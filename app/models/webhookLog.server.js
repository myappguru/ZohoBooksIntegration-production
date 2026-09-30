import db from "../db.server";

// Shopify can (and does) redeliver the same webhook more than once, so
// `webhook_id` has a UNIQUE constraint on the table - inserting first and
// treating a duplicate-key failure as "already being handled" is the
// idempotency guard. A duplicate whose earlier attempt *failed* (or that
// the retry sweeper has queued, status "retrying") is claimed and
// reprocessed instead of dropped - previously a failed event was lost for
// good. The claim is a single conditional UPDATE, so only one of several
// concurrent deliveries wins it.
// Returns null if the caller should skip processing, otherwise the log row id.
export async function recordWebhookReceived(
  shopId,
  { webhookId, topic, shopDomain, resourceId, payload },
) {
  try {
    const [result] = await db.execute(
      `INSERT INTO webhook_logs (shop_id, webhook_id, topic, shop_domain, resource_id, payload, status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'received', NOW())`,
      [
        shopId,
        webhookId || null,
        topic,
        shopDomain,
        resourceId || null,
        payload ? JSON.stringify(payload) : null,
      ],
    );

    return result.insertId;
  } catch (error) {
    if (error.code !== "ER_DUP_ENTRY") throw error;
    return claimWebhookForRetry(webhookId);
  }
}

async function claimWebhookForRetry(webhookId) {
  if (!webhookId) return null;
  const [result] = await db.execute(
    `UPDATE webhook_logs SET status = 'received', updated_at = NOW()
     WHERE webhook_id = ? AND status IN ('failed', 'retrying')`,
    [webhookId],
  );
  if (result.affectedRows !== 1) return null;

  const [rows] = await db.execute(`SELECT id FROM webhook_logs WHERE webhook_id = ?`, [webhookId]);
  return rows[0]?.id || null;
}

export async function finishWebhookLog(
  logId,
  { status, errorMessage, resourceLabel },
) {
  await db.execute(
    `UPDATE webhook_logs SET status = ?, error_message = ?, resource_label = COALESCE(?, resource_label), attempts = attempts + 1, processed_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [status, errorMessage || null, resourceLabel || null, logId],
  );
}

// Used by the Dashboard's "Synchronization Overview" stat tile - inventory
// has no `sync_mappings` entity_type of its own (it rides on the product
// mapping + a warehouse mapping), so a real stock push count is the closest
// analog to "how many records are synced" that products/customers/orders
// show, using data this app already records rather than inventing a new
// running total.
export async function getSyncedWebhookCount(shopId, topic) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS count FROM webhook_logs WHERE shop_id = ? AND topic = ? AND status = 'synced'`,
    [shopId, topic],
  );

  return rows[0]?.count || 0;
}

export async function getRecentWebhookLogs(shopId, topic, limit = 10) {
  const safeLimit = Number.isInteger(limit) ? limit : 10;
  const [rows] = await db.execute(
    `SELECT topic, resource_id, resource_label, status, error_message, received_at, processed_at FROM webhook_logs WHERE shop_id = ? AND topic = ? ORDER BY id DESC LIMIT ${safeLimit}`,
    [shopId, topic],
  );

  return rows;
}

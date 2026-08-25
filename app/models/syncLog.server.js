import db from "../db.server";

// One row per sync *run* (not per record) - records_processed/success/failed
// summarize the whole run, and per-item detail goes in `metadata` as a JSON
// array. This is what the (future) sync-history page will read.
export async function startSyncLog(shopId, { entityType, direction }) {
  const [result] = await db.execute(
    `INSERT INTO sync_logs (shop_id, entity_type, direction, status, started_at)
     VALUES (?, ?, ?, 'running', NOW())`,
    [shopId, entityType, direction],
  );

  return result.insertId;
}

export async function finishSyncLog(
  logId,
  { recordsProcessed, recordsSuccess, recordsFailed, errorMessage, metadata },
) {
  await db.execute(
    `UPDATE sync_logs
     SET status = ?, records_processed = ?, records_success = ?, records_failed = ?, error_message = ?, metadata = ?, completed_at = NOW()
     WHERE id = ?`,
    [
      recordsFailed > 0 ? "completed_with_errors" : "completed",
      recordsProcessed,
      recordsSuccess,
      recordsFailed,
      errorMessage || null,
      metadata ? JSON.stringify(metadata) : null,
      logId,
    ],
  );
}

export async function getLatestSyncLog(shopId, entityType) {
  const [rows] = await db.execute(
    `SELECT * FROM sync_logs WHERE shop_id = ? AND entity_type = ? ORDER BY id DESC LIMIT 1`,
    [shopId, entityType],
  );

  return rows[0] || null;
}

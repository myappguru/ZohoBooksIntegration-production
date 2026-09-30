import db from "../db.server";
import { purgeOldWebhookPayloads } from "./compliance.server";
import { unauthenticated } from "../shopify.server";
import { processOrderUpsertWebhook } from "./orderSync.server";
import { processOrderPaidWebhook } from "./paymentSync.server";
import { processProductUpsertWebhook } from "./productSync.server";
import { processCustomerUpsertWebhook } from "./customerSync.server";
import { processFulfillmentCreateWebhook } from "./fulfillmentSync.server";
import { processRefundCreateWebhook } from "./refundSync.server";
import {
  processInventoryLevelWebhook,
  processOrderCancelledWebhook,
  processCustomerDeleteWebhook,
  processProductDeleteWebhook,
} from "./webhookHandlers.server";

// Background processing for Shopify webhooks.
//
// Routes verify the HMAC, hand the event to enqueueWebhook and answer 200
// straight away - Shopify allows 5 seconds, and one orders/paid event can
// need a dozen sequential Zoho calls. Events run one at a time per shop,
// which also keeps a shop's webhooks from racing each other on Zoho's rate
// limit and on token refreshes.
//
// Because the response no longer depends on the outcome, failures are
// retried here instead: every event is already stored in webhook_logs with
// its payload, and the sweeper replays `failed` rows with exponential
// backoff, plus rows left stuck in `received` by a crash/restart.

const HANDLERS = {
  ORDERS_CREATE: processOrderUpsertWebhook,
  ORDERS_UPDATED: processOrderUpsertWebhook,
  ORDERS_PAID: processOrderPaidWebhook,
  ORDERS_CANCELLED: processOrderCancelledWebhook,
  PRODUCTS_CREATE: processProductUpsertWebhook,
  PRODUCTS_UPDATE: processProductUpsertWebhook,
  PRODUCTS_DELETE: processProductDeleteWebhook,
  CUSTOMERS_CREATE: processCustomerUpsertWebhook,
  CUSTOMERS_UPDATE: processCustomerUpsertWebhook,
  CUSTOMERS_DELETE: processCustomerDeleteWebhook,
  FULFILLMENTS_CREATE: processFulfillmentCreateWebhook,
  REFUNDS_CREATE: processRefundCreateWebhook,
  INVENTORY_LEVELS_UPDATE: processInventoryLevelWebhook,
};

// Topics whose payload is the resource's full current state. Replaying an
// old one after a newer delivery for the same resource would overwrite
// newer data with stale data, so those are skipped as superseded instead.
const STATE_TOPIC_FAMILIES = [
  ["PRODUCTS_CREATE", "PRODUCTS_UPDATE"],
  ["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE"],
  ["ORDERS_CREATE", "ORDERS_UPDATED"],
  ["INVENTORY_LEVELS_UPDATE"],
];

const MAX_ATTEMPTS = 6;
const RETRY_WINDOW_DAYS = 3;
const STUCK_AFTER_MINUTES = 15;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 50;

const shopQueues = new Map();

export function normalizeTopic(topic) {
  return String(topic || "").toUpperCase().replace(/\//g, "_");
}

export async function processWebhook(event) {
  const handler = HANDLERS[normalizeTopic(event.topic)];
  if (!handler) {
    console.warn("No background handler for webhook topic", event.topic);
    return;
  }
  await handler(event);
}

// Runs the event after any earlier events for the same shop. Never throws -
// handlers record their own failures in webhook_logs.
export function enqueueWebhook(event) {
  const key = event.shop;
  const previous = shopQueues.get(key) || Promise.resolve();
  const next = previous
    .then(() => processWebhook(event))
    .catch((error) => console.error("Background webhook processing failed", event.topic, event.shop, error));
  shopQueues.set(key, next);
  next.finally(() => {
    if (shopQueues.get(key) === next) shopQueues.delete(key);
  });
  return next;
}

function familyFor(topic) {
  return STATE_TOPIC_FAMILIES.find((family) => family.includes(topic)) || null;
}

async function isSuperseded(row) {
  const family = familyFor(normalizeTopic(row.topic));
  if (!family || !row.resource_id) return false;
  const placeholders = family.map(() => "?").join(", ");
  const [rows] = await db.execute(
    `SELECT id FROM webhook_logs
     WHERE shop_id = ? AND resource_id = ? AND id > ? AND UPPER(REPLACE(topic, '/', '_')) IN (${placeholders})
     LIMIT 1`,
    [row.shop_id, row.resource_id, row.id, ...family],
  );
  return rows.length > 0;
}

async function adminForShop(shopDomain) {
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    return admin;
  } catch (error) {
    console.warn("No admin session for webhook retry", shopDomain, error.message);
    return undefined;
  }
}

// One pass of the retry sweeper. Exported so it can also be triggered on
// demand (e.g. from the Reporting page or a test).
export async function retryFailedWebhooks({ limit = SWEEP_BATCH } = {}) {
  const [rows] = await db.execute(
    `SELECT id, shop_id, webhook_id, topic, shop_domain, resource_id, payload, attempts, status
     FROM webhook_logs
     WHERE webhook_id IS NOT NULL
       AND received_at > NOW() - INTERVAL ${RETRY_WINDOW_DAYS} DAY
       AND (
         (status = 'failed' AND attempts < ${MAX_ATTEMPTS}
           AND updated_at < NOW() - INTERVAL (5 * POW(2, GREATEST(attempts, 1) - 1)) MINUTE)
         OR (status = 'received' AND updated_at < NOW() - INTERVAL ${STUCK_AFTER_MINUTES} MINUTE)
       )
     ORDER BY id ASC
     LIMIT ${Number(limit) || SWEEP_BATCH}`,
  );

  let retried = 0;
  for (const row of rows) {
    if (await isSuperseded(row)) {
      await db.execute(
        `UPDATE webhook_logs SET status = 'skipped', error_message = CONCAT(COALESCE(error_message, ''), ' [superseded by a newer delivery, not retried]'), updated_at = NOW() WHERE id = ? AND status IN ('failed', 'received')`,
        [row.id],
      );
      continue;
    }

    // Hand the row to the handler: recordWebhookReceived claims 'retrying'
    // rows, so the handler reprocesses it under the same log id.
    const [claim] = await db.execute(
      `UPDATE webhook_logs SET status = 'retrying', updated_at = NOW() WHERE id = ? AND status IN ('failed', 'received')`,
      [row.id],
    );
    if (claim.affectedRows !== 1) continue;

    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    const topic = normalizeTopic(row.topic);
    const needsAdmin = topic.startsWith("PRODUCTS_") || topic === "INVENTORY_LEVELS_UPDATE";
    const admin = needsAdmin ? await adminForShop(row.shop_domain) : undefined;

    await enqueueWebhook({ shop: row.shop_domain, topic: row.topic, webhookId: row.webhook_id, payload, admin });
    retried += 1;
  }

  return { retried };
}

// Started once per server process from entry.server.jsx.
export function startWebhookRetryLoop() {
  if (globalThis.__zohoWebhookRetryLoop) return;
  if (process.env.NODE_ENV === "test" || process.env.DISABLE_WEBHOOK_RETRY === "true") return;

  const run = () => {
    retryFailedWebhooks().catch((error) => console.error("Webhook retry sweep failed", error));
    purgeOldWebhookPayloads().catch((error) => console.error("Webhook payload purge failed", error));
  };
  globalThis.__zohoWebhookRetryLoop = setInterval(run, SWEEP_INTERVAL_MS);
  globalThis.__zohoWebhookRetryLoop.unref?.();
  setTimeout(run, 30 * 1000).unref?.();
}

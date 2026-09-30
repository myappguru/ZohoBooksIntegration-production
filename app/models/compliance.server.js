import db from "../db.server";

// How long full webhook payloads (orders, addresses, customers...) are kept.
// Retries only look back 3 days (webhookQueue.server.js), so 30 days leaves
// room for debugging while not storing personal data indefinitely. The log
// rows themselves stay (status, counts) with the payload cleared.
export const WEBHOOK_PAYLOAD_RETENTION_DAYS = 30;

export async function purgeOldWebhookPayloads() {
  const [result] = await db.execute(
    `UPDATE webhook_logs SET payload = NULL, resource_label = NULL
     WHERE payload IS NOT NULL AND received_at < NOW() - INTERVAL ${WEBHOOK_PAYLOAD_RETENTION_DAYS} DAY`,
  );
  return result.affectedRows || 0;
}

function customerKeys(customer) {
  const keys = [];
  if (customer?.id) keys.push(`gid://shopify/Customer/${customer.id}`);
  if (customer?.email) keys.push(`guest:${customer.email}`);
  if (customer?.phone) keys.push(`guest-phone:${String(customer.phone).replace(/\s+/g, "")}`);
  return keys;
}

// customers/redact: remove everything this app stores about the customer -
// the customer mappings (including guest email/phone keys) and every
// webhook log that carries their data: their customer events, their orders
// and the fulfillments/refunds of those orders (which hold addresses and
// names too). Previously only rows whose resource_id matched were removed.
export async function redactCustomer(shopId, payload) {
  const customer = payload.customer || {};
  const keys = customerKeys(customer);
  const orderIds = (payload.orders_to_redact || []).map(String);
  const customerId = customer.id ? String(customer.id) : null;

  if (keys.length > 0) {
    await db.execute(
      `DELETE FROM sync_mappings WHERE shop_id = ? AND entity_type = 'customer' AND shopify_id IN (${keys.map(() => "?").join(", ")})`,
      [shopId, ...keys],
    );
  }

  if (customerId) {
    await db.execute(
      `DELETE FROM webhook_logs
       WHERE shop_id = ? AND (
         resource_id = ?
         OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.customer.id')) = ?
       )`,
      [shopId, `gid://shopify/Customer/${customerId}`, customerId],
    );
  }

  if (customer.email) {
    await db.execute(
      `DELETE FROM webhook_logs WHERE shop_id = ? AND (
         JSON_UNQUOTE(JSON_EXTRACT(payload, '$.email')) = ?
         OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.contact_email')) = ?
       )`,
      [shopId, customer.email, customer.email],
    );
  }

  for (const orderId of orderIds) {
    await db.execute(
      `DELETE FROM webhook_logs WHERE shop_id = ? AND (
         resource_id = ?
         OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.order_id')) = ?
       )`,
      [shopId, `gid://shopify/Order/${orderId}`, orderId],
    );
  }
}

// customers/data_request: the app's own data is limited to sync links and
// webhook logs; summarise what exists so the merchant can respond to the
// request (the customer's accounting records live in the merchant's Zoho).
export async function describeCustomerData(shopId, payload) {
  const keys = customerKeys(payload.customer);
  const orderIds = (payload.orders_requested || []).map((id) => `gid://shopify/Order/${id}`);
  const ids = [...keys, ...orderIds];
  const [mappings] = ids.length
    ? await db.execute(
        `SELECT entity_type, shopify_id, zoho_id FROM sync_mappings WHERE shop_id = ? AND shopify_id IN (${ids.map(() => "?").join(", ")})`,
        [shopId, ...ids],
      )
    : [[]];
  return { mappings };
}

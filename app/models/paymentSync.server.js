import db from "../db.server";
import { createZohoCustomerPayment } from "../zoho.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "./zohoConnection.server";
import { getAppSettings } from "./appSettings.server";
import { getProductMappings } from "./productSync.server";
import { getCustomerMappings } from "./customerSync.server";
import {
  getOrderMappings,
  normalizeRestOrder,
  buildOrderCustomer,
} from "./orderSync.server";
import { syncInvoiceForOrder } from "./invoiceSync.server";
import { recordWebhookReceived, finishWebhookLog } from "./webhookLog.server";

const ENTITY_TYPE = "payment";

// ZohoApiError's `.message` is just a generic label - the actual reason
// Zoho gave lives in `.details`. Folding it into the stored string means
// the real cause shows up in sync_mappings/sync_logs directly.
function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

export async function getPaymentMappings(shopId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id, status, last_synced_at, last_error FROM sync_mappings WHERE shop_id = ? AND entity_type = ?`,
    [shopId, ENTITY_TYPE],
  );

  return Object.fromEntries(
    rows.map((row) => [
      row.shopify_id,
      {
        zohoId: row.zoho_id,
        status: row.status,
        lastSyncedAt: row.last_synced_at,
        lastError: row.last_error,
      },
    ]),
  );
}

export async function getPaymentMapping(shopId, shopifyOrderId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [shopId, ENTITY_TYPE, shopifyOrderId],
  );

  return rows[0] || null;
}

export async function savePaymentMapping(shopId, shopifyOrderId, zohoPaymentId) {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, zoho_id, status, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, 'synced', NOW(), NULL)
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), status = 'synced', last_synced_at = NOW(), last_error = NULL`,
    [shopId, ENTITY_TYPE, shopifyOrderId, zohoPaymentId],
  );
}

export async function markPaymentMappingError(shopId, shopifyOrderId, errorMessage) {
  await db.execute(
    `UPDATE sync_mappings SET status = 'error', last_error = ? WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [errorMessage, shopId, ENTITY_TYPE, shopifyOrderId],
  );
}

// Maps a Shopify payment gateway name to one of Zoho's fixed payment_mode
// values (check, cash, creditcard, banktransfer, bankremittance,
// autotransaction, others) - Zoho doesn't accept arbitrary gateway names,
// so anything unrecognized falls back to "others" rather than failing.
export function mapPaymentMode(paymentGatewayNames) {
  const gateway = (paymentGatewayNames?.[0] || "").toLowerCase();

  if (gateway.includes("paypal")) return "others";
  if (gateway.includes("shopify_payments") || gateway.includes("stripe") || gateway.includes("credit")) {
    return "creditcard";
  }
  if (gateway.includes("bank")) return "banktransfer";
  if (gateway.includes("cash") || gateway === "manual" || gateway.includes("cod")) return "cash";
  if (gateway.includes("check") || gateway.includes("cheque")) return "check";

  return "others";
}

export function buildZohoPaymentPayload(order, { customerId, invoiceId, accountId }) {
  const amount = Number(order.totalPrice) || 0;

  return {
    customer_id: customerId,
    payment_mode: mapPaymentMode(order.paymentGatewayNames),
    amount,
    date: (order.updatedAt || order.createdAt || "").slice(0, 10),
    reference_number: order.name,
    ...(accountId ? { account_id: accountId } : {}),
    invoices: [{ invoice_id: invoiceId, amount_applied: amount }],
  };
}

// Records a Zoho payment against the order's invoice and applies it in the
// same call. Like invoice sync, this is one-shot - once an order has a
// payment mapping, it's left alone rather than re-synced, since a recorded
// payment is a finished accounting event, not something to keep updating.
export async function syncPaymentForOrder({
  shopId,
  zohoAuth,
  order,
  invoiceId,
  customerId,
  accountSettings,
}) {
  if (!invoiceId || !customerId) {
    return { orderName: order.name, status: "skipped", reason: "no invoice or customer to pay against" };
  }

  const existingPayment = await getPaymentMapping(shopId, order.id);
  if (existingPayment) {
    return { orderName: order.name, status: "skipped", reason: "already paid" };
  }

  const payload = buildZohoPaymentPayload(order, {
    customerId,
    invoiceId,
    accountId: accountSettings?.paymentAccountId,
  });

  try {
    const payment = await createZohoCustomerPayment(zohoAuth, payload);
    await savePaymentMapping(shopId, order.id, payment.payment_id);

    return { orderName: order.name, zohoPaymentId: payment.payment_id, status: "success" };
  } catch (error) {
    console.error("Failed to record Zoho payment for order", order.name, error);
    const description = describeZohoError(error);
    await markPaymentMappingError(shopId, order.id, description);

    return { orderName: order.name, status: "error", error: description };
  }
}

// Composes invoice sync (Section E) with payment sync (Section F) - the
// single entry point both the orders/paid webhook and the Orders page
// "Sync now" backfill call, so the two call sites can't drift out of sync.
// Ensures an invoice exists (creating one on the spot if needed, same as
// invoice sync does for sales orders), then records a payment against it.
export async function syncInvoiceAndPaymentForOrder({
  shopId,
  zohoAuth,
  order,
  taxSettings,
  accountSettings,
  productMappings,
  customerMappings,
  orderMappings,
}) {
  const invoiceResult = await syncInvoiceForOrder({
    shopId,
    zohoAuth,
    order,
    taxSettings,
    productMappings,
    customerMappings,
    orderMappings,
    inventoryAccountId: accountSettings?.inventoryAccountId,
  });

  if (invoiceResult.status === "error") {
    return { invoice: invoiceResult, payment: null };
  }

  if (!invoiceResult.zohoInvoiceId) {
    return { invoice: invoiceResult, payment: { orderName: order.name, status: "skipped" } };
  }

  const customerId = customerMappings[buildOrderCustomer(order).id]?.zohoId;

  const paymentResult = await syncPaymentForOrder({
    shopId,
    zohoAuth,
    order,
    invoiceId: invoiceResult.zohoInvoiceId,
    customerId,
    accountSettings,
  });

  return { invoice: invoiceResult, payment: paymentResult };
}

// Shopify's orders/paid webhook fires whenever an order's financial status
// transitions to "paid". Always resolves (never throws) so the route can
// respond 200 to Shopify regardless of what happened internally; failures
// are recorded in webhook_logs instead of surfacing as a delivery failure.
export async function processOrderPaidWebhook({
  shop: shopDomain,
  topic,
  webhookId,
  payload,
}) {
  const { shop, connection } = await getConnectionForShopDomain(shopDomain);

  const logId = await recordWebhookReceived(shop.id, {
    webhookId,
    topic,
    shopDomain,
    resourceId: payload.admin_graphql_api_id,
    payload,
  });

  if (!logId) return; // Duplicate delivery of a webhook we've already processed.

  if (!connection) {
    await finishWebhookLog(logId, {
      status: "skipped",
      errorMessage: "Zoho Books is not connected for this shop",
    });
    return;
  }

  try {
    const token = await getValidAccessToken(shop.id);
    if (!token) throw new Error("No valid Zoho access token");

    const zohoAuth = {
      accessToken: token.accessToken,
      apiDomain: token.apiDomain,
      organizationId: connection.organization_id,
    };
    const order = normalizeRestOrder(payload);
    const appSettings = await getAppSettings(shop.id);
    const [productMappings, customerMappings, orderMappings] = await Promise.all([
      getProductMappings(shop.id),
      getCustomerMappings(shop.id),
      getOrderMappings(shop.id),
    ]);

    const { invoice, payment } = await syncInvoiceAndPaymentForOrder({
      shopId: shop.id,
      zohoAuth,
      order,
      taxSettings: appSettings.taxSettings || {},
      accountSettings: appSettings.accountSettings || {},
      productMappings,
      customerMappings,
      orderMappings,
    });

    const failed = [invoice, payment].filter((result) => result?.status === "error");

    await finishWebhookLog(logId, {
      status: failed.length > 0 ? "failed" : "processed",
      errorMessage:
        failed.length > 0 ? failed.map((result) => result.error).join("; ") : null,
    });
  } catch (error) {
    console.error("Failed to process order paid webhook", topic, error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }
}

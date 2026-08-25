import db from "../db.server";
import {
  fetchZohoSalesOrder,
  createZohoPackage,
  createZohoShipmentOrder,
} from "../zoho.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "./zohoConnection.server";
import { getOrderMapping } from "./orderSync.server";
import { recordWebhookReceived, finishWebhookLog } from "./webhookLog.server";

const ENTITY_TYPE = "fulfillment";

// ZohoApiError's `.message` is just a generic label - the actual reason
// Zoho gave lives in `.details`.
function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

export async function getFulfillmentMapping(shopId, shopifyFulfillmentId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id, status FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [shopId, ENTITY_TYPE, shopifyFulfillmentId],
  );

  return rows[0] || null;
}

async function saveFulfillmentMapping(shopId, shopifyFulfillmentId, zohoShipmentId, shopifyOrderId) {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, shopify_parent_id, zoho_id, status, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, ?, 'synced', NOW(), NULL)
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), shopify_parent_id = VALUES(shopify_parent_id), status = 'synced', last_synced_at = NOW(), last_error = NULL`,
    [shopId, ENTITY_TYPE, shopifyFulfillmentId, shopifyOrderId || null, zohoShipmentId],
  );
}

// Shopify's fulfillments/create webhook delivers { id, order_id, name,
// tracking_company, tracking_number/tracking_numbers, line_items: [...] } -
// verified against Shopify's real webhook payload docs, not assumed.
// `order_id`/fulfillment `id` are plain numeric REST ids, rebuilt into GIDs
// the same way this app's other REST normalizers do, so they line up with
// the GID-keyed mappings already stored from the GraphQL-based order sync.
export function normalizeRestFulfillment(payload) {
  return {
    id: payload.admin_graphql_api_id || `gid://shopify/Fulfillment/${payload.id}`,
    orderId: `gid://shopify/Order/${payload.order_id}`,
    name: payload.name || `#${payload.id}`,
    trackingCompany: payload.tracking_company || null,
    trackingNumber:
      payload.tracking_number ||
      (Array.isArray(payload.tracking_numbers) ? payload.tracking_numbers[0] : null) ||
      null,
    lineItems: (payload.line_items || []).map((lineItem) => ({
      sku: lineItem.sku,
      quantity: lineItem.quantity,
    })),
  };
}

// Creates a Zoho Package + Shipment Order for a Shopify fulfillment -
// Zoho's actual accounting-side record that (some of) an order's items
// shipped, as opposed to just a note on the sales order. Matches the
// fulfillment's line items to the sales order's own line items by SKU
// (the same matching key used throughout this app's product/order sync)
// to get each one's `line_item_id`, which is what the Packages API needs
// (not the item_id).
//
// `delivery_method` and `tracking_number` are mandatory on Zoho's create
// call even though a Shopify fulfillment can have either blank (e.g. a
// manual, untracked fulfillment) - falls back to "Other"/the fulfillment's
// own name rather than sending an empty string, which Zoho would reject.
export async function syncFulfillmentToZoho({ shopId, zohoAuth, fulfillment, zohoSalesOrderId }) {
  const existing = await getFulfillmentMapping(shopId, fulfillment.id);
  if (existing) {
    return { status: "skipped", reason: "already synced" };
  }

  if (!zohoSalesOrderId) {
    return { status: "skipped", reason: "order not yet synced to Zoho" };
  }

  try {
    const salesOrder = await fetchZohoSalesOrder(zohoAuth, zohoSalesOrderId);
    const soLineItemsBySku = new Map(
      (salesOrder.line_items || [])
        .filter((lineItem) => lineItem.sku)
        .map((lineItem) => [lineItem.sku, lineItem]),
    );

    const packageLineItems = [];
    for (const lineItem of fulfillment.lineItems) {
      const soLineItem = soLineItemsBySku.get(lineItem.sku);
      // Not every fulfilled line item necessarily made it into the Zoho
      // sales order (e.g. a no-SKU custom line item, skipped the same way
      // order sync itself skips them) - just leave those out of the
      // package rather than failing the whole shipment.
      if (!soLineItem) continue;

      packageLineItems.push({
        soLineItemId: soLineItem.line_item_id,
        quantity: lineItem.quantity,
      });
    }

    if (packageLineItems.length === 0) {
      return { status: "skipped", reason: "no matching Zoho sales order line items to ship" };
    }

    const today = new Date().toISOString().slice(0, 10);

    const zohoPackage = await createZohoPackage(zohoAuth, {
      salesOrderId: zohoSalesOrderId,
      date: today,
      lineItems: packageLineItems,
      packageNumber: `PKG-${fulfillment.name.replace(/^#/, "")}`,
    });

    const shipment = await createZohoShipmentOrder(zohoAuth, {
      salesOrderId: zohoSalesOrderId,
      packageIds: [zohoPackage.package_id],
      shipmentNumber: `SHP-${fulfillment.name.replace(/^#/, "")}`,
      date: today,
      deliveryMethod: fulfillment.trackingCompany || "Other",
      trackingNumber: fulfillment.trackingNumber || fulfillment.name,
    });

    await saveFulfillmentMapping(shopId, fulfillment.id, shipment.shipment_id, fulfillment.orderId);

    return { status: "success", zohoShipmentId: shipment.shipment_id };
  } catch (error) {
    console.error("Failed to sync fulfillment to Zoho", fulfillment.id, error);
    return { status: "error", error: describeZohoError(error) };
  }
}

// Shared body for the fulfillments/create webhook route - always resolves
// (never throws) so the route can respond 200 to Shopify regardless of
// what happened internally; failures are recorded in webhook_logs instead
// of surfacing as a webhook delivery failure (which would make Shopify
// retry and eventually disable the subscription).
export async function processFulfillmentCreateWebhook({ shop: shopDomain, topic, webhookId, payload }) {
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

    const fulfillment = normalizeRestFulfillment(payload);
    const orderMapping = await getOrderMapping(shop.id, fulfillment.orderId);

    const result = await syncFulfillmentToZoho({
      shopId: shop.id,
      zohoAuth,
      fulfillment,
      zohoSalesOrderId: orderMapping?.zoho_id,
    });

    const statusForLog =
      result.status === "error" ? "failed" : result.status === "success" ? "synced" : "skipped";

    await finishWebhookLog(logId, {
      status: statusForLog,
      errorMessage: result.status === "error" ? result.error : result.reason || null,
    });
  } catch (error) {
    console.error("Failed to process fulfillment webhook", topic, error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }
}

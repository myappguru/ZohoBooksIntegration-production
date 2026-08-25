import db from "../db.server";
import {
  createZohoInvoiceFromSalesOrder,
  fetchZohoSalesOrder,
} from "../zoho.server";
import { syncOrderToZoho } from "./orderSync.server";

const ENTITY_TYPE = "invoice";

// ZohoApiError's `.message` is just a generic label - the actual reason
// Zoho gave lives in `.details`. Folding it into the stored string means
// the real cause shows up in sync_mappings/sync_logs directly.
function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

export async function getInvoiceMappings(shopId) {
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

export async function getInvoiceMapping(shopId, shopifyOrderId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [shopId, ENTITY_TYPE, shopifyOrderId],
  );

  return rows[0] || null;
}

export async function saveInvoiceMapping(shopId, shopifyOrderId, zohoInvoiceId) {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, zoho_id, status, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, 'synced', NOW(), NULL)
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), status = 'synced', last_synced_at = NOW(), last_error = NULL`,
    [shopId, ENTITY_TYPE, shopifyOrderId, zohoInvoiceId],
  );
}

export async function markInvoiceMappingError(shopId, shopifyOrderId, errorMessage) {
  await db.execute(
    `UPDATE sync_mappings SET status = 'error', last_error = ? WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [errorMessage, shopId, ENTITY_TYPE, shopifyOrderId],
  );
}

// An invoice is only ever generated once per order - unlike products/
// customers/orders, there's no "update" here, since re-running this after
// an invoice already exists would just duplicate it in Zoho. If the order
// hasn't been synced to Zoho as a sales order yet (e.g. Zoho wasn't
// connected when the order first came in), that sales order is created on
// the spot via the exact same syncOrderToZoho used by order sync, then
// immediately converted - an invoice shouldn't have to wait on someone
// visiting the Orders page first.
export async function syncInvoiceForOrder({
  shopId,
  zohoAuth,
  order,
  taxSettings,
  productMappings,
  customerMappings,
  orderMappings,
  inventoryAccountId,
}) {
  const existingInvoice = await getInvoiceMapping(shopId, order.id);
  if (existingInvoice) {
    // Payment sync (Section F) needs the invoice id even when the invoice
    // already existed from a prior run, so it can still apply a payment
    // against it.
    return {
      orderName: order.name,
      zohoInvoiceId: existingInvoice.zoho_id,
      status: "skipped",
      reason: "already invoiced",
    };
  }

  let salesOrderId = orderMappings[order.id]?.zohoId;

  if (!salesOrderId) {
    const orderResult = await syncOrderToZoho({
      shopId,
      zohoAuth,
      order,
      taxSettings,
      productMappings,
      customerMappings,
      orderMappings,
      inventoryAccountId,
    });

    if (orderResult.status !== "success") {
      return { orderName: order.name, status: orderResult.status, error: orderResult.error };
    }

    salesOrderId = orderResult.zohoSalesOrderId;
  }

  try {
    const invoice = await createZohoInvoiceFromSalesOrder(zohoAuth, salesOrderId);
    await saveInvoiceMapping(shopId, order.id, invoice.invoice_id);

    return { orderName: order.name, zohoInvoiceId: invoice.invoice_id, status: "success" };
  } catch (error) {
    // Zoho reports "no items left to invoice" (36026) when the sales
    // order has already been fully invoiced by something outside this
    // app's tracking (e.g. converted manually in Zoho's own UI) - rather
    // than failing, fetch the sales order's own detail record, which
    // includes Zoho's authoritative `invoices` link, and adopt whatever
    // invoice is already there. The same "link instead of duplicate"
    // pattern used for products (SKU) and customers (email).
    if (error.details?.code === 36026) {
      try {
        const salesOrder = await fetchZohoSalesOrder(zohoAuth, salesOrderId);
        const existing = salesOrder?.invoices?.[0];
        if (existing) {
          await saveInvoiceMapping(shopId, order.id, existing.invoice_id);
          return { orderName: order.name, zohoInvoiceId: existing.invoice_id, status: "success" };
        }
      } catch (lookupError) {
        console.error("Failed to look up existing Zoho invoice for order", order.name, lookupError);
      }
    }

    console.error("Failed to create Zoho invoice for order", order.name, error);
    const description = describeZohoError(error);
    await markInvoiceMappingError(shopId, order.id, description);

    return { orderName: order.name, status: "error", error: description };
  }
}

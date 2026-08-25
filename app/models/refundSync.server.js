import db from "../db.server";
import {
  fetchZohoInvoice,
  createZohoCreditNote,
  applyZohoCreditNoteToInvoice,
  createZohoCreditNoteRefund,
} from "../zoho.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "./zohoConnection.server";
import { getInvoiceMapping } from "./invoiceSync.server";
import { mapPaymentMode } from "./paymentSync.server";
import { getAppSettings } from "./appSettings.server";
import { recordWebhookReceived, finishWebhookLog } from "./webhookLog.server";

const ENTITY_TYPE = "refund";

// ZohoApiError's `.message` is just a generic label - the actual reason
// Zoho gave lives in `.details`.
function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

export async function getRefundMapping(shopId, shopifyRefundId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id, status FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [shopId, ENTITY_TYPE, shopifyRefundId],
  );

  return rows[0] || null;
}

async function saveRefundMapping(shopId, shopifyRefundId, zohoCreditNoteId, shopifyOrderId) {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, shopify_parent_id, zoho_id, status, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, ?, 'synced', NOW(), NULL)
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), shopify_parent_id = VALUES(shopify_parent_id), status = 'synced', last_synced_at = NOW(), last_error = NULL`,
    [shopId, ENTITY_TYPE, shopifyRefundId, shopifyOrderId || null, zohoCreditNoteId],
  );
}

// Shopify's refunds/create webhook - verified against Shopify's real
// webhook payload docs (admin-rest/2026-07/resources/webhook +
// resources/refund), not assumed. `transactions` carries the actual money
// movement (kind: "refund", with the gateway and amount) - used instead of
// summing refund_line_items' subtotal/tax, since a refund can include
// amounts (e.g. a goodwill adjustment) that aren't tied to a specific line
// item at all. A refund with no money transaction (e.g. a pure "restock
// only, no charge reversed" correction) legitimately has amount 0.
export function normalizeRestRefund(payload) {
  const refundTransactions = (payload.transactions || []).filter(
    (transaction) => transaction.kind === "refund",
  );

  return {
    id: payload.admin_graphql_api_id || `gid://shopify/Refund/${payload.id}`,
    orderId: `gid://shopify/Order/${payload.order_id}`,
    createdAt: payload.created_at || payload.processed_at,
    amount: refundTransactions.reduce((sum, transaction) => sum + (Number(transaction.amount) || 0), 0),
    gatewayNames: refundTransactions.map((transaction) => transaction.gateway).filter(Boolean),
    lineItems: (payload.refund_line_items || [])
      .filter((refundLineItem) => refundLineItem.line_item?.sku)
      .map((refundLineItem) => ({
        sku: refundLineItem.line_item.sku,
        quantity: refundLineItem.quantity,
      })),
  };
}

// Creates a Zoho Credit Note for a Shopify refund and credits it against
// the original invoice. Two Zoho calls, not one - confirmed live
// (2026-08-18) that Zoho rejects a credit note create call that tries to
// link `invoice_id`/`invoice_item_id` directly on its line items (`code: 6,
// "Invalid values are given for creation"`), and that the actually-correct
// flow is to create the credit note as a plain standalone document (pulling
// each line's price straight from the invoice's own line item here, since
// there's no automatic inheritance without the link) and then separately
// call `applyZohoCreditNoteToInvoice` ("Credit to an invoice") to credit it
// against the specific invoice - the same create-then-convert shape already
// used for sales-order→invoice (Section E).
export async function syncRefundToZoho({ shopId, zohoAuth, refund, zohoInvoiceId, accountSettings }) {
  const existing = await getRefundMapping(shopId, refund.id);
  if (existing) {
    return { status: "skipped", reason: "already synced" };
  }

  if (!zohoInvoiceId) {
    return { status: "skipped", reason: "order has no Zoho invoice to credit" };
  }

  try {
    const invoice = await fetchZohoInvoice(zohoAuth, zohoInvoiceId);
    const invoiceLineItemsBySku = new Map(
      (invoice.line_items || [])
        .filter((lineItem) => lineItem.sku)
        .map((lineItem) => [lineItem.sku, lineItem]),
    );

    const creditNoteLineItems = [];
    for (const lineItem of refund.lineItems) {
      const invoiceLineItem = invoiceLineItemsBySku.get(lineItem.sku);
      // A refunded line that never made it onto the Zoho invoice (e.g. a
      // no-SKU custom line item, skipped the same way order/invoice sync
      // itself skips them) is left out of the credit note rather than
      // failing the whole refund.
      if (!invoiceLineItem) continue;

      creditNoteLineItems.push({
        itemId: invoiceLineItem.item_id,
        quantity: lineItem.quantity,
        rate: invoiceLineItem.rate,
      });
    }

    if (creditNoteLineItems.length === 0) {
      return { status: "skipped", reason: "no matching invoice line items to credit" };
    }

    const date = (refund.createdAt || "").slice(0, 10);

    const creditNote = await createZohoCreditNote(zohoAuth, {
      customerId: invoice.customer_id,
      date,
      lineItems: creditNoteLineItems,
    });

    const creditTotal = creditNoteLineItems.reduce(
      (sum, lineItem) => sum + lineItem.quantity * (Number(lineItem.rate) || 0),
      0,
    );

    try {
      await applyZohoCreditNoteToInvoice(zohoAuth, {
        creditNoteId: creditNote.creditnote_id,
        invoiceId: zohoInvoiceId,
        amountApplied: creditTotal,
      });
    } catch (error) {
      // Zoho treats a fully-paid invoice as internally "closed" (distinct
      // from the "paid" status it displays) and refuses to link a credit
      // note to one (code 12006) - confirmed live 2026-08-19 against a real
      // paid invoice. There's no outstanding balance to offset in that case
      // anyway, so the credit is refunded straight back to the customer
      // instead (below) rather than applied against the invoice - the
      // credit note itself was already created successfully above either way.
      if (error.details?.code !== 12006) throw error;
    }

    if (refund.amount > 0) {
      await createZohoCreditNoteRefund(zohoAuth, {
        creditNoteId: creditNote.creditnote_id,
        date,
        amount: refund.amount,
        refundMode: mapPaymentMode(refund.gatewayNames),
        fromAccountId: accountSettings?.paymentAccountId,
        referenceNumber: refund.id,
      });
    }

    await saveRefundMapping(shopId, refund.id, creditNote.creditnote_id, refund.orderId);

    return { status: "success", zohoCreditNoteId: creditNote.creditnote_id };
  } catch (error) {
    console.error("Failed to sync refund to Zoho", refund.id, error);
    return { status: "error", error: describeZohoError(error) };
  }
}

// Shared body for the refunds/create webhook route - always resolves
// (never throws) so the route can respond 200 to Shopify regardless of
// what happened internally; failures are recorded in webhook_logs instead
// of surfacing as a webhook delivery failure (which would make Shopify
// retry and eventually disable the subscription).
//
// Reversing inventory for restocked items needs no code here at all -
// Shopify itself adjusts its own inventory levels when a refund line item
// has a restock_type other than "no_restock", which fires the existing
// inventory_levels/update webhook (Section G) and pushes the corrected
// quantity into Zoho through that already-built path.
export async function processRefundCreateWebhook({ shop: shopDomain, topic, webhookId, payload }) {
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

    const refund = normalizeRestRefund(payload);
    const invoiceMapping = await getInvoiceMapping(shop.id, refund.orderId);
    const appSettings = await getAppSettings(shop.id);

    const result = await syncRefundToZoho({
      shopId: shop.id,
      zohoAuth,
      refund,
      zohoInvoiceId: invoiceMapping?.zoho_id,
      accountSettings: appSettings.accountSettings,
    });

    const statusForLog =
      result.status === "error" ? "failed" : result.status === "success" ? "synced" : "skipped";

    await finishWebhookLog(logId, {
      status: statusForLog,
      errorMessage: result.status === "error" ? result.error : result.reason || null,
    });
  } catch (error) {
    console.error("Failed to process refund webhook", topic, error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }
}

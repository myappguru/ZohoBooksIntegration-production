import db from "../db.server";
import {
  fetchZohoInvoice,
  fetchZohoCreditNote,
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
import { withResourceLock, resourceLockKey } from "./resourceLock.server";

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

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// A credit note exists but applying/refunding it hasn't finished - kept as
// status "error" so it shows as needing attention and a retry resumes it.
async function markRefundPending(shopId, shopifyRefundId, zohoCreditNoteId, shopifyOrderId, errorMessage = "Credit note created; refund not yet recorded") {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, shopify_parent_id, zoho_id, status, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, ?, 'error', NOW(), ?)
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), shopify_parent_id = VALUES(shopify_parent_id), status = 'error', last_synced_at = NOW(), last_error = VALUES(last_error)`,
    [shopId, ENTITY_TYPE, shopifyRefundId, shopifyOrderId || null, zohoCreditNoteId, errorMessage],
  );
}

// Shopify's refunds/create webhook - verified against Shopify's real
// webhook payload docs (admin-rest/2026-07/resources/webhook +
// resources/refund), not assumed. `transactions` carries the actual money
// movement (kind: "refund", with the gateway and amount). Line items keep
// Shopify's own refunded `subtotal`/`total_tax`, and refunded shipping comes
// from `refund_shipping_lines` (plus legacy `shipping_refund` order
// adjustments), so the credit note can be built from what was actually
// refunded. A refund with no money transaction (e.g. a pure "restock only"
// correction) legitimately has amount 0.
export function normalizeRestRefund(payload) {
  const refundTransactions = (payload.transactions || []).filter(
    (transaction) => transaction.kind === "refund" && (!transaction.status || transaction.status === "success"),
  );

  const shippingFromLines = (payload.refund_shipping_lines || []).reduce(
    (sum, line) => sum + (Number(line.subtotal_amount_set?.shop_money?.amount) || 0),
    0,
  );
  const shippingFromAdjustments = (payload.order_adjustments || [])
    .filter((adjustment) => adjustment.kind === "shipping_refund")
    .reduce((sum, adjustment) => sum - (Number(adjustment.amount) || 0) - (Number(adjustment.tax_amount) || 0), 0);

  return {
    id: payload.admin_graphql_api_id || `gid://shopify/Refund/${payload.id}`,
    orderId: `gid://shopify/Order/${payload.order_id}`,
    createdAt: payload.created_at || payload.processed_at,
    amount: round2(refundTransactions.reduce((sum, transaction) => sum + (Number(transaction.amount) || 0), 0)),
    gatewayNames: refundTransactions.map((transaction) => transaction.gateway).filter(Boolean),
    shippingAmount: round2(shippingFromLines || shippingFromAdjustments),
    lineItems: (payload.refund_line_items || [])
      .filter((refundLineItem) => Number(refundLineItem.quantity) > 0)
      .map((refundLineItem) => ({
        sku: refundLineItem.line_item?.sku || null,
        title: refundLineItem.line_item?.title || refundLineItem.line_item?.name || null,
        quantity: refundLineItem.quantity,
        subtotal: refundLineItem.subtotal_set?.shop_money?.amount ?? refundLineItem.subtotal ?? null,
        totalTax: refundLineItem.total_tax_set?.shop_money?.amount ?? refundLineItem.total_tax ?? 0,
      })),
  };
}

// Builds the credit note lines from what Shopify actually refunded: each
// refunded item (linked to its Zoho item where the invoice has one, so
// stock and item reports reverse correctly, with the invoice line's tax),
// refunded shipping, and a free-text adjustment for any money refunded
// beyond those - goodwill/partial-amount refunds and refunds with no line
// items at all used to be skipped entirely.
export function buildCreditNoteLineItems(refund, invoice) {
  const invoiceLines = invoice.line_items || [];
  const bySku = new Map(invoiceLines.filter((line) => line.sku).map((line) => [line.sku, line]));
  const byName = new Map(invoiceLines.filter((line) => line.name).map((line) => [line.name, line]));
  const inclusive = Boolean(invoice.is_inclusive_tax);

  const lines = [];
  let covered = 0;

  for (const lineItem of refund.lineItems) {
    const invoiceLine =
      (lineItem.sku && bySku.get(lineItem.sku)) || (lineItem.title && byName.get(lineItem.title)) || null;
    const quantity = Number(lineItem.quantity) || 0;
    const subtotal =
      lineItem.subtotal != null ? Number(lineItem.subtotal) : quantity * (Number(invoiceLine?.rate) || 0);
    const tax = Number(lineItem.totalTax) || 0;

    lines.push({
      itemId: invoiceLine?.item_id || null,
      name: invoiceLine?.name || lineItem.title || lineItem.sku || "Refunded item",
      quantity,
      rate: round2(quantity ? subtotal / quantity : 0),
      taxId: tax > 0 ? invoiceLine?.tax_id || null : null,
    });
    covered += subtotal + (inclusive ? 0 : tax);
  }

  if (refund.shippingAmount > 0) {
    lines.push({ itemId: null, name: "Shipping refund", quantity: 1, rate: refund.shippingAmount, taxId: null });
    covered += refund.shippingAmount;
  }

  const remainder = round2(refund.amount - covered);
  if (remainder > 0.01) {
    lines.push({ itemId: null, name: "Refund adjustment", quantity: 1, rate: remainder, taxId: null });
  }

  return lines.filter((line) => line.quantity > 0 && line.rate > 0);
}

// Creates a Zoho Credit Note for a Shopify refund, credits any unpaid
// invoice balance with it, and records the money refunded against what is
// left. Confirmed live (2026-08-18) that Zoho rejects a credit note that
// links `invoice_id`/`invoice_item_id` on its lines, so the note is created
// standalone and then applied via `applyZohoCreditNoteToInvoice`.
//
// The mapping is saved as soon as the credit note exists (status "error"
// until every step finishes), so a failure after that point is retried by
// resuming with the same credit note instead of creating another one.
export async function syncRefundToZoho(args) {
  return withResourceLock(resourceLockKey(args.shopId, ENTITY_TYPE, args.refund.id), () =>
    syncRefundToZohoUnlocked(args),
  );
}

async function syncRefundToZohoUnlocked({ shopId, zohoAuth, refund, zohoInvoiceId, accountSettings }) {
  const existing = await getRefundMapping(shopId, refund.id);
  if (existing?.status === "synced") {
    return { status: "skipped", reason: "already synced" };
  }

  if (!zohoInvoiceId) {
    return { status: "skipped", reason: "order has no Zoho invoice to credit" };
  }

  let creditNoteId = existing?.zoho_id || null;

  try {
    const invoice = await fetchZohoInvoice(zohoAuth, zohoInvoiceId);
    const date = (refund.createdAt || "").slice(0, 10);

    if (!creditNoteId) {
      const lineItems = buildCreditNoteLineItems(refund, invoice);
      if (lineItems.length === 0) {
        return { status: "skipped", reason: "nothing refunded to credit" };
      }

      const creditNote = await createZohoCreditNote(zohoAuth, {
        customerId: invoice.customer_id,
        date,
        lineItems,
        isInclusiveTax: Boolean(invoice.is_inclusive_tax),
        referenceNumber: invoice.reference_number || undefined,
      });
      creditNoteId = creditNote.creditnote_id;
      await markRefundPending(shopId, refund.id, creditNoteId, refund.orderId);
    }

    // Work from Zoho's own view of the credit note (its tax-inclusive total
    // and what is still unused), not from our estimate.
    const creditNote = await fetchZohoCreditNote(zohoAuth, creditNoteId);
    let remaining = round2(creditNote?.balance ?? creditNote?.total);

    const invoiceBalance = round2(invoice.balance);
    if (invoiceBalance > 0 && remaining > 0) {
      const amountApplied = Math.min(invoiceBalance, remaining);
      try {
        await applyZohoCreditNoteToInvoice(zohoAuth, { creditNoteId, invoiceId: zohoInvoiceId, amountApplied });
        remaining = round2(remaining - amountApplied);
      } catch (error) {
        // Zoho treats a fully-paid invoice as "closed" and refuses to link a
        // credit to it (code 12006, confirmed live 2026-08-19) - there's no
        // balance to offset then, so the money is refunded directly below.
        if (error.details?.code !== 12006) throw error;
      }
    }

    const refundAmount = Math.min(round2(refund.amount), remaining);
    if (refundAmount > 0) {
      await createZohoCreditNoteRefund(zohoAuth, {
        creditNoteId,
        date,
        amount: refundAmount,
        refundMode: mapPaymentMode(refund.gatewayNames),
        fromAccountId: accountSettings?.paymentAccountId,
        referenceNumber: refund.id,
      });
    }
    if (round2(refund.amount) - refundAmount > 0.01) {
      console.warn("Shopify refund exceeds unused Zoho credit", refund.id, { refunded: refund.amount, recorded: refundAmount });
    }

    await saveRefundMapping(shopId, refund.id, creditNoteId, refund.orderId);

    return { status: "success", zohoCreditNoteId: creditNoteId };
  } catch (error) {
    console.error("Failed to sync refund to Zoho", refund.id, error);
    const description = describeZohoError(error);
    if (creditNoteId) await markRefundPending(shopId, refund.id, creditNoteId, refund.orderId, description);
    return { status: "error", error: description };
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

import { describe, it, expect, vi, beforeEach } from "vitest";

// syncRefundToZoho talks to the DB and Zoho - mocked at the module
// boundary, same pattern as reportingSync.server.test.js, so only its own
// decision logic (apply-to-invoice vs. fall back to a direct customer
// refund) is under test here.
vi.mock("../db.server", () => ({ default: { execute: vi.fn().mockResolvedValue([[]]) } }));
vi.mock("../zoho.server", () => ({
  fetchZohoInvoice: vi.fn(),
  fetchZohoCreditNote: vi.fn(),
  createZohoCreditNote: vi.fn(),
  applyZohoCreditNoteToInvoice: vi.fn(),
  createZohoCreditNoteRefund: vi.fn(),
  ZohoApiError: class ZohoApiError extends Error {
    constructor(message, details) {
      super(message);
      this.details = details;
    }
  },
}));
vi.mock("./paymentSync.server", () => ({ mapPaymentMode: vi.fn().mockReturnValue("others") }));
vi.mock("./webhookLog.server", () => ({ recordWebhookReceived: vi.fn(), finishWebhookLog: vi.fn() }));
vi.mock("./zohoConnection.server", () => ({ getConnectionForShopDomain: vi.fn(), getValidAccessToken: vi.fn() }));
vi.mock("./invoiceSync.server", () => ({ getInvoiceMapping: vi.fn() }));
vi.mock("./appSettings.server", () => ({ getAppSettings: vi.fn() }));

vi.mock("./resourceLock.server", () => ({
  withResourceLock: (_key, fn) => fn(),
  resourceLockKey: (...parts) => parts.join(":"),
}));

import db from "../db.server";
import { normalizeRestRefund, syncRefundToZoho, buildCreditNoteLineItems } from "./refundSync.server";
import {
  fetchZohoInvoice,
  fetchZohoCreditNote,
  createZohoCreditNote,
  applyZohoCreditNoteToInvoice,
  createZohoCreditNoteRefund,
  ZohoApiError,
} from "../zoho.server";

describe("normalizeRestRefund", () => {
  // Shape mirrors the real refunds/create webhook payload captured live
  // against order #1004 during the 2026-08-18 testing pass (the one that
  // surfaced the credit-note linkage bug) - trimmed to the fields this
  // function actually reads.
  const realRefundPayload = {
    id: 939866849465,
    order_id: 6623959679161,
    created_at: "2026-08-18T02:07:47-04:00",
    admin_graphql_api_id: "gid://shopify/Refund/939866849465",
    refund_line_items: [
      {
        quantity: 1,
        line_item: { sku: "sku-hidden-snow", title: "The Hidden Snowboard" },
      },
    ],
    transactions: [
      { kind: "refund", gateway: "manual", amount: "749.95" },
    ],
  };

  it("sums only the refund-kind transactions for the amount", () => {
    const refund = normalizeRestRefund(realRefundPayload);
    expect(refund.amount).toBe(749.95);
    expect(refund.gatewayNames).toEqual(["manual"]);
  });

  it("ignores non-refund transaction kinds when computing the amount", () => {
    const refund = normalizeRestRefund({
      ...realRefundPayload,
      transactions: [
        { kind: "sale", gateway: "manual", amount: "749.95" },
        { kind: "refund", gateway: "manual", amount: "100.00" },
      ],
    });

    expect(refund.amount).toBe(100);
  });

  it("has amount 0 for a pure restock-only refund with no money transaction", () => {
    const refund = normalizeRestRefund({ ...realRefundPayload, transactions: [] });
    expect(refund.amount).toBe(0);
    expect(refund.gatewayNames).toEqual([]);
  });

  it("keeps SKU-less line items too, with Shopify's refunded subtotal and tax", () => {
    const refund = normalizeRestRefund({
      ...realRefundPayload,
      refund_line_items: [
        { quantity: 1, subtotal: 10.99, total_tax: 2.67, line_item: { sku: "sku-hidden-snow", title: "Snow" } },
        { quantity: 1, subtotal: 5, total_tax: 0, line_item: { title: "Gift wrap" } },
      ],
    });

    expect(refund.lineItems).toEqual([
      { sku: "sku-hidden-snow", title: "Snow", quantity: 1, subtotal: 10.99, totalTax: 2.67 },
      { sku: null, title: "Gift wrap", quantity: 1, subtotal: 5, totalTax: 0 },
    ]);
  });

  it("picks up refunded shipping from refund_shipping_lines", () => {
    const refund = normalizeRestRefund({
      ...realRefundPayload,
      refund_shipping_lines: [{ subtotal_amount_set: { shop_money: { amount: "5.00" } } }],
    });
    expect(refund.shippingAmount).toBe(5);
  });

  it("builds the order GID from the plain numeric order_id", () => {
    const refund = normalizeRestRefund(realRefundPayload);
    expect(refund.orderId).toBe("gid://shopify/Order/6623959679161");
  });
});

describe("buildCreditNoteLineItems", () => {
  const invoice = {
    is_inclusive_tax: false,
    line_items: [{ sku: "sku-1", name: "Board", item_id: "item1", rate: 100, tax_id: "tax1" }],
  };

  it("credits items with the invoice's tax, refunded shipping, and any leftover as an adjustment", () => {
    const lines = buildCreditNoteLineItems(
      {
        amount: 128,
        shippingAmount: 5,
        lineItems: [{ sku: "sku-1", title: "Board", quantity: 1, subtotal: 100, totalTax: 18 }],
      },
      invoice,
    );

    expect(lines).toEqual([
      { itemId: "item1", name: "Board", quantity: 1, rate: 100, taxId: "tax1" },
      { itemId: null, name: "Shipping refund", quantity: 1, rate: 5, taxId: null },
      { itemId: null, name: "Refund adjustment", quantity: 1, rate: 5, taxId: null },
    ]);
  });

  it("records an amount-only (goodwill) refund with no line items", () => {
    const lines = buildCreditNoteLineItems({ amount: 20, shippingAmount: 0, lineItems: [] }, invoice);
    expect(lines).toEqual([{ itemId: null, name: "Refund adjustment", quantity: 1, rate: 20, taxId: null }]);
  });
});

describe("syncRefundToZoho", () => {
  const refund = {
    id: "gid://shopify/Refund/1",
    orderId: "gid://shopify/Order/1",
    createdAt: "2026-08-19T00:00:00Z",
    amount: 629.95,
    gatewayNames: ["manual"],
    shippingAmount: 0,
    lineItems: [{ sku: "sku-managed-1", title: "Managed", quantity: 1, subtotal: 629.95, totalTax: 0 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchZohoInvoice.mockResolvedValue({
      customer_id: "cust1",
      balance: 0,
      line_items: [{ sku: "sku-managed-1", item_id: "item1", rate: 629.95 }],
    });
    createZohoCreditNote.mockResolvedValue({ creditnote_id: "cn1" });
    fetchZohoCreditNote.mockResolvedValue({ creditnote_id: "cn1", total: 629.95, balance: 629.95 });
  });

  // An unpaid invoice gets its balance credited, and only whatever credit
  // is left is refunded as money - refunding the full amount after applying
  // used to exceed the credit note's remaining balance.
  it("applies the credit to an unpaid invoice and refunds only what's left", async () => {
    fetchZohoInvoice.mockResolvedValue({
      customer_id: "cust1",
      balance: 629.95,
      line_items: [{ sku: "sku-managed-1", item_id: "item1", rate: 629.95 }],
    });
    applyZohoCreditNoteToInvoice.mockResolvedValue({});
    createZohoCreditNoteRefund.mockResolvedValue({});

    const result = await syncRefundToZoho({
      shopId: 1,
      zohoAuth: {},
      refund,
      zohoInvoiceId: "inv1",
      accountSettings: {},
    });

    expect(applyZohoCreditNoteToInvoice).toHaveBeenCalledWith(
      {},
      { creditNoteId: "cn1", invoiceId: "inv1", amountApplied: 629.95 },
    );
    expect(createZohoCreditNoteRefund).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "success", zohoCreditNoteId: "cn1" });
  });

  it("resumes with the existing credit note after an earlier partial failure instead of creating another", async () => {
    db.execute.mockResolvedValueOnce([[{ shopify_id: refund.id, zoho_id: "cn-old", status: "error" }]]);
    fetchZohoCreditNote.mockResolvedValue({ creditnote_id: "cn-old", total: 629.95, balance: 629.95 });
    createZohoCreditNoteRefund.mockResolvedValue({});

    const result = await syncRefundToZoho({ shopId: 1, zohoAuth: {}, refund, zohoInvoiceId: "inv1", accountSettings: {} });

    expect(createZohoCreditNote).not.toHaveBeenCalled();
    expect(createZohoCreditNoteRefund).toHaveBeenCalledWith({}, expect.objectContaining({ creditNoteId: "cn-old" }));
    expect(result).toEqual({ status: "success", zohoCreditNoteId: "cn-old" });
  });

  it("refunds a paid invoice's credit straight to the customer without applying it", async () => {
    createZohoCreditNoteRefund.mockResolvedValue({});

    const result = await syncRefundToZoho({ shopId: 1, zohoAuth: {}, refund, zohoInvoiceId: "inv1", accountSettings: {} });

    expect(applyZohoCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(createZohoCreditNoteRefund).toHaveBeenCalledWith({}, expect.objectContaining({ creditNoteId: "cn1", amount: 629.95 }));
    expect(result).toEqual({ status: "success", zohoCreditNoteId: "cn1" });
  });

  // The real bug found live 2026-08-19: refunding against an
  // already-fully-paid invoice fails to apply (Zoho error 12006, "Credits
  // cannot be applied to invoices in the closed status") even though the
  // credit note itself was created successfully. The fix: fall back to
  // refunding the credit note straight to the customer instead of erroring
  // out and leaving it orphaned/unmapped.
  it("falls back to refunding the credit note directly when Zoho reports the invoice as closed (12006)", async () => {
    fetchZohoInvoice.mockResolvedValue({ customer_id: "cust1", balance: 10, line_items: [{ sku: "sku-managed-1", item_id: "item1", rate: 629.95 }] });
    applyZohoCreditNoteToInvoice.mockRejectedValue(
      new ZohoApiError("Failed to apply Zoho credit note to invoice", {
        code: 12006,
        message: "Credits cannot be applied to invoices in the closed status",
      }),
    );
    createZohoCreditNoteRefund.mockResolvedValue({});

    const result = await syncRefundToZoho({
      shopId: 1,
      zohoAuth: {},
      refund,
      zohoInvoiceId: "inv1",
      accountSettings: {},
    });

    expect(createZohoCreditNoteRefund).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ creditNoteId: "cn1", amount: 629.95 }),
    );
    expect(result).toEqual({ status: "success", zohoCreditNoteId: "cn1" });
  });

  // Any other Zoho error applying the credit note is a real failure, not
  // the known closed-invoice case - must still surface as an error rather
  // than being silently swallowed by the 12006 fallback.
  it("still reports an error for a different apply-to-invoice failure", async () => {
    fetchZohoInvoice.mockResolvedValue({ customer_id: "cust1", balance: 10, line_items: [{ sku: "sku-managed-1", item_id: "item1", rate: 629.95 }] });
    applyZohoCreditNoteToInvoice.mockRejectedValue(
      new ZohoApiError("Failed to apply Zoho credit note to invoice", {
        code: 99999,
        message: "Some other real failure",
      }),
    );

    const result = await syncRefundToZoho({
      shopId: 1,
      zohoAuth: {},
      refund,
      zohoInvoiceId: "inv1",
      accountSettings: {},
    });

    expect(createZohoCreditNoteRefund).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
  });
});

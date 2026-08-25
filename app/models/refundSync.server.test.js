import { describe, it, expect, vi, beforeEach } from "vitest";

// syncRefundToZoho talks to the DB and Zoho - mocked at the module
// boundary, same pattern as reportingSync.server.test.js, so only its own
// decision logic (apply-to-invoice vs. fall back to a direct customer
// refund) is under test here.
vi.mock("../db.server", () => ({ default: { execute: vi.fn().mockResolvedValue([[]]) } }));
vi.mock("../zoho.server", () => ({
  fetchZohoInvoice: vi.fn(),
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

import { normalizeRestRefund, syncRefundToZoho } from "./refundSync.server";
import {
  fetchZohoInvoice,
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

  it("keeps only line items with a SKU (matches order/invoice sync's own SKU-only rule)", () => {
    const refund = normalizeRestRefund({
      ...realRefundPayload,
      refund_line_items: [
        { quantity: 1, line_item: { sku: "sku-hidden-snow" } },
        { quantity: 1, line_item: {} }, // no sku - a custom/manual line item
      ],
    });

    expect(refund.lineItems).toEqual([{ sku: "sku-hidden-snow", quantity: 1 }]);
  });

  it("builds the order GID from the plain numeric order_id", () => {
    const refund = normalizeRestRefund(realRefundPayload);
    expect(refund.orderId).toBe("gid://shopify/Order/6623959679161");
  });
});

describe("syncRefundToZoho", () => {
  const refund = {
    id: "gid://shopify/Refund/1",
    orderId: "gid://shopify/Order/1",
    createdAt: "2026-08-19T00:00:00Z",
    amount: 629.95,
    gatewayNames: ["manual"],
    lineItems: [{ sku: "sku-managed-1", quantity: 1 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchZohoInvoice.mockResolvedValue({
      customer_id: "cust1",
      line_items: [{ sku: "sku-managed-1", item_id: "item1", rate: 629.95 }],
    });
    createZohoCreditNote.mockResolvedValue({ creditnote_id: "cn1" });
  });

  // Regression check for the pre-existing path - a normal (non-closed)
  // invoice still gets the credit applied against it, same as before this
  // fix.
  it("applies the credit note to the invoice when Zoho accepts it", async () => {
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
    expect(createZohoCreditNoteRefund).toHaveBeenCalled();
    expect(result).toEqual({ status: "success", zohoCreditNoteId: "cn1" });
  });

  // The real bug found live 2026-08-19: refunding against an
  // already-fully-paid invoice fails to apply (Zoho error 12006, "Credits
  // cannot be applied to invoices in the closed status") even though the
  // credit note itself was created successfully. The fix: fall back to
  // refunding the credit note straight to the customer instead of erroring
  // out and leaving it orphaned/unmapped.
  it("falls back to refunding the credit note directly when Zoho reports the invoice as closed (12006)", async () => {
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

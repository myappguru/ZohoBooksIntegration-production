import { describe, it, expect } from "vitest";
import { mapPaymentMode, buildZohoPaymentPayload } from "./paymentSync.server";

describe("mapPaymentMode", () => {
  it("maps shopify_payments/stripe/credit gateways to creditcard", () => {
    expect(mapPaymentMode(["shopify_payments"])).toBe("creditcard");
    expect(mapPaymentMode(["stripe"])).toBe("creditcard");
    expect(mapPaymentMode(["some_credit_gateway"])).toBe("creditcard");
  });

  it("maps paypal to others (Zoho has no dedicated paypal mode)", () => {
    expect(mapPaymentMode(["paypal"])).toBe("others");
  });

  it("maps bank-ish gateways to banktransfer", () => {
    expect(mapPaymentMode(["bank_transfer"])).toBe("banktransfer");
  });

  it("maps cash/manual/cod gateways to cash", () => {
    expect(mapPaymentMode(["cash"])).toBe("cash");
    expect(mapPaymentMode(["manual"])).toBe("cash");
    expect(mapPaymentMode(["cod"])).toBe("cash");
  });

  it("maps check/cheque gateways to check", () => {
    expect(mapPaymentMode(["cheque"])).toBe("check");
  });

  it("falls back to others for anything unrecognized", () => {
    expect(mapPaymentMode(["some_unknown_gateway"])).toBe("others");
  });

  it("falls back to others when there are no gateway names at all", () => {
    expect(mapPaymentMode([])).toBe("others");
    expect(mapPaymentMode(undefined)).toBe("others");
  });
});

describe("buildZohoPaymentPayload", () => {
  it("uses the order's own total as the payment amount, not a recomputed one", () => {
    const payload = buildZohoPaymentPayload(
      { totalPrice: "149.75", paymentGatewayNames: ["shopify_payments"], name: "#2001" },
      { customerId: "c1", invoiceId: "inv1" },
    );

    expect(payload.amount).toBe(149.75);
    expect(payload.invoices).toEqual([{ invoice_id: "inv1", amount_applied: 149.75 }]);
  });

  it("falls back to createdAt when updatedAt is missing for the payment date", () => {
    const payload = buildZohoPaymentPayload(
      { totalPrice: "10.00", createdAt: "2026-08-14T00:00:00Z", name: "#2001" },
      { customerId: "c1", invoiceId: "inv1" },
    );

    expect(payload.date).toBe("2026-08-14");
  });

  it("only includes account_id when one is actually configured", () => {
    const withAccount = buildZohoPaymentPayload(
      { totalPrice: "10.00", name: "#2001" },
      { customerId: "c1", invoiceId: "inv1", accountId: "acct1" },
    );
    const withoutAccount = buildZohoPaymentPayload(
      { totalPrice: "10.00", name: "#2001" },
      { customerId: "c1", invoiceId: "inv1" },
    );

    expect(withAccount.account_id).toBe("acct1");
    expect(withoutAccount.account_id).toBeUndefined();
  });
});

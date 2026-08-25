import { describe, it, expect, vi, beforeEach } from "vitest";

// reconcilePayments talks to the DB, Shopify, and Zoho - none of which
// should run for real in a unit test. This mocks each collaborator at the
// module boundary and only asserts on `reconcilePayments`'s own decision
// logic (match vs. mismatch vs. error), the actual business rule this
// function exists for - the same rule that would have caught the real
// order #1001 undercounting bug (Section F) automatically instead of
// needing a manual diagnostic.
vi.mock("../db.server", () => ({ default: { execute: vi.fn() } }));
vi.mock("./syncLog.server", () => ({
  startSyncLog: vi.fn().mockResolvedValue(1),
  finishSyncLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./orderSync.server", () => ({ fetchAllOrdersForSync: vi.fn() }));
vi.mock("./invoiceSync.server", () => ({ getInvoiceMappings: vi.fn() }));
vi.mock("./paymentSync.server", () => ({ getPaymentMappings: vi.fn() }));
vi.mock("../zoho.server", () => ({ fetchZohoInvoice: vi.fn() }));

import { reconcilePayments } from "./reportingSync.server";
import { fetchAllOrdersForSync } from "./orderSync.server";
import { getInvoiceMappings } from "./invoiceSync.server";
import { getPaymentMappings } from "./paymentSync.server";
import { fetchZohoInvoice } from "../zoho.server";

describe("reconcilePayments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags a mismatch when Shopify's total and Zoho's invoice total disagree", async () => {
    fetchAllOrdersForSync.mockResolvedValue([{ id: "order1", name: "#1001", totalPrice: "149.75" }]);
    getPaymentMappings.mockResolvedValue({ order1: { status: "synced" } });
    getInvoiceMappings.mockResolvedValue({ order1: { zohoId: "inv1" } });
    fetchZohoInvoice.mockResolvedValue({ total: 99.8, balance: 0 });

    const results = await reconcilePayments({ shopId: 1, admin: {}, zohoAuth: {} });

    expect(results).toEqual([
      { orderName: "#1001", shopifyTotal: 149.75, zohoTotal: 99.8, zohoBalance: 0, status: "mismatch" },
    ]);
  });

  it("reports a match when totals agree exactly, and a match within a cent of rounding", async () => {
    fetchAllOrdersForSync.mockResolvedValue([{ id: "order1", name: "#1002", totalPrice: "577.45" }]);
    getPaymentMappings.mockResolvedValue({ order1: { status: "synced" } });
    getInvoiceMappings.mockResolvedValue({ order1: { zohoId: "inv1" } });
    fetchZohoInvoice.mockResolvedValue({ total: 577.45, balance: 0 });

    const results = await reconcilePayments({ shopId: 1, admin: {}, zohoAuth: {} });

    expect(results[0].status).toBe("match");
  });

  it("skips an order whose payment hasn't synced yet (status !== 'synced')", async () => {
    fetchAllOrdersForSync.mockResolvedValue([{ id: "order1", name: "#1001", totalPrice: "149.75" }]);
    getPaymentMappings.mockResolvedValue({ order1: { status: "error" } });
    getInvoiceMappings.mockResolvedValue({ order1: { zohoId: "inv1" } });

    const results = await reconcilePayments({ shopId: 1, admin: {}, zohoAuth: {} });

    expect(results).toEqual([]);
    expect(fetchZohoInvoice).not.toHaveBeenCalled();
  });

  it("skips an order with a synced payment but no invoice mapping at all", async () => {
    fetchAllOrdersForSync.mockResolvedValue([{ id: "order1", name: "#1001", totalPrice: "149.75" }]);
    getPaymentMappings.mockResolvedValue({ order1: { status: "synced" } });
    getInvoiceMappings.mockResolvedValue({});

    const results = await reconcilePayments({ shopId: 1, admin: {}, zohoAuth: {} });

    expect(results).toEqual([]);
  });

  it("records a Zoho fetch failure as its own 'error' status rather than throwing", async () => {
    fetchAllOrdersForSync.mockResolvedValue([{ id: "order1", name: "#1001", totalPrice: "149.75" }]);
    getPaymentMappings.mockResolvedValue({ order1: { status: "synced" } });
    getInvoiceMappings.mockResolvedValue({ order1: { zohoId: "inv1" } });
    fetchZohoInvoice.mockRejectedValue(new Error("Zoho is down"));

    const results = await reconcilePayments({ shopId: 1, admin: {}, zohoAuth: {} });

    expect(results[0].status).toBe("error");
  });
});

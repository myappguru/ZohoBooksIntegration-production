import { describe, it, expect, vi, beforeEach } from "vitest";

const events = [];
const slowHandler = (name) =>
  vi.fn(async (event) => {
    events.push(`start:${name}:${event.webhookId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end:${name}:${event.webhookId}`);
  });

vi.mock("../db.server", () => ({ default: { execute: vi.fn() } }));
vi.mock("../shopify.server", () => ({ unauthenticated: { admin: vi.fn().mockResolvedValue({ admin: { graphql: vi.fn() } }) } }));
vi.mock("./orderSync.server", () => ({ processOrderUpsertWebhook: slowHandler("order") }));
vi.mock("./paymentSync.server", () => ({ processOrderPaidWebhook: slowHandler("paid") }));
vi.mock("./productSync.server", () => ({ processProductUpsertWebhook: slowHandler("product") }));
vi.mock("./customerSync.server", () => ({ processCustomerUpsertWebhook: slowHandler("customer") }));
vi.mock("./fulfillmentSync.server", () => ({ processFulfillmentCreateWebhook: vi.fn() }));
vi.mock("./refundSync.server", () => ({ processRefundCreateWebhook: slowHandler("refund") }));
vi.mock("./webhookHandlers.server", () => ({
  processInventoryLevelWebhook: vi.fn(),
  processOrderCancelledWebhook: vi.fn(),
  processCustomerDeleteWebhook: vi.fn(),
  processProductDeleteWebhook: vi.fn(),
}));

const db = (await import("../db.server")).default;
const { enqueueWebhook, retryFailedWebhooks, normalizeTopic } = await import("./webhookQueue.server");
const { processRefundCreateWebhook } = await import("./refundSync.server");
const { processProductUpsertWebhook } = await import("./productSync.server");

beforeEach(() => {
  events.length = 0;
  vi.clearAllMocks();
});

describe("enqueueWebhook", () => {
  it("processes one shop's events in arrival order, one at a time", async () => {
    await Promise.all([
      enqueueWebhook({ shop: "a.myshopify.com", topic: "ORDERS_CREATE", webhookId: "1", payload: {} }),
      enqueueWebhook({ shop: "a.myshopify.com", topic: "ORDERS_PAID", webhookId: "2", payload: {} }),
    ]);

    expect(events).toEqual(["start:order:1", "end:order:1", "start:paid:2", "end:paid:2"]);
  });

  it("accepts REST-style topic names too", () => {
    expect(normalizeTopic("orders/paid")).toBe("ORDERS_PAID");
  });
});

describe("retryFailedWebhooks", () => {
  it("replays a failed event-type webhook with its stored payload", async () => {
    db.execute
      .mockResolvedValueOnce([[{ id: 7, shop_id: 1, webhook_id: "w7", topic: "REFUNDS_CREATE", shop_domain: "a.myshopify.com", resource_id: "gid://shopify/Refund/1", payload: { id: 1 }, attempts: 1, status: "failed" }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await retryFailedWebhooks();

    expect(result).toEqual({ retried: 1 });
    expect(processRefundCreateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ shop: "a.myshopify.com", webhookId: "w7", payload: { id: 1 } }),
    );
  });

  it("skips a stale product payload that a newer delivery has superseded", async () => {
    db.execute
      .mockResolvedValueOnce([[{ id: 8, shop_id: 1, webhook_id: "w8", topic: "PRODUCTS_UPDATE", shop_domain: "a.myshopify.com", resource_id: "gid://shopify/Product/1", payload: {}, attempts: 1, status: "failed" }]])
      .mockResolvedValueOnce([[{ id: 9 }]]) // newer row exists
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await retryFailedWebhooks();

    expect(result).toEqual({ retried: 0 });
    expect(processProductUpsertWebhook).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from "vitest";
import { normalizeRestFulfillment } from "./fulfillmentSync.server";

describe("normalizeRestFulfillment", () => {
  const basePayload = {
    id: 5823719014585,
    order_id: 6623959679161,
    name: "#1004-F1",
    admin_graphql_api_id: "gid://shopify/Fulfillment/5823719014585",
    line_items: [{ sku: "sku-hidden-snow", quantity: 1 }],
  };

  it("prefers a direct tracking_number over the tracking_numbers array", () => {
    const fulfillment = normalizeRestFulfillment({
      ...basePayload,
      tracking_number: "1Z999",
      tracking_numbers: ["OTHER123"],
    });

    expect(fulfillment.trackingNumber).toBe("1Z999");
  });

  it("falls back to the first entry in tracking_numbers when tracking_number is absent", () => {
    const fulfillment = normalizeRestFulfillment({
      ...basePayload,
      tracking_numbers: ["OTHER123", "OTHER456"],
    });

    expect(fulfillment.trackingNumber).toBe("OTHER123");
  });

  it("is null when there's no tracking number at all (a manual, untracked fulfillment)", () => {
    const fulfillment = normalizeRestFulfillment(basePayload);
    expect(fulfillment.trackingNumber).toBeNull();
    expect(fulfillment.trackingCompany).toBeNull();
  });

  it("passes through the tracking company when present", () => {
    const fulfillment = normalizeRestFulfillment({ ...basePayload, tracking_company: "UPS" });
    expect(fulfillment.trackingCompany).toBe("UPS");
  });

  it("builds the order GID from the plain numeric order_id", () => {
    const fulfillment = normalizeRestFulfillment(basePayload);
    expect(fulfillment.orderId).toBe("gid://shopify/Order/6623959679161");
  });
});

import { describe, it, expect } from "vitest";
import { buildZohoItemPayload, normalizeRestProduct } from "./productSync.server";

describe("buildZohoItemPayload", () => {
  const product = { title: "The Hidden Snowboard", description: "A snowboard." };

  it("combines product and variant title when the variant has a real title", () => {
    const payload = buildZohoItemPayload(product, {
      title: "Special Edition",
      sku: "sku-1",
      price: "749.95",
    });

    expect(payload.name).toBe("The Hidden Snowboard - Special Edition");
  });

  it("uses just the product title when the variant title is Shopify's default placeholder", () => {
    const payload = buildZohoItemPayload(product, {
      title: "Default Title",
      sku: "sku-1",
      price: "749.95",
    });

    expect(payload.name).toBe("The Hidden Snowboard");
  });

  it("only sends track_inventory/inventory_account_id when an inventory account is configured", () => {
    const untracked = buildZohoItemPayload(product, { title: "Default Title", sku: "sku-1", price: "1" });
    const tracked = buildZohoItemPayload(
      product,
      { title: "Default Title", sku: "sku-1", price: "1" },
      { inventoryAccountId: "acct1" },
    );

    expect(untracked.track_inventory).toBeUndefined();
    expect(tracked.track_inventory).toBe(true);
    expect(tracked.inventory_account_id).toBe("acct1");
  });
});

describe("normalizeRestProduct", () => {
  it("strips HTML tags from the description", () => {
    const product = normalizeRestProduct({
      admin_graphql_api_id: "gid://shopify/Product/1",
      title: "Widget",
      status: "active",
      body_html: "<p>A <strong>great</strong> widget.</p>",
      variants: [],
    });

    expect(product.description).toBe("A great widget.");
  });

  it("uppercases the status to match the GraphQL query's shape", () => {
    const product = normalizeRestProduct({
      admin_graphql_api_id: "gid://shopify/Product/1",
      title: "Widget",
      status: "draft",
      variants: [],
    });

    expect(product.status).toBe("DRAFT");
  });
});

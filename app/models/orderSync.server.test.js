import { describe, it, expect } from "vitest";
import {
  buildTaxRateKey,
  buildTaxRateLabel,
  buildZohoSalesOrderPayload,
  buildOrderCustomer,
  normalizeRestOrder,
} from "./orderSync.server";

describe("buildTaxRateKey", () => {
  it("returns null when there are no tax lines", () => {
    expect(buildTaxRateKey([])).toBeNull();
    expect(buildTaxRateKey(null)).toBeNull();
    expect(buildTaxRateKey(undefined)).toBeNull();
  });

  it("builds a stable key for a single tax line", () => {
    expect(buildTaxRateKey([{ title: "GST 18%", rate: 0.18 }])).toBe("GST 18%@0.1800");
  });

  it("combines a compound (multi-line) tax the same way regardless of array order", () => {
    const cgstFirst = buildTaxRateKey([
      { title: "CGST", rate: 0.09 },
      { title: "SGST", rate: 0.09 },
    ]);
    const sgstFirst = buildTaxRateKey([
      { title: "SGST", rate: 0.09 },
      { title: "CGST", rate: 0.09 },
    ]);

    expect(cgstFirst).toBe(sgstFirst);
    expect(cgstFirst).toBe("CGST@0.0900+SGST@0.0900");
  });

  it("treats a missing rate as 0 rather than throwing", () => {
    expect(buildTaxRateKey([{ title: "Zero-rated" }])).toBe("Zero-rated@0.0000");
  });
});

describe("buildTaxRateLabel", () => {
  it("returns null for no tax lines", () => {
    expect(buildTaxRateLabel([])).toBeNull();
  });

  it("formats a single rate as a percentage", () => {
    expect(buildTaxRateLabel([{ title: "GST 18%", rate: 0.18 }])).toBe("GST 18% (18.00%)");
  });

  it("joins a compound rate with ' + '", () => {
    expect(
      buildTaxRateLabel([
        { title: "CGST", rate: 0.09 },
        { title: "SGST", rate: 0.09 },
      ]),
    ).toBe("CGST (9.00%) + SGST (9.00%)");
  });
});

describe("buildZohoSalesOrderPayload", () => {
  const baseOrder = {
    createdAt: "2026-08-18T00:00:00Z",
    name: "#2001",
    totalDiscount: "0",
    totalShipping: "10.00",
    note: "",
    discountCodes: [],
  };

  it("always sends discount_type entity_level, matching this app's single flat-discount-number behavior", () => {
    const payload = buildZohoSalesOrderPayload(baseOrder, {
      customerId: "c1",
      lineItems: [],
      taxSettings: {},
    });

    expect(payload.discount_type).toBe("entity_level");
  });

  it("defaults is_discount_before_tax to true when unset", () => {
    const payload = buildZohoSalesOrderPayload(baseOrder, {
      customerId: "c1",
      lineItems: [],
      taxSettings: {},
    });

    expect(payload.is_discount_before_tax).toBe(true);
  });

  it("respects an explicit discountBeforeTax: false setting", () => {
    const payload = buildZohoSalesOrderPayload(baseOrder, {
      customerId: "c1",
      lineItems: [],
      taxSettings: { discountBeforeTax: false },
    });

    expect(payload.is_discount_before_tax).toBe(false);
  });

  it("includes delivery_method only when the order has a shipping method", () => {
    const withShipping = buildZohoSalesOrderPayload(
      { ...baseOrder, shippingMethod: "Standard Shipping" },
      { customerId: "c1", lineItems: [], taxSettings: {} },
    );
    const withoutShipping = buildZohoSalesOrderPayload(baseOrder, {
      customerId: "c1",
      lineItems: [],
      taxSettings: {},
    });

    expect(withShipping.delivery_method).toBe("Standard Shipping");
    expect(withoutShipping.delivery_method).toBeUndefined();
  });

  it("resolves a line item's tax_id from rateMap over the default tax", () => {
    const lineItems = [
      {
        zohoItemId: "item1",
        quantity: 1,
        price: "100.00",
        taxLines: [{ title: "GST 18%", rate: 0.18 }],
      },
    ];
    const payload = buildZohoSalesOrderPayload(baseOrder, {
      customerId: "c1",
      lineItems,
      taxSettings: {
        defaultTaxId: "default-tax",
        rateMap: { "GST 18%@0.1800": "mapped-tax" },
      },
    });

    expect(payload.line_items[0].tax_id).toBe("mapped-tax");
  });

  it("falls back to the default tax when the line item's rate isn't mapped", () => {
    const lineItems = [
      {
        zohoItemId: "item1",
        quantity: 1,
        price: "100.00",
        taxLines: [{ title: "VAT 20%", rate: 0.2 }],
      },
    ];
    const payload = buildZohoSalesOrderPayload(baseOrder, {
      customerId: "c1",
      lineItems,
      taxSettings: { defaultTaxId: "default-tax", rateMap: {} },
    });

    expect(payload.line_items[0].tax_id).toBe("default-tax");
  });

  it("omits tax_id entirely when there's no mapping and no default (old pre-Section-J behavior)", () => {
    const lineItems = [{ zohoItemId: "item1", quantity: 1, price: "100.00", taxLines: [] }];
    const payload = buildZohoSalesOrderPayload(baseOrder, {
      customerId: "c1",
      lineItems,
      taxSettings: {},
    });

    expect(payload.line_items[0].tax_id).toBeUndefined();
  });
});

describe("buildOrderCustomer", () => {
  it("passes through a registered Shopify customer as-is", () => {
    const order = { customer: { id: "gid://shopify/Customer/1", email: "a@example.com" } };
    expect(buildOrderCustomer(order)).toBe(order.customer);
  });

  it("builds a synthetic guest:<email> id for guest checkouts", () => {
    const order = {
      email: "guest@example.com",
      billingAddress: { firstName: "Jamie", lastName: "Lee", address1: "1 Main St" },
    };
    const customer = buildOrderCustomer(order);

    expect(customer.id).toBe("guest:guest@example.com");
    expect(customer.firstName).toBe("Jamie");
    expect(customer.address.address1).toBe("1 Main St");
  });

  it("returns a null id when there's no customer and no email at all", () => {
    const customer = buildOrderCustomer({});
    expect(customer.id).toBeNull();
    expect(customer.email).toBeNull();
  });
});

describe("normalizeRestOrder", () => {
  it("extracts the shipping method title from shipping_lines[0]", () => {
    const order = normalizeRestOrder({
      admin_graphql_api_id: "gid://shopify/Order/1",
      name: "#2001",
      shipping_lines: [{ title: "Express Shipping" }],
    });

    expect(order.shippingMethod).toBe("Express Shipping");
  });

  it("is null when there are no shipping lines", () => {
    const order = normalizeRestOrder({
      admin_graphql_api_id: "gid://shopify/Order/1",
      name: "#2001",
      shipping_lines: [],
    });

    expect(order.shippingMethod).toBeNull();
  });

  it("maps each line item's tax_lines into { title, rate } pairs", () => {
    const order = normalizeRestOrder({
      admin_graphql_api_id: "gid://shopify/Order/1",
      name: "#2001",
      line_items: [
        {
          sku: "sku-1",
          title: "Widget",
          quantity: 1,
          price: "10.00",
          tax_lines: [{ title: "GST 18%", rate: "0.18" }],
        },
      ],
    });

    expect(order.lineItems[0].taxLines).toEqual([{ title: "GST 18%", rate: 0.18 }]);
  });
});

import { describe, it, expect } from "vitest";
import { buildZohoContactPayload } from "./customerSync.server";

describe("buildZohoContactPayload", () => {
  it("uses the full name when both first and last name are present", () => {
    const payload = buildZohoContactPayload({ firstName: "Jamie", lastName: "Lee", email: "jamie@example.com" });
    expect(payload.contact_name).toBe("Jamie Lee");
  });

  it("falls back to email when there's no name at all", () => {
    const payload = buildZohoContactPayload({ email: "jamie@example.com" });
    expect(payload.contact_name).toBe("jamie@example.com");
  });

  it("falls back to a generic label when there's neither a name nor an email", () => {
    const payload = buildZohoContactPayload({});
    expect(payload.contact_name).toBe("Unnamed customer");
  });

  it("always sends customer_sub_type individual (no B2B support yet)", () => {
    const payload = buildZohoContactPayload({ email: "jamie@example.com" });
    expect(payload.customer_sub_type).toBe("individual");
  });

  it("mirrors the billing address into shipping_address (only defaultAddress syncs today)", () => {
    const payload = buildZohoContactPayload({
      email: "jamie@example.com",
      address: { address1: "1 Main St", city: "Springfield" },
    });

    expect(payload.billing_address).toEqual(payload.shipping_address);
    expect(payload.billing_address.address).toBe("1 Main St");
    expect(payload.billing_address.city).toBe("Springfield");
  });
});

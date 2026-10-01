import { describe, expect, it, vi } from "vitest";
import { openZohoAuthPopup, ZOHO_POPUP_NAME } from "./zohoAuthPopup";

function fakePopup() {
  return { location: { href: "about:blank" }, focus: vi.fn(), close: vi.fn() };
}

describe("openZohoAuthPopup", () => {
  it("opens a blank popup first, then points it at the freshly fetched URL", async () => {
    const popup = fakePopup();
    const openWindow = vi.fn(() => popup);
    const fetchUrl = vi.fn(async () => {
      // The popup must already be open before the (async) URL fetch, so the
      // browser still counts it as a response to the click.
      expect(openWindow).toHaveBeenCalledTimes(1);
      return "https://accounts.zoho.com/oauth/v2/auth?state=fresh";
    });

    const result = await openZohoAuthPopup({ openWindow, fetchUrl });

    expect(result).toEqual({ ok: true });
    expect(openWindow).toHaveBeenCalledWith("about:blank", ZOHO_POPUP_NAME, expect.any(String));
    expect(popup.location.href).toBe("https://accounts.zoho.com/oauth/v2/auth?state=fresh");
  });

  it("navigates a reused popup instead of leaving its old page", async () => {
    const popup = fakePopup();
    popup.location.href = "https://accounts.zoho.com/oauth/v2/auth?state=stale";

    await openZohoAuthPopup({ openWindow: () => popup, fetchUrl: async () => "https://accounts.zoho.com/oauth/v2/auth?state=fresh" });

    expect(popup.location.href).toBe("https://accounts.zoho.com/oauth/v2/auth?state=fresh");
  });

  it("reports a blocked popup without fetching", async () => {
    const fetchUrl = vi.fn();
    const result = await openZohoAuthPopup({ openWindow: () => null, fetchUrl });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/i);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("closes the popup and reports an error when the URL can't be fetched", async () => {
    const popup = fakePopup();
    const result = await openZohoAuthPopup({
      openWindow: () => popup,
      fetchUrl: async () => {
        throw new Error("401");
      },
    });

    expect(result.ok).toBe(false);
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe("about:blank");
  });

  it("treats an empty URL as a failure", async () => {
    const popup = fakePopup();
    const result = await openZohoAuthPopup({ openWindow: () => popup, fetchUrl: async () => "" });

    expect(result.ok).toBe(false);
    expect(popup.close).toHaveBeenCalled();
  });
});

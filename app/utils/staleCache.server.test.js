import { describe, expect, it } from "vitest";
import { addStaleCacheClearHeaders, CACHE_CLEARED_COOKIE, CLEAR_STALE_CACHE_UNTIL } from "./staleCache.server";

function requestWithCookie(cookie) {
  return new Request("https://example.com/app", cookie ? { headers: { cookie } } : undefined);
}

const BEFORE_CUTOFF = Date.parse("2026-10-01T08:00:00Z");

describe("addStaleCacheClearHeaders", () => {
  it("clears the cache and sets the marker cookie on a browser's first page load", () => {
    const headers = new Headers();
    addStaleCacheClearHeaders(requestWithCookie(), headers, BEFORE_CUTOFF);

    expect(headers.get("Clear-Site-Data")).toBe('"cache"');
    const cookie = headers.get("Set-Cookie");
    expect(cookie).toContain(`${CACHE_CLEARED_COOKIE}=1`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
  });

  it("does nothing once the browser already has the marker cookie", () => {
    const headers = new Headers();
    addStaleCacheClearHeaders(requestWithCookie(`other=x; ${CACHE_CLEARED_COOKIE}=1`), headers, BEFORE_CUTOFF);

    expect(headers.get("Clear-Site-Data")).toBeNull();
    expect(headers.get("Set-Cookie")).toBeNull();
  });

  it("ignores a cookie that only looks similar", () => {
    const headers = new Headers();
    addStaleCacheClearHeaders(requestWithCookie(`${CACHE_CLEARED_COOKIE}=10`), headers, BEFORE_CUTOFF);

    expect(headers.get("Clear-Site-Data")).toBe('"cache"');
  });

  it("does nothing after the cutoff, when every stale copy has expired", () => {
    const headers = new Headers();
    addStaleCacheClearHeaders(requestWithCookie(), headers, CLEAR_STALE_CACHE_UNTIL);

    expect(headers.get("Clear-Site-Data")).toBeNull();
    expect(headers.get("Set-Cookie")).toBeNull();
  });

  it("keeps cookies other code already set on the response", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "existing=1; Path=/");
    addStaleCacheClearHeaders(requestWithCookie(), headers, BEFORE_CUTOFF);

    expect(headers.getSetCookie()).toHaveLength(2);
  });
});

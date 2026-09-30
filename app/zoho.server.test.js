import { describe, it, expect, vi, afterEach } from "vitest";
import { zohoFetch, normalizeAccountsServer } from "./zoho.server";

const res = (status, body, headers = {}) =>
  new Response(body, { status, headers: { "retry-after": "0", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("zohoFetch", () => {
  it("retries a 429 and returns the eventual response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(429, "<html>slow down</html>"))
      .mockResolvedValueOnce(res(200, JSON.stringify({ code: 0, ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await zohoFetch("https://zoho.test/x", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({ code: 0, ok: true });
  });

  it("does not retry a POST on a 5xx (it may already have been applied)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(502, "Bad gateway"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await zohoFetch("https://zoho.test/x", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.ok).toBe(false);
    expect(await response.json()).toMatchObject({ code: -1, http_status: 502, body: "Bad gateway" });
  });

  it("retries an idempotent GET on a 5xx", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(503, ""))
      .mockResolvedValueOnce(res(200, JSON.stringify({ code: 0 })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await zohoFetch("https://zoho.test/x");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({ code: 0 });
  });
});

describe("normalizeAccountsServer", () => {
  it("only accepts Zoho accounts hosts over https", () => {
    expect(normalizeAccountsServer("https://accounts.zoho.in")).toBe("https://accounts.zoho.in");
    expect(normalizeAccountsServer("https://accounts.zohocloud.ca/")).toBe("https://accounts.zohocloud.ca");
    expect(normalizeAccountsServer("https://attacker.example")).toBeNull();
    expect(normalizeAccountsServer("https://accounts.zoho.com.evil.io")).toBeNull();
    expect(normalizeAccountsServer("http://accounts.zoho.com")).toBeNull();
  });
});

// Until the 2026-10-01 restart, Apache's inherited WordPress rule
// ("ExpiresDefault access plus 1 month", see .htaccess) made browsers cache
// React Router .data responses for 30 days. A browser holding one of those
// copies shows that old page (e.g. a dashboard stuck on "Zoho not
// connected") without ever asking the server. Tell each browser once to drop
// its cache for this origin. After the cutoff every such copy has expired on
// its own, so this can be deleted.
export const CLEAR_STALE_CACHE_UNTIL = Date.parse("2026-11-01T00:00:00Z");
export const CACHE_CLEARED_COOKIE = "zb_cache_cleared";

export function addStaleCacheClearHeaders(request, responseHeaders, now = Date.now()) {
  if (now >= CLEAR_STALE_CACHE_UNTIL) return;

  const cookies = (request.headers.get("cookie") || "").split(/;\s*/);
  if (cookies.includes(`${CACHE_CLEARED_COOKIE}=1`)) return;

  responseHeaders.set("Clear-Site-Data", '"cache"');
  // Partitioned (CHIPS) so the cookie still works inside the Shopify admin
  // iframe, and lines up with the browser's per-top-level-site cache.
  responseHeaders.append(
    "Set-Cookie",
    `${CACHE_CLEARED_COOKIE}=1; Max-Age=${60 * 60 * 24 * 40}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
  );
}

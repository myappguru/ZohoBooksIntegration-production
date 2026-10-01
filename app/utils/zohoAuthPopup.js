export const ZOHO_POPUP_NAME = "zoho-connect";
const POPUP_FEATURES = "width=600,height=720";

// Opens the Zoho OAuth popup with a URL fetched at click time.
//
// The popup is opened synchronously (blank) so the browser still treats it
// as a response to the click, then pointed at the fresh URL. Setting its
// location explicitly also means a leftover "zoho-connect" window from an
// earlier attempt is always navigated to the new URL rather than reused as
// it was, with its old (expired) state.
//
// Returns { ok: true } or { ok: false, error } - callers show the error.
export async function openZohoAuthPopup({
  openWindow = (url, name, features) => window.open(url, name, features),
  fetchUrl = defaultFetchUrl,
} = {}) {
  const popup = openWindow("about:blank", ZOHO_POPUP_NAME, POPUP_FEATURES);
  if (!popup) {
    return { ok: false, error: "Your browser blocked the Zoho Books window. Allow pop-ups for this app and try again." };
  }

  try {
    const url = await fetchUrl();
    if (typeof url !== "string" || !url) throw new Error("No authorization URL returned");
    popup.location.href = url;
    try {
      popup.focus();
    } catch {
      // Focus is best-effort.
    }
    return { ok: true };
  } catch {
    try {
      popup.close();
    } catch {
      // Already closed.
    }
    return { ok: false, error: "Couldn't start the Zoho Books connection. Please try again." };
  }
}

async function defaultFetchUrl() {
  // App Bridge adds the session token to same-origin fetches.
  const response = await fetch("/app/zoho-auth-url", { cache: "no-store" });
  if (!response.ok) throw new Error(`Auth URL request failed (${response.status})`);
  const data = await response.json();
  return data?.url;
}

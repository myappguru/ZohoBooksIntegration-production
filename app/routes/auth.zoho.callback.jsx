import { verifyOAuthState, normalizeAccountsServer } from "../zoho.server";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON that is safe to drop inside a <script> block.
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function resultPage({ title, message, success, handoff = null }) {
  const safeTitle = escapeHtml(title);
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <title>${safeTitle}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f6f7; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { background: #fff; border-radius: 12px; padding: 32px 40px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); max-width: 420px; text-align: center; }
      h1 { font-size: 18px; margin-bottom: 8px; color: ${success ? "#008060" : "#d72c0d"}; }
      p { color: #4a4a4a; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1 id="title">${safeTitle}</h1>
      <p id="message">${escapeHtml(message)}</p>
      <p>You can close this tab and return to Shopify admin.</p>
    </div>
    <script>
      (function () {
        var handoff = ${scriptJson(handoff)};
        var delivered = false;
        try {
          if (window.opener) {
            window.opener.postMessage(
              handoff
                ? { source: "zoho-oauth", type: "authorization-code", code: handoff.code, state: handoff.state, accountsServer: handoff.accountsServer }
                : { source: "zoho-oauth", success: ${success ? "true" : "false"} },
              window.location.origin
            );
            delivered = true;
          }
        } catch (e) {}
        if (handoff && !delivered) {
          document.getElementById("title").textContent = "Connection not completed";
          document.getElementById("message").textContent =
            "Please open the app in Shopify admin and click Connect Zoho Books again.";
          return;
        }
        setTimeout(function () { window.close(); }, handoff ? 1500 : 4000);
      })();
    </script>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// Zoho redirects the popup here. We deliberately do NOT exchange the code in
// this request: nothing here proves which Shopify admin started the flow, so
// a "Connect Zoho" link sent to someone else would link their Zoho org to the
// sender's store. Instead the code is handed back to the embedded app window
// that opened this popup, and the authenticated `/app/zoho-connect` action
// finishes the exchange after checking the state belongs to that session.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  // Zoho reports which data center actually issued this code
  // (accounts.zoho.com/.in/.eu/zohocloud.ca/...). It is only trusted when it
  // is one of Zoho's own accounts hosts - see normalizeAccountsServer.
  const accountsServerParam = url.searchParams.get("accounts-server");

  if (errorParam) {
    return resultPage({
      title: "Connection cancelled",
      message: `Zoho did not complete the connection (${errorParam}).`,
      success: false,
    });
  }

  const statePayload = verifyOAuthState(state);

  if (!statePayload || !code) {
    return resultPage({
      title: "Connection failed",
      message: "This authorization link is invalid or has expired. Please try connecting again from the app.",
      success: false,
    });
  }

  const accountsServer = accountsServerParam ? normalizeAccountsServer(accountsServerParam) : null;
  if (accountsServerParam && !accountsServer) {
    console.warn("Rejected Zoho OAuth callback with untrusted accounts-server", { accountsServer: accountsServerParam, shop: statePayload.shop });
    return resultPage({
      title: "Connection failed",
      message: "This authorization response did not come from Zoho. Please try connecting again from the app.",
      success: false,
    });
  }

  return resultPage({
    title: "Finishing connection…",
    message: "Returning to the app to complete the Zoho Books connection.",
    success: true,
    handoff: { code, state, accountsServer },
  });
};

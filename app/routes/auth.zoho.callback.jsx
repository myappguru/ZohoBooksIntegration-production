import {
  verifyOAuthState,
  exchangeCodeForToken,
  fetchOrganizations,
  dataCenterFromApiDomain,
  getPreferredOrganizationId,
} from "../zoho.server";
import { ensureShop } from "../models/shop.server";
import { getActiveConnection, saveConnection } from "../models/zohoConnection.server";

function resultPage({ title, message, success }) {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f6f7; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { background: #fff; border-radius: 12px; padding: 32px 40px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); max-width: 420px; text-align: center; }
      h1 { font-size: 18px; margin-bottom: 8px; color: ${success ? "#008060" : "#d72c0d"}; }
      p { color: #4a4a4a; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
      <p>You can close this tab and return to Shopify admin.</p>
    </div>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage({ source: "zoho-oauth", success: ${success ? "true" : "false"} }, window.location.origin);
        }
      } catch (e) {}
      setTimeout(function () { window.close(); }, 4000);
    </script>
  </body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  // Zoho reports which data center actually issued this code (accounts.zoho.com/.in/.eu/...).
  // A merchant's Zoho account can be on any of these, so the token exchange must target
  // this exact server rather than a single hardcoded region.
  const accountsServer = url.searchParams.get("accounts-server");

  if (errorParam) {
    return resultPage({
      title: "Connection cancelled",
      message: `Zoho did not complete the connection (${errorParam}).`,
      success: false,
    });
  }

  const shopDomain = verifyOAuthState(state);

  if (!shopDomain || !code) {
    return resultPage({
      title: "Connection failed",
      message: "This authorization link is invalid or has expired. Please try connecting again from the app.",
      success: false,
    });
  }

  try {
    const shop = await ensureShop(shopDomain);
    const tokenResponse = await exchangeCodeForToken(code, accountsServer || undefined);

    let refreshToken = tokenResponse.refresh_token;
    if (!refreshToken) {
      const existing = await getActiveConnection(shop.id);
      refreshToken = existing?.refresh_token;
    }

    if (!refreshToken) {
      return resultPage({
        title: "Connection failed",
        message: "Zoho did not grant offline access. Please try connecting again and approve the request.",
        success: false,
      });
    }

    const organizations = await fetchOrganizations({
      accessToken: tokenResponse.access_token,
      apiDomain: tokenResponse.api_domain,
    });

    const preferredOrgId = getPreferredOrganizationId();
    const organization =
      organizations.find((org) => org.organization_id === preferredOrgId) || organizations[0];

    if (!organization) {
      return resultPage({
        title: "No Zoho organization found",
        message: "We couldn't find any Zoho Books organization on this account.",
        success: false,
      });
    }

    await saveConnection(shop.id, {
      organizationId: organization.organization_id,
      organizationName: organization.name,
      accessToken: tokenResponse.access_token,
      refreshToken,
      apiDomain: tokenResponse.api_domain,
      dataCenter: dataCenterFromApiDomain(tokenResponse.api_domain),
      scope: tokenResponse.scope,
      accessTokenExpiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
    });

    return resultPage({
      title: "Zoho Books connected",
      message: `Connected to "${organization.name}" successfully.`,
      success: true,
    });
  } catch (error) {
    console.error("Zoho OAuth callback failed", error);

    return resultPage({
      title: "Connection failed",
      message: "Something went wrong while connecting to Zoho Books. Please try again.",
      success: false,
    });
  }
};

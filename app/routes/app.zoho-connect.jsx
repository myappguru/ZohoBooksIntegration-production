import { authenticate } from "../shopify.server";
import {
  verifyOAuthState,
  normalizeAccountsServer,
  exchangeCodeForToken,
  fetchOrganizations,
  dataCenterFromApiDomain,
  getPreferredOrganizationId,
} from "../zoho.server";
import { ensureShop } from "../models/shop.server";
import { getActiveConnection, saveConnection } from "../models/zohoConnection.server";

// Completes the Zoho OAuth flow. Called by useZohoConnectionSync with the
// code the /auth/zoho/callback popup handed back. Because this request is
// authenticated as a Shopify admin, and the signed state must name that same
// shop, a Zoho authorization started by someone else can't be attached to
// this store (and vice versa).
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const code = formData.get("code");
  const state = formData.get("state");
  const accountsServerParam = formData.get("accountsServer") || null;

  const statePayload = verifyOAuthState(typeof state === "string" ? state : null);
  if (!code || !statePayload || statePayload.shop !== session.shop) {
    return { ok: false, error: "This Zoho authorization is invalid or has expired. Please try connecting again." };
  }

  const accountsServer = accountsServerParam ? normalizeAccountsServer(accountsServerParam) : null;
  if (accountsServerParam && !accountsServer) {
    return { ok: false, error: "This authorization response did not come from Zoho. Please try connecting again." };
  }

  try {
    const shop = await ensureShop(session.shop);
    const tokenResponse = await exchangeCodeForToken(String(code), accountsServer || undefined);

    let refreshToken = tokenResponse.refresh_token;
    if (!refreshToken) {
      const existing = await getActiveConnection(shop.id);
      refreshToken = existing?.refresh_token;
    }

    if (!refreshToken) {
      return { ok: false, error: "Zoho did not grant offline access. Please try connecting again and approve the request." };
    }

    const organizations = await fetchOrganizations({
      accessToken: tokenResponse.access_token,
      apiDomain: tokenResponse.api_domain,
    });

    const preferredOrgId = getPreferredOrganizationId();
    const organization =
      organizations.find((org) => org.organization_id === preferredOrgId) || organizations[0];

    if (!organization) {
      return { ok: false, error: "We couldn't find any Zoho Books organization on this account." };
    }

    await saveConnection(shop.id, {
      organizationId: organization.organization_id,
      organizationName: organization.name,
      accessToken: tokenResponse.access_token,
      refreshToken,
      apiDomain: tokenResponse.api_domain,
      dataCenter: dataCenterFromApiDomain(tokenResponse.api_domain),
      accountsServer,
      scope: tokenResponse.scope,
      accessTokenExpiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
    });

    return { ok: true, organizationName: organization.name };
  } catch (error) {
    console.error("Zoho OAuth completion failed", error);
    return { ok: false, error: "Something went wrong while connecting to Zoho Books. Please try again." };
  }
};

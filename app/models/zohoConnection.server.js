import db from "../db.server";
import { ensureShop } from "./shop.server";
import { withResourceLock, resourceLockKey } from "./resourceLock.server";
import { refreshAccessToken, accountsServerForDataCenter, normalizeAccountsServer } from "../zoho.server";

export async function getActiveConnection(shopId) {
  const [rows] = await db.execute(
    `SELECT * FROM zoho_connections WHERE shop_id = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1`,
    [shopId]
  );

  return rows[0] || null;
}

export async function getConnectionForShopDomain(shopDomain) {
  const shop = await ensureShop(shopDomain);
  const connection = await getActiveConnection(shop.id);

  return { shop, connection };
}

export async function saveConnection(shopId, {
  organizationId,
  organizationName,
  accessToken,
  refreshToken,
  apiDomain,
  dataCenter,
  accountsServer,
  scope,
  accessTokenExpiresAt,
}) {
  if (!refreshToken) {
    throw new Error("saveConnection requires a refresh token");
  }

  await db.execute(
    `INSERT INTO zoho_connections
       (shop_id, organization_id, organization_name, access_token, refresh_token, api_domain, data_center, accounts_server, scope, access_token_expires_at, is_active, connected_at, disconnected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW(), NULL)
     ON DUPLICATE KEY UPDATE
       organization_name = VALUES(organization_name),
       access_token = VALUES(access_token),
       refresh_token = VALUES(refresh_token),
       api_domain = VALUES(api_domain),
       data_center = VALUES(data_center),
       accounts_server = VALUES(accounts_server),
       scope = VALUES(scope),
       access_token_expires_at = VALUES(access_token_expires_at),
       is_active = TRUE,
       needs_reauth = FALSE,
       last_auth_error = NULL,
       connected_at = NOW(),
       disconnected_at = NULL`,
    [
      shopId,
      organizationId,
      organizationName || null,
      accessToken || null,
      refreshToken,
      apiDomain || null,
      dataCenter || null,
      normalizeAccountsServer(accountsServer),
      scope || null,
      accessTokenExpiresAt || null,
    ]
  );

  return getActiveConnection(shopId);
}

export async function updateAccessToken(connectionId, { accessToken, accessTokenExpiresAt }) {
  await db.execute(
    `UPDATE zoho_connections SET access_token = ?, access_token_expires_at = ? WHERE id = ?`,
    [accessToken, accessTokenExpiresAt, connectionId]
  );
}

export async function disconnect(shopId) {
  await db.execute(
    `UPDATE zoho_connections SET is_active = FALSE, disconnected_at = NOW() WHERE shop_id = ? AND is_active = TRUE`,
    [shopId]
  );
}

// Zoho's answer when the refresh token itself is no longer valid (access
// revoked in Zoho, grant expired) - retrying can't fix these.
const REAUTH_ERRORS = new Set(["invalid_code", "invalid_token", "invalid_client", "access_denied"]);

export async function markConnectionNeedsReauth(connectionId, message) {
  await db.execute(
    `UPDATE zoho_connections SET needs_reauth = TRUE, last_auth_error = ? WHERE id = ?`,
    [message || null, connectionId],
  );
}

export class ZohoReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZohoReauthRequiredError";
  }
}

function currentToken(connection) {
  const bufferMs = 2 * 60 * 1000;
  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at).getTime()
    : 0;

  if (connection.access_token && expiresAt - bufferMs > Date.now()) {
    return { accessToken: connection.access_token, apiDomain: connection.api_domain, connection };
  }
  return null;
}

// Returns a currently-valid access token for the shop's active Zoho
// connection, transparently refreshing (and persisting) it when expired.
// Later sync features (products/customers/orders/...) should call this
// rather than reading zoho_connections.access_token directly.
//
// Refreshes happen behind a per-shop lock and re-check the stored token
// first, so a burst of webhooks arriving as the token expires produces one
// refresh instead of many (Zoho throttles refresh requests).
export async function getValidAccessToken(shopId) {
  const connection = await getActiveConnection(shopId);

  if (!connection) return null;
  if (connection.needs_reauth) {
    throw new ZohoReauthRequiredError("Zoho access was revoked or expired - reconnect Zoho Books in Settings");
  }

  const cached = currentToken(connection);
  if (cached) return cached;

  return withResourceLock(resourceLockKey(shopId, "zoho-token", connection.id), async () => {
    const latest = (await getActiveConnection(shopId)) || connection;
    const fresh = currentToken(latest);
    if (fresh) return fresh;
    return refreshConnectionToken(latest);
  });
}

async function refreshConnectionToken(connection) {
  // Refresh must target the same data center the connection was created on
  // (accounts.zoho.com/.in/.eu/zohocloud.ca/...). Prefer the accounts host
  // recorded at connect time; older rows fall back to data_center.
  const accountsServer =
    normalizeAccountsServer(connection.accounts_server) ||
    accountsServerForDataCenter(connection.data_center);
  let refreshed;
  try {
    refreshed = await refreshAccessToken(connection.refresh_token, accountsServer);
  } catch (error) {
    if (REAUTH_ERRORS.has(error.details?.error)) {
      await markConnectionNeedsReauth(connection.id, `Zoho rejected the refresh token (${error.details.error})`);
      throw new ZohoReauthRequiredError("Zoho access was revoked or expired - reconnect Zoho Books in Settings");
    }
    throw error;
  }
  const accessTokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

  await updateAccessToken(connection.id, { accessToken: refreshed.access_token, accessTokenExpiresAt });

  return {
    accessToken: refreshed.access_token,
    apiDomain: refreshed.api_domain || connection.api_domain,
    connection,
  };
}

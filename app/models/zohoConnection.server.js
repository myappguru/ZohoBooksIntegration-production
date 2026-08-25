import db from "../db.server";
import { ensureShop } from "./shop.server";
import { refreshAccessToken } from "../zoho.server";

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
  scope,
  accessTokenExpiresAt,
}) {
  if (!refreshToken) {
    throw new Error("saveConnection requires a refresh token");
  }

  await db.execute(
    `INSERT INTO zoho_connections
       (shop_id, organization_id, organization_name, access_token, refresh_token, api_domain, data_center, scope, access_token_expires_at, is_active, connected_at, disconnected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW(), NULL)
     ON DUPLICATE KEY UPDATE
       organization_name = VALUES(organization_name),
       access_token = VALUES(access_token),
       refresh_token = VALUES(refresh_token),
       api_domain = VALUES(api_domain),
       data_center = VALUES(data_center),
       scope = VALUES(scope),
       access_token_expires_at = VALUES(access_token_expires_at),
       is_active = TRUE,
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

// Returns a currently-valid access token for the shop's active Zoho
// connection, transparently refreshing (and persisting) it when expired.
// Later sync features (products/customers/orders/...) should call this
// rather than reading zoho_connections.access_token directly.
export async function getValidAccessToken(shopId) {
  const connection = await getActiveConnection(shopId);

  if (!connection) return null;

  const bufferMs = 2 * 60 * 1000;
  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at).getTime()
    : 0;

  if (connection.access_token && expiresAt - bufferMs > Date.now()) {
    return { accessToken: connection.access_token, apiDomain: connection.api_domain, connection };
  }

  // Refresh must target the same data center the connection was created on
  // (accounts.zoho.com/.in/.eu/...) - derived from the stored data_center
  // column since a merchant's account can be on any Zoho region.
  const accountsServer = connection.data_center ? `https://accounts.zoho.${connection.data_center}` : undefined;
  const refreshed = await refreshAccessToken(connection.refresh_token, accountsServer);
  const accessTokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

  await updateAccessToken(connection.id, { accessToken: refreshed.access_token, accessTokenExpiresAt });

  return {
    accessToken: refreshed.access_token,
    apiDomain: refreshed.api_domain || connection.api_domain,
    connection,
  };
}

import { authenticate } from "../shopify.server";
import { getConnectionForShopDomain, disconnect, getValidAccessToken } from "./zohoConnection.server";
import { getAppSettings, mergeAppSettings } from "./appSettings.server";
import { getWarehouseMappings, saveWarehouseMapping, removeWarehouseMapping } from "./warehouseMapping.server";
import { getAuthorizationUrl, fetchOrganizationDetails, fetchWarehouses, fetchTaxes, fetchChartOfAccounts } from "../zoho.server";
import { detectShopifyTaxRates } from "./orderSync.server";

const LOCATIONS_QUERY = `#graphql
  query WarehouseMappingLocations {
    locations(first: 50) { edges { node { id name isActive } } }
  }
`;
const CACHE_TTL_MS = 15 * 60 * 1000;
const isFresh = (value) => Boolean(value) && Date.now() - new Date(value).getTime() < CACHE_TTL_MS;

async function loadOrganizationSettings(shop, token, connection, { force = false } = {}) {
  const cached = await getAppSettings(shop.id);
  if (!force && isFresh(cached.organization?.fetchedAt)) return { ...cached.organization, organizationId: cached.organization.organizationId || connection.organization_id || null, organizationName: cached.organization.organizationName || connection.organization_name || null };
  try {
    if (!token) throw new Error("No valid Zoho access token");
    const org = await fetchOrganizationDetails(connection.organization_id, { accessToken: token.accessToken, apiDomain: token.apiDomain });
    const settings = await mergeAppSettings(shop.id, "organization", {
      organizationId: org.organization_id || connection.organization_id || null,
      organizationName: org.organization_name || connection.organization_name || null,
      currencyCode: org.currency_code || null,
      currencySymbol: org.currency_symbol || null,
      fiscalYearStartMonth: org.fiscal_year_start_month || null,
      timeZone: org.time_zone || null,
      languageCode: org.language_code || null,
      dateFormat: org.date_format || null,
      industryType: org.industry_type_formatted || org.industry_type || null,
      taxIdLabel: org.tax_id_label || null,
      taxIdValue: org.tax_id_value || null,
      planName: org.plan_name || null,
      fetchedAt: new Date().toISOString(),
      stale: false,
    });
    return settings.organization;
  } catch (error) {
    console.error("Failed to refresh Zoho organization settings", error);
    return cached.organization ? { ...cached.organization, organizationId: cached.organization.organizationId || connection.organization_id || null, organizationName: cached.organization.organizationName || connection.organization_name || null, stale: true } : { organizationId: connection.organization_id || null, organizationName: connection.organization_name || null, stale: true };
  }
}

async function loadZohoList(shop, key, token, fetchList, { force = false } = {}) {
  const cached = await getAppSettings(shop.id);
  const cachedList = cached[key];
  if (!force && isFresh(cachedList?.fetchedAt)) return { items: cachedList.items || [], error: false };
  try {
    if (!token) throw new Error("No valid Zoho access token");
    const items = await fetchList();
    await mergeAppSettings(shop.id, key, { items, fetchedAt: new Date().toISOString() });
    return { items, error: false };
  } catch (error) {
    console.error(`Failed to fetch Zoho ${key}`, error);
    return cachedList ? { items: cachedList.items || [], error: true } : { items: [], error: true };
  }
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  const token = connection ? await getValidAccessToken(shop.id).catch(() => null) : null;
  const organization = connection ? await loadOrganizationSettings(shop, token, connection) : null;
  const warehousesResult = connection ? await loadZohoList(shop, "warehouses", token, () => fetchWarehouses({ accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id })) : { items: [], error: false };
  const warehouseMappings = connection ? await getWarehouseMappings(shop.id) : {};
  const taxesResult = connection ? await loadZohoList(shop, "taxes", token, () => fetchTaxes({ accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id })) : { items: [], error: false };
  const accountsResult = connection ? await loadZohoList(shop, "accounts", token, () => fetchChartOfAccounts({ accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id })) : { items: [], error: false };
  const appSettings = await getAppSettings(shop.id);
  const taxSettings = appSettings.taxSettings || {};
  const accountSettings = appSettings.accountSettings || {};
  const syncPreferences = appSettings.syncPreferences || { products: true, orders: true, customers: true };
  const rateMap = taxSettings.rateMap || {};
  const detectedRates = connection ? await detectShopifyTaxRates(admin) : [];
  const taxRateRows = [...detectedRates];
  for (const key of Object.keys(rateMap)) if (!taxRateRows.some((row) => row.key === key)) taxRateRows.push({ key, label: key });
  const locationsResponse = await admin.graphql(LOCATIONS_QUERY);
  const locationsJson = await locationsResponse.json();
  const locations = (locationsJson.data?.locations?.edges || []).map(({ node }) => node);
  return {
    shopDomain: session.shop,
    connection: connection ? { organizationId: connection.organization_id, organizationName: connection.organization_name, dataCenter: connection.data_center, connectedAt: connection.connected_at, tokenExpiresAt: connection.access_token_expires_at, tokenMasked: token?.accessToken ? `zoho${"•".repeat(28)}${token.accessToken.slice(-4)}` : "zoho••••••••••••••••••••••••••••••••", hasToken: Boolean(token?.accessToken), connectedBy: connection.connected_by || "Zoho Books account", scope: connection.scope || null } : null,
    organization, syncPreferences, locations, locationsError: Boolean(locationsJson.errors) && locations.length === 0,
    warehouses: warehousesResult.items, warehouseMappings, warehouseSyncError: warehousesResult.error,
    taxes: taxesResult.items, taxSyncError: taxesResult.error, taxSettings, taxRateRows, taxRates: taxRateRows,
    accounts: accountsResult.items, accountSyncError: accountsResult.error,
    accountSettings, zohoAuthUrl: getAuthorizationUrl(session.shop),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const { shop, connection } = await getConnectionForShopDomain(session.shop);
  if (intent === "disconnect") await disconnect(shop.id);
  if (intent === "refresh-zoho-data" && connection) {
    const token = await getValidAccessToken(shop.id).catch(() => null);
    await loadOrganizationSettings(shop, token, connection, { force: true });
    await loadZohoList(shop, "warehouses", token, () => fetchWarehouses({ accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id }), { force: true });
    await loadZohoList(shop, "taxes", token, () => fetchTaxes({ accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id }), { force: true });
    await loadZohoList(shop, "accounts", token, () => fetchChartOfAccounts({ accessToken: token.accessToken, apiDomain: token.apiDomain, organizationId: connection.organization_id }), { force: true });
  }
  if (intent === "test-connection" && connection) await getValidAccessToken(shop.id);
  if (intent === "save-sync-preferences") await mergeAppSettings(shop.id, "syncPreferences", { products: formData.get("productsEnabled") === "true", orders: formData.get("ordersEnabled") === "true", customers: formData.get("customersEnabled") === "true" });
  if (intent === "save-warehouse-mapping") {
    for (const [key, value] of formData.entries()) { if (!key.startsWith("warehouse:")) continue; const locationId = key.slice("warehouse:".length); if (value) await saveWarehouseMapping(shop.id, locationId, value); else await removeWarehouseMapping(shop.id, locationId); }
  }
  if (intent === "save-tax-settings") {
    const currentSettings = await getAppSettings(shop.id); const rateMap = { ...(currentSettings.taxSettings?.rateMap || {}) };
    for (const [key, value] of formData.entries()) { if (!key.startsWith("taxrate:")) continue; const rateKey = key.slice("taxrate:".length); if (value) rateMap[rateKey] = value; else delete rateMap[rateKey]; }
    await mergeAppSettings(shop.id, "taxSettings", { defaultTaxId: formData.get("defaultTaxId") || null, pricesIncludeTax: formData.get("pricesIncludeTax") === "true", discountBeforeTax: formData.get("discountBeforeTax") === "true", rateMap });
  }
  if (intent === "save-account-settings") {
    let accountAccess = [];
    try { accountAccess = JSON.parse(formData.get("accountAccess") || "[]"); } catch { accountAccess = []; }
    await mergeAppSettings(shop.id, "accountSettings", {
      salesAccountId: formData.get("salesAccountId") || null,
      paymentAccountId: formData.get("paymentAccountId") || null,
      inventoryAccountId: formData.get("inventoryAccountId") || null,
      merchantName: formData.get("merchantName") || null,
      accountEmail: formData.get("accountEmail") || null,
      ipWhitelisting: formData.get("ipWhitelisting") === "true",
      emailNotifications: formData.get("emailNotifications") === "true",
      accountAccess,
      updatedAt: new Date().toISOString(),
    });
  }
  return null;
};
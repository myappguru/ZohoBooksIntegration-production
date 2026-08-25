import crypto from "node:crypto";

const ZOHO_ACCOUNTS_URL =
  process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;

const ZOHO_SCOPES = [
  "ZohoBooks.fullaccess.all",
  "ZohoInventory.fullaccess.all",
].join(",");

const STATE_TTL_MS = 15 * 60 * 1000;

export class ZohoApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ZohoApiError";
    this.details = details;
  }
}

function getStateSecret() {
  return process.env.SHOPIFY_API_SECRET || "zoho-oauth-state-secret";
}

// Signs {shop, nonce, ts} so the OAuth callback can trust the shop domain
// without needing a Shopify-authenticated session (the callback is opened
// in a plain browser tab, outside the embedded admin iframe).
export function createOAuthState(shopDomain) {
  const payload = {
    shop: shopDomain,
    nonce: crypto.randomBytes(8).toString("hex"),
    ts: Date.now(),
  };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getStateSecret())
    .update(json)
    .digest("base64url");

  return `${json}.${signature}`;
}

export function verifyOAuthState(state) {
  if (!state || !state.includes(".")) return null;

  const [json, signature] = state.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", getStateSecret())
    .update(json)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  const payload = JSON.parse(Buffer.from(json, "base64url").toString("utf8"));

  if (Date.now() - payload.ts > STATE_TTL_MS) {
    return null;
  }

  return payload.shop;
}

export function getAuthorizationUrl(shopDomain) {
  const params = new URLSearchParams({
    scope: ZOHO_SCOPES,
    client_id: ZOHO_CLIENT_ID,
    response_type: "code",
    redirect_uri: ZOHO_REDIRECT_URI,
    access_type: "offline",
    prompt: "consent",
    state: createOAuthState(shopDomain),
  });

  return `${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?${params.toString()}`;
}

// Zoho's callback echoes back an `accounts-server` param identifying which
// data center (accounts.zoho.com / .in / .eu / .com.au / ...) actually
// issued the code, regardless of which one we sent the user to. A code
// must be exchanged against that SAME data center or Zoho rejects it with
// "invalid_code" - so callers must pass this through rather than assuming
// a single global accounts URL. Merchants can be on any Zoho data center.
export async function exchangeCodeForToken(
  code,
  accountsServer = ZOHO_ACCOUNTS_URL,
) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    redirect_uri: ZOHO_REDIRECT_URI,
    code,
  });

  const response = await fetch(`${accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new ZohoApiError("Failed to exchange Zoho authorization code", data);
  }

  return data;
}

// Refreshing a token has the same data-center requirement as the initial
// exchange - use the accounts-server that was recorded when this
// connection was created (see zohoConnection.server.js#getValidAccessToken).
export async function refreshAccessToken(
  refreshToken,
  accountsServer = ZOHO_ACCOUNTS_URL,
) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  const response = await fetch(`${accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new ZohoApiError("Failed to refresh Zoho access token", data);
  }

  return data;
}

export async function fetchOrganizations({ accessToken, apiDomain }) {
  const response = await fetch(`${apiDomain}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho organizations", data);
  }

  return data.organizations || [];
}

// Full organization record (fiscal year, currency, tax basis, time zone, ...)
// - the /organizations list endpoint used during OAuth only carries enough
// to pick which org to connect to, so settings display fetches this separately.
export async function fetchOrganizationDetails(
  organizationId,
  { accessToken, apiDomain },
) {
  const response = await fetch(
    `${apiDomain}/books/v3/organizations/${organizationId}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho organization details", data);
  }

  return data.organization;
}

// Stock locations for the connected organization, used to map against
// Shopify locations for inventory sync. Confirmed live (2026-08-17) that an
// org running only Zoho Books' own native multi-location inventory feature
// (Settings > Locations in Zoho's UI) - as opposed to a separate Zoho
// Inventory app subscription - has an empty /inventory/v1/warehouses list
// even though its items report real per-location stock. /books/v3/locations
// is the endpoint that's actually populated for such orgs, and is what
// every item's own `locations[]` array (see fetchZohoItem) is keyed
// against - so that's used here instead, unconditionally, and remapped to
// the warehouse_id/warehouse_name shape the rest of this app already
// expects (this app's UI still calls these "warehouses" - renaming
// throughout would be a bigger change than the bug warrants).
export async function fetchWarehouses({
  accessToken,
  apiDomain,
  organizationId,
}) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/locations?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho locations", data);
  }

  return (data.locations || []).map((location) => ({
    warehouse_id: location.location_id,
    warehouse_name: location.location_name,
  }));
}

// Org-level tax list (Settings > Taxes in Zoho Books) - used as the pick
// list for a default GST/VAT tax to apply during (future) order/invoice
// sync, since Shopify has no equivalent catalog of named tax rates to map
// against one-for-one.
export async function fetchTaxes({ accessToken, apiDomain, organizationId }) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/settings/taxes?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho taxes", data);
  }

  return data.taxes || [];
}

// Full chart of accounts - used as the pick list for default sales/payment
// accounts. Callers filter by account_type (e.g. "income"/"other_income"
// for sales, "bank"/"cash" for payments).
export async function fetchChartOfAccounts({
  accessToken,
  apiDomain,
  organizationId,
}) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/chartofaccounts?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho chart of accounts", data);
  }

  return data.chartofaccounts || [];
}

// Looks up a Zoho Inventory item by exact SKU match, so product sync can
// link to an item a merchant already has in Zoho instead of creating a
// duplicate. Returns null if none exists yet.
export async function fetchZohoItemBySku({
  accessToken,
  apiDomain,
  organizationId,
  sku,
}) {
  const params = new URLSearchParams({ organization_id: organizationId, sku });
  const response = await fetch(
    `${apiDomain}/inventory/v1/items?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to look up Zoho item by SKU", data);
  }

  return (data.items || []).find((item) => item.sku === sku) || null;
}

// Full item detail, including its `warehouses` array ({ warehouse_id,
// warehouse_stock_on_hand, ... }) for orgs with multi-warehouse inventory
// enabled - needed to know an item's current stock at a specific warehouse
// before adjusting it, since Zoho's inventory adjustment API only accepts
// a relative delta, not an absolute quantity to set.
export async function fetchZohoItem(
  { accessToken, apiDomain, organizationId },
  itemId,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/inventory/v1/items/${itemId}?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho item", data);
  }

  return data.item;
}

// Adjusts an item's stock at a specific warehouse (Zoho calls this
// `location_id` in the adjustments API, even though the same id is called
// `warehouse_id` everywhere else - both refer to the same record).
// `quantityAdjusted` is a signed delta (+/-), not an absolute quantity -
// callers must compute it against the item's current stock first.
export async function createZohoInventoryAdjustment(
  { accessToken, apiDomain, organizationId },
  { itemId, locationId, quantityAdjusted, reason, date },
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const body = {
    date,
    reason,
    adjustment_type: "quantity",
    location_id: locationId,
    line_items: [
      {
        item_id: itemId,
        quantity_adjusted: quantityAdjusted,
        location_id: locationId,
      },
    ],
  };
  const response = await fetch(
    `${apiDomain}/inventory/v1/inventoryadjustments?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho inventory adjustment", data);
  }

  return data.inventory_adjustment;
}

export async function createZohoItem(
  { accessToken, apiDomain, organizationId },
  item,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/inventory/v1/items?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(item),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho item", data);
  }

  return data.item;
}

export async function updateZohoItem(
  { accessToken, apiDomain, organizationId },
  itemId,
  item,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/inventory/v1/items/${itemId}?${params.toString()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(item),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to update Zoho item", data);
  }

  return data.item;
}

export async function deleteZohoItem(
  { accessToken, apiDomain, organizationId },
  itemId,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/inventory/v1/items/${itemId}?${params.toString()}`,
    {
      method: "DELETE",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to delete Zoho item", data);
  }

  return data;
}

// Item status (active/inactive) isn't settable via create/update - Zoho
// only exposes it through these dedicated endpoints.
export async function setZohoItemActiveStatus(
  { accessToken, apiDomain, organizationId },
  itemId,
  isActive,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/inventory/v1/items/${itemId}/${isActive ? "active" : "inactive"}?${params.toString()}`,
    {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to set Zoho item status", data);
  }

  return data;
}

// Looks up a Zoho Books contact by exact email match, so customer sync can
// link to a contact a merchant already has in Zoho instead of creating a
// duplicate. Zoho's `email` list filter is fuzzy, so results are still
// checked for an exact (case-insensitive) match client-side - the same
// pattern as fetchZohoItemBySku.
export async function fetchZohoContactByEmail({
  accessToken,
  apiDomain,
  organizationId,
  email,
}) {
  const params = new URLSearchParams({ organization_id: organizationId, email });
  const response = await fetch(
    `${apiDomain}/books/v3/contacts?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to look up Zoho contact by email", data);
  }

  return (
    (data.contacts || []).find(
      (contact) => (contact.email || "").toLowerCase() === email.toLowerCase(),
    ) || null
  );
}

export async function createZohoContact(
  { accessToken, apiDomain, organizationId },
  contact,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/contacts?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(contact),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho contact", data);
  }

  return data.contact;
}

export async function updateZohoContact(
  { accessToken, apiDomain, organizationId },
  contactId,
  contact,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/contacts/${contactId}?${params.toString()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(contact),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to update Zoho contact", data);
  }

  return data.contact;
}

export async function deleteZohoContact(
  { accessToken, apiDomain, organizationId },
  contactId,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/contacts/${contactId}?${params.toString()}`,
    {
      method: "DELETE",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to delete Zoho contact", data);
  }

  return data;
}

// Like item status, a contact's active/inactive state isn't settable via
// create/update - only through these dedicated endpoints. Used as the
// fallback when a contact can't be hard-deleted because it has existing
// transaction history (invoices, payments, etc.).
export async function setZohoContactActiveStatus(
  { accessToken, apiDomain, organizationId },
  contactId,
  isActive,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/contacts/${contactId}/${isActive ? "active" : "inactive"}?${params.toString()}`,
    {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to set Zoho contact status", data);
  }

  return data;
}

export async function createZohoSalesOrder(
  { accessToken, apiDomain, organizationId },
  salesOrder,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/salesorders?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(salesOrder),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho sales order", data);
  }

  return data.salesorder;
}

export async function updateZohoSalesOrder(
  { accessToken, apiDomain, organizationId },
  salesOrderId,
  salesOrder,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/salesorders/${salesOrderId}?${params.toString()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(salesOrder),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to update Zoho sales order", data);
  }

  return data.salesorder;
}

// Zoho sales orders aren't simply deleted when a Shopify order is cancelled
// (deleting is only allowed before an order has been invoiced/shipped, and
// would erase the accounting record) - voiding is the standard way to mark
// a sales order as no longer active while keeping it on the books.
export async function voidZohoSalesOrder(
  { accessToken, apiDomain, organizationId },
  salesOrderId,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/salesorders/${salesOrderId}/status/void?${params.toString()}`,
    {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to void Zoho sales order", data);
  }

  return data;
}

// Converts an existing Zoho sales order into an invoice, carrying over its
// customer, line items, tax, discount, and shipping charge - so invoice
// creation doesn't need to rebuild any of that from the Shopify order
// again. Zoho requires no request body for this conversion.
export async function createZohoInvoiceFromSalesOrder(
  { accessToken, apiDomain, organizationId },
  salesOrderId,
) {
  const params = new URLSearchParams({
    organization_id: organizationId,
    salesorder_id: salesOrderId,
  });
  const response = await fetch(
    `${apiDomain}/books/v3/invoices/fromsalesorder?${params.toString()}`,
    {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho invoice from sales order", data);
  }

  return data.invoice;
}

// Fetches full sales order detail, including its `invoices` array - Zoho's
// own authoritative link to whatever invoice(s) already exist for this
// sales order, however they were created (via this app's API calls, or
// manually in Zoho's own UI). Used to adopt an existing invoice instead of
// failing when Zoho reports the sales order has nothing left to invoice.
// Matching on `reference_number` was tried first but proved unreliable -
// Zoho's own "convert to invoice" UI action doesn't carry over the sales
// order's custom reference_number to the resulting invoice.
export async function fetchZohoSalesOrder(
  { accessToken, apiDomain, organizationId },
  salesOrderId,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/salesorders/${salesOrderId}?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho sales order", data);
  }

  return data.salesorder;
}

// Creates a Package against a sales order - the Zoho Inventory record of
// "these specific line items/quantities are boxed up and ready to ship".
// `lineItems` is [{ soLineItemId, quantity }], matching the sales order's
// own `line_items[].line_item_id` (not the item_id) for whichever items
// this particular Shopify fulfillment covers - verified live against
// Shopify.dev's raw API docs (both this and createZohoShipmentOrder below),
// same as every other Zoho endpoint added this project: `organization_id`
// and `salesorder_id` are query params, not body fields.
// `packageNumber` is documented as optional but confirmed live (real
// webhook failure, 2026-08-17) to be enforced as mandatory in practice -
// Zoho rejects the call with "It is mandatory to specify the Package
// Number" if it's left out, despite the docs saying otherwise.
export async function createZohoPackage(
  { accessToken, apiDomain, organizationId },
  { salesOrderId, date, lineItems, packageNumber },
) {
  const params = new URLSearchParams({
    organization_id: organizationId,
    salesorder_id: salesOrderId,
  });
  const body = {
    date,
    package_number: packageNumber,
    line_items: lineItems.map((lineItem) => ({
      so_line_item_id: lineItem.soLineItemId,
      quantity: lineItem.quantity,
    })),
  };

  const response = await fetch(
    `${apiDomain}/inventory/v1/packages?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho package", data);
  }

  return data.package;
}

// Creates a Shipment Order for one or more already-created packages -
// Zoho's record that those packages actually shipped, with carrier/
// tracking info. `delivery_method` and `tracking_number` are mandatory on
// Zoho's side even though Shopify fulfillments can have either field
// empty (e.g. a manual fulfillment with no tracking) - callers fall back
// to a placeholder string rather than omitting them, since Zoho rejects
// the call entirely without them.
export async function createZohoShipmentOrder(
  { accessToken, apiDomain, organizationId },
  { salesOrderId, packageIds, shipmentNumber, date, deliveryMethod, trackingNumber },
) {
  const params = new URLSearchParams({
    organization_id: organizationId,
    salesorder_id: salesOrderId,
    package_ids: packageIds.join(","),
  });
  const body = {
    shipment_number: shipmentNumber,
    date,
    delivery_method: deliveryMethod,
    tracking_number: trackingNumber,
  };

  const response = await fetch(
    `${apiDomain}/inventory/v1/shipmentorders?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho shipment order", data);
  }

  return data.shipmentorder;
}

// Records a payment and applies it against one or more invoices in a
// single call - `payment.invoices` is the { invoice_id, amount_applied }
// pairing that both creates the payment and marks the invoice(s) as paid.
export async function createZohoCustomerPayment(
  { accessToken, apiDomain, organizationId },
  payment,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/customerpayments?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payment),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho customer payment", data);
  }

  return data.payment;
}

// Fetches full invoice detail, including its own `customer_id` and
// `line_items[].line_item_id` - needed to build a credit note that
// references specific invoice line items (Zoho requires the invoice's own
// `invoice_item_id`, not just an item_id, to credit a specific sold line).
export async function fetchZohoInvoice(
  { accessToken, apiDomain, organizationId },
  invoiceId,
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const response = await fetch(
    `${apiDomain}/books/v3/invoices/${invoiceId}?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to fetch Zoho invoice", data);
  }

  return data.invoice;
}

// Creates a Credit Note - Zoho's record of "this customer is owed money
// back for returned/refunded items" - as a plain freestanding document
// (item_id/rate/quantity), NOT linked to the invoice at creation time.
//
// An earlier version of this function put `invoice_id`/`invoice_item_id`
// directly on each line item, on the assumption (from Zoho's docs) that
// this both linked the credit note to the invoice for reporting AND pulled
// each line's price/tax from the invoice automatically. Confirmed live
// (real webhook failure, 2026-08-18) that this combination is rejected
// outright by Zoho - `code: 6, "Invalid values are given for creation"` -
// reproduced directly against the API with the exact same payload,
// independent of this app's own code, ruling out a request-building bug.
// Confirmed via direct trial-and-error against the live API (docs didn't
// spell out the correct shape) that Zoho instead expects a **separate**
// two-step flow, mirroring the same "create, then convert/apply" pattern
// already used for sales-order→invoice (Section E) and
// invoice→payment (Section F): create the credit note as a plain
// standalone document first (this function - `rate` is passed explicitly
// per line since there's no invoice link to inherit it from), then call
// `applyZohoCreditNoteToInvoice` separately to credit it against the
// specific invoice.
export async function createZohoCreditNote(
  { accessToken, apiDomain, organizationId },
  { customerId, date, lineItems },
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const body = {
    customer_id: customerId,
    date,
    line_items: lineItems.map((lineItem) => ({
      item_id: lineItem.itemId,
      quantity: lineItem.quantity,
      rate: lineItem.rate,
    })),
  };
  const response = await fetch(
    `${apiDomain}/books/v3/creditnotes?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho credit note", data);
  }

  return data.creditnote;
}

// "Credit to an invoice" - the second half of the two-step flow above.
// Confirmed live: this is what actually links the credit note to the
// invoice (`POST /creditnotes/{id}/invoices`), and it also reduces the
// invoice's own balance by `amountApplied` (confirmed by re-fetching the
// invoice after calling this in a live test - balance dropped from 749.95
// to 0, status changed to "paid", `credits_applied` populated). That's
// standard double-entry behavior, not data corruption: Zoho tracks
// `payment_made` and `credits_applied` as separate fields on the invoice,
// so a previously-paid invoice's payment history isn't erased by also
// recording a later credit against it.
export async function applyZohoCreditNoteToInvoice(
  { accessToken, apiDomain, organizationId },
  { creditNoteId, invoiceId, amountApplied },
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const body = {
    invoices: [{ invoice_id: invoiceId, amount_applied: amountApplied }],
  };
  const response = await fetch(
    `${apiDomain}/books/v3/creditnotes/${creditNoteId}/invoices?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to apply Zoho credit note to invoice", data);
  }

  return data;
}

// Records the actual money movement back to the customer against an
// already-created credit note - `fromAccountId` mirrors Section F's
// `paymentAccountId` (the same account money was received into originally
// now pays back out of).
export async function createZohoCreditNoteRefund(
  { accessToken, apiDomain, organizationId },
  { creditNoteId, date, amount, refundMode, fromAccountId, referenceNumber },
) {
  const params = new URLSearchParams({ organization_id: organizationId });
  const body = {
    date,
    amount,
    refund_mode: refundMode,
    from_account_id: fromAccountId,
    reference_number: referenceNumber,
  };
  const response = await fetch(
    `${apiDomain}/books/v3/creditnotes/${creditNoteId}/refunds?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new ZohoApiError("Failed to create Zoho credit note refund", data);
  }

  return data.creditnote_refund;
}

export function getPreferredOrganizationId() {
  return process.env.ZOHO_ORGANIZATION_ID || null;
}

export function dataCenterFromApiDomain(apiDomain) {
  try {
    const hostname = new URL(apiDomain).hostname;

    return hostname.replace(/^www\.zohoapis\./, "");
  } catch {
    return null;
  }
}

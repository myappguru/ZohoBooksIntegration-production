import db from "../db.server";
import {
  fetchZohoItemBySku,
  createZohoItem,
  updateZohoItem,
  setZohoItemActiveStatus,
  deleteZohoItem,
} from "../zoho.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "./zohoConnection.server";
import { recordWebhookReceived, finishWebhookLog } from "./webhookLog.server";
import { getAppSettings } from "./appSettings.server";
import { startSyncLog, finishSyncLog } from "./syncLog.server";

const ENTITY_TYPE = "product";

// ZohoApiError's `.message` is just a generic label - the actual reason
// Zoho gave lives in `.details`. Folding it into the stored string means
// the real cause shows up in sync_mappings/sync_logs directly, instead of
// only being visible via a live diagnostic script. (Confirmed the cost of
// not having this: diagnosing a real order-sync bug on 2026-08-17 needed
// three separate live Zoho API calls just to see an error this would have
// surfaced immediately.)
function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

// Used by the Dashboard's "Synchronization Overview" stat tile - counts
// variants with a real, currently-synced link to a Zoho item (not attempts
// that ended in error).
export async function getSyncedProductCount(shopId) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS count FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND status = 'synced'`,
    [shopId, ENTITY_TYPE],
  );

  return rows[0]?.count || 0;
}

export async function getProductMappings(shopId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id, status, last_synced_at, last_error FROM sync_mappings WHERE shop_id = ? AND entity_type = ?`,
    [shopId, ENTITY_TYPE],
  );

  return Object.fromEntries(
    rows.map((row) => [
      row.shopify_id,
      {
        zohoId: row.zoho_id,
        status: row.status,
        lastSyncedAt: row.last_synced_at,
        lastError: row.last_error,
      },
    ]),
  );
}

// Called after a successful create/update/link against Zoho - a mapping
// row can only exist once we actually have a zoho_id (the column is
// NOT NULL), so a variant that has never synced successfully has no row
// here at all until its first success. `shopifyParentId` (the product's
// GID) is stored so a later products/delete webhook - which only gives us
// the product's id, none of its variants' - can still find every mapping
// row that belongs to it.
export async function saveProductMapping(
  shopId,
  shopifyVariantId,
  zohoItemId,
  shopifyParentId,
) {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, shopify_parent_id, zoho_id, status, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, ?, 'synced', NOW(), NULL)
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), shopify_parent_id = VALUES(shopify_parent_id), status = 'synced', last_synced_at = NOW(), last_error = NULL`,
    [
      shopId,
      ENTITY_TYPE,
      shopifyVariantId,
      shopifyParentId || null,
      zohoItemId,
    ],
  );
}

// Records a failure against an already-mapped variant (re-sync of an
// existing item failed). A no-op if the variant never mapped successfully
// in the first place - that failure lives only in the sync_logs run entry.
export async function markProductMappingError(
  shopId,
  shopifyVariantId,
  errorMessage,
) {
  await db.execute(
    `UPDATE sync_mappings SET status = 'error', last_error = ? WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [errorMessage, shopId, ENTITY_TYPE, shopifyVariantId],
  );
}

export async function getProductMappingsByParentId(shopId, shopifyParentId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_parent_id = ?`,
    [shopId, ENTITY_TYPE, shopifyParentId],
  );

  return rows;
}

export async function deleteProductMapping(shopId, shopifyVariantId) {
  await db.execute(
    `DELETE FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`,
    [shopId, ENTITY_TYPE, shopifyVariantId],
  );
}

// Shared by the manual "Sync now" bulk action and the products webhooks -
// one source of truth for "how do we turn a Shopify product+variant into a
// Zoho Inventory item" so the two call sites can't drift out of sync.
//
// `inventoryAccountId` is optional - it's the Settings page's "Inventory
// account" (Section G, Inventory Synchronization). Without it, items are
// left untracked, same as before Section G existed: explicitly passing
// `track_inventory: false` (or `true` with no `inventory_account_id`)
// trips up Zoho's validation with a misleading "invalid Product Type"
// error (code 700029) - confirmed by testing directly against the API -
// so the field is omitted entirely unless a real account id is available.
export function buildZohoItemPayload(product, variant, { inventoryAccountId } = {}) {
  const name =
    variant.title && variant.title !== "Default Title"
      ? `${product.title} - ${variant.title}`
      : product.title;

  return {
    name,
    sku: variant.sku,
    rate: Number(variant.price) || 0,
    description: product.description || "",
    item_type: "inventory",
    product_type: "goods",
    ...(inventoryAccountId
      ? { track_inventory: true, inventory_account_id: inventoryAccountId }
      : {}),
  };
}

// Confirmed against the live Admin GraphQL schema via the Shopify AI
// Toolkit before writing this.
const SET_VARIANT_INVENTORY_POLICY_MUTATION = `#graphql
  mutation SetVariantInventoryPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors {
        field
        message
      }
    }
  }
`;

// An accurate synced stock number alone doesn't stop overselling - Shopify
// only blocks checkout at zero if the variant's own `inventoryPolicy` is
// "DENY" ("CONTINUE" allows selling past zero, i.e. backorders). Whenever a
// variant becomes inventory-tracked via Zoho, this forces that setting so
// the number this app is already syncing actually has teeth. Always sent
// rather than checked-then-conditionally-updated - nothing in this app
// currently reads a variant's existing inventoryPolicy, and Shopify accepts
// a same-value update as a harmless no-op. Silently does nothing if there's
// no `admin` client (e.g. a webhook with no stored session) or no parent
// product id (e.g. a guest/custom order line item with no real product) -
// this is a best-effort enforcement layer, not something sync itself
// should fail over.
async function denyOversellForVariant(admin, product, variant) {
  if (!admin || !product?.id) return;

  const response = await admin.graphql(SET_VARIANT_INVENTORY_POLICY_MUTATION, {
    variables: {
      productId: product.id,
      variants: [{ id: variant.id, inventoryPolicy: "DENY" }],
    },
  });
  const json = await response.json();
  const userErrors = json.data?.productVariantsBulkUpdate?.userErrors || [];

  if (userErrors.length > 0) {
    console.error(
      "Failed to set inventoryPolicy=DENY for variant",
      variant.id,
      userErrors,
    );
  }
}

// `product` is { id, title, status, description, variants: [...] } and
// `variant` is { id, title, sku, price } - the same shape whether it came
// from the Admin GraphQL products query or was normalized from a REST
// webhook payload (see the products.create/update webhook routes).
// `admin` is optional - only needed to also enforce oversell prevention
// (see denyOversellForVariant); the Zoho-side sync itself doesn't need it.
export async function syncVariantToZoho({
  shopId,
  admin,
  zohoAuth,
  product,
  variant,
  mappings,
  inventoryAccountId,
}) {
  if (!variant.sku) {
    return { sku: variant.sku, status: "skipped" };
  }

  const payload = buildZohoItemPayload(product, variant, { inventoryAccountId });
  const existingMapping = mappings[variant.id];

  try {
    let zohoItemId = existingMapping?.zohoId;

    if (zohoItemId) {
      await updateZohoItem(zohoAuth, zohoItemId, payload);
    } else {
      const existingItem = await fetchZohoItemBySku({
        ...zohoAuth,
        sku: variant.sku,
      });
      if (existingItem) {
        zohoItemId = existingItem.item_id;
        await updateZohoItem(zohoAuth, zohoItemId, payload);
      } else {
        const created = await createZohoItem(zohoAuth, payload);
        zohoItemId = created.item_id;
      }
    }

    await setZohoItemActiveStatus(
      zohoAuth,
      zohoItemId,
      product.status === "ACTIVE",
    );
    await saveProductMapping(shopId, variant.id, zohoItemId, product.id);

    if (inventoryAccountId) {
      await denyOversellForVariant(admin, product, variant);
    }

    return { sku: variant.sku, zohoItemId, status: "success" };
  } catch (error) {
    console.error("Failed to sync product variant to Zoho", variant.sku, error);
    const description = describeZohoError(error);
    await markProductMappingError(shopId, variant.id, description);

    return { sku: variant.sku, status: "error", error: description };
  }
}

export async function syncProductToZoho({
  shopId,
  admin,
  zohoAuth,
  product,
  mappings,
  inventoryAccountId,
}) {
  const results = [];

  for (const variant of product.variants) {
    results.push(
      await syncVariantToZoho({
        shopId,
        admin,
        zohoAuth,
        product,
        variant,
        mappings,
        inventoryAccountId,
      }),
    );
  }

  return results;
}

// Shared by `app.products.jsx`'s loader (paginated display) and the
// sync-all/sync-now helpers below, so the GraphQL shape used for syncing
// stays identical to what's shown on the Products page.
export const PRODUCTS_QUERY = `#graphql
  query SyncableProducts($first: Int, $after: String, $last: Int, $before: String) {
    products(first: $first, after: $after, last: $last, before: $before) {
      edges {
        node {
          id
          title
          status
          description
          featuredMedia {
            preview {
              image {
                url
                altText
              }
            }
          }
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

export function normalizeProductNode(node) {
  return {
    ...node,
    imageUrl: node.featuredMedia?.preview?.image?.url || null,
    variants: (node.variants?.edges || []).map(({ node: variant }) => variant),
  };
}

// The "Sync now"/"Sync everything" actions have to cover the whole catalog
// regardless of how many products a page happens to be displaying - so this
// pages through everything itself (250 at a time, the API max) rather than
// reusing the paginated display query.
async function fetchAllProductsForSync(admin) {
  const allProducts = [];
  let after = null;

  for (;;) {
    const response = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: 250, after },
    });
    const json = await response.json();
    const edges = json.data?.products?.edges || [];

    allProducts.push(...edges.map(({ node }) => normalizeProductNode(node)));

    const pageInfo = json.data?.products?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  return allProducts;
}

// Shared by `app.products.jsx`'s own "Sync now" button and the Dashboard's
// "Sync everything" button (`app._index.jsx`) - lives here (not in either
// route file) so it stays guaranteed server-only (`.server.js`) regardless
// of which route imports it, rather than relying on route-to-route imports
// being handled correctly by React Router's client/server code-splitting.
export async function runProductSync({ admin, shop, zohoAuth }) {
  const logId = await startSyncLog(shop.id, {
    entityType: "product",
    direction: "shopify_to_zoho",
  });

  const products = await fetchAllProductsForSync(admin);
  const mappings = await getProductMappings(shop.id);
  const appSettings = await getAppSettings(shop.id);
  const inventoryAccountId = appSettings.accountSettings?.inventoryAccountId;

  const results = [];
  for (const product of products) {
    results.push(
      ...(await syncProductToZoho({
        shopId: shop.id,
        admin,
        zohoAuth,
        product,
        mappings,
        inventoryAccountId,
      })),
    );
  }

  const attempted = results.filter((result) => result.status !== "skipped");
  const summary = {
    processed: attempted.length,
    success: attempted.filter((result) => result.status === "success").length,
    failed: attempted.filter((result) => result.status === "error").length,
  };

  await finishSyncLog(logId, {
    recordsProcessed: summary.processed,
    recordsSuccess: summary.success,
    recordsFailed: summary.failed,
    metadata: attempted,
  });

  return summary;
}

// Shopify's products/create and products/update webhooks deliver the
// classic REST-shaped product resource, not the GraphQL shape the Admin
// GraphQL products query returns - normalize it to the same
// { id, title, status, description, variants: [...] } shape so both
// call sites can share syncProductToZoho/syncVariantToZoho unchanged.
// `admin_graphql_api_id` is what lines up with the GIDs already stored in
// sync_mappings from GraphQL-based syncs.
export function normalizeRestProduct(payload) {
  return {
    id: payload.admin_graphql_api_id,
    title: payload.title,
    status: (payload.status || "").toUpperCase(),
    description: (payload.body_html || "").replace(/<[^>]*>/g, "").trim(),
    variants: (payload.variants || []).map((variant) => ({
      id: variant.admin_graphql_api_id,
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
    })),
  };
}

// Shared body for the products/create and products/update webhook routes -
// they only differ in which Shopify topic triggered them. Always resolves
// (never throws) so the route can respond 200 to Shopify regardless of
// what happened internally; failures are recorded in webhook_logs instead
// of surfacing as a webhook delivery failure (which would make Shopify
// retry and eventually disable the subscription).
export async function processProductUpsertWebhook({
  shop: shopDomain,
  topic,
  webhookId,
  payload,
  admin,
}) {
  const { shop, connection } = await getConnectionForShopDomain(shopDomain);

  const logId = await recordWebhookReceived(shop.id, {
    webhookId,
    topic,
    shopDomain,
    resourceId: payload.admin_graphql_api_id,
    payload,
  });

  if (!logId) return; // Duplicate delivery of a webhook we've already processed.

  if (!connection) {
    await finishWebhookLog(logId, {
      status: "skipped",
      errorMessage: "Zoho Books is not connected for this shop",
    });
    return;
  }

  try {
    const token = await getValidAccessToken(shop.id);
    if (!token) throw new Error("No valid Zoho access token");

    const zohoAuth = {
      accessToken: token.accessToken,
      apiDomain: token.apiDomain,
      organizationId: connection.organization_id,
    };
    const product = normalizeRestProduct(payload);
    const mappings = await getProductMappings(shop.id);
    const appSettings = await getAppSettings(shop.id);

    const results = await syncProductToZoho({
      shopId: shop.id,
      admin,
      zohoAuth,
      product,
      mappings,
      inventoryAccountId: appSettings.accountSettings?.inventoryAccountId,
    });
    const failed = results.filter((result) => result.status === "error");

    await finishWebhookLog(logId, {
      status: failed.length > 0 ? "failed" : "processed",
      errorMessage:
        failed.length > 0
          ? failed.map((result) => `${result.sku}: ${result.error}`).join("; ")
          : null,
    });
  } catch (error) {
    console.error("Failed to process product webhook", topic, error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }
}

// For each Zoho item mapped to this (now-deleted) Shopify product: try a
// hard delete first, but Zoho refuses to delete an item that's been used
// in any transaction (invoice, bill, etc.) - so fall back to deactivating
// it instead, which preserves that transaction history. The mapping row
// is removed either way (the Shopify side is gone regardless); if BOTH
// the delete and the deactivate attempt fail, the row is kept with
// status "error" instead, so the failure stays visible rather than
// silently vanishing.
export async function syncProductDeletionToZoho({
  shopId,
  zohoAuth,
  shopifyProductId,
}) {
  const mappings = await getProductMappingsByParentId(shopId, shopifyProductId);
  const results = [];

  for (const mapping of mappings) {
    try {
      await deleteZohoItem(zohoAuth, mapping.zoho_id);
      await deleteProductMapping(shopId, mapping.shopify_id);
      results.push({ zohoItemId: mapping.zoho_id, status: "deleted" });
    } catch (deleteError) {
      try {
        await setZohoItemActiveStatus(zohoAuth, mapping.zoho_id, false);
        await deleteProductMapping(shopId, mapping.shopify_id);
        results.push({ zohoItemId: mapping.zoho_id, status: "deactivated" });
      } catch (deactivateError) {
        console.error(
          "Failed to delete or deactivate Zoho item for deleted product",
          mapping.zoho_id,
          deactivateError,
        );
        await markProductMappingError(
          shopId,
          mapping.shopify_id,
          deactivateError.message,
        );
        results.push({
          zohoItemId: mapping.zoho_id,
          status: "error",
          error: deactivateError.message,
        });
      }
    }
  }

  return results;
}

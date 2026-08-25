import { randomUUID } from "node:crypto";
import { fetchZohoItem, createZohoInventoryAdjustment } from "../zoho.server";
import { getProductMappings } from "./productSync.server";
import { getWarehouseMappings } from "./warehouseMapping.server";
import { startSyncLog, finishSyncLog } from "./syncLog.server";

// ZohoApiError's `.message` is just a generic label - the actual reason
// Zoho gave lives in `.details`.
function describeZohoError(error) {
  return error.details ? `${error.message}: ${JSON.stringify(error.details)}` : error.message;
}

// Pushes a Shopify location's `available` quantity for one variant to Zoho
// as an inventory adjustment. Zoho's adjustment API only accepts a signed
// delta (how much to add/remove), not an absolute quantity to set, so the
// item's current stock at that warehouse is fetched first to compute the
// difference. Requires both the variant and the Shopify location to
// already be mapped (Sections B and A respectively) - if either is
// missing, this is skipped rather than guessed at.
export async function syncInventoryLevelToZoho({
  zohoAuth,
  shopifyVariantId,
  shopifyLocationId,
  availableQuantity,
  productMappings,
  warehouseMappings,
}) {
  const zohoItemId = productMappings[shopifyVariantId]?.zohoId;
  if (!zohoItemId) {
    return { status: "skipped", reason: "product not synced to Zoho yet" };
  }

  const zohoWarehouseId = warehouseMappings[shopifyLocationId];
  if (!zohoWarehouseId) {
    return { status: "skipped", reason: "Shopify location has no warehouse mapping" };
  }

  try {
    const item = await fetchZohoItem(zohoAuth, zohoItemId);

    if (!item.track_inventory) {
      return { status: "skipped", reason: "item is not inventory-tracked in Zoho" };
    }

    // An item's per-location stock comes back under `locations[]`
    // (location_id/location_stock_on_hand) - Zoho Books' own multi-location
    // model, which is what this app's `fetchWarehouses` now reads from too
    // (see the comment there). There is no `item.warehouses` field for an
    // org running on Books locations rather than a separate Inventory app.
    const location = (item.locations || []).find(
      (entry) => String(entry.location_id) === String(zohoWarehouseId),
    );
    const currentStock = location ? Number(location.location_stock_on_hand) || 0 : 0;
    const delta = Number(availableQuantity) - currentStock;

    if (delta === 0) {
      return { status: "skipped", reason: "no change" };
    }

    await createZohoInventoryAdjustment(zohoAuth, {
      itemId: zohoItemId,
      locationId: zohoWarehouseId,
      quantityAdjusted: delta,
      reason: "Shopify inventory sync",
      date: new Date().toISOString().slice(0, 10),
    });

    return { status: "success", delta };
  } catch (error) {
    console.error("Failed to sync inventory level to Zoho", shopifyVariantId, error);
    return { status: "error", error: describeZohoError(error) };
  }
}

// Zoho -> Shopify direction (manual "Sync now" on the Inventory page, not a
// webhook - Zoho doesn't push to third-party apps the way Shopify does).
// For every mapped product, reads Zoho's current stock at every mapped
// warehouse and resolves it back to the Shopify variant/location pair it
// corresponds to. Doesn't touch Shopify itself - the caller (which holds
// the `admin` GraphQL client) diffs these against Shopify's live quantities
// and decides what actually needs to change.
//
// Loop safety: pushing a Zoho quantity into Shopify triggers Shopify's
// `inventory_levels/update` webhook, which re-computes a delta against
// Zoho's current stock (see `syncInventoryLevelToZoho` above) and finds it
// zero - since we just set Shopify to match - so no adjustment fires back
// to Zoho and the loop terminates after one hop.
export async function fetchZohoStockForMappedProducts({
  zohoAuth,
  productMappings,
  warehouseMappings,
}) {
  const zohoWarehouseToShopifyLocation = Object.fromEntries(
    Object.entries(warehouseMappings).map(([shopifyLocationId, zohoWarehouseId]) => [
      String(zohoWarehouseId),
      shopifyLocationId,
    ]),
  );

  const results = [];

  for (const [shopifyVariantId, mapping] of Object.entries(productMappings)) {
    if (!mapping.zohoId) continue;

    let item;
    try {
      item = await fetchZohoItem(zohoAuth, mapping.zohoId);
    } catch (error) {
      results.push({
        shopifyVariantId,
        status: "error",
        error: describeZohoError(error),
      });
      continue;
    }

    if (!item.track_inventory) continue;

    for (const location of item.locations || []) {
      const shopifyLocationId =
        zohoWarehouseToShopifyLocation[String(location.location_id)];
      if (!shopifyLocationId) continue;

      results.push({
        shopifyVariantId,
        shopifyLocationId,
        zohoStock: Number(location.location_stock_on_hand) || 0,
        status: "resolved",
      });
    }
  }

  return results;
}

const INVENTORY_LEVELS_QUERY = `#graphql
  query VariantInventoryLevels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem {
          id
          inventoryLevels(first: 50) {
            edges {
              node {
                location { id }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }
`;

// `ignoreCompareQuantity` (used in older Shopify docs examples) is not a
// real field on InventorySetQuantitiesInput as of API version 2026-07 -
// confirmed against the live schema, it throws "Field is not defined". The
// compare-and-set check lives per quantity entry instead, via
// `changeFromQuantity` - which is mandatory (must be explicitly present,
// `null` to skip the check, omitting the key entirely is a schema error).
// Separately, as of 2026-04 this mutation also requires an idempotency key
// via the `@idempotent` directive (previously optional).
const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

// Keyed by "<variantId>::<locationId>" so the pull-sync action can look up
// "what does Shopify currently say this variant's stock is at this
// location" for each Zoho-resolved (variant, location) pair in one shot.
async function fetchCurrentInventoryLevels(admin, variantIds) {
  const response = await admin.graphql(INVENTORY_LEVELS_QUERY, {
    variables: { ids: variantIds },
  });
  const json = await response.json();
  const levels = {};

  for (const node of json.data?.nodes || []) {
    if (!node?.inventoryItem) continue;
    const inventoryItemId = node.inventoryItem.id;

    for (const { node: level } of node.inventoryItem.inventoryLevels?.edges ||
      []) {
      const available = (level.quantities || []).find(
        (quantity) => quantity.name === "available",
      );
      levels[`${node.id}::${level.location.id}`] = {
        inventoryItemId,
        quantity: available ? available.quantity : null,
      };
    }
  }

  return levels;
}

// Pulls current Zoho stock for every mapped product/warehouse pair and
// pushes it into Shopify via `inventorySetQuantities` - the Zoho -> Shopify
// direction, done as a manual pull rather than a Zoho-initiated webhook
// (Zoho has no built-in equivalent of Shopify's signed webhooks; wiring one
// up would require the user to hand-configure a Workflow Rule in Zoho's own
// UI). Only variant/location pairs whose Shopify quantity actually differs
// from Zoho's are written, both to avoid needless API calls and to keep
// `webhook_logs` free of no-op entries from the resulting inventory webhook.
// Shared by `app.inventory.jsx`'s own "Sync now" button and the Dashboard's
// "Sync everything" button (`app._index.jsx`) - lives here so it stays
// guaranteed server-only regardless of which route imports it.
export async function runInventoryPull({ admin, shop, zohoAuth }) {
  const logId = await startSyncLog(shop.id, {
    entityType: "inventory",
    direction: "zoho_to_shopify",
  });

  const [productMappings, warehouseMappings] = await Promise.all([
    getProductMappings(shop.id),
    getWarehouseMappings(shop.id),
  ]);

  const resolved = await fetchZohoStockForMappedProducts({
    zohoAuth,
    productMappings,
    warehouseMappings,
  });

  const results = resolved.filter((entry) => entry.status === "error");
  const toCheck = resolved.filter((entry) => entry.status === "resolved");
  const variantIds = [...new Set(toCheck.map((entry) => entry.shopifyVariantId))];

  const currentLevels = variantIds.length
    ? await fetchCurrentInventoryLevels(admin, variantIds)
    : {};

  const quantities = [];
  for (const entry of toCheck) {
    const current =
      currentLevels[`${entry.shopifyVariantId}::${entry.shopifyLocationId}`];

    if (!current) {
      results.push({
        ...entry,
        status: "skipped",
        reason: "not stocked at this location in Shopify",
      });
      continue;
    }

    if (current.quantity === entry.zohoStock) {
      results.push({ ...entry, status: "skipped", reason: "already matches" });
      continue;
    }

    quantities.push({
      inventoryItemId: current.inventoryItemId,
      locationId: entry.shopifyLocationId,
      quantity: entry.zohoStock,
      // Mandatory field - Shopify requires it to be explicitly present
      // (even as null) rather than omitted. null skips the compare-and-swap
      // check against Shopify's current quantity, which is correct here:
      // Zoho is the source of truth for this pull, not whatever Shopify
      // currently happens to say.
      changeFromQuantity: null,
    });
    results.push({ ...entry, status: "pending" });
  }

  if (quantities.length > 0) {
    const response = await admin.graphql(INVENTORY_SET_QUANTITIES_MUTATION, {
      variables: {
        input: {
          name: "available",
          reason: "correction",
          quantities,
        },
        // Required as of API version 2026-04 - one key per batch, since a
        // retried request should not double-apply the same set of changes.
        idempotencyKey: randomUUID(),
      },
    });
    const json = await response.json();
    const userErrors = json.data?.inventorySetQuantities?.userErrors || [];
    const errorMessage = userErrors.map((error) => error.message).join("; ");

    for (const result of results) {
      if (result.status !== "pending") continue;
      result.status = userErrors.length > 0 ? "error" : "success";
      if (userErrors.length > 0) result.error = errorMessage;
    }
  }

  const attempted = results.filter((result) => result.status !== "skipped");

  await finishSyncLog(logId, {
    recordsProcessed: attempted.length,
    recordsSuccess: attempted.filter((result) => result.status === "success")
      .length,
    recordsFailed: attempted.filter((result) => result.status === "error")
      .length,
    metadata: results,
  });

  return {
    processed: attempted.length,
    success: attempted.filter((result) => result.status === "success").length,
    failed: attempted.filter((result) => result.status === "error").length,
  };
}

import db from "../db.server";

const ENTITY_TYPE = "warehouse";

export async function getWarehouseMappings(shopId) {
  const [rows] = await db.execute(
    `SELECT shopify_id, zoho_id FROM sync_mappings WHERE shop_id = ? AND entity_type = ?`,
    [shopId, ENTITY_TYPE]
  );

  return Object.fromEntries(rows.map((row) => [row.shopify_id, row.zoho_id]));
}

export async function saveWarehouseMapping(shopId, shopifyLocationId, zohoWarehouseId) {
  await db.execute(
    `INSERT INTO sync_mappings (shop_id, entity_type, shopify_id, zoho_id, status, last_synced_at)
     VALUES (?, ?, ?, ?, 'mapped', NOW())
     ON DUPLICATE KEY UPDATE zoho_id = VALUES(zoho_id), status = 'mapped', last_synced_at = NOW()`,
    [shopId, ENTITY_TYPE, shopifyLocationId, zohoWarehouseId]
  );
}

export async function removeWarehouseMapping(shopId, shopifyLocationId) {
  await db.execute(`DELETE FROM sync_mappings WHERE shop_id = ? AND entity_type = ? AND shopify_id = ?`, [
    shopId,
    ENTITY_TYPE,
    shopifyLocationId,
  ]);
}

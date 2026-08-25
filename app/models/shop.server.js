import db from "../db.server";

export async function ensureShop(shopDomain, { shopName, email } = {}) {
  await db.execute(
    `INSERT INTO shops (shop_domain, shop_name, email, is_active, installed_at)
     VALUES (?, ?, ?, TRUE, NOW())
     ON DUPLICATE KEY UPDATE
       shop_name = COALESCE(?, shop_name),
       email = COALESCE(?, email),
       is_active = TRUE,
       uninstalled_at = NULL`,
    [shopDomain, shopName || null, email || null, shopName || null, email || null]
  );

  return getShopByDomain(shopDomain);
}

export async function getShopByDomain(shopDomain) {
  const [rows] = await db.execute(
    `SELECT id, shop_domain, shop_name, email FROM shops WHERE shop_domain = ? LIMIT 1`,
    [shopDomain]
  );

  return rows[0] || null;
}

import db from "../db.server";

// Makes sure a shops row exists. Deliberately does NOT reactivate an
// uninstalled shop - every webhook and page load goes through here, and
// only a real (re)install should flip is_active back on (markShopInstalled).
export async function ensureShop(shopDomain, { shopName, email } = {}) {
  await db.execute(
    `INSERT INTO shops (shop_domain, shop_name, email, is_active, installed_at)
     VALUES (?, ?, ?, TRUE, NOW())
     ON DUPLICATE KEY UPDATE
       shop_name = COALESCE(?, shop_name),
       email = COALESCE(?, email)`,
    [shopDomain, shopName || null, email || null, shopName || null, email || null]
  );

  return getShopByDomain(shopDomain);
}

// Called from the afterAuth hook, i.e. on install/reinstall.
export async function markShopInstalled(shopDomain, { shopName, email } = {}) {
  await db.execute(
    `INSERT INTO shops (shop_domain, shop_name, email, is_active, installed_at)
     VALUES (?, ?, ?, TRUE, NOW())
     ON DUPLICATE KEY UPDATE
       shop_name = COALESCE(?, shop_name),
       email = COALESCE(?, email),
       is_active = TRUE,
       installed_at = IF(is_active, installed_at, NOW()),
       uninstalled_at = NULL`,
    [shopDomain, shopName || null, email || null, shopName || null, email || null]
  );
}

export async function markShopUninstalled(shopDomain) {
  await db.execute(
    `UPDATE shops SET is_active = FALSE, uninstalled_at = NOW() WHERE shop_domain = ?`,
    [shopDomain]
  );
}

export async function getShopByDomain(shopDomain) {
  const [rows] = await db.execute(
    `SELECT id, shop_domain, shop_name, email FROM shops WHERE shop_domain = ? LIMIT 1`,
    [shopDomain]
  );

  return rows[0] || null;
}

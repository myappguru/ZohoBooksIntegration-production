import db from "../db.server";

export async function getAppSettings(shopId) {
  const [rows] = await db.execute(`SELECT settings FROM app_settings WHERE shop_id = ? LIMIT 1`, [shopId]);

  if (!rows[0] || !rows[0].settings) return {};

  return typeof rows[0].settings === "string" ? JSON.parse(rows[0].settings) : rows[0].settings;
}

// Shallow-merges `patch` into the shop's stored settings under the given
// top-level key (e.g. "organization"), leaving other keys (warehouse
// mapping, tax settings, ... added by later sync features) untouched.
export async function mergeAppSettings(shopId, key, patch) {
  const current = await getAppSettings(shopId);
  const next = { ...current, [key]: { ...current[key], ...patch } };

  await db.execute(
    `INSERT INTO app_settings (shop_id, settings)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE settings = VALUES(settings)`,
    [shopId, JSON.stringify(next)]
  );

  return next;
}

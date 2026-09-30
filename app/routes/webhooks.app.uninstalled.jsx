import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopByDomain, markShopUninstalled } from "../models/shop.server";
import { disconnect } from "../models/zohoConnection.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app
  // has already been uninstalled. If this webhook already ran,
  // the session may have been deleted previously.
  if (session) {
    await db.execute(
      `
        DELETE FROM shopify_sessions
        WHERE shop = ?
      `,
      [shop]
    );
  }

  // Mark the shop uninstalled and revoke/wipe its Zoho credentials - the
  // app can no longer act for this store, so nothing should keep syncing
  // or keep working tokens for its books around.
  try {
    await markShopUninstalled(shop);
    const shopRecord = await getShopByDomain(shop);
    if (shopRecord) await disconnect(shopRecord.id);
  } catch (error) {
    console.error("Failed to clean up after uninstall", shop, error);
  }

  return new Response();
};
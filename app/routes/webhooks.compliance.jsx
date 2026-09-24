import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopByDomain } from "../models/shop.server";

// Mandatory compliance webhooks (customers/data_request, customers/redact,
// shop/redact). authenticate.webhook verifies the HMAC and responds with
// 401 on an invalid signature, as required by Shopify.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} compliance webhook for ${shop}`);

  const shopRecord = await getShopByDomain(shop);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // The only customer data stored is the Shopify <-> Zoho id mapping
      // (sync_mappings) and webhook logs; nothing to return automatically.
      console.log(
        `Customer data request for ${shop}, customer ${payload.customer?.id}`
      );
      break;

    case "CUSTOMERS_REDACT": {
      if (!shopRecord || !payload.customer?.id) break;

      const shopifyCustomerId = `gid://shopify/Customer/${payload.customer.id}`;

      await db.execute(
        `DELETE FROM sync_mappings
         WHERE shop_id = ? AND entity_type = 'customer' AND shopify_id = ?`,
        [shopRecord.id, shopifyCustomerId]
      );
      await db.execute(
        `DELETE FROM webhook_logs WHERE shop_id = ? AND resource_id = ?`,
        [shopRecord.id, shopifyCustomerId]
      );

      // Order webhook payloads hold the customer's name, email and addresses.
      for (const orderId of payload.orders_to_redact || []) {
        await db.execute(
          `DELETE FROM webhook_logs WHERE shop_id = ? AND resource_id = ?`,
          [shopRecord.id, `gid://shopify/Order/${orderId}`]
        );
      }
      break;
    }

    case "SHOP_REDACT":
      // Deleting the shops row cascades to zoho_connections, sync_mappings,
      // sync_logs, webhook_logs and app_settings.
      if (shopRecord) {
        await db.execute(`DELETE FROM shops WHERE id = ?`, [shopRecord.id]);
      }
      await db.execute(`DELETE FROM shopify_sessions WHERE shop = ?`, [shop]);
      break;
  }

  return new Response();
};

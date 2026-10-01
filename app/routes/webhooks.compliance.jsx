import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopByDomain } from "../models/shop.server";
import { redactCustomer, describeCustomerData } from "../models/compliance.server";

// Mandatory compliance webhooks (customers/data_request, customers/redact,
// shop/redact). authenticate.webhook verifies the HMAC and responds with
// 401 on an invalid signature, as required by Shopify.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} compliance webhook for ${shop}`);

  const shopRecord = await getShopByDomain(shop);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      if (!shopRecord) break;
      const { mappings } = await describeCustomerData(shopRecord.id, payload);
      // The app stores no customer profile of its own - only these sync
      // links (to records in the merchant's Zoho org) and short-lived logs.
      console.log(
        `Customer data request for ${shop}, customer ${payload.customer?.id}: ${mappings.length} sync link(s)`,
        mappings.map((row) => `${row.entity_type}:${row.zoho_id}`),
      );
      break;
    }

    case "CUSTOMERS_REDACT":
      if (!shopRecord) break;
      await redactCustomer(shopRecord.id, payload);
      break;

    case "SHOP_REDACT":
      if (shopRecord) {
        await db.execute(`DELETE FROM shops WHERE id = ?`, [shopRecord.id]);
      }
      await db.execute(`DELETE FROM shopify_sessions WHERE shop = ?`, [shop]);
      break;
  }

  return new Response();
};

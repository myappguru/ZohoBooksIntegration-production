import { authenticate } from "../shopify.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "../models/zohoConnection.server";
import { syncProductDeletionToZoho } from "../models/productSync.server";
import {
  recordWebhookReceived,
  finishWebhookLog,
} from "../models/webhookLog.server";

// Shopify's products/delete payload is just `{ id }` (the numeric REST id)
// - no admin_graphql_api_id, no variants. The product's GID is
// deterministic (`gid://shopify/Product/{id}`), and sync_mappings now
// stores that GID as `shopify_parent_id` on every variant mapping row
// (added specifically for this), so it can still be looked up.
export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);
  const { shop: shopRecord, connection } =
    await getConnectionForShopDomain(shop);
  const shopifyProductId = `gid://shopify/Product/${payload.id}`;

  const logId = await recordWebhookReceived(shopRecord.id, {
    webhookId,
    topic,
    shopDomain: shop,
    resourceId: shopifyProductId,
    payload,
  });

  if (!logId) return new Response(); // Duplicate delivery of a webhook we've already processed.

  if (!connection) {
    await finishWebhookLog(logId, {
      status: "skipped",
      errorMessage: "Zoho Books is not connected for this shop",
    });
    return new Response();
  }

  try {
    const token = await getValidAccessToken(shopRecord.id);
    if (!token) throw new Error("No valid Zoho access token");

    const zohoAuth = {
      accessToken: token.accessToken,
      apiDomain: token.apiDomain,
      organizationId: connection.organization_id,
    };
    const results = await syncProductDeletionToZoho({
      shopId: shopRecord.id,
      zohoAuth,
      shopifyProductId,
    });
    const failed = results.filter((result) => result.status === "error");

    await finishWebhookLog(logId, {
      status: failed.length > 0 ? "failed" : "processed",
      errorMessage:
        failed.length > 0
          ? failed
              .map((result) => `${result.zohoItemId}: ${result.error}`)
              .join("; ")
          : null,
    });
  } catch (error) {
    console.error("Failed to process product deletion webhook", error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }

  return new Response();
};

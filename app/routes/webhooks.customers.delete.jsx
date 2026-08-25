import { authenticate } from "../shopify.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "../models/zohoConnection.server";
import { syncCustomerDeletionToZoho } from "../models/customerSync.server";
import {
  recordWebhookReceived,
  finishWebhookLog,
} from "../models/webhookLog.server";

// Shopify's customers/delete payload is just `{ id }` (the numeric REST id)
// - no admin_graphql_api_id. The customer's GID is deterministic
// (`gid://shopify/Customer/{id}`), which is exactly what's stored as
// shopify_id on the mapping row from GraphQL/webhook upsert syncs.
export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);
  const { shop: shopRecord, connection } =
    await getConnectionForShopDomain(shop);
  const shopifyCustomerId = `gid://shopify/Customer/${payload.id}`;

  const logId = await recordWebhookReceived(shopRecord.id, {
    webhookId,
    topic,
    shopDomain: shop,
    resourceId: shopifyCustomerId,
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
    const result = await syncCustomerDeletionToZoho({
      shopId: shopRecord.id,
      zohoAuth,
      shopifyCustomerId,
    });

    await finishWebhookLog(logId, {
      status: result.status === "error" ? "failed" : "processed",
      errorMessage: result.status === "error" ? result.error : null,
    });
  } catch (error) {
    console.error("Failed to process customer deletion webhook", error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }

  return new Response();
};

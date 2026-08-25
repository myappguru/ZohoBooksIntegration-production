import { authenticate } from "../shopify.server";
import {
  getConnectionForShopDomain,
  getValidAccessToken,
} from "../models/zohoConnection.server";
import { syncOrderCancellationToZoho } from "../models/orderSync.server";
import {
  recordWebhookReceived,
  finishWebhookLog,
} from "../models/webhookLog.server";

export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);
  const { shop: shopRecord, connection } =
    await getConnectionForShopDomain(shop);
  const shopifyOrderId = payload.admin_graphql_api_id;

  const logId = await recordWebhookReceived(shopRecord.id, {
    webhookId,
    topic,
    shopDomain: shop,
    resourceId: shopifyOrderId,
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
    const result = await syncOrderCancellationToZoho({
      shopId: shopRecord.id,
      zohoAuth,
      shopifyOrderId,
    });

    await finishWebhookLog(logId, {
      status: result.status === "error" ? "failed" : "processed",
      errorMessage: result.status === "error" ? result.error : null,
    });
  } catch (error) {
    console.error("Failed to process order cancellation webhook", error);
    await finishWebhookLog(logId, {
      status: "failed",
      errorMessage: error.message,
    });
  }

  return new Response();
};

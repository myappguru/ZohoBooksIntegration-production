import { authenticate } from "../shopify.server";
import { processRefundCreateWebhook } from "../models/refundSync.server";

export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await processRefundCreateWebhook({ shop, topic, webhookId, payload });

  return new Response();
};

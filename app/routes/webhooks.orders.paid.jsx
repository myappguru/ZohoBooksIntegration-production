import { authenticate } from "../shopify.server";
import { processOrderPaidWebhook } from "../models/paymentSync.server";

export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);

  await processOrderPaidWebhook({ shop, topic, webhookId, payload });

  return new Response();
};

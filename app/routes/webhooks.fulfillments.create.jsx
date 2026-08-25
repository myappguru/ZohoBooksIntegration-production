import { authenticate } from "../shopify.server";
import { processFulfillmentCreateWebhook } from "../models/fulfillmentSync.server";

export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await processFulfillmentCreateWebhook({ shop, topic, webhookId, payload });

  return new Response();
};

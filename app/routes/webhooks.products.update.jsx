import { authenticate } from "../shopify.server";
import { processProductUpsertWebhook } from "../models/productSync.server";

export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload, admin } =
    await authenticate.webhook(request);

  await processProductUpsertWebhook({ shop, topic, webhookId, payload, admin });

  return new Response();
};

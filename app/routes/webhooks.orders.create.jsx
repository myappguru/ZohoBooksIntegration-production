import { authenticate } from "../shopify.server";
import { processOrderUpsertWebhook } from "../models/orderSync.server";

export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);

  await processOrderUpsertWebhook({ shop, topic, webhookId, payload });

  return new Response();
};

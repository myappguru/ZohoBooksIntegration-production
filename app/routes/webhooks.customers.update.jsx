import { authenticate } from "../shopify.server";
import { processCustomerUpsertWebhook } from "../models/customerSync.server";

export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);

  await processCustomerUpsertWebhook({ shop, topic, webhookId, payload });

  return new Response();
};

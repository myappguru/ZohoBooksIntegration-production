import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../models/webhookQueue.server";

// Acknowledged immediately and processed in the background: Shopify gives a
// webhook 5 seconds, and syncing to Zoho can take many sequential calls.
export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  enqueueWebhook({ shop, topic, webhookId, payload });

  return new Response();
};

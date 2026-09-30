import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../models/webhookQueue.server";

// Needs `admin` (available from authenticate.webhook when there's a stored
// session for the shop) to resolve the inventory item back to its variant.
export const action = async ({ request }) => {
  const { shop, topic, webhookId, payload, admin } = await authenticate.webhook(request);

  enqueueWebhook({ shop, topic, webhookId, payload, admin });

  return new Response();
};

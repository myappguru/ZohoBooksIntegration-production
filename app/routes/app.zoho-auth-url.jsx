import { authenticate } from "../shopify.server";
import { getAuthorizationUrl } from "../zoho.server";

// Returns a freshly signed Zoho authorization URL. The Connect buttons fetch
// this at click time instead of baking the URL into the page loader, because
// the signed state expires after 15 minutes and a page left open longer
// would otherwise send the merchant to Zoho with a dead link.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return Response.json(
    { url: getAuthorizationUrl(session.shop) },
    { headers: { "Cache-Control": "no-store" } },
  );
};

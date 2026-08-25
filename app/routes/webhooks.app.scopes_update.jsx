import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current;

  if (session) {
    await db.execute(
      `
        UPDATE shopify_sessions
        SET scope = ?
        WHERE id = ?
      `,
      [current.toString(), session.id]
    );
  }

  return new Response();
};
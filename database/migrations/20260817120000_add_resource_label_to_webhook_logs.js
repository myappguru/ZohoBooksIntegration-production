export async function up(knex) {
  await knex.schema.alterTable("webhook_logs", (table) => {
    // Human-readable description of what the webhook was about (e.g.
    // "Blue T-Shirt - Large (SKU BTS-L) @ Warehouse A — available: 42") -
    // `resource_id` alone is a raw Shopify GID, useless for a merchant
    // reading the activity log. Only known once the handler resolves the
    // payload (variant/location lookup), so it's set via finishWebhookLog,
    // not at initial insert.
    table.string("resource_label", 500).nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable("webhook_logs", (table) => {
    table.dropColumn("resource_label");
  });
}

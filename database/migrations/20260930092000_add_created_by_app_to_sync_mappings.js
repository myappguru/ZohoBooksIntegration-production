export async function up(knex) {
  await knex.schema.alterTable("sync_mappings", (table) => {
    // TRUE when this app created the Zoho record, FALSE when it linked to a
    // record that already existed in Zoho (matched by SKU/email). NULL for
    // rows written before this was tracked - treated as "not ours", so a
    // Shopify delete only deactivates those instead of deleting them.
    table.boolean("created_by_app").nullable().after("zoho_id");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("sync_mappings", (table) => {
    table.dropColumn("created_by_app");
  });
}

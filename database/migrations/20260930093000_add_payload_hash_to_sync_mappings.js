export async function up(knex) {
  await knex.schema.alterTable("sync_mappings", (table) => {
    // Hash of the last payload successfully pushed to Zoho, so unchanged
    // records (products/update fired by a sale, "Sync now" re-runs) skip the
    // Zoho calls instead of burning the org's daily API quota.
    table.string("payload_hash", 64).nullable().after("created_by_app");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("sync_mappings", (table) => {
    table.dropColumn("payload_hash");
  });
}

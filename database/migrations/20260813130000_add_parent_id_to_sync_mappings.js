export async function up(knex) {
  await knex.schema.alterTable("sync_mappings", (table) => {
    // Generic parent link (e.g. a product's GID for a product-variant
    // mapping row) - lets callers find "all mapping rows belonging to X"
    // when a delete webhook only gives us the parent's id, not its
    // children's. Nullable since not every entity_type has a parent.
    table.string("shopify_parent_id", 255).nullable();
    table.index(["shop_id", "entity_type", "shopify_parent_id"]);
  });
}

export async function down(knex) {
  await knex.schema.alterTable("sync_mappings", (table) => {
    table.dropIndex(["shop_id", "entity_type", "shopify_parent_id"]);
    table.dropColumn("shopify_parent_id");
  });
}

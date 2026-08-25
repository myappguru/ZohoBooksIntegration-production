export async function up(knex) {
    await knex.schema.createTable("sync_mappings", (table) => {
        table.bigIncrements("id").primary();

        table
            .bigInteger("shop_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("shops")
            .onDelete("CASCADE");

        table.string("entity_type", 100).notNullable();

        table.string("shopify_id", 255).notNullable();

        table.string("zoho_id", 255).notNullable();

        table.string("status", 50).notNullable().defaultTo("synced");

        table.timestamp("last_synced_at").nullable();

        table.text("last_error").nullable();

        table.timestamps(true, true);

        table.unique(["shop_id", "entity_type", "shopify_id"]);

        table.index(["zoho_id"]);
        table.index(["entity_type"]);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("sync_mappings");
}
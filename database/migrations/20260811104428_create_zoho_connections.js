export async function up(knex) {
  await knex.schema.createTable("zoho_connections", (table) => {
    table.bigIncrements("id").primary();

    table
      .bigInteger("shop_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("shops")
      .onDelete("CASCADE");

    table.string("organization_id", 100).notNullable();

    table.string("organization_name", 255).nullable();

    table.text("access_token").nullable();

    table.text("refresh_token").notNullable();

    table.string("api_domain", 255).nullable();

    table.string("data_center", 50).nullable();

    table.string("scope", 1000).nullable();

    table.timestamp("access_token_expires_at").nullable();

    table.boolean("is_active").notNullable().defaultTo(true);

    table.timestamp("connected_at").nullable();

    table.timestamp("disconnected_at").nullable();

    table.timestamps(true, true);

    table.unique(["shop_id", "organization_id"]);

    table.index(["shop_id"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("zoho_connections");
}
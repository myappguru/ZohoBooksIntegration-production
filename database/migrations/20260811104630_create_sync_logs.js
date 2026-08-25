export async function up(knex) {
  await knex.schema.createTable("sync_logs", (table) => {
    table.bigIncrements("id").primary();

    table
      .bigInteger("shop_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("shops")
      .onDelete("CASCADE");

    table
      .bigInteger("zoho_connection_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("zoho_connections")
      .onDelete("SET NULL");

    table.string("entity_type", 100).notNullable();
    table.string("direction", 50).notNullable();
    table.string("action", 50).nullable();
    table.string("source_id", 255).nullable();
    table.string("target_id", 255).nullable();
    table.string("status", 50).notNullable().defaultTo("pending");
    table.integer("records_processed").notNullable().defaultTo(0);
    table.integer("records_success").notNullable().defaultTo(0);
    table.integer("records_failed").notNullable().defaultTo(0);
    table.text("error_message").nullable();
    table.json("metadata").nullable();
    table.timestamp("started_at").nullable();
    table.timestamp("completed_at").nullable();
    table.timestamps(true, true);
    table.index(["shop_id"]);
    table.index(["entity_type"]);
    table.index(["status"]);
    table.index(["created_at"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("sync_logs");
}
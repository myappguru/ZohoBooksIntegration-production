export async function up(knex) {
  await knex.schema.createTable("webhook_logs", (table) => {
    table.bigIncrements("id").primary();

    table
      .bigInteger("shop_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("shops")
      .onDelete("CASCADE");

    table.string("webhook_id", 255).nullable().unique();
    table.string("topic", 255).notNullable();
    table.string("shop_domain", 255).notNullable();
    table.string("resource_id", 255).nullable();
    table.json("payload").nullable();
    table.string("status", 50).notNullable().defaultTo("received");
    table.integer("attempts").notNullable().defaultTo(0);
    table.text("error_message").nullable();
    table.timestamp("received_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("processed_at").nullable();
    table.timestamps(true, true);
    table.index(["shop_id"]);
    table.index(["topic"]);
    table.index(["status"]);
    table.index(["received_at"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("webhook_logs");
}
export async function up(knex) {
  await knex.schema.createTable("app_settings", (table) => {
    table.bigIncrements("id").primary();

    table
      .bigInteger("shop_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("shops")
      .onDelete("CASCADE");

    table.json("settings").nullable();
    table.timestamps(true, true);
    table.unique(["shop_id"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("app_settings");
}
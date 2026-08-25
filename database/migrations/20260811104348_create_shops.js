export async function up(knex) {
  await knex.schema.createTable("shops", (table) => {
    table.bigIncrements("id").primary();

    table
      .string("shop_domain", 255)
      .notNullable()
      .unique();

    table.string("shop_name", 255).nullable();

    table.string("email", 255).nullable();

    table.boolean("is_active").notNullable().defaultTo(true);

    table.timestamp("installed_at").nullable();

    table.timestamp("uninstalled_at").nullable();

    table.timestamps(true, true);

    table.index(["shop_domain"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("shops");
}
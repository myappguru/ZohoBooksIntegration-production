export async function up(knex) {
  await knex.schema.alterTable("shopify_sessions", (table) => {
    // This app's SCOPES list is ~2000 chars, well past the session
    // package's default varchar(1024), which made every OAuth session
    // write fail with ER_DATA_TOO_LONG.
    table.text("scope").nullable().alter();
  });
}

export async function down(knex) {
  await knex.schema.alterTable("shopify_sessions", (table) => {
    table.string("scope", 1024).nullable().alter();
  });
}

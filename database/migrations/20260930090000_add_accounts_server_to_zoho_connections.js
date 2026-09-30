export async function up(knex) {
  await knex.schema.alterTable("zoho_connections", (table) => {
    // The exact Zoho accounts host that issued the tokens (e.g.
    // accounts.zohocloud.ca for Canada), so refreshes don't have to guess
    // it from data_center.
    table.string("accounts_server", 255).nullable().after("data_center");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("zoho_connections", (table) => {
    table.dropColumn("accounts_server");
  });
}

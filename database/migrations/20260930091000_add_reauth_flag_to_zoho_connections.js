export async function up(knex) {
  await knex.schema.alterTable("zoho_connections", (table) => {
    // Set when Zoho rejects the refresh token (revoked access, expired
    // grant) so the UI can ask the merchant to reconnect instead of still
    // showing "Connected" while every sync fails.
    table.boolean("needs_reauth").notNullable().defaultTo(false).after("is_active");
    table.text("last_auth_error").nullable().after("needs_reauth");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("zoho_connections", (table) => {
    table.dropColumn("last_auth_error");
    table.dropColumn("needs_reauth");
  });
}

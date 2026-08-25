import "dotenv/config";

export default {
  development: {
    client: "mysql2",
    connection: {
      host: process.env.DB_HOST || "127.0.0.1",
      port: Number(process.env.DB_PORT || 3307),
      user: process.env.DB_USERNAME || "root",
      password: process.env.DB_PASSWORD || "",
      database:
        process.env.DB_DATABASE || "dev-zohobooksintegration",
    },
    migrations: {
      directory: "./database/migrations"
    },
  },
};
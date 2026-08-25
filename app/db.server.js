import mysql from "mysql2/promise";

const db = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USERNAME || "root",
  password: process.env.DB_PASSWORD || "",
  database:
    process.env.DB_DATABASE || "dev-zohobooksintegration",

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export default db;
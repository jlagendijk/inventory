import mariadb from "mariadb";
import fs from "fs";
import path from "path";

const SCHEMA_PATH = path.resolve("/app/server/schema.sql");

export function createPool({ host, port, user, password, database }) {
  return mariadb.createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit: 5
  });
}

export async function ensureSchema(pool) {
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  let conn;
  try {
    conn = await pool.getConnection();
    // schema.sql bevat meerdere statements; mariadb driver accepteert dit doorgaans.
    // Voor maximale compatibiliteit splitsen we op ';' en runnen we per stuk.
    const parts = sql
      .split(";")
      .map(s => s.trim())
      .filter(Boolean);

    for (const stmt of parts) {
      await conn.query(stmt);
    }
  } finally {
    if (conn) conn.release();
  }
}

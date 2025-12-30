import mariadb from "mariadb";

export function createPool(opts) {
  return mariadb.createPool({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database: opts.database,
    connectionLimit: 5,
    acquireTimeout: 10000,
  });
}

export async function ensureSchema(pool) {
  let conn;
  try {
    conn = await pool.getConnection();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        description TEXT NULL,
        qty INT NULL,
        store VARCHAR(255) NULL,
        purchase_date DATE NULL,
        warranty_months INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_id INT NOT NULL,
        filename VARCHAR(512) NOT NULL,
        original_name VARCHAR(512) NULL,
        mime_type VARCHAR(128) NULL,
        size_bytes BIGINT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_receipts_item
          FOREIGN KEY (item_id) REFERENCES items(id)
          ON DELETE CASCADE
      )
    `);
  } finally {
    if (conn) conn.release();
  }
}

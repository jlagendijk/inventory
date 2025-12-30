import mariadb from "mariadb";

/**
 * Create a MariaDB pool.
 */
export function createPool({ host, port, user, password, database }) {
  return mariadb.createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit: 5,
    acquireTimeout: 10000,
    idleTimeout: 60000
  });
}

/**
 * Create/upgrade DB schema (idempotent).
 * Notes:
 * - items.id is INT(11) (signed) to match your existing table.
 * - attachments.item_id is also INT(11) to satisfy FK.
 */
export async function ensureSchema(pool) {
  let conn;
  try {
    conn = await pool.getConnection();

    // Ensure DB defaults (safe)
    await conn.query("SET NAMES utf8mb4");

    // Items table (minimal, with added link_url)
    // If your table already exists, the CREATE IF NOT EXISTS won't change it.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS items (
        id INT(11) NOT NULL AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        description TEXT NULL,
        quantity INT NULL,
        store VARCHAR(255) NULL,
        purchase_date DATE NULL,
        warranty_months INT NULL,
        article_no VARCHAR(255) NULL,
        link_url VARCHAR(2048) NULL,
        notes TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // If items exists already, add columns if missing (best-effort).
    await safeAddColumn(conn, "items", "description", "TEXT NULL");
    await safeAddColumn(conn, "items", "quantity", "INT NULL");
    await safeAddColumn(conn, "items", "link_url", "VARCHAR(2048) NULL");

    // Attachments table (bon & gebruiksaanwijzing)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id INT(11) NOT NULL AUTO_INCREMENT,
        item_id INT(11) NOT NULL,
        kind ENUM('receipt','manual') NOT NULL,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NULL,
        mime_type VARCHAR(128) NULL,
        size_bytes BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_item_id (item_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Add FK if possible (best-effort; ignore if it already exists or cannot be added)
    // First ensure items uses InnoDB (FK requires it).
    await conn.query(`ALTER TABLE items ENGINE=InnoDB;`).catch(() => {});

    await conn
      .query(`
        ALTER TABLE attachments
        ADD CONSTRAINT fk_attachments_item
        FOREIGN KEY (item_id) REFERENCES items(id)
        ON DELETE CASCADE
      `)
      .catch(() => {});

  } finally {
    if (conn) conn.release();
  }
}

async function safeAddColumn(conn, table, column, ddl) {
  try {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
  } catch {
    // ignore: column exists or not possible
  }
}

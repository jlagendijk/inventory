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
      CREATE TABLE IF NOT EXISTS types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sizes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        type_id INT NULL,
        box_no VARCHAR(255) NULL,
        qty INT NULL,
        size_id INT NULL,
        location_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_items_type FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE SET NULL,
        CONSTRAINT fk_items_size FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE SET NULL,
        CONSTRAINT fk_items_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
      )
    `);

    // Seed defaults (idempotent)
    await conn.query(`INSERT IGNORE INTO types (name) VALUES ('Schroeven'),('PVC'),('Boren'),('Spijkers')`);
    await conn.query(`INSERT IGNORE INTO locations (name) VALUES ('Zolder'),('Schuur'),('Garage')`);
    await conn.query(`INSERT IGNORE INTO sizes (name) VALUES ('-')`);
  } finally {
    if (conn) conn.release();
  }
}

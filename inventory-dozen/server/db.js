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
      CREATE TABLE IF NOT EXISTS locations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS boxes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        location_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_boxes_location
          FOREIGN KEY (location_id) REFERENCES locations(id)
          ON DELETE SET NULL
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS box_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        box_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        qty INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_boxitems_box
          FOREIGN KEY (box_id) REFERENCES boxes(id)
          ON DELETE CASCADE
      )
    `);
  } finally {
    if (conn) conn.release();
  }
}

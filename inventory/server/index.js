// inventory/server/index.js
// Full, corrected server for Home Assistant add-on "inventory":
// - MariaDB (core-mariadb) via mariadb pool (createPool in db.js)
// - Ingress-safe base_url handling
// - Items CRUD
// - Receipts upload/list/delete
// - Locations + Boxes
// - Move item to box / box contents
// - BigInt-safe JSON output
//
// Assumptions:
// - db.js exports: createPool(opts) and ensureSchema(pool)
// - ensureSchema creates tables: items, receipts, locations, boxes, and items.box_id (nullable)

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";

import { createPool, ensureSchema } from "./db.js";

// -------------------------
// Options (from /data/options.json)
// -------------------------
const OPTIONS_PATH = "/data/options.json";
function readOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
  } catch {
    return {};
  }
}
const options = readOptions();

const DB_HOST = options.db_host ?? "core-mariadb";
const DB_PORT = Number(options.db_port ?? 3306);
const DB_USER = options.db_user ?? "inventory_user";
const DB_PASSWORD = options.db_password ?? "change_me";
const DB_NAME = options.db_name ?? "inventory";

// base_url is optional (usually empty for ingress)
const BASE_URL = String(options.base_url ?? "").trim().replace(/\/+$/, "");
function apiPath(p) {
  const pp = String(p).startsWith("/") ? p : `/${p}`;
  return `${BASE_URL}${pp}`;
}

// -------------------------
// BigInt-safe JSON
// -------------------------
function jsonSafe(value) {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

// -------------------------
// App + DB pool (pool must exist BEFORE routes)
// -------------------------
const app = express();

const pool = createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
});

app.use(express.json({ limit: "2mb" }));

// -------------------------
// Persistent uploads
// -------------------------
const UPLOAD_DIR = "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Static UI under base_url (ingress uses subpath)
app.use(`${BASE_URL}/`, express.static("/app/web"));
app.use(`${BASE_URL}/uploads`, express.static(UPLOAD_DIR));

// -------------------------
// Multer for receipts
// -------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeOrig = (file.originalname || "receipt").replace(/[^\w.\-]+/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    cb(null, `${stamp}-${safeOrig}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// -------------------------
// Health
// -------------------------
app.get(apiPath("/api/health"), async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      await conn.query("SELECT 1");
    } finally {
      conn.release();
    }
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message ?? e) });
  }
});

// -------------------------
// Items
// -------------------------
app.get(apiPath("/api/items"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT i.id, i.name, i.store, i.warranty_months, i.article_no, i.purchase_date,
              i.notes, i.created_at, i.box_id,
              b.code AS box_code, b.label AS box_label
       FROM items i
       LEFT JOIN boxes b ON b.id = i.box_id
       ORDER BY i.id DESC`
    );
    res.json(jsonSafe(rows));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/items"), async (req, res) => {
  const { name, store, warranty_months, article_no, purchase_date, notes } = req.body ?? {};
  if (!name || String(name).trim().length === 0) return res.status(400).json({ error: "name_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `INSERT INTO items (name, store, warranty_months, article_no, purchase_date, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(name).trim(),
        store ?? null,
        warranty_months === "" || warranty_months == null ? null : Number(warranty_months),
        article_no ?? null,
        purchase_date ?? null,
        notes ?? null,
      ]
    );
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.delete(apiPath("/api/items/:id"), async (req, res) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("DELETE FROM items WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// Move item to box (or null to unbox)
app.post(apiPath("/api/items/:id/move"), async (req, res) => {
  const itemId = Number(req.params.id);
  const { box_id } = req.body ?? {};
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("UPDATE items SET box_id = ? WHERE id = ?", [box_id ?? null, itemId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// -------------------------
// Receipts
// -------------------------
app.get(apiPath("/api/items/:id/receipts"), async (req, res) => {
  const itemId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, item_id, filename, original_name, mime_type, size_bytes, uploaded_at
       FROM receipts
       WHERE item_id = ?
       ORDER BY uploaded_at DESC`,
      [itemId]
    );

    const mapped = rows.map((r) => ({
      ...r,
      url: `${BASE_URL}/uploads/${encodeURIComponent(r.filename)}`,
    }));

    res.json(jsonSafe(mapped));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/items/:id/receipts"), upload.single("file"), async (req, res) => {
  const itemId = Number(req.params.id);
  if (!req.file) return res.status(400).json({ error: "file_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(
      `INSERT INTO receipts (item_id, filename, original_name, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?)`,
      [itemId, req.file.filename, req.file.originalname ?? null, req.file.mimetype ?? null, req.file.size ?? null]
    );
    res.json({ ok: true });
  } catch (e) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
    } catch {
      // ignore
    }
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.delete(apiPath("/api/receipts/:receiptId"), async (req, res) => {
  const receiptId = Number(req.params.receiptId);
  let conn;
  try {
    conn = await pool.getConnection();

    const rows = await conn.query("SELECT filename FROM receipts WHERE id = ?", [receiptId]);
    const filename = rows?.[0]?.filename;

    await conn.query("DELETE FROM receipts WHERE id = ?", [receiptId]);

    if (filename) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, filename));
      } catch {
        // ignore
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// -------------------------
// Locations
// -------------------------
app.get(apiPath("/api/locations"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query("SELECT id, name, notes, created_at FROM locations ORDER BY name ASC");
    res.json(jsonSafe(rows));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/locations"), async (req, res) => {
  const { name, notes } = req.body ?? {};
  if (!name || String(name).trim().length === 0) return res.status(400).json({ error: "name_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query("INSERT INTO locations (name, notes) VALUES (?, ?)", [
      String(name).trim(),
      notes ?? null,
    ]);
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.delete(apiPath("/api/locations/:id"), async (req, res) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("DELETE FROM locations WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// -------------------------
// Boxes
// -------------------------
app.get(apiPath("/api/boxes"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT b.id, b.code, b.label, b.notes, b.created_at,
              b.location_id, l.name AS location_name,
              CAST((SELECT COUNT(*) FROM items i WHERE i.box_id = b.id) AS UNSIGNED) AS item_count
       FROM boxes b
       LEFT JOIN locations l ON l.id = b.location_id
       ORDER BY b.code ASC`
    );
    res.json(jsonSafe(rows));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/boxes"), async (req, res) => {
  const { code, label, location_id, notes } = req.body ?? {};
  if (!code || String(code).trim().length === 0) return res.status(400).json({ error: "code_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query("INSERT INTO boxes (code, label, location_id, notes) VALUES (?, ?, ?, ?)", [
      String(code).trim(),
      label ?? null,
      location_id ?? null,
      notes ?? null,
    ]);
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.delete(apiPath("/api/boxes/:id"), async (req, res) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("DELETE FROM boxes WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// Box contents
app.get(apiPath("/api/boxes/:id/items"), async (req, res) => {
  const boxId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT i.id, i.name, i.store, i.warranty_months, i.article_no, i.purchase_date,
              i.notes, i.created_at, i.box_id
       FROM items i
       WHERE i.box_id = ?
       ORDER BY i.id DESC`,
      [boxId]
    );
    res.json(jsonSafe(rows));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// -------------------------
// Search (server-side, optional)
// -------------------------
app.get(apiPath("/api/search"), async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const like = `%${q}%`;

  let conn;
  try {
    conn = await pool.getConnection();

    const itemRows = q
      ? await conn.query(
          `SELECT i.id, i.name, i.store, i.warranty_months, i.article_no, i.purchase_date,
                  i.notes, i.created_at, i.box_id,
                  b.code AS box_code, b.label AS box_label
           FROM items i
           LEFT JOIN boxes b ON b.id = i.box_id
           WHERE i.name LIKE ? OR i.store LIKE ? OR i.article_no LIKE ? OR i.notes LIKE ?
           ORDER BY i.id DESC
           LIMIT 200`,
          [like, like, like, like]
        )
      : [];

    const boxRows = q
      ? await conn.query(
          `SELECT b.id, b.code, b.label, b.notes, b.created_at,
                  b.location_id, l.name AS location_name,
                  CAST((SELECT COUNT(*) FROM items i WHERE i.box_id = b.id) AS UNSIGNED) AS item_count
           FROM boxes b
           LEFT JOIN locations l ON l.id = b.location_id
           WHERE b.code LIKE ? OR b.label LIKE ? OR b.notes LIKE ? OR l.name LIKE ?
           ORDER BY b.code ASC
           LIMIT 200`,
          [like, like, like, like]
        )
      : [];

    res.json(jsonSafe({ q, items: itemRows, boxes: boxRows }));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// -------------------------
// Startup (schema + optional FK) + listen
// -------------------------
const PORT = Number(process.env.PORT || 8099);

(async () => {
  // Ensure schema
  await ensureSchema(pool);

  // Optional: add FK items.box_id -> boxes.id (ignore errors if exists)
  try {
    const conn = await pool.getConnection();
    try {
      await conn.query(`
        ALTER TABLE items
        ADD CONSTRAINT fk_items_box
        FOREIGN KEY (box_id) REFERENCES boxes(id) ON DELETE SET NULL
      `);
    } finally {
      conn.release();
    }
  } catch {
    // ignore
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Inventory] listening on 0.0.0.0:${PORT} base_url="${BASE_URL}"`);
    console.log(`[Inventory] DB host=${DB_HOST} db=${DB_NAME} user=${DB_USER}`);
  });
})().catch((err) => {
  console.error("[Inventory] startup error:", err);
  process.exit(1);
});

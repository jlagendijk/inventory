// inventory/server/index.js (DECOUPLED)
// - Items + receipts (purchase module)
// - Inventory boxes + contents (separate module)
// No linkage between the two.

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { createPool, ensureSchema } from "./db.js";

// -------------------------
// Options
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
// App + DB pool
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
// Uploads + Static UI
// -------------------------
const UPLOAD_DIR = "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

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

// ===================================================================
// MODULE A: Artikelen + Kassabonnen (purchase module)
// ===================================================================

// Items
app.get(apiPath("/api/items"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, name, store, warranty_months, article_no, purchase_date, notes, created_at
       FROM items
       ORDER BY id DESC`
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

// Receipts
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
    try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch {}
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
      try { fs.unlinkSync(path.join(UPLOAD_DIR, filename)); } catch {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// ===================================================================
// MODULE B: Dozen-inventaris (SEPARAAT, los van artikelen)
// Tables: inventory_locations, inventory_boxes, inventory_box_items
// ===================================================================

// Locations
app.get(apiPath("/api/inventory/locations"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, name, notes, created_at
       FROM inventory_locations
       ORDER BY name ASC`
    );
    res.json(jsonSafe(rows));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/inventory/locations"), async (req, res) => {
  const { name, notes } = req.body ?? {};
  if (!name || String(name).trim().length === 0) return res.status(400).json({ error: "name_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `INSERT INTO inventory_locations (name, notes) VALUES (?, ?)`,
      [String(name).trim(), notes ?? null]
    );
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.delete(apiPath("/api/inventory/locations/:id"), async (req, res) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("DELETE FROM inventory_locations WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// Boxes
app.get(apiPath("/api/inventory/boxes"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT b.id, b.code, b.label, b.notes, b.created_at,
              b.location_id, l.name AS location_name,
              CAST((SELECT COUNT(*) FROM inventory_box_items bi WHERE bi.box_id = b.id) AS UNSIGNED) AS item_count
       FROM inventory_boxes b
       LEFT JOIN inventory_locations l ON l.id = b.location_id
       ORDER BY b.code ASC`
    );
    res.json(jsonSafe(rows));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/inventory/boxes"), async (req, res) => {
  const { code, label, location_id, notes } = req.body ?? {};
  if (!code || String(code).trim().length === 0) return res.status(400).json({ error: "code_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `INSERT INTO inventory_boxes (code, label, location_id, notes) VALUES (?, ?, ?, ?)`,
      [String(code).trim(), label ?? null, location_id ?? null, notes ?? null]
    );
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.delete(apiPath("/api/inventory/boxes/:id"), async (req, res) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("DELETE FROM inventory_boxes WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// Box contents (inventory items)
app.get(apiPath("/api/inventory/boxes/:id/items"), async (req, res) => {
  const boxId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, box_id, name, qty, notes, created_at
       FROM inventory_box_items
       WHERE box_id = ?
       ORDER BY id DESC`,
      [boxId]
    );
    res.json(jsonSafe(rows));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/inventory/boxes/:id/items"), async (req, res) => {
  const boxId = Number(req.params.id);
  const { name, qty, notes } = req.body ?? {};
  if (!name || String(name).trim().length === 0) return res.status(400).json({ error: "name_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `INSERT INTO inventory_box_items (box_id, name, qty, notes) VALUES (?, ?, ?, ?)`,
      [boxId, String(name).trim(), qty == null || qty === "" ? null : Number(qty), notes ?? null]
    );
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.delete(apiPath("/api/inventory/box-items/:id"), async (req, res) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("DELETE FROM inventory_box_items WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

// -------------------------
// Startup
// -------------------------
const PORT = Number(process.env.PORT || 8099);

(async () => {
  // Existing schema for items/receipts (your db.js should handle those)
  await ensureSchema(pool);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Inventory] listening on 0.0.0.0:${PORT} base_url="${BASE_URL}"`);
    console.log(`[Inventory] DB host=${DB_HOST} db=${DB_NAME} user=${DB_USER}`);
  });
})().catch((err) => {
  console.error("[Inventory] startup error:", err);
  process.exit(1);
});

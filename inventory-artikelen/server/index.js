import express from "express";
import fs from "fs";
import path from "path";

import { createPool, ensureSchema } from "./db.js";

const OPTIONS_PATH = "/data/options.json";
const options = (() => {
  try { return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8")); } catch { return {}; }
})();

const DB_HOST = options.db_host ?? "core-mariadb";
const DB_PORT = Number(options.db_port ?? 3306);
const DB_USER = options.db_user ?? "inventory_user";
const DB_PASSWORD = options.db_password ?? "change_me";
const DB_NAME = options.db_name ?? "inventory_artikelen";

const BASE_URL = String(options.base_url ?? "").trim().replace(/\/+$/, "");
function apiPath(p) {
  const pp = String(p).startsWith("/") ? p : `/${p}`;
  return `${BASE_URL}${pp}`;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// UI
app.use(`${BASE_URL}/`, express.static("/app/web"));

// Uploads (persist in /data)
const UPLOAD_DIR = "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(`${BASE_URL}/uploads`, express.static(UPLOAD_DIR));

const pool = createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });

// Health
app.get(apiPath("/api/health"), async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try { await conn.query("SELECT 1"); } finally { conn.release(); }
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message ?? e) });
  }
});

// Items CRUD
app.get(apiPath("/api/items"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(`
      SELECT id, label, description, qty, store, purchase_date, warranty_months, created_at
      FROM items
      ORDER BY id DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
});

app.post(apiPath("/api/items"), async (req, res) => {
  const label = String(req.body?.label ?? "").trim();
  if (!label) return res.status(400).json({ error: "label_required" });

  const description = req.body?.description ?? null;
  const qty = req.body?.qty === "" || req.body?.qty == null ? null : Number(req.body.qty);
  const store = req.body?.store ?? null;
  const purchase_date = req.body?.purchase_date ?? null;
  const warranty_months = req.body?.warranty_months === "" || req.body?.warranty_months == null ? null : Number(req.body.warranty_months);

  let conn;
  try {
    conn = await pool.getConnection();
    const r = await conn.query(
      `INSERT INTO items (label, description, qty, store, purchase_date, warranty_months)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [label, description, qty, store, purchase_date, warranty_months]
    );
    res.json({ id: Number(r.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
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
  } finally { if (conn) conn.release(); }
});

// Receipts (optional)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeOrig = (file.originalname || "receipt").replace(/[^\w.\-]+/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    cb(null, `${stamp}-${safeOrig}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

app.get(apiPath("/api/items/:id/receipts"), async (req, res) => {
  const itemId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, item_id, filename, original_name, mime_type, size_bytes, created_at
       FROM receipts
       WHERE item_id = ?
       ORDER BY id DESC`,
      [itemId]
    );

    const mapped = rows.map(r => ({
      ...r,
      url: `${BASE_URL}/uploads/${encodeURIComponent(r.filename)}`
    }));
    res.json(mapped);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
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
  } finally { if (conn) conn.release(); }
});

app.delete(apiPath("/api/receipts/:id"), async (req, res) => {
  const receiptId = Number(req.params.id);
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
  } finally { if (conn) conn.release(); }
});

const PORT = 8100;

(async () => {
  await ensureSchema(pool);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Inventory Artikelen] listening on :${PORT}`);
    console.log(`[Inventory Artikelen] DB ${DB_HOST}:${DB_PORT} db=${DB_NAME} user=${DB_USER}`);
  });
})().catch((err) => {
  console.error("[Inventory Artikelen] startup error:", err);
  process.exit(1);
});

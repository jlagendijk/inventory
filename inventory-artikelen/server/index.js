import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";

import { createPool, ensureSchema } from "./db.js";

const app = express();

// Read add-on options
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
const DB_NAME = options.db_name ?? "inventory_artikelen";
const BASE_URL = String(options.base_url ?? "").trim().replace(/\/+$/, "");

// Helper: prefix paths when BASE_URL is used (often empty for ingress)
function apiPath(p) {
  const pp = String(p).startsWith("/") ? p : `/${p}`;
  return `${BASE_URL}${pp}`;
}

// BigInt-safe JSON
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

// Storage (persistent)
const UPLOAD_DIR = "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeOrig = (file.originalname || "file").replace(/[^\w.\-]+/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    cb(null, `${stamp}-${safeOrig}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

const pool = createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME
});

app.use(express.json({ limit: "2mb" }));

// Static web UI
app.use(`${BASE_URL}/`, express.static("/app/web"));

// Serve uploads (attachments)
app.use(`${BASE_URL}/uploads`, express.static(UPLOAD_DIR));

/** Health */
app.get(apiPath("/api/health"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

/** Items list */
app.get(apiPath("/api/items"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, name, description, quantity, store, purchase_date, warranty_months,
              article_no, link_url, notes, created_at
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

/** Create item */
app.post(apiPath("/api/items"), async (req, res) => {
  const {
    name,
    description,
    quantity,
    store,
    purchase_date,
    warranty_months,
    article_no,
    link_url,
    notes
  } = req.body ?? {};

  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ error: "name_required" });
  }

  const nameTrim = String(name).trim();
  const qty = quantity === "" || quantity == null ? null : Number(quantity);
  const wMonths = warranty_months === "" || warranty_months == null ? null : Number(warranty_months);

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `INSERT INTO items (name, description, quantity, store, purchase_date, warranty_months, article_no, link_url, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nameTrim,
        description ?? null,
        Number.isFinite(qty) ? qty : null,
        store ?? null,
        purchase_date ?? null,
        Number.isFinite(wMonths) ? wMonths : null,
        article_no ?? null,
        link_url ?? null,
        notes ?? null
      ]
    );
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

/** Delete item (also deletes attachments via FK/ON DELETE CASCADE; and we also remove files best-effort) */
app.delete(apiPath("/api/items/:id"), async (req, res) => {
  const itemId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();

    // fetch filenames first to delete files
    const files = await conn.query(
      `SELECT filename FROM attachments WHERE item_id = ?`,
      [itemId]
    );

    await conn.query(`DELETE FROM items WHERE id = ?`, [itemId]);

    // delete files best-effort
    for (const f of files) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f.filename)); } catch {}
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

/** Attachments list for an item */
app.get(apiPath("/api/items/:id/attachments"), async (req, res) => {
  const itemId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT id, item_id, kind, filename, original_name, mime_type, size_bytes, created_at
       FROM attachments
       WHERE item_id = ?
       ORDER BY id DESC`,
      [itemId]
    );

    const mapped = rows.map(r => ({
      ...r,
      url: `${BASE_URL}/uploads/${encodeURIComponent(r.filename)}`
    }));

    res.json(jsonSafe(mapped));
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

/** Upload attachment for an item (kind=receipt|manual, field=file) */
app.post(apiPath("/api/items/:id/attachments"), upload.single("file"), async (req, res) => {
  const itemId = Number(req.params.id);
  const kind = String(req.body?.kind ?? "").trim();

  if (!req.file) return res.status(400).json({ error: "file_required" });
  if (!["receipt", "manual"].includes(kind)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch {}
    return res.status(400).json({ error: "kind_invalid" });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      `INSERT INTO attachments (item_id, kind, filename, original_name, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        itemId,
        kind,
        req.file.filename,
        req.file.originalname ?? null,
        req.file.mimetype ?? null,
        req.file.size ?? null
      ]
    );
    res.json({ id: Number(result.insertId) });
  } catch (e) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch {}
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

/** Delete attachment by id (also deletes the file) */
app.delete(apiPath("/api/attachments/:attachmentId"), async (req, res) => {
  const attachmentId = Number(req.params.attachmentId);
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(`SELECT filename FROM attachments WHERE id = ?`, [attachmentId]);
    const filename = rows?.[0]?.filename;

    await conn.query(`DELETE FROM attachments WHERE id = ?`, [attachmentId]);

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

// Start
const PORT = 8099;

(async () => {
  await ensureSchema(pool);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Inventory Artikelen] listening on :${PORT}`);
    console.log(`[Inventory Artikelen] DB host=${DB_HOST} db=${DB_NAME} user=${DB_USER}`);
  });
})().catch(err => {
  console.error("[Inventory Artikelen] startup error:", err);
  process.exit(1);
});

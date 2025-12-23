import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";

import { createPool, ensureSchema } from "./db.js";

const app = express();

// Add-on options komen via /data/options.json
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

// base_url is handig als je de app ooit buiten ingress wilt hosten.
// Voor ingress laten we dit leeg en gebruiken we relatieve paden.
const BASE_URL = (options.base_url ?? "").replace(/\/+$/, "");

// Persistente uploads
const UPLOAD_DIR = "/data/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const pool = createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME
});

app.use(express.json({ limit: "2mb" }));

// Static UI
app.use(`${BASE_URL}/`, express.static("/app/web"));

// Serve uploads (receipts)
app.use(`${BASE_URL}/uploads`, express.static(UPLOAD_DIR));

// API helper
function apiPath(p) {
  return `${BASE_URL}${p}`;
}

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

// Items
app.get(apiPath("/api/items"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      "SELECT id, name, store, warranty_months, article_no, purchase_date, notes, created_at FROM items ORDER BY id DESC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/items"), async (req, res) => {
  const { name, store, warranty_months, article_no, purchase_date, notes } = req.body ?? {};
  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ error: "name_required" });
  }

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

// ===== Locations =====
app.get(apiPath("/api/locations"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      "SELECT id, name, notes, created_at FROM locations ORDER BY name ASC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/locations"), async (req, res) => {
  const { name, notes } = req.body ?? {};
  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ error: "name_required" });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      "INSERT INTO locations (name, notes) VALUES (?, ?)",
      [String(name).trim(), notes ?? null]
    );
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

// ===== Boxes =====
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
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally {
    if (conn) conn.release();
  }
});

app.post(apiPath("/api/boxes"), async (req, res) => {
  const { code, label, location_id, notes } = req.body ?? {};
  if (!code || String(code).trim().length === 0) {
    return res.status(400).json({ error: "code_required" });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    const result = await conn.query(
      "INSERT INTO boxes (code, label, location_id, notes) VALUES (?, ?, ?, ?)",
      [String(code).trim(), label ?? null, location_id ?? null, notes ?? null]
    );
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

// ===== Items: koppel aan doos =====
app.post(apiPath("/api/items/:id/move"), async (req, res) => {
  const itemId = Number(req.params.id);
  const { box_id } = req.body ?? {}; // null = uit doos halen
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


// Receipts upload
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
  `SELECT i.id, i.name, i.store, i.warranty_months, i.article_no, i.purchase_date,
          i.notes, i.created_at, i.box_id,
          b.code AS box_code, b.label AS box_label
   FROM items i
   LEFT JOIN boxes b ON b.id = i.box_id
   ORDER BY i.id DESC`
);

    // Voeg een URL toe voor direct bekijken
    const mapped = rows.map(r => ({
      ...r,
      url: `${BASE_URL}/uploads/${encodeURIComponent(r.filename)}`
    }));
    res.json(mapped);
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
      [
        itemId,
        req.file.filename,
        req.file.originalname ?? null,
        req.file.mimetype ?? null,
        req.file.size ?? null
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    // Als DB insert faalt, verwijder bestand weer
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

const PORT = 8099;

(async () => {
  // DB & schema init
    await ensureSchema(pool);

  // Probeer FK items.box_id -> boxes.id toe te voegen (idempotent)
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
    // negeren: constraint bestaat al of DB ondersteunt IF NOT EXISTS niet
  }


  app.listen(PORT, () => {
    console.log(`[Inventory] listening on :${PORT}`);
    console.log(`[Inventory] DB host=${DB_HOST} db=${DB_NAME} user=${DB_USER}`);
  });
})().catch(err => {
  console.error("[Inventory] startup error:", err);
  process.exit(1);
});

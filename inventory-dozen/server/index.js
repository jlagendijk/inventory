import express from "express";
import fs from "fs";
import { createPool, ensureSchema } from "./db.js";

const OPTIONS_PATH = "/data/options.json";
const options = (() => {
  try { return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8")); } catch { return {}; }
})();

const DB_HOST = options.db_host ?? "core-mariadb";
const DB_PORT = Number(options.db_port ?? 3306);
const DB_USER = options.db_user ?? "inventory_user";
const DB_PASSWORD = options.db_password ?? "change_me";
const DB_NAME = options.db_name ?? "inventory_dozen";

const BASE_URL = String(options.base_url ?? "").trim().replace(/\/+$/, "");
function apiPath(p) {
  const pp = String(p).startsWith("/") ? p : `/${p}`;
  return `${BASE_URL}${pp}`;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// UI
app.use(`${BASE_URL}/`, express.static("/app/web"));

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

// Locations
app.get(apiPath("/api/locations"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query("SELECT id, name FROM locations ORDER BY name ASC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
});

app.post(apiPath("/api/locations"), async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const r = await conn.query("INSERT INTO locations (name) VALUES (?)", [name]);
    res.json({ id: Number(r.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
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
  } finally { if (conn) conn.release(); }
});

// Boxes
app.get(apiPath("/api/boxes"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(`
      SELECT b.id, b.label, b.location_id, l.name AS location_name,
             (SELECT COUNT(*) FROM box_items bi WHERE bi.box_id = b.id) AS item_count
      FROM boxes b
      LEFT JOIN locations l ON l.id = b.location_id
      ORDER BY b.label ASC
    `);
    // COUNT() kan BigInt opleveren; cast naar Number
    const mapped = rows.map(r => ({ ...r, item_count: Number(r.item_count ?? 0) }));
    res.json(mapped);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
});

app.post(apiPath("/api/boxes"), async (req, res) => {
  const label = String(req.body?.label ?? "").trim();
  const location_id = req.body?.location_id == null || req.body.location_id === "" ? null : Number(req.body.location_id);

  if (!label) return res.status(400).json({ error: "label_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const r = await conn.query("INSERT INTO boxes (label, location_id) VALUES (?, ?)", [label, location_id]);
    res.json({ id: Number(r.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
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
  } finally { if (conn) conn.release(); }
});

// Box contents
app.get(apiPath("/api/boxes/:id/items"), async (req, res) => {
  const boxId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      "SELECT id, box_id, name, qty, created_at FROM box_items WHERE box_id = ? ORDER BY id DESC",
      [boxId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
});

app.post(apiPath("/api/boxes/:id/items"), async (req, res) => {
  const boxId = Number(req.params.id);
  const name = String(req.body?.name ?? "").trim();
  const qty = req.body?.qty == null || req.body.qty === "" ? null : Number(req.body.qty);

  if (!name) return res.status(400).json({ error: "name_required" });

  let conn;
  try {
    conn = await pool.getConnection();
    const r = await conn.query(
      "INSERT INTO box_items (box_id, name, qty) VALUES (?, ?, ?)",
      [boxId, name, qty]
    );
    res.json({ id: Number(r.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
});

app.delete(apiPath("/api/box-items/:id"), async (req, res) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query("DELETE FROM box_items WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
});

const PORT = 8099;

(async () => {
  await ensureSchema(pool);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Inventory Dozen] listening on :${PORT}`);
    console.log(`[Inventory Dozen] DB ${DB_HOST}:${DB_PORT} db=${DB_NAME} user=${DB_USER}`);
  });
})().catch((err) => {
  console.error("[Inventory Dozen] startup error:", err);
  process.exit(1);
});

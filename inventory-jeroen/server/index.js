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
const DB_NAME = options.db_name ?? "inventory_jeroen";

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

// Generic helpers for lookups
async function listTable(table, res) {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(`SELECT id, name FROM ${table} ORDER BY name ASC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
}
async function insertTable(table, name, res) {
  let conn;
  try {
    conn = await pool.getConnection();
    const r = await conn.query(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
    res.json({ id: Number(r.insertId) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
}
async function deleteTable(table, id, res) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
}

// Types
app.get(apiPath("/api/types"), (req, res) => listTable("types", res));
app.post(apiPath("/api/types"), (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name_required" });
  return insertTable("types", name, res);
});
app.delete(apiPath("/api/types/:id"), (req, res) => deleteTable("types", Number(req.params.id), res));

// Locations
app.get(apiPath("/api/locations"), (req, res) => listTable("locations", res));
app.post(apiPath("/api/locations"), (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name_required" });
  return insertTable("locations", name, res);
});
app.delete(apiPath("/api/locations/:id"), (req, res) => deleteTable("locations", Number(req.params.id), res));

// Sizes
app.get(apiPath("/api/sizes"), (req, res) => listTable("sizes", res));
app.post(apiPath("/api/sizes"), (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name_required" });
  return insertTable("sizes", name, res);
});
app.delete(apiPath("/api/sizes/:id"), (req, res) => deleteTable("sizes", Number(req.params.id), res));

// Items
app.get(apiPath("/api/items"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(`
      SELECT i.id, i.label, i.box_no, i.qty, i.created_at,
             i.type_id, t.name AS type_name,
             i.size_id, s.name AS size_name,
             i.location_id, l.name AS location_name
      FROM items i
      LEFT JOIN types t ON t.id = i.type_id
      LEFT JOIN sizes s ON s.id = i.size_id
      LEFT JOIN locations l ON l.id = i.location_id
      ORDER BY i.id DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  } finally { if (conn) conn.release(); }
});

app.post(apiPath("/api/items"), async (req, res) => {
  const label = String(req.body?.label ?? "").trim();
  if (!label) return res.status(400).json({ error: "label_required" });

  const type_id = req.body?.type_id == null || req.body.type_id === "" ? null : Number(req.body.type_id);
  const location_id = req.body?.location_id == null || req.body.location_id === "" ? null : Number(req.body.location_id);
  const size_id = req.body?.size_id == null || req.body.size_id === "" ? null : Number(req.body.size_id);
  const box_no = String(req.body?.box_no ?? "").trim() || null;
  const qty = req.body?.qty == null || req.body.qty === "" ? null : Number(req.body.qty);

  let conn;
  try {
    conn = await pool.getConnection();
    const r = await conn.query(
      `INSERT INTO items (label, type_id, box_no, qty, size_id, location_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [label, type_id, box_no, qty, size_id, location_id]
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

const PORT = 8101;

(async () => {
  await ensureSchema(pool);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Inventory Jeroen] listening on :${PORT}`);
    console.log(`[Inventory Jeroen] DB ${DB_HOST}:${DB_PORT} db=${DB_NAME} user=${DB_USER}`);
  });
})().catch((err) => {
  console.error("[Inventory Jeroen] startup error:", err);
  process.exit(1);
});

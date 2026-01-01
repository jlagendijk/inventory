const $ = (id) => document.getElementById(id);

function baseUrl() {
  return new URL(".", window.location.href);
}

async function api(path, options = {}) {
  const url = new URL(String(path).replace(/^\/+/, ""), baseUrl());

  const isFormData = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isFormData) headers["Content-Type"] = headers["Content-Type"] || "application/json";

  const res = await fetch(url.toString(), { ...options, headers });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${txt}`);
  }

  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

let types = [];
let locations = [];
let sizes = [];
let items = [];
let search = "";

// -------------------- Health --------------------
async function loadHealth() {
  const pill = $("healthPill");
  if (!pill) return;

  try {
    const h = await api("api/health");
    pill.textContent = `DB: ${h.db ? "OK" : "?"}`;
    pill.classList.toggle("ok", !!h.db);
  } catch {
    pill.textContent = "DB: ERROR";
    pill.classList.remove("ok");
  }
}

// -------------------- Lookups --------------------
async function loadLookups() {
  [types, locations, sizes] = await Promise.all([
    api("api/types"),
    api("api/locations"),
    api("api/sizes")
  ]);

  renderSelect($("typeSelect"), types, "(geen type)");
  renderSelect($("locationSelect"), locations, "(geen locatie)");
  renderSelect($("sizeSelect"), sizes, "(geen afmeting)");

  renderList("typesList", types, "api/types");
  renderList("locationsList", locations, "api/locations");
  renderList("sizesList", sizes, "api/sizes");
}

function renderSelect(sel, rows, emptyText) {
  if (!sel) return;

  sel.innerHTML = `<option value="">${emptyText}</option>`;
  for (const r of rows) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    sel.appendChild(opt);
  }
}

function renderList(rootId, rows, endpoint) {
  const root = $(rootId);
  if (!root) return;

  root.innerHTML = "";
  if (!rows.length) {
    root.innerHTML = `<div class="empty">Leeg</div>`;
    return;
  }

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `
      <div><b>${esc(r.name)}</b></div>
      <button class="danger" data-del="${r.id}">Verwijder</button>
    `;
    root.appendChild(row);
  }

  root.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      await api(`${endpoint}/${id}`, { method: "DELETE" });
      await loadLookups();
      await loadItems();
    });
  });
}

async function addLookup(endpoint, inputId) {
  const input = $(inputId);
  if (!input) return;

  const name = input.value.trim();
  if (!name) return;

  await api(endpoint, { method: "POST", body: JSON.stringify({ name }) });
  input.value = "";
  await loadLookups();
}

// -------------------- Items --------------------
async function loadItems() {
  items = await api("api/items");
  renderItems();
}

function renderItems() {
  const root = $("items");
  if (!root) return;

  root.innerHTML = "";

  const filtered = search
    ? items.filter((i) => {
        const s = `${i.label ?? ""} ${i.type_name ?? ""} ${i.box_no ?? ""} ${i.size_name ?? ""} ${i.location_name ?? ""}`.toLowerCase();
        return s.includes(search);
      })
    : items;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen items (of geen zoekresultaten).</div>`;
    return;
  }

  for (const it of filtered) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemMain">
        <div class="itemTitle">${esc(it.label ?? "")}</div>
        <div class="itemMeta">
          <span><b>Type:</b> ${esc(it.type_name ?? "-")}</span>
          <span><b>Doos/Krat:</b> ${esc(it.box_no ?? "-")}</span>
          <span><b>Aantal:</b> ${it.qty ?? "-"}</span>
          <span><b>Afmeting:</b> ${esc(it.size_name ?? "-")}</span>
          <span><b>Locatie:</b> ${esc(it.location_name ?? "-")}</span>
        </div>
      </div>
      <div class="itemActions">
        <button class="danger" data-del="${it.id}">Verwijder</button>
      </div>
    `;
    root.appendChild(div);
  }

  root.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      await api(`api/items/${id}`, { method: "DELETE" });
      await loadItems();
    });
  });
}

// -------------------- Init --------------------
document.addEventListener("DOMContentLoaded", async () => {
  await loadHealth();
  setInterval(loadHealth, 10000);

  const searchEl = $("search");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      search = searchEl.value.trim().toLowerCase();
      renderItems();
    });
  }

  $("addTypeBtn")?.addEventListener("click", () => addLookup("api/types", "newType"));
  $("addLocationBtn")?.addEventListener("click", () => addLookup("api/locations", "newLocation"));
  $("addSizeBtn")?.addEventListener("click", () => addLookup("api/sizes", "newSize"));

  const form = $("itemForm");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const label = $("label")?.value?.trim() ?? "";
      if (!label) return;

      const payload = {
        label,
        type_id: $("typeSelect")?.value || null,
        box_no: ($("box_no")?.value ?? "").trim() || null,
        qty: ($("qty")?.value ?? "").trim() === "" ? null : Number($("qty").value),
        size_id: $("sizeSelect")?.value || null,
        location_id: $("locationSelect")?.value || null
      };

      await api("api/items", { method: "POST", body: JSON.stringify(payload) });
      form.reset();
      await loadItems();
    });
  }

  $("resetBtn")?.addEventListener("click", () => $("itemForm")?.reset());

  await loadLookups();
  await loadItems();
});

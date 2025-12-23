/* inventory/web/app.js (DECOUPLED)
   - Module A: Artikelen + kassabonnen (purchase)
   - Module B: Dozen-inventaris (separate inventory)
   - Search filters BOTH lists (client-side)
   - Box dialog shows inventory_box_items (NOT articles)
*/

const $ = (id) => document.getElementById(id);

// -------------------------
// Ingress-safe API helper
// -------------------------
function getBase() {
  return new URL(".", window.location.href);
}

async function api(path, options = {}) {
  const base = getBase();
  const clean = String(path).replace(/^\/+/, "");
  const url = new URL(clean, base);

  const isFormData = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isFormData) headers["Content-Type"] = headers["Content-Type"] || "application/json";

  const res = await fetch(url.toString(), { ...options, headers });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${res.statusText}${text ? " - " + text : ""}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

// -------------------------
// State
// -------------------------
let items = [];               // purchase items
let invLocations = [];        // inventory locations
let invBoxes = [];            // inventory boxes

let activeItemId = null;      // for receipts dialog
let selectedInvBoxId = null;  // for inventory box dialog

let searchTerm = "";

// -------------------------
// Health
// -------------------------
async function loadHealth() {
  try {
    const h = await api("api/health");
    $("healthPill").textContent = `DB: ${h.db ? "OK" : "?"}`;
    $("healthPill").classList.toggle("ok", !!h.db);
  } catch {
    $("healthPill").textContent = "DB: ERROR";
    $("healthPill").classList.remove("ok");
  }
}

// =====================================================================
// MODULE A: Artikelen + Kassabonnen
// =====================================================================
async function loadItems() {
  items = await api("api/items");
  renderItems();
}

function renderItems() {
  const root = $("items");
  root.innerHTML = "";

  const filtered = searchTerm
    ? items.filter((it) => {
        const s = `${it.name} ${it.store ?? ""} ${it.article_no ?? ""} ${it.notes ?? ""}`.toLowerCase();
        return s.includes(searchTerm);
      })
    : items;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen artikelen (of geen zoekresultaten).</div>`;
    return;
  }

  for (const it of filtered) {
    const pd = it.purchase_date ? String(it.purchase_date).slice(0, 10) : "-";
    const wm = it.warranty_months ?? "-";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemMain">
        <div class="itemTitle">${escapeHtml(it.name)}</div>
        <div class="itemMeta">
          <span><b>Winkel:</b> ${escapeHtml(it.store ?? "-")}</span>
          <span><b>Garantie:</b> ${wm} mnd</span>
          <span><b>Artikel#:</b> ${escapeHtml(it.article_no ?? "-")}</span>
          <span><b>Aankoop:</b> ${pd}</span>
        </div>
        ${it.notes ? `<div class="itemNotes">${escapeHtml(it.notes)}</div>` : ""}
      </div>

      <div class="itemActions">
        <button class="secondary" data-receipts="${it.id}">Kassabonnen</button>
        <button class="danger" data-del="${it.id}">Verwijderen</button>
      </div>
    `;
    root.appendChild(div);
  }

  root.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del"));
      await api(`api/items/${id}`, { method: "DELETE" });
      await loadItems();
    });
  });

  root.querySelectorAll("[data-receipts]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      activeItemId = Number(btn.getAttribute("data-receipts"));
      $("receiptFile").value = "";
      await loadReceipts(activeItemId);
      $("receiptsDlg").showModal();
    });
  });
}

// Receipts
async function loadReceipts(itemId) {
  const list = await api(`api/items/${itemId}/receipts`);
  const root = $("receiptsList");
  root.innerHTML = "";

  if (!list.length) {
    root.innerHTML = `<div class="empty">Nog geen kassabonnen voor dit artikel.</div>`;
    return;
  }

  for (const r of list) {
    const row = document.createElement("div");
    row.className = "receiptRow";
    row.innerHTML = `
      <a class="receiptLink" href="${r.url}" target="_blank" rel="noreferrer">
        ${escapeHtml(r.original_name ?? r.filename)}
      </a>
      <button class="danger" data-receipt-del="${r.id}">Delete</button>
    `;
    root.appendChild(row);
  }

  root.querySelectorAll("[data-receipt-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-receipt-del"));
      await api(`api/receipts/${id}`, { method: "DELETE" });
      await loadReceipts(activeItemId);
    });
  });
}

async function uploadReceipt(itemId, file) {
  const base = getBase();
  const url = new URL(`api/items/${itemId}/receipts`, base);

  const form = new FormData();
  form.append("file", file);

  const res = await fetch(url.toString(), { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${res.statusText}${text ? " - " + text : ""}`);
  }
}

// =====================================================================
// MODULE B: Dozen-inventaris (LOS)
// =====================================================================
async function loadInvLocations() {
  invLocations = await api("api/inventory/locations");
  renderInvLocations();
  renderInvLocationSelect();
}

function renderInvLocations() {
  const root = $("locationsList");
  if (!root) return;

  root.innerHTML = "";

  const filtered = searchTerm
    ? invLocations.filter((l) => {
        const s = `${l.name} ${l.notes ?? ""}`.toLowerCase();
        return s.includes(searchTerm);
      })
    : invLocations;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen locaties (of geen zoekresultaten).</div>`;
    return;
  }

  for (const l of filtered) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `
      <div><b>${escapeHtml(l.name)}</b></div>
      <button class="danger" data-loc-del="${l.id}">Verwijder</button>
    `;
    root.appendChild(row);
  }

  root.querySelectorAll("[data-loc-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-loc-del"));
      await api(`api/inventory/locations/${id}`, { method: "DELETE" });
      await loadInvLocations();
      await loadInvBoxes();
    });
  });
}

function renderInvLocationSelect() {
  const sel = $("boxLocation");
  if (!sel) return;

  sel.innerHTML = `<option value="">(geen locatie)</option>`;
  for (const l of invLocations) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    sel.appendChild(opt);
  }
}

async function loadInvBoxes() {
  invBoxes = await api("api/inventory/boxes");
  renderInvBoxes();
}

function renderInvBoxes() {
  const root = $("boxesList");
  if (!root) return;

  root.innerHTML = "";

  const filtered = searchTerm
    ? invBoxes.filter((b) => {
        const s = `${b.code} ${b.label ?? ""} ${b.notes ?? ""} ${b.location_name ?? ""}`.toLowerCase();
        return s.includes(searchTerm);
      })
    : invBoxes;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen dozen (of geen zoekresultaten).</div>`;
    return;
  }

  for (const b of filtered) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `
      <button class="linkRow" type="button" data-box-open="${b.id}">
        <div>
          <div><b>${escapeHtml(b.code)}</b> ${b.label ? `— ${escapeHtml(b.label)}` : ""}</div>
          <div class="mutedSmall">
            Locatie: ${escapeHtml(b.location_name ?? "-")} • Items: ${b.item_count ?? 0}
          </div>
        </div>
      </button>
      <button class="danger" data-box-del="${b.id}">Verwijder</button>
    `;
    root.appendChild(row);
  }

  root.querySelectorAll("[data-box-open]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await openInvBox(btn.getAttribute("data-box-open"));
    });
  });

  root.querySelectorAll("[data-box-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-box-del"));
      await api(`api/inventory/boxes/${id}`, { method: "DELETE" });
      await loadInvBoxes();
    });
  });
}

// Inventory box dialog (shows inventory_box_items)
async function openInvBox(boxId) {
  selectedInvBoxId = Number(boxId);
  const box = invBoxes.find((b) => Number(b.id) === selectedInvBoxId);

  $("boxDlgTitle").textContent = box
    ? `Doos: ${box.code}${box.label ? " — " + box.label : ""}`
    : `Doos: ${selectedInvBoxId}`;

  $("boxDlgMeta").textContent = box
    ? `Locatie: ${box.location_name ?? "-"} • Items: ${box.item_count ?? 0}`
    : "";

  const content = await api(`api/inventory/boxes/${selectedInvBoxId}/items`);
  renderInvBoxItems(content);

  $("boxDlg").showModal();
}

function renderInvBoxItems(content) {
  const root = $("boxItemsList");
  root.innerHTML = "";

  // Add quick-add form at top
  const add = document.createElement("div");
  add.className = "subcard";
  add.innerHTML = `
    <div class="row">
      <input id="invItemName" placeholder="Wat zit er in deze doos? (bijv. kerstballen)" />
      <input id="invItemQty" type="number" min="0" step="1" placeholder="Aantal" style="max-width:120px" />
      <button id="invAddItemBtn" type="button">Toevoegen</button>
    </div>
    <div class="hint">Tip: gebruik zoek bovenaan om dozen snel terug te vinden.</div>
  `;
  root.appendChild(add);

  $("invAddItemBtn").addEventListener("click", async () => {
    const name = ($("invItemName").value ?? "").trim();
    if (!name) return;
    const qtyRaw = ($("invItemQty").value ?? "").trim();
    const qty = qtyRaw === "" ? null : Number(qtyRaw);

    await api(`api/inventory/boxes/${selectedInvBoxId}/items`, {
      method: "POST",
      body: JSON.stringify({ name, qty }),
    });

    $("invItemName").value = "";
    $("invItemQty").value = "";

    const refreshed = await api(`api/inventory/boxes/${selectedInvBoxId}/items`);
    renderInvBoxItems(refreshed);
    await loadInvBoxes(); // refresh counts in list
  });

  if (!content.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Deze doos heeft nog geen inhoudregels.";
    root.appendChild(empty);
    return;
  }

  for (const it of content) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemMain">
        <div class="itemTitle">${escapeHtml(it.name)}</div>
        <div class="itemMeta">
          <span><b>Aantal:</b> ${it.qty ?? "-"}</span>
        </div>
        ${it.notes ? `<div class="itemNotes">${escapeHtml(it.notes)}</div>` : ""}
      </div>
      <div class="itemActions">
        <button class="danger" data-inv-del="${it.id}">Verwijder</button>
      </div>
    `;
    root.appendChild(div);
  }

  root.querySelectorAll("[data-inv-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-inv-del"));
      await api(`api/inventory/box-items/${id}`, { method: "DELETE" });

      const refreshed = await api(`api/inventory/boxes/${selectedInvBoxId}/items`);
      renderInvBoxItems(refreshed);
      await loadInvBoxes();
    });
  });
}

// =====================================================================
// Search + Wire-up
// =====================================================================
function wireSearch() {
  const s = $("search");
  if (!s) return;

  s.addEventListener("input", () => {
    searchTerm = String(s.value ?? "").toLowerCase().trim();
    // Re-render both modules
    renderInvLocations();
    renderInvBoxes();
    renderItems();
  });
}

// Bulk controls are from old coupled UI; disable to prevent confusion
function disableBulkControls() {
  const sel = $("bulkBoxSelect");
  const moveBtn = $("bulkMoveBtn");
  const clearBtn = $("bulkClearBtn");
  if (sel) sel.disabled = true;
  if (moveBtn) moveBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;

  if (sel) sel.innerHTML = `<option>(losgekoppeld)</option>`;
}

// =====================================================================
// Bootstrap
// =====================================================================
document.addEventListener("DOMContentLoaded", async () => {
  await loadHealth();
  setInterval(loadHealth, 10000);

  wireSearch();
  disableBulkControls();

  // Load both modules
  await loadInvLocations();
  await loadInvBoxes();
  await loadItems();

  // Add location (inventory module)
  $("addLocBtn")?.addEventListener("click", async () => {
    const name = ($("locName")?.value ?? "").trim();
    if (!name) return;
    await api("api/inventory/locations", { method: "POST", body: JSON.stringify({ name }) });
    $("locName").value = "";
    await loadInvLocations();
    await loadInvBoxes();
  });

  // Add box (inventory module)
  $("addBoxBtn")?.addEventListener("click", async () => {
    const code = ($("boxCode")?.value ?? "").trim();
    if (!code) return;

    const payload = {
      code,
      label: ($("boxLabel")?.value ?? "").trim() || null,
      location_id: $("boxLocation")?.value ? Number($("boxLocation").value) : null,
    };

    await api("api/inventory/boxes", { method: "POST", body: JSON.stringify(payload) });

    $("boxCode").value = "";
    $("boxLabel").value = "";
    $("boxLocation").value = "";

    await loadInvBoxes();
  });

  // New item form (purchase module)
  $("itemForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: $("name").value,
      store: $("store").value || null,
      warranty_months: $("warranty_months").value || null,
      article_no: $("article_no").value || null,
      purchase_date: $("purchase_date").value || null,
      notes: $("notes").value || null,
    };
    await api("api/items", { method: "POST", body: JSON.stringify(payload) });
    e.target.reset();
    await loadItems();
  });

  $("resetBtn")?.addEventListener("click", () => $("itemForm")?.reset());

  // Receipt upload
  $("uploadReceiptBtn")?.addEventListener("click", async () => {
    if (!activeItemId) return;
    const f = $("receiptFile")?.files?.[0];
    if (!f) return;

    await uploadReceipt(activeItemId, f);
    $("receiptFile").value = "";
    await loadReceipts(activeItemId);
  });
});

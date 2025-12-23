/* inventory/web/app.js
   Full client for:
   - Items CRUD
   - Receipts upload + list + delete (per item)
   - Locations + Boxes (inventory)
   - Box dialog (see contents of a box)
   - Bulk select items → move to box
   - Search filter (items + boxes)
*/

const $ = (id) => document.getElementById(id);

// -------------------------
// Ingress-safe API helper
// -------------------------
function getBase() {
  // Keeps calls inside /api/hassio_ingress/<token>/ when running via Ingress
  return new URL(".", window.location.href);
}

async function api(path, options = {}) {
  const base = getBase();
  const clean = String(path).replace(/^\/+/, "");
  const url = new URL(clean, base);

  const res = await fetch(url.toString(), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

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
let items = [];
let locations = [];
let boxes = [];

let activeItemId = null;     // for receipts dialog
let selectedBoxId = null;    // for box dialog

const selectedItems = new Set(); // bulk selection
let searchTerm = "";             // search filter

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

// -------------------------
// Items
// -------------------------
async function loadItems() {
  items = await api("api/items");
  renderItems();
}

function renderItems() {
  const root = $("items");
  root.innerHTML = "";

  const filtered = searchTerm
    ? items.filter((it) => {
        const s = `${it.name} ${it.store ?? ""} ${it.article_no ?? ""} ${it.notes ?? ""} ${it.box_code ?? ""} ${it.box_label ?? ""}`.toLowerCase();
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
    const boxLine = it.box_code
      ? `${it.box_code}${it.box_label ? " — " + it.box_label : ""}`
      : "-";

    const checked = selectedItems.has(Number(it.id)) ? "checked" : "";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemMain">
        <div class="itemTitleRow">
          <label class="check">
            <input type="checkbox" data-sel="${it.id}" ${checked} />
            <span></span>
          </label>
          <div class="itemTitle">${escapeHtml(it.name)}</div>
        </div>

        <div class="itemMeta">
          <span><b>Winkel:</b> ${escapeHtml(it.store ?? "-")}</span>
          <span><b>Garantie:</b> ${wm} mnd</span>
          <span><b>Artikel#:</b> ${escapeHtml(it.article_no ?? "-")}</span>
          <span><b>Aankoop:</b> ${pd}</span>
          <span><b>Doos:</b> ${escapeHtml(boxLine)}</span>
        </div>

        ${it.notes ? `<div class="itemNotes">${escapeHtml(it.notes)}</div>` : ""}
      </div>

      <div class="itemActions">
        <select class="boxSelect" data-item="${it.id}">
          <option value="">(uit doos)</option>
          ${boxes.map((b) => {
            const selected = Number(it.box_id) === Number(b.id) ? "selected" : "";
            const label = `${b.code}${b.label ? " — " + b.label : ""}`;
            return `<option value="${b.id}" ${selected}>${escapeHtml(label)}</option>`;
          }).join("")}
        </select>

        <button class="secondary" data-receipts="${it.id}">Kassabonnen</button>
        <button class="danger" data-del="${it.id}">Verwijderen</button>
      </div>
    `;
    root.appendChild(div);
  }

  // Selection checkboxes
  root.querySelectorAll("[data-sel]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = Number(cb.getAttribute("data-sel"));
      if (cb.checked) selectedItems.add(id);
      else selectedItems.delete(id);
    });
  });

  // Per-item move to box
  root.querySelectorAll(".boxSelect").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const itemId = Number(sel.getAttribute("data-item"));
      const val = sel.value;
      const box_id = val === "" ? null : Number(val);
      await api(`api/items/${itemId}/move`, {
        method: "POST",
        body: JSON.stringify({ box_id }),
      });
      await loadBoxes();  // updates counts
      renderBulkBoxSelect();
      await loadItems();  // refresh items list (box labels)
    });
  });

  // Delete item
  root.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del"));
      await api(`api/items/${id}`, { method: "DELETE" });
      selectedItems.delete(id);
      await loadBoxes();
      renderBulkBoxSelect();
      await loadItems();
    });
  });

  // Receipts dialog
  root.querySelectorAll("[data-receipts]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      activeItemId = Number(btn.getAttribute("data-receipts"));
      $("receiptFile").value = "";
      await loadReceipts(activeItemId);
      $("receiptsDlg").showModal();
    });
  });
}

// -------------------------
// Receipts
// -------------------------
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

// -------------------------
// Locations
// -------------------------
async function loadLocations() {
  locations = await api("api/locations");
  renderLocations();
  renderLocationSelect();
}

function renderLocations() {
  const root = $("locationsList");
  if (!root) return;

  root.innerHTML = "";
  const filtered = searchTerm
    ? locations.filter((l) => {
        const s = `${l.name} ${l.notes ?? ""}`.toLowerCase();
        return s.includes(searchTerm);
      })
    : locations;

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
      await api(`api/locations/${btn.getAttribute("data-loc-del")}`, { method: "DELETE" });
      await loadLocations();
      await loadBoxes();
      renderBulkBoxSelect();
      renderItems();
    });
  });
}

function renderLocationSelect() {
  const sel = $("boxLocation");
  if (!sel) return;

  sel.innerHTML = `<option value="">(geen locatie)</option>`;
  for (const l of locations) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    sel.appendChild(opt);
  }
}

// -------------------------
// Boxes
// -------------------------
async function loadBoxes() {
  boxes = await api("api/boxes");
  renderBoxes();
}

function renderBoxes() {
  const root = $("boxesList");
  if (!root) return;

  root.innerHTML = "";

  const filtered = searchTerm
    ? boxes.filter((b) => {
        const s = `${b.code} ${b.label ?? ""} ${b.notes ?? ""} ${b.location_name ?? ""}`.toLowerCase();
        return s.includes(searchTerm);
      })
    : boxes;

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
      await openBox(btn.getAttribute("data-box-open"));
    });
  });

  root.querySelectorAll("[data-box-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`api/boxes/${btn.getAttribute("data-box-del")}`, { method: "DELETE" });
      await loadBoxes();
      renderBulkBoxSelect();
      await loadItems();
    });
  });
}

function renderBulkBoxSelect() {
  const sel = $("bulkBoxSelect");
  if (!sel) return;

  sel.innerHTML = `<option value="">(kies doos)</option>`;
  for (const b of boxes) {
    const label = `${b.code}${b.label ? " — " + b.label : ""}`;
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

// -------------------------
// Box dialog (contents)
// -------------------------
async function openBox(boxId) {
  selectedBoxId = Number(boxId);
  const box = boxes.find((b) => Number(b.id) === selectedBoxId);

  $("boxDlgTitle").textContent = box
    ? `Doos: ${box.code}${box.label ? " — " + box.label : ""}`
    : `Doos: ${selectedBoxId}`;

  $("boxDlgMeta").textContent = box
    ? `Locatie: ${box.location_name ?? "-"} • Items: ${box.item_count ?? 0}`
    : "";

  const itemsInBox = await api(`api/boxes/${selectedBoxId}/items`);
  renderBoxItems(itemsInBox);

  $("boxDlg").showModal();
}

function renderBoxItems(itemsInBox) {
  const root = $("boxItemsList");
  root.innerHTML = "";

  if (!itemsInBox.length) {
    root.innerHTML = `<div class="empty">Deze doos is leeg.</div>`;
    return;
  }

  for (const it of itemsInBox) {
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
        <button class="secondary" data-unbox="${it.id}">Uit doos</button>
      </div>
    `;
    root.appendChild(div);
  }

  // Unbox item
  root.querySelectorAll("[data-unbox]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = Number(btn.getAttribute("data-unbox"));
      await api(`api/items/${itemId}/move`, {
        method: "POST",
        body: JSON.stringify({ box_id: null }),
      });
      await loadBoxes();
      renderBulkBoxSelect();
      await openBox(selectedBoxId); // refresh dialog
      await loadItems();            // refresh main list
    });
  });

  // Receipts from dialog
  root.querySelectorAll("[data-receipts]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      activeItemId = Number(btn.getAttribute("data-receipts"));
      $("receiptFile").value = "";
      await loadReceipts(activeItemId);
      $("receiptsDlg").showModal();
    });
  });
}

// -------------------------
// Search
// -------------------------
function wireSearch() {
  const s = $("search");
  if (!s) return;

  s.addEventListener("input", () => {
    searchTerm = String(s.value ?? "").toLowerCase().trim();
    // Re-render with filters applied
    renderLocations();
    renderBoxes();
    renderItems();
  });
}

// -------------------------
// Bulk move
// -------------------------
function wireBulkControls() {
  const moveBtn = $("bulkMoveBtn");
  const clearBtn = $("bulkClearBtn");
  const sel = $("bulkBoxSelect");

  if (moveBtn && sel) {
    moveBtn.addEventListener("click", async () => {
      const boxId = sel.value ? Number(sel.value) : null;
      if (!boxId) return;

      const ids = Array.from(selectedItems);
      if (!ids.length) return;

      // Move sequentially (stable, avoids hammering API)
      for (const id of ids) {
        await api(`api/items/${id}/move`, {
          method: "POST",
          body: JSON.stringify({ box_id: boxId }),
        });
      }

      selectedItems.clear();
      await loadBoxes();
      renderBulkBoxSelect();
      await loadItems();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      selectedItems.clear();
      await loadItems();
    });
  }
}

// -------------------------
// Bootstrap
// -------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // Health + periodic check
  await loadHealth();
  setInterval(loadHealth, 10000);

  // Inventory (locs/boxes) first, because items render uses boxes
  await loadLocations();
  await loadBoxes();
  renderBulkBoxSelect();
  await loadItems();

  // Search + bulk
  wireSearch();
  wireBulkControls();

  // Add location
  const addLocBtn = $("addLocBtn");
  if (addLocBtn) {
    addLocBtn.addEventListener("click", async () => {
      const name = ($("locName")?.value ?? "").trim();
      if (!name) return;
      await api("api/locations", { method: "POST", body: JSON.stringify({ name }) });
      $("locName").value = "";
      await loadLocations();
    });
  }

  // Add box
  const addBoxBtn = $("addBoxBtn");
  if (addBoxBtn) {
    addBoxBtn.addEventListener("click", async () => {
      const code = ($("boxCode")?.value ?? "").trim();
      if (!code) return;

      const payload = {
        code,
        label: ($("boxLabel")?.value ?? "").trim() || null,
        location_id: $("boxLocation")?.value ? Number($("boxLocation").value) : null,
      };

      await api("api/boxes", { method: "POST", body: JSON.stringify(payload) });

      $("boxCode").value = "";
      $("boxLabel").value = "";
      $("boxLocation").value = "";

      await loadBoxes();
      renderBulkBoxSelect();
      renderItems();
    });
  }

  // New item form
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

  // Reset item form
  $("resetBtn")?.addEventListener("click", () => $("itemForm")?.reset());

  // Upload receipt button
  $("uploadReceiptBtn")?.addEventListener("click", async () => {
    if (!activeItemId) return;
    const f = $("receiptFile")?.files?.[0];
    if (!f) return;

    await uploadReceipt(activeItemId, f);
    $("receiptFile").value = "";
    await loadReceipts(activeItemId);
  });
});

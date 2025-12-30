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
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}

let locations = [];
let boxes = [];
let search = "";
let activeBoxId = null;

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

async function loadLocations() {
  locations = await api("api/locations");
  renderLocations();
  renderLocationSelect();
}

function renderLocationSelect() {
  const sel = $("boxLocation");
  sel.innerHTML = `<option value="">(geen locatie)</option>`;
  for (const l of locations) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    sel.appendChild(opt);
  }
}

function renderLocations() {
  const root = $("locationsList");
  root.innerHTML = "";
  const filtered = search
    ? locations.filter(l => (`${l.name}`).toLowerCase().includes(search))
    : locations;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen locaties.</div>`;
    return;
  }

  for (const l of filtered) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `<div><b>${esc(l.name)}</b></div><button class="danger" data-del="${l.id}">Verwijder</button>`;
    root.appendChild(row);
  }

  root.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api(`api/locations/${btn.getAttribute("data-del")}`, { method: "DELETE" });
      await loadLocations();
      await loadBoxes();
    });
  });
}

async function loadBoxes() {
  boxes = await api("api/boxes");
  renderBoxes();
}

function renderBoxes() {
  const root = $("boxesList");
  root.innerHTML = "";

  const filtered = search
    ? boxes.filter(b => (`${b.label} ${b.location_name ?? ""}`).toLowerCase().includes(search))
    : boxes;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen dozen.</div>`;
    return;
  }

  for (const b of filtered) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `
      <button class="linkRow" type="button" data-open="${b.id}">
        <div>
          <div><b>${esc(b.label)}</b></div>
          <div class="mutedSmall">Locatie: ${esc(b.location_name ?? "-")} • Inhoudregels: ${b.item_count ?? 0}</div>
        </div>
      </button>
      <button class="danger" data-del="${b.id}">Verwijder</button>
    `;
    root.appendChild(row);
  }

  root.querySelectorAll("[data-open]").forEach(btn => {
    btn.addEventListener("click", () => openBox(Number(btn.getAttribute("data-open"))));
  });

  root.querySelectorAll("button.danger[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api(`api/boxes/${btn.getAttribute("data-del")}`, { method: "DELETE" });
      await loadBoxes();
    });
  });
}

async function openBox(boxId) {
  activeBoxId = boxId;
  const box = boxes.find(b => Number(b.id) === boxId);
  $("boxDlgTitle").textContent = box ? `Doos: ${box.label}` : "Doos";
  $("boxDlgMeta").textContent = box ? `Locatie: ${box.location_name ?? "-"}` : "";

  $("boxItemName").value = "";
  $("boxItemQty").value = "";

  const items = await api(`api/boxes/${boxId}/items`);
  renderBoxItems(items);
  $("boxDlg").showModal();
}

function renderBoxItems(items) {
  const root = $("boxItemsList");
  root.innerHTML = "";

  const filtered = search
    ? items.filter(i => (`${i.name}`).toLowerCase().includes(search))
    : items;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen inhoud in deze doos.</div>`;
    return;
  }

  for (const it of filtered) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemMain">
        <div class="itemTitle">${esc(it.name)}</div>
        <div class="itemMeta"><span><b>Aantal:</b> ${it.qty ?? "-"}</span></div>
      </div>
      <div class="itemActions">
        <button class="danger" data-del="${it.id}">Verwijder</button>
      </div>
    `;
    root.appendChild(div);
  }

  root.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api(`api/box-items/${btn.getAttribute("data-del")}`, { method: "DELETE" });
      const items2 = await api(`api/boxes/${activeBoxId}/items`);
      renderBoxItems(items2);
      await loadBoxes();
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadHealth();
  setInterval(loadHealth, 10000);

  $("search").addEventListener("input", async () => {
    search = $("search").value.trim().toLowerCase();
    renderLocations();
    renderBoxes();
    if (activeBoxId) {
      const items = await api(`api/boxes/${activeBoxId}/items`);
      renderBoxItems(items);
    }
  });

  $("addLocBtn").addEventListener("click", async () => {
    const name = $("locName").value.trim();
    if (!name) return;
    await api("api/locations", { method: "POST", body: JSON.stringify({ name }) });
    $("locName").value = "";
    await loadLocations();
  });

  $("addBoxBtn").addEventListener("click", async () => {
    const label = $("boxLabel").value.trim();
    if (!label) return;
    const location_id = $("boxLocation").value ? Number($("boxLocation").value) : null;
    await api("api/boxes", { method: "POST", body: JSON.stringify({ label, location_id }) });
    $("boxLabel").value = "";
    $("boxLocation").value = "";
    await loadBoxes();
  });

  $("addBoxItemBtn").addEventListener("click", async () => {
    if (!activeBoxId) return;
    const name = $("boxItemName").value.trim();
    if (!name) return;
    const qty = $("boxItemQty").value.trim() === "" ? null : Number($("boxItemQty").value);
    await api(`api/boxes/${activeBoxId}/items`, { method: "POST", body: JSON.stringify({ name, qty }) });
    $("boxItemName").value = "";
    $("boxItemQty").value = "";
    const items = await api(`api/boxes/${activeBoxId}/items`);
    renderBoxItems(items);
    await loadBoxes();
  });

  await loadLocations();
  await loadBoxes();
});

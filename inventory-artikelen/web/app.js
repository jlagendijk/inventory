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

let items = [];
let search = "";
let activeItemId = null;

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

async function loadItems() {
  items = await api("api/items");
  renderItems();
}

function renderItems() {
  const root = $("items");
  root.innerHTML = "";

  const filtered = search
    ? items.filter(i => (`${i.label} ${i.store ?? ""} ${i.description ?? ""}`).toLowerCase().includes(search))
    : items;

  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Nog geen artikelen (of geen zoekresultaten).</div>`;
    return;
  }

  for (const it of filtered) {
    const pd = it.purchase_date ? String(it.purchase_date).slice(0, 10) : "-";
    const qty = it.qty ?? "-";
    const wm = it.warranty_months ?? "-";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemMain">
        <div class="itemTitle">${esc(it.label)}</div>
        <div class="itemMeta">
          <span><b>Aantal:</b> ${qty}</span>
          <span><b>Winkel:</b> ${esc(it.store ?? "-")}</span>
          <span><b>Datum:</b> ${pd}</span>
          <span><b>Garantie:</b> ${wm} mnd</span>
        </div>
        ${it.description ? `<div class="itemNotes">${esc(it.description)}</div>` : ""}
      </div>
      <div class="itemActions">
        <button class="secondary" data-receipts="${it.id}">Bonnen</button>
        <button class="danger" data-del="${it.id}">Verwijder</button>
      </div>
    `;
    root.appendChild(div);
  }

  root.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api(`api/items/${btn.getAttribute("data-del")}`, { method: "DELETE" });
      await loadItems();
    });
  });

  root.querySelectorAll("[data-receipts]").forEach(btn => {
    btn.addEventListener("click", async () => {
      activeItemId = Number(btn.getAttribute("data-receipts"));
      $("receiptFile").value = "";
      await loadReceipts(activeItemId);
      $("receiptsDlg").showModal();
    });
  });
}

async function loadReceipts(itemId) {
  const list = await api(`api/items/${itemId}/receipts`);
  const root = $("receiptsList");
  root.innerHTML = "";

  if (!list.length) {
    root.innerHTML = `<div class="empty">Nog geen bonnen.</div>`;
    return;
  }

  for (const r of list) {
    const row = document.createElement("div");
    row.className = "receiptRow";
    row.innerHTML = `
      <a class="receiptLink" href="${r.url}" target="_blank" rel="noreferrer">
        ${esc(r.original_name ?? r.filename)}
      </a>
      <button class="danger" data-rdel="${r.id}">Delete</button>
    `;
    root.appendChild(row);
  }

  root.querySelectorAll("[data-rdel]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await api(`api/receipts/${btn.getAttribute("data-rdel")}`, { method: "DELETE" });
      await loadReceipts(activeItemId);
    });
  });
}

async function uploadReceipt(itemId, file) {
  const url = new URL(`api/items/${itemId}/receipts`, baseUrl());
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(url.toString(), { method: "POST", body: form });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadHealth();
  setInterval(loadHealth, 10000);

  $("search").addEventListener("input", () => {
    search = $("search").value.trim().toLowerCase();
    renderItems();
  });

  $("itemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      label: $("label").value.trim(),
      qty: $("qty").value.trim() === "" ? null : Number($("qty").value),
      store: $("store").value.trim() || null,
      purchase_date: $("purchase_date").value || null,
      warranty_months: $("warranty_months").value.trim() === "" ? null : Number($("warranty_months").value),
      description: $("description").value.trim() || null,
    };
    await api("api/items", { method: "POST", body: JSON.stringify(payload) });
    e.target.reset();
    await loadItems();
  });

  $("resetBtn").addEventListener("click", () => $("itemForm").reset());

  $("uploadReceiptBtn").addEventListener("click", async () => {
    if (!activeItemId) return;
    const f = $("receiptFile").files?.[0];
    if (!f) return;
    await uploadReceipt(activeItemId, f);
    $("receiptFile").value = "";
    await loadReceipts(activeItemId);
  });

  await loadItems();
});

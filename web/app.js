const $ = (id) => document.getElementById(id);

function getBase() {
  // Ingress-safe base (blijft binnen /api/hassio_ingress/<token>/)
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
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${res.statusText}${text ? " - " + text : ""}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

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

let items = [];
let activeItemId = null;

function renderItems() {
  const root = $("items");
  root.innerHTML = "";

  if (!items.length) {
    root.innerHTML = `<div class="empty">Nog geen artikelen.</div>`;
    return;
  }

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "item";

    const pd = it.purchase_date ? String(it.purchase_date).slice(0, 10) : "-";
    const wm = it.warranty_months ?? "-";

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

  root.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del"));
      await api(`api/items/${id}`, { method: "DELETE" });
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

async function loadItems() {
  items = await api("api/items");
  renderItems();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
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

  root.querySelectorAll("[data-receipt-del]").forEach(btn => {
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

document.addEventListener("DOMContentLoaded", async () => {
  await loadHealth();
  await loadItems();

  $("itemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: $("name").value,
      store: $("store").value || null,
      warranty_months: $("warranty_months").value || null,
      article_no: $("article_no").value || null,
      purchase_date: $("purchase_date").value || null,
      notes: $("notes").value || null
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

  // health poll
  setInterval(loadHealth, 10000);
});

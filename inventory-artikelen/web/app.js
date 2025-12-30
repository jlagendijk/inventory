const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    throw new Error(`${res.status}: ${res.statusText}${detail ? " - " + detail : ""}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(d) {
  if (!d) return "";
  return String(d).slice(0, 10);
}

let items = [];
let currentAttachItemId = null;
let currentAttachItemName = "";

async function loadHealth() {
  try {
    const h = await api("./api/health");
    $("healthPill").textContent = `DB: ${h.db ? "OK" : "?"}`;
    $("healthPill").classList.toggle("ok", !!h.db);
  } catch {
    $("healthPill").textContent = "DB: ERROR";
    $("healthPill").classList.remove("ok");
  }
}

async function loadItems() {
  items = await api("./api/items");
  renderItems();
}

function renderItems() {
  const el = $("items");
  if (!items.length) {
    el.innerHTML = `<div class="empty">Nog geen artikelen.</div>`;
    return;
  }

  el.innerHTML = items.map((it) => {
    const meta = [
      it.quantity != null ? `Aantal: ${esc(it.quantity)}` : null,
      it.store ? `Winkel: ${esc(it.store)}` : null,
      it.purchase_date ? `Datum: ${esc(fmtDate(it.purchase_date))}` : null,
      it.warranty_months != null ? `Garantie: ${esc(it.warranty_months)} mnd` : null,
      it.article_no ? `Art.nr: ${esc(it.article_no)}` : null
    ].filter(Boolean).join(" · ");

    const link = it.link_url
      ? `<div class="mutedSmall"><a class="receiptLink" href="${esc(it.link_url)}" target="_blank" rel="noopener">Open link</a></div>`
      : "";

    const notes = it.notes ? `<div class="itemNotes">${esc(it.notes)}</div>` : "";

    return `
      <div class="item">
        <div>
          <div class="itemTitle">${esc(it.name)}</div>
          ${it.description ? `<div class="mutedSmall">${esc(it.description)}</div>` : ""}
          <div class="itemMeta">${esc(meta)}</div>
          ${link}
          ${notes}
        </div>

        <div class="itemActions">
          <button class="secondary" data-attach="${it.id}" data-name="${esc(it.name)}">Bijlagen</button>
          <button class="danger" data-del="${it.id}">Verwijder</button>
        </div>
      </div>
    `;
  }).join("");

  el.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del"));
      if (!confirm("Artikel verwijderen? (Bijlagen worden ook verwijderd)")) return;
      await api(`./api/items/${id}`, { method: "DELETE" });
      await loadItems();
    });
  });

  el.querySelectorAll("[data-attach]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-attach"));
      const name = btn.getAttribute("data-name") || "";
      openAttachments(id, name);
    });
  });
}

async function openAttachments(itemId, itemName) {
  currentAttachItemId = itemId;
  currentAttachItemName = itemName;

  $("attachDlgTitle").textContent = `Bijlagen - ${itemName}`;
  $("attachFile").value = "";
  $("attachKind").value = "receipt";

  await loadAttachments();
  $("attachDlg").showModal();
}

async function loadAttachments() {
  const rows = await api(`./api/items/${currentAttachItemId}/attachments`);
  const el = $("attachList");

  if (!rows.length) {
    el.innerHTML = `<div class="empty">Nog geen bijlagen.</div>`;
    return;
  }

  el.innerHTML = rows.map(a => {
    const kindLabel = a.kind === "manual" ? "Gebruiksaanwijzing" : "Bon";
    const name = a.original_name || a.filename;
    return `
      <div class="receiptRow">
        <div>
          <div class="itemTitle">${esc(kindLabel)}: ${esc(name)}</div>
          <div class="mutedSmall">${esc(fmtDate(a.created_at))}</div>
        </div>
        <div class="itemActions">
          <a class="receiptLink" href="${esc(a.url)}" target="_blank" rel="noopener">Open</a>
          <button class="danger" data-del-attach="${a.id}">Verwijder</button>
        </div>
      </div>
    `;
  }).join("");

  el.querySelectorAll("[data-del-attach]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-del-attach"));
      if (!confirm("Bijlage verwijderen?")) return;
      await api(`./api/attachments/${id}`, { method: "DELETE" });
      await loadAttachments();
    });
  });
}

async function uploadAttachment() {
  if (!currentAttachItemId) return;

  const file = $("attachFile").files?.[0];
  const kind = $("attachKind").value;

  if (!file) {
    alert("Kies eerst een bestand.");
    return;
  }

  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);

  await fetch(`./api/items/${currentAttachItemId}/attachments`, {
    method: "POST",
    body: fd
  }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text());
  });

  $("attachFile").value = "";
  await loadAttachments();
}

function resetForm() {
  $("name").value = "";
  $("description").value = "";
  $("quantity").value = "";
  $("store").value = "";
  $("purchase_date").value = "";
  $("warranty_months").value = "";
  $("article_no").value = "";
  $("link_url").value = "";
  $("notes").value = "";
}

async function onSubmit(e) {
  e.preventDefault();

  const body = {
    name: $("name").value.trim(),
    description: $("description").value.trim() || null,
    quantity: $("quantity").value === "" ? null : Number($("quantity").value),
    store: $("store").value.trim() || null,
    purchase_date: $("purchase_date").value || null,
    warranty_months: $("warranty_months").value === "" ? null : Number($("warranty_months").value),
    article_no: $("article_no").value.trim() || null,
    link_url: $("link_url").value.trim() || null,
    notes: $("notes").value.trim() || null
  };

  await api("./api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  resetForm();
  await loadItems();
}

document.addEventListener("DOMContentLoaded", async () => {
  $("itemForm").addEventListener("submit", onSubmit);
  $("resetBtn").addEventListener("click", resetForm);
  $("uploadAttachBtn").addEventListener("click", uploadAttachment);

  await loadHealth();
  await loadItems();
});

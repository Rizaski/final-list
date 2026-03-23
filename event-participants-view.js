import { firebaseInitPromise } from "./firebase.js";

function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

function escapeHtml(s) {
  if (s == null) return "";
  const t = document.createElement("div");
  t.textContent = s;
  return t.innerHTML;
}

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

let rows = [];
let api = null;
let token = "";

function renderRows() {
  const tbody = document.getElementById("eventShareTbody");
  const empty = document.getElementById("eventShareEmpty");
  const q = normalize(document.getElementById("eventShareSearch")?.value || "");
  if (!tbody) return;
  const list = rows
    .filter((r) => {
      if (!q) return true;
      return [r.name, r.nationalId, r.phone, r.address, r.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    })
    .sort((a, b) => normalize(a.name).localeCompare(normalize(b.name), "en"));

  tbody.innerHTML = "";
  if (!list.length) {
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";

  list.forEach((row) => {
    const id = String(row.id || "");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="input" data-row-field="name" data-row-id="${escapeHtml(id)}" value="${escapeHtml(row.name || "")}" placeholder="Full name"></td>
      <td><input class="input" data-row-field="nationalId" data-row-id="${escapeHtml(id)}" value="${escapeHtml(row.nationalId || "")}" placeholder="ID number"></td>
      <td><input class="input" data-row-field="phone" data-row-id="${escapeHtml(id)}" value="${escapeHtml(row.phone || "")}" placeholder="Phone"></td>
      <td><input class="input" data-row-field="address" data-row-id="${escapeHtml(id)}" value="${escapeHtml(row.address || "")}" placeholder="Address"></td>
      <td><input class="input" data-row-field="notes" data-row-id="${escapeHtml(id)}" value="${escapeHtml(row.notes || "")}" placeholder="Notes"></td>
      <td style="text-align:right;"><button type="button" class="ghost-button ghost-button--small" data-delete-row="${escapeHtml(id)}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("input[data-row-id]").forEach((input) => {
    input.addEventListener("change", async () => {
      const rowId = input.getAttribute("data-row-id");
      const field = input.getAttribute("data-row-field");
      const row = rows.find((r) => String(r.id) === String(rowId));
      if (!row || !api?.setEventParticipantRowFs) return;
      row[field] = input.value || "";
      await api.setEventParticipantRowFs(token, rowId, {
        ...row,
        name: row.name || "",
        nationalId: row.nationalId || "",
        phone: row.phone || "",
        address: row.address || "",
        notes: row.notes || "",
      });
    });
  });
  tbody.querySelectorAll("[data-delete-row]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rowId = btn.getAttribute("data-delete-row");
      if (!rowId) return;
      rows = rows.filter((r) => String(r.id) !== String(rowId));
      renderRows();
      if (api?.deleteEventParticipantRowFs) await api.deleteEventParticipantRowFs(token, rowId);
    });
  });
}

async function refreshFromServer() {
  if (!api?.getEventParticipantRowsFromServerFs) return;
  rows = await api.getEventParticipantRowsFromServerFs(token);
  if (!Array.isArray(rows)) rows = [];
  renderRows();
}

async function addRow() {
  if (!api?.setEventParticipantRowFs) return;
  const rowId = "p-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
  const row = {
    id: rowId,
    sourceVoterId: "",
    sequence: "",
    photoUrl: "",
    name: "",
    nationalId: "",
    phone: "",
    address: "",
    currentLocation: "",
    ballotBox: "",
    island: "",
    pledgeStatus: "undecided",
    supportStatus: "unknown",
    votedAt: "",
    notes: "",
  };
  rows.push(row);
  renderRows();
  await api.setEventParticipantRowFs(token, rowId, row);
}

async function init() {
  token = getTokenFromUrl();
  if (!token) {
    document.getElementById("eventShareTitle").textContent = "Invalid link";
    document.getElementById("eventShareSubtitle").textContent = "Missing token.";
    return;
  }
  api = await firebaseInitPromise;
  if (!api?.ready || !api.getEventParticipantShareByTokenFs || !api.getEventParticipantRowsFs) {
    document.getElementById("eventShareTitle").textContent = "Error";
    document.getElementById("eventShareSubtitle").textContent = "Could not load participant list.";
    return;
  }

  const share = await api.getEventParticipantShareByTokenFs(token);
  if (!share) {
    document.getElementById("eventShareTitle").textContent = "Invalid or expired link";
    document.getElementById("eventShareSubtitle").textContent = "This participants share link is not available.";
    return;
  }

  document.getElementById("eventShareTitle").textContent = share.eventName || "Event participants";
  document.getElementById("eventShareSubtitle").textContent =
    "Shared participant list. You can add and edit rows. Use Refresh to force latest server data.";

  rows = await api.getEventParticipantRowsFs(token);
  if (!Array.isArray(rows)) rows = [];
  renderRows();

  document.getElementById("eventShareSearch")?.addEventListener("input", renderRows);
  document.getElementById("eventShareRefreshBtn")?.addEventListener("click", refreshFromServer);
  document.getElementById("eventShareAddBtn")?.addEventListener("click", addRow);

  if (api.onEventParticipantRowsSnapshotFs) {
    api.onEventParticipantRowsSnapshotFs(token, (items) => {
      rows = Array.isArray(items) ? items : [];
      renderRows();
    });
  }
}

init();

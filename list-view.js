/**
 * List view for candidate: open shared link (?token=xxx), see only assigned voters, set status (In Progress, Need Assistance, Completed). Real-time sync.
 */
import { firebaseInitPromise } from "./firebase.js";
import { getListStatusLabel, getListStatusValues } from "./lists.js";
import { initTableViewMenus } from "./table-view-menu.js";

const STATUS_OPTIONS = ["", ...getListStatusValues()];

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

let share = null;
let statusMap = {}; // voterId -> { status, updatedAt }

function renderTable() {
  const tbody = document.getElementById("listViewTbody");
  const emptyEl = document.getElementById("listViewEmpty");
  if (!tbody) return;

  const voters = share?.voters || [];
  if (voters.length === 0) {
    tbody.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  tbody.innerHTML = "";
  voters.forEach((v) => {
    const tr = document.createElement("tr");
    const current = statusMap[v.id];
    const currentStatus = (current && current.status) || "";
    tr.innerHTML = `
      <td class="data-table-col--name">${escapeHtml(v.fullName || v.id)}</td>
      <td>${escapeHtml(v.nationalId ?? "")}</td>
      <td>${escapeHtml(v.permanentAddress ?? "")}</td>
      <td><select class="status-select" data-voter-id="${escapeHtml(v.id)}" data-status>
        ${STATUS_OPTIONS.map((s) => `<option value="${escapeHtml(s)}" ${s === currentStatus ? "selected" : ""}>${escapeHtml(getListStatusLabel(s) || "—")}</option>`).join("")}
      </select></td>
    `;
    const select = tr.querySelector("[data-status]");
    if (select) {
      select.addEventListener("change", () => {
        const newStatus = select.value || "";
        setStatus(v.id, newStatus);
      });
    }
    tbody.appendChild(tr);
  });
}

async function setStatus(voterId, status) {
  const token = getTokenFromUrl();
  if (!token) return;
  const api = await firebaseInitPromise;
  if (!api.ready || !api.setListShareStatusFs) return;
  await api.setListShareStatusFs(token, voterId, status);
  statusMap[voterId] = { status, updatedAt: new Date().toISOString() };
  renderTable();
}

async function init() {
  const token = getTokenFromUrl();
  if (!token) {
    document.getElementById("listViewTitle").textContent = "Invalid link";
    document.getElementById("listViewSubtitle").textContent = "This list link is missing or invalid.";
    return;
  }

  const api = await firebaseInitPromise;
  if (!api.ready || !api.getListShareByToken) {
    document.getElementById("listViewTitle").textContent = "Error";
    document.getElementById("listViewSubtitle").textContent = "Could not load list.";
    return;
  }

  share = await api.getListShareByToken(token);
  if (!share) {
    document.getElementById("listViewTitle").textContent = "Invalid or expired link";
    document.getElementById("listViewSubtitle").textContent = "This list may have been removed or the link has expired.";
    return;
  }

  document.getElementById("listViewTitle").textContent = share.name || "Assigned list";
  document.getElementById("listViewSubtitle").textContent = "Mark status for each voter. Changes sync in real time.";

  const statusList = await api.getListShareStatusFs?.(token) || [];
  statusMap = {};
  (statusList || []).forEach((item) => {
    statusMap[item.voterId] = { status: item.status || "", updatedAt: item.updatedAt };
  });

  if (api.onListShareStatusSnapshotFs) {
    api.onListShareStatusSnapshotFs(token, (items) => {
      statusMap = {};
      (items || []).forEach((item) => {
        statusMap[item.voterId] = { status: item.status || "", updatedAt: item.updatedAt };
      });
      renderTable();
    });
  }

  renderTable();
  initTableViewMenus();
}

init();

/**
 * Pledged report view: open shared link (?token=xxx), see only pledged voters for a candidate (read-only).
 */
import { firebaseInitPromise } from "./firebase.js";
import { initTableViewMenus } from "./table-view-menu.js";

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

function renderTable() {
  const tbody = document.getElementById("pledgedViewTbody");
  const emptyEl = document.getElementById("pledgedViewEmpty");
  if (!tbody) return;

  const voters = share?.voters || [];
  if (voters.length === 0) {
    tbody.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  const sorted = [...voters].sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
  tbody.innerHTML = "";
  sorted.forEach((v) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="data-table-col--seq">${escapeHtml(v.sequence ?? "")}</td>
      <td>${escapeHtml(v.nationalId ?? "")}</td>
      <td class="data-table-col--name">${escapeHtml(v.fullName ?? v.id ?? "—")}</td>
      <td>${escapeHtml(v.permanentAddress ?? "")}</td>
      <td>${escapeHtml((v.ballotBox || "").trim() || "—")}</td>
      <td>${escapeHtml(v.assignedAgent ?? "")}</td>
      <td>${escapeHtml(v.phone ?? "")}</td>
      <td>${escapeHtml(v.island ?? "")}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function init() {
  const token = getTokenFromUrl();
  if (!token) {
    document.getElementById("pledgedViewTitle").textContent = "Invalid link";
    document.getElementById("pledgedViewSubtitle").textContent = "This link is missing or invalid.";
    return;
  }

  const api = await firebaseInitPromise;
  if (!api.ready || !api.getPledgedReportShareByTokenFs) {
    document.getElementById("pledgedViewTitle").textContent = "Error";
    document.getElementById("pledgedViewSubtitle").textContent = "Could not load the list.";
    return;
  }

  share = await api.getPledgedReportShareByTokenFs(token);
  if (!share) {
    document.getElementById("pledgedViewTitle").textContent = "Invalid or expired link";
    document.getElementById("pledgedViewSubtitle").textContent = "This link may have been removed or has expired.";
    return;
  }

  const name = share.candidateName || share.candidateId || "Candidate";
  document.getElementById("pledgedViewTitle").textContent = `Pledged voters – ${name}`;
  document.getElementById("pledgedViewSubtitle").textContent = `Read-only list (${(share.voters || []).length} voter(s)). Shared from Campaign Reports.`;

  renderTable();
  initTableViewMenus();
}

init();

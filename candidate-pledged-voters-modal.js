/**
 * Shared modal: pledged voters for one candidate (Reports + Settings → Candidates).
 * Matches Settings → Agents “Voters” modal: filters, CSV, Print, wide layout.
 */
import { getVoterImageSrc } from "./voters.js";
import { getVotedTimeMarked } from "./zeroDay.js";
import { openModal, closeModal } from "./ui.js";
import { candidatePledgedAgentStorageKey } from "./agents-context.js";
import { initTableViewMenus } from "./table-view-menu.js";
import {
  compareBallotSequence,
  sequenceAsImportedFromCsv,
  compareVotersByBallotBoxThenSequenceThenName,
  compareVotersByBallotSequenceThenName,
} from "./sequence-utils.js";

const REPORT_PLEDGED_PAGE_SIZE = 20;

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pledgePillClass(status) {
  if (status === "yes") return "pledge-pill pledge-pill--pledged";
  if (status === "undecided") return "pledge-pill pledge-pill--undecided";
  return "pledge-pill pledge-pill--not-pledged";
}

function reportBallotBoxLabel(v) {
  const box = String(v && v.ballotBox != null ? v.ballotBox : "").trim();
  const loc = String(v && v.currentLocation != null ? v.currentLocation : "").trim();
  if (box.toLowerCase() === "others" && loc) return `Others - ${loc}`;
  return box || "—";
}

/**
 * @param {object} opts
 * @param {string} opts.candidateId
 * @param {() => object[]} opts.getAllVoters
 * @param {() => { role?: string, candidateId?: string | null } | null} [opts.getCurrentUser]
 * @param {() => { id: unknown, name?: string }[]} opts.getCandidates
 */
export function openCandidatePledgedVotersModal({
  candidateId,
  getAllVoters,
  getCurrentUser,
  getCandidates,
}) {
  if (!candidateId) return;
  const cu = getCurrentUser ? getCurrentUser() : null;
  if (cu?.role === "candidate" && cu?.candidateId && String(cu.candidateId) !== String(candidateId)) {
    return;
  }
  const allVoters = typeof getAllVoters === "function" ? getAllVoters() : [];
  const baseList = allVoters.filter((v) => {
    const cp = v.candidatePledges || {};
    return cp[String(candidateId)] === "yes";
  });
  const candidates = getCandidates();
  const assignedAgentStorageKey = candidatePledgedAgentStorageKey(candidateId);
  let assignedByVoterId = {};
  try {
    const raw = localStorage.getItem(assignedAgentStorageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") assignedByVoterId = parsed;
    }
  } catch (_) {}

  const candidate = candidates.find((c) => String(c.id) === String(candidateId));
  const title = candidate ? `Pledged voters – ${candidate.name || candidateId}` : "Pledged voters – Candidate";

  function candidatePledgeForRow(v) {
    const cp = v.candidatePledges || {};
    const s = cp[String(candidateId)];
    if (s === "yes" || s === "no" || s === "undecided") return s;
    return "undecided";
  }

  function pickAgentAssignmentVal(raw) {
    if (raw == null) return "";
    if (typeof raw === "object") return String(raw.name || raw.id || "").trim();
    return String(raw).trim();
  }

  function getAssignedAgentName(v) {
    const fromObj =
      v.candidateAgentAssignments && typeof v.candidateAgentAssignments === "object"
        ? v.candidateAgentAssignments[String(candidateId)]
        : "";
    const fromDoc = pickAgentAssignmentVal(fromObj);
    const raw = fromDoc || assignedByVoterId[String(v.id)];
    return pickAgentAssignmentVal(raw);
  }

  const body = document.createElement("div");
  body.className = "modal-body-inner";

  const toolbar = document.createElement("div");
  toolbar.className = "modal-list-toolbar list-toolbar";
  const boxes = [...new Set(baseList.map((v) => (v.ballotBox || "").trim()).filter(Boolean))].sort();
  toolbar.innerHTML = `
      <div class="list-toolbar__search">
        <label for="reportPledgedSearch" class="sr-only">Search</label>
        <input type="search" id="reportPledgedSearch" placeholder="Search by name, ID, address, island…" aria-label="Search pledged voters">
      </div>
      <div class="list-toolbar__controls">
        <div class="field-group field-group--inline">
          <label for="reportPledgedFilterPledge">Filter</label>
          <select id="reportPledgedFilterPledge">
            <option value="all">All</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="undecided">Undecided</option>
          </select>
        </div>
        <div class="field-group field-group--inline">
          <label for="reportPledgedFilterBox">Ballot box</label>
          <select id="reportPledgedFilterBox">
            <option value="all">All</option>
            ${boxes.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("")}
          </select>
        </div>
        <div class="field-group field-group--inline">
          <label for="reportPledgedSort">Sort</label>
          <select id="reportPledgedSort">
            <option value="sequence">Sequence</option>
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="id">ID Number</option>
            <option value="address">Address</option>
            <option value="pledge">Pledge</option>
            <option value="box">Ballot box</option>
            <option value="voted">Voted at</option>
          </select>
        </div>
        <div class="field-group field-group--inline">
          <label for="reportPledgedGroupBy">Group by</label>
          <select id="reportPledgedGroupBy">
            <option value="none">None</option>
            <option value="box">Ballot box</option>
            <option value="pledge">Pledge</option>
          </select>
        </div>
        <div class="dropdown-wrap table-view-dropdown" data-table-view-for="reportPledgedTable">
          <button type="button" class="ghost-button ghost-button--small table-view-menu-btn" aria-label="Table view options" aria-haspopup="true" aria-expanded="false" title="Table view">⋮</button>
          <div class="dropdown-menu" data-table-view-dropdown hidden role="menu" aria-label="Table view">
            <div class="dropdown-menu__item dropdown-menu__item--static">Table view</div>
            <button type="button" class="dropdown-menu__item table-view-dropdown__option" role="menuitem" data-table-view-density="compact">Compact</button>
            <button type="button" class="dropdown-menu__item table-view-dropdown__option" role="menuitem" data-table-view-density="default">Default</button>
            <button type="button" class="dropdown-menu__item table-view-dropdown__option" role="menuitem" data-table-view-density="comfortable">Comfortable</button>
          </div>
        </div>
      </div>
    `;
  body.appendChild(toolbar);

  const summary = document.createElement("p");
  summary.className = "helper-text";
  summary.style.margin = "0 0 8px";
  summary.textContent = "";
  body.appendChild(summary);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "data-table";
  table.id = "reportPledgedTable";
  table.innerHTML = `
      <thead>
        <tr>
          <th class="data-table-col--seq">Seq</th>
          <th>Image</th>
          <th>ID Number</th>
          <th class="data-table-col--name">Name</th>
          <th>Permanent Address</th>
          <th title="Pledge to this candidate">Pledge</th>
          <th>Ballot box</th>
          <th>Assigned agent</th>
          <th>Phone</th>
          <th>Island</th>
          <th>Voted</th>
        </tr>
      </thead>
      <tbody id="reportPledgedTableBody"></tbody>
    `;
  tableWrap.appendChild(table);
  body.appendChild(tableWrap);
  initTableViewMenus(body);

  const tbody = table.querySelector("#reportPledgedTableBody");
  const COL_COUNT = 11;
  let currentPage = 1;
  /** @type {object[]} */
  let lastFilteredVoters = [];

  function getFilteredSortedGrouped() {
    const query = String(body.querySelector("#reportPledgedSearch")?.value || "")
      .toLowerCase()
      .trim();
    const filterPledge = body.querySelector("#reportPledgedFilterPledge")?.value || "all";
    const filterBox = body.querySelector("#reportPledgedFilterBox")?.value || "all";
    const sortBy = body.querySelector("#reportPledgedSort")?.value || "sequence";
    const groupBy = body.querySelector("#reportPledgedGroupBy")?.value || "none";

    let list = baseList.filter((v) => {
      if (filterPledge !== "all" && candidatePledgeForRow(v) !== filterPledge) return false;
      if (filterBox !== "all" && (v.ballotBox || "").trim() !== filterBox) return false;
      if (query) {
        const s = [v.fullName, v.nationalId, v.id, v.permanentAddress, v.ballotBox, v.phone, v.island]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!s.includes(query)) return false;
      }
      return true;
    });

    const cmp = (a, b) => {
      switch (sortBy) {
        case "sequence":
          return compareVotersByBallotSequenceThenName(a, b);
        case "name-desc":
          return (b.fullName || "").localeCompare(a.fullName || "", "en");
        case "name-asc":
          return (a.fullName || "").localeCompare(b.fullName || "", "en");
        case "id":
          return (a.nationalId || "").localeCompare(b.nationalId || "", "en");
        case "address":
          return (a.permanentAddress || "").localeCompare(b.permanentAddress || "", "en");
        case "pledge":
          return candidatePledgeForRow(a).localeCompare(candidatePledgeForRow(b), "en");
        case "box":
          return compareVotersByBallotBoxThenSequenceThenName(a, b);
        case "voted": {
          const ta = String(getVotedTimeMarked(a.id) || a.votedAt || "");
          const tb = String(getVotedTimeMarked(b.id) || b.votedAt || "");
          return tb.localeCompare(ta, "en");
        }
        default:
          return (a.fullName || "").localeCompare(b.fullName || "", "en");
      }
    };
    list = list.slice().sort(cmp);

    if (groupBy === "box") {
      list.sort(compareVotersByBallotBoxThenSequenceThenName);
    }

    if (groupBy === "none") return list.map((v) => ({ type: "row", voter: v }));
    const out = [];
    let lastKey = null;
    const getKey = (v) =>
      groupBy === "box"
        ? (v.ballotBox || "Unassigned")
        : candidatePledgeForRow(v) === "yes"
          ? "Yes"
          : candidatePledgeForRow(v) === "no"
            ? "No"
            : "Undecided";
    list.forEach((v) => {
      const key = getKey(v);
      if (key !== lastKey) {
        out.push({ type: "group", label: key });
        lastKey = key;
      }
      out.push({ type: "row", voter: v });
    });
    return out;
  }

  function renderReportTable() {
    const displayList = getFilteredSortedGrouped();
    const rowsOnly = displayList.filter((x) => x.type === "row");
    lastFilteredVoters = rowsOnly.map((x) => x.voter);
    const total = rowsOnly.length;
    const totalPages = Math.max(1, Math.ceil(total / REPORT_PLEDGED_PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * REPORT_PLEDGED_PAGE_SIZE;
    const pageRows = rowsOnly.slice(start, start + REPORT_PLEDGED_PAGE_SIZE);

    const candName = candidate?.name || String(candidateId);
    summary.textContent = `Candidate: ${candName} • Showing ${total} of ${baseList.length} pledged voters (Yes to this candidate)`;

    tbody.innerHTML = "";
    if (rowsOnly.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="${COL_COUNT}" class="text-muted" style="text-align:center;padding:24px;">No voters match the filters.</td>`;
      tbody.appendChild(tr);
    } else {
      let pendingGroupLabel = null;
      displayList.forEach((item) => {
        if (item.type === "group") {
          pendingGroupLabel = item.label;
          return;
        }
        const v = item.voter;
        const idxInRows = rowsOnly.findIndex((r) => r.voter.id === v.id);
        if (idxInRows < start || idxInRows >= start + REPORT_PLEDGED_PAGE_SIZE) return;
        if (pendingGroupLabel) {
          const tr = document.createElement("tr");
          tr.className = "list-toolbar__group-header";
          tr.innerHTML = `<td colspan="${COL_COUNT}">${escapeHtml(pendingGroupLabel)}</td>`;
          tbody.appendChild(tr);
          pendingGroupLabel = null;
        }
        const initials =
          (v.fullName || "").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") ||
          "?";
        const photoSrc = getVoterImageSrc(v);
        const photoCell = photoSrc
          ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
          : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
        const pledgeStatus = candidatePledgeForRow(v);
        const timeMarked = getVotedTimeMarked(v.id);
        const votedCell = timeMarked
          ? (() => {
              const d = new Date(timeMarked);
              const formatted = d.toLocaleString("en-MV", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              });
              return `<span class="pledge-pill pledge-pill--pledged" title="${escapeHtml(formatted)}">Voted</span>`;
            })()
          : '<span class="text-muted">—</span>';
        const assignedAgentName = getAssignedAgentName(v);
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="data-table-col--seq">${escapeHtml(sequenceAsImportedFromCsv(v))}</td>
            <td>${photoCell}</td>
            <td>${escapeHtml(v.nationalId ?? "")}</td>
            <td class="data-table-col--name">${escapeHtml(v.fullName ?? "")}</td>
            <td>${escapeHtml(v.permanentAddress ?? "")}</td>
            <td><span class="${pledgePillClass(pledgeStatus)}">${pledgeStatus === "yes" ? "Yes" : pledgeStatus === "no" ? "No" : "Undecided"}</span></td>
            <td>${escapeHtml((v.ballotBox || "").trim() || "—")}</td>
            <td>${escapeHtml(assignedAgentName || "—")}</td>
            <td>${escapeHtml(v.phone ?? "")}</td>
            <td>${escapeHtml(v.island ?? "")}</td>
            <td class="voted-status-cell">${votedCell}</td>
          `;
        tbody.appendChild(tr);
      });
    }

    const paginationEl = body.querySelector("#reportPledgedPagination");
    if (paginationEl) {
      const from = total === 0 ? 0 : start + 1;
      const to = Math.min(start + REPORT_PLEDGED_PAGE_SIZE, total);
      paginationEl.innerHTML = `
          <span class="pagination-bar__summary">Showing ${from}–${to} of ${total}</span>
          <div class="pagination-bar__nav">
            <button type="button" class="pagination-bar__btn" data-page="prev" ${currentPage <= 1 ? "disabled" : ""}>Previous</button>
            <span class="pagination-bar__summary">Page ${currentPage} of ${totalPages}</span>
            <button type="button" class="pagination-bar__btn" data-page="next" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
          </div>
        `;
      paginationEl.querySelectorAll("[data-page]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.page === "prev" && currentPage > 1) currentPage--;
          if (btn.dataset.page === "next" && currentPage < totalPages) currentPage++;
          renderReportTable();
        });
      });
    }
  }

  const paginationBar = document.createElement("div");
  paginationBar.id = "reportPledgedPagination";
  paginationBar.className = "pagination-bar";
  body.appendChild(paginationBar);

  const searchEl = body.querySelector("#reportPledgedSearch");
  const filterPledgeEl = body.querySelector("#reportPledgedFilterPledge");
  const filterBoxEl = body.querySelector("#reportPledgedFilterBox");
  const sortEl = body.querySelector("#reportPledgedSort");
  const groupByEl = body.querySelector("#reportPledgedGroupBy");
  [searchEl, filterPledgeEl, filterBoxEl, sortEl, groupByEl].forEach((el) => {
    if (el)
      el.addEventListener(el.id === "reportPledgedSearch" ? "input" : "change", () => {
        currentPage = 1;
        renderReportTable();
      });
  });

  function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function downloadPledgedVotersCsv() {
    if (!lastFilteredVoters.length) return;
    const headers = [
      "Seq",
      "Name",
      "ID Number",
      "Phone",
      "Permanent Address",
      "Ballot box",
      "Pledge",
      "Assigned agent",
      "Island",
      "Voted at",
      "Notes",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    lastFilteredVoters.forEach((v) => {
      const votedAt = getVotedTimeMarked(v.id) || v.votedAt || "";
      const cols = [
        sequenceAsImportedFromCsv(v),
        v.fullName || "",
        v.nationalId || v.id || "",
        v.phone || "",
        v.permanentAddress || "",
        reportBallotBoxLabel(v),
        candidatePledgeForRow(v),
        getAssignedAgentName(v),
        v.island || "",
        votedAt ? String(votedAt) : "",
        v.notes || v.callComments || "",
      ];
      lines.push(cols.map(csvEscape).join(","));
    });
    const csv = lines.join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeCand = String(candidate?.name || candidateId || "candidate")
      .trim()
      .replace(/[^\w\-]+/g, "_");
    a.download = `pledged-voters-${safeCand}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function printPledgedVotersReport() {
    if (!lastFilteredVoters.length) return;
    const printRows = [...lastFilteredVoters].sort((a, b) => {
      const boxA = reportBallotBoxLabel(a);
      const boxB = reportBallotBoxLabel(b);
      const boxCmp = boxA.localeCompare(boxB, "en");
      if (boxCmp !== 0) return boxCmp;
      const seqCmp = compareBallotSequence(a.sequence, b.sequence);
      if (seqCmp !== 0) return seqCmp;
      return String(a.fullName || "").localeCompare(String(b.fullName || ""), "en");
    });
    const rowsHtml = printRows
      .map((v) => {
        const votedAt = getVotedTimeMarked(v.id) || v.votedAt || "";
        return `
          <tr>
            <td>${escapeHtml(sequenceAsImportedFromCsv(v))}</td>
            <td>${escapeHtml(v.fullName || "")}</td>
            <td>${escapeHtml(v.nationalId || v.id || "")}</td>
            <td>${escapeHtml(v.phone || "")}</td>
            <td>${escapeHtml(v.permanentAddress || "")}</td>
            <td>${escapeHtml(reportBallotBoxLabel(v))}</td>
            <td>${escapeHtml(candidatePledgeForRow(v))}</td>
            <td>${escapeHtml(votedAt ? String(votedAt) : "")}</td>
            <td>${escapeHtml(getAssignedAgentName(v))}</td>
          </tr>
        `;
      })
      .join("");
    const w = window.open("about:blank", "_blank");
    if (!w) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Popup blocked",
          meta: "Allow popups for this site to open Print Preview.",
        });
      } else {
        alert("Allow popups for this site to open Print Preview.");
      }
      return;
    }
    try {
      w.opener = null;
    } catch (_) {}
    const candLine = candidate ? candidate.name || candidateId : candidateId;
    w.document.open();
    w.document.write(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Pledged voters report</title>
        <style>
          :root { color-scheme: light; }
          body { font-family: Arial, sans-serif; margin: 0; color: #111; background: #f5f7fb; }
          .page { max-width: 1200px; margin: 20px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.06); overflow: hidden; }
          .report-head { padding: 16px 18px; border-bottom: 1px solid #e5e7eb; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
          .report-title { margin: 0; font-size: 20px; line-height: 1.2; }
          .report-meta { margin: 4px 0 0; color: #4b5563; font-size: 13px; }
          .report-actions { display: flex; gap: 8px; }
          .btn { border: 1px solid #d1d5db; background: #fff; color: #111; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
          .btn--primary { border-color: #2563eb; background: #2563eb; color: #fff; }
          .table-wrap { padding: 10px; overflow: auto; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; min-width: 980px; }
          th, td {
            border: 1px solid #e5e7eb;
            padding: 4px 6px;
            text-align: left;
            vertical-align: top;
            line-height: 1.2;
            white-space: normal;
            overflow-wrap: anywhere;
            word-break: break-word;
            hyphens: auto;
          }
          th { background: #f9fafb; font-weight: 600; position: sticky; top: 0; z-index: 1; }
          tbody tr:nth-child(odd) { background: #fcfcfd; }
          .col-seq { width: 4%; }
          .col-name { width: 15%; }
          .col-id { width: 11%; }
          .col-phone { width: 10%; }
          .col-address { width: 24%; }
          .col-box { width: 9%; }
          .col-pledge { width: 6%; }
          .col-voted { width: 10%; }
          .col-agent { width: 11%; }
          @media print {
            @page { size: A4 landscape; margin: 9mm; }
            body { background: #fff; }
            .page { margin: 0; border: none; box-shadow: none; border-radius: 0; max-width: none; }
            .report-actions { display: none !important; }
            .table-wrap { padding: 0; overflow: visible; }
            table { min-width: 0; width: 100%; font-size: 9.5px; table-layout: fixed; }
            th, td { padding: 2px 4px; line-height: 1.15; }
            th { position: static; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <header class="report-head">
            <div>
              <h1 class="report-title">Pledged voters report</h1>
              <p class="report-meta">Candidate: ${escapeHtml(candLine)} | Total: ${printRows.length} | Sorted: Ballot box | Generated: ${escapeHtml(
                new Date().toLocaleString("en-MV")
              )}</p>
            </div>
            <div class="report-actions">
              <button type="button" class="btn" onclick="window.close()">Close</button>
              <button type="button" class="btn btn--primary" onclick="window.print()">Print</button>
            </div>
          </header>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="col-seq">Seq</th>
                  <th class="col-name">Name</th>
                  <th class="col-id">ID Number</th>
                  <th class="col-phone">Phone</th>
                  <th class="col-address">Permanent Address</th>
                  <th class="col-box">Ballot box</th>
                  <th class="col-pledge">Pledge</th>
                  <th class="col-voted">Voted at</th>
                  <th class="col-agent">Assigned agent</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      </body>
      </html>
    `);
    w.document.close();
    w.focus();
  }

  renderReportTable();

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.flexWrap = "wrap";
  footer.style.gap = "10px";
  footer.style.alignItems = "center";
  footer.style.justifyContent = "flex-end";

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "ghost-button";
  downloadBtn.textContent = "Download CSV";
  downloadBtn.addEventListener("click", downloadPledgedVotersCsv);

  const printBtn = document.createElement("button");
  printBtn.type = "button";
  printBtn.className = "ghost-button";
  printBtn.textContent = "Print";
  printBtn.addEventListener("click", printPledgedVotersReport);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost-button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);

  footer.appendChild(downloadBtn);
  footer.appendChild(printBtn);
  footer.appendChild(closeBtn);

  openModal({ title, body, footer });
}

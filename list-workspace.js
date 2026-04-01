/**
 * List workspace: open a voter list in a separate window. CRUD, columns, filter/sort/group, export, assign, share link.
 */
import { firebaseInitPromise } from "./firebase.js";
import { getList, getListFromServer, saveList, createShareLink, getListStatusValues, getListStatusLabel } from "./lists.js";
import { openModal, closeModal } from "./ui.js";
import { initTableViewMenus } from "./table-view-menu.js";
import {
  compareBallotSequence,
  sequenceAsImportedFromCsv,
  compareVotersByBallotBoxThenSequenceThenName,
} from "./sequence-utils.js";

const PAGE_SIZE = 20;
const VOTER_IMAGES_BASE = "photos/";

const COLUMN_OPTIONS = [
  { key: "sequence", label: "Seq" },
  { key: "image", label: "Image" },
  { key: "nationalId", label: "ID Number" },
  { key: "fullName", label: "Name" },
  { key: "permanentAddress", label: "Address" },
  { key: "pledgeStatus", label: "Pledge" },
  { key: "phone", label: "Phone" },
  { key: "island", label: "Island" },
  { key: "ballotBox", label: "Ballot box" },
];

function getVoterImageSrc(voter) {
  if (!voter) return "";
  const rawId = (voter.nationalId || voter.id || "").toString().trim();
  const id = rawId.replace(/\s+/g, "");
  if (!id) return "";
  return VOTER_IMAGES_BASE + id + ".jpg";
}

function getListIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("listId") || "";
}

/** Return a strict array of voter IDs from the list (never undefined; handles Firestore quirks). */
function getListVoterIdsArray(list) {
  if (!list) return [];
  const raw = list.voterIds;
  if (Array.isArray(raw)) return raw.map((id) => String(id));
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return Object.values(raw).map((id) => String(id));
  return [];
}

function escapeHtml(s) {
  if (s == null) return "";
  const t = document.createElement("div");
  t.textContent = s;
  return t.innerHTML;
}

function pledgePillClass(status) {
  if (status === "yes") return "pledge-pill pledge-pill--pledged";
  if (status === "no") return "pledge-pill pledge-pill--not-pledged";
  return "pledge-pill pledge-pill--undecided";
}

let listId = "";
let list = null;
let allVoters = [];
let listVoters = [];
let candidates = [];
let agents = [];
let currentPage = 1;
let visibleColumns = ["sequence", "image", "nationalId", "fullName", "permanentAddress", "pledgeStatus"];

function getSearchEl() { return document.getElementById("listWorkspaceSearch"); }
function getFilterPledgeEl() { return document.getElementById("listWorkspaceFilterPledge"); }
function getSortEl() { return document.getElementById("listWorkspaceSort"); }
function getGroupByEl() { return document.getElementById("listWorkspaceGroupBy"); }
function getAddSearchEl() { return document.getElementById("listWorkspaceAddSearch"); }
function getAddResultsEl() { return document.getElementById("listWorkspaceAddResults"); }
function getAddSearchStatusEl() { return document.getElementById("listWorkspaceAddSearchStatus"); }

function getFilteredSortedGrouped() {
  const query = (getSearchEl()?.value || "").toLowerCase().trim();
  const pledgeFilter = getFilterPledgeEl()?.value || "all";
  const sortBy = getSortEl()?.value || "sequence";
  const groupBy = getGroupByEl()?.value || "none";

  let rows = listVoters.filter((v) => {
    if (pledgeFilter !== "all" && (v.pledgeStatus || "") !== pledgeFilter) return false;
    if (query) {
      const name = (v.fullName || "").toLowerCase();
      const id = (v.id || "").toLowerCase();
      const nationalId = (v.nationalId || "").toLowerCase();
      const phone = (v.phone || "").toLowerCase();
      const address = (v.permanentAddress || "").toLowerCase();
      const island = (v.island || "").toLowerCase();
      if (!name.includes(query) && !id.includes(query) && !nationalId.includes(query) && !phone.includes(query) && !address.includes(query) && !island.includes(query)) return false;
    }
    return true;
  });

  const cmp = (a, b) => {
    switch (sortBy) {
      case "sequence": return compareBallotSequence(a.sequence, b.sequence);
      case "name-desc": return (b.fullName || "").localeCompare(a.fullName || "", "en");
      case "name-asc": return (a.fullName || "").localeCompare(b.fullName || "", "en");
      case "id": return (a.nationalId || "").localeCompare(b.nationalId || "", "en");
      case "address": return (a.permanentAddress || "").localeCompare(b.permanentAddress || "", "en");
      case "pledge": return (a.pledgeStatus || "").localeCompare(b.pledgeStatus || "", "en");
      default: return (a.fullName || "").localeCompare(b.fullName || "", "en");
    }
  };
  rows = rows.slice().sort(cmp);

  if (groupBy === "island") {
    rows.sort(compareVotersByBallotBoxThenSequenceThenName);
  }

  if (groupBy === "none") return rows.map((v) => ({ type: "row", voter: v }));
  const getGroupKey = (v) => {
    if (groupBy === "island") return v.ballotBox || "Unassigned";
    if (groupBy === "permanentAddress") return (v.permanentAddress || "").trim() || "No address";
    return v.pledgeStatus || "undecided";
  };
  const out = [];
  let lastKey = null;
  rows.forEach((v) => {
    const key = getGroupKey(v);
    if (key !== lastKey) { out.push({ type: "group", label: key }); lastKey = key; }
    out.push({ type: "row", voter: v });
  });
  return out;
}

function renderTable() {
  const thead = document.getElementById("listWorkspaceThead");
  const tbody = document.getElementById("listWorkspaceTbody");
  const paginationEl = document.getElementById("listWorkspacePagination");
  if (!thead || !tbody) return;

  const displayList = getFilteredSortedGrouped();
  const dataRows = displayList.filter((x) => x.type === "row");
  const total = dataRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageRows = dataRows.slice(start, end);

  thead.innerHTML = "";
  const headerRow = document.createElement("tr");
  visibleColumns.forEach((key) => {
    const opt = COLUMN_OPTIONS.find((c) => c.key === key);
    const th = headerRow.appendChild(document.createElement("th"));
    th.textContent = opt ? opt.label : key;
    if (key === "sequence") th.classList.add("data-table-col--seq");
    if (key === "fullName") th.classList.add("data-table-col--name");
  });
  headerRow.appendChild(document.createElement("th")).innerHTML = "Actions";
  thead.appendChild(headerRow);

  tbody.innerHTML = "";
  pageRows.forEach((item) => {
    const voter = item.voter;
    const tr = document.createElement("tr");
    const initials = (voter.fullName || "").split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "?";
    const photoSrc = getVoterImageSrc(voter);
    const photoCellHtml = photoSrc
      ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
      : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
    visibleColumns.forEach((key) => {
      const td = tr.appendChild(document.createElement("td"));
      if (key === "sequence") td.classList.add("data-table-col--seq");
      if (key === "fullName") td.classList.add("data-table-col--name");
      if (key === "image") {
        td.innerHTML = photoCellHtml;
      } else if (key === "pledgeStatus") {
        td.innerHTML = `<span class="${pledgePillClass(voter.pledgeStatus)}">${voter.pledgeStatus || "No"}</span>`;
      } else if (key === "sequence") {
        td.textContent = sequenceAsImportedFromCsv(voter);
      } else {
        td.textContent = voter[key] ?? "";
      }
    });
    const actionsTd = tr.appendChild(document.createElement("td"));
    actionsTd.style.textAlign = "right";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost-button ghost-button--small";
    removeBtn.textContent = "Remove from list";
    removeBtn.addEventListener("click", () => removeVoterFromList(voter.id));
    actionsTd.appendChild(removeBtn);
    tbody.appendChild(tr);
  });

  if (paginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(end, total);
    paginationEl.innerHTML = `
      <span class="pagination-bar__summary">${from}–${to} of ${total}</span>
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
        renderTable();
      });
    });
  }
}

async function removeVoterFromList(voterId) {
  if (!list || !listId) return;
  const currentIds = getListVoterIdsArray(list);
  const voterIds = currentIds.filter((id) => id !== String(voterId));
  list.voterIds = voterIds;
  await saveList(list);
  const idSet = new Set(voterIds);
  listVoters = allVoters.filter((v) => idSet.has(String(v.id)));
  renderTable();
  updateSubtitle();
}

let tableSectionVisible = false;

function setTableSectionVisible(visible) {
  tableSectionVisible = !!visible;
  const section = document.getElementById("listWorkspaceTableSection");
  if (section) section.hidden = !tableSectionVisible;
  const btn = document.getElementById("listWorkspaceShowTableBtn");
  if (btn) btn.textContent = tableSectionVisible ? "Hide voters in list" : "Show voters in list";
}

function updateSubtitle() {
  const n = listVoters.length || 0;
  const el = document.getElementById("listWorkspaceSubtitle");
  if (el) el.textContent = n + " voter(s) in this list";
  const summaryEl = document.getElementById("listWorkspaceShowTableSummary");
  if (summaryEl) summaryEl.textContent = n + " voter(s) in list";
  const btn = document.getElementById("listWorkspaceShowTableBtn");
  if (btn) btn.textContent = tableSectionVisible ? "Hide voters in list" : "Show voters in list";
}

/** Add one voter to the list; they then appear in the table. */
async function addVoterToList(voter) {
  if (!list || !listId) return;
  const currentIds = getListVoterIdsArray(list);
  if (currentIds.includes(String(voter.id))) return;
  list.voterIds = [...currentIds, String(voter.id)];
  await saveList(list);
  const idSet = new Set(list.voterIds);
  listVoters = allVoters.filter((v) => idSet.has(String(v.id)));
  renderAddSearchResults();
  renderTable();
  updateSubtitle();
}

function renderAddSearchResults() {
  const input = getAddSearchEl();
  const resultsEl = getAddResultsEl();
  const statusEl = getAddSearchStatusEl();
  if (!resultsEl) return;
  const q = (input?.value || "").toLowerCase().trim();
  const listIdSet = new Set(getListVoterIdsArray(list));
  const matched = q
    ? allVoters.filter((v) => {
        const name = (v.fullName || "").toLowerCase();
        const nationalId = (v.nationalId || "").toLowerCase();
        const id = (v.id || "").toLowerCase();
        const address = (v.permanentAddress || "").toLowerCase();
        const island = (v.island || "").toLowerCase();
        const phone = (v.phone || "").toLowerCase();
        return name.includes(q) || nationalId.includes(q) || id.includes(q) || address.includes(q) || island.includes(q) || phone.includes(q);
      })
    : [];
  const maxShow = 50;
  const toShow = matched.slice(0, maxShow);

  if (statusEl) {
    if (!q) statusEl.textContent = "";
    else statusEl.textContent = matched.length === 0 ? "No voters match." : (toShow.length < matched.length ? `Showing ${toShow.length} of ${matched.length} matches.` : `${matched.length} match${matched.length !== 1 ? "es" : ""}.`);
  }

  resultsEl.innerHTML = "";
  if (!q) {
    resultsEl.innerHTML = "<p class=\"list-workspace__add-empty-hint\">Type above to search voters. Click <strong>Add to list</strong> to add them — only then they appear in the table.</p>";
    return;
  }
  if (toShow.length === 0) {
    resultsEl.innerHTML = "<p class=\"list-workspace__add-empty-hint\">No voters match your search.</p>";
    return;
  }
  toShow.forEach((v) => {
    const inList = listIdSet.has(String(v.id));
    const row = document.createElement("div");
    row.className = "list-workspace__add-result-row";
    row.innerHTML = `
      <div class="add-result-info">
        <span class="add-result-name">${escapeHtml(v.fullName || v.nationalId || v.id || "—")}</span>
        <div class="add-result-meta">${escapeHtml(v.nationalId || "")} ${v.permanentAddress ? " · " + escapeHtml(v.permanentAddress) : ""}</div>
      </div>
    `;
    const action = document.createElement("div");
    if (inList) {
      action.innerHTML = "<span class=\"text-muted\" style=\"font-size:12px;\">In list</span>";
    } else {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "primary-button";
      addBtn.textContent = "Add to list";
      addBtn.addEventListener("click", () => addVoterToList(v));
      action.appendChild(addBtn);
    }
    row.appendChild(action);
    resultsEl.appendChild(row);
  });
}

function bindAddSearch() {
  const input = getAddSearchEl();
  if (input) input.addEventListener("input", () => renderAddSearchResults());
}

/** Parse file to Set of normalized ID strings. */
function parseIdsFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = (reader.result || "").toString();
      const ids = new Set();
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const parts = line.split(/[,;\t]/).map((p) => p.trim());
        for (const p of parts) {
          const id = p.replace(/\s+/g, "").trim();
          if (id) ids.add(id);
        }
      }
      resolve(ids);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsText(file, "UTF-8");
  });
}

/** Find voter ids whose nationalId or id is in the uploaded set. */
function findVoterIdsByUploadedIds(uploadedIdSet) {
  const matched = [];
  for (const v of allVoters) {
    const nid = (v.nationalId || "").toString().replace(/\s+/g, "").trim();
    const id = String(v.id || "").trim();
    if (uploadedIdSet.has(nid) || uploadedIdSet.has(id)) matched.push(String(v.id));
  }
  return matched;
}

function bindUploadIds() {
  const input = document.getElementById("listWorkspaceUploadIds");
  const statusEl = document.getElementById("listWorkspaceUploadStatus");
  if (!input) return;
  input.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!list || !listId) return;
    if (statusEl) statusEl.textContent = "Processing…";
    try {
      const uploadedIdSet = await parseIdsFromFile(file);
      if (uploadedIdSet.size === 0) {
        if (statusEl) statusEl.textContent = "No IDs found in file.";
        return;
      }
      const matchedVoterIds = findVoterIdsByUploadedIds(uploadedIdSet);
      // Replace list with only voters from the uploaded file — table shows only those
      list.voterIds = matchedVoterIds;
      await saveList(list);
      const idSet = new Set(list.voterIds);
      listVoters = allVoters.filter((v) => idSet.has(String(v.id)));
      renderAddSearchResults();
      renderTable();
      updateSubtitle();
      if (statusEl) {
        statusEl.textContent = matchedVoterIds.length > 0
          ? `List replaced: ${matchedVoterIds.length} voter(s) from file now in list. ${uploadedIdSet.size - matchedVoterIds.length} ID(s) in file had no match.`
          : `No voters matched the ${uploadedIdSet.size} ID(s) in the file. List is now empty.`;
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = "Error: " + (err?.message || String(err));
    }
  });
}

function bindShowTableToggle() {
  const btn = document.getElementById("listWorkspaceShowTableBtn");
  if (btn) btn.addEventListener("click", () => setTableSectionVisible(!tableSectionVisible));
}

function openColumnsModal() {
  const body = document.createElement("div");
  body.className = "form-group";
  const p = document.createElement("p");
  p.className = "helper-text";
  p.textContent = "Toggle columns to show in the table.";
  body.appendChild(p);
  const div = document.createElement("div");
  div.style.display = "flex";
  div.style.flexDirection = "column";
  div.style.gap = "8px";
  COLUMN_OPTIONS.forEach((opt) => {
    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = visibleColumns.includes(opt.key);
    cb.addEventListener("change", () => {
      if (cb.checked) visibleColumns.push(opt.key);
      else visibleColumns = visibleColumns.filter((k) => k !== opt.key);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(opt.label));
    div.appendChild(label);
  });
  body.appendChild(div);
  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary-button";
  saveBtn.textContent = "Apply";
  saveBtn.addEventListener("click", () => {
    list.visibleColumns = [...visibleColumns];
    saveList(list).then(() => { closeModal(); renderTable(); });
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  openModal({ title: "Columns", body, footer });
}

function exportCsv() {
  const displayList = getFilteredSortedGrouped();
  const rows = displayList.filter((x) => x.type === "row").map((x) => x.voter);
  const headers = visibleColumns.slice();
  const line = (arr) => arr.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",");
  const lines = [line(headers), ...rows.map((v) => line(headers.map((k) => v[k] ?? "")))];
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (list?.name || "list") + "-export.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Same rows/columns as CSV; opens print dialog so the user can Save as PDF. */
function exportPdf() {
  const displayList = getFilteredSortedGrouped();
  const rows = displayList.filter((x) => x.type === "row").map((x) => x.voter);
  const headerLabels = visibleColumns.map((k) => {
    const opt = COLUMN_OPTIONS.find((c) => c.key === k);
    return opt ? opt.label : k;
  });
  const listName = list?.name || "List";
  const headCells = headerLabels.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyRows = rows.map((v) => {
    const tds = visibleColumns.map((key) => {
      let cell = "";
      if (key === "image") {
        cell =
          (v.fullName || "").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "—";
      } else if (key === "pledgeStatus") {
        cell = v.pledgeStatus || "—";
      } else if (key === "sequence") {
        cell = sequenceAsImportedFromCsv(v);
      } else {
        cell = v[key] ?? "";
      }
      return `<td>${escapeHtml(String(cell))}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");

  const w = window.open("", "_blank", "noopener,noreferrer");
  if (!w) {
    window.alert("Pop-up blocked. Allow pop-ups for this site to export PDF, or use Export CSV.");
    return;
  }
  const title = escapeHtml(listName);
  w.document.write(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 16px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 8px; font-weight: 600; }
  .meta { margin: 0 0 14px; font-size: 12px; color: #444; }
  table { border-collapse: collapse; width: 100%; font-size: 10px; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; word-break: break-word; }
  th { background: #eee; font-weight: 600; }
  @media print {
    body { margin: 8px; }
    th { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style></head><body>
<h1>${title}</h1>
<p class="meta">${rows.length.toLocaleString()} voter(s) · use your browser print dialog and choose <strong>Save as PDF</strong> if available.</p>
<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>
<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},250);});<\/script>
</body></html>`);
  w.document.close();
}

function openShareLinkModal() {
  const body = document.createElement("div");
  const snapshots = listVoters.map((v) => ({
    id: v.id,
    fullName: v.fullName,
    nationalId: v.nationalId,
    phone: v.phone,
    permanentAddress: v.permanentAddress,
    island: v.island,
    pledgeStatus: v.pledgeStatus,
  }));
  createShareLink(listId, snapshots)
    .then(({ url }) => {
      body.innerHTML = "<p class=\"helper-text\">Share this link with the assigned candidate. They will only see voters in this list and can mark status (In Progress, Need Assistance, Completed).</p><div class=\"form-group\"><label>Link</label><input type=\"text\" id=\"shareLinkInput\" readonly value=\"" + escapeHtml(url) + "\" style=\"width:100%;\"></div>";
      const footer = document.createElement("div");
      footer.style.display = "flex";
      footer.style.gap = "8px";
      footer.style.justifyContent = "flex-end";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "primary-button";
      copyBtn.textContent = "Copy link";
      copyBtn.addEventListener("click", () => {
        const input = document.getElementById("shareLinkInput");
        if (input) { input.select(); document.execCommand("copy"); copyBtn.textContent = "Copied"; }
      });
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "ghost-button";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", closeModal);
      footer.appendChild(copyBtn);
      footer.appendChild(closeBtn);
      openModal({ title: "Share link", body, footer });
    })
    .catch((e) => {
      body.textContent = "Failed to create share link: " + (e?.message || String(e));
      const footer = document.createElement("div");
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "ghost-button";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", closeModal);
      footer.appendChild(closeBtn);
      openModal({ title: "Error", body, footer });
    });
}

function bindToolbar() {
  [getSearchEl(), getFilterPledgeEl(), getSortEl(), getGroupByEl()].forEach((el) => {
    if (el) el.addEventListener("input", () => { currentPage = 1; renderTable(); });
  });
  const columnsBtn = document.getElementById("listWorkspaceColumnsBtn");
  if (columnsBtn) columnsBtn.addEventListener("click", openColumnsModal);
  const exportBtn = document.getElementById("listWorkspaceExportBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportCsv);
  const exportPdfBtn = document.getElementById("listWorkspaceExportPdfBtn");
  if (exportPdfBtn) exportPdfBtn.addEventListener("click", exportPdf);
  const shareBtn = document.getElementById("listWorkspaceShareLinkBtn");
  if (shareBtn) shareBtn.addEventListener("click", openShareLinkModal);

  const candidateSelect = document.getElementById("listWorkspaceAssignCandidate");
  if (candidateSelect) {
    candidateSelect.innerHTML = "<option value=\"\">—</option>";
    candidates.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name || c.id;
      if (list?.assignedCandidateId === c.id) opt.selected = true;
      candidateSelect.appendChild(opt);
    });
    candidateSelect.addEventListener("change", async () => {
      list.assignedCandidateId = candidateSelect.value || "";
      await saveList(list);
    });
  }
  const agentSelect = document.getElementById("listWorkspaceAssignAgent");
  if (agentSelect) {
    agentSelect.innerHTML = "<option value=\"\">—</option>";
    agents.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name || a.email || a.id;
      if (list?.assignedAgentId === a.id) opt.selected = true;
      agentSelect.appendChild(opt);
    });
    agentSelect.addEventListener("change", async () => {
      list.assignedAgentId = agentSelect.value || "";
      await saveList(list);
    });
  }

  const backBtn = document.getElementById("listWorkspaceBack");
  if (backBtn) backBtn.addEventListener("click", () => { try { window.close(); } catch (_) { window.location.href = "index.html"; } });
}

async function init() {
  listId = getListIdFromUrl();
  if (!listId) {
    document.getElementById("listWorkspaceTitle").textContent = "No list";
    document.getElementById("listWorkspaceSubtitle").textContent = "Open a list from the main app (Voters → My lists).";
    return;
  }

  const api = await firebaseInitPromise;
  if (!api.ready) {
    document.getElementById("listWorkspaceSubtitle").textContent = "Firebase not ready.";
    return;
  }

  // Fetch list from server so we get current voterIds (avoid stale cache showing wrong set)
  list = await getListFromServer(listId);
  if (!list) {
    document.getElementById("listWorkspaceTitle").textContent = "List not found";
    document.getElementById("listWorkspaceSubtitle").textContent = "This list may have been deleted.";
    return;
  }
  // Normalize so list.voterIds is always a string array (handles Firestore/cache quirks)
  list.voterIds = getListVoterIdsArray(list);

  allVoters = await api.getAllVotersFs?.() || [];
  if (!Array.isArray(allVoters)) allVoters = [];
  // Only show voters that are in this list's voterIds — never the full voter roll
  const listVoterIdSet = new Set(list.voterIds);
  listVoters = allVoters.filter((v) => listVoterIdSet.has(String(v.id)));
  candidates = await api.getAllCandidatesFs?.() || [];
  if (!Array.isArray(candidates)) candidates = [];
  agents = await api.getAllAgentsFs?.() || [];
  if (!Array.isArray(agents)) agents = [];

  if (Array.isArray(list.visibleColumns) && list.visibleColumns.length > 0) visibleColumns = list.visibleColumns;

  document.getElementById("listWorkspaceTitle").textContent = list.name || "List";
  bindShowTableToggle();
  bindAddSearch();
  bindUploadIds();
  updateSubtitle();
  bindToolbar();
  renderAddSearchResults();
  renderTable();
  initTableViewMenus();
}

init();

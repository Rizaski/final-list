import { openModal } from "./ui.js";
import { updateVoterCandidatePledge, getVoterImageSrc } from "./voters.js";
import { getAgentsForDropdown, getCandidates } from "./settings.js";

const PAGE_SIZE = 15;
/** Pledges table: Seq, Image, Name, ID, Permanent Address, then candidate columns (Pledge column is on Door to Door). */
const BASE_PLEDGE_COLUMNS = 5;
const VISIBLE_CANDIDATES_STORAGE_KEY = "pledges-visible-candidates";

const pledgesTableBody = document.querySelector("#pledgesTable tbody");
const pledgesPaginationEl = document.getElementById("pledgesPagination");
const pledgeSearchEl = document.getElementById("pledgeSearch");
const pledgeSortEl = document.getElementById("pledgeSort");
const pledgeFilterStatusEl = document.getElementById("pledgeFilterStatus");
const pledgeFilterIslandEl = document.getElementById("pledgeFilterIsland");
const pledgeGroupByEl = document.getElementById("pledgeGroupBy");

let pledgeRows = [];
let pledgesCurrentPage = 1;

function ensureSeedData(votersContext) {
  const voters = votersContext.getAllVoters();
  pledgeRows = voters.map((v) => ({
    voterId: v.id,
    sequence: v.sequence ?? "",
    nationalId: v.nationalId ?? "",
    name: v.fullName,
    permanentAddress: v.permanentAddress || "",
    island: v.island || "",
    ballotBox: v.ballotBox ?? "",
    volunteer: v.volunteer ?? "",
    pledgeStatus: v.pledgeStatus || "undecided",
    metStatus: v.metStatus ?? "not-met",
    persuadable: v.persuadable ?? "unknown",
    pledgedAt: v.pledgedAt ?? "",
    notes: v.notes || "",
    photoUrl: v.photoUrl || "",
    candidatePledges: v.candidatePledges && typeof v.candidatePledges === "object" ? { ...v.candidatePledges } : {},
  }));
  syncPledgeFilterIsland();
}

function syncPledgeFilterIsland() {
  if (!pledgeFilterIslandEl) return;
  // Ballot box filter should be driven by ballot boxes from the voters list,
  // not island names. Use row.ballotBox as the source.
  const boxes = [...new Set(pledgeRows.map((r) => r.ballotBox || "Unassigned").filter(Boolean))].sort();
  const current = pledgeFilterIslandEl.value;
  pledgeFilterIslandEl.innerHTML =
    '<option value="all">All</option>' +
    boxes.map((b) => `<option value="${escapeHtml(b)}"${b === current ? " selected" : ""}>${escapeHtml(b)}</option>`).join("");
}

function pledgeStatusLabel(status) {
  switch (status) {
    case "yes":
      return "Yes";
    case "no":
      return "No";
    case "undecided":
      return "Undecided";
    default:
      return "Undecided";
  }
}

function pledgeStatusClass(status) {
  switch (status) {
    case "yes":
      return "pledge-pill pledge-pill--pledged";
    case "undecided":
      return "pledge-pill pledge-pill--undecided";
    default:
      return "pledge-pill pledge-pill--not-pledged";
  }
}

function getInitials(name) {
  return (name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";
}

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getFilteredSortedGroupedPledges() {
  const query = (pledgeSearchEl?.value || "").toLowerCase().trim();
  const filterStatus = pledgeFilterStatusEl?.value || "all";
  const filterIsland = pledgeFilterIslandEl?.value || "all";
  const sortBy = pledgeSortEl?.value || "sequence";
  const groupBy = pledgeGroupByEl?.value || "none";

  let list = pledgeRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (filterStatus !== "all" && row.pledgeStatus !== filterStatus) return false;
      if (filterIsland !== "all" && (row.ballotBox || "Unassigned") !== filterIsland) return false;
      if (query) {
        const searchable = [
          row.name,
          row.permanentAddress,
          row.ballotBox,
          row.notes,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!searchable.includes(query)) return false;
      }
      return true;
    });

  const cmp = (a, b) => {
    const ra = a.row;
    const rb = b.row;
    switch (sortBy) {
      case "sequence":
        return (Number(ra.sequence) || 0) - (Number(rb.sequence) || 0);
      case "name-asc":
        return (ra.name || "").localeCompare(rb.name || "", "en");
      case "name-desc":
        return (rb.name || "").localeCompare(ra.name || "", "en");
      case "id":
        return (ra.nationalId || "").localeCompare(rb.nationalId || "", "en");
      case "address":
        return (ra.permanentAddress || "").localeCompare(rb.permanentAddress || "", "en");
      case "pledge":
        return (ra.pledgeStatus || "").localeCompare(rb.pledgeStatus || "", "en");
      case "island":
        return (ra.island || "").localeCompare(rb.island || "", "en");
      case "volunteer":
        return (ra.volunteer || "").localeCompare(rb.volunteer || "", "en");
      case "met":
        return (ra.metStatus || "").localeCompare(rb.metStatus || "", "en");
      case "persuadable":
        return (ra.persuadable || "").localeCompare(rb.persuadable || "", "en");
      case "date":
        return (ra.pledgedAt || "").localeCompare(rb.pledgedAt || "", "en");
      case "notes":
        return (ra.notes || "").localeCompare(rb.notes || "", "en");
      default:
        return (ra.name || "").localeCompare(rb.name || "", "en");
    }
  };
  list.sort(cmp);

  if (groupBy === "none") {
    return list.map(({ row, index }) => ({ type: "row", row, index }));
  }
  const out = [];
  let lastKey = null;
  for (const item of list) {
    const key =
      groupBy === "island"
        ? item.row.ballotBox || "Unassigned"
        : pledgeStatusLabel(item.row.pledgeStatus);
    if (lastKey !== key) {
      lastKey = key;
      out.push({ type: "group", label: key });
    }
    out.push({ type: "row", row: item.row, index: item.index });
  }
  return out;
}

function getVisibleCandidateIds() {
  try {
    const raw = localStorage.getItem(VISIBLE_CANDIDATES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(String);
  } catch (_) {
    return null;
  }
}

function setVisibleCandidateIds(ids) {
  try {
    localStorage.setItem(VISIBLE_CANDIDATES_STORAGE_KEY, JSON.stringify(ids));
  } catch (_) {}
}

/** Candidates to show in the table: stored visible ids, or all if none stored. */
function getVisibleCandidates() {
  const all = getCandidates();
  const stored = getVisibleCandidateIds();
  if (!stored || stored.length === 0) return all;
  const set = new Set(stored);
  return all.filter((c) => set.has(String(c.id)));
}

function getPledgeTableColumnCount() {
  return BASE_PLEDGE_COLUMNS + getVisibleCandidates().length;
}

function updatePledgesTableHeader() {
  const thead = document.querySelector("#pledgesTable thead");
  if (!thead) return;
  const candidates = getVisibleCandidates();
  const candidateHeaders = candidates
    .map((c) => {
      const name = c.name || "Candidate";
      const initials = getInitials(name);
      return `<th scope="col" class="pledge-th pledge-th--candidate" title="${escapeHtml(name)}">${escapeHtml(initials)}</th>`;
    })
    .join("");
  thead.innerHTML = `
    <tr>
      <th scope="col" class="pledge-th pledge-th--sequence th-sortable" data-sort-key="sequence">Seq<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--photo">Image</th>
      <th scope="col" class="pledge-th pledge-th--id th-sortable" data-sort-key="id">ID Number<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--name th-sortable" data-sort-key="name">Name<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--address th-sortable" data-sort-key="address">Permanent Address<span class="sort-indicator"></span></th>
      ${candidateHeaders}
    </tr>
  `;
}

function renderPledgesTable() {
  updatePledgesTableHeader();
  pledgesTableBody.innerHTML = "";

  const displayList = getFilteredSortedGroupedPledges();
  const dataRows = displayList.filter((x) => x.type === "row");
  const total = dataRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pledgesCurrentPage > totalPages) pledgesCurrentPage = totalPages;
  const start = (pledgesCurrentPage - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageDataRows = dataRows.slice(start, end);
  const candidates = getVisibleCandidates();
  const colCount = getPledgeTableColumnCount();

  const pageDisplayList = [];
  let lastGroup = null;
  for (const rowItem of pageDataRows) {
    const idxInDisplay = displayList.indexOf(rowItem);
    const groupItem =
      displayList[idxInDisplay - 1]?.type === "group"
        ? displayList[idxInDisplay - 1]
        : null;
    if (groupItem && groupItem !== lastGroup) {
      pageDisplayList.push(groupItem);
      lastGroup = groupItem;
    }
    pageDisplayList.push(rowItem);
  }

  for (const item of pageDisplayList) {
    if (item.type === "group") {
      const tr = document.createElement("tr");
      tr.className = "pledges-toolbar__group-header";
      tr.innerHTML = `<td colspan="${colCount}">${escapeHtml(item.label)}</td>`;
      pledgesTableBody.appendChild(tr);
      continue;
    }
    const { row, index } = item;
    const tr = document.createElement("tr");
    tr.dataset.rowIndex = String(index);

    const rowVoter = { photoUrl: row.photoUrl, nationalId: row.nationalId, id: row.voterId };
    const photoSrc = getVoterImageSrc(rowVoter);
    const initials = getInitials(row.name);
    const photoCell = photoSrc
      ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
      : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
    const cp = row.candidatePledges || {};
    const candidateCells = candidates
      .map(
        (c) => {
          const val = cp[String(c.id)] || "undecided";
          const pillClass = pledgeStatusClass(val);
          const selId = `pledge-cand-${index}-${c.id}`;
          return `<td class="pledge-cell pledge-cell--candidate">
            <span class="${pillClass} pledge-cell__pill">
              <select id="${selId}" class="inline-select pledge-candidate-select" data-candidate-id="${escapeHtml(String(c.id))}">
                <option value="yes"${val === "yes" ? " selected" : ""}>Yes</option>
                <option value="no"${val === "no" ? " selected" : ""}>No</option>
                <option value="undecided"${val === "undecided" ? " selected" : ""}>Undecided</option>
              </select>
            </span>
          </td>`;
        }
      )
      .join("");

    tr.innerHTML = `
      <td class="pledge-cell pledge-cell--sequence">${escapeHtml(String(row.sequence ?? ""))}</td>
      <td class="pledge-cell pledge-cell--photo">${photoCell}</td>
      <td class="pledge-cell pledge-cell--id">${escapeHtml(row.nationalId || "")}</td>
      <td class="pledge-cell pledge-cell--name">${escapeHtml(row.name)}</td>
      <td class="pledge-cell pledge-cell--address">${escapeHtml(row.permanentAddress || "")}</td>
      ${candidateCells}
    `;

    pledgesTableBody.appendChild(tr);

    tr.querySelectorAll(".pledge-candidate-select").forEach((sel) => {
      const cid = sel.getAttribute("data-candidate-id");
      sel.addEventListener("change", () => {
        const status = sel.value;
        if (!row.candidatePledges) row.candidatePledges = {};
        row.candidatePledges[cid] = status;
        updateVoterCandidatePledge(row.voterId, cid, status);
        document.dispatchEvent(new CustomEvent("pledges-updated", { detail: { rows: pledgeRows } }));
      });
    });
  }

  if (pledgesPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    pledgesPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${pledgesCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${pledgesCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${pledgesCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    pledgesPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && pledgesCurrentPage > 1) pledgesCurrentPage--;
        if (btn.dataset.page === "next" && pledgesCurrentPage < totalPages) pledgesCurrentPage++;
        renderPledgesTable();
      });
    });
  }

  updatePledgeSortIndicators();
}

function updatePledgeSortIndicators() {
  const headers = document.querySelectorAll("#pledgesTable thead th.th-sortable");
  if (!headers.length) return;
  const sortBy = pledgeSortEl?.value || "sequence";
  headers.forEach((th) => {
    const key = th.getAttribute("data-sort-key");
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    th.removeAttribute("aria-sort");
    if (key === "name" && (sortBy === "name-asc" || sortBy === "name-desc")) {
      th.classList.add(sortBy === "name-asc" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "name-asc" ? "ascending" : "descending");
    } else if (sortBy === key) {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    }
  });
}

function bindPledgeTableHeaderSort() {
  const thead = document.querySelector("#pledgesTable thead");
  if (!thead) return;
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.th-sortable");
    if (!th) return;
    const key = th.getAttribute("data-sort-key");
    if (!key || !pledgeSortEl) return;
    if (key === "name") {
      pledgeSortEl.value = pledgeSortEl.value === "name-asc" ? "name-desc" : "name-asc";
    } else {
      pledgeSortEl.value = key;
    }
    pledgesCurrentPage = 1;
    renderPledgesTable();
  });
}

function csvEscape(val) {
  const s = String(val == null ? "" : val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function exportPledgesCSV() {
  const displayList = getFilteredSortedGroupedPledges();
  const dataRows = displayList.filter((x) => x.type === "row").map((x) => x.row);
  const candidates = getCandidates();
  const baseHeaders = [
    "Seq",
    "Image",
    "ID Number",
    "Name",
    "Permanent Address",
    "Pledge",
    "Ballot Box",
    "Assigned agent",
    "Met?",
    "Persuadable?",
    "Date pledged",
    "Notes",
  ];
  const candidateHeaders = candidates.map((c) => `Pledge – ${c.name || "Candidate"}`);
  const headers = [...baseHeaders, ...candidateHeaders];
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of dataRows) {
    const cp = row.candidatePledges || {};
    const base = [
      row.sequence ?? "",
      row.photoUrl || "",
      row.nationalId || "",
      row.name || "",
      row.permanentAddress || "",
      row.pledgeStatus || "",
      row.ballotBox || "",
      row.volunteer || "",
      row.metStatus || "",
      row.persuadable || "",
      row.pledgedAt || "",
      row.notes || "",
    ];
    const cand = candidates.map((c) => cp[String(c.id)] || "undecided");
    lines.push([...base, ...cand].map(csvEscape).join(","));
  }
  const csv = lines.join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pledges-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  if (window.appNotifications) {
    window.appNotifications.push({
      title: "Pledges exported",
      meta: `${dataRows.length.toLocaleString("en-MV")} rows as CSV`,
    });
  }
}

function renderCandidateVisibilityMenu() {
  const menu = document.getElementById("pledgeColumnsMenu");
  if (!menu) return;
  const all = getCandidates();
  const stored = getVisibleCandidateIds();
  const visibleSet = new Set(stored && stored.length > 0 ? stored : all.map((c) => String(c.id)));
  menu.innerHTML = `
    <div class="dropdown-menu__item" style="pointer-events:none; font-weight:600;">Show columns</div>
    ${all
      .map(
        (c) => {
          const id = String(c.id);
          const name = escapeHtml(c.name || "Candidate");
          const checked = visibleSet.has(id);
          return `<label class="dropdown-menu__item" style="cursor:pointer; display:flex; align-items:center; gap:8px;">
        <input type="checkbox" data-candidate-id="${escapeHtml(id)}" ${checked ? "checked" : ""}>
        <span>${name}</span>
      </label>`;
        }
      )
      .join("")}
  `;
  menu.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      const cid = cb.getAttribute("data-candidate-id");
      const current = getVisibleCandidateIds();
      const allIds = getCandidates().map((c) => String(c.id));
      const base = current && current.length > 0 ? current.filter((id) => allIds.includes(id)) : allIds;
      const set = new Set(base);
      if (cb.checked) set.add(cid);
      else set.delete(cid);
      const next = Array.from(set);
      setVisibleCandidateIds(next.length === allIds.length ? [] : next);
      renderPledgesTable();
    });
  });
}

function bindPledgeToolbar() {
  const resetPageAndRender = () => {
    pledgesCurrentPage = 1;
    renderPledgesTable();
  };
  pledgeSearchEl?.addEventListener("input", resetPageAndRender);
  pledgeSortEl?.addEventListener("change", resetPageAndRender);
  pledgeFilterStatusEl?.addEventListener("change", resetPageAndRender);
  pledgeFilterIslandEl?.addEventListener("change", resetPageAndRender);
  pledgeGroupByEl?.addEventListener("change", resetPageAndRender);
}

export function initPledgesModule(votersContext) {
  ensureSeedData(votersContext);
  bindPledgeToolbar();
  bindPledgeTableHeaderSort();
  renderPledgesTable();

  const exportCsvBtn = document.getElementById("pledgesExportCsvButton");
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener("click", exportPledgesCSV);
  }

  document.addEventListener("candidates-updated", () => {
    renderCandidateVisibilityMenu();
    renderPledgesTable();
  });

  renderCandidateVisibilityMenu();
  const pledgeColumnsBtn = document.getElementById("pledgeColumnsButton");
  const pledgeColumnsMenu = document.getElementById("pledgeColumnsMenu");
  if (pledgeColumnsBtn && pledgeColumnsMenu) {
    pledgeColumnsMenu.addEventListener("click", (e) => e.stopPropagation());
    pledgeColumnsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !pledgeColumnsMenu.hidden;
      pledgeColumnsMenu.hidden = open;
      pledgeColumnsBtn.setAttribute("aria-expanded", !open);
      if (!open) {
        document.addEventListener("click", closeColumnsMenuOnce);
      }
    });
  }
  function closeColumnsMenuOnce() {
    if (pledgeColumnsMenu) {
      pledgeColumnsMenu.hidden = true;
      if (pledgeColumnsBtn) pledgeColumnsBtn.setAttribute("aria-expanded", "false");
    }
    document.removeEventListener("click", closeColumnsMenuOnce);
  }

  document.addEventListener("agents-updated", () => {
    renderPledgesTable();
  });

  document.addEventListener("voters-updated", () => {
    ensureSeedData(votersContext);
    renderPledgesTable();
  });

  pledgesTableBody.addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    const index = Number(tr.dataset.rowIndex || -1);
    if (index < 0) return;
    const row = pledgeRows[index];
    const body = document.createElement("div");
    const agents = getAgentsForDropdown();
    const candidates = getCandidates();
    const cp = row.candidatePledges || {};

    body.innerHTML = `
      <div class="form-grid">
        <div class="form-group">
          <label for="pledgeEditName">Voter name</label>
          <input id="pledgeEditName" type="text" value="${escapeHtml(
            row.name
          )}" disabled>
        </div>
        <div class="form-group">
          <label for="pledgeEditIsland">Island / Ward</label>
          <input id="pledgeEditIsland" type="text" value="${escapeHtml(
            row.island
          )}" disabled>
        </div>
        <div class="form-group">
          <label for="pledgeEditAgent">Assigned agent</label>
          <select id="pledgeEditAgent">
            <option value="">Unassigned</option>
            ${agents
              .map(
                (a) =>
                  `<option value="${escapeHtml(a.name)}"${
                    a.name === row.volunteer ? " selected" : ""
                  }>${escapeHtml(a.name)}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="form-group">
          <label for="pledgeEditStatus">Overall pledge status</label>
          <select id="pledgeEditStatus">
            <option value="yes"${
              row.pledgeStatus === "yes" ? " selected" : ""
            }>Yes</option>
            <option value="no"${
              row.pledgeStatus === "no" ? " selected" : ""
            }>No</option>
            <option value="undecided"${
              row.pledgeStatus === "undecided" ? " selected" : ""
            }>Undecided</option>
          </select>
        </div>
        <div class="form-group">
          <label for="pledgeEditMet">Met during door-to-door / event?</label>
          <select id="pledgeEditMet">
            <option value="not-met"${
              row.metStatus === "not-met" ? " selected" : ""
            }>No</option>
            <option value="met"${
              row.metStatus === "met" ? " selected" : ""
            }>Yes</option>
          </select>
        </div>
        <div class="form-group">
          <label for="pledgeEditPersuadable">Persuadable?</label>
          <select id="pledgeEditPersuadable">
            <option value="unknown"${
              row.persuadable === "unknown" ? " selected" : ""
            }>Unknown</option>
            <option value="yes"${
              row.persuadable === "yes" ? " selected" : ""
            }>Yes</option>
            <option value="no"${
              row.persuadable === "no" ? " selected" : ""
            }>No</option>
          </select>
        </div>
        <div class="form-group form-group--full">
          <label for="pledgeEditNotes">Notes</label>
          <textarea id="pledgeEditNotes" rows="3">${escapeHtml(
            row.notes || ""
          )}</textarea>
        </div>
      </div>
      <div class="form-group form-group--full">
        <label>Candidate pledges</label>
        <div class="candidate-pledge-list">
          ${candidates
            .map((c) => {
              const cid = String(c.id);
              const current = cp[cid] || "undecided";
              const isYes = current === "yes";
              const isNo = current === "no";
              const isUndecided = current === "undecided";
              return `
                <div class="candidate-pledge-row" data-candidate-id="${escapeHtml(
                  cid
                )}">
                  <div class="candidate-pledge-name">${escapeHtml(
                    c.name || "Candidate"
                  )}</div>
                  <div class="pill-toggle-group">
                    <button type="button" class="pill-toggle${
                      isYes ? " pill-toggle--active" : ""
                    }" data-pledge-status="yes">Yes</button>
                    <button type="button" class="pill-toggle${
                      isNo ? " pill-toggle--active" : ""
                    }" data-pledge-status="no">No</button>
                    <button type="button" class="pill-toggle${
                      isUndecided ? " pill-toggle--active" : ""
                    }" data-pledge-status="undecided">Undecided</button>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
      <div class="form-group form-group--full">
        <label for="pledgeEditPassword">Approval password</label>
        <input id="pledgeEditPassword" type="password" class="input" autocomplete="off" placeholder="Enter password to save candidate pledges">
        <p class="helper-text">Required only if candidate pledges are changed.</p>
      </div>
    `;

    // Bind candidate pledge pill toggles (local state only until Save)
    body
      .querySelectorAll(".candidate-pledge-row")
      .forEach((rowEl) => {
        const buttons = Array.from(
          rowEl.querySelectorAll(".pill-toggle[data-pledge-status]")
        );
        buttons.forEach((btn) => {
          btn.addEventListener("click", () => {
            buttons.forEach((b) =>
              b.classList.remove("pill-toggle--active")
            );
            btn.classList.add("pill-toggle--active");
          });
        });
      });

    const footer = document.createElement("div");
    const saveBtn = document.createElement("button");
    saveBtn.className = "primary-button";
    saveBtn.textContent = "Save changes";
    footer.appendChild(saveBtn);

    saveBtn.addEventListener("click", () => {
      const agentSelect = body.querySelector("#pledgeEditAgent");
      const pledgeSelect = body.querySelector("#pledgeEditStatus");
      const metSel = body.querySelector("#pledgeEditMet");
      const persSel = body.querySelector("#pledgeEditPersuadable");
      const notesTextarea = body.querySelector("#pledgeEditNotes");
      const passwordInput = body.querySelector("#pledgeEditPassword");

      row.volunteer = (agentSelect && agentSelect.value) || "";
      row.pledgeStatus = (pledgeSelect && pledgeSelect.value) || row.pledgeStatus;
      row.metStatus = (metSel && metSel.value) || row.metStatus;
      row.persuadable = (persSel && persSel.value) || row.persuadable;
      row.notes = notesTextarea ? notesTextarea.value : row.notes;
      if (row.pledgeStatus === "yes") {
        row.pledgedAt = new Date().toISOString().slice(0, 10);
      } else if (row.pledgeStatus !== "yes") {
        row.pledgedAt = "";
      }

      const changedCandidates = [];
      body
        .querySelectorAll(".candidate-pledge-row")
        .forEach((rowEl) => {
          const cid = rowEl.getAttribute("data-candidate-id");
          if (!cid) return;
          const activeBtn = rowEl.querySelector(
            ".pill-toggle--active[data-pledge-status]"
          );
          const nextStatus =
            (activeBtn &&
              activeBtn.getAttribute("data-pledge-status")) || "undecided";
          const prevStatus =
            (row.candidatePledges && row.candidatePledges[cid]) ||
            "undecided";
          if (nextStatus !== prevStatus) {
            changedCandidates.push({ cid, nextStatus });
          }
        });

      if (changedCandidates.length > 0) {
        const pwd = (passwordInput && passwordInput.value) || "";
        if (pwd !== "PNC@2026") {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Incorrect password",
              meta: "Candidate pledges were not updated.",
            });
          }
          return;
        }
        if (!row.candidatePledges || typeof row.candidatePledges !== "object") {
          row.candidatePledges = {};
        }
        changedCandidates.forEach(({ cid, nextStatus }) => {
          row.candidatePledges[cid] = nextStatus;
          updateVoterCandidatePledge(row.voterId, cid, nextStatus);
        });
      }

      renderPledgesTable();
      document.dispatchEvent(
        new CustomEvent("pledges-updated", {
          detail: { rows: pledgeRows },
        })
      );
    });

    openModal({
      title: "Edit voter pledges",
      body,
      footer,
    });
  });

  return {
    getPledges: () => [...pledgeRows],
  };
}

export function getPledgeStatsFromPledges(scope) {
  const pledgedCount = pledgeRows.filter(
    (r) => r.pledgeStatus === "yes"
  ).length;
  return {
    pledgedCount,
  };
}


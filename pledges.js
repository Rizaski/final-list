import * as votersApi from "./voters.js";
import { getCandidates, openAddAgentModal } from "./settings.js";
import { getAgentsFromStorage } from "./agents-context.js";
import { initPledgesTableViewInColumnMenu } from "./table-view-menu.js";
import {
  compareBallotSequence,
  sequenceAsImportedFromCsv,
  compareVotersByBallotBoxThenSequenceThenName,
} from "./sequence-utils.js";

const PAGE_SIZE = 15;
/** Pledges page table: Seq, Image, ID, Name, Permanent Address, Ballot Box, Transport Required, Overall Pledge. */
const PLEDGES_TABLE_COL_COUNT = 8;
const pledgesTableBody = document.querySelector("#pledgesTable tbody");
const pledgesPaginationEl = document.getElementById("pledgesPagination");
const pledgeSearchEl = document.getElementById("pledgeSearch");
const pledgeSortEl = document.getElementById("pledgeSort");
const pledgeFilterStatusEl = document.getElementById("pledgeFilterStatus");
const pledgeFilterIslandEl = document.getElementById("pledgeFilterIsland");
const pledgeGroupByEl = document.getElementById("pledgeGroupBy");
const pledgesDetailsContent = document.getElementById("pledgesDetailsContent");
const pledgesDetailsSubtitle = document.getElementById("pledgesDetailsSubtitle");

let pledgeRows = [];
let pledgesCurrentPage = 1;
let selectedPledgeVoterId = null;

function normalizeReferendumVote(raw) {
  if (raw === "yes" || raw === "no") return raw;
  return "undecided";
}

function referendumVoteLabel(status) {
  switch (status) {
    case "yes":
      return "Yes";
    case "no":
      return "No";
    case "undecided":
    default:
      return "Undecided";
  }
}

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
    transportNeeded: v.transportNeeded === true,
    metStatus: v.metStatus ?? "not-met",
    persuadable: v.persuadable ?? "unknown",
    pledgedAt: v.pledgedAt ?? "",
    notes: v.notes || "",
    photoUrl: v.photoUrl || "",
    candidatePledges:
      v.candidatePledges && typeof v.candidatePledges === "object"
        ? { ...v.candidatePledges }
        : {},
    candidateAgentAssignments:
      v.candidateAgentAssignments && typeof v.candidateAgentAssignments === "object"
        ? { ...v.candidateAgentAssignments }
        : {},
    candidateAgentAssignmentIds:
      v.candidateAgentAssignmentIds && typeof v.candidateAgentAssignmentIds === "object"
        ? { ...v.candidateAgentAssignmentIds }
        : {},
    referendumVote: normalizeReferendumVote(v.referendumVote),
    referendumNotes: v.referendumNotes != null ? String(v.referendumNotes) : "",
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

function transportNeededPillClass(transportNeeded) {
  return transportNeeded ? "pledge-pill pledge-pill--pledged" : "pledge-pill pledge-pill--not-pledged";
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

function setupPledgeCandidateAgentDropdown({ agentSel, agentSearchInput, menuEl, getAgents, rootEl }) {
  if (!agentSel || !agentSearchInput || !menuEl) return;

  const toNorm = (s) => String(s || "").trim().toLowerCase();
  const initialsFromName = (name) => {
    const out = String(name || "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("");
    return out || "?";
  };

  const imgOnError =
    "var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';";

  const hideMenu = () => {
    menuEl.style.display = "none";
  };

  const renderMenu = () => {
    if (agentSearchInput.disabled) {
      hideMenu();
      return;
    }
    const q = toNorm(agentSearchInput.value);
    const list = (typeof getAgents === "function" ? getAgents() : [])
      .filter((a) => {
        if (!q) return true;
        const name = toNorm(a?.name);
        const nationalId = toNorm(a?.nationalId);
        const phone = toNorm(a?.phone);
        return name.includes(q) || nationalId.includes(q) || phone.includes(q);
      })
      .slice(0, 40);

    if (!list.length) {
      menuEl.innerHTML = '<div class="voter-agent-dropdown__empty">No matching agents.</div>';
      menuEl.style.display = "block";
      return;
    }

    menuEl.innerHTML = list
      .map((a) => {
        const aid = a?.id != null ? String(a.id) : "";
        const name = String(a?.name || "");
        const nationalId = String(a?.nationalId || "—");
        const phone = String(a?.phone || "—");
        const initials = initialsFromName(name);
        const photoSrc = votersApi.getVoterImageSrc({ nationalId: a?.nationalId || aid || "" });
        const photoHtml = photoSrc
          ? `<div class="avatar-cell avatar-cell--settings-agent"><img class="avatar-img" src="${escapeHtml(
              photoSrc
            )}" alt="" onerror="${imgOnError}"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(
              initials
            )}</div></div>`
          : `<div class="avatar-cell avatar-cell--settings-agent"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;

        return `<button type="button" class="voter-agent-dropdown__item" data-agent-id="${escapeHtml(
          aid
        )}" data-agent-name="${escapeHtml(name)}">
          ${photoHtml}
          <span class="voter-agent-dropdown__main">${escapeHtml(name)}</span>
          <span class="voter-agent-dropdown__meta">ID: ${escapeHtml(nationalId)} | ${escapeHtml(phone)}</span>
        </button>`;
      })
      .join("");

    menuEl.style.display = "block";
  };

  agentSearchInput.addEventListener("focus", renderMenu);
  agentSearchInput.addEventListener("input", renderMenu);

  const applyAgentFromSearch = () => {
    const q = String(agentSearchInput.value || "").trim();
    if (!q) {
      agentSel.value = "";
      agentSel.dispatchEvent(new Event("change"));
      return;
    }
    const list = (typeof getAgents === "function" ? getAgents() : []) || [];
    const exact =
      list.find((a) => String(a?.name || "").trim().toLowerCase() === q.toLowerCase()) ||
      list.find((a) => String(a?.name || "").trim().toLowerCase().includes(q.toLowerCase()));
    if (!exact) {
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Agent not found", meta: "Pick an agent from the list." });
      }
      return;
    }
    agentSearchInput.value = exact.name || "";
    agentSel.value = exact?.id != null ? String(exact.id) : "";
    agentSel.dispatchEvent(new Event("change"));
  };

  agentSearchInput.addEventListener("change", applyAgentFromSearch);

  menuEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });

  const focusOutRoot = rootEl || agentSearchInput.parentElement;
  focusOutRoot?.addEventListener("focusout", (e) => {
    const rt = e.relatedTarget;
    if (rt && focusOutRoot.contains(rt)) return;
    window.setTimeout(() => {
      const active = document.activeElement;
      if (focusOutRoot && !focusOutRoot.contains(active)) hideMenu();
    }, 0);
  });

  menuEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-agent-id]");
    if (!btn) return;
    const aid = String(btn.getAttribute("data-agent-id") || "");
    const name = String(btn.getAttribute("data-agent-name") || "");
    agentSearchInput.value = name;
    agentSel.value = aid;
    agentSel.dispatchEvent(new Event("change"));
    hideMenu();
  });
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
        return compareBallotSequence(ra.sequence, rb.sequence);
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
      case "island": {
        const boxCmp = (ra.ballotBox || "").localeCompare(rb.ballotBox || "", "en");
        if (boxCmp !== 0) return boxCmp;
        const seqCmp = compareBallotSequence(ra.sequence, rb.sequence);
        if (seqCmp !== 0) return seqCmp;
        return (ra.name || "").localeCompare(rb.name || "", "en");
      }
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

  if (groupBy === "island") {
    list.sort((a, b) =>
      compareVotersByBallotBoxThenSequenceThenName(
        { ballotBox: a.row.ballotBox, sequence: a.row.sequence, fullName: a.row.name },
        { ballotBox: b.row.ballotBox, sequence: b.row.sequence, fullName: b.row.name }
      )
    );
  }

  if (groupBy === "none") {
    return list.map(({ row, index }) => ({ type: "row", row, index }));
  }
  const out = [];
  let lastKey = null;
  for (const item of list) {
    const key =
      groupBy === "island"
        ? item.row.ballotBox || "Unassigned"
        : groupBy === "address"
          ? item.row.permanentAddress || "Unassigned"
          : pledgeStatusLabel(item.row.pledgeStatus);
    if (lastKey !== key) {
      lastKey = key;
      out.push({ type: "group", label: key });
    }
    out.push({ type: "row", row: item.row, index: item.index });
  }
  return out;
}

function getPledgeTableColumnCount() {
  return PLEDGES_TABLE_COL_COUNT;
}

function updatePledgesTableHeader() {
  const thead = document.querySelector("#pledgesTable thead");
  if (!thead) return;
  thead.innerHTML = `
    <tr>
      <th scope="col" class="pledge-th pledge-th--sequence data-table-col--seq th-sortable" data-sort-key="sequence">Seq<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--photo">Image</th>
      <th scope="col" class="pledge-th pledge-th--name data-table-col--name th-sortable" data-sort-key="name">Name<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--id th-sortable" data-sort-key="id">ID Number<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--address th-sortable" data-sort-key="address">Permanent Address<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--ballotbox th-sortable" data-sort-key="island">Ballot Box<span class="sort-indicator"></span></th>
      <th scope="col" class="pledge-th pledge-th--transport">Transportation Required</th>
      <th scope="col" class="pledge-th pledge-th--pledge th-sortable" data-sort-key="pledge">Overall Pledge<span class="sort-indicator"></span></th>
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
    const photoSrc = votersApi.getVoterImageSrc(rowVoter);
    const initials = getInitials(row.name);
    const photoCell = photoSrc
      ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
      : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
    const pledgeVal = row.pledgeStatus || "undecided";
    const pledgeClass = pledgeStatusClass(pledgeVal);
    const transportText = row.transportNeeded === true ? "Yes" : "No";

    tr.innerHTML = `
      <td class="pledge-cell pledge-cell--sequence data-table-col--seq">${escapeHtml(sequenceAsImportedFromCsv(row))}</td>
      <td class="pledge-cell pledge-cell--photo">${photoCell}</td>
      <td class="pledge-cell pledge-cell--name data-table-col--name">${escapeHtml(row.name)}</td>
      <td class="pledge-cell pledge-cell--id">${escapeHtml(row.nationalId || "")}</td>
      <td class="pledge-cell pledge-cell--address">${escapeHtml(row.permanentAddress || "")}</td>
      <td class="pledge-cell pledge-cell--ballotbox">${escapeHtml(row.ballotBox || "")}</td>
      <td class="pledge-cell pledge-cell--transport">
        ${escapeHtml(transportText)}
      </td>
      <td class="pledge-cell pledge-cell--pledge">
        <span class="${pledgeClass} door-to-door-pledge-pill">
          <select class="inline-select door-to-door-pledge" data-voter-id="${escapeHtml(String(row.voterId))}" aria-label="Overall pledge status">
            <option value="yes"${pledgeVal === "yes" ? " selected" : ""}>Yes</option>
            <option value="no"${pledgeVal === "no" ? " selected" : ""}>No</option>
            <option value="undecided"${pledgeVal === "undecided" ? " selected" : ""}>Undecided</option>
          </select>
        </span>
      </td>
    `;

    tr.dataset.voterId = String(row.voterId);
    if (selectedPledgeVoterId != null && String(selectedPledgeVoterId) === String(row.voterId)) {
      tr.classList.add("is-selected");
    }
    pledgesTableBody.appendChild(tr);

    const pledgeSel = tr.querySelector('select.door-to-door-pledge[data-voter-id]');
    pledgeSel?.addEventListener("change", () => {
      const next = pledgeSel.value || "undecided";
      // Update local row so subsequent re-renders immediately reflect the change.
      row.pledgeStatus = next;
      votersApi.updateVoterPledgeStatus(row.voterId, next);
      // Keep details panel aligned (candidate/agent panel uses row.volunteer + row.candidatePledges).
      selectedPledgeVoterId = String(row.voterId);
      renderPledgesDetailsPanel(row);
      renderPledgesTable();
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
    "Transportation Required",
    "Referendum",
    "Referendum notes",
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
      sequenceAsImportedFromCsv(row),
      row.photoUrl || "",
      row.nationalId || "",
      row.name || "",
      row.permanentAddress || "",
      row.pledgeStatus || "",
      row.ballotBox || "",
      row.transportNeeded === true ? "Yes" : "No",
      referendumVoteLabel(row.referendumVote),
      row.referendumNotes != null ? String(row.referendumNotes) : "",
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

function renderPledgesDetailsPanel(row) {
  if (!pledgesDetailsContent || !pledgesDetailsSubtitle) return;

  if (!row) {
    pledgesDetailsSubtitle.textContent = "Select a voter from the list to edit pledge status.";
    pledgesDetailsContent.innerHTML =
      `<p class="helper-text" style="padding: 12px 0;">No voter selected.</p>`;
    return;
  }

  const cp = row.candidatePledges || {};
  const candAgentMap = row.candidateAgentAssignments || {};
  const candAgentIdMap = row.candidateAgentAssignmentIds || {};
  const allCandidates = getCandidates() || [];
  const allAgents = getAgentsFromStorage();
  const agentsByCandidateId = new Map();
  for (const a of allAgents) {
    const key = String(a?.candidateId || "");
    if (!agentsByCandidateId.has(key)) agentsByCandidateId.set(key, []);
    agentsByCandidateId.get(key).push(a);
  }
  const refVote = normalizeReferendumVote(row.referendumVote);
  const refYes = refVote === "yes";
  const refNo = refVote === "no";
  const refUndecided = refVote === "undecided";

  pledgesDetailsSubtitle.textContent = `${row.name || "Voter"} • ${row.id || row.voterId}`;

  pledgesDetailsContent.innerHTML = `
    <div class="form-grid">
      <div class="form-group form-group--full pledges-referendum-box">
        <label>Referendum</label>
        <div class="pill-toggle-group pledges-referendum-pills" role="group" aria-label="Referendum vote">
          <button type="button" class="pill-toggle${
            refYes ? " pill-toggle--active" : ""
          }" data-referendum="yes">Yes</button>
          <button type="button" class="pill-toggle${
            refNo ? " pill-toggle--active" : ""
          }" data-referendum="no">No</button>
          <button type="button" class="pill-toggle${
            refUndecided ? " pill-toggle--active" : ""
          }" data-referendum="undecided">Undecided</button>
        </div>
        <div class="pledges-referendum-notes-field">
          <label class="pledges-referendum-notes-label" for="pledgesReferendumNotes">Comment</label>
          <textarea
            id="pledgesReferendumNotes"
            class="pledges-referendum-notes"
            rows="2"
            placeholder="Voter comment on referendum…"
            aria-label="Referendum comment"
          >${escapeHtml(row.referendumNotes != null ? String(row.referendumNotes) : "")}</textarea>
        </div>
      </div>
      <div class="form-group form-group--full" style="margin-top: 12px;">
        <div class="candidate-pledges-header">
          <label>Assigned agent</label>
          <label>Candidate pledges</label>
        </div>
        <div class="candidate-pledge-list" style="margin-top: 10px;">
          ${
            allCandidates.length
              ? allCandidates
                  .map((c) => {
                    const cid = String(c.id);
                    const current = cp[cid] || "undecided";
                    const isYes = current === "yes";
                    const isNo = current === "no";
                    const isUndecided = current === "undecided";
                    const candAgents = agentsByCandidateId.get(cid) || [];
                    const assignedId = candAgentIdMap[cid] != null ? String(candAgentIdMap[cid]) : "";
                    const assignedName = candAgentMap[cid] != null ? String(candAgentMap[cid]) : "";
                    const assignedAgentFromId =
                      assignedId && candAgents.length ? candAgents.find((a) => String(a?.id || "") === assignedId) : null;
                    const assignedNameFinal = assignedName || assignedAgentFromId?.name || "";

                    return `
                      <div class="candidate-pledge-row" data-candidate-id="${escapeHtml(cid)}">
                        <div class="candidate-pledge-name-box">
                          <div class="candidate-pledge-name">${escapeHtml(c.name || "Candidate")}</div>
                        </div>

                        <div class="candidate-pledge-assigned-container">
                          <div class="candidate-pledge-agentline">
                            <div class="voter-agent-dropdown pledges-candidate-agent-dropdown" data-candidate-id="${escapeHtml(cid)}">
                              <input
                                type="text"
                                class="agent-modal-voter-search-input voter-agent-dropdown__search"
                                data-candidate-id="${escapeHtml(cid)}"
                                value="${escapeHtml(assignedNameFinal)}"
                                placeholder="Search and pick agent…"
                                aria-label="Search agent from list"
                                autocomplete="off"
                                spellcheck="false"
                              />
                              <div class="voter-agent-dropdown__menu" role="listbox" aria-label="Agents"></div>
                            </div>
                            <select
                              class="agent-dropdown-select agent-dropdown-select--table candidate-agent-select"
                              data-candidate-id="${escapeHtml(cid)}"
                              data-voter-id="${escapeHtml(String(row.voterId))}"
                              aria-label="Assigned agent for candidate"
                              style="display:none"
                            >
                              <option value="">Unassigned</option>
                              ${candAgents
                                .map((a) => {
                                  const aid = a?.id != null ? String(a.id) : "";
                                  const label = a?.name != null ? String(a.name) : "";
                                  const selected =
                                    (assignedId && aid === assignedId) ||
                                    (!assignedId &&
                                      assignedNameFinal &&
                                      label.toLowerCase() === assignedNameFinal.toLowerCase())
                                      ? " selected"
                                      : "";
                                  return `<option value="${escapeHtml(aid)}"${selected}>${escapeHtml(label)}</option>`;
                                })
                                .join("")}
                            </select>
                          </div>
                          <div class="candidate-pledge-agent-add-container">
                            <button
                              type="button"
                              class="ghost-button ghost-button--small voter-details-agent-add-btn"
                              data-candidate-id="${escapeHtml(cid)}"
                              aria-label="Add new agent for candidate"
                            >
                              Add new agent…
                            </button>
                          </div>
                        </div>

                        <div class="candidate-pledge-pledges-container">
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
                      </div>
                    `;
                  })
                  .join("")
              : `<p class="helper-text">No candidates found.</p>`
          }
        </div>
      </div>
    </div>
  `;

  pledgesDetailsContent.querySelectorAll(".pledges-referendum-pills .pill-toggle[data-referendum]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-referendum") || "undecided";
      if (typeof votersApi.updateVoterReferendumVote === "function") {
        votersApi.updateVoterReferendumVote(row.voterId, next);
      }
    });
  });

  const referendumNotesEl = pledgesDetailsContent.querySelector("#pledgesReferendumNotes");
  referendumNotesEl?.addEventListener("blur", () => {
    if (typeof votersApi.updateVoterReferendumNotes !== "function") return;
    votersApi.updateVoterReferendumNotes(row.voterId, referendumNotesEl.value);
  });

  // Candidate assigned agent (auto-save)
  pledgesDetailsContent
    .querySelectorAll('select.agent-dropdown-select[data-candidate-id]')
    .forEach((sel) => {
      sel.addEventListener("change", () => {
        const cid = sel.getAttribute("data-candidate-id") || "";
        const voterId = sel.getAttribute("data-voter-id") || String(row.voterId);
        const agentId = sel.value || "";
        const agentName = agentId ? sel.options[sel.selectedIndex]?.text || "" : "";
        if (typeof votersApi.updateVoterCandidateAgentAssignment === "function") {
          votersApi.updateVoterCandidateAgentAssignment(voterId, cid, agentId, agentName);
        }
      });
    });

  // Candidate assigned agent: searchable dropdown (per candidate)
  pledgesDetailsContent
    .querySelectorAll(".pledges-candidate-agent-dropdown[data-candidate-id]")
    .forEach((rootEl) => {
      const cid = rootEl.getAttribute("data-candidate-id") || "";
      const rowEl = rootEl.closest(".candidate-pledge-row");
      const agentSel = rowEl?.querySelector(`select.candidate-agent-select[data-candidate-id="${escapeHtml(cid)}"]`);
      const agentSearchInput = rootEl.querySelector("input.agent-modal-voter-search-input");
      const menuEl = rootEl.querySelector(".voter-agent-dropdown__menu");
      const candAgentsForDropdown = agentsByCandidateId.get(cid) || [];

      setupPledgeCandidateAgentDropdown({
        agentSel,
        agentSearchInput,
        menuEl,
        rootEl,
        getAgents: () => candAgentsForDropdown,
      });
    });

  // Candidate: add new agent (scoped to that candidate)
  pledgesDetailsContent
    .querySelectorAll(".voter-details-agent-add-btn[data-candidate-id]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const cid = btn.getAttribute("data-candidate-id") || "";
        openAddAgentModal({ lockCandidateId: cid });
      });
    });

  // Candidate pledges (per candidate) (auto-save)
  pledgesDetailsContent.querySelectorAll(".candidate-pledge-row").forEach((rowEl) => {
    const cid = rowEl.getAttribute("data-candidate-id");
    if (!cid) return;
    rowEl.querySelectorAll(".pill-toggle[data-pledge-status]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextStatus = btn.getAttribute("data-pledge-status") || "undecided";
        votersApi.updateVoterCandidatePledge(row.voterId, cid, nextStatus);
      });
    });
  });
}

export function initPledgesModule(votersContext) {
  ensureSeedData(votersContext);
  bindPledgeToolbar();
  bindPledgeTableHeaderSort();
  renderPledgesTable();
  renderPledgesDetailsPanel(null);

  const infoBtn = document.getElementById("pledgesDetailsInfoBtn");
  infoBtn?.addEventListener("click", () => {
    const voterId = selectedPledgeVoterId;
    if (!voterId) return;

    if (typeof votersApi.openVoterDetailsPopup === "function") {
      votersApi.openVoterDetailsPopup(voterId);
    }
  });

  const exportCsvBtn = document.getElementById("pledgesExportCsvButton");
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener("click", exportPledgesCSV);
  }

  document.addEventListener("candidates-updated", () => {
    // Candidate changes only affect the details panel content.
    renderPledgesTable();
    if (selectedPledgeVoterId != null) {
      const row = pledgeRows.find((r) => String(r.voterId) === String(selectedPledgeVoterId));
      renderPledgesDetailsPanel(row || null);
    }
  });

  initPledgesTableViewInColumnMenu();
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
    if (selectedPledgeVoterId != null) {
      const row = pledgeRows.find((r) => String(r.voterId) === String(selectedPledgeVoterId));
      renderPledgesDetailsPanel(row || null);
    }
  });

  document.addEventListener("voters-updated", () => {
    ensureSeedData(votersContext);
    renderPledgesTable();

    if (selectedPledgeVoterId != null) {
      const row = pledgeRows.find((r) => String(r.voterId) === String(selectedPledgeVoterId));
      renderPledgesDetailsPanel(row || null);
    } else {
      renderPledgesDetailsPanel(null);
    }
  });

  pledgesTableBody?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    const voterId = tr.dataset.voterId;
    if (!voterId) return; // group header rows
    selectedPledgeVoterId = String(voterId);
    const row = pledgeRows.find((r) => String(r.voterId) === String(voterId));
    renderPledgesDetailsPanel(row || null);
    renderPledgesTable(); // ensure selection highlight updates
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


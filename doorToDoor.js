/**
 * Door to Door module: track field visits (pledge, ballot box, assigned agent, met, persuadable, date pledged, notes).
 * Table: Seq, Image, Name, ID, Permanent Address, Pledge, Ballot Box, Assigned agent, Met?, Persuadable?, Date pledged, Notes.
 */
import { getAgentsForDropdown, openAddAgentModal } from "./settings.js";
import {
  updateVoterDoorToDoorFields,
  updateVoterPledgeStatus,
  getVoterImageSrc,
} from "./voters.js";

const PAGE_SIZE = 15;
const doorToDoorTableBody = document.querySelector("#doorToDoorTable tbody");
const doorToDoorPaginationEl = document.getElementById("doorToDoorPagination");
const doorToDoorSearchEl = document.getElementById("doorToDoorSearch");
const doorToDoorSortEl = document.getElementById("doorToDoorSort");
const doorToDoorFilterStatusEl = document.getElementById("doorToDoorFilterStatus");
const doorToDoorFilterBoxEl = document.getElementById("doorToDoorFilterBox");
const doorToDoorGroupByEl = document.getElementById("doorToDoorGroupBy");
const doorToDoorAddAgentButton = document.getElementById("doorToDoorAddAgentButton");

let votersContext = null;
let doorToDoorCurrentPage = 1;

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getInitials(name) {
  return (
    (name || "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}

function pledgePillClass(status) {
  if (status === "yes") return "pledge-pill pledge-pill--pledged";
  if (status === "undecided") return "pledge-pill pledge-pill--undecided";
  return "pledge-pill pledge-pill--not-pledged";
}

function getFilteredVoters() {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const query = (doorToDoorSearchEl?.value || "").toLowerCase().trim();
  const filterStatus = doorToDoorFilterStatusEl?.value || "all";
  const filterBox = doorToDoorFilterBoxEl?.value || "all";
  const sortBy = doorToDoorSortEl?.value || "sequence";

  let list = voters
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (filterStatus !== "all" && (row.pledgeStatus || "undecided") !== filterStatus) return false;
      if (filterBox !== "all" && (row.ballotBox || "").trim() !== filterBox) return false;
      if (query) {
        const searchable = [
          row.fullName,
          row.nationalId,
          row.id,
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
    const va = a.row;
    const vb = b.row;
    switch (sortBy) {
      case "sequence":
        return (Number(va.sequence) || 0) - (Number(vb.sequence) || 0);
      case "name-asc":
        return (va.fullName || "").localeCompare(vb.fullName || "", "en");
      case "name-desc":
        return (vb.fullName || "").localeCompare(va.fullName || "", "en");
      case "id":
        return (va.nationalId || "").localeCompare(vb.nationalId || "", "en");
      case "address":
        return (va.permanentAddress || "").localeCompare(vb.permanentAddress || "", "en");
      case "pledge":
        return (va.pledgeStatus || "").localeCompare(vb.pledgeStatus || "", "en");
      case "box":
        return (va.ballotBox || "").localeCompare(vb.ballotBox || "", "en");
      case "volunteer":
        return (va.volunteer || "").localeCompare(vb.volunteer || "", "en");
      case "met":
        return (va.metStatus || "").localeCompare(vb.metStatus || "", "en");
      case "persuadable":
        return (va.persuadable || "").localeCompare(vb.persuadable || "", "en");
      case "date":
        return (va.pledgedAt || "").localeCompare(vb.pledgedAt || "", "en");
      case "notes":
        return (va.notes || "").localeCompare(vb.notes || "", "en");
      default:
        return (va.fullName || "").localeCompare(vb.fullName || "", "en");
    }
  };

  list.sort(cmp);
  return list;
}

function syncBallotBoxFilter() {
  if (!doorToDoorFilterBoxEl) return;
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const boxes = [...new Set(voters.map((v) => (v.ballotBox || "").trim()).filter(Boolean))].sort();
  const current = doorToDoorFilterBoxEl.value;
  doorToDoorFilterBoxEl.innerHTML =
    '<option value="all">All</option>' +
    boxes.map((b) => `<option value="${escapeHtml(b)}"${b === current ? " selected" : ""}>${escapeHtml(b)}</option>`).join("");
}

function renderDoorToDoorTable() {
  if (!doorToDoorTableBody) return;
  const sortAndFiltered = getFilteredVoters();
  const groupBy = doorToDoorGroupByEl?.value || "none";

  let displayList;
  if (groupBy === "none") {
    displayList = sortAndFiltered.map((x) => ({ type: "row", row: x.row }));
  } else {
    displayList = [];
    let lastKey = null;
    for (const item of sortAndFiltered) {
      const v = item.row;
      const key =
        groupBy === "box"
          ? (v.ballotBox || "Unassigned") || "Unassigned"
          : (v.pledgeStatus === "yes" ? "Yes" : v.pledgeStatus === "no" ? "No" : "Undecided");
      if (key !== lastKey) {
        lastKey = key;
        displayList.push({ type: "group", label: key });
      }
      displayList.push({ type: "row", row: v });
    }
  }

  const rowsOnly = displayList.filter((x) => x.type === "row");
  const total = rowsOnly.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (doorToDoorCurrentPage > totalPages) doorToDoorCurrentPage = totalPages;
  const start = (doorToDoorCurrentPage - 1) * PAGE_SIZE;
  const pageRows = rowsOnly.slice(start, start + PAGE_SIZE);

  doorToDoorTableBody.innerHTML = "";
  if (pageRows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="12" class="text-muted" style="text-align:center;padding:24px;">No voters. Import voters in Settings → Data, or adjust filters.</td>`;
    doorToDoorTableBody.appendChild(tr);
  } else {
    const agents = getAgentsForDropdown();

    // If grouped, we may need to insert group header rows within the current page.
    let lastGroupLabel = null;
    displayList.forEach((item) => {
      if (item.type === "group") {
        // Only render group headers that have at least one row in current page
        if (!rowsOnly.length) return;
        const label = item.label;
        // Determine if any row for this group is in the current page
        const hasRowInPage = rowsOnly.some((r, idx) => {
          if (idx < start || idx >= start + PAGE_SIZE) return false;
          if (groupBy === "box") {
            return (r.row.ballotBox || "Unassigned") === label;
          }
          const statusLabel =
            r.row.pledgeStatus === "yes"
              ? "Yes"
              : r.row.pledgeStatus === "no"
              ? "No"
              : "Undecided";
          return statusLabel === label;
        });
        if (hasRowInPage && label !== lastGroupLabel) {
          lastGroupLabel = label;
          const tr = document.createElement("tr");
          tr.className = "pledges-toolbar__group-header";
          tr.innerHTML = `<td colspan="12">${escapeHtml(label)}</td>`;
          doorToDoorTableBody.appendChild(tr);
        }
        return;
      }

      const v = item.row;
      // Only render rows in the current page slice
      const idxInRows = rowsOnly.findIndex((r) => r.row.id === v.id);
      if (idxInRows < start || idxInRows >= start + PAGE_SIZE) return;
      const tr = document.createElement("tr");
      tr.dataset.voterId = v.id;
      const pledgeStatus = v.pledgeStatus ?? "undecided";
      const volunteer = v.volunteer ?? "";
      const metStatus = v.metStatus ?? "not-met";
      const persuadable = v.persuadable ?? "unknown";
      const pledgedAt = v.pledgedAt ?? "";
      const notes = v.notes ?? "";
      const initials = getInitials(v.fullName || v.nationalId || v.id);
      const photoSrc = getVoterImageSrc({
        photoUrl: v.photoUrl,
        nationalId: v.nationalId,
        id: v.id,
      });
      const photoCell = photoSrc
        ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(
            photoSrc
          )}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(
            initials
          )}</div></div>`
        : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(
            initials
          )}</div></div>`;
      const agentOptions =
        '<option value="">Unassigned</option>' +
        agents.map((a) => `<option value="${escapeHtml(a.name)}"${a.name === volunteer ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
      tr.innerHTML = `
        <td>${escapeHtml(String(v.sequence ?? ""))}</td>
        <td>${photoCell}</td>
        <td>${escapeHtml(v.fullName || "")}</td>
        <td>${escapeHtml(v.nationalId || v.id || "")}</td>
        <td>${escapeHtml(v.permanentAddress || "")}</td>
        <td>
          <span class="${pledgePillClass(pledgeStatus)} door-to-door-pledge-pill">
            <select class="inline-select door-to-door-pledge" data-voter-id="${escapeHtml(v.id)}">
              <option value="yes"${pledgeStatus === "yes" ? " selected" : ""}>Yes</option>
              <option value="no"${pledgeStatus === "no" ? " selected" : ""}>No</option>
              <option value="undecided"${pledgeStatus === "undecided" ? " selected" : ""}>Undecided</option>
            </select>
          </span>
        </td>
        <td>${escapeHtml(v.ballotBox || "")}</td>
        <td>
          <select class="door-to-door-agent agent-dropdown-select agent-dropdown-select--inline" data-voter-id="${escapeHtml(v.id)}" data-field="volunteer" aria-label="Assigned agent">
            ${agentOptions}
          </select>
        </td>
        <td>
          <select class="inline-select door-to-door-met" data-voter-id="${escapeHtml(v.id)}" data-field="metStatus">
            <option value="not-met"${metStatus === "not-met" ? " selected" : ""}>No</option>
            <option value="met"${metStatus === "met" ? " selected" : ""}>Yes</option>
          </select>
        </td>
        <td>
          <select class="inline-select door-to-door-persuadable" data-voter-id="${escapeHtml(v.id)}" data-field="persuadable">
            <option value="unknown"${persuadable === "unknown" ? " selected" : ""}>Unknown</option>
            <option value="yes"${persuadable === "yes" ? " selected" : ""}>Yes</option>
            <option value="no"${persuadable === "no" ? " selected" : ""}>No</option>
            <option value="50%"${persuadable === "50%" ? " selected" : ""}>50%</option>
          </select>
        </td>
        <td>
          <input type="date" class="input" style="max-width:140px;" value="${pledgedAt ? pledgedAt.slice(0, 10) : ""}" data-voter-id="${escapeHtml(v.id)}" data-field="pledgedAt" placeholder="Date">
        </td>
        <td>
          <input type="text" class="pledge-notes-input" value="${escapeHtml(notes)}" placeholder="Notes" data-voter-id="${escapeHtml(v.id)}" data-field="notes">
        </td>
      `;
      doorToDoorTableBody.appendChild(tr);
    });
  }

  if (doorToDoorPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    doorToDoorPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${doorToDoorCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${doorToDoorCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${doorToDoorCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    doorToDoorPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && doorToDoorCurrentPage > 1) doorToDoorCurrentPage--;
        if (btn.dataset.page === "next" && doorToDoorCurrentPage < totalPages) doorToDoorCurrentPage++;
        renderDoorToDoorTable();
      });
    });
  }

  doorToDoorTableBody.querySelectorAll(".door-to-door-pledge").forEach((el) => {
    el.addEventListener("change", () => {
      const voterId = el.getAttribute("data-voter-id");
      const newStatus = el.value || "undecided";
      updateVoterPledgeStatus(voterId, newStatus);
      document.dispatchEvent(new CustomEvent("voters-updated"));
      document.dispatchEvent(new CustomEvent("pledges-updated"));
    });
  });
  doorToDoorTableBody.querySelectorAll(".door-to-door-agent").forEach((el) => {
    el.addEventListener("change", () => {
      const voterId = el.getAttribute("data-voter-id");
      updateVoterDoorToDoorFields(voterId, { volunteer: el.value || "" });
    });
  });
  doorToDoorTableBody.querySelectorAll(".door-to-door-met").forEach((el) => {
    el.addEventListener("change", () => {
      const voterId = el.getAttribute("data-voter-id");
      updateVoterDoorToDoorFields(voterId, { metStatus: el.value || "" });
    });
  });
  doorToDoorTableBody.querySelectorAll(".door-to-door-persuadable").forEach((el) => {
    el.addEventListener("change", () => {
      const voterId = el.getAttribute("data-voter-id");
      updateVoterDoorToDoorFields(voterId, { persuadable: el.value || "" });
    });
  });
  doorToDoorTableBody.querySelectorAll("input[data-field='pledgedAt']").forEach((el) => {
    el.addEventListener("change", () => {
      const voterId = el.getAttribute("data-voter-id");
      const val = el.value ? el.value + (el.value.length === 10 ? "" : "") : "";
      updateVoterDoorToDoorFields(voterId, { pledgedAt: val });
    });
  });
  doorToDoorTableBody.querySelectorAll("input[data-field='notes']").forEach((el) => {
    el.addEventListener("change", () => {
      const voterId = el.getAttribute("data-voter-id");
      updateVoterDoorToDoorFields(voterId, { notes: el.value || "" });
    });
  });
}

export function initDoorToDoorModule(votersContextParam) {
  votersContext = votersContextParam || null;
  syncBallotBoxFilter();
  renderDoorToDoorTable();

  doorToDoorAddAgentButton?.addEventListener("click", () => {
    openAddAgentModal({});
  });

  document.addEventListener("agents-updated", () => {
    renderDoorToDoorTable();
  });

  doorToDoorSearchEl?.addEventListener("input", () => {
    doorToDoorCurrentPage = 1;
    renderDoorToDoorTable();
  });
  doorToDoorFilterStatusEl?.addEventListener("change", () => {
    doorToDoorCurrentPage = 1;
    renderDoorToDoorTable();
  });
  doorToDoorFilterBoxEl?.addEventListener("change", () => {
    doorToDoorCurrentPage = 1;
    renderDoorToDoorTable();
  });
  doorToDoorSortEl?.addEventListener("change", () => {
    doorToDoorCurrentPage = 1;
    renderDoorToDoorTable();
  });
  doorToDoorGroupByEl?.addEventListener("change", () => {
    doorToDoorCurrentPage = 1;
    renderDoorToDoorTable();
  });

  document.addEventListener("voters-updated", () => {
    syncBallotBoxFilter();
    renderDoorToDoorTable();
  });
  document.addEventListener("agents-updated", () => {
    renderDoorToDoorTable();
  });
}

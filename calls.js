import { openModal, closeModal } from "./ui.js";
import { updateVoterDoorToDoorFields } from "./voters.js";

const PAGE_SIZE = 15;

const callsTableBody = document.querySelector("#callsTable tbody");
const addCallButton = document.getElementById("addCallButton");
const callsPaginationEl = document.getElementById("callsPagination");
const callsSearchEl = document.getElementById("callsSearch");
const callsFilterStatusEl = document.getElementById("callsFilterStatus");
const callsFilterOutcomeEl = document.getElementById("callsFilterOutcome");
const callsGroupByEl = document.getElementById("callsGroupBy");

// Dynamic calls collection – one row per voter when seeded.
let calls = [];
let callsCurrentPage = 1;

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function seedCalls(votersContext) {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  calls = voters.map((v, index) => ({
    id: index + 1,
    voterId: v.id,
    voterName: v.fullName,
    phone: v.phone,
    nationalId: v.nationalId,
    permanentAddress: v.permanentAddress,
    caller: "Call team",
    type: "Pledge confirmation",
    scheduledAt: new Date().toISOString().slice(0, 16),
    status: "pending",
    outcome: "not-reached",
    persuadable: "unknown",
    // Keep in sync with Door to Door notes (stored on voter record).
    notes: v.notes || "",
  }));
}

function syncCallNotesFromVoters(votersContext) {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const notesByVoterId = new Map(
    voters.map((v) => [String(v.id), String(v.notes || "")])
  );
  calls.forEach((call) => {
    const voterId = String(call.voterId || "");
    if (!voterId) return;
    if (notesByVoterId.has(voterId)) {
      call.notes = notesByVoterId.get(voterId) || "";
    }
  });
}

function callStatusLabel(status) {
  if (status === "completed") return "Completed";
  if (status === "in-progress") return "In progress";
  return "Pending";
}

function outcomeLabel(outcome) {
  switch (outcome) {
    case "supportive":
      return "Supportive";
    case "opposed":
      return "Opposed";
    case "no-answer":
      return "No answer";
    case "not-interested":
      return "Not interested";
    default:
      return "Not reached";
  }
}

function getFilteredSortedCalls() {
  const query = (callsSearchEl?.value || "").toLowerCase().trim();
  const filterStatus = callsFilterStatusEl?.value || "all";
  const filterOutcome = callsFilterOutcomeEl?.value || "all";
  const groupBy = callsGroupByEl?.value || "none";

  let list = calls.filter((call) => {
    if (filterStatus !== "all" && call.status !== filterStatus) return false;
    if (filterOutcome !== "all" && call.outcome !== filterOutcome) return false;
    if (query) {
      const searchable = [
        call.voterName,
        call.phone,
        call.notes,
        call.caller,
        call.nationalId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(query)) return false;
    }
    return true;
  });

  list = list.slice().sort((a, b) => {
    const dateDiff = new Date(a.scheduledAt) - new Date(b.scheduledAt);
    if (groupBy === "status") {
      const ka = callStatusLabel(a.status);
      const kb = callStatusLabel(b.status);
      if (ka !== kb) return ka.localeCompare(kb, "en");
      return dateDiff;
    }
    if (groupBy === "outcome") {
      const ka = outcomeLabel(a.outcome);
      const kb = outcomeLabel(b.outcome);
      if (ka !== kb) return ka.localeCompare(kb, "en");
      return dateDiff;
    }
    if (groupBy === "address") {
      const ka = a.permanentAddress || "No address";
      const kb = b.permanentAddress || "No address";
      if (ka !== kb) return ka.localeCompare(kb, "en");
      return dateDiff;
    }
    return dateDiff;
  });

  if (groupBy === "none") {
    return list.map((call) => ({ type: "row", call }));
  }

  const grouped = [];
  let lastKey = null;
  list.forEach((call) => {
    let key;
    if (groupBy === "status") {
      key = callStatusLabel(call.status);
    } else if (groupBy === "outcome") {
      key = outcomeLabel(call.outcome);
    } else if (groupBy === "address") {
      key = call.permanentAddress || "No address";
    }
    if (key !== lastKey) {
      lastKey = key;
      grouped.push({ type: "group", label: key });
    }
    grouped.push({ type: "row", call });
  });
  return grouped;
}

function renderCallsTable() {
  callsTableBody.innerHTML = "";
  const displayList = getFilteredSortedCalls();
  const dataRows = displayList.filter((x) => x.type === "row");
  const total = dataRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (callsCurrentPage > totalPages) callsCurrentPage = totalPages;
  const start = (callsCurrentPage - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageDataRows = dataRows.slice(start, end);

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

  pageDisplayList.forEach((item) => {
    if (item.type === "group") {
      const tr = document.createElement("tr");
      tr.className = "list-toolbar__group-header";
      tr.innerHTML = `<td colspan="12">${escapeHtml(item.label)}</td>`;
      callsTableBody.appendChild(tr);
      return;
    }
    const call = item.call;
    const tr = document.createElement("tr");
    tr.dataset.callId = String(call.id);
    if (call.status === "completed") {
      tr.classList.add("call-row--completed");
    } else if (call.status === "in-progress") {
      tr.classList.add("call-row--in-progress");
    } else {
      tr.classList.add("call-row--pending");
    }

    tr.innerHTML = `
      <td class="data-table-col--name">${escapeHtml(call.voterName)}</td>
      <td>${escapeHtml(call.phone || "")}</td>
      <td>${escapeHtml(call.nationalId || "")}</td>
      <td>${escapeHtml(call.permanentAddress || "")}</td>
      <td>
        <input
          type="text"
          class="table-cell-input calls-table-cell-input"
          data-call-field="caller"
          value="${escapeHtml(call.caller || "")}"
        >
      </td>
      <td>
        <select class="calls-table-select" data-call-field="type">
          <option value="Pledge confirmation"${
            call.type === "Pledge confirmation" ? " selected" : ""
          }>Pledge confirmation</option>
          <option value="Issue follow-up"${
            call.type === "Issue follow-up" ? " selected" : ""
          }>Issue follow-up</option>
          <option value="Event invitation"${
            call.type === "Event invitation" ? " selected" : ""
          }>Event invitation</option>
        </select>
      </td>
      <td>
        <input
          type="datetime-local"
          class="table-cell-input calls-table-cell-input calls-table-cell-input--datetime"
          data-call-field="scheduledAt"
          value="${escapeHtml(call.scheduledAt)}"
        >
      </td>
      <td>
        <select class="calls-table-select" data-call-field="status">
          <option value="pending"${
            call.status === "pending" ? " selected" : ""
          }>Pending</option>
          <option value="in-progress"${
            call.status === "in-progress" ? " selected" : ""
          }>In progress</option>
          <option value="completed"${
            call.status === "completed" ? " selected" : ""
          }>Completed</option>
        </select>
      </td>
      <td>
        <select class="calls-table-select" data-call-field="outcome">
          <option value="not-reached"${
            call.outcome === "not-reached" ? " selected" : ""
          }>Not reached</option>
          <option value="supportive"${
            call.outcome === "supportive" ? " selected" : ""
          }>Supportive</option>
          <option value="opposed"${
            call.outcome === "opposed" ? " selected" : ""
          }>Opposed</option>
          <option value="no-answer"${
            call.outcome === "no-answer" ? " selected" : ""
          }>No answer</option>
          <option value="not-interested"${
            call.outcome === "not-interested" ? " selected" : ""
          }>Not interested</option>
        </select>
      </td>
      <td>
        <select class="calls-table-select" data-call-field="persuadable">
          <option value="unknown"${
            call.persuadable === "unknown" ? " selected" : ""
          }>Unknown</option>
          <option value="yes"${
            call.persuadable === "yes" ? " selected" : ""
          }>Yes</option>
          <option value="no"${
            call.persuadable === "no" ? " selected" : ""
          }>No</option>
        </select>
      </td>
      <td>
        <input
          type="text"
          class="table-cell-input calls-table-cell-input"
          data-call-field="notes"
          value="${escapeHtml(call.notes || "")}"
          placeholder="Add comment (optional)"
        >
      </td>
      <td></td>
    `;

    callsTableBody.appendChild(tr);
  });

  if (callsPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    callsPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${callsCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${callsCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${callsCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    callsPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && callsCurrentPage > 1) callsCurrentPage--;
        if (btn.dataset.page === "next" && callsCurrentPage < totalPages) callsCurrentPage++;
        renderCallsTable();
      });
    });
  }
}

function bindCallsToolbar() {
  const go = () => {
    callsCurrentPage = 1;
    renderCallsTable();
  };
  callsSearchEl?.addEventListener("input", go);
  callsFilterStatusEl?.addEventListener("change", go);
  callsFilterOutcomeEl?.addEventListener("change", go);
   callsGroupByEl?.addEventListener("change", go);
}

export function initCallsModule(votersContext) {
  seedCalls(votersContext);
  syncCallNotesFromVoters(votersContext);
  bindCallsToolbar();
  renderCallsTable();

  document.addEventListener("voters-updated", () => {
    syncCallNotesFromVoters(votersContext);
    renderCallsTable();
  });

  // Inline editing: update call record when dropdowns / inputs change.
  callsTableBody.addEventListener("change", (e) => {
    const target = e.target;
    const field = target.getAttribute("data-call-field");
    if (!field) return;
    const row = target.closest("tr");
    if (!row) return;
    const id = Number(row.dataset.callId);
    const call = calls.find((c) => c.id === id);
    if (!call) return;
    call[field] = target.value;
    if (field === "notes" && call.voterId) {
      // Keep door-to-door notes in sync with calls notes for this voter.
      updateVoterDoorToDoorFields(call.voterId, { notes: call.notes || "" });
    }
    // Re-render when status changes so row highlighting updates
    if (field === "status") {
      renderCallsTable();
    }
  });

  callsTableBody.addEventListener("input", (e) => {
    const target = e.target;
    const field = target.getAttribute("data-call-field");
    if (!field) return;
    const row = target.closest("tr");
    if (!row) return;
    const id = Number(row.dataset.callId);
    const call = calls.find((c) => c.id === id);
    if (!call) return;
    call[field] = target.value;
    if (field === "notes" && call.voterId) {
      updateVoterDoorToDoorFields(call.voterId, { notes: call.notes || "" });
    }
  });

  return {
    getCalls: () => [...calls],
  };
}


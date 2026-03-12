/**
 * Door to Door module: track field visits (pledge, ballot box, assigned agent, met, persuadable, date pledged, notes).
 * Table: Seq, Name, ID, Permanent Address, Pledge, Ballot Box, Assigned agent, Met?, Persuadable?, Date pledged, Notes.
 */
import { getAgents } from "./settings.js";
import { updateVoterDoorToDoorFields, updateVoterPledgeStatus } from "./voters.js";

const PAGE_SIZE = 15;
const doorToDoorTableBody = document.querySelector("#doorToDoorTable tbody");
const doorToDoorPaginationEl = document.getElementById("doorToDoorPagination");
const doorToDoorSearchEl = document.getElementById("doorToDoorSearch");
const doorToDoorFilterBoxEl = document.getElementById("doorToDoorFilterBox");

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

function pledgePillClass(status) {
  if (status === "yes") return "pledge-pill pledge-pill--pledged";
  if (status === "undecided") return "pledge-pill pledge-pill--undecided";
  return "pledge-pill pledge-pill--not-pledged";
}

function getFilteredVoters() {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const query = (doorToDoorSearchEl?.value || "").toLowerCase().trim();
  const filterBox = doorToDoorFilterBoxEl?.value || "all";
  let list = voters;
  if (filterBox !== "all") {
    list = list.filter((v) => (v.ballotBox || "").trim() === filterBox);
  }
  if (query) {
    list = list.filter((v) => {
      const searchable = [
        v.fullName,
        v.nationalId,
        v.id,
        v.permanentAddress,
        v.ballotBox,
        v.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }
  return list.sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
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
  const list = getFilteredVoters();
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (doorToDoorCurrentPage > totalPages) doorToDoorCurrentPage = totalPages;
  const start = (doorToDoorCurrentPage - 1) * PAGE_SIZE;
  const pageVoters = list.slice(start, start + PAGE_SIZE);

  doorToDoorTableBody.innerHTML = "";
  if (pageVoters.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="11" class="text-muted" style="text-align:center;padding:24px;">No voters. Import voters in Settings → Data, or adjust filters.</td>`;
    doorToDoorTableBody.appendChild(tr);
  } else {
    const agents = getAgents();
    pageVoters.forEach((v) => {
      const tr = document.createElement("tr");
      tr.dataset.voterId = v.id;
      const pledgeStatus = v.pledgeStatus ?? "undecided";
      const volunteer = v.volunteer ?? "";
      const metStatus = v.metStatus ?? "not-met";
      const persuadable = v.persuadable ?? "unknown";
      const pledgedAt = v.pledgedAt ?? "";
      const notes = v.notes ?? "";
      const agentOptions =
        '<option value="">Unassigned</option>' +
        agents.map((a) => `<option value="${escapeHtml(a.name)}"${a.name === volunteer ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
      tr.innerHTML = `
        <td>${escapeHtml(String(v.sequence ?? ""))}</td>
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
          <select class="inline-select door-to-door-agent" data-voter-id="${escapeHtml(v.id)}" data-field="volunteer">
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

  doorToDoorSearchEl?.addEventListener("input", () => {
    doorToDoorCurrentPage = 1;
    renderDoorToDoorTable();
  });
  doorToDoorFilterBoxEl?.addEventListener("change", () => {
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

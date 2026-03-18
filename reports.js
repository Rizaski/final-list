import { getPledgeByBallotBox, getVoterImageSrc } from "./voters.js";
import { getVotedVoterIds, getVotedTimeMarked } from "./zeroDay.js";
import { openModal, closeModal } from "./ui.js";
import { getCandidates, getAgents } from "./settings.js";
import { firebaseInitPromise } from "./firebase.js";

const REPORT_PLEDGED_PAGE_SIZE = 20;

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderBarSet(container, items) {
  if (!container) return;
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = '<div class="helper-text">No data yet.</div>';
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "chart-bar";
    row.innerHTML = `
      <div class="chart-bar__label">${escapeHtml(item.label)}</div>
      <div class="chart-bar__track">
        <div class="chart-bar__fill chart-bar__fill--primary" style="width:${item.value}%"></div>
      </div>
      <div class="chart-bar__value">${item.value.toFixed(1)}%</div>
    `;
    container.appendChild(row);
  });
}

function renderPledgePie(container, { yesPct, noPct, undecidedPct, yesCount = 0, noCount = 0, undecidedCount = 0 }) {
  if (!container) return;
  const total = yesPct + noPct + undecidedPct;
  if (total === 0) {
    container.innerHTML =
      '<div class="helper-text">No pledge data yet. Import voters or update pledges to see distribution.</div>';
    return;
  }

  const yesDeg = (yesPct / 100) * 360;
  const noDeg = (noPct / 100) * 360;
  const undecidedDeg = 360 - yesDeg - noDeg;

  container.innerHTML = `
    <div class="pie-chart">
      <div class="pie-chart__circle"></div>
      <div class="pie-chart__legend">
        <div class="pie-chart__legend-item">
          <span class="pie-chart__legend-color" style="background: var(--color-pledged);"></span>
          Yes – ${yesCount.toLocaleString("en-MV")} (${yesPct.toFixed(1)}%)
        </div>
        <div class="pie-chart__legend-item">
          <span class="pie-chart__legend-color" style="background: var(--color-not-pledged);"></span>
          No – ${noCount.toLocaleString("en-MV")} (${noPct.toFixed(1)}%)
        </div>
        <div class="pie-chart__legend-item">
          <span class="pie-chart__legend-color" style="background: var(--color-undecided);"></span>
          Undecided – ${undecidedCount.toLocaleString("en-MV")} (${undecidedPct.toFixed(1)}%)
        </div>
      </div>
    </div>
  `;

  const circle = container.querySelector(".pie-chart__circle");
  if (circle) {
    circle.style.background = `conic-gradient(
      var(--color-pledged) 0deg ${yesDeg}deg,
      var(--color-not-pledged) ${yesDeg}deg ${yesDeg + noDeg}deg,
      var(--color-undecided) ${yesDeg + noDeg}deg 360deg
    )`;
  }
}

function buildDetailTable(columns, rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr>" + columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("") + "</tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${columns.length}" class="text-muted" style="text-align:center;padding:16px;">No data.</td></tr>`;
  } else {
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join("");
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// Rich voter detail table used in Reports → View details (same columns as Candidate pledge summary → View pledged voters)
function buildVoterDetailTable(voters) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Seq</th>
        <th>Image</th>
        <th>ID Number</th>
        <th>Name</th>
        <th>Permanent Address</th>
        <th>Pledge</th>
        <th>Ballot box</th>
        <th>Assigned agent</th>
        <th>Phone</th>
        <th>Island</th>
        <th>Voted</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  voters.forEach((v) => {
    const initials =
      (v.fullName || "")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() || "")
        .join("") || "?";
    const photoSrc = getVoterImageSrc(v);
    const photoCell = photoSrc
      ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(
          photoSrc
        )}" alt="" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(
          initials
        )}</div></div>`
      : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(
          initials
        )}</div></div>`;
    const pledgeStatus = v.pledgeStatus ?? "undecided";
    const pledgeClass =
      pledgeStatus === "yes"
        ? "pledge-pill pledge-pill--pledged"
        : pledgeStatus === "undecided"
        ? "pledge-pill pledge-pill--undecided"
        : "pledge-pill pledge-pill--not-pledged";
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
          return `<span class="pledge-pill pledge-pill--pledged" title="${escapeHtml(
            formatted
          )}">Voted</span>`;
        })()
      : '<span class="text-muted">—</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${v.sequence ?? ""}</td>
      <td>${photoCell}</td>
      <td>${escapeHtml(v.nationalId ?? "")}</td>
      <td>${escapeHtml(v.fullName ?? v.id ?? "—")}</td>
      <td>${escapeHtml(v.permanentAddress ?? "")}</td>
      <td><span class="${pledgeClass}">${pledgeStatus === "yes" ? "Yes" : pledgeStatus === "no" ? "No" : "Undecided"}</span></td>
      <td>${escapeHtml((v.ballotBox || "").trim() || "—")}</td>
      <td>${escapeHtml(v.volunteer ?? "")}</td>
      <td>${escapeHtml(v.phone ?? "")}</td>
      <td>${escapeHtml(v.island ?? "")}</td>
      <td class="voted-status-cell">${votedCell}</td>
    `;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

function renderCandidatePledgeSummary(container, voters) {
  if (!container) return;
  const allCandidates = getCandidates();
  const totalVoters = voters.length;

  if (!allCandidates.length) {
    container.innerHTML =
      '<div class="helper-text">No candidates configured yet. Add candidates in Settings → Candidates to see pledge breakdown.</div>';
    return;
  }

  if (totalVoters === 0) {
    container.innerHTML =
      '<div class="helper-text">No voters in the system yet. Import voters to see candidate pledge statistics.</div>';
    return;
  }

  const rows = allCandidates.map((cand) => {
    const id = String(cand.id);
    let pledgedCount = 0;
    for (const v of voters) {
      const cp = v.candidatePledges || {};
      if (cp[id] === "yes") pledgedCount += 1;
    }
    const pledgePct =
      totalVoters === 0 ? 0 : (pledgedCount / totalVoters) * 100;
    return {
      id,
      name: cand.name || `Candidate ${id}`,
      candidateNumber: cand.candidateNumber || "",
      pledgedCount,
      pledgePct,
    };
  });

  const hasAnyPledges = rows.some((r) => r.pledgedCount > 0);
  if (!hasAnyPledges) {
    container.innerHTML =
      '<div class="helper-text">No candidate-specific pledges recorded yet. Use the Pledges module to assign pledges per candidate.</div>';
    return;
  }

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Candidate</th>
      <th>Candidate no.</th>
      <th>Pledged voters</th>
      <th>Pledge %</th>
      <th></th>
    </tr>
  `;
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  rows
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "en"))
    .forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.candidateNumber)}</td>
        <td>${row.pledgedCount.toLocaleString("en-MV")}</td>
        <td>${row.pledgePct.toFixed(1)}%</td>
        <td style="text-align:right;">
          <button type="button" class="ghost-button ghost-button--small" data-report-candidate-id="${escapeHtml(
            row.id
          )}">View pledged voters</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

  table.appendChild(tbody);
  container.innerHTML = "";
  container.appendChild(table);
}

export function initReportsModule({ votersContext, pledgesContext, eventsContext }) {
  const pledgeChart = document.getElementById("reportsPledgeChart");
  const supportChart = document.getElementById("reportsSupportChart");
  const registrationChart = document.getElementById("reportsRegistrationChart");
  const boxPledgeChart = document.getElementById("reportsBoxPledgeChart");
  const eventChart = document.getElementById("reportsEventChart");
  const candidateSummaryEl = document.getElementById("reportsCandidatePledgeSummary");
  const reportsModule = document.getElementById("module-reports");

  function openReportDetails(reportType) {
    const voters = votersContext.getAllVoters();
    const events = eventsContext.getEvents();
    let title = "";
    // Use the same inner layout shell as the pledged voters window for consistent styling
    const body = document.createElement("div");
    body.className = "modal-body-inner";

    if (reportType === "pledge-by-island") {
      const byBox = voters
        .filter((v) => (v.ballotBox || "").trim())
        .slice()
        .sort((a, b) => (a.ballotBox || "").localeCompare(b.ballotBox || "", "en"));
      title = "Pledge by ballot box – voters";
      body.appendChild(buildVoterDetailTable(byBox));
    } else if (reportType === "pledge-pie") {
      const byPledge = voters
        .slice()
        .sort((a, b) => (a.pledgeStatus || "").localeCompare(b.pledgeStatus || "", "en"));
      title = "Pledge distribution – voters";
      body.appendChild(buildVoterDetailTable(byPledge));
    } else if (reportType === "box-pledge") {
      const votedIds = getVotedVoterIds();
      const pledgedAndVoted = voters
        .filter(
          (v) => (v.ballotBox || "").trim() && v.pledgeStatus === "yes" && votedIds.has(v.id)
        )
        .slice()
        .sort((a, b) => (a.ballotBox || "").localeCompare(b.ballotBox || "", "en"));
      title = "Box-wise pledge – voters who pledged and have voted";
      body.appendChild(buildVoterDetailTable(pledgedAndVoted));
    } else if (reportType === "support") {
      const bySupport = voters
        .slice()
        .sort((a, b) => (a.supportStatus || "").localeCompare(b.supportStatus || "", "en"));
      title = "Support distribution – voters";
      body.appendChild(buildVoterDetailTable(bySupport));
    } else if (reportType === "events") {
      const sorted = [...events].sort(
        (a, b) => new Date(a.dateTime || 0) - new Date(b.dateTime || 0)
      );
      const formatDt = (dt) => {
        if (!dt) return "–";
        return new Date(dt).toLocaleString("en-MV", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        });
      };
      const rows = sorted.map((ev) => [
        ev.name || "–",
        ev.location || "–",
        ev.scope || "–",
        formatDt(ev.dateTime),
        ev.team || "–",
        ev.expectedAttendees ?? "–",
      ]);
      title = "Event participation – details";
      body.appendChild(buildDetailTable(
        ["Event", "Location", "Scope", "Date & time", "Team", "Expected attendees"],
        rows
      ));
    }

    if (!title) return;
    const footer = document.createElement("div");
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ghost-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeModal);
    footer.appendChild(closeBtn);
    openModal({ title, body, footer });
  }

  function pledgePillClass(status) {
    if (status === "yes") return "pledge-pill pledge-pill--pledged";
    if (status === "undecided") return "pledge-pill pledge-pill--undecided";
    return "pledge-pill pledge-pill--not-pledged";
  }

  function openCandidatePledgedVoters(candidateId) {
    if (!candidateId) return;
    const allVoters = votersContext.getAllVoters();
    const baseList = allVoters.filter((v) => {
      const cp = v.candidatePledges || {};
      return cp[String(candidateId)] === "yes";
    });
    const candidates = getCandidates();
    const agents = getAgents();
    // Candidate-specific "assigned agent" should not affect global voter volunteer assignments.
    const assignedAgentStorageKey = `candidatePledgedAgentAssignments:v2:${String(candidateId)}`;
    let assignedByVoterId = {};
    try {
      const raw = localStorage.getItem(assignedAgentStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") assignedByVoterId = parsed;
      }
    } catch (_) {}
    // Important: do NOT prefill from global `voter.volunteer`.
    // Candidate pledges are supposed to be independent per candidate list,
    // even when the same voter appears in multiple candidates' pledged lists.
    const candidate = candidates.find((c) => String(c.id) === String(candidateId));
    const title = candidate
      ? `Pledged voters – ${candidate.name || candidateId}`
      : "Pledged voters – Candidate";

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
      </div>
    `;
    body.appendChild(toolbar);

    const tableWrap = document.createElement("div");
    tableWrap.className = "table-wrapper";
    const table = document.createElement("table");
    table.className = "data-table";
    table.id = "reportPledgedTable";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Seq</th>
          <th>Image</th>
          <th>ID Number</th>
          <th>Name</th>
          <th>Permanent Address</th>
          <th>Pledge</th>
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

    const tbody = table.querySelector("#reportPledgedTableBody");
    const COL_COUNT = 11;
    let currentPage = 1;

    function getFilteredSortedGrouped() {
      const query = (body.querySelector("#reportPledgedSearch")?.value || "").toLowerCase().trim();
      const filterPledge = body.querySelector("#reportPledgedFilterPledge")?.value || "all";
      const filterBox = body.querySelector("#reportPledgedFilterBox")?.value || "all";
      const sortBy = body.querySelector("#reportPledgedSort")?.value || "sequence";
      const groupBy = body.querySelector("#reportPledgedGroupBy")?.value || "none";

      let list = baseList.filter((v) => {
        if (filterPledge !== "all" && (v.pledgeStatus || "undecided") !== filterPledge) return false;
        if (filterBox !== "all" && (v.ballotBox || "").trim() !== filterBox) return false;
        if (query) {
          const s = [v.fullName, v.nationalId, v.id, v.permanentAddress, v.ballotBox, v.phone, v.island].filter(Boolean).join(" ").toLowerCase();
          if (!s.includes(query)) return false;
        }
        return true;
      });

      const cmp = (a, b) => {
        switch (sortBy) {
          case "sequence": return (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
          case "name-desc": return (b.fullName || "").localeCompare(a.fullName || "", "en");
          case "name-asc": return (a.fullName || "").localeCompare(b.fullName || "", "en");
          case "id": return (a.nationalId || "").localeCompare(b.nationalId || "", "en");
          case "address": return (a.permanentAddress || "").localeCompare(b.permanentAddress || "", "en");
          case "pledge": return (a.pledgeStatus || "").localeCompare(b.pledgeStatus || "", "en");
          case "box": return (a.ballotBox || "").localeCompare(b.ballotBox || "", "en");
          default: return (a.fullName || "").localeCompare(b.fullName || "", "en");
        }
      };
      list = list.slice().sort(cmp);

      if (groupBy === "none") return list.map((v) => ({ type: "row", voter: v }));
      const out = [];
      let lastKey = null;
      const getKey = (v) => groupBy === "box" ? (v.ballotBox || "Unassigned") : (v.pledgeStatus === "yes" ? "Yes" : v.pledgeStatus === "no" ? "No" : "Undecided");
      list.forEach((v) => {
        const key = getKey(v);
        if (key !== lastKey) { out.push({ type: "group", label: key }); lastKey = key; }
        out.push({ type: "row", voter: v });
      });
      return out;
    }

    function renderReportTable() {
      const displayList = getFilteredSortedGrouped();
      const rowsOnly = displayList.filter((x) => x.type === "row");
      const total = rowsOnly.length;
      const totalPages = Math.max(1, Math.ceil(total / REPORT_PLEDGED_PAGE_SIZE));
      if (currentPage > totalPages) currentPage = totalPages;
      const start = (currentPage - 1) * REPORT_PLEDGED_PAGE_SIZE;
      const pageRows = rowsOnly.slice(start, start + REPORT_PLEDGED_PAGE_SIZE);

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
          const initials = (v.fullName || "").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "?";
          const photoSrc = getVoterImageSrc(v);
          const photoCell = photoSrc
            ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
            : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
          const pledgeStatus = v.pledgeStatus ?? "undecided";
          const timeMarked = getVotedTimeMarked(v.id);
          const votedCell = timeMarked
            ? (() => {
                const d = new Date(timeMarked);
                const formatted = d.toLocaleString("en-MV", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
                return `<span class="pledge-pill pledge-pill--pledged" title="${escapeHtml(formatted)}">Voted</span>`;
              })()
            : '<span class="text-muted">—</span>';
          const assignedAgentName = assignedByVoterId[String(v.id)] || "";
          const agentOptions =
            '<option value="">Unassigned</option>' +
            agents.map((a) => `<option value="${escapeHtml(a.name)}"${a.name === assignedAgentName ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td>${v.sequence ?? ""}</td>
            <td>${photoCell}</td>
            <td>${escapeHtml(v.nationalId ?? "")}</td>
            <td>${escapeHtml(v.fullName ?? "")}</td>
            <td>${escapeHtml(v.permanentAddress ?? "")}</td>
            <td><span class="${pledgePillClass(pledgeStatus)}">${pledgeStatus === "yes" ? "Yes" : pledgeStatus === "no" ? "No" : "Undecided"}</span></td>
            <td>${escapeHtml((v.ballotBox || "").trim() || "—")}</td>
            <td><select class="inline-select report-pledged-agent" data-voter-id="${escapeHtml(v.id)}">${agentOptions}</select></td>
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
      if (el) el.addEventListener(el.id === "reportPledgedSearch" ? "input" : "change", () => { currentPage = 1; renderReportTable(); });
    });

    body.addEventListener("change", (e) => {
      if (e.target.matches(".report-pledged-agent")) {
        const voterId = e.target.getAttribute("data-voter-id");
        if (voterId) {
          assignedByVoterId[String(voterId)] = e.target.value || "";
          try {
            localStorage.setItem(assignedAgentStorageKey, JSON.stringify(assignedByVoterId));
          } catch (_) {}
        }
      }
    });

    renderReportTable();

    const footer = document.createElement("div");
    footer.style.display = "flex";
    footer.style.flexWrap = "wrap";
    footer.style.gap = "10px";
    footer.style.alignItems = "center";
    footer.style.justifyContent = "space-between";

    const shareLinkBtn = document.createElement("button");
    shareLinkBtn.type = "button";
    shareLinkBtn.className = "ghost-button";
    shareLinkBtn.textContent = "Share link";
    shareLinkBtn.addEventListener("click", async () => {
      const api = await firebaseInitPromise;
      if (!api.ready || !api.setPledgedReportShareFs) {
        alert("Sharing is not available. Check your connection and try again.");
        return;
      }
      const token = "pr-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now().toString(36);
      const voters = baseList.map((v) => {
        const assignedAgent = assignedByVoterId[String(v.id)] || "";
        // Keep this payload as small as possible because Firestore rules enforce a size limit.
        const out = {
          sequence: v.sequence,
          fullName: v.fullName,
          nationalId: v.nationalId,
          permanentAddress: v.permanentAddress,
          ballotBox: (v.ballotBox || "").trim(),
          phone: v.phone,
          island: v.island,
        };
        if (assignedAgent) out.assignedAgent = assignedAgent;
        return out;
      });
      try {
        await api.setPledgedReportShareFs(token, {
          candidateId,
          candidateName: candidate ? (candidate.name || candidateId) : String(candidateId),
          voters,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[Reports] Failed creating pledged voters share doc", err);
        alert(`Could not create pledge voters share link: ${err?.message || String(err)}`);
        return;
      }
      // Build URL robustly regardless of whether index.html is at the web root or a subfolder.
      const urlObj = new URL("pledged-report-view.html", window.location.href);
      urlObj.searchParams.set("token", token);
      const url = urlObj.toString();
      const shareBody = document.createElement("div");
      shareBody.innerHTML = `
        <p class="helper-text">Anyone with this link can view the pledged voters list (read-only).</p>
        <div class="form-group" style="margin-top:12px;">
          <label for="reportShareLinkInput">Link</label>
          <input type="text" id="reportShareLinkInput" readonly value="${escapeHtml(url)}" style="width:100%; padding:8px 12px; font-size:13px;">
        </div>
      `;
      const shareFooter = document.createElement("div");
      shareFooter.style.display = "flex";
      shareFooter.style.gap = "8px";
      shareFooter.style.justifyContent = "flex-end";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "primary-button";
      copyBtn.textContent = "Copy link";
      copyBtn.addEventListener("click", () => {
        const input = document.getElementById("reportShareLinkInput");
        if (input) {
          input.select();
          document.execCommand("copy");
          copyBtn.textContent = "Copied";
        }
      });
      const closeShareBtn = document.createElement("button");
      closeShareBtn.type = "button";
      closeShareBtn.className = "ghost-button";
      closeShareBtn.textContent = "Close";
      closeShareBtn.addEventListener("click", closeModal);
      shareFooter.appendChild(copyBtn);
      shareFooter.appendChild(closeShareBtn);
      openModal({ title: "Share pledged voters list", body: shareBody, footer: shareFooter });
    });
    footer.appendChild(shareLinkBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ghost-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeModal);
    footer.appendChild(closeBtn);

    openModal({ title, body, footer, startMaximized: true });
  }

  function recomputeReports() {
    const voters = votersContext.getAllVoters();
    const pledges = pledgesContext.getPledges();
    const events = eventsContext.getEvents();

    // Pledge percentage by ballot box only (so chart shows only locations in the voter list, e.g. Dhuvaafaru, Kandolhudhoo)
    const pledgeByBox = getPledgeByBallotBox();
    renderBarSet(pledgeChart, pledgeByBox);

    // Pledge distribution pie (pledge voters: Yes / No / Undecided)
    const totalVoters = voters.length;
    const yesCount = voters.filter((v) => v.pledgeStatus === "yes").length;
    const noCount = voters.filter((v) => v.pledgeStatus === "no").length;
    const undecidedCount = voters.filter(
      (v) => v.pledgeStatus === "undecided"
    ).length;
    const yesPct = totalVoters === 0 ? 0 : (yesCount / totalVoters) * 100;
    const noPct = totalVoters === 0 ? 0 : (noCount / totalVoters) * 100;
    const undecidedPct =
      totalVoters === 0 ? 0 : (undecidedCount / totalVoters) * 100;
    renderPledgePie(registrationChart, { yesPct, noPct, undecidedPct, yesCount, noCount, undecidedCount });

    // Candidate-level vote result: among pledged voters, how many have voted (per candidate)
    const candidates = getCandidates();
    const votedIds = getVotedVoterIds();
    const candidateResults = candidates
      .map((cand) => {
        const id = String(cand.id);
        let pledged = 0;
        let voted = 0;
        voters.forEach((v) => {
          const cp = v.candidatePledges || {};
          if (cp[id] === "yes") {
            pledged += 1;
            if (votedIds.has(String(v.id))) voted += 1;
          }
        });
        const value = pledged === 0 ? 0 : (voted / pledged) * 100;
        const label = `${cand.name || id} (${voted}/${pledged} voted)`;
        return { label, value, pledged, voted };
      })
      .filter((r) => r.pledged > 0)
      .sort((a, b) => b.value - a.value);
    renderBarSet(boxPledgeChart, candidateResults);

    const supportTypes = ["supporting", "leaning", "opposed", "unknown"];
    const supportDistribution = supportTypes.map((type) => {
      const count = voters.filter((v) => v.supportStatus === type).length;
      const pct = voters.length === 0 ? 0 : (count / voters.length) * 100;
      const label =
        type.charAt(0).toUpperCase() + type.slice(1).replace("-", " ");
      return { label, value: pct };
    });
    renderBarSet(supportChart, supportDistribution);

    const attendedEvents = events.length;
    const plannedEvents = events.length;
    const participationItems =
      plannedEvents === 0
        ? []
        : [
            {
              label: "Attended events",
              value:
                plannedEvents === 0
                  ? 0
                  : (attendedEvents / plannedEvents) * 100,
            },
          ];
    renderBarSet(eventChart, participationItems);

    // Candidate pledge summary
    renderCandidatePledgeSummary(candidateSummaryEl, voters);

  }

  recomputeReports();

  if (reportsModule) {
    reportsModule.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-report-details]");
      if (btn) {
        openReportDetails(btn.getAttribute("data-report-details"));
        return;
      }
      const candBtn = e.target.closest("[data-report-candidate-id]");
      if (candBtn) {
        const candidateId = candBtn.getAttribute("data-report-candidate-id");
        openCandidatePledgedVoters(candidateId);
      }
    });
  }

  document.addEventListener("voters-updated", recomputeReports);
  document.addEventListener("pledges-updated", recomputeReports);
  document.addEventListener("events-updated", recomputeReports);
  document.addEventListener("candidates-updated", recomputeReports);
}


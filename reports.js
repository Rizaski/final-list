import { getPledgeByBallotBox, getVoterImageSrc } from "./voters.js";
import { getVotedVoterIds, getVotedTimeMarked } from "./zeroDay.js";
import { openModal, closeModal } from "./ui.js";
import { getCandidates } from "./settings.js";
import { candidatePledgedAgentStorageKey } from "./agents-context.js";
import { firebaseInitPromise } from "./firebase.js";
import { initTableViewMenus } from "./table-view-menu.js";

const REPORT_PLEDGED_PAGE_SIZE = 20;

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizeReferendumVote(v) {
  const r = v?.referendumVote;
  if (r === "yes" || r === "no") return r;
  return "undecided";
}

function referendumVoteLabel(status) {
  if (status === "yes") return "Yes";
  if (status === "no") return "No";
  return "Undecided";
}

function referendumPillClass(status) {
  if (status === "yes") return "pledge-pill pledge-pill--pledged";
  if (status === "undecided") return "pledge-pill pledge-pill--undecided";
  return "pledge-pill pledge-pill--not-pledged";
}

/** Combined momentum score (0–100): pledge yes rate, support blend, marked turnout. */
function computeWinOMeter(voters) {
  const n = voters.length;
  if (n === 0) {
    return {
      score: 0,
      empty: true,
      pledgeRate: 0,
      supportBlend: 0,
      turnoutRate: 0,
      yesPledge: 0,
      supporting: 0,
      leaning: 0,
      votedCount: 0,
      total: 0,
    };
  }
  const yesPledge = voters.filter((v) => v.pledgeStatus === "yes").length;
  const pledgeRate = yesPledge / n;
  const supporting = voters.filter((v) => v.supportStatus === "supporting").length;
  const leaning = voters.filter((v) => v.supportStatus === "leaning").length;
  const supportBlend = (supporting + leaning * 0.5) / n;
  const votedIds = getVotedVoterIds();
  const votedCount = voters.filter((v) => votedIds.has(String(v.id))).length;
  const turnoutRate = votedCount / n;
  const score = Math.min(
    100,
    Math.round(100 * (0.45 * pledgeRate + 0.35 * supportBlend + 0.2 * turnoutRate))
  );
  return {
    score,
    empty: false,
    pledgeRate,
    supportBlend,
    turnoutRate,
    yesPledge,
    supporting,
    leaning,
    votedCount,
    total: n,
  };
}

function renderWinOMeter(container, voters) {
  if (!container) return;
  const w = computeWinOMeter(voters);
  if (w.empty) {
    container.innerHTML =
      '<div class="helper-text">Import voters to see your Win O Meter.</div>';
    return;
  }
  container.innerHTML = `
    <div class="win-o-meter" style="--wom-score:${w.score}">
      <div class="win-o-meter__layout">
        <div class="win-o-meter__visual-col">
          <div class="win-o-meter__ring" role="img" aria-label="Win O Meter ${w.score} out of 100">
            <div class="win-o-meter__ring-inner">
              <span class="win-o-meter__score">${w.score}</span>
              <span class="win-o-meter__score-suffix">/ 100</span>
              <span class="win-o-meter__score-caption">Momentum</span>
            </div>
          </div>
          <div class="win-o-meter__track-wrap">
            <div class="chart-bar__track win-o-meter__bar-track" aria-hidden="true">
              <div class="win-o-meter__fill" style="width:${w.score}%"></div>
            </div>
            <p class="helper-text win-o-meter__formula">
              45% pledge (Yes) · 35% support (Supporting + ½ Leaning) · 20% marked voted
            </p>
          </div>
        </div>
        <div class="win-o-meter__metrics">
          <div class="win-o-meter__metric">
            <span class="win-o-meter__metric-label">Pledge yes</span>
            <span class="win-o-meter__metric-value">${(w.pledgeRate * 100).toFixed(1)}%</span>
            <span class="win-o-meter__metric-meta">${w.yesPledge.toLocaleString("en-MV")} / ${w.total.toLocaleString("en-MV")}</span>
          </div>
          <div class="win-o-meter__metric">
            <span class="win-o-meter__metric-label">Support blend</span>
            <span class="win-o-meter__metric-value">${(w.supportBlend * 100).toFixed(1)}%</span>
            <span class="win-o-meter__metric-meta">${w.supporting} supporting · ${w.leaning} leaning</span>
          </div>
          <div class="win-o-meter__metric">
            <span class="win-o-meter__metric-label">Marked voted</span>
            <span class="win-o-meter__metric-value">${(w.turnoutRate * 100).toFixed(1)}%</span>
            <span class="win-o-meter__metric-meta">${w.votedCount.toLocaleString("en-MV")} / ${w.total.toLocaleString("en-MV")}</span>
          </div>
        </div>
      </div>
    </div>
  `;
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
function buildVoterDetailTable(voters, options = {}) {
  const includeReferendum = options.includeReferendum === true;
  const wrap = document.createElement("div");
  wrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th class="data-table-col--seq">Seq</th>
        <th>Image</th>
        <th>ID Number</th>
        <th class="data-table-col--name">Name</th>
        <th>Permanent Address</th>
        <th>Pledge</th>
        ${includeReferendum ? "<th>Referendum</th>" : ""}
        <th>Ballot box</th>
        <th>Assigned agent</th>
        <th>Phone</th>
        <th>Island</th>
        <th>Voted</th>
        ${includeReferendum ? "<th>Referendum notes</th>" : ""}
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
    const refStatus = normalizeReferendumVote(v);
    const refNotesText = String(v.referendumNotes ?? "").trim();
    const refVoteCol = includeReferendum
      ? `<td><span class="${referendumPillClass(refStatus)}">${referendumVoteLabel(refStatus)}</span></td>`
      : "";
    const refNotesCol = includeReferendum
      ? `<td class="data-table-col--referendum-notes">${refNotesText ? escapeHtml(refNotesText) : '<span class="text-muted">—</span>'}</td>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="data-table-col--seq">${v.sequence ?? ""}</td>
      <td>${photoCell}</td>
      <td>${escapeHtml(v.nationalId ?? "")}</td>
      <td class="data-table-col--name">${escapeHtml(v.fullName ?? v.id ?? "—")}</td>
      <td>${escapeHtml(v.permanentAddress ?? "")}</td>
      <td><span class="${pledgeClass}">${pledgeStatus === "yes" ? "Yes" : pledgeStatus === "no" ? "No" : "Undecided"}</span></td>
      ${refVoteCol}
      <td>${escapeHtml((v.ballotBox || "").trim() || "—")}</td>
      <td>${escapeHtml(v.volunteer ?? "")}</td>
      <td>${escapeHtml(v.phone ?? "")}</td>
      <td>${escapeHtml(v.island ?? "")}</td>
      <td class="voted-status-cell">${votedCell}</td>
      ${refNotesCol}
    `;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

function renderCandidatePledgeSummary(container, voters, options = {}) {
  if (!container) return;
  let allCandidates = getCandidates();
  const restrictToCandidateId = options.restrictToCandidateId != null ? String(options.restrictToCandidateId) : null;
  if (restrictToCandidateId) {
    allCandidates = allCandidates.filter((c) => String(c.id) === restrictToCandidateId);
  }
  const totalVoters = voters.length;

  if (!allCandidates.length) {
    container.innerHTML = restrictToCandidateId
      ? '<div class="helper-text">No candidate configured for your account, or no pledge data yet.</div>'
      : '<div class="helper-text">No candidates configured yet. Add candidates in Settings → Candidates to see pledge breakdown.</div>';
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
  const wrap = document.createElement("div");
  wrap.className = "table-wrapper";
  wrap.appendChild(table);
  container.innerHTML = "";
  container.appendChild(wrap);
}

export function initReportsModule({ votersContext, pledgesContext, eventsContext, getCurrentUser }) {
  const pledgeChart = document.getElementById("reportsPledgeChart");
  const referendumChart = document.getElementById("reportsReferendumChart");
  const registrationChart = document.getElementById("reportsRegistrationChart");
  const boxPledgeChart = document.getElementById("reportsBoxPledgeChart");
  const winOMeterEl = document.getElementById("reportsWinOMeter");
  const candidateSummaryEl = document.getElementById("reportsCandidatePledgeSummary");
  const reportsModule = document.getElementById("module-reports");

  function applyCandidateOnlyView() {
    const user = getCurrentUser ? getCurrentUser() : null;
    const isCandidate = user?.role === "candidate" && user?.candidateId;
    if (!reportsModule || !candidateSummaryEl || !isCandidate) return;
    const candidateCard = candidateSummaryEl.closest(".card");
    if (!candidateCard) return;
    reportsModule.querySelectorAll(".card").forEach((card) => {
      card.style.display = card === candidateCard ? "" : "none";
    });
    const moduleHeader = reportsModule.querySelector(".module-header");
    if (moduleHeader) moduleHeader.style.display = "none";
  }

  applyCandidateOnlyView();
  if (reportsModule) {
    const obs = new MutationObserver(() => {
      if (reportsModule.classList.contains("module--active")) applyCandidateOnlyView();
    });
    obs.observe(reportsModule, { attributes: true, attributeFilter: ["class"] });
  }

  function openReportDetails(reportType) {
    const voters = votersContext.getAllVoters();
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
    } else if (reportType === "referendum") {
      const byRef = voters
        .slice()
        .sort((a, b) =>
          normalizeReferendumVote(a).localeCompare(normalizeReferendumVote(b), "en")
        );
      title = "Referendum pledge results – voters";
      body.appendChild(buildVoterDetailTable(byRef, { includeReferendum: true }));
    } else if (reportType === "win-o-meter") {
      const w = computeWinOMeter(voters);
      title = "Win O Meter – breakdown";
      if (w.empty) {
        body.innerHTML =
          '<p class="helper-text">No voters in the system yet. Import voters to compute the score.</p>';
      } else {
        const intro = document.createElement("p");
        intro.className = "helper-text win-o-meter-modal__intro";
        intro.textContent =
          "The Win O Meter (0–100) blends overall pledge Yes rate, support sentiment (Supporting counts full; Leaning counts half), and share of voters marked as voted in Zero Day.";
        body.appendChild(intro);
        const scoreBanner = document.createElement("div");
        scoreBanner.className = "win-o-meter-modal__score-banner";
        scoreBanner.innerHTML = `<span class="win-o-meter-modal__score-num">${w.score}</span><span class="win-o-meter-modal__score-outof">/ 100</span>`;
        body.appendChild(scoreBanner);
        const metrics = document.createElement("div");
        metrics.className = "table-wrapper win-o-meter-modal__table-wrap";
        metrics.innerHTML = `
          <table class="data-table">
            <thead>
              <tr><th>Component</th><th>Weight</th><th>Value</th><th>Contribution</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Pledge Yes rate</td>
                <td>45%</td>
                <td>${(w.pledgeRate * 100).toFixed(1)}% (${w.yesPledge} / ${w.total})</td>
                <td>${(0.45 * w.pledgeRate * 100).toFixed(1)} pts</td>
              </tr>
              <tr>
                <td>Support blend</td>
                <td>35%</td>
                <td>${(w.supportBlend * 100).toFixed(1)}% (${w.supporting} supporting, ${w.leaning} leaning)</td>
                <td>${(0.35 * w.supportBlend * 100).toFixed(1)} pts</td>
              </tr>
              <tr>
                <td>Marked voted</td>
                <td>20%</td>
                <td>${(w.turnoutRate * 100).toFixed(1)}% (${w.votedCount} / ${w.total})</td>
                <td>${(0.2 * w.turnoutRate * 100).toFixed(1)} pts</td>
              </tr>
              <tr>
                <td colspan="3"><strong>Total (rounded)</strong></td>
                <td><strong>${w.score} / 100</strong></td>
              </tr>
            </tbody>
          </table>`;
        body.appendChild(metrics);
      }
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
    const cu = getCurrentUser ? getCurrentUser() : null;
    if (cu?.role === "candidate" && cu?.candidateId && String(cu.candidateId) !== String(candidateId)) return;
    const allVoters = votersContext.getAllVoters();
    const baseList = allVoters.filter((v) => {
      const cp = v.candidatePledges || {};
      return cp[String(candidateId)] === "yes";
    });
    const candidates = getCandidates();
    // Candidate-specific "assigned agent" should not affect global voter volunteer assignments.
    const assignedAgentStorageKey = candidatePledgedAgentStorageKey(candidateId);
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

    /** Same field as candidate login voters list & pledges module — not global pledgeStatus. */
    function candidatePledgeForRow(v) {
      const cp = v.candidatePledges || {};
      const s = cp[String(candidateId)];
      if (s === "yes" || s === "no" || s === "undecided") return s;
      return "undecided";
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

    function getFilteredSortedGrouped() {
      const query = (body.querySelector("#reportPledgedSearch")?.value || "").toLowerCase().trim();
      const filterPledge = body.querySelector("#reportPledgedFilterPledge")?.value || "all";
      const filterBox = body.querySelector("#reportPledgedFilterBox")?.value || "all";
      const sortBy = body.querySelector("#reportPledgedSort")?.value || "sequence";
      const groupBy = body.querySelector("#reportPledgedGroupBy")?.value || "none";

      let list = baseList.filter((v) => {
        if (filterPledge !== "all" && candidatePledgeForRow(v) !== filterPledge) return false;
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
          case "pledge": return candidatePledgeForRow(a).localeCompare(candidatePledgeForRow(b), "en");
          case "box": return (a.ballotBox || "").localeCompare(b.ballotBox || "", "en");
          default: return (a.fullName || "").localeCompare(b.fullName || "", "en");
        }
      };
      list = list.slice().sort(cmp);

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
          const pledgeStatus = candidatePledgeForRow(v);
          const timeMarked = getVotedTimeMarked(v.id);
          const votedCell = timeMarked
            ? (() => {
                const d = new Date(timeMarked);
                const formatted = d.toLocaleString("en-MV", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
                return `<span class="pledge-pill pledge-pill--pledged" title="${escapeHtml(formatted)}">Voted</span>`;
              })()
            : '<span class="text-muted">—</span>';
          const fromDoc =
            v.candidateAgentAssignments && typeof v.candidateAgentAssignments === "object"
              ? String(v.candidateAgentAssignments[String(candidateId)] || "")
              : "";
          const assignedAgentName = (fromDoc || assignedByVoterId[String(v.id)] || "").trim();
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td class="data-table-col--seq">${v.sequence ?? ""}</td>
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
      if (el) el.addEventListener(el.id === "reportPledgedSearch" ? "input" : "change", () => { currentPage = 1; renderReportTable(); });
    });

    renderReportTable();

    const footer = document.createElement("div");
    footer.style.display = "flex";
    footer.style.flexWrap = "wrap";
    footer.style.gap = "10px";
    footer.style.alignItems = "center";
    footer.style.justifyContent = "flex-end";

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

    const referendumBuckets = ["yes", "no", "undecided"];
    const referendumDistribution = referendumBuckets.map((type) => {
      const count = voters.filter((v) => normalizeReferendumVote(v) === type).length;
      const pct = voters.length === 0 ? 0 : (count / voters.length) * 100;
      const label = type === "yes" ? "Yes" : type === "no" ? "No" : "Undecided";
      return { label, value: pct };
    });
    renderBarSet(referendumChart, referendumDistribution);

    renderWinOMeter(winOMeterEl, voters);

    // Candidate pledge summary (restrict to one candidate when current user is a candidate)
    const currentUser = getCurrentUser ? getCurrentUser() : null;
    const pledgeSummaryOpts =
      currentUser?.role === "candidate" && currentUser?.candidateId
        ? { restrictToCandidateId: currentUser.candidateId }
        : {};
    renderCandidatePledgeSummary(candidateSummaryEl, voters, pledgeSummaryOpts);

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
  document.addEventListener("voted-entries-updated", recomputeReports);
}


import { getPledgeByBallotBox, getVoterImageSrc } from "./voters.js";
import { getVotedVoterIds, getVotedTimeMarked } from "./zeroDay.js";
import { openModal, closeModal } from "./ui.js";
import { getCandidatesForActiveElectionView } from "./settings.js";
import { openCandidatePledgedVotersModal } from "./candidate-pledged-voters-modal.js";
import { sequenceAsImportedFromCsv } from "./sequence-utils.js";

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
            <span class="win-o-meter__metric-meta">${w.yesPledge.toLocaleString("en-US")} / ${w.total.toLocaleString("en-US")}</span>
          </div>
          <div class="win-o-meter__metric">
            <span class="win-o-meter__metric-label">Support blend</span>
            <span class="win-o-meter__metric-value">${(w.supportBlend * 100).toFixed(1)}%</span>
            <span class="win-o-meter__metric-meta">${w.supporting} supporting · ${w.leaning} leaning</span>
          </div>
          <div class="win-o-meter__metric">
            <span class="win-o-meter__metric-label">Marked voted</span>
            <span class="win-o-meter__metric-value">${(w.turnoutRate * 100).toFixed(1)}%</span>
            <span class="win-o-meter__metric-meta">${w.votedCount.toLocaleString("en-US")} / ${w.total.toLocaleString("en-US")}</span>
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
    const fillMod = item.fillClass && String(item.fillClass).trim() ? String(item.fillClass).trim() : "chart-bar__fill--primary";
    const row = document.createElement("div");
    row.className = "chart-bar";
    row.innerHTML = `
      <div class="chart-bar__label">${escapeHtml(item.label)}</div>
      <div class="chart-bar__track">
        <div class="chart-bar__fill ${fillMod}" style="width:${item.value}%"></div>
      </div>
      <div class="chart-bar__value">${item.value.toFixed(1)}%</div>
    `;
    container.appendChild(row);
  });
}

const PERSUADABLE_REPORT_KEYS = [
  { key: "unknown", label: "Unknown" },
  { key: "yes", label: "Yes" },
  { key: "no", label: "No" },
  { key: "50%", label: "50%" },
];

function normalizePersuadableReportKey(v) {
  const raw = String(v?.persuadable ?? "unknown").trim().toLowerCase();
  if (raw === "yes") return "yes";
  if (raw === "no") return "no";
  if (raw === "50%" || raw === "50") return "50%";
  return "unknown";
}

function persuadableBarFillClass(key) {
  if (key === "yes") return "chart-bar__fill--pledge-yes";
  if (key === "no") return "chart-bar__fill--pledge-no";
  if (key === "50%") return "chart-bar__fill--persuadable-50";
  return "chart-bar__fill--pledge-undecided";
}

/** Radial donut: share of voters with door-to-door Met = yes. */
function renderMetCountDonut(container, voters) {
  if (!container) return;
  const n = voters.length;
  if (n === 0) {
    container.innerHTML = '<div class="helper-text">Import voters to see met counts.</div>';
    return;
  }
  const met = voters.filter((v) => String(v.metStatus || "").trim() === "met").length;
  const notMet = Math.max(0, n - met);
  const metPct = (met / n) * 100;
  const metDeg = (met / n) * 360;
  const aria = `${met} of ${n} voters marked met (${metPct.toFixed(1)} percent)`;
  container.innerHTML = `
    <div class="met-donut">
      <div class="met-donut__ring" role="img" aria-label="${escapeHtml(aria)}">
        <div class="met-donut__inner">
          <span class="met-donut__value">${met.toLocaleString("en-US")}</span>
          <span class="met-donut__suffix">/ ${n.toLocaleString("en-US")}</span>
          <span class="met-donut__caption">Met</span>
          <span class="met-donut__pct">${metPct.toFixed(1)}%</span>
        </div>
      </div>
      <ul class="met-donut__legend" aria-hidden="true">
        <li class="met-donut__legend-item">
          <span class="met-donut__swatch met-donut__swatch--met"></span>
          Met — ${met.toLocaleString("en-US")}
        </li>
        <li class="met-donut__legend-item">
          <span class="met-donut__swatch met-donut__swatch--not"></span>
          Not met — ${notMet.toLocaleString("en-US")}
        </li>
      </ul>
    </div>
  `;
  const ring = container.querySelector(".met-donut__ring");
  if (ring) {
    ring.style.background = `conic-gradient(
      from -90deg,
      var(--color-primary, #0d9488) 0deg ${metDeg}deg,
      #e5e7eb ${metDeg}deg 360deg
    )`;
  }
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
          Yes – ${yesCount.toLocaleString("en-US")} (${yesPct.toFixed(1)}%)
        </div>
        <div class="pie-chart__legend-item">
          <span class="pie-chart__legend-color" style="background: var(--color-not-pledged);"></span>
          No – ${noCount.toLocaleString("en-US")} (${noPct.toFixed(1)}%)
        </div>
        <div class="pie-chart__legend-item">
          <span class="pie-chart__legend-color" style="background: var(--color-undecided);"></span>
          Undecided – ${undecidedCount.toLocaleString("en-US")} (${undecidedPct.toFixed(1)}%)
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

/** Horizontal bars for general pledge overview (same counts / % of all voters as the pie). */
function renderPledgeOverviewBars(container, { yesCount, noCount, undecidedCount, totalVoters }) {
  if (!container) return;
  const tv = typeof totalVoters === "number" ? totalVoters : yesCount + noCount + undecidedCount;
  if (tv === 0) {
    container.innerHTML =
      '<div class="helper-text">No pledge data yet. Import voters or update pledges to see distribution.</div>';
    return;
  }
  const yesPct = (yesCount / tv) * 100;
  const noPct = (noCount / tv) * 100;
  const undecidedPct = (undecidedCount / tv) * 100;
  const rows = [
    { label: "Yes", count: yesCount, pct: yesPct, fillClass: "chart-bar__fill--pledge-yes" },
    { label: "No", count: noCount, pct: noPct, fillClass: "chart-bar__fill--pledge-no" },
    { label: "Undecided", count: undecidedCount, pct: undecidedPct, fillClass: "chart-bar__fill--pledge-undecided" },
  ];
  container.innerHTML = "";
  rows.forEach((row) => {
    const el = document.createElement("div");
    el.className = "chart-bar";
    el.innerHTML = `
      <div class="chart-bar__label">${escapeHtml(row.label)}</div>
      <div class="chart-bar__track">
        <div class="chart-bar__fill ${row.fillClass}" style="width:${Math.min(100, row.pct).toFixed(1)}%"></div>
      </div>
      <div class="chart-bar__value">${row.count.toLocaleString("en-US")} (${row.pct.toFixed(1)}%)</div>
    `;
    container.appendChild(el);
  });
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
          const formatted = d.toLocaleString("en-US", {
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
      <td class="data-table-col--seq">${escapeHtml(sequenceAsImportedFromCsv(v))}</td>
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
  let allCandidates = getCandidatesForActiveElectionView();
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
        <td>${row.pledgedCount.toLocaleString("en-US")}</td>
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
  const persuadableBarsEl = document.getElementById("reportsPersuadableBars");
  const metDonutEl = document.getElementById("reportsMetDonut");
  const registrationChart = document.getElementById("reportsRegistrationChart");
  const pledgeOverviewBars = document.getElementById("reportsPledgeOverviewBars");
  const boxPledgeChart = document.getElementById("reportsBoxPledgeChart");
  const winOMeterEl = document.getElementById("reportsWinOMeter");
  const candidateSummaryEl = document.getElementById("reportsCandidatePledgeSummary");
  const reportsModule = document.getElementById("module-reports");

  function applyCandidateOnlyView() {
    const user = getCurrentUser ? getCurrentUser() : null;
    const isCandidate = user?.role === "candidate" && user?.candidateId;
    if (!reportsModule || !isCandidate) return;
    const candidateCard = candidateSummaryEl?.closest(".card");
    const referendumCard = document.getElementById("reportsReferendumCard")?.closest(".card");
    if (!candidateCard && !referendumCard) return;
    reportsModule.querySelectorAll(".card").forEach((card) => {
      const show =
        (candidateCard && card === candidateCard) || (referendumCard && card === referendumCard);
      card.style.display = show ? "" : "none";
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

  function openCandidatePledgedVoters(candidateId) {
    openCandidatePledgedVotersModal({
      candidateId,
      getAllVoters: () => votersContext.getAllVoters(),
      getCurrentUser,
      getCandidates: () => getCandidatesForActiveElectionView(),
    });
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
    renderPledgeOverviewBars(pledgeOverviewBars, {
      yesCount,
      noCount,
      undecidedCount,
      totalVoters,
    });

    // Candidate-level vote result: among pledged voters, how many have voted (per candidate)
    const candidates = getCandidatesForActiveElectionView();
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

    const persuadableDistribution = PERSUADABLE_REPORT_KEYS.map(({ key, label }) => {
      const count = voters.filter((v) => normalizePersuadableReportKey(v) === key).length;
      const pct = voters.length === 0 ? 0 : (count / voters.length) * 100;
      return {
        label: `${label} (${count.toLocaleString("en-US")})`,
        value: pct,
        fillClass: persuadableBarFillClass(key),
      };
    });
    renderBarSet(persuadableBarsEl, persuadableDistribution);
    renderMetCountDonut(metDonutEl, voters);

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
  document.addEventListener("effective-election-view-changed", recomputeReports);
}


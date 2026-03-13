import { getPledgeByBallotBox } from "./voters.js";
import { getVotedVoterIds } from "./zeroDay.js";
import { openModal, closeModal } from "./ui.js";

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

function renderPledgePie(container, { yesPct, noPct, undecidedPct }) {
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
          Yes – ${yesPct.toFixed(1)}%
        </div>
        <div class="pie-chart__legend-item">
          <span class="pie-chart__legend-color" style="background: var(--color-not-pledged);"></span>
          No – ${noPct.toFixed(1)}%
        </div>
        <div class="pie-chart__legend-item">
          <span class="pie-chart__legend-color" style="background: var(--color-undecided);"></span>
          Undecided – ${undecidedPct.toFixed(1)}%
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

export function initReportsModule({ votersContext, pledgesContext, eventsContext }) {
  const pledgeChart = document.getElementById("reportsPledgeChart");
  const supportChart = document.getElementById("reportsSupportChart");
  const registrationChart = document.getElementById("reportsRegistrationChart");
  const boxPledgeChart = document.getElementById("reportsBoxPledgeChart");
  const eventChart = document.getElementById("reportsEventChart");
  const reportsModule = document.getElementById("module-reports");

  function openReportDetails(reportType) {
    const voters = votersContext.getAllVoters();
    const events = eventsContext.getEvents();
    let title = "";
    let body = document.createElement("div");

    if (reportType === "pledge-by-island") {
      const byBox = voters
        .filter((v) => (v.ballotBox || "").trim())
        .slice()
        .sort((a, b) => (a.ballotBox || "").localeCompare(b.ballotBox || "", "en"));
      const rows = byBox.map((v) => [
        (v.ballotBox || "").trim() || "–",
        v.fullName || v.id || "–",
        v.nationalId || v.id || "–",
        (v.pledgeStatus === "yes" ? "Yes" : v.pledgeStatus === "no" ? "No" : "Undecided"),
      ]);
      title = "Pledge by ballot box – voters";
      body.appendChild(buildDetailTable(["Ballot box", "Name", "ID number", "Pledge"], rows));
    } else if (reportType === "pledge-pie") {
      const byPledge = voters
        .slice()
        .sort((a, b) => (a.pledgeStatus || "").localeCompare(b.pledgeStatus || "", "en"));
      const rows = byPledge.map((v) => [
        v.fullName || v.id || "–",
        v.nationalId || v.id || "–",
        (v.pledgeStatus === "yes" ? "Yes" : v.pledgeStatus === "no" ? "No" : "Undecided"),
      ]);
      title = "Pledge distribution – voters";
      body.appendChild(buildDetailTable(["Name", "ID number", "Pledge status"], rows));
    } else if (reportType === "box-pledge") {
      const votedIds = getVotedVoterIds();
      const pledgedAndVoted = voters.filter(
        (v) => (v.ballotBox || "").trim() && v.pledgeStatus === "yes" && votedIds.has(v.id)
      );
      const rows = pledgedAndVoted
        .slice()
        .sort((a, b) => (a.ballotBox || "").localeCompare(b.ballotBox || "", "en"))
        .map((v) => [v.ballotBox || "–", v.fullName || v.id || "–", v.nationalId || v.id || "–"]);
      title = "Box-wise pledge – voters who pledged and have voted";
      body.appendChild(buildDetailTable(["Ballot box", "Name", "ID number"], rows));
    } else if (reportType === "support") {
      const bySupport = voters
        .slice()
        .sort((a, b) => (a.supportStatus || "").localeCompare(b.supportStatus || "", "en"));
      const supportLabel = (s) =>
        !s ? "Unknown" : s.charAt(0).toUpperCase() + s.slice(1).replace("-", " ");
      const rows = bySupport.map((v) => [
        v.fullName || v.id || "–",
        v.nationalId || v.id || "–",
        supportLabel(v.supportStatus),
      ]);
      title = "Support distribution – voters";
      body.appendChild(buildDetailTable(["Name", "ID number", "Support"], rows));
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
    renderPledgePie(registrationChart, { yesPct, noPct, undecidedPct });

    // Box-wise pledge voter result
    const pledgeByBox = getPledgeByBallotBox();
    renderBarSet(boxPledgeChart, pledgeByBox);

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

  }

  recomputeReports();

  if (reportsModule) {
    reportsModule.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-report-details]");
      if (btn) openReportDetails(btn.getAttribute("data-report-details"));
    });
  }

  document.addEventListener("voters-updated", recomputeReports);
  document.addEventListener("pledges-updated", recomputeReports);
  document.addEventListener("events-updated", recomputeReports);
}


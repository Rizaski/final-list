import { openModal, closeModal } from "./ui.js";
import { firebaseInitPromise } from "./firebase.js";
import {
  compareBallotSequence,
  sequenceAsImportedFromCsv,
  compareVotersByBallotBoxThenSequenceThenName,
} from "./sequence-utils.js";

const PAGE_SIZE = 15;

const eventsTableBody = document.querySelector("#eventsTable tbody");
const eventsTimeline = document.getElementById("eventsTimeline");
const addEventButton = document.getElementById("addEventButton");
const eventsPaginationEl = document.getElementById("eventsPagination");

// Dynamic events collection – starts empty, then loaded from Firestore.
let events = [];
let eventsCurrentPage = 1;
let eventsUnsubscribe = null;

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateShareToken() {
  return "evs-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now().toString(36);
}

function buildEventParticipantsShareUrl(token) {
  const path = window.location.pathname || "/";
  const dir = path.endsWith("/") ? path : path.replace(/[^/]+$/, "") || "/";
  const base = window.location.origin + dir + "event-participants-view.html";
  return `${base}?token=${encodeURIComponent(token)}`;
}

function formatDateTime(dtString) {
  const dt = new Date(dtString);
  return dt.toLocaleString("en-MV", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderEventsTable() {
  eventsTableBody.innerHTML = "";
  const sorted = [...events].sort(
    (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
  );
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (eventsCurrentPage > totalPages) eventsCurrentPage = totalPages;
  const start = (eventsCurrentPage - 1) * PAGE_SIZE;
  const pageEvents = sorted.slice(start, start + PAGE_SIZE);

  pageEvents.forEach((ev) => {
    const tr = document.createElement("tr");
    tr.dataset.eventId = String(ev.id);
    tr.innerHTML = `
      <td>${ev.name}</td>
      <td>${ev.location}</td>
      <td>${ev.scope}</td>
      <td>${formatDateTime(ev.dateTime)}</td>
      <td>${ev.team}</td>
      <td>${ev.expectedAttendees}</td>
      <td style="text-align:right;">
        <button class="ghost-button ghost-button--small" data-event-participants="${ev.id}">Participants <span class="pill-toggle__meta">(${Number(ev.participantCount || 0)})</span></button>
        <button class="ghost-button ghost-button--small" data-edit-event="${ev.id}">Edit</button>
      </td>
    `;
    eventsTableBody.appendChild(tr);
  });

  if (eventsPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    eventsPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${eventsCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${eventsCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${eventsCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    eventsPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && eventsCurrentPage > 1) eventsCurrentPage--;
        if (btn.dataset.page === "next" && eventsCurrentPage < totalPages) eventsCurrentPage++;
        renderEventsTable();
      });
    });
  }
}

function getVotersForEventParticipantPicker() {
  try {
    const raw = localStorage.getItem("voters-data");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function ensureEventParticipantsShareToken(event) {
  if (!event) return "";
  let token = String(event.participantsShareToken || "").trim();
  if (!token) {
    token = generateShareToken();
    event.participantsShareToken = token;
    const idx = events.findIndex((x) => String(x.id) === String(event.id));
    if (idx >= 0) events[idx].participantsShareToken = token;
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setEventFs) {
        await api.setEventFs(event.id, { participantsShareToken: token });
      }
    } catch (_) {}
  }
  return token;
}

async function openEventParticipantsModal(event) {
  if (!event || event.id == null) return;
  const token = await ensureEventParticipantsShareToken(event);
  if (!token) return;
  const api = await firebaseInitPromise;
  if (!api.ready || !api.getEventParticipantRowsFs || !api.setEventParticipantRowFs) {
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Participants unavailable",
        meta: "Firebase is not ready. Try again in a moment.",
      });
    }
    return;
  }
  if (api.setEventParticipantShareFs) {
    try {
      await api.setEventParticipantShareFs(token, {
        token,
        eventId: String(event.id),
        eventName: event.name || "Event participants",
      });
    } catch (_) {}
  }

  const title = `Participants – ${event.name || "Event"}`;
  const body = document.createElement("div");
  body.className = "modal-body-inner";
  const shareUrl = buildEventParticipantsShareUrl(token);
  const voters = getVotersForEventParticipantPicker();

  body.innerHTML = `
    <div class="modal-list-toolbar list-toolbar">
      <div class="list-toolbar__search">
        <label for="eventParticipantsSearch" class="sr-only">Search participants</label>
        <input type="search" id="eventParticipantsSearch" placeholder="Search by name, ID, phone, address…">
      </div>
      <div class="list-toolbar__controls">
        <div class="field-group field-group--inline">
          <label for="eventParticipantsFilterPledge">Filter</label>
          <select id="eventParticipantsFilterPledge">
            <option value="all">All</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="undecided">Undecided</option>
          </select>
        </div>
        <div class="field-group field-group--inline">
          <label for="eventParticipantsFilterBox">Ballot box</label>
          <select id="eventParticipantsFilterBox">
            <option value="all">All</option>
          </select>
        </div>
        <div class="field-group field-group--inline">
          <label for="eventParticipantsSort">Sort</label>
          <select id="eventParticipantsSort">
            <option value="sequence">Seq</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
            <option value="id">ID Number</option>
            <option value="support">Support</option>
            <option value="box">Ballot box</option>
            <option value="island">Island</option>
            <option value="pledge">Pledge</option>
            <option value="voted">Voted at</option>
          </select>
        </div>
        <div class="field-group field-group--inline">
          <label for="eventParticipantsGroupBy">Group by</label>
          <select id="eventParticipantsGroupBy">
            <option value="none">None</option>
            <option value="box">Ballot box</option>
            <option value="island">Island</option>
            <option value="pledge">Pledge</option>
          </select>
        </div>
        <button type="button" class="ghost-button ghost-button--small" id="eventParticipantsRefreshBtn">Refresh</button>
        <button type="button" class="ghost-button ghost-button--small" id="eventParticipantsAddManualBtn">Add participant</button>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:8px;">
      <label for="eventParticipantFromVoter">Add from voters</label>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <div class="event-participant-picker" id="eventParticipantPicker">
          <input type="text" id="eventParticipantFromVoter" class="input event-participant-picker__input" placeholder="Type name, ID, phone or address…">
          <div class="event-participant-picker__menu" id="eventParticipantPickerMenu" role="listbox" aria-label="Voter search results"></div>
        </div>
        <button type="button" class="ghost-button ghost-button--small" id="eventParticipantsAddFromVoterBtn">Add from voter</button>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px;">
        <label for="eventParticipantsShareLink" class="sr-only">Share link</label>
        <input type="text" id="eventParticipantsShareLink" class="input" readonly value="${escapeHtml(shareUrl)}" style="min-width:320px; flex:1;">
        <button type="button" class="ghost-button ghost-button--small" id="eventParticipantsCopyLinkBtn">Copy link</button>
        <button type="button" class="ghost-button ghost-button--small" id="eventParticipantsOpenLinkBtn">Open shared view</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table class="data-table" id="eventParticipantsTable">
        <thead>
          <tr>
            <th class="data-table-col--seq">Seq</th>
            <th>Image</th>
            <th class="data-table-col--name">Full Name</th>
            <th>ID Number</th>
            <th>Permanent Address</th>
            <th>Phone Number</th>
            <th>Ballot box</th>
            <th>Pledge</th>
            <th class="settings-agents-actions-col">Actions</th>
          </tr>
        </thead>
        <tbody id="eventParticipantsTbody"></tbody>
      </table>
    </div>
  `;

  const tbody = body.querySelector("#eventParticipantsTbody");
  const searchEl = body.querySelector("#eventParticipantsSearch");
  const filterPledgeEl = body.querySelector("#eventParticipantsFilterPledge");
  const filterBoxEl = body.querySelector("#eventParticipantsFilterBox");
  const sortEl = body.querySelector("#eventParticipantsSort");
  const groupByEl = body.querySelector("#eventParticipantsGroupBy");
  const fromVoterInput = body.querySelector("#eventParticipantFromVoter");
  const fromVoterMenu = body.querySelector("#eventParticipantPickerMenu");
  let rows = await api.getEventParticipantRowsFs(token);
  if (!Array.isArray(rows)) rows = [];

  function buildVoterIndex() {
    const byId = new Map();
    const byNationalId = new Map();
    voters.forEach((v) => {
      const id = String(v.id || "").trim();
      const nid = String(v.nationalId || "").trim();
      if (id) byId.set(id, v);
      if (nid) byNationalId.set(nid, v);
    });
    return { byId, byNationalId };
  }

  function normalizeRowsWithVoters(sourceRows) {
    const { byId, byNationalId } = buildVoterIndex();
    return (Array.isArray(sourceRows) ? sourceRows : []).map((r) => {
      const id = String(r.id || "").trim();
      const sourceVoterId = String(r.sourceVoterId || "").trim();
      const nationalId = String(r.nationalId || "").trim();
      const voter =
        (sourceVoterId && byId.get(sourceVoterId)) ||
        (nationalId && byNationalId.get(nationalId)) ||
        null;
      if (!voter) return r;
      return {
        ...r,
        sequence: r.sequence != null && r.sequence !== "" ? r.sequence : voter.sequence || "",
        name: r.name || voter.fullName || "",
        nationalId: r.nationalId || voter.nationalId || voter.id || "",
        phone: r.phone || voter.phone || "",
        address: r.address || voter.permanentAddress || "",
        currentLocation: r.currentLocation || voter.currentLocation || "",
        ballotBox: r.ballotBox || voter.ballotBox || "",
        island: r.island || voter.island || "",
        pledgeStatus: r.pledgeStatus || voter.pledgeStatus || "undecided",
        supportStatus: r.supportStatus || voter.supportStatus || "unknown",
        votedAt: r.votedAt || voter.votedAt || "",
      };
    });
  }
  rows = normalizeRowsWithVoters(rows);

  async function syncParticipantCountToEvent(count) {
    const num = Number(count || 0);
    if (Number(event.participantCount || 0) === num) return;
    event.participantCount = num;
    const idx = events.findIndex((x) => String(x.id) === String(event.id));
    if (idx >= 0) events[idx].participantCount = num;
    renderEventsTable();
    try {
      if (api.setEventFs) await api.setEventFs(event.id, { participantCount: num });
    } catch (_) {}
  }

  function toNorm(s) {
    return String(s || "").trim().toLowerCase();
  }

  function pledgeLabel(status) {
    if (status === "yes") return "Yes";
    if (status === "no") return "No";
    return "Undecided";
  }

  function findVoterFromSearchInput(raw) {
    const q = String(raw || "").trim().toLowerCase();
    if (!q) return null;
    const exact = voters.find((v) => {
      const name = String(v.fullName || "").trim().toLowerCase();
      const nid = String(v.nationalId || "").trim().toLowerCase();
      const id = String(v.id || "").trim().toLowerCase();
      return name === q || nid === q || id === q;
    });
    if (exact) return exact;
    const list = voters.filter((v) => {
      const name = String(v.fullName || "").toLowerCase();
      const nid = String(v.nationalId || "").toLowerCase();
      const id = String(v.id || "").toLowerCase();
      const phone = String(v.phone || "").toLowerCase();
      const addr = String(v.permanentAddress || "").toLowerCase();
      return (
        name.includes(q) ||
        nid.includes(q) ||
        id.includes(q) ||
        phone.includes(q) ||
        addr.includes(q)
      );
    });
    return list.length === 1 ? list[0] : null;
  }

  function renderVoterPickerMenu() {
    if (!fromVoterInput || !fromVoterMenu) return;
    const q = String(fromVoterInput.value || "").trim().toLowerCase();
    const list = voters
      .filter((v) => {
        if (!q) return true;
        const name = String(v.fullName || "").toLowerCase();
        const nid = String(v.nationalId || "").toLowerCase();
        const id = String(v.id || "").toLowerCase();
        const phone = String(v.phone || "").toLowerCase();
        const addr = String(v.permanentAddress || "").toLowerCase();
        return (
          name.includes(q) ||
          nid.includes(q) ||
          id.includes(q) ||
          phone.includes(q) ||
          addr.includes(q)
        );
      })
      .slice(0, 25);
    if (!list.length) {
      fromVoterMenu.innerHTML = '<div class="voter-agent-dropdown__empty">No matching voters.</div>';
      fromVoterMenu.style.display = "block";
      return;
    }
    fromVoterMenu.innerHTML = list
      .map((v) => {
        const fullName = String(v.fullName || "");
        const nid = String(v.nationalId || v.id || "");
        const phone = String(v.phone || "—");
        const addr = String(v.permanentAddress || "—");
        const rawId = String(v.nationalId || v.id || "").replace(/\s+/g, "");
        const photoSrc = rawId ? `photos/${rawId}.jpg` : "";
        const initials =
          fullName
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((p) => p[0]?.toUpperCase() || "")
            .join("") || "?";
        const photoHtml = photoSrc
          ? `<div class="avatar-cell avatar-cell--settings-agent"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
          : `<div class="avatar-cell avatar-cell--settings-agent"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
        return `<button type="button" class="voter-agent-dropdown__item" data-voter-id="${escapeHtml(String(v.id || ""))}">
          ${photoHtml}
          <span class="voter-agent-dropdown__main">${escapeHtml(fullName)}</span>
          <span class="voter-agent-dropdown__meta">ID: ${escapeHtml(nid)} | ${escapeHtml(phone)} | ${escapeHtml(addr)}</span>
        </button>`;
      })
      .join("");
    fromVoterMenu.style.display = "block";
  }

  function syncFilterBoxOptions() {
    const options = [...new Set(rows.map((r) => String(r.ballotBox || "").trim()).filter(Boolean))].sort();
    const current = filterBoxEl?.value || "all";
    if (!filterBoxEl) return;
    filterBoxEl.innerHTML =
      '<option value="all">All</option>' +
      options.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
    if ([...filterBoxEl.options].some((o) => o.value === current)) filterBoxEl.value = current;
  }

  function getFilteredSortedGroupedRows() {
    const q = toNorm(searchEl?.value || "");
    const filterPledge = filterPledgeEl?.value || "all";
    const filterBox = filterBoxEl?.value || "all";
    const sortBy = sortEl?.value || "sequence";
    const groupBy = groupByEl?.value || "none";

    let list = rows.filter((r) => {
      const pledge = String(r.pledgeStatus || "undecided");
      const box = String(r.ballotBox || "").trim();
      if (filterPledge !== "all" && pledge !== filterPledge) return false;
      if (filterBox !== "all" && box !== filterBox) return false;
      if (!q) return true;
      return [
        r.sequence,
        r.name,
        r.nationalId,
        r.phone,
        r.address,
        r.currentLocation,
        r.ballotBox,
        r.island,
        r.pledgeStatus,
        r.supportStatus,
        r.votedAt,
        r.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    const cmp = (a, b) => {
      switch (sortBy) {
        case "name-desc":
          return String(b.name || "").localeCompare(String(a.name || ""), "en");
        case "name-asc":
          return String(a.name || "").localeCompare(String(b.name || ""), "en");
        case "id":
          return String(a.nationalId || "").localeCompare(String(b.nationalId || ""), "en");
        case "support":
          return String(a.supportStatus || "unknown").localeCompare(String(b.supportStatus || "unknown"), "en");
        case "box": {
          const boxCmp = String(a.ballotBox || "").localeCompare(String(b.ballotBox || ""), "en");
          if (boxCmp !== 0) return boxCmp;
          const sc = compareBallotSequence(a.sequence, b.sequence);
          if (sc !== 0) return sc;
          return String(a.name || "").localeCompare(String(b.name || ""), "en");
        }
        case "island":
          return String(a.island || "").localeCompare(String(b.island || ""), "en");
        case "pledge":
          return String(a.pledgeStatus || "undecided").localeCompare(String(b.pledgeStatus || "undecided"), "en");
        case "voted":
          return String(b.votedAt || "").localeCompare(String(a.votedAt || ""), "en");
        case "sequence":
        default: {
          const c = compareBallotSequence(a.sequence, b.sequence);
          if (c !== 0) return c;
          return String(a.name || "").localeCompare(String(b.name || ""), "en");
        }
      }
    };
    list = [...list].sort(cmp);
    if (groupBy === "box") {
      list.sort((a, b) =>
        compareVotersByBallotBoxThenSequenceThenName(
          { ballotBox: a.ballotBox, sequence: a.sequence, fullName: a.name },
          { ballotBox: b.ballotBox, sequence: b.sequence, fullName: b.name }
        )
      );
    }
    if (groupBy === "none") return list.map((r) => ({ type: "row", row: r }));
    const out = [];
    let last = null;
    const getKey = (r) => {
      if (groupBy === "box") return String(r.ballotBox || "—").trim() || "—";
      if (groupBy === "island") return String(r.island || "—").trim() || "—";
      return pledgeLabel(r.pledgeStatus || "undecided");
    };
    list.forEach((r) => {
      const key = getKey(r);
      if (key !== last) {
        out.push({ type: "group", label: key });
        last = key;
      }
      out.push({ type: "row", row: r });
    });
    return out;
  }

  function renderRows() {
    syncFilterBoxOptions();
    const displayList = getFilteredSortedGroupedRows();
    const onlyRows = displayList.filter((x) => x.type === "row");

    tbody.innerHTML = "";
    if (!onlyRows.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="text-muted" style="text-align:center;padding:16px;">No participants match filters.</td></tr>`;
      return;
    }
    displayList.forEach((item) => {
      if (item.type === "group") {
        const tr = document.createElement("tr");
        tr.className = "list-toolbar__group-header";
        tr.innerHTML = `<td colspan="10">${escapeHtml(item.label)}</td>`;
        tbody.appendChild(tr);
        return;
      }
      const row = item.row;
      const id = String(row.id || "");
      const rawId = String(row.nationalId || "").trim().replace(/\s+/g, "");
      const photoSrc = rawId ? `photos/${rawId}.jpg` : "";
      const initials =
        String(row.name || "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((p) => p[0]?.toUpperCase() || "")
          .join("") || "?";
      const imageCell = photoSrc
        ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
        : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
      const support = String(row.supportStatus || "unknown");
      const supportLabel =
        support === "supporting"
          ? "Supporting"
          : support === "leaning"
            ? "Leaning"
            : support === "opposed"
              ? "Opposed"
              : "Unknown";
      const pledge = String(row.pledgeStatus || "undecided");
      const pledgeClass =
        pledge === "yes"
          ? "pledge-pill pledge-pill--pledged"
          : pledge === "no"
            ? "pledge-pill pledge-pill--not-pledged"
            : "pledge-pill pledge-pill--undecided";
      const pledgeText = pledgeLabel(pledge);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="data-table-col--seq">${escapeHtml(sequenceAsImportedFromCsv(row) || "—")}</td>
        <td>${imageCell}</td>
        <td class="data-table-col--name">${escapeHtml(row.name || "—")}</td>
        <td>${escapeHtml(row.nationalId || "—")}</td>
        <td>${escapeHtml(row.address || "—")}</td>
        <td>${escapeHtml(row.phone || "—")}</td>
        <td>${escapeHtml(row.ballotBox || "—")}</td>
        <td><span class="${escapeHtml(pledgeClass)}">${escapeHtml(pledgeText)}</span></td>
        <td class="settings-agents-actions-col">
          <div class="settings-agents-crud" role="group" aria-label="Participant actions">
            <button type="button" class="ghost-button ghost-button--small" data-edit-row="${id}">Edit</button>
            <button type="button" class="ghost-button ghost-button--small settings-agents-crud__delete" data-delete-row="${id}">Delete</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("[data-edit-row]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rowId = btn.getAttribute("data-edit-row");
        const existing = rows.find((x) => String(x.id) === String(rowId));
        if (existing) openAddManualParticipantForm(existing, rowId);
      });
    });
    tbody.querySelectorAll("[data-delete-row]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rowId = btn.getAttribute("data-delete-row");
        if (!rowId) return;
        rows = rows.filter((x) => String(x.id) !== String(rowId));
        renderRows();
        syncParticipantCountToEvent(rows.length);
        if (api.deleteEventParticipantRowFs) await api.deleteEventParticipantRowFs(token, rowId);
      });
    });
  }

  function openAddManualParticipantForm(seed = {}, existingRowId = null) {
    const formBody = document.createElement("div");
    formBody.className = "form-grid";
    formBody.innerHTML = `
      <div class="form-group">
        <label for="epName">Full name <span class="text-muted">(required)</span></label>
        <input id="epName" class="input" value="${escapeHtml(seed.name || "")}" placeholder="First Last">
      </div>
      <div class="form-group">
        <label for="epNationalId">ID Number</label>
        <input id="epNationalId" class="input" value="${escapeHtml(seed.nationalId || "")}" placeholder="National ID">
      </div>
      <div class="form-group">
        <label for="epPhone">Phone</label>
        <input id="epPhone" class="input" value="${escapeHtml(seed.phone || "")}" placeholder="Phone">
      </div>
        <div class="form-group">
          <label for="epSequence">Seq</label>
          <input id="epSequence" class="input" value="${escapeHtml(sequenceAsImportedFromCsv(seed))}" placeholder="Sequence">
        </div>
      <div class="form-group">
        <label for="epAddress">Address</label>
        <input id="epAddress" class="input" value="${escapeHtml(seed.address || "")}" placeholder="Permanent address">
      </div>
      <div class="form-group">
        <label for="epCurrentLocation">Current location</label>
        <input id="epCurrentLocation" class="input" value="${escapeHtml(seed.currentLocation || "")}" placeholder="Current location">
      </div>
        <div class="form-group">
          <label for="epBallotBox">Ballot box</label>
          <input id="epBallotBox" class="input" value="${escapeHtml(seed.ballotBox || "")}" placeholder="Ballot box">
        </div>
        <div class="form-group">
          <label for="epIsland">Island</label>
          <input id="epIsland" class="input" value="${escapeHtml(seed.island || "")}" placeholder="Island">
        </div>
        <div class="form-group">
          <label for="epPledge">Pledge</label>
          <select id="epPledge" class="input agent-dropdown-select agent-dropdown-select--modal">
            <option value="undecided"${(seed.pledgeStatus || "undecided") === "undecided" ? " selected" : ""}>Undecided</option>
            <option value="yes"${seed.pledgeStatus === "yes" ? " selected" : ""}>Yes</option>
            <option value="no"${seed.pledgeStatus === "no" ? " selected" : ""}>No</option>
          </select>
        </div>
        <div class="form-group">
          <label for="epSupport">Support</label>
          <select id="epSupport" class="input agent-dropdown-select agent-dropdown-select--modal">
            <option value="unknown"${(seed.supportStatus || "unknown") === "unknown" ? " selected" : ""}>Unknown</option>
            <option value="supporting"${seed.supportStatus === "supporting" ? " selected" : ""}>Supporting</option>
            <option value="leaning"${seed.supportStatus === "leaning" ? " selected" : ""}>Leaning</option>
            <option value="opposed"${seed.supportStatus === "opposed" ? " selected" : ""}>Opposed</option>
          </select>
        </div>
        <div class="form-group">
          <label for="epVotedAt">Voted at</label>
          <input id="epVotedAt" class="input" value="${escapeHtml(seed.votedAt || "")}" placeholder="YYYY-MM-DD HH:mm">
        </div>
      <div class="form-group" style="grid-column:1 / -1;">
        <label for="epNotes">Notes</label>
        <input id="epNotes" class="input" value="${escapeHtml(seed.notes || "")}" placeholder="Optional notes">
      </div>
    `;
    const footer = document.createElement("div");
    footer.style.display = "flex";
    footer.style.gap = "8px";
    footer.style.justifyContent = "flex-end";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost-button";
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary-button";
    const isEdit = !!existingRowId;
    saveBtn.textContent = isEdit ? "Update participant" : "Create participant";
    cancelBtn.addEventListener("click", () => {
      closeModal();
      openModal({ title, body, footer: mainFooter });
    });
    saveBtn.addEventListener("click", async () => {
      const name = formBody.querySelector("#epName").value.trim();
      const nationalId = formBody.querySelector("#epNationalId").value.trim();
      const phone = formBody.querySelector("#epPhone").value.trim();
      const sequenceRaw = formBody.querySelector("#epSequence").value.trim();
      const address = formBody.querySelector("#epAddress").value.trim();
      const currentLocation = formBody.querySelector("#epCurrentLocation").value.trim();
      const ballotBox = formBody.querySelector("#epBallotBox").value.trim();
      const island = formBody.querySelector("#epIsland").value.trim();
      const pledgeStatus = formBody.querySelector("#epPledge").value.trim() || "undecided";
      const supportStatus = formBody.querySelector("#epSupport").value.trim() || "unknown";
      const votedAt = formBody.querySelector("#epVotedAt").value.trim();
      const notes = formBody.querySelector("#epNotes").value.trim();
      if (!name) return;
      const rowId =
        existingRowId || "p-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
      const row = {
        id: rowId,
        sequence: sequenceRaw,
        name,
        nationalId,
        phone,
        address,
        currentLocation,
        ballotBox,
        island,
        pledgeStatus,
        supportStatus,
        votedAt,
        notes,
      };
      if (isEdit) {
        const idx = rows.findIndex((x) => String(x.id) === String(rowId));
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
      } else {
        rows.push(row);
      }
      await api.setEventParticipantRowFs(token, rowId, row);
      syncParticipantCountToEvent(rows.length);
      closeModal();
      openModal({ title, body, footer: mainFooter });
      renderRows();
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    closeModal();
    openModal({ title: isEdit ? "Update participant" : "Create participant", body: formBody, footer });
  }

  body.querySelector("#eventParticipantsAddManualBtn").addEventListener("click", () => {
    openAddManualParticipantForm();
  });
  fromVoterInput?.addEventListener("focus", renderVoterPickerMenu);
  fromVoterInput?.addEventListener("input", renderVoterPickerMenu);
  fromVoterMenu?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-voter-id]");
    if (!btn || !fromVoterInput) return;
    const voterId = String(btn.getAttribute("data-voter-id") || "");
    const voter = voters.find((v) => String(v.id) === voterId);
    if (!voter) return;
    fromVoterInput.value = String(voter.fullName || "");
    fromVoterInput.setAttribute("data-selected-voter-id", voterId);
    fromVoterMenu.style.display = "none";
  });
  body.querySelector("#eventParticipantPicker")?.addEventListener("focusout", () => {
    window.setTimeout(() => {
      const root = body.querySelector("#eventParticipantPicker");
      const active = document.activeElement;
      if (root && !root.contains(active) && fromVoterMenu) {
        fromVoterMenu.style.display = "none";
      }
    }, 0);
  });
  body.querySelector("#eventParticipantsAddFromVoterBtn").addEventListener("click", () => {
    const selectedId = String(fromVoterInput?.getAttribute("data-selected-voter-id") || "").trim();
    const typed = String(fromVoterInput?.value || "").trim();
    const voter =
      (selectedId && voters.find((v) => String(v.id) === selectedId)) ||
      findVoterFromSearchInput(typed);
    if (!voter) return;
    openAddManualParticipantForm({
      sequence: voter.sequence != null ? voter.sequence : "",
      name: voter.fullName || "",
      nationalId: voter.nationalId || voter.id || "",
      phone: voter.phone || "",
      address: voter.permanentAddress || "",
      currentLocation: voter.currentLocation || "",
      ballotBox: voter.ballotBox || "",
      island: voter.island || "",
      pledgeStatus: voter.pledgeStatus || "undecided",
      supportStatus: voter.supportStatus || "unknown",
      votedAt: voter.votedAt || "",
      notes: "",
    });
    if (fromVoterInput) fromVoterInput.setAttribute("data-selected-voter-id", String(voter.id || ""));
  });
  body.querySelector("#eventParticipantsRefreshBtn").addEventListener("click", async () => {
    if (api.getEventParticipantRowsFromServerFs) {
      rows = await api.getEventParticipantRowsFromServerFs(token);
      rows = normalizeRowsWithVoters(rows);
      renderRows();
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Participants refreshed", meta: event.name || "Event" });
      }
    }
  });
  body.querySelector("#eventParticipantsCopyLinkBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      if (window.showToast) window.showToast("Participants share link copied");
    });
  });
  body.querySelector("#eventParticipantsOpenLinkBtn").addEventListener("click", () => {
    window.open(shareUrl, "_blank", "noopener,noreferrer");
  });
  searchEl?.addEventListener("input", renderRows);
  filterPledgeEl?.addEventListener("change", renderRows);
  filterBoxEl?.addEventListener("change", renderRows);
  sortEl?.addEventListener("change", renderRows);
  groupByEl?.addEventListener("change", renderRows);

  let unsubscribeRows = null;
  if (api.onEventParticipantRowsSnapshotFs) {
    unsubscribeRows = api.onEventParticipantRowsSnapshotFs(token, (items) => {
      rows = Array.isArray(items) ? items : [];
      rows = normalizeRowsWithVoters(rows);
      syncParticipantCountToEvent(rows.length);
      renderRows();
    });
  }

  const mainFooter = document.createElement("div");
  mainFooter.style.display = "flex";
  mainFooter.style.flexWrap = "wrap";
  mainFooter.style.gap = "8px";
  mainFooter.style.justifyContent = "flex-end";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "ghost-button";
  copyBtn.textContent = "Copy share link";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      if (window.showToast) window.showToast("Participants share link copied");
    });
  });
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "ghost-button";
  openBtn.textContent = "Open shared view";
  openBtn.addEventListener("click", () => window.open(shareUrl, "_blank", "noopener,noreferrer"));
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "primary-button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => {
    if (typeof unsubscribeRows === "function") unsubscribeRows();
    closeModal();
  });
  copyBtn.style.display = "none";
  mainFooter.appendChild(copyBtn);
  mainFooter.appendChild(openBtn);
  mainFooter.appendChild(closeBtn);

  renderRows();
  syncParticipantCountToEvent(rows.length);
  openModal({ title, body, footer: mainFooter, startMaximized: true });
}

function renderEventsTimeline() {
  eventsTimeline.innerHTML = "";
  const sorted = [...events].sort(
    (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
  );

  sorted.forEach((ev) => {
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.innerHTML = `
      <div class="timeline-item__time">${formatDateTime(ev.dateTime)}</div>
      <div class="timeline-item__content">
        <div><strong>${ev.name}</strong></div>
        <div class="helper-text">${ev.location} • ${ev.scope} • ${
      ev.team
    }</div>
      </div>
    `;
    eventsTimeline.appendChild(item);
  });
}

function openEventForm(existing) {
  const body = document.createElement("div");
  const isEdit = !!existing;
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="eventName">Event name</label>
        <input id="eventName" type="text" value="${existing?.name || ""}">
      </div>
      <div class="form-group">
        <label for="eventLocation">Event location</label>
        <input id="eventLocation" type="text" value="${
          existing?.location || ""
        }">
      </div>
      <div class="form-group">
        <label for="eventScope">Island / Constituency</label>
        <input id="eventScope" type="text" value="${existing?.scope || ""}">
      </div>
      <div class="form-group">
        <label for="eventDateTime">Date &amp; time</label>
        <input id="eventDateTime" type="datetime-local" value="${
          existing
            ? existing.dateTime.slice(0, 16)
            : new Date().toISOString().slice(0, 16)
        }">
      </div>
      <div class="form-group">
        <label for="eventTeam">Assigned campaign team</label>
        <input id="eventTeam" type="text" value="${existing?.team || ""}">
      </div>
      <div class="form-group">
        <label for="eventAttendees">Expected attendees</label>
        <input id="eventAttendees" type="number" min="0" value="${
          existing?.expectedAttendees || 0
        }">
      </div>
    </div>
  `;

  const footer = document.createElement("div");
  const saveBtn = document.createElement("button");
  saveBtn.className = "primary-button";
  saveBtn.textContent = isEdit ? "Save changes" : "Add event";
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", async () => {
    const name = body.querySelector("#eventName").value.trim();
    const location = body.querySelector("#eventLocation").value.trim();
    const scope = body.querySelector("#eventScope").value.trim();
    const dateTime = body
      .querySelector("#eventDateTime")
      .value.trim();
    const team = body.querySelector("#eventTeam").value.trim();
    const attendees = Number(
      body.querySelector("#eventAttendees").value || 0
    );

    if (!name || !location || !scope || !dateTime) {
      return;
    }

    let id = existing?.id;
    if (!id) {
      // Generate a stable numeric id based on current max
      id = events.reduce((max, ev) => Math.max(max, Number(ev.id) || 0), 0) + 1;
    }

    // Update local array optimistically
    const idx = events.findIndex((ev) => String(ev.id) === String(id));
    const updated = {
      id,
      name,
      location,
      scope,
      dateTime,
      team,
      expectedAttendees: attendees,
      participantsShareToken: existing?.participantsShareToken || "",
      participantCount: existing?.participantCount || 0,
    };
    if (idx >= 0) {
      events[idx] = updated;
    } else {
      events.push(updated);
    }

    // Persist to Firestore if available
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setEventFs) {
        await api.setEventFs(id, {
          name,
          location,
          scope,
          dateTime,
          team,
          expectedAttendees: attendees,
          participantsShareToken: existing?.participantsShareToken || "",
          participantCount: existing?.participantCount || 0,
        });
      }
    } catch (e) {
      console.error("[Events] Failed to save event to Firestore", e);
    }

    renderEventsTable();
    renderEventsTimeline();
    document.dispatchEvent(
      new CustomEvent("events-updated", { detail: { events: [...events] } })
    );
    if (window.appNotifications) {
      window.appNotifications.push({
        title: isEdit ? "Event updated" : "Event added",
        meta: `${name} • ${scope}`,
      });
    }
    closeModal();
  });

  openModal({
    title: isEdit ? "Edit event" : "Add event",
    body,
    footer,
  });
}

export function initEventsModule() {
  // Load from Firestore and subscribe to changes
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllEventsFs && api.onEventsSnapshotFs) {
        const initial = await api.getAllEventsFs();
        events = initial.map((ev) => ({
          id: ev.id,
          name: ev.name || "",
          location: ev.location || "",
          scope: ev.scope || "",
          dateTime: ev.dateTime || new Date().toISOString(),
          team: ev.team || "",
          expectedAttendees: ev.expectedAttendees ?? 0,
          participantsShareToken: ev.participantsShareToken || "",
          participantCount: Number(ev.participantCount || 0),
        }));
        renderEventsTable();
        renderEventsTimeline();
        document.dispatchEvent(
          new CustomEvent("events-updated", { detail: { events: [...events] } })
        );

        eventsUnsubscribe = api.onEventsSnapshotFs((items) => {
          events = items.map((ev) => ({
            id: ev.id,
            name: ev.name || "",
            location: ev.location || "",
            scope: ev.scope || "",
            dateTime: ev.dateTime || new Date().toISOString(),
            team: ev.team || "",
            expectedAttendees: ev.expectedAttendees ?? 0,
            participantsShareToken: ev.participantsShareToken || "",
            participantCount: Number(ev.participantCount || 0),
          }));
          renderEventsTable();
          renderEventsTimeline();
          document.dispatchEvent(
            new CustomEvent("events-updated", { detail: { events: [...events] } })
          );
        });
      } else {
        // Fallback to empty local state
        renderEventsTable();
        renderEventsTimeline();
      }
    } catch (e) {
      console.error("[Events] Failed to initialize events from Firestore", e);
      renderEventsTable();
      renderEventsTimeline();
    }
  })();

  eventsTableBody.addEventListener("click", (e) => {
    const participantsBtn = e.target.closest("[data-event-participants]");
    const btn = e.target.closest("[data-edit-event]");
    if (participantsBtn) {
      const id = Number(participantsBtn.getAttribute("data-event-participants"));
      const ev = events.find((x) => Number(x.id) === id);
      if (ev) openEventParticipantsModal(ev);
      return;
    }
    if (btn) {
      const id = Number(btn.getAttribute("data-edit-event"));
      const existing = events.find((ev) => ev.id === id);
      if (existing) {
        openEventForm(existing);
      }
    }
  });

  addEventButton.addEventListener("click", () => {
    openEventForm(null);
  });

  return {
    getEvents: () => [...events],
  };
}

export function getUpcomingEventsSummary(scope) {
  const now = new Date();
  const soon = events
    .filter((ev) => new Date(ev.dateTime) >= now)
    .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime))
    .slice(0, 4);

  return soon.map((ev) => ({
    dateLabel: formatDateTime(ev.dateTime),
    name: ev.name,
    location: ev.location,
    scope: ev.scope,
    team: ev.team,
  }));
}

export async function refreshEventsFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getAllEventsFs) return;
    const initial = await api.getAllEventsFs();
    if (!Array.isArray(initial)) return;
    events = initial.map((ev) => ({
      id: ev.id,
      name: ev.name || "",
      location: ev.location || "",
      scope: ev.scope || "",
      dateTime: ev.dateTime || new Date().toISOString(),
      team: ev.team || "",
      expectedAttendees: ev.expectedAttendees ?? 0,
      participantsShareToken: ev.participantsShareToken || "",
      participantCount: Number(ev.participantCount || 0),
    }));
    renderEventsTable();
    renderEventsTimeline();
    document.dispatchEvent(
      new CustomEvent("events-updated", { detail: { events: [...events] } })
    );
  } catch (e) {
    console.warn("[Events] refreshEventsFromFirestore", e);
  }
}

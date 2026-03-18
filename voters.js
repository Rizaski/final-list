import { openModal, closeModal, confirmDialog } from "./ui.js";
import { firebaseInitPromise } from "./firebase.js";
import {
  getVotedTimeMarked,
  mergeVotedAtFromVoters,
  clearVotedForVoter,
  getAvailableTransportRoutes,
} from "./zeroDay.js";
import {
  getLists,
  createList,
  openListWorkspace,
} from "./lists.js";

const PAGE_SIZE = 15;
const VOTERS_STORAGE_KEY = "voters-data";

// Dynamic data: starts empty and is populated via bulk upload and in-app actions.
let currentVoters = [];

function loadVotersFromStorage() {
  try {
    const raw = localStorage.getItem(VOTERS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) currentVoters = parsed;
    }
  } catch (_) {}
}

function saveVotersToStorage() {
  try {
    localStorage.setItem(VOTERS_STORAGE_KEY, JSON.stringify(currentVoters));
  } catch (_) {}
}
let selectedVoterId = null;
let votersCurrentPage = 1;
let unsubscribeVotersFs = null;

const VOTER_TABLE_COLUMN_COUNT = 8;

const votersTableBody = document.querySelector("#votersTable tbody");
const votersPaginationEl = document.getElementById("votersPagination");
const voterSearchInput = document.getElementById("voterSearch");
const voterSortEl = document.getElementById("voterSort");
const voterFilterPledgeEl = document.getElementById("voterFilterPledge");
const voterGroupByEl = document.getElementById("voterGroupBy");
const voterDetailsSubtitle = document.getElementById("voterDetailsSubtitle");
const voterDetailsContent = document.getElementById("voterDetailsContent");
const voterNotesTextarea = document.getElementById("voterNotes");
const saveVoterNotesButton = document.getElementById("saveVoterNotesButton");
const voterInteractionTimeline = document.getElementById(
  "voterInteractionTimeline"
);

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Base path for voter ID-based images (folder must be next to index.html, e.g. /photos/). */
const VOTER_IMAGES_BASE = "photos/";

/**
 * Returns the first image URL to try for a voter. Uses explicit photoUrl if set,
 * otherwise builds a path under /photos using the national ID so that images
 * named by ID card number (e.g. 12345.jpg) load. Caller should use onerror to
 * try .jpeg / .png when .jpg fails.
 */
export function getVoterImageSrc(voter) {
  if (!voter) return "";
  // Always derive from ID so that images live in /photos and aren't affected
  // by any legacy CSV image paths.
  const rawId = (voter.nationalId || voter.id || "").toString().trim();
  const id = rawId.replace(/\s+/g, "");
  if (!id) return "";
  return VOTER_IMAGES_BASE + id + ".jpg";
}

function supportBadgeClass(status) {
  switch (status) {
    case "supporting":
      return "badge badge--supporting";
    case "leaning":
      return "badge badge--leaning";
    case "opposed":
      return "badge badge--opposed";
    default:
      return "badge badge--unknown";
  }
}

function pledgePillClass(status) {
  switch (status) {
    case "yes":
      return "pledge-pill pledge-pill--pledged";
    case "undecided":
      return "pledge-pill pledge-pill--undecided";
    default:
      return "pledge-pill pledge-pill--not-pledged";
  }
}

function getFilteredSortedGroupedVoters() {
  const query = (voterSearchInput?.value || "").toLowerCase().trim();
  const pledgeFilter = voterFilterPledgeEl?.value || "all";
  const sortBy = voterSortEl?.value || "sequence";
  const groupBy = voterGroupByEl?.value || "none";

  let list = currentVoters.filter((voter) => {
    if (pledgeFilter !== "all" && voter.pledgeStatus !== pledgeFilter)
      return false;
    if (query) {
      const name = (voter.fullName || "").toLowerCase();
      const id = (voter.id || "").toLowerCase();
      const nationalId = (voter.nationalId || "").toLowerCase();
      const phone = (voter.phone || "").toLowerCase();
      const address = (voter.permanentAddress || "").toLowerCase();
      const island = (voter.island || "").toLowerCase();
      const notes = (voter.notes || "").toLowerCase();
      if (
        !name.includes(query) &&
        !id.includes(query) &&
        !nationalId.includes(query) &&
        !phone.includes(query) &&
        !address.includes(query) &&
        !island.includes(query) &&
        !notes.includes(query)
      )
        return false;
    }
    return true;
  });

  const cmp = (a, b) => {
    switch (sortBy) {
      case "sequence":
        return (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
      case "name-desc":
        return (b.fullName || "").localeCompare(a.fullName || "", "en");
      case "island":
        return (a.island || "").localeCompare(b.island || "", "en");
      case "pledge":
        return (a.pledgeStatus || "").localeCompare(b.pledgeStatus || "", "en");
      case "address":
        return (a.permanentAddress || "").localeCompare(
          b.permanentAddress || "",
          "en"
        );
      case "id":
        return (a.nationalId || "").localeCompare(b.nationalId || "", "en");
      default:
        return (a.fullName || "").localeCompare(b.fullName || "", "en");
    }
  };
  list = list.slice().sort(cmp);

  if (groupBy === "none") {
    return list.map((voter) => ({ type: "row", voter }));
  }

  const getGroupKey = (v) => {
    if (groupBy === "island") return v.ballotBox || "Unassigned";
    if (groupBy === "pledge") return v.pledgeStatus || "undecided";
    return "";
  };
  const displayList = [];
  let lastKey = null;
  list.forEach((voter) => {
    const key = getGroupKey(voter);
    if (key !== lastKey) {
      displayList.push({ type: "group", label: key });
      lastKey = key;
    }
    displayList.push({ type: "row", voter });
  });
  return displayList;
}

/** Returns voter IDs from current filter/sort (no grouping). Used for "Create list from search". */
export function getCurrentFilteredVoterIds() {
  const displayList = getFilteredSortedGroupedVoters();
  return displayList.filter((x) => x.type === "row").map((x) => x.voter.id);
}

function renderVotersTable() {
  if (!votersTableBody) return;
  const displayList = getFilteredSortedGroupedVoters();
  const dataRows = displayList.filter((x) => x.type === "row");
  const total = dataRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (votersCurrentPage > totalPages) votersCurrentPage = totalPages;
  const start = (votersCurrentPage - 1) * PAGE_SIZE;
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

  votersTableBody.innerHTML = "";

  if (total === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${VOTER_TABLE_COLUMN_COUNT}" class="text-muted" style="text-align:center;padding:24px;">No voters. Add a voter or import from Settings → Data.</td>`;
    votersTableBody.appendChild(tr);
  }

  for (const item of pageDisplayList) {
    if (item.type === "group") {
      const tr = document.createElement("tr");
      tr.className = "list-toolbar__group-header";
      tr.innerHTML = `<td colspan="${VOTER_TABLE_COLUMN_COUNT}">${escapeHtml(item.label)}</td>`;
      votersTableBody.appendChild(tr);
      continue;
    }
    const voter = item.voter;
    const tr = document.createElement("tr");
    tr.dataset.voterId = voter.id;
    if (voter.id === selectedVoterId) {
      tr.classList.add("is-selected");
    }
    const initials = (voter.fullName || "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?";
    const photoSrc = getVoterImageSrc(voter);
    const photoCell = photoSrc
      ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${initials}</div></div>`
      : `<div class="avatar-cell"><div class="avatar-circle">${initials}</div></div>`;
    const timeMarked = voter.votedAt || getVotedTimeMarked(voter.id);
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
    tr.innerHTML = `
      <td>${voter.sequence ?? ""}</td>
      <td>${photoCell}</td>
      <td>${voter.nationalId ?? ""}</td>
      <td>${voter.fullName}</td>
      <td>${voter.permanentAddress ?? ""}</td>
      <td><span class="${pledgePillClass(
        voter.pledgeStatus
      )}">${voter.pledgeStatus || "No"}</span></td>
      <td class="voted-status-cell">${votedCell}</td>
      <td style="text-align:right;">
        <button type="button" class="ghost-button ghost-button--small" data-voter-edit="${escapeHtml(
          voter.id
        )}" title="Edit">Edit</button>
        <button type="button" class="ghost-button ghost-button--small" data-voter-delete="${escapeHtml(
          voter.id
        )}" title="Delete">Delete</button>
        ${
          timeMarked
            ? `<button type="button" class="ghost-button ghost-button--small" data-voter-unmark="${escapeHtml(
                voter.id
              )}" title="Mark not voted">Not voted</button>`
            : ""
        }
      </td>
    `;
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-voter-edit], [data-voter-delete]")) return;
      selectVoter(voter.id);
    });
    votersTableBody.appendChild(tr);
  }

  if (votersPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    votersPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${votersCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${votersCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${votersCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    votersPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && votersCurrentPage > 1) votersCurrentPage--;
        if (btn.dataset.page === "next" && votersCurrentPage < totalPages) votersCurrentPage++;
        renderVotersTable();
      });
    });
  }

  updateVoterSortIndicators();
}

function updateVoterSortIndicators() {
  const headers = document.querySelectorAll("#votersTable thead th.th-sortable");
  if (!headers.length) return;
  const sortBy = voterSortEl?.value || "sequence";
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

function bindVoterTableHeaderSort() {
  const thead = document.querySelector("#votersTable thead");
  if (!thead) return;
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.th-sortable");
    if (!th) return;
    const key = th.getAttribute("data-sort-key");
    if (!key || !voterSortEl) return;
    if (key === "name") {
      voterSortEl.value = voterSortEl.value === "name-asc" ? "name-desc" : "name-asc";
    } else {
      voterSortEl.value = key;
    }
    votersCurrentPage = 1;
    renderVotersTable();
  });
}

function formatDobAndAge(voter) {
  const dobRaw = voter?.dateOfBirth || "";
  if (!dobRaw) {
    return { dobDisplay: "", ageDisplay: voter?.age || "" };
  }
  const parsed = new Date(dobRaw);
  if (Number.isNaN(parsed.getTime())) {
    // Fallback: show raw value if date cannot be parsed
    return { dobDisplay: dobRaw, ageDisplay: voter?.age || "" };
  }
  const dobDisplay = parsed.toLocaleDateString("en-MV", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const today = new Date();
  let age = today.getFullYear() - parsed.getFullYear();
  const m = today.getMonth() - parsed.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < parsed.getDate())) {
    age--;
  }
  const ageDisplay = age >= 0 && Number.isFinite(age) ? `${age}` : voter?.age || "";
  return { dobDisplay, ageDisplay };
}

function renderVoterDetails(voter) {
  if (!voter) {
    voterDetailsSubtitle.textContent =
      "Select a voter from the list to view details.";
    voterDetailsContent.innerHTML = "";
    voterInteractionTimeline.innerHTML = "";
    voterNotesTextarea.value = "";
    voterNotesTextarea.disabled = true;
    saveVoterNotesButton.disabled = true;
    return;
  }

  const { dobDisplay, ageDisplay } = formatDobAndAge(voter);
  const availableRoutes = getAvailableTransportRoutes();
  const transportRoute = voter.transportRoute || "";
  const transportType = voter.transportType || "oneway";

  voterDetailsSubtitle.textContent = voter.fullName;
  const detailsPhotoSrc = getVoterImageSrc(voter);
  const detailsInitials =
    (voter.fullName || "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?";
  const detailsPhoto = detailsPhotoSrc
    ? `<div class="avatar-cell avatar-cell--large"><img class="avatar-img" src="${escapeHtml(
        detailsPhotoSrc
      )}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${detailsInitials}</div></div>`
    : `<div class="avatar-cell avatar-cell--large"><div class="avatar-circle">${detailsInitials}</div></div>`;
  voterDetailsContent.innerHTML = `
    <div class="voter-details-layout">
      <section class="voter-details-section">
        <h3 class="voter-details-section__title">Identity &amp; registration</h3>
        <div class="details-grid details-grid--two-column">
          <div>
            ${detailsPhoto}
          </div>
          <div>
            <div class="detail-item-label">Full name</div>
            <div class="detail-item-value">${voter.fullName}</div>
          </div>
          <div>
            <div class="detail-item-label">National ID</div>
            <div class="detail-item-value">${voter.nationalId}</div>
          </div>
          <div>
            <div class="detail-item-label">Sequence</div>
            <div class="detail-item-value">${voter.sequence ?? ""}</div>
          </div>
          <div>
            <div class="detail-item-label">Ballot box</div>
            <div class="detail-item-value">${voter.ballotBox ?? ""}</div>
          </div>
          <div>
            <div class="detail-item-label">Date of birth</div>
            <div class="detail-item-value">${dobDisplay}</div>
          </div>
          <div>
            <div class="detail-item-label">Age</div>
            <div class="detail-item-value">${ageDisplay}</div>
          </div>
        </div>
      </section>

      <section class="voter-details-section">
        <h3 class="voter-details-section__title">Address &amp; contact</h3>
        <div class="details-grid details-grid--two-column">
          <div>
            <div class="detail-item-label">Permanent address</div>
            <div class="detail-item-value">${voter.permanentAddress ?? ""}</div>
          </div>
          <div>
            <div class="detail-item-label">Island</div>
            <div class="detail-item-value">${voter.island}</div>
          </div>
          <div>
            <div class="detail-item-label">Current location</div>
            <div class="detail-item-value">${voter.currentLocation ?? ""}</div>
          </div>
          <div>
            <div class="detail-item-label">Phone number</div>
            <div class="detail-item-value">${voter.phone}</div>
          </div>
        </div>
      </section>

      <section class="voter-details-section voter-details-section--full">
        <h3 class="voter-details-section__title">Status</h3>
        <div class="details-grid details-grid--two-column">
          <div>
            <div class="detail-item-label">Support status</div>
            <div class="detail-item-value">
              <span class="${supportBadgeClass(
                voter.supportStatus
              )}">${voter.supportStatus || "Unknown"}</span>
            </div>
          </div>
          <div>
            <div class="detail-item-label">Pledge status</div>
            <div class="detail-item-value">
              <span class="${pledgePillClass(
                voter.pledgeStatus
              )}">${voter.pledgeStatus || "No"}</span>
            </div>
          </div>
          <div>
            <div class="detail-item-label">Marked voted</div>
            <div class="detail-item-value">${(function () {
              const timeMarked = voter.votedAt || getVotedTimeMarked(voter.id);
              if (timeMarked) {
                const d = new Date(timeMarked);
                const formatted = d.toLocaleString("en-MV", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return `<span class="pledge-pill pledge-pill--pledged">Yes</span> ${formatted}`;
              }
              return '<span class="pledge-pill pledge-pill--undecided">No</span>';
            })()}</div>
          </div>
        </div>
      </section>

      <section class="voter-details-section voter-details-section--full">
        <h3 class="voter-details-section__title">Transportation</h3>
        <div class="details-grid details-grid--two-column">
          <div>
            <div class="detail-item-label">Transportation needed</div>
            <div class="detail-item-value">
              <label style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" id="voterTransportNeeded" ${
                  voter.transportNeeded ? "checked" : ""
                }>
                <span>${voter.transportNeeded ? "Yes" : "No"}</span>
              </label>
            </div>
          </div>
          <div>
            <div class="detail-item-label">Route &amp; direction</div>
            <div class="detail-item-value">
              ${
                availableRoutes.length
                  ? `<div class="field-group">
                       <label for="voterTransportRoute" class="sr-only">Route</label>
                       <select id="voterTransportRoute" class="input"${
                         voter.transportNeeded ? "" : " disabled"
                       }>
                         <option value="">Select route…</option>
                         ${availableRoutes
                           .map((route) => {
                             const isSelected = route === transportRoute;
                             return `<option value="${escapeHtml(route)}"${
                               isSelected ? " selected" : ""
                             }>${escapeHtml(route)}</option>`;
                           })
                           .join("")}
                       </select>
                     </div>
                     <div class="pill-toggle-group" style="margin-top:8px;">
                       <span class="detail-item-label" style="margin-right:4px;">Trip type</span>
                       <button type="button" class="pill-toggle${
                         transportType !== "return" ? " pill-toggle--active" : ""
                       }" data-transport-type="oneway"${
                         voter.transportNeeded ? "" : " disabled"
                       }>One way</button>
                       <button type="button" class="pill-toggle${
                         transportType === "return" ? " pill-toggle--active" : ""
                       }" data-transport-type="return"${
                         voter.transportNeeded ? "" : " disabled"
                       }>Return</button>
                     </div>
                     <p class="helper-text" style="margin-top:4px;">Choose the route this voter will use and whether transport is one way or return.</p>`
                  : '<p class="helper-text">No transport routes yet. Add trips in Zero Day → Transport.</p>'
              }
              ${
                voter.transportNeeded && transportRoute
                  ? `<div class="badge badge--supporting" style="display:inline-flex;align-items:center;margin-top:8px;">
                       <span>${escapeHtml(
                         transportRoute
                       )}</span>
                       <span style="margin-left:6px;font-size:12px;opacity:0.9;">${
                         transportType === "return" ? "Return trip" : "One way"
                       }</span>
                     </div>`
                  : ""
              }
            </div>
          </div>
        </div>
      </section>
    </div>
  `;

  voterNotesTextarea.disabled = false;
  voterNotesTextarea.value = voter.notes || "";
  saveVoterNotesButton.disabled = true;

  voterInteractionTimeline.innerHTML = "";
  if (!voter.interactions || voter.interactions.length === 0) {
    const li = document.createElement("li");
    li.className = "timeline-item";
    li.innerHTML = `
      <div class="timeline-item__time">–</div>
      <div class="timeline-item__content">
        <div>No recorded campaign interactions for this voter yet.</div>
      </div>
    `;
    voterInteractionTimeline.appendChild(li);
  } else {
    voter.interactions.forEach((it) => {
      const li = document.createElement("li");
      li.className = "timeline-item";
      li.innerHTML = `
        <div class="timeline-item__time">${it.date}</div>
        <div class="timeline-item__content">
          <div><strong>${it.type}</strong></div>
          <div class="helper-text">By ${it.by}</div>
        </div>
      `;
      voterInteractionTimeline.appendChild(li);
    });
  }

  // Bind notes
  voterNotesTextarea.disabled = false;
  voterNotesTextarea.value = voter.notes || "";
  saveVoterNotesButton.disabled = true;

  // Bind transportation controls
  const transportNeededEl = document.getElementById("voterTransportNeeded");
  const transportRouteEl = document.getElementById("voterTransportRoute");
  const transportTypeEls = Array.from(
    document.querySelectorAll("[data-transport-type]")
  );
  if (transportNeededEl && transportRouteEl) {
    const updateRoutesDisabled = () => {
      const disabled = !transportNeededEl.checked;
      transportRouteEl.disabled = disabled;
      transportTypeEls.forEach((el) => {
        el.disabled = disabled;
      });
    };

    const persistTransport = () => {
      const v = currentVoters.find((x) => x.id === voter.id);
      if (!v) return;
      v.transportNeeded = !!transportNeededEl.checked;
      v.transportRoute = transportRouteEl.value || "";
      const activeTypeEl =
        transportTypeEls.find((el) =>
          el.classList.contains("pill-toggle--active")
        ) || null;
      v.transportType = activeTypeEl
        ? activeTypeEl.getAttribute("data-transport-type") || "oneway"
        : "oneway";
      (async () => {
        try {
          const api = await firebaseInitPromise;
          if (api.ready && api.setVoterFs) await api.setVoterFs(v);
        } catch (_) {}
        saveVotersToStorage();
        renderVotersTable();
        if (selectedVoterId === v.id) renderVoterDetails(v);
        document.dispatchEvent(new CustomEvent("voters-updated"));
      })();
    };

    updateRoutesDisabled();
    transportNeededEl.addEventListener("change", () => {
      updateRoutesDisabled();
      persistTransport();
    });
    transportRouteEl.addEventListener("change", () => {
      persistTransport();
    });
    transportTypeEls.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        transportTypeEls.forEach((el) =>
          el.classList.remove("pill-toggle--active")
        );
        btn.classList.add("pill-toggle--active");
        persistTransport();
      });
    });
  }
}

function selectVoter(voterId) {
  selectedVoterId = voterId;
  renderVotersTable();
  const voter = currentVoters.find((v) => v.id === voterId);
  renderVoterDetails(voter);
}

function bindVoterToolbar() {
  const go = () => {
    votersCurrentPage = 1;
    renderVotersTable();
  };
  if (voterSearchInput) voterSearchInput.addEventListener("input", go);
  if (voterSortEl) voterSortEl.addEventListener("change", go);
  if (voterFilterPledgeEl) voterFilterPledgeEl.addEventListener("change", go);
  if (voterGroupByEl) voterGroupByEl.addEventListener("change", go);
}
bindVoterToolbar();

if (voterNotesTextarea) {
  voterNotesTextarea.addEventListener("input", () => {
    if (!selectedVoterId) return;
    if (saveVoterNotesButton) saveVoterNotesButton.disabled = false;
  });
}

if (saveVoterNotesButton) {
  saveVoterNotesButton.addEventListener("click", () => {
    if (!selectedVoterId) return;
    const voter = currentVoters.find((v) => v.id === selectedVoterId);
    if (!voter) return;
    voter.notes = voterNotesTextarea ? voterNotesTextarea.value : "";
    saveVoterNotesButton.disabled = true;
    (async () => {
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.setVoterFs) await api.setVoterFs(voter);
      } catch (_) {}
      saveVotersToStorage();
      if (selectedVoterId === voter.id) renderVoterDetails(voter);
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Voter notes saved",
          meta: voter.fullName || voter.nationalId || voter.id,
        });
      }
    })();
  });
}

document.addEventListener("global-search", (e) => {
  const query = (e.detail.query || "").toLowerCase();
  if (voterSearchInput) voterSearchInput.value = query;
  renderVotersTable();
});

function buildVoterFormFields(voter = null) {
  const v = voter || {};
  const support = (v.supportStatus || "unknown").toLowerCase();
  const met = (v.metStatus || "not-met").toLowerCase();
  const persuadable = (v.persuadable || "unknown").toLowerCase();
  const transportType = (v.transportType || "oneway").toLowerCase();
  const pledgedAt = (v.pledgedAt || "").trim();
  const votedAt = (v.votedAt || "").trim();
  const transportRoute = (v.transportRoute || "").trim();
  const transportNeeded = v.transportNeeded === true;
  return `
    <div class="content-tabs">
      <div class="content-tabs__list" role="tablist" aria-label="Edit voter sections">
        <button type="button" class="content-tabs__tab is-active" data-voter-edit-tab="identity" role="tab" aria-selected="true">Identity</button>
        <button type="button" class="content-tabs__tab" data-voter-edit-tab="contact" role="tab" aria-selected="false">Contact</button>
        <button type="button" class="content-tabs__tab" data-voter-edit-tab="campaign" role="tab" aria-selected="false">Campaign</button>
        <button type="button" class="content-tabs__tab" data-voter-edit-tab="transport" role="tab" aria-selected="false">Transport</button>
        <button type="button" class="content-tabs__tab" data-voter-edit-tab="notes" role="tab" aria-selected="false">Notes</button>
      </div>

      <div class="content-tabs__panel" id="voterEditTab-identity" data-voter-edit-panel="identity" role="tabpanel">
      <div class="form-section">
        <h3 class="form-section__title">Identity &amp; registration</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="voterFormId">Internal ID</label>
            <input id="voterFormId" type="text" value="${escapeHtml(
              v.id || ""
            )}" disabled>
          </div>
          <div class="form-group">
            <label for="voterFormNationalId">ID number</label>
            <input id="voterFormNationalId" type="text" value="${escapeHtml(
              v.nationalId || v.id || ""
            )}" placeholder="National ID">
          </div>
          <div class="form-group">
            <label for="voterFormName">Full name</label>
            <input id="voterFormName" type="text" value="${escapeHtml(
              v.fullName || ""
            )}" placeholder="Full name" required>
          </div>
          <div class="form-group">
            <label for="voterFormSequence">Sequence</label>
            <input id="voterFormSequence" type="number" value="${escapeHtml(
              v.sequence ?? ""
            )}" placeholder="Seq" min="1">
          </div>
          <div class="form-group">
            <label for="voterFormDob">Date of birth</label>
            <input id="voterFormDob" type="date" value="${escapeHtml(
              (v.dateOfBirth || "").slice(0, 10)
            )}">
          </div>
          <div class="form-group">
            <label for="voterFormAge">Age</label>
            <input id="voterFormAge" type="number" min="0" value="${escapeHtml(
              v.age ?? ""
            )}" placeholder="Age">
          </div>
          <div class="form-group">
            <label for="voterFormGender">Gender</label>
            <select id="voterFormGender">
              <option value=""${!v.gender ? " selected" : ""}>—</option>
              <option value="male"${
                String(v.gender || "").toLowerCase() === "male" ? " selected" : ""
              }>Male</option>
              <option value="female"${
                String(v.gender || "").toLowerCase() === "female" ? " selected" : ""
              }>Female</option>
              <option value="other"${
                String(v.gender || "").toLowerCase() === "other" ? " selected" : ""
              }>Other</option>
            </select>
          </div>
          <div class="form-group form-group--full">
            <label for="voterFormPhotoUrl">Photo URL (optional)</label>
            <input id="voterFormPhotoUrl" type="text" value="${escapeHtml(
              v.photoUrl || ""
            )}" placeholder="https://...">
          </div>
        </div>
      </div>
      </div>

      <div class="content-tabs__panel" id="voterEditTab-contact" data-voter-edit-panel="contact" role="tabpanel" hidden>
      <div class="form-section">
        <h3 class="form-section__title">Address &amp; contact</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="voterFormBallotBox">Ballot box</label>
            <input id="voterFormBallotBox" type="text" value="${escapeHtml(
              v.ballotBox || ""
            )}" placeholder="Ballot box">
          </div>
          <div class="form-group">
            <label for="voterFormIsland">Island</label>
            <input id="voterFormIsland" type="text" value="${escapeHtml(
              v.island || ""
            )}" placeholder="Island">
          </div>
          <div class="form-group form-group--full">
            <label for="voterFormAddress">Permanent address</label>
            <input id="voterFormAddress" type="text" value="${escapeHtml(
              v.permanentAddress || ""
            )}" placeholder="Address">
          </div>
          <div class="form-group">
            <label for="voterFormCurrentLocation">Current location</label>
            <input id="voterFormCurrentLocation" type="text" value="${escapeHtml(
              v.currentLocation || ""
            )}" placeholder="Current location">
          </div>
          <div class="form-group">
            <label for="voterFormPhone">Phone</label>
            <input id="voterFormPhone" type="text" value="${escapeHtml(
              v.phone || ""
            )}" placeholder="Phone">
          </div>
        </div>
      </div>
      </div>

      <div class="content-tabs__panel" id="voterEditTab-campaign" data-voter-edit-panel="campaign" role="tabpanel" hidden>
      <div class="form-section">
        <h3 class="form-section__title">Campaign status</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="voterFormSupport">Support status</label>
            <select id="voterFormSupport">
              <option value="supporting"${
                support === "supporting" ? " selected" : ""
              }>Supporting</option>
              <option value="leaning"${
                support === "leaning" ? " selected" : ""
              }>Leaning</option>
              <option value="opposed"${
                support === "opposed" ? " selected" : ""
              }>Opposed</option>
              <option value="unknown"${
                support === "unknown" ? " selected" : ""
              }>Unknown</option>
            </select>
          </div>
          <div class="form-group">
            <label for="voterFormPledge">Overall pledge</label>
            <select id="voterFormPledge">
              <option value="yes"${
                (v.pledgeStatus || "") === "yes" ? " selected" : ""
              }>Yes</option>
              <option value="no"${
                (v.pledgeStatus || "") === "no" ? " selected" : ""
              }>No</option>
              <option value="undecided"${
                (v.pledgeStatus || "") === "undecided" || !v.pledgeStatus
                  ? " selected"
                  : ""
              }>Undecided</option>
            </select>
          </div>
          <div class="form-group">
            <label for="voterFormPledgedAt">Date pledged</label>
            <input id="voterFormPledgedAt" type="date" value="${escapeHtml(
              pledgedAt.slice(0, 10)
            )}">
          </div>
          <div class="form-group">
            <label for="voterFormVolunteer">Assigned agent</label>
            <input id="voterFormVolunteer" type="text" value="${escapeHtml(
              v.volunteer || ""
            )}" placeholder="Agent name">
          </div>
          <div class="form-group">
            <label for="voterFormMet">Met?</label>
            <select id="voterFormMet">
              <option value="not-met"${
                met !== "met" ? " selected" : ""
              }>No</option>
              <option value="met"${met === "met" ? " selected" : ""}>Yes</option>
            </select>
          </div>
          <div class="form-group">
            <label for="voterFormPersuadable">Persuadable?</label>
            <select id="voterFormPersuadable">
              <option value="unknown"${
                persuadable === "unknown" ? " selected" : ""
              }>Unknown</option>
              <option value="yes"${
                persuadable === "yes" ? " selected" : ""
              }>Yes</option>
              <option value="no"${
                persuadable === "no" ? " selected" : ""
              }>No</option>
            </select>
          </div>
          <div class="form-group form-group--full">
            <label for="voterFormCallComments">Call comments</label>
            <textarea id="voterFormCallComments" rows="2" placeholder="Call comments">${escapeHtml(
              v.callComments || ""
            )}</textarea>
          </div>
          <div class="form-group">
            <label for="voterFormVotedAt">Voted at (ISO)</label>
            <input id="voterFormVotedAt" type="text" value="${escapeHtml(
              votedAt
            )}" placeholder="Leave empty if not voted">
          </div>
        </div>
      </div>
      </div>

      <div class="content-tabs__panel" id="voterEditTab-transport" data-voter-edit-panel="transport" role="tabpanel" hidden>
      <div class="form-section">
        <h3 class="form-section__title">Transportation</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="voterFormTransportNeeded">Transportation needed</label>
            <select id="voterFormTransportNeeded">
              <option value="no"${!transportNeeded ? " selected" : ""}>No</option>
              <option value="yes"${transportNeeded ? " selected" : ""}>Yes</option>
            </select>
          </div>
          <div class="form-group">
            <label for="voterFormTransportType">Trip type</label>
            <select id="voterFormTransportType">
              <option value="oneway"${
                transportType !== "return" ? " selected" : ""
              }>One way</option>
              <option value="return"${
                transportType === "return" ? " selected" : ""
              }>Return</option>
            </select>
          </div>
          <div class="form-group form-group--full">
            <label for="voterFormTransportRoute">Route</label>
            <input id="voterFormTransportRoute" type="text" value="${escapeHtml(
              transportRoute
            )}" placeholder="Route name (e.g. North pickup run 1)">
            <p class="helper-text">Use a route name that matches your Zero Day transport trips.</p>
          </div>
        </div>
      </div>
      </div>

      <div class="content-tabs__panel" id="voterEditTab-notes" data-voter-edit-panel="notes" role="tabpanel" hidden>
      <div class="form-section">
        <h3 class="form-section__title">Notes</h3>
        <div class="form-grid">
          <div class="form-group form-group--full">
            <label for="voterFormNotes">Notes</label>
            <textarea id="voterFormNotes" rows="3" placeholder="Notes">${escapeHtml(
              v.notes || ""
            )}</textarea>
          </div>
        </div>
      </div>
      </div>
    </div>
  `;
}

function openVoterForm(existingVoter) {
  const isEdit = !!existingVoter;
  const body = document.createElement("div");
  body.innerHTML = buildVoterFormFields(existingVoter);

  // Tabs for edit modal sections
  const tabButtons = Array.from(body.querySelectorAll("[data-voter-edit-tab]"));
  const tabPanels = Array.from(body.querySelectorAll("[data-voter-edit-panel]"));
  const setActiveTab = (key) => {
    tabButtons.forEach((btn) => {
      const isActive = btn.getAttribute("data-voter-edit-tab") === key;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    tabPanels.forEach((panel) => {
      panel.hidden = panel.getAttribute("data-voter-edit-panel") !== key;
    });
  };
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-voter-edit-tab");
      if (key) setActiveTab(key);
    });
  });
  setActiveTab("identity");

  const footer = document.createElement("div");
  footer.className = "form-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary-button";
  saveBtn.textContent = isEdit ? "Save changes" : "Add voter";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", () => {
    const name = (body.querySelector("#voterFormName").value || "").trim();
    const nationalId = (body.querySelector("#voterFormNationalId").value || "").trim();
    if (!name && !nationalId) return;
    const sequence = parseInt(body.querySelector("#voterFormSequence").value, 10) || currentVoters.length + 1;
    const ballotBox = (body.querySelector("#voterFormBallotBox").value || "").trim();
    const island = (body.querySelector("#voterFormIsland").value || "").trim();
    const permanentAddress = (body.querySelector("#voterFormAddress").value || "").trim();
    const currentLocation = (body.querySelector("#voterFormCurrentLocation")?.value || "").trim();
    const phone = (body.querySelector("#voterFormPhone").value || "").trim();
    const pledgeStatus = body.querySelector("#voterFormPledge").value || "undecided";
    const supportStatus = (body.querySelector("#voterFormSupport")?.value || "unknown").trim();
    const pledgedAt = (body.querySelector("#voterFormPledgedAt")?.value || "").trim();
    const volunteer = (body.querySelector("#voterFormVolunteer")?.value || "").trim();
    const metStatus = (body.querySelector("#voterFormMet")?.value || "not-met").trim();
    const persuadable = (body.querySelector("#voterFormPersuadable")?.value || "unknown").trim();
    const callComments = (body.querySelector("#voterFormCallComments")?.value || "").trim();
    const photoUrl = (body.querySelector("#voterFormPhotoUrl")?.value || "").trim();
    const dateOfBirth = (body.querySelector("#voterFormDob")?.value || "").trim();
    const ageRaw = (body.querySelector("#voterFormAge")?.value || "").trim();
    const age = ageRaw === "" ? "" : Number(ageRaw);
    const gender = (body.querySelector("#voterFormGender")?.value || "").trim();
    const votedAt = (body.querySelector("#voterFormVotedAt")?.value || "").trim();
    const transportNeeded = (body.querySelector("#voterFormTransportNeeded")?.value || "no") === "yes";
    const transportType = (body.querySelector("#voterFormTransportType")?.value || "oneway").trim();
    const transportRoute = (body.querySelector("#voterFormTransportRoute")?.value || "").trim();
    const notes = (body.querySelector("#voterFormNotes").value || "").trim();

    if (isEdit) {
      existingVoter.fullName = name || existingVoter.fullName;
      existingVoter.nationalId = nationalId || existingVoter.nationalId;
      existingVoter.sequence = sequence;
      existingVoter.ballotBox = ballotBox;
      existingVoter.island = island;
      existingVoter.permanentAddress = permanentAddress;
      existingVoter.currentLocation = currentLocation;
      existingVoter.phone = phone;
      existingVoter.pledgeStatus = pledgeStatus;
      existingVoter.supportStatus = supportStatus || existingVoter.supportStatus || "unknown";
      existingVoter.pledgedAt = pledgedAt;
      existingVoter.volunteer = volunteer;
      existingVoter.metStatus = metStatus;
      existingVoter.persuadable = persuadable;
      existingVoter.callComments = callComments;
      existingVoter.photoUrl = photoUrl;
      existingVoter.dateOfBirth = dateOfBirth;
      existingVoter.age = age;
      existingVoter.gender = gender;
      existingVoter.votedAt = votedAt;
      existingVoter.transportNeeded = transportNeeded;
      existingVoter.transportType = transportType;
      existingVoter.transportRoute = transportRoute;
      existingVoter.notes = notes;
      if (selectedVoterId === existingVoter.id) renderVoterDetails(existingVoter);
    } else {
      const id = nationalId || `V-${Date.now()}`;
      const newVoter = {
        id,
        sequence,
        ballotBox,
        fullName: name,
        permanentAddress,
        dateOfBirth,
        age,
        pledgeStatus,
        gender,
        island,
        currentLocation,
        nationalId: nationalId || id,
        phone,
        notes,
        callComments,
        supportStatus: supportStatus || "unknown",
        interactions: [],
        candidatePledges: {},
        volunteer,
        metStatus,
        persuadable,
        pledgedAt,
        photoUrl,
        votedAt,
        transportNeeded,
        transportType,
        transportRoute,
      };
      currentVoters.push(newVoter);
    }
    const toSave = isEdit ? existingVoter : currentVoters[currentVoters.length - 1];
    (async () => {
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.setVoterFs) await api.setVoterFs(toSave);
      } catch (_) {}
      saveVotersToStorage();
      renderVotersTable();
      if (isEdit && selectedVoterId === existingVoter?.id) renderVoterDetails(existingVoter);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    })();
    closeModal();
    if (window.appNotifications) {
      window.appNotifications.push({
        title: isEdit ? "Voter updated" : "Voter added",
        meta: name || nationalId || (existingVoter && existingVoter.id),
      });
    }
  });

  openModal({
    title: isEdit ? "Edit voter" : "Add voter",
    body,
    footer,
  });
}

function deleteVoter(voterId) {
  const voter = currentVoters.find((v) => v.id === voterId);
  if (!voter) return;
  (async () => {
    const ok = await confirmDialog({
      title: "Delete voter",
      message: `Delete voter "${escapeHtml(
        voter.fullName || voter.nationalId || voterId
      )}"? This cannot be undone.`,
      confirmText: "Delete",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.deleteVoterFs) await api.deleteVoterFs(voterId);
      const idx = currentVoters.findIndex((v) => v.id === voterId);
      if (idx !== -1) currentVoters.splice(idx, 1);
      if (selectedVoterId === voterId) {
        selectedVoterId = null;
        renderVoterDetails(null);
      }
      saveVotersToStorage();
      renderVotersTable();
      document.dispatchEvent(new CustomEvent("voters-updated"));
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Voter deleted", meta: voter.fullName || voter.nationalId || voterId });
      }
    } catch (_) {}
  })();
}

export async function initVotersModule() {
  const votersTableLoader = document.getElementById("votersTableLoader");
  if (votersTableLoader) votersTableLoader.hidden = false;

  bindVoterTableHeaderSort();

  // Refresh Voted column when ballot box link (or Zero Day) marks voters as voted
  document.addEventListener("voted-entries-updated", () => renderVotersTable());

  const addVoterBtn = document.getElementById("addVoterButton");
  if (addVoterBtn) addVoterBtn.addEventListener("click", () => openVoterForm(null));

  function openCreateListModal() {
    const body = document.createElement("div");
    body.className = "form-group";
    const label = document.createElement("label");
    label.setAttribute("for", "createListName");
    label.textContent = "List name";
    const input = document.createElement("input");
    input.id = "createListName";
    input.type = "text";
    input.placeholder = "e.g. Door-knock North";
    input.value = "";
    const p = document.createElement("p");
    p.className = "helper-text";
    p.style.marginTop = "8px";
    p.textContent = "The list will start empty. Add voters by searching and clicking Add to list, or by uploading a file of ID numbers.";
    body.appendChild(label);
    body.appendChild(input);
    body.appendChild(p);
    const footer = document.createElement("div");
    footer.style.display = "flex";
    footer.style.gap = "8px";
    footer.style.justifyContent = "flex-end";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost-button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => closeModal());
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "primary-button";
    createBtn.textContent = "Create and open";
    createBtn.addEventListener("click", async () => {
      const name = (input.value || "").trim() || "Untitled list";
      try {
        const list = await createList(name, []);
        closeModal();
        openListWorkspace(list.id);
        if (window.appNotifications) {
          window.appNotifications.push({ title: "List created", meta: list.name });
        }
      } catch (e) {
        if (window.appNotifications) {
          window.appNotifications.push({ title: "Could not create list", meta: e?.message || String(e) });
        }
      }
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(createBtn);
    openModal({ title: "Create voter list", body, footer });
    setTimeout(() => input.focus(), 100);
  }

  const createListBtn = document.getElementById("createListButton");
  if (createListBtn) createListBtn.addEventListener("click", openCreateListModal);

  const myListsSelect = document.getElementById("myListsSelect");
  if (myListsSelect) {
    const CREATE_NEW_VALUE = "__create__";
    const refreshMyLists = async () => {
      const lists = await getLists();
      const current = myListsSelect.value;
      myListsSelect.innerHTML = "";
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = "My lists…";
      myListsSelect.appendChild(opt0);
      const createOpt = document.createElement("option");
      createOpt.value = CREATE_NEW_VALUE;
      createOpt.textContent = "Create new list…";
      myListsSelect.appendChild(createOpt);
      (lists || []).forEach((list) => {
        const opt = document.createElement("option");
        opt.value = list.id;
        opt.textContent = (list.name || list.id) + " (" + (list.voterIds?.length || 0) + ")";
        myListsSelect.appendChild(opt);
      });
      if (current && current !== CREATE_NEW_VALUE) myListsSelect.value = current;
    };
    refreshMyLists();
    myListsSelect.addEventListener("change", () => {
      const id = myListsSelect.value;
      if (id === CREATE_NEW_VALUE) {
        myListsSelect.value = "";
        openCreateListModal();
      } else if (id) {
        openListWorkspace(id);
        myListsSelect.value = "";
      }
    });
    document.addEventListener("voters-updated", refreshMyLists);
  }

  const votersTable = document.getElementById("votersTable");
  if (votersTable) {
    votersTable.addEventListener("click", (e) => {
      const editBtn = e.target.closest("[data-voter-edit]");
      const deleteBtn = e.target.closest("[data-voter-delete]");
      const unmarkBtn = e.target.closest("[data-voter-unmark]");
      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        const id = editBtn.getAttribute("data-voter-edit");
        const voter = currentVoters.find((v) => v.id === id);
        if (voter) openVoterForm(voter);
      } else if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        const id = deleteBtn.getAttribute("data-voter-delete");
        if (id) deleteVoter(id);
      } else if (unmarkBtn) {
        e.preventDefault();
        e.stopPropagation();
        const id = unmarkBtn.getAttribute("data-voter-unmark");
        if (!id) return;
        const voter = currentVoters.find((v) => v.id === id);
        if (!voter) return;
        (async () => {
          const ok = await confirmDialog({
            title: "Mark not voted",
            message: `Mark "${escapeHtml(
              voter.fullName || voter.nationalId || id
            )}" as not voted? This will clear their voted status across the app.`,
            confirmText: "Mark not voted",
            cancelText: "Cancel",
            danger: true,
          });
          if (!ok) return;
        // Clear local votedAt immediately for responsive UI
        voter.votedAt = "";
          await clearVotedForVoter(id);
          saveVotersToStorage();
          renderVotersTable();
          if (selectedVoterId === id) renderVoterDetails(voter);
          document.dispatchEvent(new CustomEvent("voters-updated"));
        })();
      }
    });
  }

  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.getAllVotersFs && api.onVotersSnapshotFs) {
      const initial = await api.getAllVotersFs();
      if (Array.isArray(initial)) {
        currentVoters = initial;
        saveVotersToStorage();
        mergeVotedAtFromVoters(initial);
      } else {
        loadVotersFromStorage();
      }

      renderVotersTable();
      renderVoterDetails(null);

      unsubscribeVotersFs = api.onVotersSnapshotFs((items) => {
        if (Array.isArray(items)) {
          currentVoters = items;
          mergeVotedAtFromVoters(items);
          renderVotersTable();
          const selected =
            selectedVoterId &&
            currentVoters.find((v) => v.id === selectedVoterId);
          renderVoterDetails(selected || null);
          document.dispatchEvent(new CustomEvent("voters-updated"));
        }
      });
    } else {
      loadVotersFromStorage();
      renderVotersTable();
      renderVoterDetails(null);
    }
  } catch (err) {
    console.error("[Voters] Failed to load from Firebase (using cache if any):", err);
    loadVotersFromStorage();
    renderVotersTable();
    renderVoterDetails(null);
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Could not load voters from Firebase",
        meta: err?.message || String(err),
      });
    }
  }

  if (votersTableLoader) votersTableLoader.hidden = true;

  return {
    getAllVoters: () => [...currentVoters],
  };
}

/** Reload voters from storage and re-render; dispatches voters-updated for pledges etc. */
export function refreshVotersFromStorage() {
  loadVotersFromStorage();
  renderVotersTable();
  const selected = selectedVoterId
    ? currentVoters.find((v) => v.id === selectedVoterId) || null
    : null;
  renderVoterDetails(selected);
  document.dispatchEvent(new CustomEvent("voters-updated"));
}

export function getVoterStats(scope) {
  const totalVoters = currentVoters.length;
  const pledgedCount = currentVoters.filter(
    (v) => v.pledgeStatus === "yes"
  ).length;
  return {
    totalVoters,
    pledgedCount,
  };
}

export function getPledgeByBallotBox() {
  const byBox = new Map();
  currentVoters.forEach((v) => {
    const box = v.ballotBox || "Unassigned";
    if (!byBox.has(box)) {
      byBox.set(box, { total: 0, pledged: 0 });
    }
    const entry = byBox.get(box);
    entry.total += 1;
    if (v.pledgeStatus === "yes") {
      entry.pledged += 1;
    }
  });
  return Array.from(byBox.entries())
    .map(([box, { total, pledged }]) => ({
      label: box,
      value: total === 0 ? 0 : (pledged / total) * 100,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "en"));
}

/** For standalone ballot-box page: load voters from storage and return context (no DOM). */
export function getVotersContextForStandalone() {
  loadVotersFromStorage();
  return { getAllVoters: () => [...currentVoters] };
}

export function updateVoterPledgeStatus(voterId, pledgeStatus) {
  const v = currentVoters.find((x) => x.id === voterId);
  if (!v) return;
  v.pledgeStatus = pledgeStatus;
  v.pledgedAt = pledgeStatus === "yes" ? new Date().toISOString().slice(0, 10) : "";
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) await api.setVoterFs(v);
      saveVotersToStorage();
      renderVotersTable();
      if (selectedVoterId === voterId) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

/** Update pledge for a single candidate; candidateId is the candidate's id (number or string). */
export function updateVoterCandidatePledge(voterId, candidateId, status) {
  const v = currentVoters.find((x) => x.id === voterId);
  if (!v) return;
  if (!v.candidatePledges) v.candidatePledges = {};
  v.candidatePledges[String(candidateId)] = status;
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) await api.setVoterFs(v);
      saveVotersToStorage();
      renderVotersTable();
      if (selectedVoterId === voterId) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

/** Update door-to-door fields (assigned agent, met, persuadable, date pledged, notes). */
export function updateVoterDoorToDoorFields(voterId, fields) {
  const v = currentVoters.find((x) => x.id === voterId);
  if (!v) return;
  if (fields.volunteer !== undefined) v.volunteer = fields.volunteer;
  if (fields.metStatus !== undefined) v.metStatus = fields.metStatus;
  if (fields.persuadable !== undefined) v.persuadable = fields.persuadable;
  if (fields.pledgedAt !== undefined) v.pledgedAt = fields.pledgedAt;
  if (fields.notes !== undefined) v.notes = fields.notes;
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) {
        await api.setVoterFs(v);
      }
      // Always keep local state and UI in sync, regardless of whether Firestore is used.
      saveVotersToStorage();
      renderVotersTable();
      if (selectedVoterId === voterId) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

export function importVotersFromTemplateRows(rows) {
  const hasContent = (r) => {
    const name = String(r["Name"] ?? "").trim();
    const id = String(r["ID Number"] ?? r.id ?? "").trim();
    return name !== "" || id !== "";
  };
  const validRows = rows.filter(hasContent);
  // Generate a stable unique internal ID per import row that does NOT rely on Sequence or ID Number.
  const importRunPrefix = `V-${Date.now()}-`;
  const mapped = validRows.map((r, index) => ({
    id: `${importRunPrefix}${index + 1}`,
    sequence: Number(r["Sequence"]) || index + 1,
    ballotBox: r["Ballot Box"] || "",
    fullName: r["Name"] || "",
    permanentAddress: r["Permanent Address"] || "",
    dateOfBirth: r["Date of Birth"] || "",
    age: r["Age"] ? Number(r["Age"]) : "",
    pledgeStatus: (r["Pledge"] || "").toLowerCase() || "undecided",
    gender: r["Gender"] || "",
    island: r["Island"] || "",
    currentLocation: r["Current Location"] || "",
    nationalId: r["ID Number"] || "",
    phone: r["Phone"] || "",
    notes: r["Call Comments"] || "",
    callComments: r["Call Comments"] || "",
    supportStatus: "unknown",
    interactions: [],
    candidatePledges: {},
    volunteer: "",
    metStatus: "not-met",
    persuadable: "unknown",
    pledgedAt: "",
    photoUrl: (r["Photo"] || r["Image"] || "").trim() || "",
  }));
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) {
        await Promise.all(mapped.map((v) => api.setVoterFs(v)));
      }
      currentVoters = mapped;
      selectedVoterId = null;
      saveVotersToStorage();
      renderVotersTable();
      renderVoterDetails(null);
      document.dispatchEvent(new CustomEvent("voters-updated"));
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Voters imported",
          meta: `${mapped.length.toLocaleString("en-MV")} voters in list`,
        });
      }
    } catch (_) {}
  })();
}


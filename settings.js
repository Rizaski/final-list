import { openModal, closeModal, confirmDialog } from "./ui.js";
import { importVotersFromTemplateRows, getVoterImageSrc } from "./voters.js";
import { firebaseInitPromise } from "./firebase.js";
import {
  AGENTS_STORAGE_KEY,
  filterAgentsForViewer,
  isProperAgentFullName,
  formatAgentNameHint,
  parseViewerFromStorage,
} from "./agents-context.js";

const PAGE_SIZE = 15;
const MAX_VOTER_ROWS = 20000;
const MAX_VOTERS_FILE_BYTES = 15 * 1024 * 1024; // ~15MB safety cap
const CAMPAIGN_STORAGE_KEY = "campaign-config";
const CANDIDATES_STORAGE_KEY = "candidates-data";
const MAX_CANDIDATES = 10;

const sidebarBrandTitle = document.getElementById("sidebarBrandTitle");
const sidebarBrandSubtitle = document.getElementById("sidebarBrandSubtitle");

let campaignConfig = {
  campaignName: "",
  campaignType: "Local Council Election",
  constituency: "",
  island: "",
  /** When false, Pledges is hidden from the sidebar (staff/admin). */
  showPledgesNav: true,
};

function loadCampaignConfig() {
  try {
    const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      campaignConfig = { ...campaignConfig, ...parsed };
    }
  } catch (_) {}
}

function saveCampaignConfig() {
  try {
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(campaignConfig));
  } catch (_) {}
}

async function syncCampaignConfigFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getFirestoreCampaignConfig) return;
    /** Snapshot local preference before remote merge — Firestore must not overwrite a deliberate hide/show. */
    let localSnap = {};
    try {
      const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
      if (raw) localSnap = JSON.parse(raw);
    } catch (_) {}
    const remote = await api.getFirestoreCampaignConfig();
    if (remote && typeof remote === "object") {
      if (remote.campaignName != null) campaignConfig.campaignName = String(remote.campaignName);
      if (remote.campaignType != null) campaignConfig.campaignType = String(remote.campaignType);
      if (remote.constituency != null) campaignConfig.constituency = String(remote.constituency);
      if (remote.island != null) campaignConfig.island = String(remote.island);
      if (localSnap.showPledgesNav !== undefined) {
        campaignConfig.showPledgesNav = Boolean(localSnap.showPledgesNav);
      } else if (remote.showPledgesNav !== undefined) {
        campaignConfig.showPledgesNav = Boolean(remote.showPledgesNav);
      }
      saveCampaignConfig();
      applyCampaignToSidebar();
      document.dispatchEvent(new CustomEvent("campaign-config-changed", { detail: { ...campaignConfig } }));
    }
  } catch (_) {}
}

async function syncCampaignConfigToFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.setFirestoreCampaignConfig) return;
    await api.setFirestoreCampaignConfig({
      campaignName: campaignConfig.campaignName,
      campaignType: campaignConfig.campaignType,
      constituency: campaignConfig.constituency,
      island: campaignConfig.island,
      showPledgesNav: campaignConfig.showPledgesNav !== false,
    });
  } catch (_) {}
}

function applyCampaignToSidebar() {
  if (sidebarBrandTitle) {
    sidebarBrandTitle.textContent = campaignConfig.campaignName.trim()
      ? campaignConfig.campaignName.trim()
      : "Campaign Console";
  }
  if (sidebarBrandSubtitle) {
    sidebarBrandSubtitle.textContent = campaignConfig.island.trim()
      ? campaignConfig.island.trim()
      : "Republic of Maldives";
  }
}

export function getCampaignConfig() {
  return { ...campaignConfig };
}

export { syncCampaignConfigFromFirestore };

const candidatesTableBody = document.querySelector("#candidatesTable tbody");
const addCandidateButton = document.getElementById("addCandidateButton");
const candidatesPaginationEl = document.getElementById("candidatesPagination");

const votersUploadFileInput = document.getElementById("votersUploadFile");
const importVotersButton = document.getElementById("importVotersButton");
const votersUploadFileNameEl = document.getElementById("votersUploadFileName");
const exportVotersCsvButton = document.getElementById("exportVotersCsvButton");
const syncVotersToFirebaseButton = document.getElementById("syncVotersToFirebaseButton");
const deleteAllVotersButton = document.getElementById("deleteAllVotersButton");

const electionTypes = [
  "Local Council Election",
  "Parliamentary Election",
  "Presidential Election",
];

const positionsByElectionType = {
  "Local Council Election": [
    "Council President",
    "Council Member",
    "WDC President",
    "WDC Member",
  ],
  "Parliamentary Election": ["Parliament Member"],
  "Presidential Election": ["President"],
};

// Dynamic candidates list – initially empty until user adds entries.
let candidates = [];
let candidatesCurrentPage = 1;

function loadCandidatesFromStorage() {
  try {
    const raw = localStorage.getItem(CANDIDATES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) candidates = parsed;
    }
  } catch (_) {}
}

function saveCandidatesToStorage() {
  try {
    localStorage.setItem(CANDIDATES_STORAGE_KEY, JSON.stringify(candidates));
  } catch (_) {}
}

/** Returns up to MAX_CANDIDATES candidates for pledge columns and CSV export. */
export function getCandidates() {
  return candidates.slice(0, MAX_CANDIDATES);
}

let agents = [];
let campaignUsers = [];
let unsubscribeAgentsFs = null;

function renderCandidatesTable() {
  candidatesTableBody.innerHTML = "";
  const total = candidates.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (candidatesCurrentPage > totalPages) candidatesCurrentPage = totalPages;
  const start = (candidatesCurrentPage - 1) * PAGE_SIZE;
  const pageCandidates = candidates.slice(start, start + PAGE_SIZE);

  pageCandidates.forEach((c) => {
    const tr = document.createElement("tr");
    tr.dataset.candidateId = String(c.id);
    tr.innerHTML = `
      <td>${c.name}</td>
      <td>${c.candidateNumber ?? ""}</td>
      <td>${c.position ?? ""}</td>
      <td>${c.electionType}</td>
      <td>${c.constituency}</td>
      <td style="text-align:right;">
        <button class="ghost-button ghost-button--small" data-edit-candidate="${c.id}">Edit</button>
      </td>
    `;
    candidatesTableBody.appendChild(tr);
  });

  if (candidatesPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    candidatesPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${candidatesCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${candidatesCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${candidatesCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    candidatesPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && candidatesCurrentPage > 1) candidatesCurrentPage--;
        if (btn.dataset.page === "next" && candidatesCurrentPage < totalPages) candidatesCurrentPage++;
        renderCandidatesTable();
      });
    });
  }

  if (document.getElementById("settingsAgentsFilterCandidate")) {
    ensureAgentsCandidateFilterOptions();
  }
}

function loadAgentsFromStorage() {
  try {
    const raw = localStorage.getItem(AGENTS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      agents = parsed;
      // Expose agents globally so modules like zero-day monitor view can show agent phone numbers.
      try {
        window.agentsCached = [...agents];
      } catch (_) {}
      document.dispatchEvent(
        new CustomEvent("agents-updated", {
          detail: { agents: [...agents] },
        })
      );
    }
  } catch (_) {}
}

export function getAgents() {
  return [...agents];
}

/** Agents visible in dropdowns for the current viewer (respects optional candidate scope). */
export function getAgentsForDropdown() {
  return filterAgentsForViewer(agents);
}

function saveAgentsToStorage() {
  try {
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(agents));
    try {
      window.agentsCached = [...agents];
    } catch (_) {}
  } catch (_) {}
}

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getIslandsFromVotersStorage() {
  try {
    const raw = localStorage.getItem("voters-data");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const islands = new Set();
    parsed.forEach((v) => {
      const name = (v.island || "").trim();
      if (name) islands.add(name);
    });
    return Array.from(islands).sort((a, b) => a.localeCompare(b, "en"));
  } catch (_) {
    return [];
  }
}

function getVotersForAgentModalSearch() {
  try {
    const raw = localStorage.getItem("voters-data");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeAgentNationalId(s) {
  return String(s || "").trim().replace(/\s+/g, "");
}

function normalizeAgentName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeAgentCandidateScope(c) {
  if (c == null || c === "") return "";
  return String(c).trim();
}

/** Returns existing agent row if same name or national ID exists in this scope. */
function getDuplicateAgentInScope({ name, nationalId, candidateId, excludeAgentId }) {
  const nid = normalizeAgentNationalId(nationalId);
  const nameKey = normalizeAgentName(name);
  const scope = normalizeAgentCandidateScope(candidateId);
  return (
    agents.find((a) => {
      if (excludeAgentId != null && String(a.id) === String(excludeAgentId)) return false;
      const sameNid = nid && normalizeAgentNationalId(a.nationalId) === nid;
      const sameName = nameKey && normalizeAgentName(a.name) === nameKey;
      if (!sameNid && !sameName) return false;
      return normalizeAgentCandidateScope(a.candidateId) === scope;
    }) || null
  );
}

function findVoterForAgentPhoto(agent, votersList) {
  if (!agent || !Array.isArray(votersList)) return null;
  const nid = normalizeAgentNationalId(agent.nationalId);
  if (nid) {
    const byNid = votersList.find(
      (v) =>
        normalizeAgentNationalId(v.nationalId) === nid || String(v.id || "").trim() === nid
    );
    if (byNid) return byNid;
  }
  const name = (agent.name || "").trim().toLowerCase();
  if (!name) return null;
  return votersList.find((v) => (v.fullName || "").trim().toLowerCase() === name) || null;
}

function buildAgentTablePhotoCell(agent, voter) {
  const initials = (agent.name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "?";
  const photoSrc = voter ? getVoterImageSrc(voter) : "";
  const imgOnError =
    "var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';";
  if (photoSrc) {
    return `<div class="avatar-cell avatar-cell--settings-agent"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="${imgOnError}"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`;
  }
  return `<div class="avatar-cell avatar-cell--settings-agent"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
}

function candidateLabelById(id) {
  if (!id) return "All campaigns";
  const c = getCandidates().find((x) => String(x.id) === String(id));
  return c ? c.name : `Candidate #${id}`;
}

const SETTINGS_AGENTS_TABLE_COL_COUNT = 8;

function ensureAgentsCandidateFilterOptions() {
  const sel = document.getElementById("settingsAgentsFilterCandidate");
  if (!sel) return;
  const preserved = sel.value;
  const candList = getCandidates();
  sel.innerHTML = `
    <option value="all">All scopes</option>
    <option value="unscoped">All campaigns (unscoped)</option>
    ${candList
      .map(
        (c) =>
          `<option value="${escapeHtml(String(c.id))}">${escapeHtml(c.name || String(c.id))}</option>`
      )
      .join("")}
  `;
  if ([...sel.options].some((o) => o.value === preserved)) sel.value = preserved;
  else sel.value = "all";
}

function getAgentCandidateScopeId(agent) {
  const raw = agent && agent.candidateId;
  if (raw == null || raw === "") return "";
  return String(raw).trim();
}

function getFilteredSortedGroupedAgents() {
  const list = Array.isArray(agents) ? [...agents] : [];
  const searchEl = document.getElementById("settingsAgentsSearch");
  const filterEl = document.getElementById("settingsAgentsFilterCandidate");
  const sortEl = document.getElementById("settingsAgentsSort");
  const groupEl = document.getElementById("settingsAgentsGroupBy");
  const query = (searchEl?.value || "").toLowerCase().trim();
  const filterScope = (filterEl?.value || "all").trim();
  const sortBy = sortEl?.value || "id";
  const groupBy = groupEl?.value || "none";

  const filtered = list.filter((a) => {
    const cid = getAgentCandidateScopeId(a);
    if (filterScope === "all") {
      /* keep */
    } else if (filterScope === "unscoped") {
      if (cid) return false;
    } else if (cid !== filterScope) {
      return false;
    }
    if (!query) return true;
    const aid = String(a.id ?? "");
    const name = (a.name || "").toLowerCase();
    const nid = (a.nationalId || "").toLowerCase();
    const phone = (a.phone || "").toLowerCase();
    const island = (a.island || "").toLowerCase();
    const candLabel = candidateLabelById(cid).toLowerCase();
    return (
      aid.includes(query) ||
      name.includes(query) ||
      nid.includes(query) ||
      phone.includes(query) ||
      island.includes(query) ||
      candLabel.includes(query)
    );
  });

  const cmp = (a, b) => {
    const candA = candidateLabelById(getAgentCandidateScopeId(a));
    const candB = candidateLabelById(getAgentCandidateScopeId(b));
    switch (sortBy) {
      case "name-desc":
        return (b.name || "").localeCompare(a.name || "", "en");
      case "nationalId":
        return (a.nationalId || "").localeCompare(b.nationalId || "", "en");
      case "phone":
        return (a.phone || "").localeCompare(b.phone || "", "en");
      case "island":
        return (a.island || "").localeCompare(b.island || "", "en");
      case "candidate":
        return candA.localeCompare(candB, "en");
      case "name-asc":
        return (a.name || "").localeCompare(b.name || "", "en");
      case "id":
      default:
        return (Number(a.id) || 0) - (Number(b.id) || 0);
    }
  };
  filtered.sort(cmp);

  if (groupBy === "none") {
    return filtered.map((agent) => ({ type: "row", agent }));
  }

  const getGroupKey = (v) => {
    if (groupBy === "island") return (v.island || "").trim() || "—";
    if (groupBy === "candidate") return candidateLabelById(getAgentCandidateScopeId(v));
    return "";
  };

  const displayList = [];
  let lastKey = null;
  filtered.forEach((agent) => {
    const key = getGroupKey(agent);
    if (key !== lastKey) {
      displayList.push({ type: "group", label: key });
      lastKey = key;
    }
    displayList.push({ type: "row", agent });
  });
  return displayList;
}

function updateAgentsSortIndicators() {
  const headers = document.querySelectorAll("#settingsAgentsTable thead th.th-sortable");
  if (!headers.length) return;
  const sortEl = document.getElementById("settingsAgentsSort");
  const sortBy = sortEl?.value || "id";
  headers.forEach((th) => {
    const key = th.getAttribute("data-sort-key");
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    th.removeAttribute("aria-sort");
    if (key === "name" && (sortBy === "name-asc" || sortBy === "name-desc")) {
      th.classList.add(sortBy === "name-asc" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "name-asc" ? "ascending" : "descending");
    } else if (key === "agent-id" && sortBy === "id") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key && key !== "name" && key !== "agent-id" && sortBy === key) {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    }
  });
}

function bindAgentsTableHeaderSort() {
  const thead = document.querySelector("#settingsAgentsTable thead");
  if (!thead || thead.dataset.agentsSortBound === "1") return;
  thead.dataset.agentsSortBound = "1";
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.th-sortable");
    if (!th) return;
    const key = th.getAttribute("data-sort-key");
    const sortEl = document.getElementById("settingsAgentsSort");
    if (!key || !sortEl) return;
    if (key === "name") {
      sortEl.value = sortEl.value === "name-asc" ? "name-desc" : "name-asc";
    } else {
      const map = {
        "agent-id": "id",
        nationalId: "nationalId",
        phone: "phone",
        island: "island",
        candidate: "candidate",
      };
      sortEl.value = map[key] ?? sortEl.value;
    }
    renderAgentsTable();
  });
}

function initAgentsToolbarListeners() {
  const searchEl = document.getElementById("settingsAgentsSearch");
  const filterEl = document.getElementById("settingsAgentsFilterCandidate");
  const sortEl = document.getElementById("settingsAgentsSort");
  const groupEl = document.getElementById("settingsAgentsGroupBy");
  const re = () => renderAgentsTable();
  if (searchEl && !searchEl.dataset.agentsToolbarBound) {
    searchEl.dataset.agentsToolbarBound = "1";
    searchEl.addEventListener("input", re);
  }
  if (filterEl && !filterEl.dataset.agentsToolbarBound) {
    filterEl.dataset.agentsToolbarBound = "1";
    filterEl.addEventListener("change", re);
  }
  if (sortEl && !sortEl.dataset.agentsToolbarBound) {
    sortEl.dataset.agentsToolbarBound = "1";
    sortEl.addEventListener("change", re);
  }
  if (groupEl && !groupEl.dataset.agentsToolbarBound) {
    groupEl.dataset.agentsToolbarBound = "1";
    groupEl.addEventListener("change", re);
  }
  bindAgentsTableHeaderSort();
}

/**
 * @param {object | null} existing
 * @param {{ lockCandidateId?: string | null }} [options]
 */
export function openAgentModal(existing = null, options = {}) {
  const opts = options || {};
  const lockCandidateId =
    opts.lockCandidateId != null && String(opts.lockCandidateId).trim() !== ""
      ? String(opts.lockCandidateId).trim()
      : null;
  const viewer = parseViewerFromStorage();
  const effectiveLockCandidate =
    lockCandidateId || (viewer.role === "candidate" && viewer.candidateId ? viewer.candidateId : null);
  const isEdit = !!(existing && existing.id != null);
  const votersList = getVotersForAgentModalSearch();
  const islands = getIslandsFromVotersStorage();
  const candList = getCandidates();

  const body = document.createElement("div");
  body.className = "form-grid";

  const candidateFieldHtml = effectiveLockCandidate
    ? `
      <div class="form-group" style="grid-column: 1 / -1;">
        <label>Candidate scope</label>
        <div class="detail-item-value">${escapeHtml(candidateLabelById(effectiveLockCandidate))}</div>
        <input type="hidden" id="agentModalCandidateId" value="${escapeHtml(effectiveLockCandidate)}">
      </div>`
    : viewer.isAdmin
      ? `
      <div class="form-group" style="grid-column: 1 / -1;">
        <label for="agentModalCandidateId">Candidate scope (optional)</label>
        <select id="agentModalCandidateId" class="input agent-dropdown-select agent-dropdown-select--modal">
          <option value="">All campaigns (visible to staff &amp; all candidates)</option>
          ${candList
            .map(
              (c) =>
                `<option value="${escapeHtml(String(c.id))}"${
                  String(existing?.candidateId || "") === String(c.id) ? " selected" : ""
                }>${escapeHtml(c.name || String(c.id))}</option>`
            )
            .join("")}
        </select>
        <span class="helper-text">When set, this agent appears only for that candidate and for administrators.</span>
      </div>`
      : `<input type="hidden" id="agentModalCandidateId" value="">`;

  body.innerHTML = `
    <div class="form-group agent-modal-voter-search-group" style="grid-column: 1 / -1;">
      <label for="agentModalVoterSearch">Search voter</label>
      <div class="agent-modal-voter-search-wrap">
        <div class="event-participant-picker" id="agentModalVoterPicker">
          <input type="text" id="agentModalVoterSearch" class="input agent-modal-voter-search-input event-participant-picker__input" placeholder="Name, national ID, phone, address, or pick a match…" autocomplete="off" spellcheck="false">
          <div id="agentModalVoterSearchMenu" class="event-participant-picker__menu" role="listbox" aria-label="Voter search results"></div>
        </div>
      </div>
      <p class="helper-text agent-modal-voter-search-hint">Match on name, national ID, permanent address, or ID-based photo filename (e.g. <span class="agent-modal-voter-search-hint__kbd">photos/…</span>). When exactly one voter matches, their details appear below.</p>
      <div id="agentModalVoterPreview" class="agent-modal-voter-preview" hidden aria-live="polite"></div>
    </div>
    <div class="form-group">
      <label for="agentModalName">Full name <span class="text-muted">(required)</span></label>
      <input type="text" id="agentModalName" class="input" placeholder="First Last" value="${escapeHtml(existing?.name || "")}">
    </div>
    <div class="form-group">
      <label for="agentModalNationalId">National ID</label>
      <input type="text" id="agentModalNationalId" class="input" value="${escapeHtml(existing?.nationalId || "")}">
    </div>
    <div class="form-group">
      <label for="agentModalPhone">Phone</label>
      <input type="tel" id="agentModalPhone" class="input" value="${escapeHtml(existing?.phone || "")}">
    </div>
    <div class="form-group">
      <label for="agentModalIsland">Island</label>
      <select id="agentModalIsland" class="input agent-dropdown-select agent-dropdown-select--modal"></select>
    </div>
    ${candidateFieldHtml}
    <p class="helper-text" style="grid-column: 1 / -1;">${escapeHtml(formatAgentNameHint())}</p>
  `;

  const islandSelect = body.querySelector("#agentModalIsland");
  const curIsland = (existing?.island || "").trim();
  if (islandSelect) {
    islandSelect.innerHTML =
      '<option value="">Select island…</option>' +
      islands
        .map(
          (name) =>
            `<option value="${escapeHtml(name)}"${name === curIsland ? " selected" : ""}>${escapeHtml(name)}</option>`
        )
        .join("");
    if (curIsland && !islands.includes(curIsland)) {
      const opt = document.createElement("option");
      opt.value = curIsland;
      opt.textContent = `${curIsland} (from record)`;
      opt.selected = true;
      islandSelect.appendChild(opt);
    }
  }

  const searchInput = body.querySelector("#agentModalVoterSearch");
  const searchMenu = body.querySelector("#agentModalVoterSearchMenu");

  function voterInitials(voter) {
    const n = (voter && voter.fullName) || "";
    return (
      n
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() || "")
        .join("") || "?"
    );
  }

  function updateAgentModalVoterPreview(voter) {
    const wrap = body.querySelector("#agentModalVoterPreview");
    if (!wrap) return;
    if (!voter) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      return;
    }
    const photoSrc = getVoterImageSrc(voter);
    const fullName = (voter.fullName || "").trim() || "—";
    const nid = (voter.nationalId || "").trim() || String(voter.id || "").trim() || "—";
    const addr = (voter.permanentAddress || "").trim() || "—";
    const initials = voterInitials(voter);
    const imgOnError =
      "var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';";
    const photoBlock = photoSrc
      ? `<div class="agent-modal-voter-preview__photo-wrap" aria-hidden="true">
           <img class="avatar-img agent-modal-voter-photo" width="60" height="60" decoding="async" loading="eager" src="${escapeHtml(photoSrc)}" alt="" onerror="${imgOnError}">
           <div class="avatar-circle avatar-circle--fallback agent-modal-voter-photo-fallback" style="display:none">${escapeHtml(initials)}</div>
         </div>`
      : `<div class="agent-modal-voter-preview__photo-wrap agent-modal-voter-preview__photo-wrap--empty" aria-hidden="true">
           <div class="avatar-circle agent-modal-voter-photo-fallback">${escapeHtml(initials)}</div>
         </div>`;
    wrap.innerHTML = `
      <p class="agent-modal-voter-preview__title">Matched voter</p>
      <div class="agent-modal-voter-preview__inner">
        ${photoBlock}
        <div class="agent-modal-voter-preview__details">
          <div class="details-grid details-grid--two-column agent-modal-voter-preview__grid">
            <div class="agent-modal-voter-preview__span2">
              <div class="detail-item-label">Full name</div>
              <div class="detail-item-value">${escapeHtml(fullName)}</div>
            </div>
            <div>
              <div class="detail-item-label">National ID</div>
              <div class="detail-item-value">${escapeHtml(nid)}</div>
            </div>
            <div class="agent-modal-voter-preview__span2">
              <div class="detail-item-label">Permanent address</div>
              <div class="detail-item-value">${escapeHtml(addr)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
    wrap.hidden = false;
  }

  function voterMatchesAgentSearchQuery(voter, rawQuery) {
    const q = (rawQuery || "").trim().toLowerCase();
    if (!q || !voter) return false;
    const name = (voter.fullName || "").toLowerCase();
    const nid = String(voter.nationalId || "").trim().toLowerCase();
    const id = String(voter.id != null ? voter.id : "").trim().toLowerCase();
    const addr = (voter.permanentAddress || "").toLowerCase();
    const phone = (voter.phone || "").toLowerCase();
    const img = (getVoterImageSrc(voter) || "").toLowerCase();
    const photoUrl = (voter.photoUrl || "").toLowerCase();
    return (
      name.includes(q) ||
      nid.includes(q) ||
      id.includes(q) ||
      addr.includes(q) ||
      phone.includes(q) ||
      img.includes(q) ||
      (photoUrl && photoUrl.includes(q))
    );
  }

  function findVoterFromSearchValue(val) {
    const raw = (val || "").trim();
    if (!raw) return null;
    const pipeParts = raw.split("|").map((s) => s.trim()).filter(Boolean);
    // Canonical datalist value: "Full name | national ID" (ID is always second segment)
    if (pipeParts.length >= 2) {
      const nidFromList = pipeParts[1];
      const found = votersList.find(
        (x) =>
          String(x.nationalId || "").trim() === nidFromList ||
          String(x.id || "").trim() === nidFromList
      );
      if (found) return found;
    }
    const byNid = votersList.find(
      (x) =>
        String(x.nationalId || "").trim() === raw ||
        String(x.id || "").trim() === raw
    );
    if (byNid) return byNid;
    const lower = raw.toLowerCase();
    const exactName = votersList.find(
      (x) => (x.fullName || "").trim().toLowerCase() === lower
    );
    if (exactName) return exactName;
    const matches = votersList.filter((x) => voterMatchesAgentSearchQuery(x, raw));
    return matches.length === 1 ? matches[0] : null;
  }

  function applyVoterMatch(voter) {
    if (!voter) return;
    const nameEl = body.querySelector("#agentModalName");
    const nidEl = body.querySelector("#agentModalNationalId");
    const phoneEl = body.querySelector("#agentModalPhone");
    if (nameEl) nameEl.value = (voter.fullName || "").trim();
    if (nidEl) nidEl.value = (voter.nationalId || "").trim();
    if (phoneEl) phoneEl.value = (voter.phone || "").trim();
    const isl = (voter.island || "").trim();
    if (islandSelect && isl) {
      if (![...islandSelect.options].some((o) => o.value === isl)) {
        const opt = document.createElement("option");
        opt.value = isl;
        opt.textContent = isl;
        islandSelect.appendChild(opt);
      }
      islandSelect.value = isl;
    }
    updateAgentModalVoterPreview(voter);
  }

  function clearAgentModalVoterPreviewOnly() {
    updateAgentModalVoterPreview(null);
  }

  function tryMatchVoterSearch() {
    const val = (searchInput?.value || "").trim();
    if (!val) {
      clearAgentModalVoterPreviewOnly();
      return;
    }
    const voter = findVoterFromSearchValue(val);
    if (voter) applyVoterMatch(voter);
    else clearAgentModalVoterPreviewOnly();
  }

  function renderAgentVoterSearchMenu() {
    if (!searchInput || !searchMenu) return;
    const q = (searchInput.value || "").trim().toLowerCase();
    const list = votersList
      .filter((v) => {
        if (!q) return true;
        return voterMatchesAgentSearchQuery(v, q);
      })
      .slice(0, 25);
    if (!list.length) {
      searchMenu.innerHTML = '<div class="voter-agent-dropdown__empty">No matching voters.</div>';
      searchMenu.style.display = "block";
      return;
    }
    searchMenu.innerHTML = list
      .map((v) => {
        const name = (v.fullName || "").trim();
        const nid = String(v.nationalId || v.id || "").trim();
        const phone = String(v.phone || "—").trim() || "—";
        const addr = String(v.permanentAddress || "—").trim() || "—";
        const photoSrc = getVoterImageSrc(v);
        const initials = voterInitials(v);
        const imgOnError =
          "var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';";
        const photoHtml = photoSrc
          ? `<div class="avatar-cell avatar-cell--settings-agent"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="${imgOnError}"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
          : `<div class="avatar-cell avatar-cell--settings-agent"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
        return `<button type="button" class="voter-agent-dropdown__item" data-voter-id="${escapeHtml(String(v.id || ""))}">
          ${photoHtml}
          <span class="voter-agent-dropdown__main">${escapeHtml(name)}</span>
          <span class="voter-agent-dropdown__meta">ID: ${escapeHtml(nid)} | ${escapeHtml(phone)} | ${escapeHtml(addr)}</span>
        </button>`;
      })
      .join("");
    searchMenu.style.display = "block";
  }

  let searchDebounceId = null;
  searchInput?.addEventListener("input", () => {
    window.clearTimeout(searchDebounceId);
    renderAgentVoterSearchMenu();
    searchDebounceId = window.setTimeout(() => tryMatchVoterSearch(), 280);
  });
  searchInput?.addEventListener("focus", renderAgentVoterSearchMenu);
  searchInput?.addEventListener("change", tryMatchVoterSearch);
  searchInput?.addEventListener("blur", tryMatchVoterSearch);
  searchMenu?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-voter-id]");
    if (!btn || !searchInput) return;
    const voterId = String(btn.getAttribute("data-voter-id") || "");
    const voter = votersList.find((v) => String(v.id) === voterId);
    if (!voter) return;
    searchInput.value = `${(voter.fullName || "").trim()} | ${(voter.nationalId || voter.id || "").trim()}`;
    applyVoterMatch(voter);
    searchMenu.style.display = "none";
  });
  body.querySelector("#agentModalVoterPicker")?.addEventListener("focusout", () => {
    window.setTimeout(() => {
      const root = body.querySelector("#agentModalVoterPicker");
      const active = document.activeElement;
      if (root && !root.contains(active) && searchMenu) {
        searchMenu.style.display = "none";
      }
    }, 0);
  });

  if (isEdit && existing && (existing.nationalId || existing.name)) {
    const nidKey = String(existing.nationalId || "").trim();
    const byNid = nidKey
      ? votersList.find((x) => String(x.nationalId || "").trim() === nidKey)
      : null;
    const byName =
      !byNid && existing.name
        ? votersList.find(
            (x) =>
              (x.fullName || "").trim().toLowerCase() === String(existing.name).trim().toLowerCase()
          )
        : null;
    const v0 = byNid || byName;
    if (v0 && searchInput) {
      searchInput.value = `${(v0.fullName || "").trim()} | ${(v0.nationalId || v0.id || "").trim()}`;
      updateAgentModalVoterPreview(v0);
    }
  }

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => closeModal());
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary-button";
  saveBtn.textContent = isEdit ? "Update agent" : "Create agent";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", () => {
    const name = (body.querySelector("#agentModalName")?.value || "").trim();
    const nationalId = (body.querySelector("#agentModalNationalId")?.value || "").trim();
    const phone = (body.querySelector("#agentModalPhone")?.value || "").trim();
    const island = (body.querySelector("#agentModalIsland")?.value || "").trim();
    const candEl = body.querySelector("#agentModalCandidateId");
    let candidateId = "";
    if (candEl) {
      if (candEl.tagName === "SELECT") candidateId = (candEl.value || "").trim();
      else candidateId = (candEl.value || "").trim();
    }

    if (!isProperAgentFullName(name)) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Invalid name",
          meta: formatAgentNameHint(),
        });
      }
      return;
    }
    if (!nationalId || !phone) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Missing fields",
          meta: "National ID and phone are required.",
        });
      }
      return;
    }

    const scopeForDup = (candidateId || "").trim();
    const existingDup = getDuplicateAgentInScope({
      name,
      nationalId,
      candidateId: scopeForDup || null,
      excludeAgentId: isEdit && existing?.id != null ? existing.id : null,
    });
    if (existingDup) {
      const scopeLabel = scopeForDup
        ? candidateLabelById(scopeForDup)
        : "All campaigns (unscoped)";
      const existingLabel = (existingDup.name || "").trim() || "this agent";
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Agent already exists",
          meta: `An agent with the same name or national ID is already registered for ${scopeLabel}. Existing: ${existingLabel} (agent ID ${existingDup.id}). Remove or edit that record instead of adding again.`,
        });
      }
      return;
    }

    (async () => {
      try {
        const api = await firebaseInitPromise;
        let savedToFirestore = false;
        const nextId =
          agents.length && agents.every((a) => a.id != null)
            ? agents.reduce((max, a) => Math.max(max, Number(a.id) || 0), 0) + 1
            : 1;
        const idStr = isEdit ? String(existing.id) : String(nextId);
        const agent = {
          id: idStr,
          name,
          nationalId,
          phone,
          island,
        };
        if (candidateId) agent.candidateId = candidateId;
        else agent.candidateId = null;

        if (api.ready && api.setAgentFs) {
          await api.setAgentFs(agent);
          savedToFirestore = true;
        }
        // Always reflect successful create/update in local UI immediately.
        if (isEdit) {
          const ix = agents.findIndex((a) => String(a.id) === idStr);
          if (ix >= 0) agents[ix] = agent;
          else agents.push(agent);
        } else {
          agents.push(agent);
        }
        saveAgentsToStorage();
        renderAgentsTable();
        try {
          window.agentsCached = [...agents];
        } catch (_) {}
        document.dispatchEvent(new CustomEvent("agents-updated", { detail: { agents: [...agents] } }));
        closeModal();
        if (window.appNotifications) {
          window.appNotifications.push({
            title: savedToFirestore
              ? isEdit
                ? "Agent updated"
                : "Agent created"
              : isEdit
                ? "Agent updated (local only)"
                : "Agent created (local only)",
            meta: savedToFirestore
              ? name
              : `${name} — Firebase sync unavailable. Check connection/permissions.`,
          });
        }
      } catch (err) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not save agent",
            meta: err?.message || String(err),
          });
        }
      }
    })();
  });

  openModal({
    title: isEdit ? "Update agent" : "Create agent",
    body,
    footer,
  });
}

/** Read-only details (R in CRUD). */
function openAgentViewModal(agent) {
  if (!agent || agent.id == null) return;
  const cid =
    agent.candidateId != null && String(agent.candidateId).trim() !== ""
      ? String(agent.candidateId).trim()
      : "";
  const scopeLabel = cid ? candidateLabelById(cid) : "All campaigns (visible to staff & all candidates)";

  const body = document.createElement("div");
  body.className = "form-grid agent-view-readonly";
  body.innerHTML = `
    <div class="form-group">
      <div class="detail-item-label">Agent ID</div>
      <div class="detail-item-value">${escapeHtml(String(agent.id))}</div>
    </div>
    <div class="form-group">
      <div class="detail-item-label">Full name</div>
      <div class="detail-item-value">${escapeHtml(agent.name || "—")}</div>
    </div>
    <div class="form-group">
      <div class="detail-item-label">National ID</div>
      <div class="detail-item-value">${escapeHtml(agent.nationalId || "—")}</div>
    </div>
    <div class="form-group">
      <div class="detail-item-label">Phone</div>
      <div class="detail-item-value">${escapeHtml(agent.phone || "—")}</div>
    </div>
    <div class="form-group">
      <div class="detail-item-label">Island</div>
      <div class="detail-item-value">${escapeHtml(agent.island || "—")}</div>
    </div>
    <div class="form-group" style="grid-column: 1 / -1;">
      <div class="detail-item-label">Candidate scope</div>
      <div class="detail-item-value">${escapeHtml(scopeLabel)}</div>
    </div>
  `;

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.flexWrap = "wrap";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost-button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closeModal());

  const viewer = parseViewerFromStorage();
  footer.appendChild(closeBtn);
  if (viewer.isAdmin) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "primary-button";
    editBtn.textContent = "Update agent";
    editBtn.addEventListener("click", () => {
      closeModal();
      openAgentModal(agent, {});
    });
    footer.appendChild(editBtn);
  }

  openModal({ title: "View agent", body, footer });
}

/** Read-only assigned voters list for an agent (global + per-candidate assignments). */
async function openAgentAssignedVotersModal(agent) {
  if (!agent || agent.id == null) return;
  const targetNameRaw = String(agent.name || "").trim();
  const normalizeName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const targetName = normalizeName(targetNameRaw);
  const targetAgentId = String(agent.id);
  const agentsByNormName = new Map(
    getAgents().map((a) => [normalizeName(a?.name), String(a?.id ?? "")])
  );
  const matchesAgent = ({ assignedName, assignedId }) => {
    const id = String(assignedId || "").trim();
    if (id && id === targetAgentId) return true;
    const nameNorm = normalizeName(assignedName);
    if (!nameNorm) return false;
    if (nameNorm === targetName) return true;
    const mappedId = agentsByNormName.get(nameNorm) || "";
    return mappedId && mappedId === targetAgentId;
  };
  const localVoters = getVotersForAgentModalSearch();
  const byId = new Map();
  localVoters.forEach((v) => {
    if (v && v.id != null) byId.set(String(v.id), v);
  });
  try {
    const api = await firebaseInitPromise;
    if (api && api.ready && typeof api.getAllVotersFs === "function") {
      const remoteVoters = await api.getAllVotersFs();
      if (Array.isArray(remoteVoters)) {
        remoteVoters.forEach((v) => {
          if (!v || v.id == null) return;
          const key = String(v.id);
          // Prefer remote doc fields, but keep any local-only fields if present.
          byId.set(key, { ...(byId.get(key) || {}), ...v });
        });
      }
    }
  } catch (_) {}
  const allVoters = Array.from(byId.values());
  const byIdLookup = new Map(allVoters.map((v) => [String(v.id), v]));
  const assignedMetaByVoterId = new Map(); // voterId -> { global: bool, candidateIds:Set<string> }

  function ensureMeta(voterId) {
    const key = String(voterId);
    if (!assignedMetaByVoterId.has(key)) {
      assignedMetaByVoterId.set(key, { global: false, candidateIds: new Set() });
    }
    return assignedMetaByVoterId.get(key);
  }

  // 1) Global assignment from voter.volunteer (Door to Door / Pledges global field)
  allVoters.forEach((v) => {
    const volunteerRaw = v && v.volunteer != null ? v.volunteer : "";
    const volunteerName = volunteerRaw && typeof volunteerRaw === "object" ? volunteerRaw.name : volunteerRaw;
    const volunteerId = volunteerRaw && typeof volunteerRaw === "object" ? volunteerRaw.id : "";
    if (matchesAgent({ assignedName: volunteerName, assignedId: volunteerId })) {
      ensureMeta(v.id).global = true;
    }
  });

  // 2) Candidate-scoped assignment maps used in candidate/report views
  const candidateNameById = new Map(
    getCandidates().map((c) => [String(c.id), String(c.name || c.id || "").trim()])
  );

  // 2a) Candidate-scoped assignments persisted on voter documents (shared across logins/devices).
  allVoters.forEach((v) => {
    if (!v || !v.id) return;
    const byIdObj = v.candidateAgentAssignmentIds;
    if (byIdObj && typeof byIdObj === "object") {
      Object.entries(byIdObj).forEach(([candidateId, assignedAgentId]) => {
        if (!matchesAgent({ assignedName: "", assignedId: assignedAgentId })) return;
        ensureMeta(v.id).candidateIds.add(String(candidateId));
      });
    }
    const obj = v.candidateAgentAssignments;
    if (!obj || typeof obj !== "object") return;
    Object.entries(obj).forEach(([candidateId, assignedAgentName]) => {
      const raw = assignedAgentName;
      const name = raw && typeof raw === "object" ? raw.name : raw;
      const id = raw && typeof raw === "object" ? raw.id : "";
      if (!matchesAgent({ assignedName: name, assignedId: id })) return;
      ensureMeta(v.id).candidateIds.add(String(candidateId));
    });
  });

  // 2b) Legacy per-browser candidate-scoped maps (keep for backward compatibility).
  const CAND_ASSIGN_PREFIX = "candidatePledgedAgentAssignments:v2:";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) || "";
    if (!key.startsWith(CAND_ASSIGN_PREFIX)) continue;
    const candidateId = key.slice(CAND_ASSIGN_PREFIX.length);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const map = JSON.parse(raw);
      if (!map || typeof map !== "object") continue;
      Object.entries(map).forEach(([voterId, assignedVal]) => {
        const assignedName = assignedVal && typeof assignedVal === "object" ? assignedVal.name : assignedVal;
        const assignedId = assignedVal && typeof assignedVal === "object" ? assignedVal.id || "" : "";
        if (matchesAgent({ assignedName, assignedId })) {
          ensureMeta(voterId).candidateIds.add(String(candidateId));
        }
      });
    } catch (_) {}
  }

  const assigned = Array.from(assignedMetaByVoterId.entries())
    .map(([voterId, meta]) => {
      const v = byIdLookup.get(String(voterId));
      if (!v) return null;
      const candidateScopes = Array.from(meta.candidateIds)
        .map((cid) => candidateNameById.get(cid) || `Candidate ${cid}`)
        .filter(Boolean)
        .join(", ");
      return {
        voter: v,
        assignmentScope:
          meta.global && candidateScopes
            ? `Global + ${candidateScopes}`
            : meta.global
              ? "Global"
              : candidateScopes || "Candidate scope",
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const sa = Number(a.voter && a.voter.sequence != null ? a.voter.sequence : NaN);
      const sb = Number(b.voter && b.voter.sequence != null ? b.voter.sequence : NaN);
      const aHas = Number.isFinite(sa);
      const bHas = Number.isFinite(sb);
      if (aHas && bHas) return sa - sb;
      if (aHas) return -1;
      if (bHas) return 1;
      return String(a.voter?.fullName || "").localeCompare(String(b.voter?.fullName || ""), "en");
    });

  const body = document.createElement("div");
  body.className = "modal-body-inner";
  function reportBallotBoxLabel(v) {
    const box = String(v && v.ballotBox != null ? v.ballotBox : "").trim();
    const loc = String(v && v.currentLocation != null ? v.currentLocation : "").trim();
    if (box.toLowerCase() === "others" && loc) return `Others - ${loc}`;
    return box || "—";
  }
  const toolbar = document.createElement("div");
  toolbar.className = "modal-list-toolbar list-toolbar";
  const boxes = [...new Set(assigned.map((x) => reportBallotBoxLabel(x.voter)).filter(Boolean))].sort();
  toolbar.innerHTML = `
    <div class="list-toolbar__search">
      <label for="agentAssignedSearch" class="sr-only">Search</label>
      <input type="search" id="agentAssignedSearch" placeholder="Search by name, ID, address, phone, notes…" aria-label="Search assigned voters">
    </div>
    <div class="list-toolbar__controls">
      <div class="field-group field-group--inline">
        <label for="agentAssignedFilterPledge">Filter</label>
        <select id="agentAssignedFilterPledge">
          <option value="all">All</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
          <option value="undecided">Undecided</option>
        </select>
      </div>
      <div class="field-group field-group--inline">
        <label for="agentAssignedFilterBox">Ballot box</label>
        <select id="agentAssignedFilterBox">
          <option value="all">All</option>
          ${boxes.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("")}
        </select>
      </div>
      <div class="field-group field-group--inline">
        <label for="agentAssignedSort">Sort</label>
        <select id="agentAssignedSort">
          <option value="sequence">Seq</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
          <option value="id">ID Number</option>
          <option value="box">Ballot box</option>
          <option value="pledge">Pledge</option>
          <option value="voted">Voted at</option>
        </select>
      </div>
    </div>
  `;
  body.appendChild(toolbar);

  const summary = document.createElement("p");
  summary.className = "helper-text";
  summary.style.margin = "0 0 8px";
  summary.textContent = `Agent: ${agent.name || "—"} • Assigned voters: ${assigned.length}`;
  body.appendChild(summary);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrapper";
  body.appendChild(tableWrap);
  let lastRenderedRows = [];

  function sortRows(list, sortBy) {
    const rows = [...list];
    rows.sort((a, b) => {
      const va = a.voter || {};
      const vb = b.voter || {};
      switch (sortBy) {
        case "name-desc":
          return String(vb.fullName || "").localeCompare(String(va.fullName || ""), "en");
        case "name-asc":
          return String(va.fullName || "").localeCompare(String(vb.fullName || ""), "en");
        case "id":
          return String(va.nationalId || va.id || "").localeCompare(String(vb.nationalId || vb.id || ""), "en");
        case "box":
          return String(va.ballotBox || "").localeCompare(String(vb.ballotBox || ""), "en");
        case "pledge":
          return String(va.pledgeStatus || "").localeCompare(String(vb.pledgeStatus || ""), "en");
        case "voted":
          return String(vb.votedAt || "").localeCompare(String(va.votedAt || ""), "en");
        case "sequence":
        default: {
          const sa = Number(va.sequence != null ? va.sequence : NaN);
          const sb = Number(vb.sequence != null ? vb.sequence : NaN);
          const aHas = Number.isFinite(sa);
          const bHas = Number.isFinite(sb);
          if (aHas && bHas) return sa - sb;
          if (aHas) return -1;
          if (bHas) return 1;
          return String(va.fullName || "").localeCompare(String(vb.fullName || ""), "en");
        }
      }
    });
    return rows;
  }

  function render() {
    const q = String(body.querySelector("#agentAssignedSearch")?.value || "").trim().toLowerCase();
    const filterPledge = String(body.querySelector("#agentAssignedFilterPledge")?.value || "all");
    const filterBox = String(body.querySelector("#agentAssignedFilterBox")?.value || "all");
    const sortBy = String(body.querySelector("#agentAssignedSort")?.value || "sequence");

    let list = assigned.filter((x) => {
      const v = x.voter || {};
      if (filterPledge !== "all" && String(v.pledgeStatus || "undecided") !== filterPledge) return false;
      if (filterBox !== "all" && reportBallotBoxLabel(v) !== filterBox) return false;
      if (!q) return true;
      const hay = [
        v.fullName,
        v.nationalId,
        v.id,
        v.phone,
        v.permanentAddress,
        reportBallotBoxLabel(v),
        v.notes,
        v.callComments,
        x.assignmentScope,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    list = sortRows(list, sortBy);
    lastRenderedRows = list;

    if (!list.length) {
      tableWrap.innerHTML = `<p class="helper-text" style="padding: 12px 0;">No assigned voters match your filters.</p>`;
      return;
    }

    const rowsHtml = list
      .map((row) => {
        const v = row.voter || {};
        const initials = (v.fullName || "")
          .split(" ")
          .filter(Boolean)
          .slice(0, 2)
          .map((p) => p[0]?.toUpperCase() || "")
          .join("") || "?";
        const photoSrc = getVoterImageSrc(v);
        const imgOnError =
          "var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';";
        const photoCell = photoSrc
          ? `<div class="avatar-cell avatar-cell--settings-agent"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="${imgOnError}"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
          : `<div class="avatar-cell avatar-cell--settings-agent"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
        return `
          <tr>
            <td>${escapeHtml(v.sequence != null && v.sequence !== "" ? String(v.sequence) : "—")}</td>
            <td>${photoCell}</td>
            <td class="data-table-col--name">${escapeHtml(v.fullName || "—")}</td>
            <td>${escapeHtml(v.nationalId || v.id || "—")}</td>
            <td>${escapeHtml(v.phone || "—")}</td>
            <td>${escapeHtml(v.permanentAddress || "—")}</td>
            <td>${escapeHtml(reportBallotBoxLabel(v))}</td>
            <td>${escapeHtml(v.pledgeStatus || "undecided")}</td>
            <td>${escapeHtml(v.supportStatus || "—")}</td>
            <td>${escapeHtml(v.metStatus || "—")}</td>
            <td>${escapeHtml(v.persuadable || "—")}</td>
            <td>${escapeHtml(v.pledgedAt || "—")}</td>
            <td class="voted-status-cell">${escapeHtml(v.votedAt || "—")}</td>
            <td>${escapeHtml(row.assignmentScope || "—")}</td>
            <td>${escapeHtml(v.notes || v.callComments || "—")}</td>
          </tr>
        `;
      })
      .join("");

    tableWrap.innerHTML = `
      <table class="data-table" aria-label="Assigned voters list">
        <thead>
          <tr>
            <th>Seq</th>
            <th>Image</th>
            <th>Name</th>
            <th>ID Number</th>
            <th>Phone</th>
            <th>Permanent Address</th>
            <th>Ballot box</th>
            <th>Pledge</th>
            <th>Support</th>
            <th>Met?</th>
            <th>Persuadable?</th>
            <th>Date pledged</th>
            <th>Voted at</th>
            <th>Assigned in</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  }

  function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function downloadAssignedVotersCsv() {
    if (!lastRenderedRows.length) return;
    const headers = [
      "Seq",
      "Name",
      "ID Number",
      "Phone",
      "Permanent Address",
      "Ballot box",
      "Pledge",
      "Support",
      "Met",
      "Persuadable",
      "Date pledged",
      "Voted at",
      "Assigned in",
      "Notes",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    lastRenderedRows.forEach((row) => {
      const v = row.voter || {};
      const cols = [
        v.sequence != null ? String(v.sequence) : "",
        v.fullName || "",
        v.nationalId || v.id || "",
        v.phone || "",
        v.permanentAddress || "",
        reportBallotBoxLabel(v),
        v.pledgeStatus || "undecided",
        v.supportStatus || "",
        v.metStatus || "",
        v.persuadable || "",
        v.pledgedAt || "",
        v.votedAt || "",
        row.assignmentScope || "",
        v.notes || v.callComments || "",
      ];
      lines.push(cols.map(csvEscape).join(","));
    });
    const csv = lines.join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeAgent = String(agent.name || "agent").trim().replace(/[^\w\-]+/g, "_");
    a.download = `assigned-voters-${safeAgent}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function printAssignedVotersReport() {
    if (!lastRenderedRows.length) return;
    // Print is always ballot-box wise (box ASC, then sequence ASC, then name ASC).
    const printRows = [...lastRenderedRows].sort((a, b) => {
      const va = a.voter || {};
      const vb = b.voter || {};
      const boxA = reportBallotBoxLabel(va);
      const boxB = reportBallotBoxLabel(vb);
      const boxCmp = boxA.localeCompare(boxB, "en");
      if (boxCmp !== 0) return boxCmp;
      const sa = Number(va.sequence != null ? va.sequence : NaN);
      const sb = Number(vb.sequence != null ? vb.sequence : NaN);
      const aHas = Number.isFinite(sa);
      const bHas = Number.isFinite(sb);
      if (aHas && bHas && sa !== sb) return sa - sb;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return String(va.fullName || "").localeCompare(String(vb.fullName || ""), "en");
    });
    const rowsHtml = printRows
      .map((row) => {
        const v = row.voter || {};
        return `
          <tr>
            <td>${escapeHtml(v.sequence != null ? String(v.sequence) : "")}</td>
            <td>${escapeHtml(v.fullName || "")}</td>
            <td>${escapeHtml(v.nationalId || v.id || "")}</td>
            <td>${escapeHtml(v.phone || "")}</td>
            <td>${escapeHtml(v.permanentAddress || "")}</td>
            <td>${escapeHtml(reportBallotBoxLabel(v))}</td>
            <td>${escapeHtml(v.pledgeStatus || "undecided")}</td>
            <td>${escapeHtml(v.votedAt || "")}</td>
            <td>${escapeHtml(row.assignmentScope || "")}</td>
          </tr>
        `;
      })
      .join("");
    const w = window.open("about:blank", "_blank");
    if (!w) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Popup blocked",
          meta: "Allow popups for this site to open Print Preview.",
        });
      } else {
        alert("Allow popups for this site to open Print Preview.");
      }
      return;
    }
    try {
      w.opener = null;
    } catch (_) {}
    w.document.open();
    w.document.write(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Assigned voters report</title>
        <style>
          :root { color-scheme: light; }
          body { font-family: Arial, sans-serif; margin: 0; color: #111; background: #f5f7fb; }
          .page { max-width: 1200px; margin: 20px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.06); overflow: hidden; }
          .report-head { padding: 16px 18px; border-bottom: 1px solid #e5e7eb; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
          .report-title { margin: 0; font-size: 20px; line-height: 1.2; }
          .report-meta { margin: 4px 0 0; color: #4b5563; font-size: 13px; }
          .report-actions { display: flex; gap: 8px; }
          .btn { border: 1px solid #d1d5db; background: #fff; color: #111; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
          .btn--primary { border-color: #2563eb; background: #2563eb; color: #fff; }
          .table-wrap { padding: 10px; overflow: auto; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; min-width: 980px; }
          th, td {
            border: 1px solid #e5e7eb;
            padding: 4px 6px;
            text-align: left;
            vertical-align: top;
            line-height: 1.2;
            white-space: normal;
            overflow-wrap: anywhere;
            word-break: break-word;
            hyphens: auto;
          }
          th { background: #f9fafb; font-weight: 600; position: sticky; top: 0; z-index: 1; }
          tbody tr:nth-child(odd) { background: #fcfcfd; }
          .col-seq { width: 4%; }
          .col-name { width: 15%; }
          .col-id { width: 11%; }
          .col-phone { width: 10%; }
          .col-address { width: 24%; }
          .col-box { width: 9%; }
          .col-pledge { width: 6%; }
          .col-voted { width: 10%; }
          .col-scope { width: 11%; }
          @media print {
            @page { size: A4 landscape; margin: 9mm; }
            body { background: #fff; }
            .page { margin: 0; border: none; box-shadow: none; border-radius: 0; max-width: none; }
            .report-actions { display: none !important; }
            .table-wrap { padding: 0; overflow: visible; }
            table { min-width: 0; width: 100%; font-size: 9.5px; table-layout: fixed; }
            th, td { padding: 2px 4px; line-height: 1.15; }
            th { position: static; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <header class="report-head">
            <div>
              <h1 class="report-title">Assigned voters report</h1>
              <p class="report-meta">Agent: ${escapeHtml(agent.name || "—")} | Total: ${printRows.length} | Sorted: Ballot box | Generated: ${escapeHtml(
                new Date().toLocaleString("en-MV")
              )}</p>
            </div>
            <div class="report-actions">
              <button type="button" class="btn" onclick="window.close()">Close</button>
              <button type="button" class="btn btn--primary" onclick="window.print()">Print</button>
            </div>
          </header>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="col-seq">Seq</th>
                  <th class="col-name">Name</th>
                  <th class="col-id">ID Number</th>
                  <th class="col-phone">Phone</th>
                  <th class="col-address">Permanent Address</th>
                  <th class="col-box">Ballot box</th>
                  <th class="col-pledge">Pledge</th>
                  <th class="col-voted">Voted at</th>
                  <th class="col-scope">Assigned in</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      </body>
      </html>
    `);
    w.document.close();
    w.focus();
  }

  body.querySelector("#agentAssignedSearch")?.addEventListener("input", render);
  body.querySelector("#agentAssignedFilterPledge")?.addEventListener("change", render);
  body.querySelector("#agentAssignedFilterBox")?.addEventListener("change", render);
  body.querySelector("#agentAssignedSort")?.addEventListener("change", render);
  render();

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.flexWrap = "wrap";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";
  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "ghost-button";
  downloadBtn.textContent = "Download CSV";
  downloadBtn.addEventListener("click", downloadAssignedVotersCsv);
  const printBtn = document.createElement("button");
  printBtn.type = "button";
  printBtn.className = "ghost-button";
  printBtn.textContent = "Print";
  printBtn.addEventListener("click", printAssignedVotersReport);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost-button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closeModal());
  footer.appendChild(downloadBtn);
  footer.appendChild(printBtn);
  footer.appendChild(closeBtn);

  openModal({ title: "Assigned voters", body, footer });
}

/** Delete agent (D in CRUD) — Firestore + local cache. */
async function deleteAgentRecord(agent) {
  if (!agent || agent.id == null) return;
  const id = String(agent.id).trim();
  if (!id) return;
  try {
    const api = await firebaseInitPromise;
    const canDeleteRemote = Boolean(api.ready && typeof api.deleteAgentFs === "function");
    if (!canDeleteRemote) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Cannot delete agent",
          meta: "Firebase is not ready. Check your connection and try again.",
        });
      }
      return;
    }
    await api.deleteAgentFs(id);
    agents = agents.filter((a) => String(a.id).trim() !== id);
    saveAgentsToStorage();
    renderAgentsTable();
    try {
      window.agentsCached = [...agents];
    } catch (_) {}
    document.dispatchEvent(new CustomEvent("agents-updated", { detail: { agents: [...agents] } }));
    if (window.appNotifications) {
      window.appNotifications.push({ title: "Agent deleted", meta: agent.name || id });
    }
  } catch (err) {
    const code = err && err.code;
    let meta = err?.message || String(err);
    if (code === "permission-denied") {
      meta =
        "Firestore blocked this delete. Deploy the latest firestore.rules (e.g. firebase deploy --only firestore:rules).";
    }
    console.error("[Agents] delete failed", code, err);
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Could not delete agent",
        meta,
      });
    }
  }
}

/** Alias for modules that only add new agents (e.g. Door to door, candidate voter view). */
export function openAddAgentModal(options) {
  openAgentModal(null, options || {});
}

function renderAgentsTable() {
  const tbody = document.querySelector("#settingsAgentsTable tbody");
  if (!tbody) return;

  ensureAgentsCandidateFilterOptions();
  initAgentsToolbarListeners();

  const viewer = parseViewerFromStorage();
  const showEdit = viewer.isAdmin;
  const votersList = getVotersForAgentModalSearch();

  tbody.innerHTML = "";
  if (!agents.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${SETTINGS_AGENTS_TABLE_COL_COUNT}" class="text-muted" style="text-align: center; padding: 24px;">No agents yet. Use <strong>Create agent</strong> to add one.</td>`;
    tbody.appendChild(tr);
    updateAgentsSortIndicators();
    return;
  }

  const displayList = getFilteredSortedGroupedAgents();
  const dataRows = displayList.filter((x) => x.type === "row");
  if (dataRows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${SETTINGS_AGENTS_TABLE_COL_COUNT}" class="text-muted" style="text-align: center; padding: 24px;">No agents match your search or filters.</td>`;
    tbody.appendChild(tr);
    updateAgentsSortIndicators();
    return;
  }

  function appendAgentRow(a) {
    const tr = document.createElement("tr");
    const aid = a && a.id != null ? String(a.id) : "";
    const cid = a.candidateId != null && String(a.candidateId).trim() !== "" ? String(a.candidateId).trim() : "";
    const candCell = cid ? escapeHtml(candidateLabelById(cid)) : '<span class="text-muted">All campaigns</span>';
    const voterForPhoto = findVoterForAgentPhoto(a, votersList);
    const photoCell = buildAgentTablePhotoCell(a, voterForPhoto);
    const mutateActions =
      showEdit
        ? `<button type="button" class="ghost-button ghost-button--small" data-edit-agent="${escapeHtml(aid)}" title="Update">Edit</button>
        <button type="button" class="ghost-button ghost-button--small settings-agents-crud__delete" data-delete-agent="${escapeHtml(aid)}" title="Delete">Delete</button>`
        : "";
    tr.dataset.agentId = aid;
    tr.innerHTML = `
      <td><code class="settings-agents-id">${escapeHtml(aid)}</code></td>
      <td class="settings-agents-photo-cell">${photoCell}</td>
      <td class="data-table-col--name">${escapeHtml(a.name || "")}</td>
      <td>${escapeHtml(a.nationalId || "")}</td>
      <td>${escapeHtml(a.phone || "")}</td>
      <td>${escapeHtml(a.island || "")}</td>
      <td>${candCell}</td>
      <td class="settings-agents-actions-col">
        <div class="settings-agents-crud" role="group" aria-label="Agent actions">
          <button type="button" class="ghost-button ghost-button--small" data-view-agent="${escapeHtml(aid)}" title="View details">View</button>
          <button type="button" class="ghost-button ghost-button--small" data-view-agent-voters="${escapeHtml(aid)}" title="View assigned voters">Voters</button>
          ${mutateActions}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  for (const item of displayList) {
    if (item.type === "group") {
      const tr = document.createElement("tr");
      tr.className = "pledges-toolbar__group-header";
      tr.innerHTML = `<td colspan="${SETTINGS_AGENTS_TABLE_COL_COUNT}">${escapeHtml(item.label)}</td>`;
      tbody.appendChild(tr);
      continue;
    }
    appendAgentRow(item.agent);
  }

  tbody.querySelectorAll("[data-view-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-view-agent");
      const agent = agents.find((x) => String(x.id) === String(id));
      if (agent) openAgentViewModal(agent);
    });
  });

  tbody.querySelectorAll("[data-view-agent-voters]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-view-agent-voters");
      const agent = agents.find((x) => String(x.id) === String(id));
      if (agent) openAgentAssignedVotersModal(agent);
    });
  });

  tbody.querySelectorAll("[data-edit-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-edit-agent");
      const agent = agents.find((x) => String(x.id) === String(id));
      if (agent) openAgentModal(agent, {});
    });
  });

  tbody.querySelectorAll("[data-delete-agent]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delete-agent");
      if (id == null || id === "") return;
      const agent = agents.find((a) => String(a.id) === String(id));
      if (!agent) return;
      const safeName = escapeHtml(agent.name || id);
      const ok = await confirmDialog({
        title: "Delete agent",
        message: `Delete agent ${safeName} (ID ${escapeHtml(String(agent.id))})? This cannot be undone.`,
        confirmText: "Delete",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;
      await deleteAgentRecord(agent);
    });
  });

  updateAgentsSortIndicators();
}

function openCandidateForm(existing) {
  const isEdit = !!existing;
  const config = getCampaignConfig();
  const defaultConstituency = (config.constituency || "").trim();
  const constituencyValue = existing?.constituency || defaultConstituency;

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="candidateName">Candidate name</label>
        <input id="candidateName" type="text" value="${existing?.name || ""}">
      </div>
      <div class="form-group">
        <label for="candidateNumber">Candidate number</label>
        <input id="candidateNumber" type="text" value="${existing?.candidateNumber ?? ""}" placeholder="e.g. 1">
      </div>
      <div class="form-group">
        <label for="candidatePosition">Position</label>
        <select id="candidatePosition"></select>
      </div>
      <div class="form-group">
        <label for="candidateElectionType">Election type</label>
        <select id="candidateElectionType">
          ${electionTypes
            .map(
              (type) => `
            <option value="${type}"${
              (existing?.electionType || config.campaignType) === type ? " selected" : ""
            }>${type}</option>
          `
            )
            .join("")}
        </select>
      </div>
      <div class="form-group">
        <label for="candidateConstituency">Constituency</label>
        <input id="candidateConstituency" type="text" value="${constituencyValue}" readonly placeholder="Set in Settings → Campaign">
      </div>
      <div class="form-group">
        <label for="candidatePhoto">Candidate photo (URL)</label>
        <input id="candidatePhoto" type="text" value="${
          existing?.photoUrl || ""
        }" placeholder="https://example.com/photo.jpg">
      </div>
      <div class="form-group">
        <label for="candidateDescription">Campaign description</label>
        <textarea id="candidateDescription" rows="3">${
          existing?.description || ""
        }</textarea>
      </div>
    </div>
  `;

  const positionSelect = body.querySelector("#candidatePosition");
  const electionTypeSelect = body.querySelector("#candidateElectionType");

  function fillPositionOptions() {
    const electionType = electionTypeSelect.value;
    const positions = positionsByElectionType[electionType] || [];
    const currentValue = positionSelect.value;
    positionSelect.innerHTML = positions
      .map((p) => `<option value="${p}">${p}</option>`)
      .join("");
    const hasCurrent = positions.includes(currentValue);
    positionSelect.value = hasCurrent ? currentValue : (positions[0] || "");
  }

  fillPositionOptions();
  if (existing?.position) {
    const positions = positionsByElectionType[electionTypeSelect.value] || [];
    if (positions.includes(existing.position)) positionSelect.value = existing.position;
  }
  electionTypeSelect.addEventListener("change", fillPositionOptions);

  const footer = document.createElement("div");
  const saveBtn = document.createElement("button");
  saveBtn.className = "primary-button";
  saveBtn.textContent = isEdit ? "Save changes" : "Add candidate";
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", () => {
    const name = body.querySelector("#candidateName").value.trim();
    const candidateNumber = body.querySelector("#candidateNumber").value.trim();
    const position = body.querySelector("#candidatePosition").value.trim();
    const electionType = body
      .querySelector("#candidateElectionType")
      .value.trim();
    const constituency = body
      .querySelector("#candidateConstituency")
      .value.trim();

    if (!name || !electionType || !constituency) {
      return;
    }

    const photoUrl = body.querySelector("#candidatePhoto").value.trim();
    const description = body.querySelector("#candidateDescription").value.trim();

    let candidate;
    if (isEdit) {
      existing.name = name;
      existing.candidateNumber = candidateNumber;
      existing.position = position;
      existing.electionType = electionType;
      existing.constituency = constituency;
      existing.photoUrl = photoUrl;
      existing.description = description;
      candidate = { ...existing };
    } else {
      const nextId =
        candidates.reduce((max, c) => Math.max(max, c.id), 0) + 1;
      candidate = {
        id: nextId,
        name,
        candidateNumber,
        position,
        electionType,
        constituency,
        photoUrl,
        description,
      };
      candidates.push(candidate);
    }

    saveCandidatesToStorage();
    renderCandidatesTable();
    document.dispatchEvent(new CustomEvent("candidates-updated"));

    (async () => {
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.setCandidateFs) {
          await api.setCandidateFs(candidate);
          saveCandidatesToStorage();
        }
      } catch (err) {
        console.error("[Settings] Failed to save candidate to Firebase:", err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not save candidate to Firebase",
            meta: err?.message || String(err),
          });
        }
      }
    })();

    closeModal();
  });

  openModal({
    title: isEdit ? "Edit candidate" : "Add candidate",
    body,
    footer,
  });
}

function initSettingsTabs() {
  const tabButtons = document.querySelectorAll("[data-settings-tab]");
  const panels = document.querySelectorAll(".settings-tabs__panel");
  const getPanelId = (tab) => `settings-tab-${tab}`;

  function switchToTab(tabKey) {
    tabButtons.forEach((btn) => {
      const isActive = btn.getAttribute("data-settings-tab") === tabKey;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    panels.forEach((panel) => {
      const isTarget = panel.id === getPanelId(tabKey);
      panel.hidden = !isTarget;
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      switchToTab(btn.getAttribute("data-settings-tab"));
    });
  });

  switchToTab("campaign");
}

function initSecurityTab() {
  loadCampaignConfig();
  const pledgesNavEl = document.getElementById("settingsShowPledgesNav");
  const saveBtn = document.getElementById("settingsSecuritySave");

  function refreshSecurityForm() {
    loadCampaignConfig();
    if (pledgesNavEl) pledgesNavEl.value = campaignConfig.showPledgesNav !== false ? "yes" : "no";
  }

  refreshSecurityForm();

  document.addEventListener("campaign-config-changed", refreshSecurityForm);

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (pledgesNavEl) {
        campaignConfig.showPledgesNav = pledgesNavEl.value === "yes";
      }
      saveCampaignConfig();
      await syncCampaignConfigToFirestore();
      document.dispatchEvent(new CustomEvent("campaign-config-changed", { detail: campaignConfig }));
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Security settings saved",
          meta: "Sidebar navigation and preferences updated.",
        });
      }
    });
  }
}

function initCampaignTab() {
  loadCampaignConfig();
  applyCampaignToSidebar();
  syncCampaignConfigFromFirestore();

  const nameEl = document.getElementById("settingsCampaignName");
  const typeEl = document.getElementById("settingsCampaignType");
  const constituencyEl = document.getElementById("settingsCampaignConstituency");
  const islandEl = document.getElementById("settingsCampaignIsland");
  const saveBtn = document.getElementById("settingsCampaignSave");

  if (nameEl) nameEl.value = campaignConfig.campaignName;
  if (typeEl) typeEl.value = campaignConfig.campaignType;
  if (constituencyEl) constituencyEl.value = campaignConfig.constituency;
  if (islandEl) islandEl.value = campaignConfig.island;

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      campaignConfig.campaignName = (nameEl?.value ?? "").trim();
      campaignConfig.campaignType = typeEl?.value ?? campaignConfig.campaignType;
      campaignConfig.constituency = (constituencyEl?.value ?? "").trim();
      campaignConfig.island = (islandEl?.value ?? "").trim();
      syncCampaignConfigToFirestore();
      saveCampaignConfig();
      applyCampaignToSidebar();
      document.dispatchEvent(new CustomEvent("campaign-config-changed", { detail: campaignConfig }));
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Campaign settings updated",
          meta: `${campaignConfig.campaignName || "Campaign"} • ${campaignConfig.campaignType}`,
        });
      }
    });
  }

  const clearRemoteBtn = document.getElementById("settingsCampaignClearRemote");
  if (clearRemoteBtn) {
    clearRemoteBtn.addEventListener("click", async () => {
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.deleteFirestoreCampaignConfig) {
          await api.deleteFirestoreCampaignConfig();
          if (window.appNotifications) {
            window.appNotifications.push({ title: "Remote campaign config cleared", meta: "Local settings kept." });
          }
        }
      } catch (_) {}
    });
  }
}

function initAgentsTab() {
  loadAgentsFromStorage();

  const addBtn = document.getElementById("settingsAgentAddButton");
  if (addBtn) {
    addBtn.addEventListener("click", () => openAgentModal(null, {}));
  }

  initAgentsToolbarListeners();
  renderAgentsTable();
}

async function loadCampaignUsers() {
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.getAllCampaignUsersFs) {
      campaignUsers = await api.getAllCampaignUsersFs();
      if (!Array.isArray(campaignUsers)) campaignUsers = [];
    } else campaignUsers = [];
  } catch (_) {
    campaignUsers = [];
  }
  renderUsersTable();
}

function renderUsersTable() {
  const tbody = document.querySelector("#settingsUsersTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!campaignUsers.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="5" class="text-muted" style="text-align: center; padding: 24px;">No users yet. Add a user to get started.</td>';
    tbody.appendChild(tr);
    return;
  }
  const candList = getCandidates();
  const candById = new Map(candList.map((c) => [String(c.id), c]));
  campaignUsers.forEach((u) => {
    const email = u.email || "";
    const role = u.role === "candidate" ? "Candidate" : u.role === "admin" ? "Admin" : "Staff";
    const cand = u.candidateId ? candById.get(String(u.candidateId)) : null;
    const candName = cand ? (cand.name || cand.id || u.candidateId) : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="data-table-col--name">${escapeHtml(u.displayName || "")}</td>
      <td>${escapeHtml(email)}</td>
      <td>${escapeHtml(role)}</td>
      <td>${escapeHtml(u.role === "candidate" ? candName : "—")}</td>
      <td style="text-align:right;">
        <button type="button" class="ghost-button ghost-button--small" data-edit-user="${escapeHtml(email)}">Edit</button>
        <button type="button" class="ghost-button ghost-button--small" data-remove-user="${escapeHtml(email)}">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("[data-edit-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const email = (btn.getAttribute("data-edit-user") || "").trim();
      if (email) openEditUserModal(email);
    });
  });
  tbody.querySelectorAll("[data-remove-user]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = (btn.getAttribute("data-remove-user") || "").trim();
      if (!email) return;
      const ok = await confirmDialog({
        title: "Remove user",
        message: `Remove ${escapeHtml(email)} from campaign users? They will no longer have candidate-specific access.`,
        confirmText: "Remove",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;
      const normalizedEmail = email.toLowerCase();
      try {
        const api = await firebaseInitPromise;
        if (!api.ready || !api.deleteCampaignUserFs) {
          if (window.appNotifications) window.appNotifications.push({ title: "Cannot remove user", meta: "Firebase is not ready." });
          return;
        }
        await api.deleteCampaignUserFs(normalizedEmail);
        await loadCampaignUsers();
        if (window.appNotifications) window.appNotifications.push({ title: "User removed", meta: email });
      } catch (err) {
        if (window.appNotifications) {
          window.appNotifications.push({ title: "Could not remove user", meta: err?.message || String(err) });
        }
      }
    });
  });
}

async function openEditUserModal(email) {
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!normalizedEmail) return;
  const user = campaignUsers.find((u) => (u.email || "").toLowerCase() === normalizedEmail);
  if (!user) {
    if (window.appNotifications) window.appNotifications.push({ title: "User not found", meta: email });
    return;
  }
  let candList = getCandidates();
  if (!candList.length) {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllCandidatesFs) {
        const items = await api.getAllCandidatesFs();
        if (Array.isArray(items) && items.length) {
          candidates = items;
          saveCandidatesToStorage();
          candList = candidates.slice(0, MAX_CANDIDATES);
        }
      }
    } catch (_) {}
  }
  const body = document.createElement("div");
  body.className = "form-group";
  const roleOptions =
    '<option value="admin">Admin</option><option value="candidate">Candidate</option>';
  const candidateOptions =
    '<option value="">Select candidate…</option>' +
    candList.map(
      (c) =>
        `<option value="${escapeHtml(String(c.id))}">${escapeHtml(c.name || `Candidate ${c.id}`)}</option>`
    ).join("");
  const currentRole = user.role === "candidate" ? "candidate" : "admin";
  const currentCand = (user.candidateId || "").trim();
  body.innerHTML = `
    <div class="form-group">
      <label for="editUserEmail">Email</label>
      <input type="email" id="editUserEmail" class="input" value="${escapeHtml(user.email || normalizedEmail)}" readonly disabled>
    </div>
    <div class="form-group">
      <label for="editUserDisplayName">Display name</label>
      <input type="text" id="editUserDisplayName" class="input" placeholder="Full name" value="${escapeHtml(user.displayName || "")}">
    </div>
    <div class="form-group">
      <label for="editUserRole">Role</label>
      <select id="editUserRole" class="input">
        ${roleOptions}
      </select>
    </div>
    <div class="form-group" id="editUserCandidateGroup">
      <label for="editUserCandidate">Candidate</label>
      <select id="editUserCandidate" class="input">
        ${candidateOptions}
      </select>
      <p class="helper-text">Only for Candidate role. This user sees the full voter list scoped to this candidate for pledges and agents.</p>
    </div>
  `;
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
  saveBtn.textContent = "Save changes";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  const roleSelect = body.querySelector("#editUserRole");
  const candidateGroup = body.querySelector("#editUserCandidateGroup");
  const candidateSelect = body.querySelector("#editUserCandidate");
  roleSelect.value = currentRole;
  candidateSelect.value = currentCand;
  function toggleCandidateVisibility() {
    candidateGroup.style.display = roleSelect?.value === "candidate" ? "" : "none";
  }
  roleSelect.addEventListener("change", toggleCandidateVisibility);
  toggleCandidateVisibility();

  saveBtn.addEventListener("click", async () => {
    const displayName = (body.querySelector("#editUserDisplayName")?.value || "").trim();
    const role = roleSelect?.value === "candidate" ? "candidate" : "admin";
    const candidateId = role === "candidate" && candidateSelect?.value ? candidateSelect.value : "";
    try {
      const api = await firebaseInitPromise;
      if (!api.ready || !api.setCampaignUserFs) {
        if (window.appNotifications) window.appNotifications.push({ title: "Cannot save", meta: "Firebase is not ready." });
        return;
      }
      await api.setCampaignUserFs({ email: normalizedEmail, displayName, role, candidateId });
      await loadCampaignUsers();
      closeModal();
      if (window.appNotifications) {
        window.appNotifications.push({ title: "User updated", meta: normalizedEmail });
      }
    } catch (err) {
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Could not update user", meta: err?.message || String(err) });
      }
    }
  });

  openModal({ title: "Edit user", body, footer });
}

async function openAddUserModal() {
  let candList = getCandidates();
  if (!candList.length) {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllCandidatesFs) {
        const items = await api.getAllCandidatesFs();
        if (Array.isArray(items) && items.length) {
          candidates = items;
          saveCandidatesToStorage();
          candList = candidates.slice(0, MAX_CANDIDATES);
        }
      }
    } catch (_) {}
  }
  const body = document.createElement("div");
  body.className = "form-group";
  const roleOptions =
    '<option value="admin">Admin</option><option value="candidate">Candidate</option>';
  const candidateOptions =
    '<option value="">Select candidate…</option>' +
    candList.map(
      (c) =>
        `<option value="${escapeHtml(String(c.id))}">${escapeHtml(c.name || `Candidate ${c.id}`)}</option>`
    ).join("");
  body.innerHTML = `
    <div class="form-group">
      <label for="userEmail">Email</label>
      <input type="email" id="userEmail" class="input" placeholder="user@example.com" required>
    </div>
    <div class="form-group">
      <label for="userDisplayName">Display name</label>
      <input type="text" id="userDisplayName" class="input" placeholder="Full name">
    </div>
    <div class="form-group">
      <label for="userRole">Role</label>
      <select id="userRole" class="input">
        ${roleOptions}
      </select>
    </div>
    <div class="form-group" id="userCandidateGroup">
      <label for="userCandidate">Candidate</label>
      <select id="userCandidate" class="input">
        ${candidateOptions}
      </select>
      <p class="helper-text">Only for Candidate role. This user sees the full voter list scoped to this candidate for pledges and agents.</p>
    </div>
  `;
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
  saveBtn.textContent = "Add user";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  const roleSelect = body.querySelector("#userRole");
  const candidateGroup = body.querySelector("#userCandidateGroup");
  const candidateSelect = body.querySelector("#userCandidate");
  function toggleCandidateVisibility() {
    candidateGroup.style.display = roleSelect?.value === "candidate" ? "" : "none";
  }
  roleSelect.addEventListener("change", toggleCandidateVisibility);
  toggleCandidateVisibility();

  saveBtn.addEventListener("click", async () => {
    const email = (body.querySelector("#userEmail")?.value || "").trim().toLowerCase();
    const displayName = (body.querySelector("#userDisplayName")?.value || "").trim();
    const role = roleSelect?.value === "candidate" ? "candidate" : "admin";
    const candidateId = role === "candidate" && candidateSelect?.value ? candidateSelect.value : "";
    if (!email) return;
    try {
      const api = await firebaseInitPromise;
      if (!api.ready || !api.setCampaignUserFs) return;
      await api.setCampaignUserFs({ email, displayName, role, candidateId });
      await loadCampaignUsers();
      closeModal();
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "User added",
          meta: role === "candidate" ? `${email} (Candidate)` : `${email} (Admin)`,
        });
      }
    } catch (err) {
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Could not add user", meta: err?.message || String(err) });
      }
    }
  });

  openModal({ title: "Add user", body, footer });
}

function initUsersTab() {
  loadCampaignUsers();
  const addBtn = document.getElementById("settingsAddUserButton");
  if (addBtn) addBtn.addEventListener("click", () => openAddUserModal());
}

export function initSettingsModule() {
  initSettingsTabs();
  initCampaignTab();
  initSecurityTab();

  // Load candidates from Firebase first (source of truth), fall back to cache on error or when Firebase not ready
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllCandidatesFs) {
        const items = await api.getAllCandidatesFs();
        if (Array.isArray(items)) {
          candidates = items;
          saveCandidatesToStorage();
          renderCandidatesTable();
          return;
        }
      }
      loadCandidatesFromStorage();
      renderCandidatesTable();
    } catch (err) {
      console.error("Candidate load failed:", err);
      loadCandidatesFromStorage();
      renderCandidatesTable();
    }
  })();

  initAgentsTab();
  initUsersTab();

  // Firestore-backed agents: load and subscribe in real time
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllAgentsFs && api.onAgentsSnapshotFs) {
        const initial = await api.getAllAgentsFs();
        if (Array.isArray(initial)) {
          agents = initial;
          saveAgentsToStorage();
          renderAgentsTable();
          try {
            window.agentsCached = [...agents];
          } catch (_) {}
          document.dispatchEvent(
            new CustomEvent("agents-updated", {
              detail: { agents: [...agents] },
            })
          );
        } else {
          loadAgentsFromStorage();
          renderAgentsTable();
        }

        unsubscribeAgentsFs = api.onAgentsSnapshotFs((items) => {
          if (!Array.isArray(items)) return;
          agents = items;
          saveAgentsToStorage();
          renderAgentsTable();
          try {
            window.agentsCached = [...agents];
          } catch (_) {}
          document.dispatchEvent(
            new CustomEvent("agents-updated", {
              detail: { agents: [...agents] },
            })
          );
        });
      } else {
        // Firestore not ready; rely on local cache only
        loadAgentsFromStorage();
        renderAgentsTable();
      }
    } catch (_) {
      loadAgentsFromStorage();
      renderAgentsTable();
    }
  })();

  addCandidateButton.addEventListener("click", () => {
    openCandidateForm(null);
  });

  candidatesTableBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit-candidate]");
    if (!btn) return;
    const id = Number(btn.getAttribute("data-edit-candidate"));
    const existing = candidates.find((c) => c.id === id);
    if (existing) {
      openCandidateForm(existing);
    }
  });

  if (votersUploadFileInput) {
    votersUploadFileInput.addEventListener("change", () => {
      const file = votersUploadFileInput.files?.[0];
      if (votersUploadFileNameEl) {
        votersUploadFileNameEl.textContent = file ? file.name : "";
      }
    });
  }

  /**
   * Parse a single CSV line respecting double-quoted fields (commas inside quotes stay in one column).
   */
  function parseCSVLine(line) {
    const out = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && c === ",") {
        out.push(field.trim());
        field = "";
        continue;
      }
      field += c;
    }
    out.push(field.trim());
    return out;
  }

  function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  importVotersButton.addEventListener("click", () => {
    const file = votersUploadFileInput.files?.[0];
    if (!file) return;

    // Basic safety caps to avoid browser "Out of memory" when importing very large files.
    if (file.size > MAX_VOTERS_FILE_BYTES) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "File too large",
          meta: "Voters CSV is larger than 15MB. Please split it into smaller files and try again.",
        });
      } else {
        alert("Voters CSV is too large. Please split it into smaller files (under 15MB) and try again.");
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target?.result || "");
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) return;

      const rawHeader = parseCSVLine(lines[0]);
      const header = rawHeader.map((h) => String(h).trim());

      let dataLines = lines.slice(1);
      if (dataLines.length > MAX_VOTER_ROWS) {
        dataLines = dataLines.slice(0, MAX_VOTER_ROWS);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Voters list truncated",
            meta: `Only the first ${MAX_VOTER_ROWS.toLocaleString("en-MV")} rows were imported to protect browser performance.`,
          });
        }
      }

      const rows = dataLines.map((line) => {
        const cols = parseCSVLine(line);
        const obj = {};
        header.forEach((h, idx) => {
          const key = h || `Column${idx + 1}`;
          obj[key] = cols[idx] != null ? String(cols[idx]).trim() : "";
        });
        return obj;
      });

      importVotersFromTemplateRows(rows);
      if (votersUploadFileNameEl) votersUploadFileNameEl.textContent = "";
      votersUploadFileInput.value = "";
    };
    reader.readAsText(file);
  });

  if (exportVotersCsvButton) {
    exportVotersCsvButton.addEventListener("click", async () => {
      try {
        // Prefer live voters from Firebase so we capture latest updates (votedAt, pledge, notes, etc.)
        let voters = [];
        try {
          const api = await firebaseInitPromise;
          if (api.ready && api.getAllVotersFs) {
            voters = await api.getAllVotersFs();
          }
        } catch (_) {}
        if (!Array.isArray(voters) || voters.length === 0) {
          // Fallback to local cache if Firebase is not ready.
          try {
            const raw = localStorage.getItem("voters-data");
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) voters = parsed;
            }
          } catch (_) {}
        }
        if (!Array.isArray(voters) || voters.length === 0) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "No voters to export",
              meta: "There are no voters in this campaign to download.",
            });
          }
          return;
        }

        const headers = [
          "Sequence",
          "Ballot Box",
          "ID Number",
          "Name",
          "Permanent Address",
          "Date of Birth",
          "Age",
          "Pledge",
          "Gender",
          "Island",
          "Current Location",
          "Phone",
          "Notes",
          "Support status",
          "Met?",
          "Persuadable?",
          "Date pledged",
          "Voted at",
        ];
        const lines = [headers.map(csvEscape).join(",")];
        voters.forEach((v) => {
          const row = [
            v.sequence ?? "",
            v.ballotBox || "",
            v.nationalId || "",
            v.fullName || v.name || "",
            v.permanentAddress || "",
            v.dateOfBirth || "",
            v.age ?? "",
            v.pledgeStatus || "",
            v.gender || "",
            v.island || "",
            v.currentLocation || "",
            v.phone || "",
            v.notes || v.callComments || "",
            v.supportStatus || "",
            v.metStatus || "",
            v.persuadable || "",
            v.pledgedAt || "",
            v.votedAt || "",
          ];
          lines.push(row.map(csvEscape).join(","));
        });
        const csv = lines.join("\r\n");
        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `voters-export-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Voters exported",
            meta: `${voters.length.toLocaleString("en-MV")} voters as CSV`,
          });
        }
      } catch (err) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not export voters",
            meta: err?.message || String(err),
          });
        }
      }
    });
  }

  if (syncVotersToFirebaseButton) {
    syncVotersToFirebaseButton.addEventListener("click", async () => {
      try {
        const raw = localStorage.getItem("voters-data");
        if (!raw) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "No local voters to sync",
              meta: "There are no voters stored in this browser.",
            });
          }
          return;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.length) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "No local voters to sync",
              meta: "There are no voters stored in this browser.",
            });
          }
          return;
        }
        const api = await firebaseInitPromise;
        if (!api.ready || !api.setVoterFs) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Sync unavailable",
              meta: "Firebase is not ready. Check your network or configuration.",
            });
          }
          return;
        }
        const voters = parsed;
        const limited = voters.slice(0, 2000); // safety cap
        await Promise.all(
          limited.map((v) => {
            if (!v || !v.id) return Promise.resolve();
            return api.setVoterFs(v);
          })
        );
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Voters synced to Firebase",
            meta: `${limited.length.toLocaleString("en-MV")} local voters pushed to Firestore.`,
          });
        }
      } catch (err) {
        console.error("[Settings] Failed to sync local voters to Firebase", err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Sync failed",
            meta: "Check the console for details.",
          });
        }
      }
    });
  }

  if (deleteAllVotersButton) {
    deleteAllVotersButton.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Delete all voters",
        message:
          "Delete all voters in this campaign? This will remove the voters list from this browser and from Firebase (if connected). This cannot be undone.",
        confirmText: "Delete all",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;

      // Clear local cache first.
      try {
        localStorage.removeItem("voters-data");
      } catch (_) {}

      // Best-effort Firestore delete of all voters.
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.getAllVotersFs && api.deleteVoterFs) {
          const existing = await api.getAllVotersFs();
          if (Array.isArray(existing) && existing.length) {
            const limited = existing.slice(0, 20000);
            await Promise.all(
              limited.map((v) => api.deleteVoterFs(v.id))
            );
          }
        }
      } catch (_) {}

      // Let modules refresh themselves.
      document.dispatchEvent(new CustomEvent("voters-updated"));
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Voters list deleted",
          meta: "All voters for this campaign have been removed.",
        });
      }
    });
  }
  // Firestore-backed candidates: load and subscribe in real time
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllCandidatesFs && api.onCandidatesSnapshotFs) {
        const initial = await api.getAllCandidatesFs();
        if (Array.isArray(initial)) {
          candidates = initial;
          saveCandidatesToStorage();
          renderCandidatesTable();
          document.dispatchEvent(
            new CustomEvent("candidates-updated", {
              detail: { candidates: [...candidates] },
            })
          );
        } else {
          loadCandidatesFromStorage();
          renderCandidatesTable();
        }

        api.onCandidatesSnapshotFs((items) => {
          if (!Array.isArray(items)) return;
          candidates = items;
          saveCandidatesToStorage();
          renderCandidatesTable();
          document.dispatchEvent(
            new CustomEvent("candidates-updated", {
              detail: { candidates: [...candidates] },
            })
          );
        });
      } else {
        loadCandidatesFromStorage();
        renderCandidatesTable();
      }
    } catch (err) {
      console.error("[Settings] Failed to load candidates from Firebase:", err);
      loadCandidatesFromStorage();
      renderCandidatesTable();
    }
  })();
}

loadCampaignConfig();

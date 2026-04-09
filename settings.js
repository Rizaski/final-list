import { openModal, closeModal, confirmDialog } from "./ui.js";
import {
  importVotersFromTemplateRows,
  getVoterImageSrc,
  getVotersContextForStandalone,
  refreshVotersFromStorage,
  removeDuplicateVotersByNationalId,
  syncLocalVotersToFirebase,
  AUTO_SYNC_LOCAL_VOTERS_ONLINE_KEY,
  importCandidatePledgeAgentFromCsvRows,
  getEffectiveVotedAtForVoter,
  getHeaderElectionScope,
} from "./voters.js";
import { openCandidatePledgedVotersModal } from "./candidate-pledged-voters-modal.js";
import { firebaseInitPromise } from "./firebase.js";
import {
  AGENTS_STORAGE_KEY,
  filterAgentsForViewer,
  formatAgentNameHint,
  parseViewerFromStorage,
} from "./agents-context.js";
import { getMonitorTokensForArchive, clearLocalCampaignWorkspaceCache } from "./archive-helpers.js";

/** Set by initSettingsTabs; used to switch tab when viewer role changes. */
let switchSettingsTabFn = null;
/** Archive UI listeners bound once; visibility/list refresh on each call. */
let campaignArchiveListenersBound = false;

/**
 * Show admin-only or candidate-only settings tabs and activate the default tab.
 * Call after login/logout (see main.js applyUserToShell).
 */
export function applySettingsTabsVisibility() {
  if (typeof switchSettingsTabFn !== "function") return;
  const u = parseViewerFromStorage();
  const isCandidate = u.role === "candidate" && u.candidateId;
  document.querySelectorAll('[data-settings-scope="admin"]').forEach((el) => {
    el.hidden = !!isCandidate;
  });
  document.querySelectorAll('[data-settings-scope="candidate"]').forEach((el) => {
    el.hidden = !isCandidate;
  });
  const settingsDesc = document.querySelector("#module-settings .module-description");
  if (settingsDesc) {
    settingsDesc.textContent = isCandidate
      ? "Upload pledge and assigned agent data from a CSV (matched by voter ID number)."
      : "Configure system parameters, candidates, data, security, and users.";
  }
  switchSettingsTabFn(isCandidate ? "candidate-csv" : "campaign");
  initCampaignArchiveUI();
}
import { compareBallotSequence, sequenceAsImportedFromCsv } from "./sequence-utils.js";

/**
 * Resolve Firebase API for agent save — never rejects on timeout (local save must still run).
 */
async function getFirebaseApiForAgentSave(timeoutMs = 20000) {
  try {
    const api = await Promise.race([
      firebaseInitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (api && typeof api === "object" && api.ready !== undefined) return api;
  } catch (_) {
    /* init rejected */
  }
  return { ready: false, setAgentFs: null, getAllAgentsFs: null };
}

/**
 * Snapshot replaces in-memory agents; rows only on disk (failed Firestore write) would vanish.
 * Keep agents marked __localPendingSync until the server includes the same id.
 */
function mergeAgentsSnapshotWithLocal(serverItems, previousAgents) {
  const byId = new Map();
  const serverArr = Array.isArray(serverItems) ? serverItems : [];
  serverArr.forEach((a) => {
    if (a && a.id != null) {
      const clean = { ...a };
      delete clean.__localPendingSync;
      byId.set(String(a.id), clean);
    }
  });
  const prevArr = Array.isArray(previousAgents) ? previousAgents : [];
  prevArr.forEach((a) => {
    if (!a || a.id == null) return;
    const id = String(a.id);
    if (a.__localPendingSync && !byId.has(id)) {
      byId.set(id, { ...a });
    }
  });
  return Array.from(byId.values());
}

/** Last-write-wins by agent id — prevents duplicate rows if save ran twice with same id. */
function dedupeAgentsById(list) {
  const byId = new Map();
  (Array.isArray(list) ? list : []).forEach((a) => {
    if (a && a.id != null) {
      const id = String(a.id);
      if (!byId.has(id)) byId.set(id, a);
    }
  });
  return Array.from(byId.values());
}

/**
 * Next Firestore document id for a new agent. Uses max numeric id + 1 among all agents, and skips
 * ids that are already taken (handles mixed numeric and non-numeric ids without reusing "1").
 */
function getNextAgentDocumentId(agentList) {
  const list = Array.isArray(agentList) ? agentList : [];
  const used = new Set();
  let maxNum = 0;
  for (const a of list) {
    if (!a || a.id == null) continue;
    const sid = String(a.id).trim();
    if (!sid) continue;
    used.add(sid);
    const n = Number(sid);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }
  let candidate = maxNum + 1;
  let idStr = String(candidate);
  while (used.has(idStr)) {
    candidate += 1;
    idStr = String(candidate);
  }
  return idStr;
}

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
  /** Zero Day → Vote Marking: ordered ballot box keys (excludes synthetic aggregate). */
  voteMarkingBallotBoxOrder: [],
  /** Ballot box key → view: `cards` | `list` | `compact`. Optional `__aggregate__` for campaign-wide card. */
  voteMarkingBallotBoxViews: {},
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
      if (Array.isArray(remote.voteMarkingBallotBoxOrder)) {
        campaignConfig.voteMarkingBallotBoxOrder = remote.voteMarkingBallotBoxOrder
          .map((x) => String(x).trim())
          .filter(Boolean);
      }
      if (remote.voteMarkingBallotBoxViews && typeof remote.voteMarkingBallotBoxViews === "object") {
        campaignConfig.voteMarkingBallotBoxViews = { ...remote.voteMarkingBallotBoxViews };
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
      ...(Array.isArray(campaignConfig.voteMarkingBallotBoxOrder)
        ? { voteMarkingBallotBoxOrder: campaignConfig.voteMarkingBallotBoxOrder }
        : {}),
      ...(campaignConfig.voteMarkingBallotBoxViews &&
      typeof campaignConfig.voteMarkingBallotBoxViews === "object"
        ? { voteMarkingBallotBoxViews: { ...campaignConfig.voteMarkingBallotBoxViews } }
        : {}),
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

/** Maps top bar `#electionType` value → canonical campaign type string (candidate `electionType`, positions, etc.). */
const HEADER_SCOPE_TO_CAMPAIGN_TYPE = {
  local: "Local Council Election",
  parliamentary: "Parliamentary Election",
  presidential: "Presidential Election",
};

/**
 * Campaign config as the user is currently viewing it: `campaignType` follows the header election
 * dropdown so merged Local Council voter data is paired with Local Council candidates/pledges even when
 * Settings / Firestore still store Presidential (e.g. after archive delete + merged list).
 * Use `getCampaignConfig()` only when persisting or editing saved workspace settings.
 */
export function getEffectiveCampaignConfig() {
  const base = { ...campaignConfig };
  let scope = null;
  try {
    const el = typeof document !== "undefined" ? document.getElementById("electionType") : null;
    const v = el?.value;
    if (v === "local" || v === "parliamentary" || v === "presidential") scope = v;
  } catch (_) {}
  if (!scope) {
    try {
      const s = getHeaderElectionScope();
      if (s === "local" || s === "parliamentary" || s === "presidential") scope = s;
    } catch (_) {}
  }
  if (!scope) scope = "local";
  const ct = HEADER_SCOPE_TO_CAMPAIGN_TYPE[scope];
  if (ct) base.campaignType = ct;
  return base;
}

/**
 * Candidates for the election type currently selected in the header (matches `electionType` on each candidate).
 * If none match, returns all candidates so older data without `electionType` still works.
 */
export function getCandidatesForActiveElectionView() {
  const want = getEffectiveCampaignConfig().campaignType;
  const all = getCandidates();
  const matched = all.filter((c) => String(c.electionType || "").trim() === want);
  return matched.length > 0 ? matched : all;
}

/** Merge into in-memory campaign config, persist localStorage, notify listeners (e.g. Vote Marking layout). */
export function mergeLocalCampaignConfig(partial) {
  if (!partial || typeof partial !== "object") return;
  campaignConfig = { ...campaignConfig, ...partial };
  saveCampaignConfig();
  document.dispatchEvent(new CustomEvent("campaign-config-changed", { detail: { ...campaignConfig } }));
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
const removeDuplicateVotersByNationalIdButton = document.getElementById(
  "removeDuplicateVotersByNationalIdButton"
);

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

/**
 * Load candidates before building Create/Edit Agent "Candidate scope" for admins.
 * In-memory `candidates` can still be [] if the user opens the modal before
 * initSettingsModule's async Firestore fetch completes.
 */
async function ensureCandidatesLoadedForAgentModal() {
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.getAllCandidatesFs) {
      const items = await api.getAllCandidatesFs();
      if (Array.isArray(items)) {
        candidates = items;
        saveCandidatesToStorage();
        try {
          renderCandidatesTable();
        } catch (_) {}
        return;
      }
    }
  } catch (err) {
    console.warn("[Agents] Could not load candidates for agent modal", err);
  }
  loadCandidatesFromStorage();
  try {
    renderCandidatesTable();
  } catch (_) {}
}

/**
 * After the modal is open, refill "Candidate scope" from Firestore so the list is never empty
 * just because the user opened Create agent before the initial sync finished.
 */
async function refreshAgentModalCandidateScopeOptions(modalBodyRoot, existing) {
  try {
    await ensureCandidatesLoadedForAgentModal();
    const sel =
      (modalBodyRoot && modalBodyRoot.querySelector("#agentModalCandidateId")) ||
      document.getElementById("agentModalCandidateId");
    if (!sel || sel.tagName !== "SELECT" || sel.disabled) return;
    const preserve = String(sel.value || "").trim();
    const candList = getCandidates();
    sel.innerHTML = `
      <option value="">All campaigns (visible to staff &amp; all candidates)</option>
      ${candList
        .map(
          (c) =>
            `<option value="${escapeHtml(String(c.id))}"${
              String(existing?.candidateId || "") === String(c.id) ? " selected" : ""
            }>${escapeHtml(c.name || String(c.id))}</option>`
        )
        .join("")}
    `;
    if (preserve && [...sel.options].some((o) => o.value === preserve)) {
      sel.value = preserve;
    }
  } catch (err) {
    console.warn("[Agents] candidate scope options refresh failed", err);
  }
}

let agents = [];
/** Primary agent id (string) → extra rows when grouped (legacy; table lists one row per agent). */
let settingsAgentDuplicateAgentsByPrimaryId = new Map();
let campaignUsers = [];
let unsubscribeAgentsFs = null;

function renderCandidatesTable() {
  if (!candidatesTableBody) return;
  candidatesTableBody.innerHTML = "";
  const total = candidates.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (candidatesCurrentPage > totalPages) candidatesCurrentPage = totalPages;
  const start = (candidatesCurrentPage - 1) * PAGE_SIZE;
  const pageCandidates = candidates.slice(start, start + PAGE_SIZE);

  pageCandidates.forEach((c) => {
    const tr = document.createElement("tr");
    tr.dataset.candidateId = String(c.id);
    const initials = (c.name || "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?";
    const photoSrc = String(c.photoUrl || "").trim();
    const photoCell = photoSrc
      ? `<div class="avatar-cell avatar-cell--settings-agent"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
      : `<div class="avatar-cell avatar-cell--settings-agent"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
    tr.innerHTML = `
      <td>${photoCell}</td>
      <td class="data-table-col--name">${escapeHtml(c.name || "")}</td>
      <td>${escapeHtml(c.candidateNumber ?? "")}</td>
      <td>${escapeHtml(c.position ?? "")}</td>
      <td>${escapeHtml(c.electionType || "")}</td>
      <td>${escapeHtml(c.constituency || "")}</td>
      <td style="text-align:right;">
        <div class="settings-agents-crud" role="group" aria-label="Candidate actions">
          <button type="button" class="ghost-button ghost-button--small" data-candidate-pledged-voters="${escapeHtml(c.id)}" title="Pledged voters list">Voters</button>
          <button type="button" class="ghost-button ghost-button--small" data-edit-candidate="${escapeHtml(c.id)}">Edit</button>
          <button type="button" class="ghost-button ghost-button--small settings-agents-crud__delete" data-delete-candidate="${escapeHtml(c.id)}" title="Delete">Delete</button>
        </div>
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

/** Same columns as Settings → Data → Bulk Voter Upload subtitle (import template). */
function csvEscapeBulkVoterTemplate(val) {
  const s = String(val == null ? "" : val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * @param {object[]} voters — live or archived snapshot rows (`fullName` or `name`, `sequence` or `ballotSequence`).
 * @returns {string} CSV text with UTF-8 BOM added by caller if needed.
 */
function buildBulkVoterUploadTemplateCsv(voters) {
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
    "Call Comments",
  ];
  const sequenceCell = (v) => {
    if (!v || typeof v !== "object") return "";
    const raw =
      v.sequence != null && v.sequence !== ""
        ? v.sequence
        : v.ballotSequence != null && v.ballotSequence !== ""
          ? v.ballotSequence
          : "";
    return sequenceAsImportedFromCsv({ sequence: raw });
  };
  const lines = [headers.map(csvEscapeBulkVoterTemplate).join(",")];
  (Array.isArray(voters) ? voters : []).forEach((v) => {
    if (!v) return;
    const row = [
      sequenceCell(v),
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
    ];
    lines.push(row.map(csvEscapeBulkVoterTemplate).join(","));
  });
  return lines.join("\r\n");
}

function triggerDownloadCsv(filename, csvText) {
  const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function sanitizeFilenameSegment(s) {
  return String(s || "")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "archive";
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

function normalizeAgentCandidateScope(c) {
  if (c == null || c === "") return "";
  return String(c).trim();
}

/**
 * Returns an existing agent row if the same national ID (agent ID number) already exists in this scope.
 * A candidate (or unscoped “all campaigns”) cannot register the same ID number twice; name is ignored.
 */
function getDuplicateAgentInScope({ nationalId, candidateId, excludeAgentId }) {
  const nid = normalizeAgentNationalId(nationalId);
  if (!nid) return null;
  const scope = normalizeAgentCandidateScope(candidateId);
  return (
    agents.find((a) => {
      if (excludeAgentId != null && String(a.id) === String(excludeAgentId)) return false;
      const aNid = normalizeAgentNationalId(a.nationalId);
      if (!aNid || aNid !== nid) return false;
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

/** One row per agent in the table; saving prevents duplicate national IDs per scope (see getDuplicateAgentInScope). */
function mapAgentsToTableRows(sortedAgents) {
  return sortedAgents.map((a) => ({ agent: a, duplicateAgents: [] }));
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

  const dedupedRows = mapAgentsToTableRows(filtered);

  if (groupBy === "none") {
    return dedupedRows.map(({ agent, duplicateAgents }) => ({
      type: "row",
      agent,
      duplicateAgents,
    }));
  }

  const getGroupKey = (v) => {
    if (groupBy === "island") return (v.island || "").trim() || "—";
    if (groupBy === "candidate") return candidateLabelById(getAgentCandidateScopeId(v));
    return "";
  };

  const displayList = [];
  let lastKey = null;
  dedupedRows.forEach(({ agent, duplicateAgents }) => {
    const key = getGroupKey(agent);
    if (key !== lastKey) {
      displayList.push({ type: "group", label: key });
      lastKey = key;
    }
    displayList.push({ type: "row", agent, duplicateAgents });
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
function openAgentModalCore(existing = null, options = {}) {
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

  // Never block opening the modal on Firestore — await was preventing openModal() from running
  // when the network was slow or init hadn’t finished. Cache first, then refresh options async.
  loadCandidatesFromStorage();
  const candList = getCandidates();

  const body = document.createElement("div");
  body.className = "form-grid form-grid--agent-modal";

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

  function hideAgentModalVoterSearchMenu() {
    if (searchMenu) searchMenu.style.display = "none";
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
    // Close dropdown so its overlay (z-index) does not block Candidate scope / other fields below.
    hideAgentModalVoterSearchMenu();
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
    if (saveBtn.disabled) return;

    const labelDefault = isEdit ? "Update agent" : "Create agent";
    const labelBusy = isEdit ? "Saving…" : "Creating…";
    saveBtn.disabled = true;
    saveBtn.setAttribute("aria-busy", "true");

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
    // Candidate login / door-knock flows pass lockCandidateId — always persist that scope even if
    // the hidden input was cleared or not yet in the DOM (avoids unscoped saves + wrong duplicate checks).
    if (effectiveLockCandidate) {
      candidateId = String(effectiveLockCandidate).trim();
    }

    function resetSaveButton() {
      if (!saveBtn.isConnected) return;
      saveBtn.disabled = false;
      saveBtn.removeAttribute("aria-busy");
      saveBtn.textContent = labelDefault;
    }

    // Support creating external/manual agents not present in voter records.
    // Name must be present; strict voter-name formatting is no longer required.
    if (!name) {
      resetSaveButton();
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Missing fields",
          meta: "Full name, National ID and phone are required.",
        });
      }
      return;
    }
    if (!nationalId || !phone) {
      resetSaveButton();
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Missing fields",
          meta: "Full name, National ID and phone are required.",
        });
      }
      return;
    }

    saveBtn.textContent = labelBusy;

    (async () => {
      if (saveBtn._agentSaveInFlight) return;
      saveBtn._agentSaveInFlight = true;
      let closedOnSuccess = false;
      try {
        const api = await getFirebaseApiForAgentSave();

        // Merge latest Firestore agents before duplicate check and before assigning a new id.
        // If the user opens Create before the first snapshot/load finishes, `agents` can be
        // empty while the server already has agents/1, agents/2, … — reusing id 1 would
        // overwrite the wrong document.
        if (api.ready && api.getAllAgentsFs) {
          try {
            const fresh = await api.getAllAgentsFs();
            if (Array.isArray(fresh)) {
              const byId = new Map();
              agents.forEach((a) => {
                if (a && a.id != null) byId.set(String(a.id), a);
              });
              fresh.forEach((a) => {
                if (a && a.id != null) byId.set(String(a.id), a);
              });
              agents = Array.from(byId.values());
            }
          } catch (_) {
            /* offline / transient — continue with local agents */
          }
        }

        const scopeForDup = (candidateId || "").trim();
        const existingDup = getDuplicateAgentInScope({
          nationalId,
          candidateId: scopeForDup || null,
          excludeAgentId: isEdit && existing?.id != null ? existing.id : null,
        });
        if (existingDup) {
          resetSaveButton();
          const scopeLabel = scopeForDup
            ? candidateLabelById(scopeForDup)
            : "All campaigns (unscoped)";
          const existingLabel = (existingDup.name || "").trim() || "this agent";
          // Use a blocking dialog here — openModal() would replace the Create agent form while it is open.
          window.alert(
            `This national ID is already registered for an agent in ${scopeLabel}.\n\n` +
              `Existing: ${existingLabel}\n` +
              `Agent ID: ${existingDup.id}\n\n` +
              `Edit or remove that agent instead of adding another with the same ID number.`
          );
          return;
        }

        let savedToFirestore = false;
        const idStr = isEdit ? String(existing.id) : getNextAgentDocumentId(agents);
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
          try {
            const forFs = { ...agent };
            delete forFs.__localPendingSync;
            await api.setAgentFs(forFs);
            savedToFirestore = true;
          } catch (fsErr) {
            console.warn("[Agents] Firestore write failed; row kept locally until sync succeeds", fsErr);
            agent.__localPendingSync = true;
            savedToFirestore = false;
          }
        } else {
          agent.__localPendingSync = true;
        }
        // Always reflect create/update in local UI (even if Firestore write failed, above).
        if (isEdit) {
          const ix = agents.findIndex((a) => String(a.id) === idStr);
          if (ix >= 0) agents[ix] = agent;
          else agents.push(agent);
        } else {
          agents.push(agent);
        }
        agents = dedupeAgentsById(agents);
        saveAgentsToStorage();
        // Close modal immediately after persistence — render/toast/notifications can throw; closing must not be skipped.
        closeModal();
        closedOnSuccess = true;
        const searchEl = document.getElementById("settingsAgentsSearch");
        if (searchEl) searchEl.value = "";
        try {
          renderAgentsTable();
        } catch (renderErr) {
          console.error("[Agents] renderAgentsTable after save", renderErr);
        }
        try {
          window.agentsCached = [...agents];
        } catch (_) {}
        try {
          document.dispatchEvent(new CustomEvent("agents-updated", { detail: { agents: [...agents] } }));
        } catch (evErr) {
          console.warn("[Agents] agents-updated dispatch", evErr);
        }
        const successMsg = isEdit
          ? `Updated agent "${name}" (National ID: ${nationalId}, agent ID: ${idStr})`
          : `Created agent "${name}" (National ID: ${nationalId}, agent ID: ${idStr})`;
        console.log(`[Agents] ${successMsg}${savedToFirestore ? "" : " — saved locally only"}`);
        try {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: savedToFirestore
                ? isEdit
                  ? "Agent updated successfully"
                  : "Agent created successfully"
                : isEdit
                  ? "Agent updated (local only)"
                  : "Agent created (local only)",
              meta: savedToFirestore
                ? `${name} — National ID: ${nationalId}. Agent ID: ${idStr}.`
                : `${name} — National ID: ${nationalId}. ${isEdit ? "Updated" : "Saved"} locally until Firebase sync works (check connection/permissions).`,
            });
          }
          if (typeof window.showAppToast === "function") {
            window.showAppToast({
              title: savedToFirestore
                ? isEdit
                  ? "Agent updated successfully"
                  : "Agent created successfully"
                : isEdit
                  ? "Agent updated (saved locally)"
                  : "Agent created (saved locally)",
              meta: savedToFirestore
                ? `${name} — National ID: ${nationalId} — Agent ID ${idStr}`
                : `${name} — National ID: ${nationalId}. Cloud sync unavailable; saved on this device only.`,
            });
          }
        } catch (uiErr) {
          console.warn("[Agents] notification/toast after save", uiErr);
        }
      } catch (err) {
        const code = err && err.code;
        let meta = err?.message || String(err);
        if (code === "permission-denied") {
          meta =
            "Firestore denied this write. Sign in, deploy firestore.rules, and check your connection.";
        }
        console.error("[Agents] save failed", code, err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not save agent",
            meta,
          });
        }
      } finally {
        saveBtn._agentSaveInFlight = false;
        if (!closedOnSuccess) resetSaveButton();
      }
    })();
  });

  openModal({
    title: isEdit ? "Update agent" : "Create agent",
    body,
    footer,
    dialogClass: "modal--wide",
  });

  if (viewer.isAdmin && !effectiveLockCandidate) {
    void refreshAgentModalCandidateScopeOptions(body, existing);
  }
}

export function openAgentModal(existing = null, options = {}) {
  try {
    openAgentModalCore(existing, options);
  } catch (err) {
    console.error("[Agents] openAgentModal failed", err);
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Could not open agent form",
        meta: err?.message || String(err),
      });
    }
  }
}

/**
 * Inline onclick from index.html — registered as soon as the module defines openAgentModal
 * (not at file end, so a later init error cannot leave this unset).
 */
window.__openCampaignAgentModal = function __openCampaignAgentModal(ev) {
  if (ev && typeof ev.preventDefault === "function") {
    ev.preventDefault();
    ev.stopPropagation();
  }
  openAgentModal(null, {});
};

/** Read-only details (R in CRUD). */
function openAgentViewModal(agent) {
  if (!agent || agent.id == null) return;
  const cid =
    agent.candidateId != null && String(agent.candidateId).trim() !== ""
      ? String(agent.candidateId).trim()
      : "";
  const scopeLabel = cid ? candidateLabelById(cid) : "All campaigns (visible to staff & all candidates)";

  const body = document.createElement("div");
  body.className = "form-grid form-grid--agent-modal agent-view-readonly";
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

  openModal({ title: "View agent", body, footer, dialogClass: "modal--wide" });
}

/** Same person may have multiple agent rows (per candidate). List other scopes and open per-scope voter list. */
function openOtherCandidateScopesModal(primaryAgent, duplicateAgents) {
  if (!primaryAgent || !Array.isArray(duplicateAgents) || duplicateAgents.length === 0) return;
  const body = document.createElement("div");
  body.className = "settings-other-scopes-modal";
  body.innerHTML = duplicateAgents
    .map((d) => {
      const cid = getAgentCandidateScopeId(d);
      const scope = cid ? candidateLabelById(cid) : "All campaigns (unscoped)";
      const aid = String(d.id ?? "");
      return `
      <div class="settings-other-scopes-modal__row" data-scope-agent-id="${escapeHtml(aid)}">
        <div class="settings-other-scopes-modal__row-head">
          <strong>${escapeHtml(scope)}</strong>
          <span class="text-muted"> · Agent ID <code>${escapeHtml(aid)}</code></span>
        </div>
        <div class="helper-text" style="margin: 4px 0 8px;">
          ${escapeHtml(d.nationalId || "—")} · ${escapeHtml(d.phone || "—")} · ${escapeHtml(d.island || "—")}
        </div>
        <button type="button" class="ghost-button ghost-button--small" data-open-voters-for-scope="${escapeHtml(aid)}">
          View assigned voters
        </button>
      </div>`;
    })
    .join("");

  body.querySelectorAll("[data-open-voters-for-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-open-voters-for-scope");
      const agent = agents.find((x) => String(x.id) === String(id));
      if (agent) openAgentAssignedVotersModal(agent);
    });
  });

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.justifyContent = "flex-end";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost-button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closeModal());
  footer.appendChild(closeBtn);

  openModal({
    title: `Other candidate scopes — ${primaryAgent.name || "Agent"}`,
    body,
    footer,
    dialogClass: "modal--wide",
  });
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
      const candidateIds = new Set(Array.from(meta.candidateIds, (cid) => String(cid)));
      const candidateScopes = Array.from(candidateIds)
        .map((cid) => candidateNameById.get(cid) || `Candidate ${cid}`)
        .filter(Boolean)
        .join(", ");
      return {
        voter: v,
        metaGlobal: Boolean(meta.global),
        candidateIds,
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
      const c = compareBallotSequence(a.voter?.sequence, b.voter?.sequence);
      if (c !== 0) return c;
      return String(a.voter?.fullName || "").localeCompare(String(b.voter?.fullName || ""), "en");
    });

  // Candidate-scoped agents: only voters assigned under that candidate (per-candidate maps),
  // not the global volunteer field alone.
  const agentScopedCandidateId = getAgentCandidateScopeId(agent);
  const assignedForDisplay = agentScopedCandidateId
    ? assigned.filter((x) => x.candidateIds.has(String(agentScopedCandidateId)))
    : assigned;

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
  const boxes = [...new Set(assignedForDisplay.map((x) => reportBallotBoxLabel(x.voter)).filter(Boolean))].sort();
  const hasGlobalAssignment = assignedForDisplay.some((x) => x.metaGlobal);
  const candidateScopeIdsForFilter = new Set();
  assignedForDisplay.forEach((x) => {
    x.candidateIds.forEach((cid) => candidateScopeIdsForFilter.add(String(cid)));
  });
  if (agentScopedCandidateId) candidateScopeIdsForFilter.add(String(agentScopedCandidateId));
  const candidateScopeFilterList = Array.from(candidateScopeIdsForFilter).sort((a, b) => {
    const la = candidateNameById.get(a) || a;
    const lb = candidateNameById.get(b) || b;
    return String(la).localeCompare(String(lb), "en");
  });
  toolbar.innerHTML = `
    <div class="list-toolbar__search">
      <label for="agentAssignedSearch" class="sr-only">Search</label>
      <input type="search" id="agentAssignedSearch" placeholder="Search by name, ID, address, phone, notes…" aria-label="Search assigned voters">
    </div>
    <div class="list-toolbar__controls">
      <div class="field-group field-group--inline">
        <label for="agentAssignedFilterScope">Candidate scope</label>
        <select id="agentAssignedFilterScope" aria-label="Filter by candidate scope">
          <option value="all">All</option>
          ${hasGlobalAssignment ? `<option value="global">Global (all campaign)</option>` : ""}
          ${candidateScopeFilterList
            .map((cid) => {
              const lab = candidateNameById.get(cid) || `Candidate ${cid}`;
              return `<option value="${escapeHtml(cid)}">${escapeHtml(lab)}</option>`;
            })
            .join("")}
        </select>
      </div>
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
  if (agentScopedCandidateId) {
    const scopeSel = toolbar.querySelector("#agentAssignedFilterScope");
    if (scopeSel && [...scopeSel.options].some((o) => o.value === String(agentScopedCandidateId))) {
      scopeSel.value = String(agentScopedCandidateId);
    }
  }

  const summary = document.createElement("p");
  summary.className = "helper-text";
  summary.style.margin = "0 0 8px";
  summary.textContent = "";
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
          return String(getEffectiveVotedAtForVoter(vb) || "").localeCompare(
            String(getEffectiveVotedAtForVoter(va) || ""),
            "en"
          );
        case "sequence":
        default: {
          const c = compareBallotSequence(va.sequence, vb.sequence);
          if (c !== 0) return c;
          return String(va.fullName || "").localeCompare(String(vb.fullName || ""), "en");
        }
      }
    });
    return rows;
  }

  function render() {
    const q = String(body.querySelector("#agentAssignedSearch")?.value || "").trim().toLowerCase();
    const filterScope = String(body.querySelector("#agentAssignedFilterScope")?.value || "all");
    const filterPledge = String(body.querySelector("#agentAssignedFilterPledge")?.value || "all");
    const filterBox = String(body.querySelector("#agentAssignedFilterBox")?.value || "all");
    const sortBy = String(body.querySelector("#agentAssignedSort")?.value || "sequence");

    let list = assignedForDisplay.filter((x) => {
      const v = x.voter || {};
      if (filterScope !== "all") {
        if (filterScope === "global") {
          if (!x.metaGlobal) return false;
        } else if (!x.candidateIds.has(filterScope)) {
          return false;
        }
      }
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
    const scopeNote = agentScopedCandidateId
      ? ` • Only voters assigned under ${candidateLabelById(agentScopedCandidateId)}`
      : "";
    summary.textContent = `Agent: ${agent.name || "—"}${scopeNote} • Showing ${list.length} of ${assignedForDisplay.length} assigned voters`;

    if (!list.length) {
      const emptyHint = agentScopedCandidateId && !assignedForDisplay.length && assigned.length
        ? "No voters are assigned to this agent under this candidate scope (global assignments are not counted for scoped agents)."
        : "No assigned voters match your filters.";
      tableWrap.innerHTML = `<p class="helper-text" style="padding: 12px 0;">${emptyHint}</p>`;
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
            <td>${escapeHtml(sequenceAsImportedFromCsv(v) || "—")}</td>
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
            <td class="voted-status-cell">${escapeHtml(getEffectiveVotedAtForVoter(v) || "—")}</td>
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
        sequenceAsImportedFromCsv(v),
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
        getEffectiveVotedAtForVoter(v) || "",
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
      const seqCmp = compareBallotSequence(va.sequence, vb.sequence);
      if (seqCmp !== 0) return seqCmp;
      return String(va.fullName || "").localeCompare(String(vb.fullName || ""), "en");
    });
    const rowsHtml = printRows
      .map((row) => {
        const v = row.voter || {};
        return `
          <tr>
            <td>${escapeHtml(sequenceAsImportedFromCsv(v))}</td>
            <td>${escapeHtml(v.fullName || "")}</td>
            <td>${escapeHtml(v.nationalId || v.id || "")}</td>
            <td>${escapeHtml(v.phone || "")}</td>
            <td>${escapeHtml(v.permanentAddress || "")}</td>
            <td>${escapeHtml(reportBallotBoxLabel(v))}</td>
            <td>${escapeHtml(v.pledgeStatus || "undecided")}</td>
            <td>${escapeHtml(getEffectiveVotedAtForVoter(v) || "")}</td>
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
  body.querySelector("#agentAssignedFilterScope")?.addEventListener("change", render);
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

/** Delete candidate (D in CRUD) — Firestore + local cache. */
async function deleteCandidateRecord(candidate) {
  if (!candidate || candidate.id == null) return;
  const id = String(candidate.id).trim();
  if (!id) return;
  try {
    const api = await firebaseInitPromise;
    const canDeleteRemote = Boolean(api.ready && typeof api.deleteCandidateFs === "function");
    if (!canDeleteRemote) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Cannot delete candidate",
          meta: "Firebase is not ready. Check your connection and try again.",
        });
      }
      return;
    }
    await api.deleteCandidateFs(id);
    candidates = candidates.filter((c) => String(c.id).trim() !== id);
    saveCandidatesToStorage();
    renderCandidatesTable();
    document.dispatchEvent(
      new CustomEvent("candidates-updated", {
        detail: { candidates: [...candidates] },
      })
    );
    if (window.appNotifications) {
      window.appNotifications.push({ title: "Candidate deleted", meta: candidate.name || id });
    }
  } catch (err) {
    const code = err && err.code;
    let meta = err?.message || String(err);
    if (code === "permission-denied") {
      meta =
        "Firestore blocked this delete. Deploy the latest firestore.rules (e.g. firebase deploy --only firestore:rules).";
    }
    console.error("[Candidates] delete failed", code, err);
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Could not delete candidate",
        meta,
      });
    }
  }
}

/** Alias for modules that only add new agents (e.g. Door to door, candidate voter view). */
export function openAddAgentModal(options) {
  openAgentModal(null, options || {});
}

function bindSettingsAgentRowMoreMenus(tbody) {
  if (!tbody) return;

  function closeAllAgentMenus(exceptMenu) {
    tbody.querySelectorAll("[data-settings-agent-more-menu]").forEach((m) => {
      if (m !== exceptMenu) {
        m.hidden = true;
        const toggle = m.closest(".settings-agent-row-menu")?.querySelector(".settings-agent-row-menu__toggle");
        if (toggle) toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  tbody.querySelectorAll(".settings-agent-row-menu").forEach((wrap) => {
    const btn = wrap.querySelector(".settings-agent-row-menu__toggle");
    const menu = wrap.querySelector("[data-settings-agent-more-menu]");
    if (!btn || !menu || wrap.dataset.settingsAgentMoreBound) return;
    wrap.dataset.settingsAgentMoreBound = "1";

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      closeAllAgentMenus(menu);
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) {
        requestAnimationFrame(() => {
          document.addEventListener("click", onDoc);
        });
      }
    });

    function onDoc(ev) {
      if (wrap.contains(ev.target)) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDoc);
    }
  });

  tbody.querySelectorAll("[data-other-scopes]").forEach((btn) => {
    if (btn.dataset.settingsOtherScopesBound) return;
    btn.dataset.settingsOtherScopesBound = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-other-scopes");
      const wrap = btn.closest(".settings-agent-row-menu");
      const menu = wrap?.querySelector("[data-settings-agent-more-menu]");
      const toggle = wrap?.querySelector(".settings-agent-row-menu__toggle");
      if (menu) menu.hidden = true;
      if (toggle) toggle.setAttribute("aria-expanded", "false");
      const primary = agents.find((x) => String(x.id) === String(id));
      const dups = settingsAgentDuplicateAgentsByPrimaryId.get(String(id)) || [];
      if (primary && dups.length) openOtherCandidateScopesModal(primary, dups);
    });
  });
}

function renderAgentsTable() {
  const tbody = document.querySelector("#settingsAgentsTable tbody");
  if (!tbody) return;

  ensureAgentsCandidateFilterOptions();
  initAgentsToolbarListeners();

  const viewer = parseViewerFromStorage();
  const showEdit = viewer.isAdmin;
  const votersList = getVotersForAgentModalSearch();

  settingsAgentDuplicateAgentsByPrimaryId = new Map();
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

  function appendAgentRow(a, duplicateAgents) {
    const dups = Array.isArray(duplicateAgents) ? duplicateAgents : [];
    if (dups.length) {
      settingsAgentDuplicateAgentsByPrimaryId.set(String(a.id), dups);
    }
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
    const moreMenu =
      dups.length > 0
        ? `<div class="dropdown-wrap settings-agent-row-menu" style="display:inline-block;vertical-align:middle;margin-left:4px;">
  <button type="button" class="ghost-button ghost-button--small table-view-menu-btn settings-agent-row-menu__toggle" aria-label="More actions" aria-haspopup="true" aria-expanded="false" title="Other candidate scopes">⋮</button>
  <div class="dropdown-menu" data-settings-agent-more-menu hidden role="menu" aria-label="More">
    <button type="button" class="dropdown-menu__item" role="menuitem" data-other-scopes="${escapeHtml(aid)}">Other candidate scopes…</button>
  </div>
</div>`
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
          ${moreMenu}
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
    appendAgentRow(item.agent, item.duplicateAgents);
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

  bindSettingsAgentRowMoreMenus(tbody);

  updateAgentsSortIndicators();
}

function openCandidateForm(existing) {
  const isEdit = !!existing;
  const config = getEffectiveCampaignConfig();
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

  switchSettingsTabFn = switchToTab;

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      switchToTab(btn.getAttribute("data-settings-tab"));
    });
  });

  applySettingsTabsVisibility();
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

function initCampaignArchiveUI() {
  const card = document.getElementById("settingsCampaignArchiveCard");
  const openBtn = document.getElementById("settingsCampaignArchiveOpen");
  const tbody = document.getElementById("settingsCampaignArchiveTableBody");
  const table = document.getElementById("settingsCampaignArchiveTable");
  const emptyEl = document.getElementById("settingsCampaignArchiveListEmpty");
  const viewer = parseViewerFromStorage();
  if (!card || !openBtn || !tbody || !table || !emptyEl) return;
  if (!viewer.isAdmin) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const refreshArchiveList = async () => {
    tbody.innerHTML = "";
    try {
      const api = await firebaseInitPromise;
      if (!api.ready || !api.listCampaignArchivesFs) {
        emptyEl.textContent = "Could not load archives.";
        emptyEl.hidden = false;
        table.hidden = true;
        return;
      }
      const rows = await api.listCampaignArchivesFs();
      if (!rows.length) {
        emptyEl.textContent = "No archives yet.";
        emptyEl.hidden = false;
        table.hidden = true;
        return;
      }
      emptyEl.hidden = true;
      table.hidden = false;
      rows.forEach((r) => {
        const tr = document.createElement("tr");
        const stats = r.stats || {};
        const when = r.archivedAt ? String(r.archivedAt).replace("T", " ").slice(0, 19) : "—";
        tr.innerHTML = `
          <td class="data-table-col--name">${escapeHtml(String(r.label || r.campaignNameSnapshot || "—"))}</td>
          <td>${escapeHtml(when)}</td>
          <td>${escapeHtml(String(stats.voters != null ? stats.voters : "—"))}</td>
          <td style="text-align:right; white-space:nowrap;">
            <button type="button" class="ghost-button ghost-button--small" data-archive-view-full="${escapeHtml(String(r.id))}">View archive</button>
            <button type="button" class="ghost-button ghost-button--small" data-archive-download-voters-csv="${escapeHtml(String(r.id))}" data-archive-label="${escapeHtml(String(r.label || r.campaignNameSnapshot || ""))}" title="Same columns as Bulk Voter Upload (Settings → Data)">Download voters CSV</button>
            <button type="button" class="ghost-button ghost-button--small" data-archive-delete="${escapeHtml(String(r.id))}">Delete</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      emptyEl.textContent = "Could not load archives.";
      emptyEl.hidden = false;
      table.hidden = true;
      console.warn("listCampaignArchivesFs", e);
    }
  };

  const openFullArchiveViewerModal = async (archiveId, displayLabel) => {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getArchivedArchiveRootFs || !api.getArchivedSegmentFs) return;

    const titleBase = displayLabel ? `Archive — ${displayLabel}` : "Archived campaign";
    const cache = { root: null, loaded: {} };

    const formatCellVal = (val) => {
      if (val == null) return "";
      if (Array.isArray(val)) {
        if (!val.length) return "—";
        if (val.length <= 3 && val.every((x) => typeof x !== "object")) return val.join(", ");
        return `${val.length} items`;
      }
      if (typeof val === "object") {
        try {
          return JSON.stringify(val);
        } catch (_) {
          return String(val);
        }
      }
      return String(val);
    };

    const buildColumns = (rows, preferred, maxCols = 10) => {
      if (!rows.length) return preferred.slice(0, maxCols);
      const have = new Set();
      rows.slice(0, 50).forEach((r) => {
        Object.keys(r || {}).forEach((k) => have.add(k));
      });
      const out = [];
      preferred.forEach((k) => {
        if (have.has(k) && out.length < maxCols) out.push(k);
      });
      const first = rows[0];
      if (first) {
        Object.keys(first).forEach((k) => {
          if (out.length >= maxCols) return;
          if (!out.includes(k)) out.push(k);
        });
      }
      return out.slice(0, maxCols);
    };

    const archivedVoterImageSrc = (row) => {
      const u = row.photoUrl || row.photoURL || row.imageUrl;
      if (u && /^https?:\/\//i.test(String(u).trim())) return String(u).trim();
      return getVoterImageSrc(row);
    };

    const formatArchivedPledgeSummary = (voter) => {
      const cp = voter?.candidatePledges;
      if (cp && typeof cp === "object" && !Array.isArray(cp)) {
        const parts = Object.entries(cp)
          .filter(([, v]) => v === "yes" || v === "no" || v === "undecided")
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
          .map(([k, v]) => `${k}: ${v}`);
        if (parts.length) return parts.join(" · ");
      }
      const ps = voter?.pledgeStatus;
      if (ps === "yes") return "Yes";
      if (ps === "no") return "No";
      if (ps === "undecided") return "Undecided";
      return "—";
    };

    const archivedVoterVotedDisplay = (voter) => {
      const raw = voter?.votedAt || voter?.votedTimeMarked;
      if (raw == null || raw === "") return "—";
      const s = String(raw).trim();
      if (s.length >= 19 && s.includes("T")) return s.slice(0, 19).replace("T", " ");
      return s;
    };

    const archivedVoterHasVoted = (voter) => {
      const raw = voter?.votedAt || voter?.votedTimeMarked;
      if (raw == null) return false;
      return String(raw).trim() !== "";
    };

    const ARCHIVE_VOTERS_PAGE_SIZE = 15;

    const renderArchivedVotersTable = (panelEl, rows) => {
      panelEl.textContent = "";
      if (!rows.length) {
        panelEl.innerHTML = `<p class="text-muted">No rows in this snapshot.</p>`;
        return;
      }

      const bulkCsvBar = document.createElement("div");
      bulkCsvBar.className = "archive-viewer__bulk-csv-actions";
      const bulkCsvBtn = document.createElement("button");
      bulkCsvBtn.type = "button";
      bulkCsvBtn.className = "ghost-button ghost-button--small";
      bulkCsvBtn.textContent = "Download voters CSV (bulk upload template)";
      bulkCsvBtn.title =
        "Same columns as Settings → Data → Bulk Voter Upload (Sequence, Ballot Box, ID Number, Name, …)";
      bulkCsvBtn.addEventListener("click", () => {
        const csv = buildBulkVoterUploadTemplateCsv(rows);
        const name = sanitizeFilenameSegment(displayLabel || "archive");
        triggerDownloadCsv(`voters-archive-${name}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "CSV downloaded",
            meta: `${rows.length} row(s) — bulk upload template.`,
          });
        }
      });
      bulkCsvBar.appendChild(bulkCsvBtn);
      panelEl.appendChild(bulkCsvBar);

      const voterColSkip = new Set([
        "name",
        "nationalId",
        "ballotBox",
        "ballotSequence",
        "permanentAddress",
        "candidatePledges",
        "pledgeStatus",
        "votedAt",
        "votedTimeMarked",
        "photoUrl",
        "photoURL",
        "imageUrl",
      ]);
      const restCols = buildColumns(rows, ["phone", "island", "referendumVote"], 8).filter((c) => !voterColSkip.has(c));
      const headerLabels = [
        "Image",
        "Name",
        "National ID",
        "Ballot box",
        "Seq.",
        "Pledge",
        "Voted",
        "Address",
        ...restCols.map((c) => c),
      ];
      const colCount = headerLabels.length;

      const voterNameForSort = (v) => String(v.fullName || v.name || "").trim();
      const sequenceForArchivedRow = (r) => {
        if (r == null) return "";
        if (r.sequence != null && r.sequence !== "") return r.sequence;
        if (r.ballotSequence != null && r.ballotSequence !== "") return r.ballotSequence;
        return "";
      };

      const archivedPledgeForFilter = (v) => {
        const p = v?.pledgeStatus;
        if (p === "yes" || p === "no" || p === "undecided") return p;
        return "undecided";
      };

      const compareArchivedByBallotSequenceThenName = (a, b) => {
        const c = compareBallotSequence(sequenceForArchivedRow(a), sequenceForArchivedRow(b));
        if (c !== 0) return c;
        return voterNameForSort(a).localeCompare(voterNameForSort(b), "en");
      };

      const compareArchivedByBallotBoxThenSequenceThenName = (a, b) => {
        const boxA = String(a?.ballotBox || "Unassigned").trim();
        const boxB = String(b?.ballotBox || "Unassigned").trim();
        const boxCmp = boxA.localeCompare(boxB, "en");
        if (boxCmp !== 0) return boxCmp;
        return compareArchivedByBallotSequenceThenName(a, b);
      };

      const uid = `arc-vt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

      const toolbar = document.createElement("div");
      toolbar.className = "voters-toolbar list-toolbar archive-viewer__voters-toolbar";
      toolbar.innerHTML = `
        <div class="list-toolbar__search">
          <label for="${uid}-search" class="sr-only">Search voters</label>
          <input type="search" id="${uid}-search" class="input" data-archive-voter-search placeholder="Search by name, ID, address, island, notes…" autocomplete="off">
        </div>
        <div class="list-toolbar__controls">
          <div class="field-group field-group--inline">
            <label for="${uid}-pledge">Filter</label>
            <select id="${uid}-pledge" data-archive-voter-filter-pledge>
              <option value="all">All pledge statuses</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
              <option value="undecided">Undecided</option>
            </select>
          </div>
          <div class="field-group field-group--inline">
            <label for="${uid}-voted">Voted</label>
            <select id="${uid}-voted" data-archive-voter-filter-voted>
              <option value="all">All</option>
              <option value="yes">Voted</option>
              <option value="no">Not voted</option>
            </select>
          </div>
          <div class="field-group field-group--inline">
            <label for="${uid}-sort">Sort</label>
            <select id="${uid}-sort" data-archive-voter-sort>
              <option value="sequence">Seq (ballot box order)</option>
              <option value="name-asc">Name A–Z</option>
              <option value="name-desc">Name Z–A</option>
              <option value="id">ID Number</option>
              <option value="address">Permanent address</option>
              <option value="pledge">Pledge status</option>
              <option value="island">Ballot box</option>
              <option value="voted">Voted (time)</option>
            </select>
          </div>
          <div class="field-group field-group--inline">
            <label for="${uid}-group">Group by</label>
            <select id="${uid}-group" data-archive-voter-group-by>
              <option value="none">None</option>
              <option value="island">Ballot box</option>
              <option value="pledge">Pledge status</option>
            </select>
          </div>
        </div>
      `;

      const searchEl = toolbar.querySelector("[data-archive-voter-search]");
      const filterPledgeEl = toolbar.querySelector("[data-archive-voter-filter-pledge]");
      const filterVotedEl = toolbar.querySelector("[data-archive-voter-filter-voted]");
      const sortEl = toolbar.querySelector("[data-archive-voter-sort]");
      const groupByEl = toolbar.querySelector("[data-archive-voter-group-by]");

      restCols.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = `rest:${c}`;
        opt.textContent = `Column: ${c}`;
        sortEl.appendChild(opt);
      });

      const wrap = document.createElement("div");
      wrap.className = "table-wrap archive-viewer__table-wrap";
      const tbl = document.createElement("table");
      tbl.className = "data-table data-table--archive-view";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      const sortKeyForLabel = (label, idx) => {
        if (idx === 0) return null;
        if (label === "Name") return "name";
        if (label === "National ID") return "id";
        if (label === "Ballot box") return "island";
        if (label === "Seq.") return "sequence";
        if (label === "Pledge") return "pledge";
        if (label === "Voted") return "voted";
        if (label === "Address") return "address";
        const rc = restCols[idx - 8];
        return rc != null ? `rest:${rc}` : null;
      };
      headerLabels.forEach((label, idx) => {
        const th = document.createElement("th");
        th.scope = "col";
        const sk = sortKeyForLabel(label, idx);
        if (sk) {
          th.className = "th-sortable";
          th.setAttribute("data-sort-key", sk);
          th.appendChild(document.createTextNode(label));
          const ind = document.createElement("span");
          ind.className = "sort-indicator";
          th.appendChild(ind);
        } else {
          th.textContent = label;
        }
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      const tb = document.createElement("tbody");
      tbl.appendChild(head);
      tbl.appendChild(tb);
      wrap.appendChild(tbl);

      const paginationEl = document.createElement("div");
      paginationEl.className = "pagination-bar";

      const hint = document.createElement("p");
      hint.className = "helper-text archive-viewer__count";

      panelEl.appendChild(toolbar);
      panelEl.appendChild(wrap);
      panelEl.appendChild(paginationEl);
      panelEl.appendChild(hint);

      let currentPage = 1;

      const appendArchivedVoterRow = (row) => {
        const tr = document.createElement("tr");
        const tdImg = document.createElement("td");
        tdImg.className = "archive-viewer__img-cell";
        const src = archivedVoterImageSrc(row);
        if (src) {
          const img = document.createElement("img");
          img.className = "archive-viewer__voter-thumb";
          img.src = src;
          img.alt = "";
          img.loading = "lazy";
          let fallbackStep = 0;
          img.addEventListener("error", () => {
            const base = archivedVoterImageSrc(row);
            fallbackStep += 1;
            if (
              fallbackStep === 1 &&
              !/^https?:\/\//i.test(base) &&
              /\.(jpe?g)$/i.test(base)
            ) {
              img.src = base.replace(/\.(jpe?g)$/i, ".png");
              return;
            }
            img.replaceWith(document.createTextNode("—"));
          });
          tdImg.appendChild(img);
        } else {
          tdImg.textContent = "—";
        }
        tr.appendChild(tdImg);
        const nameTd = document.createElement("td");
        nameTd.textContent =
          row.name != null && String(row.name).trim() !== ""
            ? String(row.name)
            : String(row.fullName || "").trim();
        tr.appendChild(nameTd);
        ["nationalId", "ballotBox"].forEach((c) => {
          const td = document.createElement("td");
          td.textContent = row[c] != null ? String(row[c]) : "";
          tr.appendChild(td);
        });
        const tdSeq = document.createElement("td");
        tdSeq.textContent =
          row.ballotSequence != null && String(row.ballotSequence) !== ""
            ? String(row.ballotSequence)
            : row.sequence != null
              ? String(row.sequence)
              : "";
        tr.appendChild(tdSeq);
        const tdPledge = document.createElement("td");
        tdPledge.className = "archive-viewer__pledge-cell";
        tdPledge.textContent = formatArchivedPledgeSummary(row);
        tr.appendChild(tdPledge);
        const tdVoted = document.createElement("td");
        tdVoted.className = "archive-viewer__voted-cell";
        tdVoted.textContent = archivedVoterVotedDisplay(row);
        tr.appendChild(tdVoted);
        const tdAddr = document.createElement("td");
        tdAddr.textContent = row.permanentAddress != null ? String(row.permanentAddress) : "";
        tr.appendChild(tdAddr);
        restCols.forEach((c) => {
          const td = document.createElement("td");
          td.textContent = formatCellVal(row[c]);
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      };

      const updateArchiveSortIndicators = () => {
        const sortBy = sortEl?.value || "sequence";
        head.querySelectorAll("th.th-sortable").forEach((th) => {
          const key = th.getAttribute("data-sort-key");
          th.classList.remove("is-sorted-asc", "is-sorted-desc");
          th.removeAttribute("aria-sort");
          if (!key) return;
          if (key === "name" && (sortBy === "name-asc" || sortBy === "name-desc")) {
            th.classList.add(sortBy === "name-asc" ? "is-sorted-asc" : "is-sorted-desc");
            th.setAttribute("aria-sort", sortBy === "name-asc" ? "ascending" : "descending");
          } else if (sortBy === key) {
            th.classList.add("is-sorted-asc");
            th.setAttribute("aria-sort", "ascending");
          }
        });
      };

      head.addEventListener("click", (e) => {
        const th = e.target.closest("th.th-sortable");
        if (!th) return;
        const key = th.getAttribute("data-sort-key");
        if (!key) return;
        if (key === "name") {
          sortEl.value = sortEl.value === "name-asc" ? "name-desc" : "name-asc";
        } else {
          sortEl.value = key;
        }
        currentPage = 1;
        renderTableBody();
      });

      const getFilteredSortedGrouped = () => {
        const query = (searchEl?.value || "").toLowerCase().trim();
        const pledgeFilter = filterPledgeEl?.value || "all";
        const votedFilter = filterVotedEl?.value || "all";
        const sortBy = sortEl?.value || "sequence";
        const groupBy = groupByEl?.value || "none";

        let list = rows.filter((voter) => {
          if (pledgeFilter !== "all" && archivedPledgeForFilter(voter) !== pledgeFilter) return false;
          if (votedFilter === "yes" && !archivedVoterHasVoted(voter)) return false;
          if (votedFilter === "no" && archivedVoterHasVoted(voter)) return false;
          if (query) {
            const name = voterNameForSort(voter).toLowerCase();
            const id = String(voter.id || "").toLowerCase();
            const nationalId = String(voter.nationalId || "").toLowerCase();
            const phone = String(voter.phone || "").toLowerCase();
            const address = String(voter.permanentAddress || "").toLowerCase();
            const island = String(voter.island || "").toLowerCase();
            const notes = String(voter.notes || "").toLowerCase();
            const seq = String(sequenceForArchivedRow(voter) || "").toLowerCase();
            const votedDisp = String(archivedVoterVotedDisplay(voter) || "").toLowerCase();
            if (
              !name.includes(query) &&
              !id.includes(query) &&
              !nationalId.includes(query) &&
              !phone.includes(query) &&
              !address.includes(query) &&
              !island.includes(query) &&
              !notes.includes(query) &&
              !seq.includes(query) &&
              !(votedDisp !== "—" && votedDisp.includes(query))
            )
              return false;
          }
          return true;
        });

        const cmp = (a, b) => {
          switch (sortBy) {
            case "name-asc":
              return voterNameForSort(a).localeCompare(voterNameForSort(b), "en");
            case "name-desc":
              return voterNameForSort(b).localeCompare(voterNameForSort(a), "en");
            case "sequence":
              return compareArchivedByBallotSequenceThenName(a, b);
            case "island":
              return compareArchivedByBallotBoxThenSequenceThenName(a, b);
            case "pledge":
              return archivedPledgeForFilter(a).localeCompare(archivedPledgeForFilter(b), "en");
            case "address":
              return String(a.permanentAddress || "").localeCompare(String(b.permanentAddress || ""), "en");
            case "id":
              return String(a.nationalId || "").localeCompare(String(b.nationalId || ""), "en");
            case "voted": {
              const ta = String(a.votedAt || a.votedTimeMarked || "").trim();
              const tb = String(b.votedAt || b.votedTimeMarked || "").trim();
              if (!ta && !tb) return 0;
              if (!ta) return 1;
              if (!tb) return -1;
              return ta.localeCompare(tb);
            }
            default: {
              if (sortBy && String(sortBy).startsWith("rest:")) {
                const f = String(sortBy).slice(5);
                return String(a[f] ?? "").localeCompare(String(b[f] ?? ""), "en");
              }
              return voterNameForSort(a).localeCompare(voterNameForSort(b), "en");
            }
          }
        };
        list = list.slice().sort(cmp);

        if (groupBy === "island") {
          list.sort(compareArchivedByBallotBoxThenSequenceThenName);
        }

        if (groupBy === "none") {
          return list.map((voter) => ({ type: "row", voter }));
        }

        const getGroupKey = (v) => {
          if (groupBy === "island") return String(v.ballotBox || "Unassigned").trim() || "Unassigned";
          if (groupBy === "pledge") {
            const p = archivedPledgeForFilter(v);
            if (p === "yes") return "Yes";
            if (p === "no") return "No";
            return "Undecided";
          }
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
      };

      const renderTableBody = () => {
        const displayList = getFilteredSortedGrouped();
        const dataRows = displayList.filter((x) => x.type === "row");
        const total = dataRows.length;
        const totalPages = Math.max(1, Math.ceil(total / ARCHIVE_VOTERS_PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        const start = (currentPage - 1) * ARCHIVE_VOTERS_PAGE_SIZE;
        const pageDataRows = dataRows.slice(start, start + ARCHIVE_VOTERS_PAGE_SIZE);

        const pageDisplayList = [];
        let lastGroup = null;
        for (const rowItem of pageDataRows) {
          const idxInDisplay = displayList.indexOf(rowItem);
          const groupItem =
            idxInDisplay > 0 && displayList[idxInDisplay - 1]?.type === "group"
              ? displayList[idxInDisplay - 1]
              : null;
          if (groupItem && groupItem !== lastGroup) {
            pageDisplayList.push(groupItem);
            lastGroup = groupItem;
          }
          pageDisplayList.push(rowItem);
        }

        tb.textContent = "";
        if (total === 0) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td colspan="${colCount}" class="text-muted" style="text-align:center;padding:24px;">No voters match the current filters.</td>`;
          tb.appendChild(tr);
        } else {
          for (const item of pageDisplayList) {
            if (item.type === "group") {
              const tr = document.createElement("tr");
              tr.className = "list-toolbar__group-header";
              const td = document.createElement("td");
              td.colSpan = colCount;
              td.textContent = item.label;
              tr.appendChild(td);
              tb.appendChild(tr);
              continue;
            }
            appendArchivedVoterRow(item.voter);
          }
        }

        const from = total === 0 ? 0 : start + 1;
        const to = Math.min(start + ARCHIVE_VOTERS_PAGE_SIZE, total);
        paginationEl.innerHTML = `
          <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
          <div class="pagination-bar__nav">
            <button type="button" class="pagination-bar__btn" data-archive-voter-page="prev" ${currentPage <= 1 ? "disabled" : ""}>Previous</button>
            <span class="pagination-bar__summary">Page ${currentPage} of ${totalPages}</span>
            <button type="button" class="pagination-bar__btn" data-archive-voter-page="next" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
          </div>
        `;
        paginationEl.querySelectorAll("[data-archive-voter-page]").forEach((btn) => {
          btn.addEventListener("click", () => {
            if (btn.dataset.archiveVoterPage === "prev" && currentPage > 1) currentPage--;
            if (btn.dataset.archiveVoterPage === "next" && currentPage < totalPages) currentPage++;
            renderTableBody();
          });
        });

        const totalInSnapshot = rows.length;
        hint.textContent =
          total === totalInSnapshot
            ? `${total} voter${total === 1 ? "" : "s"} (read-only snapshot).`
            : `${total} of ${totalInSnapshot} voter${totalInSnapshot === 1 ? "" : "s"} match filters (read-only snapshot).`;

        updateArchiveSortIndicators();
      };

      const scheduleRender = () => {
        currentPage = 1;
        renderTableBody();
      };

      searchEl.addEventListener("input", scheduleRender);
      filterPledgeEl.addEventListener("change", scheduleRender);
      filterVotedEl.addEventListener("change", scheduleRender);
      sortEl.addEventListener("change", scheduleRender);
      groupByEl.addEventListener("change", scheduleRender);

      renderTableBody();
    };

    const renderTable = (panelEl, rows, preferredCols) => {
      panelEl.textContent = "";
      if (!rows.length) {
        panelEl.innerHTML = `<p class="text-muted">No rows in this snapshot.</p>`;
        return;
      }
      const cols = buildColumns(rows, preferredCols);
      const sortState = { key: cols[0], dir: "asc" };

      const cellSortVal = (row, col) => {
        const v = row[col];
        if (v == null) return "";
        if (typeof v === "number" && !Number.isNaN(v)) return v;
        if (typeof v === "boolean") return v ? 1 : 0;
        const s = formatCellVal(v);
        const n = Number(s);
        if (s !== "" && !Number.isNaN(n) && String(n) === s.trim()) return n;
        return s;
      };

      const compareRows = (a, b) => {
        const k = sortState.key;
        const va = cellSortVal(a, k);
        const vb = cellSortVal(b, k);
        const mul = sortState.dir === "asc" ? 1 : -1;
        if (typeof va === "number" && typeof vb === "number") {
          const t = va - vb;
          return t === 0 ? 0 : t * mul;
        }
        return String(va).localeCompare(String(vb), "en", { numeric: true }) * mul;
      };

      const wrap = document.createElement("div");
      wrap.className = "table-wrap archive-viewer__table-wrap";
      const tbl = document.createElement("table");
      tbl.className = "data-table data-table--archive-view";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      cols.forEach((c) => {
        const th = document.createElement("th");
        th.scope = "col";
        th.className = "th-sortable";
        th.setAttribute("data-sort-key", c);
        th.appendChild(document.createTextNode(c));
        const ind = document.createElement("span");
        ind.className = "sort-indicator";
        th.appendChild(ind);
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      const tb = document.createElement("tbody");

      const updateGenericSortIndicators = () => {
        head.querySelectorAll("th.th-sortable").forEach((th) => {
          const key = th.getAttribute("data-sort-key");
          th.classList.remove("is-sorted-asc", "is-sorted-desc");
          th.removeAttribute("aria-sort");
          if (key === sortState.key) {
            th.classList.add(sortState.dir === "asc" ? "is-sorted-asc" : "is-sorted-desc");
            th.setAttribute("aria-sort", sortState.dir === "asc" ? "ascending" : "descending");
          }
        });
      };

      const renderBody = () => {
        const sorted = rows.slice().sort(compareRows);
        tb.textContent = "";
        sorted.forEach((row) => {
          const tr = document.createElement("tr");
          tr.innerHTML = cols.map((c) => `<td>${escapeHtml(formatCellVal(row[c]))}</td>`).join("");
          tb.appendChild(tr);
        });
        updateGenericSortIndicators();
      };

      head.addEventListener("click", (e) => {
        const th = e.target.closest("th.th-sortable");
        if (!th) return;
        const key = th.getAttribute("data-sort-key");
        if (!key) return;
        if (sortState.key === key) {
          sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        } else {
          sortState.key = key;
          sortState.dir = "asc";
        }
        renderBody();
      });

      renderBody();
      tbl.appendChild(head);
      tbl.appendChild(tb);
      wrap.appendChild(tbl);
      const hint = document.createElement("p");
      hint.className = "helper-text archive-viewer__count";
      hint.textContent = `${rows.length} row${rows.length === 1 ? "" : "s"} (read-only). Click a column header to sort.`;
      panelEl.appendChild(wrap);
      panelEl.appendChild(hint);
    };

    const body = document.createElement("div");
    body.className = "archive-viewer";

    const tabsRow = document.createElement("div");
    tabsRow.className = "archive-viewer__tabs";
    tabsRow.setAttribute("role", "tablist");
    tabsRow.setAttribute("aria-label", "Archive sections");

    const panels = document.createElement("div");
    panels.className = "archive-viewer__panels";

    const tabDefs = [
      { key: "overview", label: "Overview" },
      { key: "voters", label: "Voters", segment: "voters" },
      { key: "agents", label: "Agents", segment: "agents", cols: ["name", "nationalId", "candidateId", "mobile", "email"] },
      { key: "candidates", label: "Candidates", segment: "candidates", cols: ["name", "id", "party", "constituency"] },
      { key: "events", label: "Events", segment: "events", cols: ["title", "name", "id", "startDate", "date", "location"] },
      { key: "trips", label: "Transport trips", segment: "transportTrips", cols: ["route", "tripType", "status", "pickupTime", "vehicle", "id"] },
      { key: "routes", label: "Transport routes", segment: "transportRoutes", cols: ["routeNum", "status", "vehicle", "driver", "id"] },
      { key: "lists", label: "Voter lists", segment: "voterLists", cols: ["name", "id", "voterIds", "shareToken"] },
      { key: "monitors", label: "Ballot monitors", monitors: true, cols: ["name", "ballotBox", "shareToken", "mobile", "voterIds"] },
    ];

    const panelByKey = {};
    tabDefs.forEach((def) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "archive-viewer__tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", def.key === "overview" ? "true" : "false");
      btn.dataset.archiveTab = def.key;
      btn.textContent = def.label;
      tabsRow.appendChild(btn);

      const panel = document.createElement("div");
      panel.className = "archive-viewer__panel";
      panel.hidden = def.key !== "overview";
      panel.dataset.archivePanel = def.key;
      panel.setAttribute("role", "tabpanel");
      if (def.key === "overview") {
        panel.innerHTML = `<p class="text-muted">Loading overview…</p>`;
      } else {
        panel.innerHTML = `<p class="text-muted">Open this tab to load data.</p>`;
      }
      panels.appendChild(panel);
      panelByKey[def.key] = { def, panel, btn };
    });

    body.appendChild(tabsRow);
    body.appendChild(panels);

    const setActiveTab = (key) => {
      tabDefs.forEach((d) => {
        const { btn, panel } = panelByKey[d.key];
        const on = d.key === key;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
        panel.hidden = !on;
      });
    };

    const loadTab = async (key) => {
      const entry = panelByKey[key];
      if (!entry) return;
      const { def, panel } = entry;
      if (def.key === "overview") {
        if (cache.loaded.overview) return;
        cache.loaded.overview = true;
        panel.textContent = "";
        const root = await api.getArchivedArchiveRootFs(archiveId);
        cache.root = root;
        if (!root) {
          panel.innerHTML = `<p class="text-muted">Could not load archive metadata.</p>`;
          return;
        }
        const stats = root.stats || {};
        const dl = document.createElement("dl");
        dl.className = "archive-viewer__meta";
        const addRow = (k, v) => {
          const dt = document.createElement("dt");
          dt.textContent = k;
          const dd = document.createElement("dd");
          dd.textContent = v;
          dl.appendChild(dt);
          dl.appendChild(dd);
        };
        addRow("Label", String(root.label || "—"));
        addRow("Archived at", String(root.archivedAt || "—"));
        addRow("Campaign name (snapshot)", String(root.campaignNameSnapshot || "—"));
        addRow("Voters", String(stats.voters != null ? stats.voters : "—"));
        addRow("Agents", String(stats.agents != null ? stats.agents : "—"));
        addRow("Candidates", String(stats.candidates != null ? stats.candidates : "—"));
        addRow("Events", String(stats.events != null ? stats.events : "—"));
        addRow("Transport trips", String(stats.transportTrips != null ? stats.transportTrips : "—"));
        addRow("Transport routes", String(stats.transportRoutes != null ? stats.transportRoutes : "—"));
        addRow("Voter lists", String(stats.voterLists != null ? stats.voterLists : "—"));
        addRow("Monitor tokens", String(stats.monitorTokens != null ? stats.monitorTokens : "—"));
        panel.appendChild(dl);
        const cfg = root.configSnapshot;
        if (cfg && typeof cfg === "object") {
          const h = document.createElement("h4");
          h.className = "archive-viewer__json-title";
          h.textContent = "Campaign config snapshot";
          panel.appendChild(h);
          const pre = document.createElement("pre");
          pre.className = "archive-viewer__json";
          try {
            pre.textContent = JSON.stringify(cfg, null, 2);
          } catch (_) {
            pre.textContent = String(cfg);
          }
          panel.appendChild(pre);
        }
        const note = document.createElement("p");
        note.className = "helper-text";
        note.textContent =
          "This is a frozen snapshot. Use the tabs above to browse voters, lists, transport, and monitors as stored at archive time.";
        panel.appendChild(note);
        return;
      }

      if (cache.loaded[key]) return;
      panel.innerHTML = `<p class="text-muted">Loading…</p>`;
      try {
        let rows;
        if (def.monitors && api.getArchivedMonitorsFs) {
          rows = await api.getArchivedMonitorsFs(archiveId);
        } else if (def.segment) {
          rows = await api.getArchivedSegmentFs(archiveId, def.segment);
        } else {
          rows = [];
        }
        if (def.key === "voters") {
          renderArchivedVotersTable(panel, rows);
        } else {
          renderTable(panel, rows, def.cols || []);
        }
        cache.loaded[key] = true;
      } catch (err) {
        panel.innerHTML = `<p class="text-muted">Could not load this section.</p>`;
        console.warn("archive viewer tab", key, err);
      }
    };

    tabsRow.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-archive-tab]");
      if (!btn) return;
      const key = btn.getAttribute("data-archive-tab");
      if (!key) return;
      setActiveTab(key);
      void loadTab(key);
    });

    tabDefs.forEach((d) => {
      const btn = panelByKey[d.key].btn;
      btn.setAttribute("data-archive-tab", d.key);
    });

    const footer = document.createElement("div");
    footer.className = "form-actions";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "primary-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => closeModal());
    footer.appendChild(closeBtn);

    openModal({
      title: titleBase,
      body,
      footer,
      dialogClass: "modal--wide",
      startMaximized: true,
    });

    await loadTab("overview");
  };

  if (!campaignArchiveListenersBound) {
    campaignArchiveListenersBound = true;

  openBtn.addEventListener("click", () => {
    const body = document.createElement("div");
    body.className = "form-grid";
    body.innerHTML = `
      <p class="helper-text" style="grid-column: 1 / -1;">
        A snapshot is saved under <strong>campaignArchives</strong>, then active campaign data is removed from Firebase. Type <strong>ARCHIVE</strong> to confirm.
      </p>
      <div class="form-group" style="grid-column: 1 / -1;">
        <label for="campaignArchiveLabelInput">Archive label (optional)</label>
        <input type="text" id="campaignArchiveLabelInput" class="input" value="LCE2026" placeholder="LCE2026 (Local Council backup for header scope)" maxlength="120">
      </div>
      <div class="form-group" style="grid-column: 1 / -1;">
        <label for="campaignArchiveConfirmInput">Type ARCHIVE to confirm</label>
        <input type="text" id="campaignArchiveConfirmInput" class="input" autocomplete="off" spellcheck="false" placeholder="ARCHIVE">
      </div>
    `;
    const footer = document.createElement("div");
    footer.className = "form-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost-button";
    cancelBtn.textContent = "Cancel";
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "primary-button primary-button--danger";
    runBtn.textContent = "Archive and wipe";
    runBtn.disabled = true;
    const confirmInput = () => body.querySelector("#campaignArchiveConfirmInput");
    const labelInput = () => body.querySelector("#campaignArchiveLabelInput");
    const syncRunState = () => {
      const ok = (confirmInput()?.value || "").trim() === "ARCHIVE";
      runBtn.disabled = !ok;
    };
    confirmInput()?.addEventListener("input", syncRunState);
    cancelBtn.addEventListener("click", () => closeModal());
    runBtn.addEventListener("click", async () => {
      if ((confirmInput()?.value || "").trim() !== "ARCHIVE") return;
      runBtn.disabled = true;
      const label = (labelInput()?.value || "").trim();

      const progressRoot = document.createElement("div");
      progressRoot.className = "campaign-archive-progress";
      progressRoot.innerHTML = `
        <div class="campaign-archive-progress__meta">
          <span class="campaign-archive-progress__pct" id="campaignArchiveProgressPct">0%</span>
          <span class="campaign-archive-progress__phase" id="campaignArchiveProgressPhase">Step 1 of 2: Saving snapshot</span>
        </div>
        <div
          class="campaign-archive-progress__track"
          id="campaignArchiveProgressTrack"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="0"
          aria-label="Archive and wipe progress"
        >
          <div class="campaign-archive-progress__bar" id="campaignArchiveProgressBar"></div>
        </div>
        <p class="campaign-archive-progress__status" id="campaignArchiveProgressText">Starting…</p>
      `;
      const pctEl = () => progressRoot.querySelector("#campaignArchiveProgressPct");
      const barEl = () => progressRoot.querySelector("#campaignArchiveProgressBar");
      const trackEl = () => progressRoot.querySelector("#campaignArchiveProgressTrack");
      const textEl = () => progressRoot.querySelector("#campaignArchiveProgressText");
      const phaseEl = () => progressRoot.querySelector("#campaignArchiveProgressPhase");
      const modalTitleEl = document.getElementById("modalTitle");

      const updateProgress = (step, localPercent, message) => {
        const global =
          step === "archive"
            ? Math.round(localPercent * 0.58)
            : Math.round(58 + localPercent * 0.42);
        const p = pctEl();
        const b = barEl();
        const t = trackEl();
        const x = textEl();
        const ph = phaseEl();
        if (p) p.textContent = `${global}%`;
        if (b) b.style.width = `${global}%`;
        if (t) t.setAttribute("aria-valuenow", String(global));
        if (x) x.textContent = message;
        if (ph) {
          ph.textContent =
            step === "archive" ? "Step 1 of 2: Saving snapshot" : "Step 2 of 2: Clearing workspace";
        }
        if (modalTitleEl) {
          modalTitleEl.textContent =
            step === "archive" ? "Archiving campaign…" : "Clearing workspace…";
        }
      };

      openModal({
        title: "Archiving campaign…",
        body: progressRoot,
        footer: null,
        hideMaximize: true,
        closeOnBackdropClick: false,
        closeOnEscape: false,
      });
      updateProgress("archive", 0, "Starting…");

      try {
        const api = await firebaseInitPromise;
        if (!api.ready || !api.archiveCampaignSnapshotFs || !api.wipeActiveCampaignDataFs) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Archive unavailable",
              meta: "Firebase is not ready.",
            });
          }
          closeModal();
          runBtn.disabled = false;
          return;
        }
        const monitorTokens = await getMonitorTokensForArchive();
        updateProgress("archive", 1, "Collecting monitor tokens…");

        const snap = await api.archiveCampaignSnapshotFs({
          label,
          monitorTokens,
          onProgress: ({ percent, message }) => updateProgress("archive", percent, message),
        });
        if (!snap.ok) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Archive failed",
              meta: snap.error || "Unknown error",
            });
          }
          closeModal();
          runBtn.disabled = false;
          return;
        }

        updateProgress("wipe", 0, "Starting workspace cleanup…");
        const wipe = await api.wipeActiveCampaignDataFs({
          monitorTokens,
          onProgress: ({ percent, message }) => updateProgress("wipe", percent, message),
        });
        if (!wipe.ok) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Snapshot saved but wipe failed",
              meta: wipe.error || "Clear active data manually or retry.",
            });
          }
          closeModal();
          runBtn.disabled = false;
          return;
        }
        updateProgress("wipe", 100, "Reloading app…");
        clearLocalCampaignWorkspaceCache();
        closeModal();
        location.reload();
      } catch (err) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Archive failed",
            meta: err?.message || String(err),
          });
        }
        closeModal();
        runBtn.disabled = false;
      }
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(runBtn);
    openModal({
      title: "Archive current campaign",
      body,
      footer,
      closeOnBackdropClick: false,
      closeOnEscape: false,
    });
  });

  tbody.addEventListener("click", async (e) => {
    const viewBtn = e.target.closest("[data-archive-view-full]");
    const delBtn = e.target.closest("[data-archive-delete]");
    const csvBtn = e.target.closest("[data-archive-download-voters-csv]");
    if (csvBtn) {
      const id = csvBtn.getAttribute("data-archive-download-voters-csv");
      if (!id) return;
      const labelAttr = csvBtn.getAttribute("data-archive-label");
      const label = labelAttr != null ? labelAttr : "";
      csvBtn.disabled = true;
      try {
        const api = await firebaseInitPromise;
        if (!api.ready || typeof api.getArchivedVotersFs !== "function") {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Could not download",
              meta: "Archive voters API is unavailable.",
            });
          }
          return;
        }
        const voters = await api.getArchivedVotersFs(id);
        if (!Array.isArray(voters) || voters.length === 0) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "No voters in archive",
              meta: "This snapshot has no voter rows to export.",
            });
          }
          return;
        }
        const csv = buildBulkVoterUploadTemplateCsv(voters);
        const name = sanitizeFilenameSegment(label);
        triggerDownloadCsv(`voters-archive-${name}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "CSV downloaded",
            meta: `${voters.length.toLocaleString("en-MV")} row(s) — same columns as Bulk Voter Upload.`,
          });
        }
      } catch (err) {
        console.warn("archive voters CSV download", err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Download failed",
            meta: err?.message || String(err),
          });
        }
      } finally {
        csvBtn.disabled = false;
      }
      return;
    }
    if (viewBtn) {
      const id = viewBtn.getAttribute("data-archive-view-full");
      if (!id) return;
      const label = (viewBtn.closest("tr")?.querySelector(".data-table-col--name")?.textContent || "").trim();
      await openFullArchiveViewerModal(id, label || "");
      return;
    }
    if (delBtn) {
      const id = delBtn.getAttribute("data-archive-delete");
      if (!id) return;
      const ok = await confirmDialog({
        title: "Delete archive?",
        message: "This permanently removes this archived snapshot from Firebase.",
        confirmText: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        const api = await firebaseInitPromise;
        if (!api.ready || !api.deleteCampaignArchiveFs) return;
        const res = await api.deleteCampaignArchiveFs(id);
        if (!res.ok) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Could not delete archive",
              meta: res.error || "",
            });
          }
          return;
        }
        if (window.appNotifications) {
          window.appNotifications.push({ title: "Archive deleted", meta: "" });
        }
        await refreshArchiveList();
      } catch (err) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not delete archive",
            meta: err?.message || String(err),
          });
        }
      }
    }
  });

  }

  refreshArchiveList();
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
      document.dispatchEvent(
        new CustomEvent("campaign-config-changed", {
          detail: { ...campaignConfig, alignHeaderElectionType: true },
        })
      );
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

  initCampaignArchiveUI();
}

function initAgentsTab() {
  loadAgentsFromStorage();

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
          document.dispatchEvent(
            new CustomEvent("candidates-updated", {
              detail: { candidates: [...candidates] },
            })
          );
          return;
        }
      }
      loadCandidatesFromStorage();
      renderCandidatesTable();
      document.dispatchEvent(
        new CustomEvent("candidates-updated", {
          detail: { candidates: [...candidates] },
        })
      );
    } catch (err) {
      console.error("Candidate load failed:", err);
      loadCandidatesFromStorage();
      renderCandidatesTable();
      document.dispatchEvent(
        new CustomEvent("candidates-updated", {
          detail: { candidates: [...candidates] },
        })
      );
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
          agents = mergeAgentsSnapshotWithLocal(initial, agents.slice());
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
          agents = mergeAgentsSnapshotWithLocal(items, agents);
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

  if (addCandidateButton) {
    addCandidateButton.addEventListener("click", () => {
      openCandidateForm(null);
    });
  }

  if (candidatesTableBody) {
    candidatesTableBody.addEventListener("click", async (e) => {
      const votersBtn = e.target.closest("[data-candidate-pledged-voters]");
      if (votersBtn) {
        const candidateId = votersBtn.getAttribute("data-candidate-pledged-voters");
        if (candidateId == null || candidateId === "") return;
        const ctx = getVotersContextForStandalone();
        openCandidatePledgedVotersModal({
          candidateId,
          getAllVoters: () => ctx.getAllVoters(),
          getCurrentUser: () => parseViewerFromStorage(),
          getCandidates,
        });
        return;
      }
      const delBtn = e.target.closest("[data-delete-candidate]");
      if (delBtn) {
        const rawId = delBtn.getAttribute("data-delete-candidate");
        if (rawId == null || rawId === "") return;
        const cand = candidates.find((c) => String(c.id) === String(rawId));
        if (!cand) return;
        const safeName = escapeHtml(String(cand.name || cand.id || ""));
        const ok = await confirmDialog({
          title: "Delete candidate",
          message: `Remove ${safeName} from the candidate list? Agents or pledges scoped to this candidate may need updating. This cannot be undone.`,
          confirmText: "Delete",
          cancelText: "Cancel",
          danger: true,
        });
        if (!ok) return;
        await deleteCandidateRecord(cand);
        return;
      }
      const btn = e.target.closest("[data-edit-candidate]");
      if (!btn) return;
      const id = Number(btn.getAttribute("data-edit-candidate"));
      const existing = candidates.find((c) => c.id === id);
      if (existing) {
        openCandidateForm(existing);
      }
    });
  }

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
    reader.onload = async (e) => {
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
          const raw = cols[idx];
          // Sequence: keep cell text exactly as in the CSV (per ballot box); other columns trimmed as before.
          obj[key] =
            raw != null
              ? key === "Sequence"
                ? String(raw)
                : String(raw).trim()
              : "";
        });
        return obj;
      });

      const prevImportLabel = importVotersButton.textContent;
      importVotersButton.disabled = true;
      importVotersButton.textContent = "Importing…";
      try {
        await importVotersFromTemplateRows(rows);
      } catch (err) {
        console.error("[Settings] Import voters failed", err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Import failed",
            meta: err?.message || String(err),
          });
        }
      } finally {
        importVotersButton.disabled = false;
        importVotersButton.textContent = prevImportLabel;
      }
      if (votersUploadFileNameEl) votersUploadFileNameEl.textContent = "";
      votersUploadFileInput.value = "";
    };
    reader.readAsText(file);
  });

  const candidatePledgeAgentCsvFile = document.getElementById("candidatePledgeAgentCsvFile");
  const candidatePledgeAgentCsvFileName = document.getElementById("candidatePledgeAgentCsvFileName");
  const importCandidatePledgeAgentCsvButton = document.getElementById(
    "importCandidatePledgeAgentCsvButton"
  );
  const downloadCandidatePledgeAgentCsvTemplate = document.getElementById(
    "downloadCandidatePledgeAgentCsvTemplate"
  );

  if (candidatePledgeAgentCsvFile) {
    candidatePledgeAgentCsvFile.addEventListener("change", () => {
      const file = candidatePledgeAgentCsvFile.files?.[0];
      if (candidatePledgeAgentCsvFileName) {
        candidatePledgeAgentCsvFileName.textContent = file ? file.name : "";
      }
    });
  }

  if (downloadCandidatePledgeAgentCsvTemplate) {
    downloadCandidatePledgeAgentCsvTemplate.addEventListener("click", () => {
      const header = "Name,ID Number,Pledge,Assigned Agent";
      const example = "Jane Doe,A12345678,yes,Agent Full Name";
      const blob = new Blob(["\uFEFF" + header + "\r\n" + example + "\r\n"], {
        type: "text/csv;charset=utf-8",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "pledge-agent-template.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  if (importCandidatePledgeAgentCsvButton && candidatePledgeAgentCsvFile) {
    importCandidatePledgeAgentCsvButton.addEventListener("click", () => {
      const u = parseViewerFromStorage();
      if (u.role !== "candidate" || !u.candidateId) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Not available",
            meta: "Candidate login only.",
          });
        }
        return;
      }
      const file = candidatePledgeAgentCsvFile.files?.[0];
      if (!file) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Choose a file",
            meta: "Select a CSV file first.",
          });
        }
        return;
      }
      if (file.size > MAX_VOTERS_FILE_BYTES) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "File too large",
            meta: "Use a CSV under 15MB.",
          });
        }
        return;
      }
      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = String(e.target?.result || "");
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length < 2) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Empty file",
              meta: "Add a header row and at least one data row.",
            });
          }
          return;
        }
        const rawHeader = parseCSVLine(lines[0]);
        const header = rawHeader.map((h) => String(h).trim());
        let dataLines = lines.slice(1);
        if (dataLines.length > MAX_VOTER_ROWS) {
          dataLines = dataLines.slice(0, MAX_VOTER_ROWS);
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
        const prevLabel = importCandidatePledgeAgentCsvButton.textContent;
        importCandidatePledgeAgentCsvButton.disabled = true;
        importCandidatePledgeAgentCsvButton.textContent = "Importing…";
        try {
          const result = await importCandidatePledgeAgentFromCsvRows(rows, u.candidateId);
          if (result.ok && window.appNotifications) {
            const nf = result.notFoundCount || 0;
            const nfSample = (result.notFound || []).slice(0, 5).filter(Boolean).join(", ");
            const cloudOk = result.cloudSynced !== false;
            const cloudNote =
              result.updated > 0 && !cloudOk && result.cloudError
                ? ` ${result.cloudError}`
                : result.updated > 0 && !cloudOk
                  ? " Cloud sync failed; data is on this device only until you reconnect and import again or use Refresh."
                  : "";
            window.appNotifications.push({
              title: cloudOk || result.updated === 0 ? "Import finished" : "Import saved locally only",
              meta: `Updated ${result.updated.toLocaleString("en-MV")} voter(s).${
                nf
                  ? ` ${nf.toLocaleString("en-MV")} ID number(s) not on the list.${
                      nfSample ? ` Examples: ${nfSample}.` : ""
                    }`
                  : ""
              }${cloudNote}`,
            });
          } else if (result.error === "forbidden") {
            window.appNotifications.push({
              title: "Not allowed",
              meta: "Use your candidate account.",
            });
          }
        } catch (err) {
          console.error("[Settings] Candidate pledge CSV import failed", err);
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Import failed",
              meta: err?.message || String(err),
            });
          }
        } finally {
          importCandidatePledgeAgentCsvButton.disabled = false;
          importCandidatePledgeAgentCsvButton.textContent = prevLabel;
        }
        if (candidatePledgeAgentCsvFileName) candidatePledgeAgentCsvFileName.textContent = "";
        candidatePledgeAgentCsvFile.value = "";
      };
      reader.readAsText(file);
    });
  }

  if (exportVotersCsvButton) {
    exportVotersCsvButton.addEventListener("click", async () => {
      const prevDisabled = exportVotersCsvButton.disabled;
      const prevLabel = exportVotersCsvButton.textContent;
      exportVotersCsvButton.disabled = true;
      exportVotersCsvButton.textContent = "Preparing…";
      try {
        const jsonForCsv = (val) => {
          if (val == null) return "";
          if (typeof val === "object") {
            try {
              return JSON.stringify(val);
            } catch (_) {
              return "";
            }
          }
          return String(val);
        };

        let fromFirestore = [];
        try {
          const api = await firebaseInitPromise;
          if (api.ready && typeof api.getAllVotersFs === "function") {
            // Prefer server + paged fetch; firebase.js falls back to cache if fromServer fails.
            fromFirestore = await api.getAllVotersFs({ fromServer: true });
          }
        } catch (err) {
          console.warn("[Settings] Export: Firestore fetch failed", err);
        }

        /** Base list first (Firestore or localStorage backup), then overlay in-memory voters so the session wins (unsynced edits). */
        const mergeWithInMemoryVoters = (primaryList) => {
          const byId = new Map();
          (Array.isArray(primaryList) ? primaryList : []).forEach((v) => {
            if (!v || v.id == null || v.id === "") return;
            byId.set(String(v.id), v);
          });
          try {
            const standalone = getVotersContextForStandalone();
            if (standalone && typeof standalone.getAllVoters === "function") {
              (standalone.getAllVoters() || []).forEach((v) => {
                if (!v || v.id == null || v.id === "") return;
                byId.set(String(v.id), v);
              });
            }
          } catch (_) {
            /* ignore */
          }
          return Array.from(byId.values());
        };

        let voters = mergeWithInMemoryVoters(fromFirestore);

        if (!Array.isArray(voters) || voters.length === 0) {
          try {
            const raw = localStorage.getItem("voters-data");
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed) && parsed.length) {
                voters = mergeWithInMemoryVoters(parsed);
              }
            }
          } catch (_) {
            /* ignore */
          }
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
          "Voted time marked",
          "Referendum vote",
          "Referendum notes",
          "Candidate pledges (JSON)",
          "Candidate agent assignments (JSON)",
          "Document ID",
        ];
        const lines = [headers.map(csvEscape).join(",")];
        voters.forEach((v) => {
          const row = [
            sequenceAsImportedFromCsv(v),
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
            v.votedTimeMarked || "",
            v.referendumVote || "",
            v.referendumNotes || "",
            jsonForCsv(v.candidatePledges),
            jsonForCsv(v.candidateAgentAssignments),
            v.id || "",
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
            meta: `${voters.length.toLocaleString("en-MV")} voter(s) — full list from the server (plus any unsynced rows on this device).`,
          });
        }
      } catch (err) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not export voters",
            meta: err?.message || String(err),
          });
        }
      } finally {
        exportVotersCsvButton.disabled = prevDisabled;
        exportVotersCsvButton.textContent = prevLabel;
      }
    });
  }

  const autoSyncLocalVotersWhenOnlineEl = document.getElementById("autoSyncLocalVotersWhenOnline");
  if (autoSyncLocalVotersWhenOnlineEl) {
    try {
      autoSyncLocalVotersWhenOnlineEl.checked =
        localStorage.getItem(AUTO_SYNC_LOCAL_VOTERS_ONLINE_KEY) === "1";
    } catch (_) {}
    autoSyncLocalVotersWhenOnlineEl.addEventListener("change", () => {
      try {
        localStorage.setItem(
          AUTO_SYNC_LOCAL_VOTERS_ONLINE_KEY,
          autoSyncLocalVotersWhenOnlineEl.checked ? "1" : "0"
        );
      } catch (_) {}
    });
  }

  if (syncVotersToFirebaseButton) {
    syncVotersToFirebaseButton.addEventListener("click", async () => {
      syncVotersToFirebaseButton.disabled = true;
      const prevLabel = syncVotersToFirebaseButton.textContent;
      syncVotersToFirebaseButton.textContent = "Syncing…";
      try {
        await syncLocalVotersToFirebase();
      } catch (err) {
        console.error("[Settings] Failed to sync local voters to Firebase", err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Sync failed",
            meta: err?.message || String(err),
          });
        }
      } finally {
        syncVotersToFirebaseButton.disabled = false;
        syncVotersToFirebaseButton.textContent = prevLabel;
      }
    });
  }

  if (removeDuplicateVotersByNationalIdButton) {
    removeDuplicateVotersByNationalIdButton.addEventListener("click", async () => {
      removeDuplicateVotersByNationalIdButton.disabled = true;
      const prevLabel = removeDuplicateVotersByNationalIdButton.textContent;
      removeDuplicateVotersByNationalIdButton.textContent = "Working…";
      try {
        await removeDuplicateVotersByNationalId();
      } finally {
        removeDuplicateVotersByNationalIdButton.disabled = false;
        removeDuplicateVotersByNationalIdButton.textContent = prevLabel;
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

      deleteAllVotersButton.disabled = true;
      const prevLabel = deleteAllVotersButton.textContent;
      deleteAllVotersButton.textContent = "Deleting…";

      try {
        // Clear local cache and in-memory list immediately so the UI is not stuck on old data.
        try {
          localStorage.removeItem("voters-data");
        } catch (_) {}
        refreshVotersFromStorage();

        // Firestore: batched deletes (fast, avoids thousands of parallel single deletes).
        try {
          const api = await firebaseInitPromise;
          if (api.ready && typeof api.deleteAllVotersFs === "function") {
            await api.deleteAllVotersFs();
          } else if (api.ready && api.deleteVoterFs && api.getAllVotersFs) {
            const existing = await api.getAllVotersFs();
            if (Array.isArray(existing) && existing.length) {
              const chunkSize = 25;
              for (let i = 0; i < existing.length; i += chunkSize) {
                await Promise.all(
                  existing.slice(i, i + chunkSize).map((v) => api.deleteVoterFs(v.id))
                );
              }
            }
          }
        } catch (err) {
          console.error("[Settings] Firestore delete all voters failed", err);
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Remote delete incomplete",
              meta: "Local list was cleared. Check your connection and try again, or remove voters in Firebase Console.",
            });
          }
        }

        refreshVotersFromStorage();
        document.dispatchEvent(new CustomEvent("voters-updated"));
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Voters list deleted",
            meta: "All voters for this campaign have been removed from this device.",
          });
        }
      } finally {
        deleteAllVotersButton.disabled = false;
        deleteAllVotersButton.textContent = prevLabel;
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

/**
 * Pull latest agents from Firestore, merge rows pending sync, re-render and broadcast.
 */
export async function refreshAgentsFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getAllAgentsFs) return;
    const initial = await api.getAllAgentsFs();
    if (!Array.isArray(initial)) return;
    agents = mergeAgentsSnapshotWithLocal(initial, agents.slice());
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
  } catch (e) {
    console.warn("[Settings] refreshAgentsFromFirestore", e);
  }
}

/**
 * Pull latest candidates from Firestore and re-render (pledge columns, modals, etc.).
 */
export async function refreshCandidatesFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getAllCandidatesFs) return;
    const items = await api.getAllCandidatesFs();
    if (!Array.isArray(items)) return;
    candidates = items;
    saveCandidatesToStorage();
    renderCandidatesTable();
    document.dispatchEvent(
      new CustomEvent("candidates-updated", {
        detail: { candidates: [...candidates] },
      })
    );
  } catch (e) {
    console.warn("[Settings] refreshCandidatesFromFirestore", e);
  }
}

loadCampaignConfig();

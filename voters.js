import { openModal, closeModal, confirmDialog } from "./ui.js";
import { firebaseInitPromise } from "./firebase.js";
import {
  getVotedTimeMarked,
  mergeVotedAtFromVoters,
  clearVotedForVoter,
  getAvailableTransportRoutes,
  addTransportRouteFromName,
  TRIP_TYPES,
  TRIP_STATUSES,
} from "./zeroDay.js";
import {
  getLists,
  createList,
  openListWorkspace,
} from "./lists.js";
import {
  filterAgentsForViewer,
  getAgentsFromStorage,
  candidatePledgedAgentStorageKey,
} from "./agents-context.js";
import {
  ballotSequenceText,
  sequenceAsImportedFromCsv,
  compareVotersByBallotSequenceThenName,
  compareVotersByBallotBoxThenSequenceThenName,
} from "./sequence-utils.js";
const PAGE_SIZE = 15;
const CANDIDATES_STORAGE_KEY = "candidates-data";
const VOTERS_STORAGE_KEY = "voters-data";

// Dynamic data: starts empty and is populated via bulk upload and in-app actions.
let currentVoters = [];
/** While true, ignore Firestore snapshot updates so partial bulk uploads don't replace the full local list. */
let votersBulkImportInProgress = false;

function sameVoterId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Normalize per-candidate maps from Firestore (string keys, valid pledge values). */
function normalizeVoterCandidateFields(v) {
  if (!v || typeof v !== "object") return v;
  const out = { ...v };
  if (out.candidatePledges != null && typeof out.candidatePledges === "object" && !Array.isArray(out.candidatePledges)) {
    const next = {};
    for (const [k, val] of Object.entries(out.candidatePledges)) {
      const key = String(k);
      if (val === "yes" || val === "no" || val === "undecided") next[key] = val;
    }
    out.candidatePledges = next;
  } else if (out.candidatePledges == null) {
    out.candidatePledges = {};
  }
  return out;
}

/** Stable key for matching voter rows (trim + internal spaces collapsed). */
function normalizeNationalIdForDedup(nid) {
  return String(nid || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Firestore document id derived from national ID — stable across CSV re-imports when Seq changes.
 * Empty string if no usable ID (caller falls back to generated id).
 */
export function voterDocumentIdFromNationalId(raw) {
  const n = normalizeNationalIdForDedup(raw);
  if (!n) return "";
  const id = n.replace(/\//g, "-");
  if (!id) return "";
  return id.length > 800 ? id.slice(0, 800) : id;
}

/** Keys used for legacy localStorage agent maps: internal id + normalized national ID. */
function localStorageAgentMapKeysForVoter(voter) {
  const keys = new Set();
  if (voter?.id != null && String(voter.id).trim()) keys.add(String(voter.id).trim());
  const nid = normalizeNationalIdForDedup(voter?.nationalId);
  if (nid) keys.add(nid);
  return Array.from(keys);
}

function mergeImportedVoterWithExistingFirestore(mappedRow, existing) {
  if (!existing || typeof existing !== "object") return mappedRow;
  const norm = normalizeVoterCandidateFields({ ...existing });
  const out = { ...mappedRow };
  const copyKeys = [
    "candidatePledges",
    "candidateAgentAssignments",
    "candidateAgentAssignmentIds",
    "transportNeeded",
    "transportRoute",
    "transportType",
    "votedAt",
    "referendumVote",
    "referendumNotes",
    "volunteer",
    "metStatus",
    "persuadable",
    "pledgedAt",
    "notes",
    "callComments",
  ];
  for (const k of copyKeys) {
    const val = norm[k];
    if (val === undefined || val === null) continue;
    if (k === "candidatePledges" && typeof val === "object" && !Array.isArray(val)) {
      out.candidatePledges = { ...norm.candidatePledges };
    } else if (
      (k === "candidateAgentAssignments" || k === "candidateAgentAssignmentIds") &&
      typeof val === "object" &&
      !Array.isArray(val)
    ) {
      out[k] = { ...val };
    } else {
      out[k] = val;
    }
  }
  return out;
}

function loadVotersFromStorage() {
  try {
    const raw = localStorage.getItem(VOTERS_STORAGE_KEY);
    if (!raw) {
      currentVoters = [];
      return;
    }
    const parsed = JSON.parse(raw);
    currentVoters = Array.isArray(parsed) ? parsed.map(normalizeVoterCandidateFields) : [];
  } catch (_) {
    currentVoters = [];
  }
}

function saveVotersToStorage() {
  try {
    localStorage.setItem(VOTERS_STORAGE_KEY, JSON.stringify(currentVoters));
  } catch (_) {}
}

/** After Firestore succeeds: keep legacy localStorage map in sync (reports / older UIs). */
function mirrorCandidatePledgedAgentLocalMap(candidateId, voterId, agentName) {
  if (!candidateId || voterId == null) return;
  const key = candidatePledgedAgentStorageKey(candidateId);
  let map = {};
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") map = p;
    }
  } catch (_) {}
  const val = agentName || "";
  map[String(voterId)] = val;
  const v = findVoterById(voterId);
  if (v) {
    for (const k of localStorageAgentMapKeysForVoter(v)) {
      if (String(k) !== String(voterId)) map[k] = val;
    }
  }
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch (_) {}
}

/** Write voter to Firestore; show notification on failure. Returns whether the write succeeded. */
async function saveVoterToFirestoreWithNotification(v, errorTitle) {
  const title = errorTitle || "Could not save to cloud";
  try {
    const api = await firebaseInitPromise;
    if (!api?.ready || typeof api.setVoterFs !== "function") {
      if (window.appNotifications) {
        window.appNotifications.push({
          title,
          meta: "Cloud sync is not ready. Check your connection and try again.",
        });
      }
      return false;
    }
    await api.setVoterFs(v);
    return true;
  } catch (err) {
    console.warn("[Voters] setVoterFs failed", err);
    if (window.appNotifications) {
      window.appNotifications.push({
        title,
        meta: err?.message || String(err),
      });
    }
    return false;
  }
}
let selectedVoterId = null;
let votersCurrentPage = 1;
let unsubscribeVotersFs = null;

function findVoterById(id) {
  return currentVoters.find((v) => sameVoterId(v.id, id));
}

/** Set by initVotersModule — used for candidate-only UI and pledge column logic. */
let getCurrentUserFn = () => null;

/** Injected from main.js (Settings) so “Add new agent…” works without fragile dynamic import. */
let openAddAgentModalRef = null;

function callOpenAddAgentModal(options) {
  const opts = options || {};
  if (typeof openAddAgentModalRef === "function") {
    try {
      openAddAgentModalRef(opts);
    } catch (err) {
      console.error("[Voters] openAddAgentModal failed", err);
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Could not open agent form",
          meta: err?.message || String(err),
        });
      }
    }
    return;
  }
  import("./settings.js")
    .then((m) => {
      if (typeof m.openAddAgentModal === "function") m.openAddAgentModal(opts);
      else throw new Error("openAddAgentModal is not available");
    })
    .catch((err) => {
      console.error("[Voters] Failed to load settings for Add agent", err);
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Could not open agent form",
          meta: err?.message || String(err),
        });
      }
    });
}

function getCandidateContext() {
  try {
    const u = typeof getCurrentUserFn === "function" ? getCurrentUserFn() : null;
    if (!u || u.role !== "candidate" || !u.candidateId) return null;
    return { candidateId: String(u.candidateId).trim() };
  } catch (_) {
    return null;
  }
}

/** Read Yes/No/Undecided for one candidate from voter.candidatePledges (flexible key shapes from Firestore). */
function readCandidatePledgeMap(voter, candidateId) {
  const cp = voter?.candidatePledges;
  if (!cp || typeof cp !== "object" || Array.isArray(cp)) return undefined;
  const want = String(candidateId);
  const d = cp[want];
  if (d === "yes" || d === "no" || d === "undecided") return d;
  for (const [k, val] of Object.entries(cp)) {
    if (String(k) === want && (val === "yes" || val === "no" || val === "undecided")) return val;
  }
  return undefined;
}

/** Pledge shown in list / filters: per-candidate for candidate users, overall pledge otherwise. */
function getEffectivePledgeStatus(voter) {
  const ctx = getCandidateContext();
  if (ctx && voter) {
    const s = readCandidatePledgeMap(voter, ctx.candidateId);
    if (s === "yes" || s === "no" || s === "undecided") return s;
    return "undecided";
  }
  return (voter && voter.pledgeStatus) || "undecided";
}

function pledgeStatusLabel(s) {
  if (s === "yes") return "Yes";
  if (s === "no") return "No";
  return "Undecided";
}

function pickAgentAssignmentVal(raw) {
  if (raw == null) return "";
  if (typeof raw === "object") return String(raw.name || raw.id || "").trim();
  return String(raw).trim();
}

/** Same source as voter detail “Assigned agent” for this candidate: Firestore map + legacy local map. */
function loadCandidateAgentAssignmentMap(candidateId) {
  const key = candidatePledgedAgentStorageKey(String(candidateId));
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return p;
    }
  } catch (_) {}
  return {};
}

function getCandidateScopedAssignedAgentNameWithMap(voter, candidateId, map) {
  if (!voter || !candidateId) return "";
  const cid = String(candidateId);
  const fromObj =
    voter.candidateAgentAssignments && typeof voter.candidateAgentAssignments === "object"
      ? voter.candidateAgentAssignments[cid]
      : "";
  const fromDoc = pickAgentAssignmentVal(fromObj);
  let fromMap = "";
  for (const key of localStorageAgentMapKeysForVoter(voter)) {
    const v = pickAgentAssignmentVal(map[key]);
    if (v) {
      fromMap = v;
      break;
    }
  }
  return (fromDoc || fromMap).trim();
}

/** `voterFilterAgent` value for voters with no agent (candidate list filter). */
const AGENT_FILTER_UNASSIGNED = "__unassigned__";

/** In-memory list synced from Settings / Firebase via `candidates-updated` (avoids stale labels for candidate UI). */
let candidatesCacheForVoters = null;

function seedCandidatesCacheFromStorage() {
  try {
    const raw = localStorage.getItem(CANDIDATES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) candidatesCacheForVoters = parsed;
    }
  } catch (_) {}
}

if (typeof document !== "undefined") {
  document.addEventListener("candidates-updated", (e) => {
    const d = e?.detail?.candidates;
    if (Array.isArray(d)) candidatesCacheForVoters = d.slice();
    else seedCandidatesCacheFromStorage();
  });
}

/** Local read only — avoids circular import with settings.js */
function getCandidateRecordById(candidateId) {
  const cid = String(candidateId);
  if (Array.isArray(candidatesCacheForVoters) && candidatesCacheForVoters.length) {
    const hit = candidatesCacheForVoters.find((c) => String(c.id) === cid);
    if (hit) return hit;
  }
  try {
    const raw = localStorage.getItem(CANDIDATES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.find((c) => String(c.id) === cid) || null;
  } catch (_) {
    return null;
  }
}

/** All candidates (Settings) — local read only. */
function getCandidatesListFromStorage() {
  try {
    const raw = localStorage.getItem(CANDIDATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/** Display label for candidate id (same idea as settings.js; local-only to avoid circular imports). */
function candidateLabelById(id) {
  if (!id) return "All campaigns";
  const c = getCandidatesListFromStorage().find((x) => String(x.id) === String(id));
  return c ? String(c.name || c.id || id) : `Candidate #${id}`;
}

const VOTER_DETAIL_AGENT_SCOPE_KEY = "voterDetailAgentCandidateScope";
const ALL_CAMPAIGN_SCOPE_KEY = "__all_campaign__";

function getViewerIsAdmin() {
  try {
    const u = typeof getCurrentUserFn === "function" ? getCurrentUserFn() : null;
    return Boolean(u?.isAdmin);
  } catch (_) {
    return false;
  }
}

function getAgentScopeId(agent) {
  const raw = agent && agent.candidateId;
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  return s && s !== "undefined" && s !== "null" ? s : "";
}

/** Candidate login can assign only candidate-scoped agents for that candidate. */
function getCandidateAssignableAgents(candidateId) {
  const cid = String(candidateId || "").trim();
  if (!cid) return [];
  return getAgentsFromStorage().filter((a) => {
    const scopeId = getAgentScopeId(a);
    return scopeId === cid;
  });
}

const VOTERS_MODULE_DESC_DEFAULT =
  "Browse and manage voters with side-by-side detailed information.";
const VOTERS_MODULE_DESC_CANDIDATE =
  "Shows the full voter list. The pledge column is your Yes / No / Undecided for each voter — update pledges in the details panel. Reports → Candidate pledge summary still lists pledged voters separately.";

function applyCandidateVotersUi() {
  const ctx = getCandidateContext();
  const isCand = !!ctx;
  const addBtn = document.getElementById("addVoterButton");
  const createListBtn = document.getElementById("createListButton");
  const myListsWrap = document.getElementById("myListsSelect")?.closest(".field-group");
  if (addBtn) addBtn.style.display = isCand ? "none" : "";
  if (createListBtn) createListBtn.style.display = isCand ? "none" : "";
  if (myListsWrap) myListsWrap.style.display = isCand ? "none" : "";
  const descEl = document.getElementById("votersModuleDescription");
  if (descEl) {
    descEl.textContent = isCand ? VOTERS_MODULE_DESC_CANDIDATE : VOTERS_MODULE_DESC_DEFAULT;
  }
  const pledgeTh = document.querySelector("#votersTable thead th[data-sort-key='pledge']");
  if (pledgeTh) {
    pledgeTh.innerHTML = isCand
      ? `Your pledge<span class="sort-indicator"></span>`
      : `Pledge<span class="sort-indicator"></span>`;
  }
  const filterSel = document.getElementById("voterFilterPledge");
  if (filterSel && filterSel.options[0]) {
    filterSel.options[0].textContent = isCand ? "All (your pledge)" : "All pledge statuses";
  }
  const agentTh = document.getElementById("votersThAssignedAgent");
  if (agentTh) agentTh.hidden = !isCand;
  const agentSortOpt = document.getElementById("voterSortOptAssignedAgent");
  if (agentSortOpt) agentSortOpt.hidden = !isCand;
  const searchEl = document.getElementById("voterSearch");
  if (searchEl) {
    searchEl.placeholder = isCand
      ? "Search by name, ID, address, island, notes, assigned agent…"
      : "Search by name, ID, address, island, notes…";
  }
  const agentFilterWrap = document.getElementById("voterFilterAgentWrap");
  if (agentFilterWrap) agentFilterWrap.hidden = !isCand;
  if (isCand) refreshVoterFilterAgentOptions();
  else {
    const agentSel = document.getElementById("voterFilterAgent");
    if (agentSel) agentSel.value = "all";
  }
}

/** Rebuild candidate-only “Assigned agent” filter options from agents list + current assignments. */
function refreshVoterFilterAgentOptions() {
  const ctx = getCandidateContext();
  const sel = document.getElementById("voterFilterAgent");
  if (!sel) return;
  if (!ctx) {
    sel.value = "all";
    return;
  }
  const prev = sel.value;
  const map = loadCandidateAgentAssignmentMap(ctx.candidateId);
  const nameSet = new Set();
  for (const a of getCandidateAssignableAgents(ctx.candidateId)) {
    const n = String(a?.name || "").trim();
    if (n) nameSet.add(n);
  }
  for (const v of currentVoters) {
    const n = getCandidateScopedAssignedAgentNameWithMap(v, ctx.candidateId, map);
    if (n) nameSet.add(n);
  }
  const sorted = Array.from(nameSet).sort((a, b) => a.localeCompare(b, "en"));
  sel.innerHTML = `
    <option value="all">All agents</option>
    <option value="${AGENT_FILTER_UNASSIGNED}">Unassigned</option>
    ${sorted
      .map(
        (n) =>
          `<option value="${escapeHtml(encodeURIComponent(n))}">${escapeHtml(n)}</option>`
      )
      .join("")}
  `;
  const prevOk =
    prev === "all" ||
    prev === AGENT_FILTER_UNASSIGNED ||
    sorted.some((n) => encodeURIComponent(n) === prev);
  sel.value = prevOk ? prev : "all";
}

function getVotersTableColumnCount() {
  return getCandidateContext() ? 9 : 8;
}

const votersTableBody = document.querySelector("#votersTable tbody");
const votersPaginationEl = document.getElementById("votersPagination");
const voterSearchInput = document.getElementById("voterSearch");
const voterSortEl = document.getElementById("voterSort");
const voterFilterPledgeEl = document.getElementById("voterFilterPledge");
const voterFilterAgentEl = document.getElementById("voterFilterAgent");
const voterGroupByEl = document.getElementById("voterGroupBy");
const voterDetailsSubtitle = document.getElementById("voterDetailsSubtitle");
const voterDetailsContent = document.getElementById("voterDetailsContent");
const voterNotesTextarea = document.getElementById("voterNotes");
const saveVoterNotesButton = document.getElementById("saveVoterNotesButton");
const voterNotesHelperEl = document.getElementById("voterNotesHelper");
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
  let sortBy = voterSortEl?.value || "sequence";
  const groupBy = voterGroupByEl?.value || "none";
  const candCtx = getCandidateContext();
  const agentMap = candCtx ? loadCandidateAgentAssignmentMap(candCtx.candidateId) : null;
  if (sortBy === "assignedAgent" && !candCtx) sortBy = "sequence";
  const agentFilterRaw = candCtx ? voterFilterAgentEl?.value || "all" : "all";

  let list = currentVoters.filter((voter) => {
    if (pledgeFilter !== "all" && getEffectivePledgeStatus(voter) !== pledgeFilter)
      return false;
    if (candCtx && agentFilterRaw !== "all") {
      const assigned = getCandidateScopedAssignedAgentNameWithMap(voter, candCtx.candidateId, agentMap);
      if (agentFilterRaw === AGENT_FILTER_UNASSIGNED) {
        if (assigned) return false;
      } else {
        let wantName = agentFilterRaw;
        try {
          wantName = decodeURIComponent(agentFilterRaw);
        } catch (_) {
          /* keep raw */
        }
        if (assigned.trim().toLowerCase() !== wantName.trim().toLowerCase()) return false;
      }
    }
    if (query) {
      const name = (voter.fullName || "").toLowerCase();
      const id = (voter.id || "").toLowerCase();
      const nationalId = (voter.nationalId || "").toLowerCase();
      const phone = (voter.phone || "").toLowerCase();
      const address = (voter.permanentAddress || "").toLowerCase();
      const island = (voter.island || "").toLowerCase();
      const notes = (voter.notes || "").toLowerCase();
      const seq = sequenceAsImportedFromCsv(voter).toLowerCase();
      const agentName = candCtx
        ? getCandidateScopedAssignedAgentNameWithMap(voter, candCtx.candidateId, agentMap).toLowerCase()
        : "";
      if (
        !name.includes(query) &&
        !id.includes(query) &&
        !nationalId.includes(query) &&
        !phone.includes(query) &&
        !address.includes(query) &&
        !island.includes(query) &&
        !notes.includes(query) &&
        !seq.includes(query) &&
        !agentName.includes(query)
      )
        return false;
    }
    return true;
  });

  const cmp = (a, b) => {
    switch (sortBy) {
      case "name-desc":
        return (b.fullName || "").localeCompare(a.fullName || "", "en");
      case "sequence":
        return compareVotersByBallotSequenceThenName(a, b);
      case "island":
        return compareVotersByBallotBoxThenSequenceThenName(a, b);
      case "pledge":
        return getEffectivePledgeStatus(a).localeCompare(getEffectivePledgeStatus(b), "en");
      case "assignedAgent":
        if (!candCtx) return (a.fullName || "").localeCompare(b.fullName || "", "en");
        return getCandidateScopedAssignedAgentNameWithMap(a, candCtx.candidateId, agentMap).localeCompare(
          getCandidateScopedAssignedAgentNameWithMap(b, candCtx.candidateId, agentMap),
          "en"
        );
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

  if (groupBy === "island") {
    list.sort(compareVotersByBallotBoxThenSequenceThenName);
  }

  if (groupBy === "none") {
    return list.map((voter) => ({ type: "row", voter }));
  }

  const getGroupKey = (v) => {
    if (groupBy === "island") return v.ballotBox || "Unassigned";
    if (groupBy === "pledge") return getEffectivePledgeStatus(v) || "undecided";
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
  const ctx = getCandidateContext();
  if (!ctx && voterSortEl?.value === "assignedAgent") {
    voterSortEl.value = "name-asc";
  }
  const agentMapForRows = ctx ? loadCandidateAgentAssignmentMap(ctx.candidateId) : null;
  let clearedSelectionForCandidate = false;
  if (ctx && selectedVoterId) {
    const sel = findVoterById(selectedVoterId);
    if (!sel) {
      selectedVoterId = null;
      clearedSelectionForCandidate = true;
    }
  }
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
    const emptyMsg = ctx
      ? "No voters in the system yet. Staff can import voters in Settings → Data."
      : "No voters. Add a voter or import from Settings → Data.";
    tr.innerHTML = `<td colspan="${getVotersTableColumnCount()}" class="text-muted" style="text-align:center;padding:24px;">${emptyMsg}</td>`;
    votersTableBody.appendChild(tr);
  }

  for (const item of pageDisplayList) {
    if (item.type === "group") {
      const tr = document.createElement("tr");
      tr.className = "list-toolbar__group-header";
      tr.innerHTML = `<td colspan="${getVotersTableColumnCount()}">${escapeHtml(item.label)}</td>`;
      votersTableBody.appendChild(tr);
      continue;
    }
    const voter = item.voter;
    const tr = document.createElement("tr");
    tr.dataset.voterId = voter.id;
    if (sameVoterId(voter.id, selectedVoterId)) {
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
    const effPledge = getEffectivePledgeStatus(voter);
    const pledgeDisplay = pledgeStatusLabel(effPledge);
    const assignedAgentName = ctx
      ? getCandidateScopedAssignedAgentNameWithMap(voter, ctx.candidateId, agentMapForRows)
      : "";
    const assignedAgentCell = ctx
      ? assignedAgentName
        ? `<td class="data-table-col--assigned-agent">${escapeHtml(assignedAgentName)}</td>`
        : `<td class="data-table-col--assigned-agent"><span class="text-muted">—</span></td>`
      : "";
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
      <td class="data-table-col--seq">${escapeHtml(sequenceAsImportedFromCsv(voter) || "")}</td>
      <td>${photoCell}</td>
      <td>${voter.nationalId ?? ""}</td>
      <td class="data-table-col--name">${voter.fullName}</td>
      <td>${voter.permanentAddress ?? ""}</td>
      <td><span class="${pledgePillClass(
        effPledge
      )}">${pledgeDisplay}</span></td>
      ${assignedAgentCell}
      <td class="voted-status-cell">${votedCell}</td>
      <td style="text-align:right;">
        ${
          getCandidateContext()
            ? '<span class="text-muted">—</span>'
            : `<button type="button" class="ghost-button ghost-button--small" data-voter-edit="${escapeHtml(
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
        }`
        }
      </td>
    `;
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-voter-edit], [data-voter-delete], [data-voter-unmark]")) return;
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
  applyCandidateVotersUi();
  if (clearedSelectionForCandidate) {
    renderVoterDetails(null);
  }
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

/** Admin: create a Zero Day trip from voter detail (same fields as Zero Day → Add trip). */
function openVoterDetailAddTransportRouteModal(voter) {
  if (!voter) return;
  const defaultPickup = new Date().toISOString().slice(0, 16);
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="vdTripType">Type</label>
        <select id="vdTripType" class="input">
          ${TRIP_TYPES.map(
            (t) =>
              `<option value="${escapeHtml(t.value)}">${escapeHtml(t.label)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label for="vdTripRoute">Trip / Route name</label>
        <input id="vdTripRoute" class="input" type="text" value="" placeholder="e.g. North pickup run 1" />
      </div>
      <div class="form-group">
        <label for="vdTripDriver">Driver / Pilot / Captain</label>
        <input id="vdTripDriver" class="input" type="text" value="" placeholder="Name" />
      </div>
      <div class="form-group">
        <label for="vdTripVehicle">Vessel name / Flight number</label>
        <input id="vdTripVehicle" class="input" type="text" value="" placeholder="e.g. MDR-301 or Flight XY123" />
      </div>
      <div class="form-group">
        <label for="vdTripPickupTime">Pickup time</label>
        <input id="vdTripPickupTime" class="input" type="datetime-local" value="${escapeHtml(defaultPickup)}" />
      </div>
      <div class="form-group">
        <label for="vdTripStatus">Status</label>
        <select id="vdTripStatus" class="input">
          ${TRIP_STATUSES.map(
            (s) =>
              `<option value="${escapeHtml(s)}"${s === "Scheduled" ? " selected" : ""}>${escapeHtml(
                s
              )}</option>`
          ).join("")}
        </select>
      </div>
    </div>
    <p class="helper-text">Creates the trip in Zero Day → Transport and adds this route to the voter dropdown.</p>
  `;
  const footer = document.createElement("div");
  footer.className = "form-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => closeModal());
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary-button";
  saveBtn.textContent = "Add trip";
  saveBtn.addEventListener("click", async () => {
    const tripType = (body.querySelector("#vdTripType")?.value || "flight").trim();
    const name = (body.querySelector("#vdTripRoute")?.value || "").trim();
    const driver = (body.querySelector("#vdTripDriver")?.value || "").trim();
    const vehicle = (body.querySelector("#vdTripVehicle")?.value || "").trim();
    const pickupTime = body.querySelector("#vdTripPickupTime")?.value || "";
    const status = (body.querySelector("#vdTripStatus")?.value || "Scheduled").trim();
    if (!name) {
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Enter a trip / route name", meta: "" });
      }
      return;
    }
    const result = await addTransportRouteFromName(name, {
      tripType,
      driver,
      vehicle,
      pickupTime,
      status,
    });
    if (!result.ok) {
      if (result.error === "duplicate" && window.appNotifications) {
        window.appNotifications.push({
          title: "Route already exists",
          meta: "Pick it from the list or use a different name.",
        });
      }
      return;
    }
    closeModal();
    const v = findVoterById(voter.id);
    if (v) {
      v.transportNeeded = true;
      v.transportRoute = result.route;
      if (!v.transportType) v.transportType = "oneway";
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.setVoterFs) await api.setVoterFs(v);
      } catch (_) {}
      saveVotersToStorage();
      renderVotersTable();
      if (sameVoterId(selectedVoterId, v.id)) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    }
    if (window.appNotifications) {
      window.appNotifications.push({ title: "Route added", meta: result.route });
    }
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  openModal({ title: "Add trip", body, footer });
  setTimeout(() => body.querySelector("#vdTripRoute")?.focus(), 100);
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

/** Searchable transport route field (same dropdown shell as assigned agent in voter details). */
function setupTransportRouteSearchDropdown({ routeSel, routeSearchInput, menuEl, getRoutes, persistTransport }) {
  if (
    !routeSel ||
    !routeSearchInput ||
    !menuEl ||
    typeof getRoutes !== "function" ||
    typeof persistTransport !== "function"
  ) {
    return;
  }
  const toNorm = (s) => String(s || "").trim().toLowerCase();
  const root = document.getElementById("voterTransportRouteDropdown");

  const renderMenu = () => {
    if (routeSearchInput.disabled) {
      menuEl.style.display = "none";
      return;
    }
    const q = toNorm(routeSearchInput.value);
    const all = getRoutes();
    const list = all.filter((r) => !q || toNorm(r).includes(q)).slice(0, 40);
    if (!list.length) {
      menuEl.innerHTML =
        '<div class="voter-agent-dropdown__empty">No matching routes.</div>';
      menuEl.style.display = "block";
      return;
    }
    menuEl.innerHTML = list
      .map(
        (r) =>
          `<button type="button" class="voter-agent-dropdown__item voter-transport-route-item" data-route-name="${escapeHtml(r)}"><span class="voter-agent-dropdown__main">${escapeHtml(r)}</span></button>`
      )
      .join("");
    menuEl.style.display = "block";
  };

  const hideMenu = () => {
    menuEl.style.display = "none";
  };

  routeSearchInput.addEventListener("focus", renderMenu);
  routeSearchInput.addEventListener("input", renderMenu);
  root?.addEventListener("focusout", () => {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!root.contains(active)) hideMenu();
    }, 0);
  });

  menuEl.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-route-name]")) e.preventDefault();
  });

  menuEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-route-name]");
    if (!btn) return;
    const name = btn.getAttribute("data-route-name") || "";
    routeSearchInput.value = name;
    routeSel.value = name;
    hideMenu();
    persistTransport();
  });

  function normalizeFromSearch() {
    if (routeSearchInput.disabled) return;
    const q = String(routeSearchInput.value || "").trim();
    const all = getRoutes();
    if (!q) {
      if (!routeSel.value) return;
      routeSel.value = "";
      routeSearchInput.value = "";
      persistTransport();
      return;
    }
    const exactCi = all.find((r) => toNorm(r) === toNorm(q));
    if (exactCi) {
      routeSearchInput.value = exactCi;
      if (routeSel.value === exactCi) return;
      routeSel.value = exactCi;
      persistTransport();
      return;
    }
    const prev = routeSel.value || "";
    routeSearchInput.value = prev;
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Route not found",
        meta: "Pick a route from the list or clear the field.",
      });
    }
  }

  routeSearchInput.addEventListener("blur", () => {
    window.setTimeout(normalizeFromSearch, 180);
  });
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
  const routeNameSet = new Set(availableRoutes);
  const trTrim = (transportRoute || "").trim();
  if (trTrim) routeNameSet.add(trTrim);
  const availableRoutesForUi = Array.from(routeNameSet).sort((a, b) => a.localeCompare(b, "en"));
  const candCtx = getCandidateContext();
  const candRecord = candCtx ? getCandidateRecordById(candCtx.candidateId) : null;
  const candLabel = candRecord?.name ? escapeHtml(candRecord.name) : "";
  const myPledge = candCtx ? getEffectivePledgeStatus(voter) : "";
  const referendumVoteVal =
    voter.referendumVote === "yes" || voter.referendumVote === "no"
      ? voter.referendumVote
      : "undecided";
  const votedStatusHtml = (() => {
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
      return `<span class="pledge-pill pledge-pill--pledged">Yes</span> ${escapeHtml(formatted)}`;
    }
    return '<span class="pledge-pill pledge-pill--undecided">No</span>';
  })();

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

  const statusSectionHtml = candCtx
    ? `
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
            <div class="detail-item-label">Your pledge${candLabel ? ` — ${candLabel}` : ""}</div>
            <div class="detail-item-value">
              <div class="candidate-pledge-picker" role="group" aria-label="Your pledge for this voter">
                <button type="button" class="candidate-pledge-option candidate-pledge-option--yes${
                  myPledge === "yes" ? " is-active" : ""
                }" data-candidate-pledge="yes">Yes</button>
                <button type="button" class="candidate-pledge-option candidate-pledge-option--no${
                  myPledge === "no" ? " is-active" : ""
                }" data-candidate-pledge="no">No</button>
                <button type="button" class="candidate-pledge-option candidate-pledge-option--undecided${
                  myPledge === "undecided" ? " is-active" : ""
                }" data-candidate-pledge="undecided">Undecided</button>
              </div>
              <p class="helper-text candidate-pledge-picker__hint">Tap to set your pledge for this voter.</p>
            </div>
          </div>
          <div>
            <div class="detail-item-label">Overall campaign pledge</div>
            <div class="detail-item-value">
              <span class="${pledgePillClass(
                voter.pledgeStatus
              )}">${pledgeStatusLabel(voter.pledgeStatus || "undecided")}</span>
            </div>
          </div>
          <div>
            <div class="detail-item-label">Marked voted</div>
            <div class="detail-item-value">${votedStatusHtml}</div>
          </div>
          <div>
            <div class="detail-item-label">Referendum</div>
            <div class="detail-item-value">
              <div class="candidate-pledge-picker voter-detail-referendum-picker" role="group" aria-label="Referendum vote">
                <button type="button" class="candidate-pledge-option candidate-pledge-option--yes${
                  referendumVoteVal === "yes" ? " is-active" : ""
                }" data-referendum-vote="yes">Yes</button>
                <button type="button" class="candidate-pledge-option candidate-pledge-option--no${
                  referendumVoteVal === "no" ? " is-active" : ""
                }" data-referendum-vote="no">No</button>
                <button type="button" class="candidate-pledge-option candidate-pledge-option--undecided${
                  referendumVoteVal === "undecided" ? " is-active" : ""
                }" data-referendum-vote="undecided">Undecided</button>
              </div>
              <p class="helper-text candidate-pledge-picker__hint">Same referendum pledge as in Pledges (campaign-wide).</p>
            </div>
          </div>
          <div>
            <div class="detail-item-label">Referendum comment</div>
            <div class="detail-item-value">
              <textarea
                id="voterDetailReferendumNotes"
                class="voter-detail-referendum-notes"
                rows="2"
                placeholder="Comment on referendum…"
                aria-label="Referendum comment"
              >${escapeHtml(voter.referendumNotes != null ? String(voter.referendumNotes) : "")}</textarea>
            </div>
          </div>
        </div>
      </section>`
    : `
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
            <div class="detail-item-value">${votedStatusHtml}</div>
          </div>
        </div>
      </section>`;

  const showAdminTransportAddRoute = (() => {
    try {
      const u = typeof getCurrentUserFn === "function" ? getCurrentUserFn() : null;
      return Boolean(u?.isAdmin);
    } catch (_) {
      return false;
    }
  })();

  const voterTransportAddRouteBtnHtml = showAdminTransportAddRoute
    ? `<div class="voter-transport-add-route">
        <button type="button" class="ghost-button ghost-button--small" id="voterTransportAddRouteBtn">Add trip…</button>
      </div>`
    : "";

  const candidateAgentSectionHtml = (() => {
    const showForCandidate = !!candCtx;
    const showForAdmin = !candCtx && getViewerIsAdmin();
    if (!showForCandidate && !showForAdmin) return "";

    const agentScopeId = (a) => {
      const raw = a && a.candidateId;
      if (raw === null || raw === undefined || raw === "") return "";
      const s = String(raw).trim();
      return s && s !== "undefined" && s !== "null" ? s : "";
    };
    const getAgentsForScope = (scopeId) => {
      const allAgents = getAgentsFromStorage();
      if (scopeId === ALL_CAMPAIGN_SCOPE_KEY) {
        return allAgents.filter((a) => !agentScopeId(a));
      }
      if (!scopeId) return [];
      return allAgents.filter((a) => agentScopeId(a) === String(scopeId));
    };
    const buildAgentOptions = (assignedName, scopeId = null) => {
      const agentOptionsList =
        scopeId == null
          ? filterAgentsForViewer(getAgentsFromStorage())
          : getAgentsForScope(scopeId);
      return (
        '<option value="">Unassigned</option>' +
        agentOptionsList
          .map(
            (a) =>
              `<option value="${escapeHtml(a.name)}"${
                a.name === assignedName ? " selected" : ""
              }>${escapeHtml(a.name)}</option>`
          )
          .join("")
      );
    };
    if (showForCandidate) {
      const agentMap = loadCandidateAgentAssignmentMap(candCtx.candidateId);
      const assignedName = getCandidateScopedAssignedAgentNameWithMap(
        voter,
        candCtx.candidateId,
        agentMap
      );
      const candidateAgents = getCandidateAssignableAgents(candCtx.candidateId);
      const agentOptions =
        '<option value="">Unassigned</option>' +
        candidateAgents
          .map(
            (a) =>
              `<option value="${escapeHtml(a.name)}"${
                a.name === assignedName ? " selected" : ""
              }>${escapeHtml(a.name)}</option>`
          )
          .join("") +
        (assignedName &&
        !candidateAgents.some(
          (a) => String(a?.name || "").trim().toLowerCase() === assignedName.toLowerCase()
        )
          ? `<option value="${escapeHtml(assignedName)}" selected>${escapeHtml(assignedName)}</option>`
          : "");
      return `
      <section class="voter-details-section voter-details-section--full voter-details-section--agent">
        <h3 class="voter-details-section__title">Assigned agent — All Campaign</h3>
        <div class="details-grid details-grid--two-column">
          <div>
            <div class="detail-item-label">Candidate scope</div>
            <div class="detail-item-value">
              <div class="field-group">
                <label class="sr-only">Candidate for assignment</label>
                <select class="agent-dropdown-select agent-dropdown-select--modal" aria-label="Candidate for agent assignment" disabled>
                  <option value="${escapeHtml(String(candCtx.candidateId))}" selected>${escapeHtml(candidateLabelById(candCtx.candidateId))}</option>
                </select>
              </div>
              <p class="helper-text" style="margin-top:6px;">Uses the same per-candidate assignments as Reports → pledged voters.</p>
            </div>
          </div>
          <div class="voter-details-agent-col">
            <div class="detail-item-label">Agent</div>
            <div class="detail-item-value detail-item-value--agent-stack">
              <div class="field-group">
                <label for="candidateVoterAgentSearch" class="sr-only">Search agent</label>
                <div class="voter-agent-dropdown" id="candidateVoterAgentDropdown">
                  <input id="candidateVoterAgentSearch" class="input agent-modal-voter-search-input voter-agent-dropdown__search" placeholder="Search and pick agent…" value="${escapeHtml(assignedName)}" aria-label="Search agent from list" autocomplete="off" spellcheck="false">
                  <div class="voter-agent-dropdown__menu" id="candidateVoterAgentMenu" role="listbox" aria-label="Agents"></div>
                </div>
              </div>
              <select id="candidateVoterAgentSelect" style="display:none" aria-hidden="true" tabindex="-1">
                ${agentOptions}
              </select>
              <button type="button" class="ghost-button ghost-button--small voter-details-agent-add-btn" id="candidateVoterAddAgentBtn">Add new agent…</button>
              <p class="helper-text voter-details-agent-hint">Candidate scope is fixed to your login. New agents must use a proper full name (first and last).</p>
            </div>
          </div>
        </div>
      </section>`;
    }

    // Admin: same assignments as Reports → pledged voters, plus all-campaign global agent.
    const candidatesList = getCandidatesListFromStorage();

    let scopeSession = "";
    try {
      scopeSession = sessionStorage.getItem(VOTER_DETAIL_AGENT_SCOPE_KEY) || "";
    } catch (_) {}
    let selectedScope = scopeSession;
    const scopeIsCandidate = candidatesList.some(
      (c) => String(c.id) === String(selectedScope)
    );
    if (!selectedScope || (selectedScope !== ALL_CAMPAIGN_SCOPE_KEY && !scopeIsCandidate)) {
      selectedScope = ALL_CAMPAIGN_SCOPE_KEY;
    }

    const scopeOptions =
      `<option value="${ALL_CAMPAIGN_SCOPE_KEY}"${
        selectedScope === ALL_CAMPAIGN_SCOPE_KEY ? " selected" : ""
      }>All campaign (general agents)</option>` +
      candidatesList
        .map((c) => {
          const id = String(c.id);
          return `<option value="${escapeHtml(id)}"${
            id === String(selectedScope) ? " selected" : ""
          }>${escapeHtml(c.name || id)}</option>`;
        })
        .join("");

    let assignedName = "";
    if (selectedScope === ALL_CAMPAIGN_SCOPE_KEY) {
      assignedName =
        typeof voter.volunteer === "string"
          ? voter.volunteer
          : voter?.volunteer?.name || "";
    } else if (selectedScope) {
      const docName =
        voter?.candidateAgentAssignments &&
        typeof voter.candidateAgentAssignments === "object"
          ? String(voter.candidateAgentAssignments[String(selectedScope)] || "")
          : "";
      if (docName) {
        assignedName = docName;
      } else {
        const key = candidatePledgedAgentStorageKey(selectedScope);
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const p = JSON.parse(raw);
            if (p && typeof p === "object") {
              for (const k of localStorageAgentMapKeysForVoter(voter)) {
                const n = p[k];
                if (n) {
                  assignedName = n;
                  break;
                }
              }
            }
          }
        } catch (_) {}
      }
    }

    const agentOptions = buildAgentOptions(assignedName, selectedScope);

    return `
      <section class="voter-details-section voter-details-section--full voter-details-section--agent">
        <h3 class="voter-details-section__title">Assigned agent — All Campaign</h3>
        <div class="details-grid details-grid--two-column">
          <div>
            <div class="detail-item-label">Candidate scope</div>
            <div class="detail-item-value">
              <div class="field-group">
                <label for="voterAgentCandidateScope" class="sr-only">Candidate for assignment</label>
                <select id="voterAgentCandidateScope" class="input" aria-label="Candidate for agent assignment">
                  ${scopeOptions}
                </select>
              </div>
              <p class="helper-text" style="margin-top:6px;">Uses the same per-candidate assignments as Reports → pledged voters.</p>
            </div>
          </div>
          <div class="voter-details-agent-col">
            <div class="detail-item-label">Agent</div>
            <div class="detail-item-value detail-item-value--agent-stack">
              <div class="field-group">
                <label for="candidateVoterAgentSearch" class="sr-only">Search agent</label>
                <div class="voter-agent-dropdown" id="candidateVoterAgentDropdown">
                  <input id="candidateVoterAgentSearch" class="input agent-modal-voter-search-input voter-agent-dropdown__search" placeholder="Search and pick agent…" value="${escapeHtml(assignedName)}" aria-label="Search agent from list" autocomplete="off" spellcheck="false">
                  <div class="voter-agent-dropdown__menu" id="candidateVoterAgentMenu" role="listbox" aria-label="Agents"></div>
                </div>
              </div>
              <select id="candidateVoterAgentSelect" style="display:none" aria-hidden="true" tabindex="-1">
                ${agentOptions}
              </select>
              <button type="button" class="ghost-button ghost-button--small voter-details-agent-add-btn" id="candidateVoterAddAgentBtn">Add new agent…</button>
              <p class="helper-text voter-details-agent-hint">Choose scope: All campaign shows general agents only. Candidate scope shows agents for that candidate.</p>
            </div>
          </div>
        </div>
      </section>`;
  })();

  const transportNoRoutesMsg = showAdminTransportAddRoute
    ? "No transport routes yet. Use “Add trip…” below or add trips in Zero Day → Transport."
    : "No transport routes yet. Add trips in Zero Day → Transport.";

  const transportSectionHtml = `
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
            <div class="detail-item-value voter-transport-route-value">
              ${
                availableRoutes.length
                  ? `<div class="field-group">
                       <label for="voterTransportRouteSearch" class="sr-only">Route</label>
                       <div class="voter-agent-dropdown" id="voterTransportRouteDropdown">
                         <input id="voterTransportRouteSearch" class="input agent-modal-voter-search-input voter-agent-dropdown__search" placeholder="Search and pick route…" value="${escapeHtml(
                           transportRoute
                         )}" aria-label="Search route from list" autocomplete="off" spellcheck="false"${
                           voter.transportNeeded ? "" : " disabled"
                         }>
                         <div class="voter-agent-dropdown__menu" id="voterTransportRouteMenu" role="listbox" aria-label="Routes"></div>
                       </div>
                       <select id="voterTransportRoute" style="display:none" aria-hidden="true" tabindex="-1">
                         <option value="">Select route…</option>
                         ${availableRoutesForUi
                           .map((route) => {
                             const isSelected = route === transportRoute;
                             return `<option value="${escapeHtml(route)}"${
                               isSelected ? " selected" : ""
                             }>${escapeHtml(route)}</option>`;
                           })
                           .join("")}
                       </select>
                     </div>
                     ${voterTransportAddRouteBtnHtml}
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
                     <p class="helper-text" style="margin-top:4px;">Search or open the list to pick a route, same as the agent field. Then choose one way or return.${
                       showAdminTransportAddRoute
                         ? " Admins can add trips without leaving this panel."
                         : ""
                     }</p>`
                  : `<p class="helper-text">${transportNoRoutesMsg}</p>
                     ${voterTransportAddRouteBtnHtml}`
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
      </section>`;

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

      ${statusSectionHtml}
      ${candidateAgentSectionHtml}
      ${transportSectionHtml}
    </div>
  `;

  // Agent notes: candidates may edit the same shared notes field as staff (saved on voter record).
  voterNotesTextarea.disabled = false;
  if (saveVoterNotesButton) {
    saveVoterNotesButton.style.display = "";
    saveVoterNotesButton.disabled = true;
  }
  voterNotesTextarea.value = voter.notes || "";
  if (voterNotesHelperEl) {
    voterNotesHelperEl.textContent = candCtx
      ? "Your edits save to this voter’s record. Agent comments are visible to campaign staff and administrators."
      : "Agent comments are visible to authorised campaign staff.";
  }

  const pledgePicker = document.querySelector(".candidate-pledge-picker");
  if (pledgePicker && candCtx) {
    pledgePicker.querySelectorAll("[data-candidate-pledge]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-candidate-pledge");
        if (val !== "yes" && val !== "no" && val !== "undecided") return;
        pledgePicker.querySelectorAll("[data-candidate-pledge]").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
        updateVoterCandidatePledge(voter.id, candCtx.candidateId, val);
      });
    });
  }

  const referendumPicker = document.querySelector(".voter-detail-referendum-picker");
  if (referendumPicker && candCtx) {
    referendumPicker.querySelectorAll("[data-referendum-vote]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-referendum-vote");
        if (val !== "yes" && val !== "no" && val !== "undecided") return;
        referendumPicker.querySelectorAll("[data-referendum-vote]").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
        updateVoterReferendumVote(voter.id, val);
      });
    });
  }
  const voterDetailRefNotes = document.getElementById("voterDetailReferendumNotes");
  if (voterDetailRefNotes && candCtx) {
    voterDetailRefNotes.addEventListener("blur", () => {
      updateVoterReferendumNotes(voter.id, voterDetailRefNotes.value);
    });
  }

  function setupCandidateAgentDropdown({ agentSel, agentSearchInput, menuEl, getAgents }) {
    if (!agentSel || !agentSearchInput || !menuEl) return;
    const toNorm = (s) => String(s || "").trim().toLowerCase();
    const initialsFromName = (name) => {
      const out = String(name || "")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join("");
      return out || "?";
    };
    const imgOnError =
      "var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';";

    const renderMenu = () => {
      if (agentSearchInput.disabled) {
        menuEl.style.display = "none";
        return;
      }
      const q = toNorm(agentSearchInput.value);
      const list = (typeof getAgents === "function" ? getAgents() : [])
        .filter((a) => {
          if (!q) return true;
          const name = toNorm(a?.name);
          const nationalId = toNorm(a?.nationalId);
          const phone = toNorm(a?.phone);
          return name.includes(q) || nationalId.includes(q) || phone.includes(q);
        })
        .slice(0, 40);
      if (!list.length) {
        menuEl.innerHTML =
          '<div class="voter-agent-dropdown__empty">No matching agents.</div>';
        menuEl.style.display = "block";
        return;
      }
      menuEl.innerHTML = list
        .map((a) => {
          const photoSrc = getVoterImageSrc({ nationalId: a?.nationalId || a?.id || "" });
          const name = String(a?.name || "");
          const nationalId = String(a?.nationalId || "—");
          const phone = String(a?.phone || "—");
          const initials = initialsFromName(name);
          const photoHtml = photoSrc
            ? `<div class="avatar-cell avatar-cell--settings-agent"><img class="avatar-img" src="${escapeHtml(photoSrc)}" alt="" onerror="${imgOnError}"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(initials)}</div></div>`
            : `<div class="avatar-cell avatar-cell--settings-agent"><div class="avatar-circle">${escapeHtml(initials)}</div></div>`;
          return `<button type="button" class="voter-agent-dropdown__item" data-agent-name="${escapeHtml(name)}">
            ${photoHtml}
            <span class="voter-agent-dropdown__main">${escapeHtml(name)}</span>
            <span class="voter-agent-dropdown__meta">ID: ${escapeHtml(nationalId)} | ${escapeHtml(phone)}</span>
          </button>`;
        })
        .join("");
      menuEl.style.display = "block";
    };

    const root = document.getElementById("candidateVoterAgentDropdown");
    const hideMenu = () => {
      menuEl.style.display = "none";
    };

    agentSearchInput.addEventListener("focus", renderMenu);
    agentSearchInput.addEventListener("input", renderMenu);
    root?.addEventListener("focusout", () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!root.contains(active)) hideMenu();
      }, 0);
    });
    menuEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-agent-name]");
      if (!btn) return;
      const selected = String(btn.getAttribute("data-agent-name") || "");
      agentSearchInput.value = selected;
      agentSel.value = selected;
      agentSel.dispatchEvent(new Event("change"));
      hideMenu();
    });
  }

  if (candCtx) {
    const agentSel = document.getElementById("candidateVoterAgentSelect");
    const agentSearchInput = document.getElementById("candidateVoterAgentSearch");
    const agentMenu = document.getElementById("candidateVoterAgentMenu");
    setupCandidateAgentDropdown({
      agentSel,
      agentSearchInput,
      menuEl: agentMenu,
      getAgents: () => getCandidateAssignableAgents(candCtx.candidateId),
    });
    function applyAgentFromSearch() {
      if (!agentSel || !agentSearchInput) return;
      const q = String(agentSearchInput.value || "").trim();
      if (!q) {
        agentSel.value = "";
        agentSel.dispatchEvent(new Event("change"));
        return;
      }
      const list = getCandidateAssignableAgents(candCtx.candidateId);
      const exact =
        list.find((a) => String(a.name || "").trim().toLowerCase() === q.toLowerCase()) ||
        list.find((a) => String(a.name || "").trim().toLowerCase().includes(q.toLowerCase()));
      if (!exact) {
        if (window.appNotifications) {
          window.appNotifications.push({ title: "Agent not found", meta: "Pick an agent from the list." });
        }
        return;
      }
      agentSearchInput.value = exact.name || "";
      agentSel.value = exact.name || "";
      agentSel.dispatchEvent(new Event("change"));
    }
    agentSearchInput?.addEventListener("input", () => {
      if (!agentSearchInput || !agentSel) return;
      const q = String(agentSearchInput.value || "").trim().toLowerCase();
      if (!q) return;
      const list = getCandidateAssignableAgents(candCtx.candidateId);
      const exact = list.find((a) => String(a.name || "").trim().toLowerCase() === q);
      if (exact) {
        agentSel.value = exact.name || "";
        agentSel.dispatchEvent(new Event("change"));
      }
    });
    agentSearchInput?.addEventListener("change", applyAgentFromSearch);
    if (agentSel) {
      agentSel.addEventListener("change", async () => {
        const v = findVoterById(voter.id);
        if (!v) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Could not save assignment",
              meta: "Voter not found in the list.",
            });
          }
          return;
        }
        const cid = String(candCtx.candidateId);
        const prevAssignments = {
          ...(v.candidateAgentAssignments && typeof v.candidateAgentAssignments === "object"
            ? v.candidateAgentAssignments
            : {}),
        };
        const prevIds = {
          ...(v.candidateAgentAssignmentIds && typeof v.candidateAgentAssignmentIds === "object"
            ? v.candidateAgentAssignmentIds
            : {}),
        };
        const prevName = String(prevAssignments[cid] ?? "");
        const prevAgentId = String(prevIds[cid] ?? "");

        if (!v.candidateAgentAssignments || typeof v.candidateAgentAssignments !== "object") {
          v.candidateAgentAssignments = {};
        }
        if (!v.candidateAgentAssignmentIds || typeof v.candidateAgentAssignmentIds !== "object") {
          v.candidateAgentAssignmentIds = {};
        }
        const selectedName = agentSel.value || "";
        const selectedAgent =
          getCandidateAssignableAgents(candCtx.candidateId).find(
            (a) => String(a?.name || "").trim() === String(selectedName).trim()
          ) || null;
        v.candidateAgentAssignments[cid] = selectedName;
        v.candidateAgentAssignmentIds[cid] =
          selectedAgent && selectedAgent.id != null ? String(selectedAgent.id) : "";

        const ok = await saveVoterToFirestoreWithNotification(v, "Agent assignment not saved to cloud");
        if (!ok) {
          v.candidateAgentAssignments = { ...prevAssignments };
          v.candidateAgentAssignmentIds = { ...prevIds };
          const revertLabel = prevName;
          agentSel.value = revertLabel;
          if (agentSearchInput) agentSearchInput.value = revertLabel;
          return;
        }

        mirrorCandidatePledgedAgentLocalMap(candCtx.candidateId, v.id, selectedName);
        saveVotersToStorage();
        document.dispatchEvent(new CustomEvent("voters-updated"));
        document.dispatchEvent(new CustomEvent("pledges-updated"));
      });
    }
    const addAgentBtn = document.getElementById("candidateVoterAddAgentBtn");
    if (addAgentBtn) {
      addAgentBtn.addEventListener("click", () => {
        callOpenAddAgentModal({ lockCandidateId: candCtx.candidateId });
      });
    }
  } else if (getViewerIsAdmin()) {
    const scopeSel = document.getElementById("voterAgentCandidateScope");
    if (scopeSel) {
      scopeSel.addEventListener("change", () => {
        try {
          sessionStorage.setItem(VOTER_DETAIL_AGENT_SCOPE_KEY, scopeSel.value || "");
        } catch (_) {}
        const v = findVoterById(voter.id);
        if (v && sameVoterId(selectedVoterId, v.id)) renderVoterDetails(v);
      });
    }
    const agentSel = document.getElementById("candidateVoterAgentSelect");
    const agentSearchInput = document.getElementById("candidateVoterAgentSearch");
    const agentMenu = document.getElementById("candidateVoterAgentMenu");
    const adminAgentsForScope = () => {
      const scopeId = scopeSel?.value?.trim() || "";
      const allAgents = getAgentsFromStorage();
      const scopeOf = (a) => {
        const raw = a && a.candidateId;
        if (raw === null || raw === undefined || raw === "") return "";
        const s = String(raw).trim();
        return s && s !== "undefined" && s !== "null" ? s : "";
      };
      if (scopeId === ALL_CAMPAIGN_SCOPE_KEY) return allAgents.filter((a) => !scopeOf(a));
      return allAgents.filter((a) => scopeOf(a) === scopeId);
    };
    setupCandidateAgentDropdown({
      agentSel,
      agentSearchInput,
      menuEl: agentMenu,
      getAgents: adminAgentsForScope,
    });
    function applyAgentFromSearch() {
      if (!agentSel || !agentSearchInput || agentSel.disabled) return;
      const q = String(agentSearchInput.value || "").trim();
      if (!q) {
        agentSel.value = "";
        agentSel.dispatchEvent(new Event("change"));
        return;
      }
      const list = adminAgentsForScope();
      const exact =
        list.find((a) => String(a.name || "").trim().toLowerCase() === q.toLowerCase()) ||
        list.find((a) => String(a.name || "").trim().toLowerCase().includes(q.toLowerCase()));
      if (!exact) {
        if (window.appNotifications) {
          window.appNotifications.push({ title: "Agent not found", meta: "Pick an agent from the list." });
        }
        return;
      }
      agentSearchInput.value = exact.name || "";
      agentSel.value = exact.name || "";
      agentSel.dispatchEvent(new Event("change"));
    }
    agentSearchInput?.addEventListener("input", () => {
      if (!agentSearchInput || !agentSel || agentSel.disabled) return;
      const q = String(agentSearchInput.value || "").trim().toLowerCase();
      if (!q) return;
      const list = adminAgentsForScope();
      const exact = list.find((a) => String(a.name || "").trim().toLowerCase() === q);
      if (exact) {
        agentSel.value = exact.name || "";
        agentSel.dispatchEvent(new Event("change"));
      }
    });
    agentSearchInput?.addEventListener("change", applyAgentFromSearch);
    if (agentSel) {
      agentSel.addEventListener("change", async () => {
        const scopeId = scopeSel?.value?.trim() || "";
        const v = findVoterById(voter.id);
        if (!v) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Could not save assignment",
              meta: "Voter not found in the list.",
            });
          }
          return;
        }

        const prevVolunteer = v.volunteer;
        const prevAssignments = {
          ...(v.candidateAgentAssignments && typeof v.candidateAgentAssignments === "object"
            ? v.candidateAgentAssignments
            : {}),
        };
        const prevIds = {
          ...(v.candidateAgentAssignmentIds && typeof v.candidateAgentAssignmentIds === "object"
            ? v.candidateAgentAssignmentIds
            : {}),
        };

        if (!v.candidateAgentAssignments || typeof v.candidateAgentAssignments !== "object") {
          v.candidateAgentAssignments = {};
        }
        if (!v.candidateAgentAssignmentIds || typeof v.candidateAgentAssignmentIds !== "object") {
          v.candidateAgentAssignmentIds = {};
        }
        const selectedName = agentSel.value || "";
        const selectedAgent =
          adminAgentsForScope().find(
            (a) => String(a?.name || "").trim() === String(selectedName).trim()
          ) || null;

        if (scopeId === ALL_CAMPAIGN_SCOPE_KEY) {
          v.volunteer = selectedName || "";
        } else if (scopeId) {
          v.candidateAgentAssignments[String(scopeId)] = selectedName || "";
          v.candidateAgentAssignmentIds[String(scopeId)] =
            selectedAgent && selectedAgent.id != null ? String(selectedAgent.id) : "";
        }

        const ok = await saveVoterToFirestoreWithNotification(v, "Agent assignment not saved to cloud");
        if (!ok) {
          v.volunteer = prevVolunteer;
          v.candidateAgentAssignments = { ...prevAssignments };
          v.candidateAgentAssignmentIds = { ...prevIds };
          const prevDisplay =
            scopeId === ALL_CAMPAIGN_SCOPE_KEY
              ? typeof prevVolunteer === "string"
                ? prevVolunteer
                : prevVolunteer?.name || ""
              : String(prevAssignments[scopeId] || "");
          agentSel.value = prevDisplay;
          if (agentSearchInput) agentSearchInput.value = prevDisplay;
          return;
        }

        if (scopeId && scopeId !== ALL_CAMPAIGN_SCOPE_KEY) {
          mirrorCandidatePledgedAgentLocalMap(scopeId, v.id, selectedName);
        }
        saveVotersToStorage();
        document.dispatchEvent(new CustomEvent("voters-updated"));
        document.dispatchEvent(new CustomEvent("pledges-updated"));
      });
    }
    const addAgentBtn = document.getElementById("candidateVoterAddAgentBtn");
    if (addAgentBtn) {
      addAgentBtn.addEventListener("click", () => {
        const scopeId = scopeSel?.value?.trim() || "";
        if (scopeId === ALL_CAMPAIGN_SCOPE_KEY) callOpenAddAgentModal({});
        else callOpenAddAgentModal({ lockCandidateId: scopeId });
      });
    }
  }

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

  // Bind transportation (admin, staff, and candidate)
  const transportNeededEl = document.getElementById("voterTransportNeeded");
  const transportRouteEl = document.getElementById("voterTransportRoute");
  const transportRouteSearch = document.getElementById("voterTransportRouteSearch");
  const transportRouteMenu = document.getElementById("voterTransportRouteMenu");
  const transportTypeEls = Array.from(
    document.querySelectorAll("[data-transport-type]")
  );
  if (transportNeededEl && transportRouteEl) {
    const getRoutesForDropdown = () => {
      const v = findVoterById(voter.id) || voter;
      const routes = getAvailableTransportRoutes();
      const cur = (v.transportRoute || "").trim();
      const set = new Set(routes);
      if (cur) set.add(cur);
      return Array.from(set).sort((a, b) => a.localeCompare(b, "en"));
    };

    const updateRoutesDisabled = () => {
      const disabled = !transportNeededEl.checked;
      transportRouteEl.disabled = disabled;
      if (transportRouteSearch) transportRouteSearch.disabled = disabled;
      transportTypeEls.forEach((el) => {
        el.disabled = disabled;
      });
    };

    const persistTransport = () => {
      const v = findVoterById(voter.id);
      if (!v) return;
      v.transportNeeded = !!transportNeededEl.checked;
      v.transportRoute = transportRouteEl.value || "";
      if (transportRouteSearch && !transportRouteSearch.disabled) {
        transportRouteSearch.value = v.transportRoute;
      }
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
        if (sameVoterId(selectedVoterId, v.id)) renderVoterDetails(v);
        document.dispatchEvent(new CustomEvent("voters-updated"));
      })();
    };

    updateRoutesDisabled();
    if (transportRouteSearch && transportRouteMenu) {
      setupTransportRouteSearchDropdown({
        routeSel: transportRouteEl,
        routeSearchInput: transportRouteSearch,
        menuEl: transportRouteMenu,
        getRoutes: getRoutesForDropdown,
        persistTransport,
      });
    }
    transportNeededEl.addEventListener("change", () => {
      updateRoutesDisabled();
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
  } else if (transportNeededEl && !transportRouteEl) {
    // No routes in list yet — still persist “transport needed” toggles
    transportNeededEl.addEventListener("change", () => {
      const v = findVoterById(voter.id);
      if (!v) return;
      v.transportNeeded = !!transportNeededEl.checked;
      (async () => {
        try {
          const api = await firebaseInitPromise;
          if (api.ready && api.setVoterFs) await api.setVoterFs(v);
        } catch (_) {}
        saveVotersToStorage();
        renderVotersTable();
        if (sameVoterId(selectedVoterId, v.id)) renderVoterDetails(v);
        document.dispatchEvent(new CustomEvent("voters-updated"));
      })();
    });
  }

  const addTransportRouteBtn = document.getElementById("voterTransportAddRouteBtn");
  if (addTransportRouteBtn) {
    addTransportRouteBtn.addEventListener("click", () =>
      openVoterDetailAddTransportRouteModal(voter)
    );
  }
}

function selectVoter(voterId) {
  selectedVoterId = voterId;
  renderVotersTable();
  const voter = findVoterById(voterId);
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
  if (voterFilterAgentEl) voterFilterAgentEl.addEventListener("change", go);
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
    const voter = findVoterById(selectedVoterId);
    if (!voter) return;
    voter.notes = voterNotesTextarea ? voterNotesTextarea.value : "";
    saveVoterNotesButton.disabled = true;
    (async () => {
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.setVoterFs) await api.setVoterFs(voter);
      } catch (_) {}
      saveVotersToStorage();
      if (sameVoterId(selectedVoterId, voter.id)) renderVoterDetails(voter);
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
            <label for="voterFormSequence">Sequence <span class="text-muted">(ballot box only, not an ID)</span></label>
            <input id="voterFormSequence" type="text" value="${escapeHtml(
              sequenceAsImportedFromCsv(v)
            )}" placeholder="e.g. 47 or 582" inputmode="text" autocomplete="off">
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
  const u = typeof getCurrentUserFn === "function" ? getCurrentUserFn() : null;
  if (u?.role === "candidate" && u?.candidateId) return;
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
    const sequence = ballotSequenceText(body.querySelector("#voterFormSequence")?.value ?? "");
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
      if (sameVoterId(selectedVoterId, existingVoter.id)) renderVoterDetails(existingVoter);
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
      if (isEdit && sameVoterId(selectedVoterId, existingVoter?.id)) renderVoterDetails(existingVoter);
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
  const u = typeof getCurrentUserFn === "function" ? getCurrentUserFn() : null;
  if (u?.role === "candidate" && u?.candidateId) return;
  const voter = findVoterById(voterId);
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
      const idx = currentVoters.findIndex((v) => sameVoterId(v.id, voterId));
      if (idx !== -1) currentVoters.splice(idx, 1);
      if (sameVoterId(selectedVoterId, voterId)) {
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

export async function initVotersModule(getCurrentUser, options = {}) {
  getCurrentUserFn = typeof getCurrentUser === "function" ? getCurrentUser : () => null;
  openAddAgentModalRef =
    typeof options.openAddAgentModal === "function" ? options.openAddAgentModal : null;
  seedCandidatesCacheFromStorage();
  const votersTableLoader = document.getElementById("votersTableLoader");
  if (votersTableLoader) votersTableLoader.hidden = false;

  bindVoterTableHeaderSort();

  // Refresh Voted column when ballot box link (or Zero Day) marks voters as voted
  document.addEventListener("voted-entries-updated", () => renderVotersTable());

  document.addEventListener("agents-updated", () => {
    if (getCandidateContext()) {
      refreshVoterFilterAgentOptions();
      renderVotersTable();
    }
    if (selectedVoterId) {
      const v = findVoterById(selectedVoterId);
      if (v) renderVoterDetails(v);
    }
  });

  document.addEventListener("transport-trips-updated", () => {
    if (selectedVoterId) {
      const v = findVoterById(selectedVoterId);
      if (v) renderVoterDetails(v);
    }
  });

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
        const voter = findVoterById(id);
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
        const voter = findVoterById(id);
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
          if (sameVoterId(selectedVoterId, id)) renderVoterDetails(voter);
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
        currentVoters = initial.map(normalizeVoterCandidateFields);
        saveVotersToStorage();
        mergeVotedAtFromVoters(initial);
      } else {
        loadVotersFromStorage();
      }

      renderVotersTable();
      renderVoterDetails(null);

      unsubscribeVotersFs = api.onVotersSnapshotFs((items) => {
        if (votersBulkImportInProgress) return;
        if (Array.isArray(items)) {
          currentVoters = items.map(normalizeVoterCandidateFields);
          mergeVotedAtFromVoters(items);
          renderVotersTable();
          const selected =
            selectedVoterId &&
            findVoterById(selectedVoterId);
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

  // Backfill legacy candidate-local assignment maps into voter docs for cross-login visibility.
  syncCandidateAgentAssignmentsFromLocalMaps().catch(() => {});

  registerAutoSyncLocalVotersWhenOnline();

  return {
    getAllVoters: () => [...currentVoters],
  };
}

/** Reload voters from storage and re-render; dispatches voters-updated for pledges etc. */
export function refreshVotersFromStorage() {
  loadVotersFromStorage();
  if (selectedVoterId && !currentVoters.some((v) => sameVoterId(v.id, selectedVoterId))) {
    selectedVoterId = null;
  }
  renderVotersTable();
  const selected = selectedVoterId
    ? findVoterById(selectedVoterId) || null
    : null;
  renderVoterDetails(selected);
  document.dispatchEvent(new CustomEvent("voters-updated"));
}

/** Pull latest voter list from Firestore, persist, merge voted times, re-render (header hard refresh). */
export async function refreshVotersFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getAllVotersFs) {
      refreshVotersFromStorage();
      return;
    }
    const items = await api.getAllVotersFs();
    if (!Array.isArray(items)) {
      refreshVotersFromStorage();
      return;
    }
    currentVoters = items.map(normalizeVoterCandidateFields);
    saveVotersToStorage();
    mergeVotedAtFromVoters(items);
    renderVotersTable();
    const selected = selectedVoterId
      ? findVoterById(selectedVoterId) || null
      : null;
    renderVoterDetails(selected);
    document.dispatchEvent(new CustomEvent("voters-updated"));
  } catch (err) {
    console.error("[Voters] refreshVotersFromFirestore", err);
    refreshVotersFromStorage();
  }
}

/** localStorage: when "1", reconnecting to the network triggers a merge sync (see registerAutoSyncLocalVotersWhenOnline). */
export const AUTO_SYNC_LOCAL_VOTERS_ONLINE_KEY = "autoSyncLocalVotersWhenOnline";

/**
 * Push all voters from this browser’s local cache to Firestore (`setDoc` merge per voter id).
 * Use after offline work or on a laptop that had not synced — requires signed-in user.
 * @param {{ silent?: boolean, notify?: boolean }} [opts] — `notify: false` skips in-app toasts (for custom UI).
 */
export async function syncLocalVotersToFirebase(opts = {}) {
  const { silent = false, notify = true } = opts;
  loadVotersFromStorage();
  const voters = currentVoters.filter((v) => v && v.id != null && String(v.id).trim() !== "");
  if (voters.length === 0) {
    if (!silent && notify && window.appNotifications) {
      window.appNotifications.push({
        title: "No local voters to sync",
        meta: "There are no voters stored in this browser.",
      });
    }
    return { ok: false, count: 0, error: "empty" };
  }

  try {
    const api = await firebaseInitPromise;
    if (!api.ready || typeof api.setVotersBatchFs !== "function") {
      if (!silent && notify && window.appNotifications) {
        window.appNotifications.push({
          title: "Sync unavailable",
          meta: "Firebase is not ready. Check your network or configuration.",
        });
      }
      return { ok: false, count: 0, error: "firebase" };
    }
    if (!api.auth?.currentUser) {
      if (!silent && notify && window.appNotifications) {
        window.appNotifications.push({
          title: "Sign in required",
          meta: "Sign in to the campaign, then sync again.",
        });
      }
      return { ok: false, count: 0, error: "auth" };
    }

    const normalized = voters.map(normalizeVoterCandidateFields);
    await api.setVotersBatchFs(normalized);
    await refreshVotersFromFirestore();

    if (!silent && notify && window.appNotifications) {
      window.appNotifications.push({
        title: "Voters synced to Firebase",
        meta: `${normalized.length.toLocaleString("en-MV")} local voters merged to Firestore.`,
      });
    }
    return { ok: true, count: normalized.length };
  } catch (err) {
    console.error("[Voters] syncLocalVotersToFirebase", err);
    if (!silent && notify && window.appNotifications) {
      window.appNotifications.push({
        title: "Sync failed",
        meta: err?.message || String(err),
      });
    }
    return { ok: false, count: 0, error: "exception", message: err?.message };
  }
}

function registerAutoSyncLocalVotersWhenOnline() {
  if (registerAutoSyncLocalVotersWhenOnline._done) return;
  registerAutoSyncLocalVotersWhenOnline._done = true;
  window.addEventListener("online", () => {
    try {
      if (localStorage.getItem(AUTO_SYNC_LOCAL_VOTERS_ONLINE_KEY) !== "1") return;
      syncLocalVotersToFirebase({ silent: true, notify: false }).then((r) => {
        if (r.ok && window.appNotifications) {
          window.appNotifications.push({
            title: "Back online — voters synced",
            meta: `${r.count.toLocaleString("en-MV")} local records merged to Firebase.`,
          });
        }
      });
    } catch (_) {}
  });
}

export function getVoterStats(scope) {
  const totalVoters = currentVoters.length;
  const pledgedCount = currentVoters.filter(
    (v) => v.pledgeStatus === "yes"
  ).length;
  const byNationalId = new Map();
  currentVoters.forEach((v) => {
    const nid = String(v.nationalId || "").trim();
    if (!nid) return;
    byNationalId.set(nid, (byNationalId.get(nid) || 0) + 1);
  });
  let duplicateNationalIdRows = 0;
  byNationalId.forEach((c) => {
    if (c > 1) duplicateNationalIdRows += c - 1;
  });
  return {
    totalVoters,
    pledgedCount,
    distinctNationalIds: byNationalId.size,
    duplicateNationalIdRows,
  };
}

function scoreVoterForDuplicateKeep(v) {
  let s = 0;
  if (v.votedAt && String(v.votedAt).trim()) s += 1_000_000;
  if (v.pledgeStatus === "yes") s += 10_000;
  if (v.pledgeStatus === "no") s += 100;
  if (v.fullName && String(v.fullName).trim()) s += 10;
  if (v.phone && String(v.phone).trim()) s += 1;
  if (v.permanentAddress && String(v.permanentAddress).trim()) s += 1;
  return s;
}

function pickVoterToKeepDuplicateGroup(group) {
  if (group.length === 0) return null;
  if (group.length === 1) return group[0];
  let best = group[0];
  let bestScore = scoreVoterForDuplicateKeep(best);
  for (let i = 1; i < group.length; i++) {
    const v = group[i];
    const sc = scoreVoterForDuplicateKeep(v);
    if (sc > bestScore || (sc === bestScore && String(v.id) < String(best.id))) {
      best = v;
      bestScore = sc;
    }
  }
  return best;
}

function analyzeDuplicateVotersByNationalId() {
  const groups = new Map();
  for (const v of currentVoters) {
    const key = normalizeNationalIdForDedup(v.nationalId);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  let duplicateGroups = 0;
  const idsToRemove = [];
  for (const [, arr] of groups) {
    if (arr.length < 2) continue;
    duplicateGroups += 1;
    const keeper = pickVoterToKeepDuplicateGroup(arr);
    for (const v of arr) {
      if (String(v.id) !== String(keeper.id)) idsToRemove.push(String(v.id));
    }
  }
  return { duplicateGroups, idsToRemove };
}

/**
 * Deletes extra voter rows that share the same national ID (trimmed, internal spaces collapsed).
 * Keeps one row per national ID: prefers voted status, pledge, and fuller records; tie-break by lowest internal id.
 */
export async function removeDuplicateVotersByNationalId() {
  const u = typeof getCurrentUserFn === "function" ? getCurrentUserFn() : null;
  if (u?.role === "candidate" && u?.candidateId) {
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Not available",
        meta: "Only staff can remove duplicate voters.",
      });
    }
    return { removed: 0, duplicateGroups: 0 };
  }

  const { duplicateGroups, idsToRemove } = analyzeDuplicateVotersByNationalId();
  if (idsToRemove.length === 0) {
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "No duplicate voters",
        meta: "No two rows share the same national ID (after trim).",
      });
    }
    return { removed: 0, duplicateGroups: 0 };
  }

  const ok = await confirmDialog({
    title: "Remove duplicate voters?",
    message: `Found ${duplicateGroups} national ID(s) with more than one row. ${idsToRemove.length} duplicate row(s) will be deleted. For each national ID, one row is kept (preferring voted status, pledge, and more complete data).`,
    confirmText: "Remove duplicates",
    cancelText: "Cancel",
    danger: true,
  });
  if (!ok) return { removed: 0, duplicateGroups };

  const idsSet = new Set(idsToRemove);
  try {
    const api = await firebaseInitPromise;
    const chunkSize = 25;
    for (let i = 0; i < idsToRemove.length; i += chunkSize) {
      const chunk = idsToRemove.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map((id) => {
          if (api.ready && api.deleteVoterFs) return api.deleteVoterFs(id);
          return Promise.resolve();
        })
      );
    }
  } catch (err) {
    console.error("[Voters] removeDuplicateVotersByNationalId Firestore", err);
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Some remote deletes may have failed",
        meta: "Duplicates were removed locally. Sync or check Firebase if counts do not match.",
      });
    }
  }

  currentVoters = currentVoters.filter((v) => !idsSet.has(String(v.id)));
  if (selectedVoterId != null && idsSet.has(String(selectedVoterId))) {
    selectedVoterId = null;
  }
  saveVotersToStorage();
  renderVotersTable();
  const selAfter =
    selectedVoterId != null
      ? currentVoters.find((v) => String(v.id) === String(selectedVoterId)) || null
      : null;
  renderVoterDetails(selAfter);
  document.dispatchEvent(new CustomEvent("voters-updated"));

  if (window.appNotifications) {
    window.appNotifications.push({
      title: "Duplicates removed",
      meta: `${idsToRemove.length.toLocaleString("en-MV")} duplicate row(s) removed.`,
    });
  }

  return { removed: idsToRemove.length, duplicateGroups };
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

/** Backfill legacy candidate-local agent assignment maps into voter docs (shared for admin/candidates). */
async function syncCandidateAgentAssignmentsFromLocalMaps() {
  const CAND_ASSIGN_PREFIX = "candidatePledgedAgentAssignments:v2:";
  const normalizeName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const agentsByNormName = new Map(
    filterAgentsForViewer(getAgentsFromStorage()).map((a) => [normalizeName(a?.name), String(a?.id ?? "")])
  );
  const findVoterForLegacyMapKey = (mapKey) => {
    const k = String(mapKey || "").trim();
    if (!k) return null;
    let voter = currentVoters.find((x) => String(x.id) === k);
    if (voter) return voter;
    const norm = normalizeNationalIdForDedup(k);
    if (!norm) return null;
    return currentVoters.find((x) => normalizeNationalIdForDedup(x.nationalId) === norm) || null;
  };

  const updatesByVoterId = new Map(); // canonical voter.id -> { [candidateId]: agentName }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) || "";
    if (!key.startsWith(CAND_ASSIGN_PREFIX)) continue;
    const candidateId = key.slice(CAND_ASSIGN_PREFIX.length);
    if (!candidateId) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const map = JSON.parse(raw);
      if (!map || typeof map !== "object") continue;
      Object.entries(map).forEach(([mapKey, assignedName]) => {
        const voter = findVoterForLegacyMapKey(mapKey);
        if (!voter) return;
        const vid = String(voter.id);
        const name = String(assignedName || "");
        if (!updatesByVoterId.has(vid)) updatesByVoterId.set(vid, {});
        updatesByVoterId.get(vid)[String(candidateId)] = name;
      });
    } catch (_) {}
  }
  if (updatesByVoterId.size === 0) return 0;

  const changed = [];
  updatesByVoterId.forEach((candidateMap, voterId) => {
    const voter = currentVoters.find((x) => String(x.id) === String(voterId));
    if (!voter) return;
    const existing =
      voter.candidateAgentAssignments && typeof voter.candidateAgentAssignments === "object"
        ? { ...voter.candidateAgentAssignments }
        : {};
    const existingIds =
      voter.candidateAgentAssignmentIds && typeof voter.candidateAgentAssignmentIds === "object"
        ? { ...voter.candidateAgentAssignmentIds }
        : {};
    let touched = false;
    Object.entries(candidateMap).forEach(([cid, name]) => {
      const next = String(name || "");
      if (String(existing[cid] || "") !== next) {
        existing[cid] = next;
        touched = true;
      }
      const resolvedId = agentsByNormName.get(normalizeName(next)) || "";
      if (resolvedId && String(existingIds[cid] || "") !== String(resolvedId)) {
        existingIds[cid] = String(resolvedId);
        touched = true;
      }
    });
    if (!touched) return;
    voter.candidateAgentAssignments = existing;
    voter.candidateAgentAssignmentIds = existingIds;
    changed.push(voter);
  });
  if (!changed.length) return 0;

  saveVotersToStorage();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setVoterFs) {
      await Promise.all(changed.map((v) => api.setVoterFs(v)));
    }
  } catch (_) {}
  document.dispatchEvent(new CustomEvent("voters-updated"));
  return changed.length;
}

/** Explicit sync pass used by topbar Refresh to push local candidate assignments to Firestore. */
export async function syncCandidateAssignmentsToFirebase() {
  const count = await syncCandidateAgentAssignmentsFromLocalMaps().catch(() => 0);
  return Number.isFinite(count) ? count : 0;
}

export function updateVoterPledgeStatus(voterId, pledgeStatus) {
  const v = findVoterById(voterId);
  if (!v) return;
  v.pledgeStatus = pledgeStatus;
  v.pledgedAt = pledgeStatus === "yes" ? new Date().toISOString().slice(0, 10) : "";
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) await api.setVoterFs(v);
      saveVotersToStorage();
      renderVotersTable();
      if (sameVoterId(selectedVoterId, voterId)) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

export function updateVoterTransportNeeded(voterId, transportNeeded) {
  const v = findVoterById(voterId);
  if (!v) return;
  v.transportNeeded = !!transportNeeded;
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) await api.setVoterFs(v);
      saveVotersToStorage();
      renderVotersTable();
      if (sameVoterId(selectedVoterId, voterId)) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

/** Referendum position: yes | no | undecided (stored on voter as `referendumVote`). */
export function updateVoterReferendumVote(voterId, referendumVote) {
  const v = findVoterById(voterId);
  if (!v) return;
  const next =
    referendumVote === "yes" || referendumVote === "no" ? referendumVote : "undecided";
  v.referendumVote = next;
  saveVotersToStorage();
  renderVotersTable();
  if (sameVoterId(selectedVoterId, voterId)) renderVoterDetails(v);
  document.dispatchEvent(new CustomEvent("voters-updated"));
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterReferendumVoteFs) {
        await api.setVoterReferendumVoteFs(voterId, next);
      } else if (api.ready && api.setVoterFs) {
        await api.setVoterFs(v);
      }
    } catch (_) {}
  })();
}

/** Free-text comment for referendum (stored as `referendumNotes` on the voter). */
export function updateVoterReferendumNotes(voterId, referendumNotes) {
  const v = findVoterById(voterId);
  if (!v) return;
  v.referendumNotes = referendumNotes == null ? "" : String(referendumNotes);
  saveVotersToStorage();
  renderVotersTable();
  if (sameVoterId(selectedVoterId, voterId)) renderVoterDetails(v);
  document.dispatchEvent(new CustomEvent("voters-updated"));
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterReferendumNotesFs) {
        await api.setVoterReferendumNotesFs(voterId, v.referendumNotes);
      } else if (api.ready && api.setVoterFs) {
        await api.setVoterFs(v);
      }
    } catch (_) {}
  })();
}

/**
 * Open the existing Voter Details panel as a modal popup (no navigation/scroll jump).
 * This moves `#voterDetailsPanel` into the shared modal shell, then restores it on close.
 */
export function openVoterDetailsPopup(voterId) {
  const voter = currentVoters.find((x) => String(x.id) === String(voterId));
  if (!voter) {
    openModal({
      title: "Voter Details",
      body: (() => {
        const d = document.createElement("div");
        d.className = "helper-text";
        d.style.padding = "12px 0";
        d.textContent = "Voter not found.";
        return d;
      })(),
    });
    return;
  }

  // Render details into the voters module panel first.
  selectedVoterId = voter.id;
  renderVoterDetails(voter);

  const panel = document.getElementById("voterDetailsPanel");
  if (!panel) {
    openModal({
      title: "Voter Details",
      body: (() => {
        const d = document.createElement("div");
        d.className = "helper-text";
        d.style.padding = "12px 0";
        d.textContent = "Voter details UI not available.";
        return d;
      })(),
    });
    return;
  }

  const modalBackdrop = document.getElementById("modalBackdrop");
  const originalParent = panel.parentElement;
  if (!originalParent) return;

  const placeholder = document.createElement("div");
  placeholder.style.display = "none";

  const next = panel.nextSibling;
  originalParent.insertBefore(placeholder, next);

  // Move the whole panel into the modal body.
  const wrapper = document.createElement("div");
  wrapper.style.width = "100%";
  wrapper.appendChild(panel);

  openModal({
    title: "Voter Details",
    body: wrapper,
    startMaximized: true,
    dialogClass: "modal--wide",
  });

  // Restore panel when modal is closed (X, backdrop click, or Esc).
  if (modalBackdrop) {
    const observer = new MutationObserver(() => {
      // closeModal sets the `hidden` property; it usually maps to the attribute.
      if (modalBackdrop.hidden) {
        try {
          placeholder.replaceWith(panel);
        } catch (_) {}
        observer.disconnect();
      }
    });
    observer.observe(modalBackdrop, { attributes: true, attributeFilter: ["hidden"] });
  }
}

/** Update pledge for a single candidate; candidateId is the candidate's id (number or string). */
export function updateVoterCandidatePledge(voterId, candidateId, status) {
  const ctx = getCandidateContext();
  if (ctx && String(candidateId) !== String(ctx.candidateId)) return;
  const v = findVoterById(voterId);
  if (!v) return;
  if (!v.candidatePledges) v.candidatePledges = {};
  v.candidatePledges[String(candidateId)] = status;
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) await api.setVoterFs(v);
      saveVotersToStorage();
      renderVotersTable();
      if (sameVoterId(selectedVoterId, voterId)) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

/** Update candidate-scoped assigned agent on the voter doc. */
export function updateVoterCandidateAgentAssignment(voterId, candidateId, agentId, agentName) {
  const ctx = getCandidateContext();
  // Candidate logins should not set assignments for other candidates.
  if (ctx && String(candidateId) !== String(ctx.candidateId)) return;

  const v = findVoterById(voterId);
  if (!v) return;

  const cid = String(candidateId);
  const nextName = String(agentName || "");
  const nextId = agentId == null ? "" : String(agentId);

  if (!v.candidateAgentAssignments || typeof v.candidateAgentAssignments !== "object") {
    v.candidateAgentAssignments = {};
  }
  if (!v.candidateAgentAssignmentIds || typeof v.candidateAgentAssignmentIds !== "object") {
    v.candidateAgentAssignmentIds = {};
  }

  v.candidateAgentAssignments[cid] = nextName;
  v.candidateAgentAssignmentIds[cid] = nextId;

  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setVoterFs) await api.setVoterFs(v);

      if (cid) mirrorCandidatePledgedAgentLocalMap(cid, voterId, nextName);

      saveVotersToStorage();
      renderVotersTable();
      if (sameVoterId(selectedVoterId, voterId)) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

/** Update door-to-door fields (assigned agent, met, persuadable, date pledged, notes). */
export function updateVoterDoorToDoorFields(voterId, fields) {
  const v = findVoterById(voterId);
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
      if (sameVoterId(selectedVoterId, voterId)) renderVoterDetails(v);
      document.dispatchEvent(new CustomEvent("voters-updated"));
    } catch (_) {}
  })();
}

export async function importVotersFromTemplateRows(rows) {
  const hasContent = (r) => {
    const name = String(r["Name"] ?? "").trim();
    const id = String(r["ID Number"] ?? r.id ?? "").trim();
    return name !== "" || id !== "";
  };
  const validRows = rows.filter(hasContent);
  const importRunPrefix = `V-${Date.now()}-`;

  let existingFromFs = [];
  try {
    const api = await firebaseInitPromise;
    if (api?.ready && typeof api.getAllVotersFs === "function") {
      existingFromFs = await api.getAllVotersFs();
    }
  } catch (_) {}

  const existingByNationalId = new Map();
  (Array.isArray(existingFromFs) ? existingFromFs : []).forEach((v) => {
    if (!v || typeof v !== "object") return;
    const k = normalizeNationalIdForDedup(v.nationalId);
    if (k) existingByNationalId.set(k, v);
    const k2 = normalizeNationalIdForDedup(v.id);
    if (k2 && k2 !== k) existingByNationalId.set(k2, v);
  });

  const usedDocIds = new Set();
  const allocateDocId = (rawNational, index) => {
    const fromNid = voterDocumentIdFromNationalId(rawNational);
    if (fromNid) {
      let id = fromNid;
      let n = 2;
      while (usedDocIds.has(id)) {
        id = `${fromNid}__${n}`;
        n += 1;
      }
      usedDocIds.add(id);
      return id;
    }
    const fallback = `${importRunPrefix}${index + 1}`;
    usedDocIds.add(fallback);
    return fallback;
  };

  const mapped = validRows.map((r, index) => {
    const rawNational = String(r["ID Number"] ?? "").trim();
    const id = allocateDocId(rawNational, index);
    const pledgeCell = String(r["Pledge"] ?? "").trim().toLowerCase();
    const pledgeFromCsv =
      pledgeCell === "yes" || pledgeCell === "no" || pledgeCell === "undecided" ? pledgeCell : "";

    const base = {
      id,
      sequence: sequenceAsImportedFromCsv(r["Sequence"]),
      ballotBox: r["Ballot Box"] || "",
      fullName: r["Name"] || "",
      permanentAddress: r["Permanent Address"] || "",
      dateOfBirth: r["Date of Birth"] || "",
      age: r["Age"] ? Number(r["Age"]) : "",
      pledgeStatus: pledgeFromCsv || "undecided",
      gender: r["Gender"] || "",
      island: r["Island"] || "",
      currentLocation: r["Current Location"] || "",
      nationalId: rawNational || "",
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
    };

    const norm = normalizeNationalIdForDedup(rawNational);
    const existing = norm ? existingByNationalId.get(norm) : null;
    let merged = mergeImportedVoterWithExistingFirestore(base, existing);
    if (!pledgeFromCsv && existing && existing.pledgeStatus) {
      merged = { ...merged, pledgeStatus: existing.pledgeStatus };
    }
    return merged;
  });

  currentVoters = mapped;
  selectedVoterId = null;
  saveVotersToStorage();
  renderVotersTable();
  renderVoterDetails(null);
  document.dispatchEvent(new CustomEvent("voters-updated"));

  let cloudSynced = false;
  if (mapped.length > 0) {
    votersBulkImportInProgress = true;
    try {
      const api = await firebaseInitPromise;
      if (api.ready && typeof api.setVotersBatchFs === "function") {
        await api.setVotersBatchFs(mapped);
        cloudSynced = true;
      } else if (api.ready && api.setVoterFs) {
        const chunk = 40;
        for (let i = 0; i < mapped.length; i += chunk) {
          await Promise.all(mapped.slice(i, i + chunk).map((v) => api.setVoterFs(v)));
        }
        cloudSynced = true;
      }
    } catch (err) {
      console.error("[Voters] Import: Firestore sync failed", err);
    } finally {
      votersBulkImportInProgress = false;
    }
  }

  saveVotersToStorage();
  renderVotersTable();

  if (window.appNotifications) {
    const n = mapped.length.toLocaleString("en-MV");
    window.appNotifications.push({
      title: mapped.length ? "Voters imported" : "Import finished",
      meta: mapped.length
        ? cloudSynced
          ? `${n} voters saved locally and synced to Firebase.`
          : `${n} voters saved on this device. Cloud sync failed or offline — use “Sync local voters to Firebase” in Settings → Data when online.`
        : "No data rows matched (need Name or ID Number per row).",
    });
  }
}


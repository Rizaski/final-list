/**
 * Zero Day module (vote marking & monitors) + Transportation page (trips).
 * Election day transport trips and voter vote-marking.
 */

import { openModal, closeModal, confirmDialog } from "./ui.js";
import { firebaseInitPromise } from "./firebase.js";
import { getAgents } from "./settings.js";
import { sequenceAsImportedFromCsv, compareVotersByBallotSequenceThenName } from "./sequence-utils.js";

const zeroDayAddTripButton = document.getElementById("zeroDayAddTripButton");
const zeroDayTransportMenuButton = document.getElementById("zeroDayTransportMenuButton");
const zeroDayTransportMenu = document.getElementById("zeroDayTransportMenu");
const zeroDayMarkVotedButton = document.getElementById("zeroDayMarkVotedButton");
const zeroDayVoteSearch = document.getElementById("zeroDayVoteSearch");
const zeroDayVoteFilter = document.getElementById("zeroDayVoteFilter");
const zeroDayTripsTableBody = document.querySelector("#zeroDayTripsTable tbody");
const zeroDayRoutesTableBody = document.querySelector("#zeroDayRoutesTable tbody");
const zeroDayVoteCardsContainer = document.getElementById("zeroDayVoteCards");
const zeroDayVotePaginationEl = document.getElementById("zeroDayVotePagination");
const zeroDayAddMonitorButton = document.getElementById("zeroDayAddMonitorButton");
const zeroDayMonitorsTableBody = document.querySelector("#zeroDayMonitorsTable tbody");

export const TRIP_TYPES = [
  { value: "flight", label: "Flight" },
  { value: "speedboat", label: "Speed boat" },
];
export const TRIP_STATUSES = ["Scheduled", "In progress", "Completed"];
const TRIPS_VISIBLE_COLS_KEY = "zero-day-trips-visible-columns";
/** Column definitions for Transportation Management table (order = default column order). */
const TRIP_TABLE_COLUMN_DEFS = [
  { key: "type", label: "Type", sortKey: "type" },
  { key: "route", label: "Trip / Route", sortKey: "route" },
  { key: "vehicle", label: "Vessel / Flight no.", sortKey: "vehicle" },
  { key: "driver", label: "Driver / Pilot / Captain", sortKey: "driver" },
  { key: "pickup", label: "Pickup time", sortKey: "pickup" },
  { key: "voters", label: "Voters assigned", sortKey: "voters" },
  { key: "status", label: "Status", sortKey: "status" },
  { key: "rate", label: "Rate", sortKey: "rate" },
  { key: "amount", label: "Amount", sortKey: "amount" },
  { key: "remarks", label: "Remarks", sortKey: "remarks" },
];
const TRIP_COLUMN_DEFAULT_KEYS = TRIP_TABLE_COLUMN_DEFS.map((c) => c.key);
let transportVisibleColumnKeys = TRIP_COLUMN_DEFAULT_KEYS.slice();
const PAGE_SIZE = 15;
const MONITORS_STORAGE_KEY = "zero-day-monitors";
const VOTED_STORAGE_KEY = "zero-day-voted";
const TRIPS_STORAGE_KEY = "zero-day-trips";
/** Trip ids the user deleted locally — prevents Firestore merge/snapshot from bringing them back (stale cache). */
const TRIPS_DELETED_IDS_KEY = "zero-day-transport-trips-deleted-ids";
const TRIPS_DELETED_IDS_MAX = 2000;
const ROUTES_STORAGE_KEY = "zero-day-transport-routes";
const ROUTES_DELETED_IDS_KEY = "zero-day-transport-routes-deleted-ids";
const ROUTES_DELETED_IDS_MAX = 2000;
/** Route table columns (same styling patterns as trips; route # is display-only). */
const ROUTE_TABLE_COLUMN_DEFS = [
  { key: "routeNum", label: "Route #", sortKey: "routeNum" },
  { key: "trips", label: "Trips", sortKey: "trips" },
  { key: "vehicle", label: "Vessel / Flight no.", sortKey: "vehicle" },
  { key: "driver", label: "Driver / Pilot / Captain", sortKey: "driver" },
  { key: "pickup", label: "Pickup time", sortKey: "pickup" },
  { key: "voters", label: "Voters assigned", sortKey: "voters" },
  { key: "status", label: "Status", sortKey: "status" },
  { key: "rate", label: "Rate", sortKey: "rate" },
  { key: "amount", label: "Amount", sortKey: "amount" },
  { key: "remarks", label: "Remarks", sortKey: "remarks" },
];
const ROUTE_TABLE_EDITABLE_FIELDS = new Set([
  "vehicle",
  "driver",
  "pickupTime",
  "rate",
  "amount",
  "remarks",
]);
const ROUTES_VISIBLE_COLS_KEY = "zero-day-routes-visible-columns";
const ROUTE_COLUMN_DEFAULT_KEYS = ROUTE_TABLE_COLUMN_DEFS.map((c) => c.key);
let transportRouteVisibleColumnKeys = ROUTE_COLUMN_DEFAULT_KEYS.slice();
/** localStorage key prefix for ballot session when Firestore is unavailable */
const MONITOR_BALLOT_SESSION_PREFIX = "monitor_ballot_session_";

const ADMIN_BALLOT_SESSION_OPEN_SVG = `<svg class="monitor-admin-session-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4V8z" fill="currentColor" stroke="none"/></svg>`;
const ADMIN_BALLOT_SESSION_CLOSE_SVG = `<svg class="monitor-admin-session-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
/** Ballot box card: list who has voted (check in circle). */
const VOTE_BOX_VIEW_VOTED_SVG = `<svg class="vote-box-card__view-icon vote-box-card__view-icon--voted" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#22c55e" stroke="#15803d" stroke-width="1.15"/><path d="M9 12l2 2 4-4" fill="none" stroke="#ffffff" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** Ballot box card: list not yet voted (clock in circle). */
const VOTE_BOX_VIEW_NOT_YET_SVG = `<svg class="vote-box-card__view-icon vote-box-card__view-icon--not-yet" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#fb923c" stroke="#c2410c" stroke-width="1.15"/><path d="M12 7v5l3 2" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let zeroDayTrips = [];
/** Set of string trip ids deleted by user; persisted so sync does not resurrect them. */
let deletedTransportTripIds = new Set();
let transportTripsUnsubscribe = null;
let zeroDayTransportRoutes = [];
let deletedTransportRouteIds = new Set();
let transportRoutesUnsubscribe = null;
let zeroDayVotedEntries = []; // { voterId, timeMarked }
let zeroDayMonitors = []; // { id, name, mobile, ballotBox, voterIds: [], shareToken, sequenceOffset? } — offset unused (legacy field)

let votersContext = null;
/** Injected from main.js to avoid circular import (voters.js imports zeroDay). */
let updateVoterPhoneFromHost = null;
let pledgeContextRef = null; // optional: { getPledges() } for agent lookup and sync
let zeroDayVoteCurrentPage = 1;
let transportViewFilter = "all"; // "all" | "flight" | "speedboat"
let votedRealtimeUnsubscribes = []; // unsubscribe fns for Firestore voted listeners
const votedByMonitor = {}; // token -> [{ voterId, timeMarked }] from real-time snapshots
let monitorBallotSessionUnsubs = []; // ballot session snapshots for Manage Monitors status column
let monitorBallotSessionVisibilityBound = false;
let monitorRowMenuDocClose = null;
let zeroDaySyncInProgress = false;
let zeroDaySyncIntervalId = null;
const ZERO_DAY_SYNC_INTERVAL_MS = 5000;

/** Returns array of unique transport route names from Zero Day trips. */
export function getAvailableTransportRoutes() {
  loadTrips();
  const routes = new Set();
  zeroDayTrips.forEach((t) => {
    const name = (t.route || "").trim();
    if (name) routes.add(name);
  });
  return Array.from(routes).sort((a, b) => a.localeCompare(b, "en"));
}

function normalizeRouteKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Create a minimal Zero Day transport trip so the route appears in voter route dropdowns.
 * Syncs to Firestore when available. Dispatches `transport-trips-updated`.
 * @param {object} [options]
 * @param {string} [options.tripType] flight | speedboat
 * @param {string} [options.driver]
 * @param {string} [options.vehicle]
 * @param {string} [options.pickupTime] datetime-local value or ISO string
 * @param {string} [options.status] Scheduled | In progress | Completed
 * @returns {{ ok: true, route: string, trip: object } | { ok: false, error: 'empty' | 'duplicate' }}
 */
export async function addTransportRouteFromName(routeName, options = {}) {
  const route = String(routeName || "").trim();
  if (!route) return { ok: false, error: "empty" };
  loadTrips();
  const key = normalizeRouteKey(route);
  const dup = zeroDayTrips.some((t) => normalizeRouteKey(t.route) === key);
  if (dup) return { ok: false, error: "duplicate" };
  const nextId =
    zeroDayTrips.length === 0
      ? 1
      : zeroDayTrips.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
  const tripType = options.tripType === "speedboat" ? "speedboat" : "flight";
  const driver = String(options.driver || "").trim();
  const vehicle = String(options.vehicle || "").trim();
  const pickupRaw = options.pickupTime != null ? String(options.pickupTime).trim() : "";
  const pickupTime = pickupRaw
    ? (() => {
        const d = new Date(pickupRaw);
        return Number.isNaN(d.getTime()) ? "" : d.toISOString();
      })()
    : "";
  const statusOpt = String(options.status || "").trim();
  const status = TRIP_STATUSES.includes(statusOpt) ? statusOpt : "Scheduled";
  const trip = normalizeTrip({
    id: nextId,
    tripType,
    route,
    driver,
    vehicle,
    pickupTime,
    status,
    voterCount: 0,
    voterIds: [],
  });
  zeroDayTrips.push(trip);
  saveTrips();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportTripFs) await api.setTransportTripFs(trip);
  } catch (_) {}
  renderZeroDayTripsTable();
  document.dispatchEvent(
    new CustomEvent("transport-trips-updated", { detail: { route, trip } })
  );
  return { ok: true, route, trip };
}

function loadDeletedTransportTripIds() {
  try {
    const raw = localStorage.getItem(TRIPS_DELETED_IDS_KEY);
    if (!raw) {
      deletedTransportTripIds = new Set();
      return;
    }
    const parsed = JSON.parse(raw);
    deletedTransportTripIds = new Set(
      Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : []
    );
  } catch (_) {
    deletedTransportTripIds = new Set();
  }
}

function saveDeletedTransportTripIds() {
  try {
    let arr = Array.from(deletedTransportTripIds);
    if (arr.length > TRIPS_DELETED_IDS_MAX) {
      arr = arr.slice(-TRIPS_DELETED_IDS_MAX);
      deletedTransportTripIds = new Set(arr);
    }
    localStorage.setItem(TRIPS_DELETED_IDS_KEY, JSON.stringify(arr));
  } catch (_) {}
}

function recordTransportTripDeleted(tripId) {
  const sid = String(tripId ?? "").trim();
  if (!sid) return;
  deletedTransportTripIds.add(sid);
  saveDeletedTransportTripIds();
}

function loadTrips() {
  loadDeletedTransportTripIds();
  try {
    const raw = localStorage.getItem(TRIPS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        zeroDayTrips = parsed
          .map(normalizeTrip)
          .filter((t) => t && t.id != null && !deletedTransportTripIds.has(String(t.id)));
      }
    }
  } catch (_) {}
}

function saveTrips() {
  try {
    localStorage.setItem(TRIPS_STORAGE_KEY, JSON.stringify(zeroDayTrips));
  } catch (_) {}
}

function sanitizeTripStringMap(m) {
  if (!m || typeof m !== "object") return {};
  const o = {};
  Object.entries(m).forEach(([k, v]) => {
    const ks = String(k).trim();
    if (!ks) return;
    o[ks] = v != null ? String(v) : "";
  });
  return o;
}

function normalizeTrip(t) {
  return {
    id: t.id,
    tripType: t.tripType || "flight",
    route: t.route || "",
    driver: t.driver || "",
    vehicle: t.vehicle || "",
    pickupTime: t.pickupTime || "",
    status: t.status || "Scheduled",
    voterCount: t.voterCount != null ? t.voterCount : (Array.isArray(t.voterIds) ? t.voterIds.length : 0),
    voterIds: Array.isArray(t.voterIds) ? t.voterIds : [],
    onboardedVoterIds: Array.isArray(t.onboardedVoterIds)
      ? t.onboardedVoterIds.map((x) => String(x))
      : [],
    excludedVoterIds: Array.isArray(t.excludedVoterIds)
      ? t.excludedVoterIds.map((x) => String(x))
      : [],
    rate: t.rate != null ? String(t.rate) : "",
    amount: t.amount != null ? String(t.amount) : "",
    remarks: t.remarks != null ? String(t.remarks) : "",
    passengerPreferredPickupByVoterId: sanitizeTripStringMap(t.passengerPreferredPickupByVoterId),
    passengerRemarksByVoterId: sanitizeTripStringMap(t.passengerRemarksByVoterId),
  };
}

/** Prefer non-empty local edits when merging offline/localStorage with Firestore. */
function mergeTripScalarPreferLocal(localVal, remoteVal) {
  const ls = String(localVal ?? "").trim();
  if (ls) return ls;
  return String(remoteVal ?? "").trim();
}

function unionTripIdArrays(a, b) {
  const s = new Set();
  (Array.isArray(a) ? a : []).forEach((x) => {
    const v = String(x).trim();
    if (v) s.add(v);
  });
  (Array.isArray(b) ? b : []).forEach((x) => {
    const v = String(x).trim();
    if (v) s.add(v);
  });
  return Array.from(s);
}

/** Union explicit id lists from two sources, then drop any id listed as excluded on either side (avoids reviving removed voters after Firestore merge). */
function mergeTripExplicitIdsWithExclusions(rIds, lIds, rEx, lEx) {
  const ex = new Set(
    unionTripIdArrays(rEx, lEx)
      .map((x) => String(x).trim())
      .filter(Boolean)
  );
  return unionTripIdArrays(rIds, lIds).filter((id) => !ex.has(String(id).trim()));
}

/** Local map wins on key overlap (spread); empty values dropped. */
function mergeTripPassengerMaps(mapR, mapL) {
  const R = sanitizeTripStringMap(mapR);
  const L = sanitizeTripStringMap(mapL);
  const merged = { ...R, ...L };
  const out = {};
  Object.entries(merged).forEach(([k, v]) => {
    const s = String(v ?? "").trim();
    if (s) out[k] = v;
  });
  return out;
}

/**
 * Merge one trip from Firestore with the same id from localStorage (offline edits).
 */
function mergeTwoTransportTrips(remote, local) {
  if (!remote && !local) return null;
  if (!local) return normalizeTrip(remote);
  if (!remote) return normalizeTrip(local);
  const R = normalizeTrip(remote);
  const L = normalizeTrip(local);
  const mergedExcluded = unionTripIdArrays(R.excludedVoterIds, L.excludedVoterIds);
  const merged = {
    id: L.id != null ? L.id : R.id,
    tripType: mergeTripScalarPreferLocal(L.tripType, R.tripType) || "flight",
    route: mergeTripScalarPreferLocal(L.route, R.route),
    driver: mergeTripScalarPreferLocal(L.driver, R.driver),
    vehicle: mergeTripScalarPreferLocal(L.vehicle, R.vehicle),
    pickupTime: mergeTripScalarPreferLocal(L.pickupTime, R.pickupTime),
    status: mergeTripScalarPreferLocal(L.status, R.status) || "Scheduled",
    rate: mergeTripScalarPreferLocal(L.rate, R.rate),
    amount: mergeTripScalarPreferLocal(L.amount, R.amount),
    remarks: mergeTripScalarPreferLocal(L.remarks, R.remarks),
    excludedVoterIds: mergedExcluded,
    voterIds: mergeTripExplicitIdsWithExclusions(R.voterIds, L.voterIds, R.excludedVoterIds, L.excludedVoterIds),
    onboardedVoterIds: (() => {
      const ex = new Set(
        mergedExcluded
          .map((x) => String(x).trim())
          .filter(Boolean)
      );
      return unionTripIdArrays(R.onboardedVoterIds, L.onboardedVoterIds).filter((id) => !ex.has(String(id).trim()));
    })(),
    passengerPreferredPickupByVoterId: mergeTripPassengerMaps(
      R.passengerPreferredPickupByVoterId,
      L.passengerPreferredPickupByVoterId
    ),
    passengerRemarksByVoterId: mergeTripPassengerMaps(R.passengerRemarksByVoterId, L.passengerRemarksByVoterId),
  };
  return normalizeTrip(merged);
}

/**
 * Union of remote trips (Firestore) and local trips (localStorage): same id is merged;
 * ids only on local are kept (e.g. created offline).
 */
function mergeTransportTripLists(localList, remoteList) {
  const local = Array.isArray(localList) ? localList.map(normalizeTrip) : [];
  const remote = Array.isArray(remoteList) ? remoteList.map(normalizeTrip) : [];
  const localById = new Map(local.map((t) => [String(t.id), t]));
  const remoteById = new Map(remote.map((t) => [String(t.id), t]));
  const remoteIds = new Set(remoteById.keys());
  const maxRemoteNumericId = remote.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  const remoteNonEmpty = remote.length > 0;
  const result = [];
  remoteById.forEach((R, id) => {
    if (deletedTransportTripIds.has(String(id))) return;
    const L = localById.get(id);
    result.push(mergeTwoTransportTrips(R, L));
  });
  localById.forEach((L, id) => {
    if (remoteIds.has(id) || deletedTransportTripIds.has(String(id))) return;
    const numId = Number(id);
    if (remoteNonEmpty && !Number.isNaN(numId) && numId <= maxRemoteNumericId) return;
    result.push(L);
  });
  result.sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && String(na) === String(a.id) && String(nb) === String(b.id)) {
      return na - nb;
    }
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
  return result;
}

function normalizeTransportRoute(r) {
  const tripIds = Array.isArray(r.tripIds)
    ? r.tripIds.map((x) => Number(x)).filter((n) => !Number.isNaN(n))
    : [];
  const createdAt =
    typeof r.createdAt === "number" && !Number.isNaN(r.createdAt)
      ? r.createdAt
      : r.createdAt != null && !Number.isNaN(Number(r.createdAt))
        ? Number(r.createdAt)
        : 0;
  return {
    id: String(r.id || "").trim(),
    tripIds,
    createdAt,
    driver: r.driver || "",
    vehicle: r.vehicle || "",
    pickupTime: r.pickupTime || "",
    status: r.status || "Scheduled",
    remarks: r.remarks != null ? String(r.remarks) : "",
    rate: r.rate != null ? String(r.rate) : "",
    amount: r.amount != null ? String(r.amount) : "",
    onboardedVoterIds: Array.isArray(r.onboardedVoterIds) ? r.onboardedVoterIds.map((x) => String(x)) : [],
    passengerPreferredPickupByVoterId: sanitizeTripStringMap(r.passengerPreferredPickupByVoterId),
    passengerRemarksByVoterId: sanitizeTripStringMap(r.passengerRemarksByVoterId),
  };
}

function mergeTwoTransportRoutes(remote, local) {
  if (!remote && !local) return null;
  if (!local) return normalizeTransportRoute(remote);
  if (!remote) return normalizeTransportRoute(local);
  const R = normalizeTransportRoute(remote);
  const L = normalizeTransportRoute(local);
  const tripIdSet = new Set([...R.tripIds, ...L.tripIds]);
  return normalizeTransportRoute({
    id: L.id || R.id,
    tripIds: Array.from(tripIdSet),
    createdAt: L.createdAt || R.createdAt || Date.now(),
    driver: mergeTripScalarPreferLocal(L.driver, R.driver),
    vehicle: mergeTripScalarPreferLocal(L.vehicle, R.vehicle),
    pickupTime: mergeTripScalarPreferLocal(L.pickupTime, R.pickupTime),
    status: mergeTripScalarPreferLocal(L.status, R.status) || "Scheduled",
    remarks: mergeTripScalarPreferLocal(L.remarks, R.remarks),
    rate: mergeTripScalarPreferLocal(L.rate, R.rate),
    amount: mergeTripScalarPreferLocal(L.amount, R.amount),
    onboardedVoterIds: unionTripIdArrays(R.onboardedVoterIds, L.onboardedVoterIds),
    passengerPreferredPickupByVoterId: mergeTripPassengerMaps(
      R.passengerPreferredPickupByVoterId,
      L.passengerPreferredPickupByVoterId
    ),
    passengerRemarksByVoterId: mergeTripPassengerMaps(R.passengerRemarksByVoterId, L.passengerRemarksByVoterId),
  });
}

function mergeTransportRouteLists(localList, remoteList) {
  const local = Array.isArray(localList) ? localList.map(normalizeTransportRoute) : [];
  const remote = Array.isArray(remoteList) ? remoteList.map(normalizeTransportRoute) : [];
  const localById = new Map(local.map((r) => [String(r.id), r]));
  const remoteById = new Map(remote.map((r) => [String(r.id), r]));
  const remoteIds = new Set(remoteById.keys());
  const result = [];
  remoteById.forEach((R, id) => {
    if (deletedTransportRouteIds.has(id)) return;
    const L = localById.get(id);
    result.push(mergeTwoTransportRoutes(R, L));
  });
  localById.forEach((L, id) => {
    if (remoteIds.has(id) || deletedTransportRouteIds.has(id)) return;
    result.push(L);
  });
  result.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return result;
}

function loadDeletedTransportRouteIds() {
  try {
    const raw = localStorage.getItem(ROUTES_DELETED_IDS_KEY);
    if (!raw) {
      deletedTransportRouteIds = new Set();
      return;
    }
    const parsed = JSON.parse(raw);
    deletedTransportRouteIds = new Set(
      Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : []
    );
  } catch (_) {
    deletedTransportRouteIds = new Set();
  }
}

function saveDeletedTransportRouteIds() {
  try {
    let arr = Array.from(deletedTransportRouteIds);
    if (arr.length > ROUTES_DELETED_IDS_MAX) {
      arr = arr.slice(-ROUTES_DELETED_IDS_MAX);
      deletedTransportRouteIds = new Set(arr);
    }
    localStorage.setItem(ROUTES_DELETED_IDS_KEY, JSON.stringify(arr));
  } catch (_) {}
}

function recordTransportRouteDeleted(routeId) {
  const sid = String(routeId ?? "").trim();
  if (!sid) return;
  deletedTransportRouteIds.add(sid);
  saveDeletedTransportRouteIds();
}

function loadTransportRoutes() {
  loadDeletedTransportRouteIds();
  try {
    const raw = localStorage.getItem(ROUTES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        zeroDayTransportRoutes = parsed
          .map(normalizeTransportRoute)
          .filter((r) => r && r.id && !deletedTransportRouteIds.has(String(r.id)));
      }
    }
  } catch (_) {}
}

function saveTransportRoutes() {
  try {
    localStorage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(zeroDayTransportRoutes));
  } catch (_) {}
}

function newTransportRouteId() {
  return `troute_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function findTransportRouteById(id) {
  if (id == null) return undefined;
  const sid = String(id);
  return zeroDayTransportRoutes.find((x) => String(x.id) === sid);
}

function getSortedTransportRoutesForDisplay() {
  return [...zeroDayTransportRoutes].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function getTransportRouteDisplayNumber(routeId) {
  const sorted = getSortedTransportRoutesForDisplay();
  const ix = sorted.findIndex((r) => String(r.id) === String(routeId));
  return ix >= 0 ? ix + 1 : 0;
}

/** Title + pickup line for one trip (routes table cell uses both lines). */
function getTransportRouteTripLineParts(trip) {
  const typeLabel = getTripTypeLabel(trip);
  const name = (trip.route || "").trim() || `Trip ${trip.id}`;
  const pickupDisplay = formatDateTime(trip.pickupTime) || "—";
  return { title: `${typeLabel}: ${name}`, pickupLabel: `Pickup: ${pickupDisplay}` };
}

/** One string per linked trip (search / CSV / summaries; includes pickup). */
function getTransportRouteTripLines(route) {
  const ids = Array.isArray(route.tripIds) ? route.tripIds : [];
  if (!ids.length) return [];
  return ids
    .map((tid) => findZeroDayTripById(tid))
    .filter(Boolean)
    .map((t) => {
      const p = getTransportRouteTripLineParts(t);
      return `${p.title} · ${p.pickupLabel}`;
    });
}

/** One line per trip for route reports (Excel / print / share): name + pickup only, no trip type. */
function getTransportRouteTripsReportLines(route) {
  const ids = Array.isArray(route.tripIds) ? route.tripIds : [];
  if (!ids.length) return [];
  return ids
    .map((tid) => findZeroDayTripById(tid))
    .filter(Boolean)
    .map((t) => {
      const name = (t.route || "").trim() || `Trip ${t.id}`;
      const p = formatDateTime(t.pickupTime);
      const pickupPart = p && p !== "–" ? p : "—";
      return `${name} · Pickup: ${pickupPart}`;
    });
}

function formatTransportRouteTripsCell(route) {
  const lines = getTransportRouteTripLines(route);
  return lines.length ? lines.join("; ") : "—";
}

/** Push every in-memory transport route to Firestore (merge writes). */
export async function flushTransportRoutesToFirestore() {
  const api = await firebaseInitPromise;
  if (!api.ready || typeof api.setTransportRouteFs !== "function") return;
  const routes = zeroDayTransportRoutes.slice();
  const results = await Promise.allSettled(routes.map((r) => api.setTransportRouteFs(r)));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.warn("[ZeroDay] flushTransportRoutesToFirestore: some routes failed", failed.length);
  }
}

/** One-shot pull of transport routes from Firestore. */
export async function refreshTransportRoutesFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getAllTransportRoutesFs) return;
    const remote = await api.getAllTransportRoutesFs();
    if (!Array.isArray(remote)) return;
    const localBefore = zeroDayTransportRoutes.slice();
    zeroDayTransportRoutes = mergeTransportRouteLists(localBefore, remote.map(normalizeTransportRoute));
    saveTransportRoutes();
    renderTransportRoutesTable();
    await flushTransportRoutesToFirestore();
  } catch (e) {
    console.warn("[ZeroDay] refreshTransportRoutesFromFirestore", e);
  }
}

/** Push every in-memory transport trip to Firestore (merge writes). Exported for manual sync if needed. */
export async function flushTransportTripsToFirestore() {
  const api = await firebaseInitPromise;
  if (!api.ready || typeof api.setTransportTripFs !== "function") return;
  const trips = zeroDayTrips.slice();
  const results = await Promise.allSettled(trips.map((t) => api.setTransportTripFs(t)));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.warn("[ZeroDay] flushTransportTripsToFirestore: some trips failed to sync", failed.length);
  }
}

function normalizeTransportRouteKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findZeroDayTripById(id) {
  if (id == null) return undefined;
  const sid = String(id);
  return zeroDayTrips.find((x) => String(x.id) === sid);
}

/** Shown when no preferred pickup is stored (Transportation → route passengers). Still editable. */
const DEFAULT_PREFERRED_PICKUP_DATETIME_LOCAL = "2026-04-04T10:00";

function defaultPreferredPickupDisplayLocale() {
  const d = new Date(DEFAULT_PREFERRED_PICKUP_DATETIME_LOCAL);
  if (Number.isNaN(d.getTime())) return "4/4/2026, 10:00 AM";
  return d.toLocaleString("en-MV", { dateStyle: "short", timeStyle: "short" });
}

function toDatetimeLocalValue(isoOrEmpty) {
  const s = String(isoOrEmpty || "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalToIso(localVal) {
  const s = String(localVal || "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

async function persistTripPassengerPreferredPickup(tripId, voterId, value) {
  const t = findZeroDayTripById(tripId);
  if (!t) return;
  if (!t.passengerPreferredPickupByVoterId) t.passengerPreferredPickupByVoterId = {};
  const vid = String(voterId);
  const iso = fromDatetimeLocalToIso(value);
  if (!iso) delete t.passengerPreferredPickupByVoterId[vid];
  else t.passengerPreferredPickupByVoterId[vid] = iso;
  saveTrips();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportTripFs) await api.setTransportTripFs(t);
  } catch (err) {
    console.warn("[ZeroDay] persistTripPassengerPreferredPickup Firestore sync failed", tripId, voterId, err);
  }
  // Defer so native datetime-local picker is not interrupted by main table DOM work.
  requestAnimationFrame(() => renderZeroDayTripsTable());
}

async function persistTripPassengerRemarks(tripId, voterId, value) {
  const t = findZeroDayTripById(tripId);
  if (!t) return;
  if (!t.passengerRemarksByVoterId) t.passengerRemarksByVoterId = {};
  const vid = String(voterId);
  const s = String(value || "").trim();
  if (!s) delete t.passengerRemarksByVoterId[vid];
  else t.passengerRemarksByVoterId[vid] = s;
  saveTrips();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportTripFs) await api.setTransportTripFs(t);
  } catch (err) {
    console.warn("[ZeroDay] persistTripPassengerRemarks Firestore sync failed", tripId, voterId, err);
  }
  requestAnimationFrame(() => renderZeroDayTripsTable());
}

async function persistRouteMetaField(routeId, field, value) {
  const r = findTransportRouteById(routeId);
  if (!r || !ROUTE_TABLE_EDITABLE_FIELDS.has(field)) return;
  if (field === "vehicle" || field === "driver") {
    r[field] = String(value || "").trim();
  } else if (field === "pickupTime") {
    r.pickupTime = fromDatetimeLocalToIso(value) || "";
  } else if (field === "rate" || field === "amount" || field === "remarks") {
    r[field] = String(value || "").trim();
  }
  saveTransportRoutes();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportRouteFs) await api.setTransportRouteFs(r);
  } catch (err) {
    console.warn("[ZeroDay] persistRouteMetaField Firestore sync failed", routeId, field, err);
  }
}

async function persistRoutePassengerPreferredPickup(routeId, voterId, value) {
  const r = findTransportRouteById(routeId);
  if (!r) return;
  if (!r.passengerPreferredPickupByVoterId) r.passengerPreferredPickupByVoterId = {};
  const vid = String(voterId);
  const iso = fromDatetimeLocalToIso(value);
  if (!iso) delete r.passengerPreferredPickupByVoterId[vid];
  else r.passengerPreferredPickupByVoterId[vid] = iso;
  saveTransportRoutes();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportRouteFs) await api.setTransportRouteFs(r);
  } catch (err) {
    console.warn("[ZeroDay] persistRoutePassengerPreferredPickup Firestore sync failed", routeId, voterId, err);
  }
  requestAnimationFrame(() => renderTransportRoutesTable());
}

async function persistRoutePassengerRemarks(routeId, voterId, value) {
  const r = findTransportRouteById(routeId);
  if (!r) return;
  if (!r.passengerRemarksByVoterId) r.passengerRemarksByVoterId = {};
  const vid = String(voterId);
  const s = String(value || "").trim();
  if (!s) delete r.passengerRemarksByVoterId[vid];
  else r.passengerRemarksByVoterId[vid] = s;
  saveTransportRoutes();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportRouteFs) await api.setTransportRouteFs(r);
  } catch (err) {
    console.warn("[ZeroDay] persistRoutePassengerRemarks Firestore sync failed", routeId, voterId, err);
  }
  requestAnimationFrame(() => renderTransportRoutesTable());
}

async function toggleRouteVoterOnboarded(routeId, voterIdStr) {
  const r = findTransportRouteById(routeId);
  if (!r) return;
  const id = String(voterIdStr);
  let arr = Array.isArray(r.onboardedVoterIds) ? r.onboardedVoterIds.map(String) : [];
  const ix = arr.indexOf(id);
  if (ix >= 0) arr.splice(ix, 1);
  else arr.push(id);
  r.onboardedVoterIds = arr;
  saveTransportRoutes();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportRouteFs) await api.setTransportRouteFs(r);
  } catch (err) {
    console.warn("[ZeroDay] toggleRouteVoterOnboarded Firestore sync failed", routeId, err);
  }
  renderTransportRoutesTable();
}

async function removeAssignedVoterFromTransportRoute(routeId, voterIdStr) {
  const routeRow = findTransportRouteById(routeId);
  if (!routeRow) return;
  const voterId = String(voterIdStr || "").trim();
  if (!voterId) return;
  const tripIds = Array.isArray(routeRow.tripIds) ? routeRow.tripIds : [];
  for (const tid of tripIds) {
    await removeAssignedVoterFromTrip(tid, voterId);
  }
  renderZeroDayTripsTable();
  renderTransportRoutesTable();
}

/** True when voter needs transport (Firestore may use non-boolean truthy values). */
function voterTransportNeededFlag(v) {
  if (!v) return false;
  const x = v.transportNeeded;
  if (x === true) return true;
  if (x === false || x == null) return false;
  if (typeof x === "string") {
    const s = x.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1";
  }
  if (typeof x === "number") return x === 1;
  return false;
}

/** Passengers for a trip: explicit voterIds on trip + voters with transportNeeded matching route. */
function collectAssignedVotersForTrip(trip) {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const ids = new Set((trip.voterIds || []).map(String));
  const excluded = new Set((trip.excludedVoterIds || []).map((x) => String(x).trim()));
  const normalizeRoute = normalizeTransportRouteKey;
  const assignedByIds = voters.filter((v) => {
    const id = v && v.id != null ? String(v.id) : "";
    const nationalId = v && v.nationalId != null ? String(v.nationalId) : "";
    if (!(ids.has(id) || ids.has(nationalId))) return false;
    return !excluded.has(id) && !excluded.has(nationalId);
  });
  const routeKey = normalizeRoute(trip.route);
  const assignedByRoute = routeKey
    ? voters.filter((v) => {
        if (!v || !voterTransportNeededFlag(v)) return false;
        const r = normalizeRoute(v.transportRoute);
        if (!r) return false;
        // Exact match only — loose substring matching caused voters to appear on multiple routes.
        return r === routeKey;
      })
    : [];
  const byId = new Map();
  [...assignedByIds, ...assignedByRoute].forEach((v) => {
    if (!v) return;
    const id = v.id != null ? String(v.id) : "";
    const nationalId = v.nationalId != null ? String(v.nationalId) : "";
    if (excluded.has(id) || excluded.has(nationalId)) return;
    const k = String(v.id || v.nationalId || "");
    if (!k) return;
    byId.set(k, v);
  });
  const list = Array.from(byId.values());
  list.sort(compareVotersByBallotSequenceThenName);
  return {
    list,
    byIdsCount: assignedByIds.length,
    byRouteCount: assignedByRoute.length,
  };
}

/** Union of passengers across all trips linked to a transport route (deduped by voter id). */
function collectAssignedVotersForTransportRoute(route) {
  const byId = new Map();
  const tripLabelSetsByVoterKey = new Map();
  let byIdsCount = 0;
  let byRouteCount = 0;
  const ids = Array.isArray(route?.tripIds) ? route.tripIds : [];
  for (const tid of ids) {
    const t = findZeroDayTripById(tid);
    if (!t) continue;
    const tripLabel = tripAssignmentLabelForRouteModal(t);
    const { list, byIdsCount: bic, byRouteCount: brc } = collectAssignedVotersForTrip(t);
    byIdsCount += bic;
    byRouteCount += brc;
    list.forEach((v) => {
      if (!v) return;
      const k = String(v.id || v.nationalId || "").trim();
      if (!k) return;
      byId.set(k, v);
      if (!tripLabelSetsByVoterKey.has(k)) tripLabelSetsByVoterKey.set(k, new Set());
      tripLabelSetsByVoterKey.get(k).add(tripLabel);
    });
  }
  const list = Array.from(byId.values());
  list.sort(compareVotersByBallotSequenceThenName);
  const tripLabelsByVoterKey = new Map();
  tripLabelSetsByVoterKey.forEach((set, k) => {
    tripLabelsByVoterKey.set(
      k,
      Array.from(set).sort((a, b) => a.localeCompare(b, "en")).join(" · ")
    );
  });
  return { list, byIdsCount, byRouteCount, tripLabelsByVoterKey };
}

function getRouteAssignedVoterCount(route) {
  return collectAssignedVotersForTransportRoute(route).list.length;
}

function mergeTripRowInputs(tripId) {
  const t = findZeroDayTripById(tripId);
  if (!t) return null;
  const row = zeroDayTripsTableBody?.querySelector(`tr[data-trip-id="${tripId}"]`);
  const vehicleInp = row?.querySelector('[data-trip-meta-field="vehicle"]');
  const driverInp = row?.querySelector('[data-trip-meta-field="driver"]');
  const pickupInp = row?.querySelector('[data-trip-meta-field="pickupTime"]');
  const rateInp = row?.querySelector('[data-trip-meta-field="rate"]');
  const amountInp = row?.querySelector('[data-trip-meta-field="amount"]');
  const remarksInp = row?.querySelector('[data-trip-meta-field="remarks"]');
  const vehicle = vehicleInp ? String(vehicleInp.value || "").trim() : String(t.vehicle || "");
  const driver = driverInp ? String(driverInp.value || "").trim() : String(t.driver || "");
  let pickupTime = t.pickupTime;
  if (pickupInp) {
    const iso = fromDatetimeLocalToIso(pickupInp.value);
    pickupTime = iso !== "" ? iso : t.pickupTime;
  }
  const rate = rateInp ? String(rateInp.value || "").trim() : String(t.rate || "");
  const amount = amountInp ? String(amountInp.value || "").trim() : String(t.amount || "");
  const remarks = remarksInp ? String(remarksInp.value || "").trim() : String(t.remarks || "");
  return { ...t, vehicle, driver, pickupTime, rate, amount, remarks };
}

function getAllVisibleTripSnapshots() {
  return getFilteredTransportTrips()
    .map((t) => mergeTripRowInputs(t.id))
    .filter(Boolean);
}

const TRIP_TABLE_EDITABLE_FIELDS = new Set([
  "vehicle",
  "driver",
  "pickupTime",
  "rate",
  "amount",
  "remarks",
]);

async function persistTripMetaField(tripId, field, value) {
  const t = findZeroDayTripById(tripId);
  if (!t || !TRIP_TABLE_EDITABLE_FIELDS.has(field)) return;
  if (field === "vehicle" || field === "driver") {
    t[field] = String(value || "").trim();
  } else if (field === "pickupTime") {
    t.pickupTime = fromDatetimeLocalToIso(value) || "";
  } else if (field === "rate" || field === "amount" || field === "remarks") {
    t[field] = String(value || "").trim();
  }
  saveTrips();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportTripFs) await api.setTransportTripFs(t);
  } catch (err) {
    console.warn("[ZeroDay] persistTripMetaField Firestore sync failed", tripId, field, err);
  }
}

function csvEscapeTransportCell(val) {
  const s = String(val == null ? "" : val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** One data row for print/CSV/share — same fields as Transportation Management table (no Actions). */
function transportManagementReportRowCells(t) {
  const typeLabel =
    TRIP_TYPES.find((x) => x.value === t.tripType)?.label || t.tripType || "—";
  const count = getTripAssignedVoterCount(t);
  return {
    typeLabel,
    route: t.route || "",
    vehicle: t.vehicle || "",
    driver: t.driver || "",
    pickup: formatDateTime(t.pickupTime) || "",
    votersAssigned: String(count),
    status: t.status || "",
    rate: t.rate || "",
    amount: t.amount || "",
    remarks: t.remarks || "",
  };
}

function openTransportTripsReportWindow(tripSnapshots, autoPrint) {
  const list = Array.isArray(tripSnapshots) ? tripSnapshots.filter(Boolean) : [];
  if (!list.length) {
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "No trips",
        meta: "Add a trip to generate a report.",
      });
    }
    return;
  }
  const tbodyHtml = list
    .map((t) => {
      const c = transportManagementReportRowCells(t);
      return `
          <tr>
            <td>${escapeHtml(c.typeLabel)}</td>
            <td>${escapeHtml(c.route)}</td>
            <td>${escapeHtml(c.vehicle)}</td>
            <td>${escapeHtml(c.driver)}</td>
            <td>${escapeHtml(c.pickup)}</td>
            <td>${escapeHtml(c.votersAssigned)}</td>
            <td>${escapeHtml(c.status)}</td>
            <td>${escapeHtml(c.rate)}</td>
            <td>${escapeHtml(c.amount)}</td>
            <td>${escapeHtml(c.remarks)}</td>
          </tr>`;
    })
    .join("");
  const sectionsHtml = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-type">Type</th>
              <th class="col-route">Trip / Route</th>
              <th class="col-vehicle">Vessel / Flight no.</th>
              <th class="col-driver">Driver / Pilot / Captain</th>
              <th class="col-pickup">Pickup time</th>
              <th class="col-voters">Voters assigned</th>
              <th class="col-status">Status</th>
              <th class="col-rate">Rate</th>
              <th class="col-amount">Amount</th>
              <th class="col-remarks">Remarks</th>
            </tr>
          </thead>
          <tbody>${tbodyHtml}</tbody>
        </table>
      </div>
    `;
  const printScript = autoPrint
    ? `<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},400);});<\/script>`
    : "";
  const title =
    list.length === 1
      ? `Transport — ${list[0].route || "Trip"}`
      : `Transport — all routes (${list.length})`;
  const w = window.open("about:blank", "_blank");
  if (!w) {
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Popup blocked",
        meta: "Allow popups for this site to open the report.",
      });
    } else {
      alert("Allow popups for this site to open the report.");
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
        <title>${escapeHtml(title)}</title>
        <style>
          :root { color-scheme: light; }
          body { font-family: Arial, sans-serif; margin: 0; color: #111; background: #f5f7fb; }
          .page { max-width: 1200px; margin: 20px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.06); overflow: hidden; padding-bottom: 16px; }
          .report-head { padding: 16px 18px; border-bottom: 1px solid #e5e7eb; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
          .report-title { margin: 0; font-size: 20px; line-height: 1.2; }
          .report-meta { margin: 4px 0 0; color: #4b5563; font-size: 13px; }
          .report-actions { display: flex; gap: 8px; }
          .btn { border: 1px solid #d1d5db; background: #fff; color: #111; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
          .btn--primary { border-color: #2563eb; background: #2563eb; color: #fff; }
          .sections { padding: 12px 14px; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; min-width: 920px; }
          th, td {
            border: 1px solid #e5e7eb;
            padding: 4px 6px;
            text-align: left;
            vertical-align: top;
            line-height: 1.2;
            white-space: normal;
            overflow-wrap: anywhere;
            word-break: break-word;
          }
          th { background: #f9fafb; font-weight: 600; }
          tbody tr:nth-child(odd) { background: #fcfcfd; }
          .col-type { width: 8%; }
          .col-route { width: 16%; }
          .col-vehicle { width: 12%; }
          .col-driver { width: 12%; }
          .col-pickup { width: 12%; }
          .col-voters { width: 8%; }
          .col-status { width: 10%; }
          .col-rate { width: 7%; }
          .col-amount { width: 7%; }
          .col-remarks { width: 11%; }
          @media print {
            @page { size: A4 landscape; margin: 9mm; }
            body { background: #fff; }
            .page { margin: 0; border: none; box-shadow: none; border-radius: 0; max-width: none; }
            .report-actions { display: none !important; }
            table { min-width: 0; width: 100%; font-size: 9.5px; }
            th, td { padding: 2px 4px; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <header class="report-head">
            <div>
              <h1 class="report-title">Transportation report</h1>
              <p class="report-meta">Routes: ${list.length} · Same columns as Transportation Management · Generated: ${escapeHtml(
                new Date().toLocaleString("en-MV")
              )}</p>
            </div>
            <div class="report-actions">
              <button type="button" class="btn" onclick="window.close()">Close</button>
              <button type="button" class="btn btn--primary" onclick="window.print()">Print</button>
            </div>
          </header>
          <div class="sections">${sectionsHtml}</div>
        </div>
        ${printScript}
      </body>
      </html>
    `);
  w.document.close();
  w.focus();
}

function downloadTransportTripsReportCsv(tripSnapshots) {
  const list = Array.isArray(tripSnapshots) ? tripSnapshots.filter(Boolean) : [];
  if (!list.length) {
    if (window.appNotifications) {
      window.appNotifications.push({ title: "No trips", meta: "Add a trip to export." });
    }
    return;
  }
  const headers = [
    "Type",
    "Trip / Route",
    "Vessel / Flight no.",
    "Driver / Pilot / Captain",
    "Pickup time",
    "Voters assigned",
    "Status",
    "Rate",
    "Amount",
    "Remarks",
  ];
  const lines = [headers.map(csvEscapeTransportCell).join(",")];
  list.forEach((t) => {
    const c = transportManagementReportRowCells(t);
    lines.push(
      [
        c.typeLabel,
        c.route,
        c.vehicle,
        c.driver,
        c.pickup,
        c.votersAssigned,
        c.status,
        c.rate,
        c.amount,
        c.remarks,
      ]
        .map(csvEscapeTransportCell)
        .join(",")
    );
  });
  const csv = lines.join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const name =
    list.length === 1
      ? `transport-${String(list[0].route || "trip")
          .trim()
          .replace(/[^\w\-]+/g, "_")
          .slice(0, 45)}`
      : "transport-all-routes";
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function shareTransportTripsReport(tripSnapshots) {
  const list = Array.isArray(tripSnapshots) ? tripSnapshots.filter(Boolean) : [];
  if (!list.length) {
    if (window.appNotifications) {
      window.appNotifications.push({ title: "No trips", meta: "Nothing to share." });
    }
    return;
  }
  const headerLine = [
    "Type",
    "Trip / Route",
    "Vessel / Flight no.",
    "Driver / Pilot / Captain",
    "Pickup time",
    "Voters assigned",
    "Status",
    "Rate",
    "Amount",
    "Remarks",
  ].join("\t");
  const rowLines = [headerLine];
  list.forEach((t) => {
    const c = transportManagementReportRowCells(t);
    rowLines.push(
      [
        c.typeLabel,
        c.route,
        c.vehicle,
        c.driver,
        c.pickup,
        c.votersAssigned,
        c.status,
        c.rate,
        c.amount,
        c.remarks,
      ].join("\t")
    );
  });
  const title =
    list.length === 1 ? `Transport: ${list[0].route || "Trip"}` : `Transport: all routes (${list.length})`;
  const text = `${title}\n\n${rowLines.join("\n")}`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    if (typeof window.showToast === "function") window.showToast("Report copied to clipboard");
    else if (window.appNotifications) {
      window.appNotifications.push({
        title: "Copied",
        meta: "Transport report copied — paste into email or chat.",
      });
    }
  } catch (_) {
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Share failed",
        meta: "Could not copy to clipboard.",
      });
    }
  }
}

/** Toggle voter on-board status for a transport trip (persisted on trip + Firestore). */
async function toggleTripVoterOnboarded(tripId, voterIdStr) {
  const t = findZeroDayTripById(tripId);
  if (!t) return;
  const id = String(voterIdStr);
  let arr = Array.isArray(t.onboardedVoterIds) ? t.onboardedVoterIds.map(String) : [];
  const ix = arr.indexOf(id);
  if (ix >= 0) arr.splice(ix, 1);
  else arr.push(id);
  t.onboardedVoterIds = arr;
  saveTrips();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportTripFs) await api.setTransportTripFs(t);
  } catch (err) {
    console.warn("[ZeroDay] toggleTripVoterOnboarded Firestore sync failed", tripId, err);
  }
  renderZeroDayTripsTable();
}

/** Remove a voter from this route list (explicit + route-match exclusion). */
async function removeAssignedVoterFromTrip(tripId, voterIdStr) {
  const t = findZeroDayTripById(tripId);
  if (!t) return;
  const voterId = String(voterIdStr || "").trim();
  if (!voterId) return;
  const all = votersContext ? votersContext.getAllVoters() : [];
  const voter = all.find((x) => String(x?.id || "").trim() === voterId);
  const nationalId = String(voter?.nationalId || "").trim();
  const removeKeys = new Set([voterId]);
  if (nationalId) removeKeys.add(nationalId);
  t.voterIds = (Array.isArray(t.voterIds) ? t.voterIds : [])
    .map((x) => String(x).trim())
    .filter((x) => x && !removeKeys.has(x));
  t.onboardedVoterIds = (Array.isArray(t.onboardedVoterIds) ? t.onboardedVoterIds : [])
    .map((x) => String(x).trim())
    .filter((x) => x && !removeKeys.has(x));
  const excluded = new Set((Array.isArray(t.excludedVoterIds) ? t.excludedVoterIds : []).map((x) => String(x).trim()));
  removeKeys.forEach((k) => excluded.add(k));
  t.excludedVoterIds = Array.from(excluded);
  const pv = t.passengerPreferredPickupByVoterId;
  if (pv && typeof pv === "object") {
    delete pv[voterId];
    if (nationalId) delete pv[nationalId];
  }
  const pr = t.passengerRemarksByVoterId;
  if (pr && typeof pr === "object") {
    delete pr[voterId];
    if (nationalId) delete pr[nationalId];
  }
  saveTrips();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setTransportTripFs) await api.setTransportTripFs(t);
  } catch (err) {
    console.warn("[ZeroDay] removeAssignedVoterFromTrip Firestore sync failed", tripId, err);
  }
  renderZeroDayTripsTable();
}

function loadMonitors() {
  try {
    const raw = localStorage.getItem(MONITORS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) zeroDayMonitors = parsed;
    }
  } catch (_) {}
}

function saveMonitors() {
  try {
    localStorage.setItem(MONITORS_STORAGE_KEY, JSON.stringify(zeroDayMonitors));
  } catch (_) {}
}

function loadVotedEntries() {
  try {
    const raw = localStorage.getItem(VOTED_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) zeroDayVotedEntries = parsed;
    }
  } catch (_) {}
}

function saveVotedEntries() {
  try {
    localStorage.setItem(VOTED_STORAGE_KEY, JSON.stringify(zeroDayVotedEntries));
  } catch (_) {}
}

/** Notify other modules (e.g. Voters list) that voted entries changed so they can refresh. */
function notifyVotedEntriesUpdated() {
  try {
    document.dispatchEvent(new CustomEvent("voted-entries-updated"));
  } catch (_) {}
}

/** Fetches voted entries from Firestore (all monitors) and merges into zeroDayVotedEntries so ballot box counts reflect votes from the link. */
export async function syncVotedFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getVotedForMonitor) return;
    loadMonitors();
    const fromMonitors = new Map();
    for (const m of zeroDayMonitors) {
      const token = m.shareToken;
      if (!token) continue;
      const entries = await api.getVotedForMonitor(token);
      for (const { voterId, timeMarked } of entries) {
        const key = String(voterId);
        const existing = fromMonitors.get(key);
        if (!existing || (timeMarked && timeMarked > (existing || ""))) {
          fromMonitors.set(key, timeMarked || existing || "");
        }
      }
    }
    zeroDayVotedEntries = Array.from(fromMonitors.entries()).map(([voterId, timeMarked]) => ({
      voterId,
      timeMarked: timeMarked || "",
    }));
    saveVotedEntries();
    mergeVotedAtFromVoters(votersContext && votersContext.getAllVoters ? votersContext.getAllVoters() : []);
    notifyVotedEntriesUpdated();
  } catch (_) {}
}

/** One-shot pull of transport trips from Firestore (e.g. header hard refresh). Merges with localStorage, then pushes merged trips to Firestore. */
export async function refreshTransportTripsFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getAllTransportTripsFs) return;
    const remote = await api.getAllTransportTripsFs();
    if (!Array.isArray(remote)) return;
    const localBefore = zeroDayTrips.slice();
    zeroDayTrips = mergeTransportTripLists(localBefore, remote.map(normalizeTrip));
    saveTrips();
    renderZeroDayTripsTable();
    renderTransportRoutesTable();
    await flushTransportTripsToFirestore();
  } catch (e) {
    console.warn("[ZeroDay] refreshTransportTripsFromFirestore", e);
  }
}

/**
 * Rebuilds zeroDayVotedEntries from the union of all Firestore monitor `voted` snapshots, then merges voter `votedAt` fields.
 * Replacing (not only adding) is required so undo/delete on a monitor removes voters from local state.
 */
function mergeRealtimeVotedIntoLocal() {
  const fromMonitors = new Map();
  for (const token of Object.keys(votedByMonitor)) {
    const entries = votedByMonitor[token];
    if (!Array.isArray(entries)) continue;
    for (const { voterId, timeMarked } of entries) {
      const key = String(voterId);
      const existing = fromMonitors.get(key);
      if (!existing || (timeMarked && timeMarked > (existing || ""))) {
        fromMonitors.set(key, timeMarked || existing || "");
      }
    }
  }
  zeroDayVotedEntries = Array.from(fromMonitors.entries()).map(([voterId, timeMarked]) => ({
    voterId,
    timeMarked: timeMarked || "",
  }));
  saveVotedEntries();
  mergeVotedAtFromVoters(votersContext && votersContext.getAllVoters ? votersContext.getAllVoters() : []);
  zeroDayVoteCurrentPage = 1;
  renderZeroDayVoteTable();
  notifyVotedEntriesUpdated();
}

/** Subscribes to Firestore voted subcollection for each monitor; ballot box cards update in real time when a monitor marks a voter. */
function subscribeVotedRealtime() {
  votedRealtimeUnsubscribes.forEach((fn) => { try { fn(); } catch (_) {} });
  votedRealtimeUnsubscribes = [];
  loadMonitors();
  firebaseInitPromise.then((api) => {
    if (!api.ready || !api.onVotedSnapshotForMonitor) return;
    for (const m of zeroDayMonitors) {
      const token = m.shareToken;
      if (!token) continue;
      const unsub = api.onVotedSnapshotForMonitor(token, (entries) => {
        votedByMonitor[token] = entries;
        mergeRealtimeVotedIntoLocal();
      });
      votedRealtimeUnsubscribes.push(unsub);
    }
  }).catch(() => {});
}
/** Returns set of voter IDs that have been marked as voted (for reports). */
export function getVotedVoterIds() {
  loadVotedEntries();
  return new Set(zeroDayVotedEntries.map((e) => String(e.voterId)));
}

/** Returns timeMarked string for a voter if they have been marked voted, otherwise null. */
export function getVotedTimeMarked(voterId) {
  loadVotedEntries();
  const entry = zeroDayVotedEntries.find((e) => String(e.voterId) === String(voterId));
  return (entry && entry.timeMarked) || null;
}
/** Clears voted status for a single voter across Zero Day local state, voter docs, and all monitor voted entries. */
export async function clearVotedForVoter(voterId) {
  const key = String(voterId);
  loadVotedEntries();
  zeroDayVotedEntries = zeroDayVotedEntries.filter(
    (e) => String(e.voterId) !== key
  );
  saveVotedEntries();
  notifyVotedEntriesUpdated();
  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.setVoterFs) {
      const all = votersContext ? votersContext.getAllVoters() : [];
      const toUpdate = all.filter(
        (v) => String(v.id) === key || String(v.nationalId) === key
      );
      await Promise.all(
        toUpdate.map((v) =>
          api.setVoterFs({
            ...v,
            votedAt: "",
          })
        )
      );
    }
    if (api.ready && api.deleteVotedForMonitor) {
      loadMonitors();
      const tokenSet = new Set(
        zeroDayMonitors
          .map((m) => m && m.shareToken)
          .filter((t) => typeof t === "string" && t.trim() !== "")
      );
      await Promise.all(
        Array.from(tokenSet).map((token) =>
          api.deleteVotedForMonitor(token, voterId)
        )
      );
    }
  } catch (_) {}
}

/** Merge votedAt from Firestore voter docs into zeroDayVotedEntries so Vote Marking and reports stay in sync. */
export function mergeVotedAtFromVoters(votersArray) {
  if (!Array.isArray(votersArray) || votersArray.length === 0) return;
  loadVotedEntries();
  const existingById = new Map(zeroDayVotedEntries.map((e) => [String(e.voterId), e.timeMarked]));
  for (const v of votersArray) {
    const votedAt = v && (v.votedAt || v.votedTimeMarked);
    if (!votedAt || !v.id) continue;
    const key = String(v.id);
    const existing = existingById.get(key);
    if (!existing || (votedAt > (existing || ""))) existingById.set(key, votedAt);
  }
  zeroDayVotedEntries = Array.from(existingById.entries()).map(([voterId, timeMarked]) => ({ voterId, timeMarked: timeMarked || "" }));
  saveVotedEntries();
  notifyVotedEntriesUpdated();
}

function generateShareToken() {
  return "zd-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now().toString(36);
}

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateTime(dtString) {
  if (!dtString) return "–";
  const d = new Date(dtString);
  return d.toLocaleString("en-MV", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compare voter IDs consistently (string vs number safe). */
function sameVoterId(a, b) {
  return String(a || "") === String(b || "");
}

function initZeroDayTabs() {
  const zdRoot = document.getElementById("module-zero-day");
  if (!zdRoot) return;
  const tabButtons = zdRoot.querySelectorAll("[data-zero-day-tab]");
  const panels = zdRoot.querySelectorAll(".zero-day-tabs__panel");

  function switchToTab(tabKey) {
    tabButtons.forEach((btn) => {
      const isActive = btn.getAttribute("data-zero-day-tab") === tabKey;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== `zero-day-tab-${tabKey}`;
    });
    // When showing Vote Marking tab, sync voted data from Firestore so ballot box link marks are reflected
    if (tabKey === "vote") {
      firebaseInitPromise.then(async (api) => {
        if (!api.ready || !api.getVotedForMonitor) return;
        loadMonitors();
        await syncVotedFromFirestore();
        zeroDayVoteCurrentPage = 1;
        renderZeroDayVoteTable();
        subscribeVotedRealtime();
      }).catch(() => {});
    }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      switchToTab(btn.getAttribute("data-zero-day-tab"));
    });
  });

  switchToTab("vote");
}

function getTransportTripsAfterTypeFilter() {
  let list = zeroDayTrips;
  if (transportViewFilter === "flight") list = list.filter((t) => t.tripType === "flight");
  else if (transportViewFilter === "speedboat") list = list.filter((t) => t.tripType === "speedboat");
  return list;
}

function tripMatchesToolbarQuery(t, query) {
  if (!query) return true;
  const blob = [
    getTripTypeLabel(t),
    t.route,
    t.vehicle,
    t.driver,
    t.status,
    t.rate,
    t.amount,
    t.remarks,
    formatDateTime(t.pickupTime),
    String(getTripAssignedVoterCount(t)),
  ]
    .map((x) => String(x ?? "").toLowerCase())
    .join(" ");
  return blob.includes(query);
}

function sortTransportTripsByKey(arr, sortBy) {
  const pickupMs = (t) => (t.pickupTime ? new Date(t.pickupTime).getTime() : 0);
  const vCount = (t) => getTripAssignedVoterCount(t);
  arr.sort((a, b) => {
    switch (sortBy) {
      case "pickup-desc":
        return pickupMs(b) - pickupMs(a);
      case "pickup":
        return pickupMs(a) - pickupMs(b);
      case "route-desc":
        return (b.route || "").localeCompare(a.route || "", "en");
      case "route":
        return (a.route || "").localeCompare(b.route || "", "en");
      case "type":
        return getTripTypeLabel(a).localeCompare(getTripTypeLabel(b), "en");
      case "vehicle":
        return (a.vehicle || "").localeCompare(b.vehicle || "", "en");
      case "driver":
        return (a.driver || "").localeCompare(b.driver || "", "en");
      case "voters-desc":
        return vCount(b) - vCount(a);
      case "voters":
        return vCount(a) - vCount(b);
      case "status":
        return (a.status || "").localeCompare(b.status || "", "en");
      case "rate-desc":
        return (b.rate || "").localeCompare(a.rate || "", "en", { numeric: true });
      case "rate":
        return (a.rate || "").localeCompare(b.rate || "", "en", { numeric: true });
      case "amount-desc":
        return (b.amount || "").localeCompare(a.amount || "", "en", { numeric: true });
      case "amount":
        return (a.amount || "").localeCompare(b.amount || "", "en", { numeric: true });
      case "remarks":
        return (a.remarks || "").localeCompare(b.remarks || "", "en");
      default:
        return pickupMs(a) - pickupMs(b);
    }
  });
}

/** Trips visible in the table: type menu + status filter + search, sorted by toolbar. */
function getFilteredTransportTrips() {
  const list = [...getTransportTripsAfterTypeFilter()];
  const searchEl = document.getElementById("zeroDayTripsSearch");
  const filterEl = document.getElementById("zeroDayTripsFilterStatus");
  const sortEl = document.getElementById("zeroDayTripsSort");
  const query = (searchEl?.value || "").trim().toLowerCase();
  const statusFilter = (filterEl?.value || "all").trim();
  const sortBy = sortEl?.value || "pickup";
  const filtered = list.filter((t) => {
    if (statusFilter !== "all" && String(t.status || "") !== statusFilter) return false;
    return tripMatchesToolbarQuery(t, query);
  });
  sortTransportTripsByKey(filtered, sortBy);
  return filtered;
}

function getFilteredSortedGroupedTransportTrips() {
  const filtered = getFilteredTransportTrips();
  const groupEl = document.getElementById("zeroDayTripsGroupBy");
  const groupBy = groupEl?.value || "none";
  if (groupBy === "none") {
    return filtered.map((trip) => ({ type: "row", trip }));
  }
  const getGroupKey = (t) => {
    if (groupBy === "type") return getTripTypeLabel(t);
    if (groupBy === "status") return (t.status || "").trim() || "—";
    if (groupBy === "route") return (t.route || "").trim() || "—";
    return "";
  };
  const displayList = [];
  let lastKey = null;
  for (const trip of filtered) {
    const key = getGroupKey(trip);
    if (key !== lastKey) {
      displayList.push({ type: "group", label: key });
      lastKey = key;
    }
    displayList.push({ type: "row", trip });
  }
  return displayList;
}

function updateTransportTripsSortIndicators() {
  const headers = document.querySelectorAll("#zeroDayTripsTable thead th.th-sortable");
  if (!headers.length) return;
  const sortEl = document.getElementById("zeroDayTripsSort");
  const sortBy = sortEl?.value || "pickup";
  headers.forEach((th) => {
    const key = th.getAttribute("data-sort-key");
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    th.removeAttribute("aria-sort");
    if (key === "route" && (sortBy === "route" || sortBy === "route-desc")) {
      th.classList.add(sortBy === "route" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "route" ? "ascending" : "descending");
    } else if (key === "pickup" && (sortBy === "pickup" || sortBy === "pickup-desc")) {
      th.classList.add(sortBy === "pickup" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "pickup" ? "ascending" : "descending");
    } else if (key === "voters" && (sortBy === "voters" || sortBy === "voters-desc")) {
      th.classList.add(sortBy === "voters" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "voters" ? "ascending" : "descending");
    } else if (key === "rate" && (sortBy === "rate" || sortBy === "rate-desc")) {
      th.classList.add(sortBy === "rate" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "rate" ? "ascending" : "descending");
    } else if (key === "amount" && (sortBy === "amount" || sortBy === "amount-desc")) {
      th.classList.add(sortBy === "amount" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "amount" ? "ascending" : "descending");
    } else if (key === "type" && sortBy === "type") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "vehicle" && sortBy === "vehicle") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "driver" && sortBy === "driver") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "status" && sortBy === "status") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "remarks" && sortBy === "remarks") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    }
  });
}

function bindTransportTripsTableHeaderSort() {
  const thead = document.querySelector("#zeroDayTripsTable thead");
  if (!thead || thead.dataset.transportSortBound === "1") return;
  thead.dataset.transportSortBound = "1";
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.th-sortable");
    if (!th) return;
    const key = th.getAttribute("data-sort-key");
    const sortEl = document.getElementById("zeroDayTripsSort");
    if (!key || !sortEl) return;
    const cur = sortEl.value;
    if (key === "route") {
      sortEl.value = cur === "route" ? "route-desc" : "route";
    } else if (key === "pickup") {
      sortEl.value = cur === "pickup" ? "pickup-desc" : "pickup";
    } else if (key === "voters") {
      sortEl.value = cur === "voters" ? "voters-desc" : "voters";
    } else if (key === "rate") {
      sortEl.value = cur === "rate" ? "rate-desc" : "rate";
    } else if (key === "amount") {
      sortEl.value = cur === "amount" ? "amount-desc" : "amount";
    } else {
      const map = {
        type: "type",
        vehicle: "vehicle",
        driver: "driver",
        status: "status",
        remarks: "remarks",
      };
      if (map[key]) sortEl.value = map[key];
    }
    renderZeroDayTripsTable();
  });
}

function initTransportTripsToolbarListeners() {
  const searchEl = document.getElementById("zeroDayTripsSearch");
  const filterEl = document.getElementById("zeroDayTripsFilterStatus");
  const sortEl = document.getElementById("zeroDayTripsSort");
  const groupEl = document.getElementById("zeroDayTripsGroupBy");
  const re = () => renderZeroDayTripsTable();
  if (searchEl && !searchEl.dataset.zdTripsToolbarBound) {
    searchEl.dataset.zdTripsToolbarBound = "1";
    searchEl.addEventListener("input", re);
  }
  if (filterEl && !filterEl.dataset.zdTripsToolbarBound) {
    filterEl.dataset.zdTripsToolbarBound = "1";
    filterEl.addEventListener("change", re);
  }
  if (sortEl && !sortEl.dataset.zdTripsToolbarBound) {
    sortEl.dataset.zdTripsToolbarBound = "1";
    sortEl.addEventListener("change", re);
  }
  if (groupEl && !groupEl.dataset.zdTripsToolbarBound) {
    groupEl.dataset.zdTripsToolbarBound = "1";
    groupEl.addEventListener("change", re);
  }
  bindTransportTripsTableHeaderSort();
}

function getTripTypeLabel(trip) {
  return TRIP_TYPES.find((t) => t.value === trip.tripType)?.label || trip.tripType || "—";
}

/** Label for route passengers modal: which trip (with trip pickup time when set). */
function tripAssignmentLabelForRouteModal(trip) {
  const typeLabel = getTripTypeLabel(trip);
  const name = (trip.route || "").trim() || `Trip ${trip.id}`;
  const pu = formatDateTime(trip.pickupTime);
  return pu ? `${typeLabel}: ${name} (${pu})` : `${typeLabel}: ${name}`;
}

function tripStatusBadgeClass(status) {
  if (status === "Completed") return "badge badge--success";
  if (status === "In progress") return "badge badge--warning";
  return "badge badge--secondary";
}

function getEmptyTransportMessage() {
  if (transportViewFilter === "flight") return "No flights. Add a trip and select type Flight.";
  if (transportViewFilter === "speedboat") return "No speed boats. Add a trip and select type Speed boat.";
  return "No trips yet. Add a trip and choose Flight or Speed boat.";
}

function getTripAssignedVoterCount(trip) {
  const byIds = Array.isArray(trip?.voterIds) ? trip.voterIds : [];
  const excluded = new Set((trip?.excludedVoterIds || []).map((x) => String(x).trim()));
  const voters = votersContext ? votersContext.getAllVoters() : [];
  if (!voters.length) {
    const explicit = byIds.map((x) => String(x).trim()).filter((x) => x && !excluded.has(x)).length;
    return trip?.voterCount != null ? Math.max(0, explicit) : explicit;
  }
  const normalizeRoute = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  const routeKey = normalizeRoute(trip?.route || "");
  const dedup = new Set();
  byIds.forEach((id) => {
    if (id != null && String(id).trim() && !excluded.has(String(id).trim())) dedup.add(String(id));
  });
  if (routeKey) {
    voters.forEach((v) => {
      if (!v || !voterTransportNeededFlag(v)) return;
      const r = normalizeRoute(v.transportRoute);
      if (!r) return;
      if (r === routeKey) {
        const key = v.id != null ? String(v.id) : v.nationalId != null ? String(v.nationalId) : "";
        if (key && !excluded.has(String(key).trim())) dedup.add(key);
      }
    });
  }
  return dedup.size;
}

function initTransportVisibleColumns() {
  try {
    const raw = localStorage.getItem(TRIPS_VISIBLE_COLS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const valid = new Set(TRIP_COLUMN_DEFAULT_KEYS);
        transportVisibleColumnKeys = parsed.filter((k) => valid.has(k));
        if (transportVisibleColumnKeys.length === 0) transportVisibleColumnKeys = TRIP_COLUMN_DEFAULT_KEYS.slice();
        return;
      }
    }
  } catch (_) {}
  transportVisibleColumnKeys = TRIP_COLUMN_DEFAULT_KEYS.slice();
}

function initTransportRoutesVisibleColumns() {
  try {
    const raw = localStorage.getItem(ROUTES_VISIBLE_COLS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const valid = new Set(ROUTE_COLUMN_DEFAULT_KEYS);
        transportRouteVisibleColumnKeys = parsed.filter((k) => valid.has(k));
        if (transportRouteVisibleColumnKeys.length === 0) {
          transportRouteVisibleColumnKeys = ROUTE_COLUMN_DEFAULT_KEYS.slice();
        }
        return;
      }
    }
  } catch (_) {}
  transportRouteVisibleColumnKeys = ROUTE_COLUMN_DEFAULT_KEYS.slice();
}

function getTransportVisibleColumnDefs() {
  const keys = new Set(transportVisibleColumnKeys);
  return TRIP_TABLE_COLUMN_DEFS.filter((c) => keys.has(c.key));
}

function getVisibleTripColumnCount() {
  return getTransportVisibleColumnDefs().length + 1;
}

function syncTransportTableHeader() {
  const theadRow = document.getElementById("zeroDayTripsTableHeadRow");
  if (!theadRow) return;
  const defs = getTransportVisibleColumnDefs();
  const ths = defs.map((col) => {
    const sortable = col.sortKey
      ? ` class="th-sortable" data-sort-key="${escapeHtml(col.sortKey)}"`
      : "";
    const ind = col.sortKey ? `<span class="sort-indicator"></span>` : "";
    return `<th scope="col"${sortable}>${escapeHtml(col.label)}${ind}</th>`;
  });
  ths.push(`<th scope="col"><span class="sr-only">Actions</span></th>`);
  theadRow.innerHTML = ths.join("");
}

function buildTripDataCellsHtml(trip) {
  const defs = getTransportVisibleColumnDefs();
  const typeLabel = getTripTypeLabel(trip);
  const count = getTripAssignedVoterCount(trip);
  const statusClass = tripStatusBadgeClass(trip.status);
  const tid = trip.id;
  return defs
    .map((col) => {
      switch (col.key) {
        case "type":
          return `<td><span class="badge badge--unknown">${escapeHtml(typeLabel)}</span></td>`;
        case "route":
          return `<td>${escapeHtml(trip.route)}</td>`;
        case "vehicle":
          return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--vehicle"><input type="text" class="input input--trip-table-meta" data-trip-meta-field="vehicle" data-trip-id="${tid}" value="${escapeHtml(trip.vehicle || "")}" placeholder="—" aria-label="Vessel or flight number" title="Vessel / flight no."></td>`;
        case "driver":
          return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--driver"><input type="text" class="input input--trip-table-meta" data-trip-meta-field="driver" data-trip-id="${tid}" value="${escapeHtml(trip.driver || "")}" placeholder="—" aria-label="Driver, pilot, or captain" title="Driver / captain"></td>`;
        case "pickup":
          return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--pickup"><input type="datetime-local" class="input input--trip-table-meta input--trip-pickup-local" data-trip-meta-field="pickupTime" data-trip-id="${tid}" value="${escapeHtml(toDatetimeLocalValue(trip.pickupTime))}" aria-label="Pickup time" title="Pickup time"></td>`;
        case "voters":
          return `<td>${count}</td>`;
        case "status":
          return `<td><span class="${escapeHtml(statusClass)}">${escapeHtml(trip.status)}</span></td>`;
        case "rate":
          return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--rate"><input type="text" class="input input--trip-table-meta" data-trip-meta-field="rate" data-trip-id="${tid}" value="${escapeHtml(trip.rate || "")}" placeholder="—" aria-label="Route rate" title="Rate for this route"></td>`;
        case "amount":
          return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--amount"><input type="text" class="input input--trip-table-meta" data-trip-meta-field="amount" data-trip-id="${tid}" value="${escapeHtml(trip.amount || "")}" placeholder="—" aria-label="Route amount" title="Amount for this route"></td>`;
        case "remarks":
          return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--remarks"><input type="text" class="input input--trip-table-meta input--trip-table-meta-remarks" data-trip-meta-field="remarks" data-trip-id="${tid}" value="${escapeHtml(trip.remarks || "")}" placeholder="Notes / remarks" aria-label="Route remarks" title="Remarks for this route"></td>`;
        default:
          return "<td></td>";
      }
    })
    .join("");
}

function buildTripActionsCellHtml(trip) {
  return `<td class="transport-trips-table__actions">
        <button type="button" class="ghost-button ghost-button--small" data-trip-status="${trip.id}" title="Change status" aria-label="Change status">Status</button>
        <button type="button" class="ghost-button ghost-button--small" data-view-trip-voters="${trip.id}" title="View voters">Voters</button>
        <button type="button" class="ghost-button ghost-button--small" data-edit-trip="${trip.id}">Edit</button>
        <button type="button" class="ghost-button ghost-button--small" data-delete-trip="${trip.id}" aria-label="Delete">Delete</button>
      </td>`;
}

function getTransportRouteVisibleColumnDefs() {
  const keys = new Set(transportRouteVisibleColumnKeys);
  return ROUTE_TABLE_COLUMN_DEFS.filter((c) => keys.has(c.key));
}

function getVisibleRouteColumnCount() {
  return getTransportRouteVisibleColumnDefs().length + 1;
}

function syncTransportRoutesTableHeader() {
  const theadRow = document.getElementById("zeroDayRoutesTableHeadRow");
  if (!theadRow) return;
  const defs = getTransportRouteVisibleColumnDefs();
  const ths = defs.map((col) => {
    const sortable = col.sortKey
      ? ` class="th-sortable" data-sort-key="${escapeHtml(col.sortKey)}"`
      : "";
    const ind = col.sortKey ? `<span class="sort-indicator"></span>` : "";
    return `<th scope="col"${sortable}>${escapeHtml(col.label)}${ind}</th>`;
  });
  ths.push(`<th scope="col"><span class="sr-only">Actions</span></th>`);
  theadRow.innerHTML = ths.join("");
}

function routeMatchesToolbarQuery(route, query) {
  if (!query) return true;
  const blob = [
    formatTransportRouteTripsCell(route),
    String(getTransportRouteDisplayNumber(route.id)),
    route.vehicle,
    route.driver,
    route.status,
    route.rate,
    route.amount,
    route.remarks,
    formatDateTime(route.pickupTime),
    String(getRouteAssignedVoterCount(route)),
  ]
    .map((x) => String(x ?? "").toLowerCase())
    .join(" ");
  return blob.includes(query);
}

function sortTransportRoutesByKey(arr, sortBy) {
  const pickupMs = (r) => (r.pickupTime ? new Date(r.pickupTime).getTime() : 0);
  const vCount = (r) => getRouteAssignedVoterCount(r);
  const tripsLabel = (r) => formatTransportRouteTripsCell(r);
  const displayOrder = (r) => {
    const sorted = getSortedTransportRoutesForDisplay();
    const ix = sorted.findIndex((x) => String(x.id) === String(r.id));
    return ix >= 0 ? ix : 999999;
  };
  arr.sort((a, b) => {
    switch (sortBy) {
      case "routeNum":
        return displayOrder(a) - displayOrder(b);
      case "pickup-desc":
        return pickupMs(b) - pickupMs(a);
      case "pickup":
        return pickupMs(a) - pickupMs(b);
      case "trips-desc":
        return tripsLabel(b).localeCompare(tripsLabel(a), "en");
      case "trips":
        return tripsLabel(a).localeCompare(tripsLabel(b), "en");
      case "vehicle":
        return (a.vehicle || "").localeCompare(b.vehicle || "", "en");
      case "driver":
        return (a.driver || "").localeCompare(b.driver || "", "en");
      case "voters-desc":
        return vCount(b) - vCount(a);
      case "voters":
        return vCount(a) - vCount(b);
      case "status":
        return (a.status || "").localeCompare(b.status || "", "en");
      case "rate-desc":
        return (b.rate || "").localeCompare(a.rate || "", "en", { numeric: true });
      case "rate":
        return (a.rate || "").localeCompare(b.rate || "", "en", { numeric: true });
      case "amount-desc":
        return (b.amount || "").localeCompare(a.amount || "", "en", { numeric: true });
      case "amount":
        return (a.amount || "").localeCompare(b.amount || "", "en", { numeric: true });
      case "remarks":
        return (a.remarks || "").localeCompare(b.remarks || "", "en");
      default:
        return displayOrder(a) - displayOrder(b);
    }
  });
}

function getFilteredTransportRoutes() {
  const list = [...zeroDayTransportRoutes];
  const searchEl = document.getElementById("zeroDayRoutesSearch");
  const filterEl = document.getElementById("zeroDayRoutesFilterStatus");
  const sortEl = document.getElementById("zeroDayRoutesSort");
  const query = (searchEl?.value || "").trim().toLowerCase();
  const statusFilter = (filterEl?.value || "all").trim();
  const sortBy = sortEl?.value || "routeNum";
  const filtered = list.filter((r) => {
    if (statusFilter !== "all" && String(r.status || "") !== statusFilter) return false;
    return routeMatchesToolbarQuery(r, query);
  });
  sortTransportRoutesByKey(filtered, sortBy);
  return filtered;
}

function getFilteredSortedGroupedTransportRoutes() {
  const filtered = getFilteredTransportRoutes();
  const groupEl = document.getElementById("zeroDayRoutesGroupBy");
  const groupBy = groupEl?.value || "none";
  if (groupBy === "none") {
    return filtered.map((route) => ({ type: "row", route }));
  }
  const getGroupKey = (r) => {
    if (groupBy === "status") return (r.status || "").trim() || "—";
    return "";
  };
  const displayList = [];
  let lastKey = null;
  for (const route of filtered) {
    const key = getGroupKey(route);
    if (key !== lastKey) {
      displayList.push({ type: "group", label: key });
      lastKey = key;
    }
    displayList.push({ type: "row", route });
  }
  return displayList;
}

function updateTransportRoutesSortIndicators() {
  const headers = document.querySelectorAll("#zeroDayRoutesTable thead th.th-sortable");
  if (!headers.length) return;
  const sortEl = document.getElementById("zeroDayRoutesSort");
  const sortBy = sortEl?.value || "routeNum";
  headers.forEach((th) => {
    const key = th.getAttribute("data-sort-key");
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    th.removeAttribute("aria-sort");
    if (key === "routeNum" && sortBy === "routeNum") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "trips" && (sortBy === "trips" || sortBy === "trips-desc")) {
      th.classList.add(sortBy === "trips" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "trips" ? "ascending" : "descending");
    } else if (key === "pickup" && (sortBy === "pickup" || sortBy === "pickup-desc")) {
      th.classList.add(sortBy === "pickup" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "pickup" ? "ascending" : "descending");
    } else if (key === "voters" && (sortBy === "voters" || sortBy === "voters-desc")) {
      th.classList.add(sortBy === "voters" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "voters" ? "ascending" : "descending");
    } else if (key === "rate" && (sortBy === "rate" || sortBy === "rate-desc")) {
      th.classList.add(sortBy === "rate" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "rate" ? "ascending" : "descending");
    } else if (key === "amount" && (sortBy === "amount" || sortBy === "amount-desc")) {
      th.classList.add(sortBy === "amount" ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", sortBy === "amount" ? "ascending" : "descending");
    } else if (key === "vehicle" && sortBy === "vehicle") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "driver" && sortBy === "driver") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "status" && sortBy === "status") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    } else if (key === "remarks" && sortBy === "remarks") {
      th.classList.add("is-sorted-asc");
      th.setAttribute("aria-sort", "ascending");
    }
  });
}

function bindTransportRoutesTableHeaderSort() {
  const thead = document.querySelector("#zeroDayRoutesTable thead");
  if (!thead || thead.dataset.transportRoutesSortBound === "1") return;
  thead.dataset.transportRoutesSortBound = "1";
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.th-sortable");
    if (!th) return;
    const key = th.getAttribute("data-sort-key");
    const sortEl = document.getElementById("zeroDayRoutesSort");
    if (!key || !sortEl) return;
    const cur = sortEl.value;
    if (key === "routeNum") {
      sortEl.value = "routeNum";
    } else if (key === "trips") {
      sortEl.value = cur === "trips" ? "trips-desc" : "trips";
    } else if (key === "pickup") {
      sortEl.value = cur === "pickup" ? "pickup-desc" : "pickup";
    } else if (key === "voters") {
      sortEl.value = cur === "voters" ? "voters-desc" : "voters";
    } else if (key === "rate") {
      sortEl.value = cur === "rate" ? "rate-desc" : "rate";
    } else if (key === "amount") {
      sortEl.value = cur === "amount" ? "amount-desc" : "amount";
    } else {
      const map = { vehicle: "vehicle", driver: "driver", status: "status", remarks: "remarks" };
      if (map[key]) sortEl.value = map[key];
    }
    renderTransportRoutesTable();
  });
}

function initTransportRoutesToolbarListeners() {
  const searchEl = document.getElementById("zeroDayRoutesSearch");
  const filterEl = document.getElementById("zeroDayRoutesFilterStatus");
  const sortEl = document.getElementById("zeroDayRoutesSort");
  const groupEl = document.getElementById("zeroDayRoutesGroupBy");
  const re = () => renderTransportRoutesTable();
  if (searchEl && !searchEl.dataset.zdRoutesToolbarBound) {
    searchEl.dataset.zdRoutesToolbarBound = "1";
    searchEl.addEventListener("input", re);
  }
  if (filterEl && !filterEl.dataset.zdRoutesToolbarBound) {
    filterEl.dataset.zdRoutesToolbarBound = "1";
    filterEl.addEventListener("change", re);
  }
  if (sortEl && !sortEl.dataset.zdRoutesToolbarBound) {
    sortEl.dataset.zdRoutesToolbarBound = "1";
    sortEl.addEventListener("change", re);
  }
  if (groupEl && !groupEl.dataset.zdRoutesToolbarBound) {
    groupEl.dataset.zdRoutesToolbarBound = "1";
    groupEl.addEventListener("change", re);
  }
  bindTransportRoutesTableHeaderSort();
}

function buildRouteDataCellsHtml(route, displayNum) {
  const count = getRouteAssignedVoterCount(route);
  const statusClass = tripStatusBadgeClass(route.status);
  const rid = escapeHtml(String(route.id));
  const defs = getTransportRouteVisibleColumnDefs();
  return defs.map((col) => {
    switch (col.key) {
      case "routeNum":
        return `<td><span class="badge badge--secondary">${displayNum}</span></td>`;
      case "trips": {
        const ids = Array.isArray(route.tripIds) ? route.tripIds : [];
        const trips = ids.map((tid) => findZeroDayTripById(tid)).filter(Boolean);
        const inner =
          trips.length === 0
            ? "—"
            : trips
                .map((t) => {
                  const p = getTransportRouteTripLineParts(t);
                  return `<div class="transport-route-trip-line"><div class="transport-route-trip-line__title">${escapeHtml(
                    p.title
                  )}</div><div class="transport-route-trip-line__pickup">${escapeHtml(p.pickupLabel)}</div></div>`;
                })
                .join("");
        return `<td class="transport-route-trips-cell">${inner}</td>`;
      }
      case "vehicle":
        return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--vehicle"><input type="text" class="input input--trip-table-meta" data-route-meta-field="vehicle" data-route-id="${rid}" value="${escapeHtml(route.vehicle || "")}" placeholder="—" aria-label="Vessel or flight number"></td>`;
      case "driver":
        return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--driver"><input type="text" class="input input--trip-table-meta" data-route-meta-field="driver" data-route-id="${rid}" value="${escapeHtml(route.driver || "")}" placeholder="—" aria-label="Driver, pilot, or captain"></td>`;
      case "pickup":
        return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--pickup"><input type="datetime-local" class="input input--trip-table-meta input--trip-pickup-local" data-route-meta-field="pickupTime" data-route-id="${rid}" value="${escapeHtml(toDatetimeLocalValue(route.pickupTime))}" aria-label="Pickup time"></td>`;
      case "voters":
        return `<td>${count}</td>`;
      case "status":
        return `<td><span class="${escapeHtml(statusClass)}">${escapeHtml(route.status)}</span></td>`;
      case "rate":
        return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--rate"><input type="text" class="input input--trip-table-meta" data-route-meta-field="rate" data-route-id="${rid}" value="${escapeHtml(route.rate || "")}" placeholder="—" aria-label="Rate"></td>`;
      case "amount":
        return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--amount"><input type="text" class="input input--trip-table-meta" data-route-meta-field="amount" data-route-id="${rid}" value="${escapeHtml(route.amount || "")}" placeholder="—" aria-label="Amount"></td>`;
      case "remarks":
        return `<td class="transport-trips-table__meta-cell transport-trips-table__meta-cell--remarks"><input type="text" class="input input--trip-table-meta input--trip-table-meta-remarks" data-route-meta-field="remarks" data-route-id="${rid}" value="${escapeHtml(route.remarks || "")}" placeholder="Notes / remarks" aria-label="Remarks"></td>`;
      default:
        return "<td></td>";
    }
  }).join("");
}

function buildRouteActionsCellHtml(route) {
  const rid = escapeHtml(String(route.id));
  return `<td class="transport-trips-table__actions">
        <button type="button" class="ghost-button ghost-button--small" data-route-status="${rid}" title="Change status">Status</button>
        <button type="button" class="ghost-button ghost-button--small" data-view-route-voters="${rid}" title="View voters">Voters</button>
        <button type="button" class="ghost-button ghost-button--small" data-edit-route="${rid}">Edit</button>
        <button type="button" class="ghost-button ghost-button--small" data-delete-route="${rid}" aria-label="Delete">Delete</button>
      </td>`;
}

function mergeRouteRowInputs(routeId) {
  const r = findTransportRouteById(routeId);
  if (!r) return null;
  const row = zeroDayRoutesTableBody?.querySelector(`tr[data-route-id="${String(routeId).replace(/"/g, "")}"]`);
  const vehicleInp = row?.querySelector('[data-route-meta-field="vehicle"]');
  const driverInp = row?.querySelector('[data-route-meta-field="driver"]');
  const pickupInp = row?.querySelector('[data-route-meta-field="pickupTime"]');
  const rateInp = row?.querySelector('[data-route-meta-field="rate"]');
  const amountInp = row?.querySelector('[data-route-meta-field="amount"]');
  const remarksInp = row?.querySelector('[data-route-meta-field="remarks"]');
  const vehicle = vehicleInp ? String(vehicleInp.value || "").trim() : String(r.vehicle || "");
  const driver = driverInp ? String(driverInp.value || "").trim() : String(r.driver || "");
  let pickupTime = r.pickupTime;
  if (pickupInp) {
    const iso = fromDatetimeLocalToIso(pickupInp.value);
    pickupTime = iso !== "" ? iso : r.pickupTime;
  }
  const rate = rateInp ? String(rateInp.value || "").trim() : String(r.rate || "");
  const amount = amountInp ? String(amountInp.value || "").trim() : String(r.amount || "");
  const remarks = remarksInp ? String(remarksInp.value || "").trim() : String(r.remarks || "");
  return { ...r, vehicle, driver, pickupTime, rate, amount, remarks };
}

function getAllVisibleRouteSnapshots() {
  return getFilteredTransportRoutes()
    .map((r) => mergeRouteRowInputs(r.id))
    .filter(Boolean);
}

function transportRoutesReportRowCells(r) {
  const displayNum = getTransportRouteDisplayNumber(r.id);
  const tripLines = getTransportRouteTripsReportLines(r);
  const tripsText = tripLines.length ? tripLines.join("\n") : "—";
  const tripsHtml = tripLines.length ? tripLines.map((line) => escapeHtml(line)).join("<br>") : escapeHtml("—");
  const remarks = String(r.remarks || "").trim();
  return {
    routeNum: String(displayNum || ""),
    tripsText,
    tripsHtml,
    remarks,
    remarksDisplay: remarks || "—",
  };
}

function openTransportRoutesReportWindow(routeSnapshots, autoPrint) {
  const list = Array.isArray(routeSnapshots) ? routeSnapshots.filter(Boolean) : [];
  if (!list.length) {
    if (window.appNotifications) {
      window.appNotifications.push({ title: "No routes", meta: "Add a route to generate a report." });
    }
    return;
  }
  const tbodyHtml = list
    .map((r) => {
      const c = transportRoutesReportRowCells(r);
      return `
          <tr>
            <td class="transport-routes-report-route-num">${escapeHtml(c.routeNum)}</td>
            <td class="transport-routes-report-trips">${c.tripsHtml}</td>
            <td class="transport-routes-report-remarks">${escapeHtml(c.remarksDisplay)}</td>
          </tr>`;
    })
    .join("");
  const printScript = autoPrint
    ? `<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},400);});<\/script>`
    : "";
  const title = `Transport routes (${list.length})`;
  const w = window.open("about:blank", "_blank");
  if (!w) {
    if (window.appNotifications) {
      window.appNotifications.push({ title: "Popup blocked", meta: "Allow popups for this site." });
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
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(title)}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap" rel="stylesheet">
        <style>
          :root {
            --color-text: #1f2937;
            --color-text-muted: #6b7280;
            --color-bg: #f5f7fb;
            --color-surface: #ffffff;
            --color-border-subtle: #e0e5f0;
            --color-border-strong: #c4ccdd;
            --color-primary: #009c9c;
            --color-accent: #007a7a;
          }
          body {
            font-family: "Poppins", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 0;
            padding: 20px 22px 28px;
            color: var(--color-text);
            background: var(--color-bg);
            font-size: 13px;
            line-height: 1.45;
          }
          .transport-routes-report-header {
            margin-bottom: 16px;
          }
          .transport-routes-report-header h1 {
            font-size: 1.35rem;
            font-weight: 600;
            margin: 0 0 6px;
            color: #0f766e;
            letter-spacing: -0.02em;
          }
          .transport-routes-report-header p {
            margin: 0;
            font-size: 12px;
            color: var(--color-text-muted);
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            background: var(--color-surface);
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 10px 25px rgba(15, 23, 42, 0.06);
          }
          th, td {
            border: 1px solid var(--color-border-subtle);
            padding: 8px 10px;
            text-align: left;
            vertical-align: top;
          }
          th {
            background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: #334155;
          }
          .transport-routes-report-route-num {
            width: 72px;
            white-space: nowrap;
            font-weight: 500;
          }
          .transport-routes-report-trips {
            white-space: normal;
            line-height: 1.5;
            min-width: 200px;
            width: 32%;
          }
          .transport-routes-report-remarks {
            min-width: 320px;
            width: 48%;
            max-width: none;
            white-space: normal;
            word-wrap: break-word;
            line-height: 1.5;
          }
          .transport-routes-report-actions {
            margin-top: 20px;
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            align-items: center;
          }
          .primary-button,
          .ghost-button {
            border-radius: 999px;
            padding: 8px 16px;
            border: 1px solid transparent;
            font-size: 13px;
            font-family: inherit;
            font-weight: 500;
            cursor: pointer;
          }
          .primary-button {
            background: linear-gradient(135deg, #1d4ed8, #0f766e);
            color: #fff;
            box-shadow: 0 10px 20px rgba(37, 99, 235, 0.28);
          }
          .primary-button:hover {
            filter: brightness(1.03);
          }
          .ghost-button {
            background-color: transparent;
            border-color: var(--color-border-subtle);
            color: var(--color-text);
          }
          .ghost-button:hover {
            background: rgba(0, 156, 156, 0.06);
            border-color: var(--color-primary);
          }
          @media print {
            body { background: #fff; padding: 12px; }
            table { box-shadow: none; border-radius: 0; }
            .transport-routes-report-actions { display: none !important; }
          }
        </style>
      </head>
      <body>
        <header class="transport-routes-report-header">
          <h1>Transportation routes</h1>
          <p>${escapeHtml(new Date().toLocaleString("en-MV"))}</p>
        </header>
        <table>
          <thead>
            <tr>
              <th scope="col">Route #</th>
              <th scope="col">Trips</th>
              <th scope="col">Remarks</th>
            </tr>
          </thead>
          <tbody>${tbodyHtml}</tbody>
        </table>
        <div class="transport-routes-report-actions">
          <button type="button" class="primary-button" onclick="window.print()">Print</button>
          <button type="button" class="ghost-button" onclick="window.close()">Close</button>
        </div>
        ${printScript}
      </body>
      </html>
    `);
  w.document.close();
  w.focus();
}

function downloadTransportRoutesReportCsv(routeSnapshots) {
  const list = Array.isArray(routeSnapshots) ? routeSnapshots.filter(Boolean) : [];
  if (!list.length) {
    if (window.appNotifications) {
      window.appNotifications.push({ title: "No routes", meta: "Add a route to export." });
    }
    return;
  }
  const headers = ["Route #", "Trips", "Remarks"];
  const lines = [headers.map(csvEscapeTransportCell).join(",")];
  list.forEach((r) => {
    const c = transportRoutesReportRowCells(r);
    lines.push([c.routeNum, c.tripsText, c.remarks].map(csvEscapeTransportCell).join(","));
  });
  const csv = lines.join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `transport-routes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function shareTransportRoutesReport(routeSnapshots) {
  const list = Array.isArray(routeSnapshots) ? routeSnapshots.filter(Boolean) : [];
  if (!list.length) {
    if (window.appNotifications) {
      window.appNotifications.push({ title: "No routes", meta: "Nothing to share." });
    }
    return;
  }
  const headerLine = ["Route #", "Trips", "Remarks"].join("\t");
  const rowLines = [headerLine];
  list.forEach((r) => {
    const c = transportRoutesReportRowCells(r);
    rowLines.push([c.routeNum, c.tripsText, c.remarks].join("\t"));
  });
  const title = `Transport routes (${list.length})`;
  const text = `${title}\n\n${rowLines.join("\n")}`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    if (typeof window.showToast === "function") window.showToast("Report copied to clipboard");
  } catch (_) {}
}

function deleteTransportRoute(id) {
  const idx = zeroDayTransportRoutes.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) return;
  recordTransportRouteDeleted(id);
  zeroDayTransportRoutes.splice(idx, 1);
  saveTransportRoutes();
  firebaseInitPromise
    .then((api) => {
      if (api.ready && api.deleteTransportRouteFs) return api.deleteTransportRouteFs(id);
    })
    .catch((err) => {
      console.warn("[ZeroDay] deleteTransportRouteFs failed", id, err);
    });
  renderTransportRoutesTable();
}

function setTransportRouteStatus(routeId, status) {
  const route = findTransportRouteById(routeId);
  if (!route || !TRIP_STATUSES.includes(status)) return;
  route.status = status;
  saveTransportRoutes();
  firebaseInitPromise.then((api) => {
    if (api.ready && api.setTransportRouteFs) return api.setTransportRouteFs(route);
  }).catch(() => {});
  renderTransportRoutesTable();
}

function openTransportRouteStatusModal(routeId) {
  const route = findTransportRouteById(routeId);
  if (!route) return;
  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.flexWrap = "wrap";
  body.style.gap = "8px";
  TRIP_STATUSES.forEach((status) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = route.status === status ? "primary-button" : "ghost-button";
    btn.textContent = status;
    btn.addEventListener("click", () => {
      setTransportRouteStatus(routeId, status);
      closeModal();
    });
    body.appendChild(btn);
  });
  const label = formatTransportRouteTripsCell(route);
  openModal({ title: `Set status: ${escapeHtml(label)}`, body });
}

function openTransportRouteVotersModal(route) {
  openTripVotersModal(route, { mode: "route" });
}

/** Lowercase haystack for route-modal trip search (type, route, vehicle, driver, pickup, id). */
function haystackForRouteTripPickerTrip(t) {
  return [
    getTripTypeLabel(t),
    t.route,
    t.vehicle,
    t.driver,
    formatDateTime(t.pickupTime),
    String(t.id),
    t.tripType,
  ]
    .map((x) => String(x || "").toLowerCase())
    .join(" ");
}

function openRouteForm(existing) {
  const isEdit = !!existing;
  loadTrips();
  const sortedTrips = [...zeroDayTrips].sort((a, b) => {
    const ra = String(a.route || "").localeCompare(String(b.route || ""), "en");
    if (ra !== 0) return ra;
    return Number(a.id) - Number(b.id);
  });
  const nextDisplay = getSortedTransportRoutesForDisplay().length + (isEdit ? 0 : 1);

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label>Route number</label>
        <input type="text" readonly class="input" value="${
          isEdit ? String(getTransportRouteDisplayNumber(existing.id)) : String(nextDisplay)
        }" aria-readonly="true" title="Numbers reorder when routes are deleted">
        <p class="helper-text">Shown in the table by creation order. If you delete a route, numbers update automatically.</p>
      </div>
      <div class="form-group" style="grid-column: 1 / -1;">
        <label for="zdRouteTripsSearch">Trips on this route (select one or more)</label>
        <div class="transport-route-trip-picker">
          <div class="transport-route-trip-picker__toolbar">
            <input type="search" id="zdRouteTripsSearch" class="input transport-route-trip-picker__search" placeholder="Search by route, type, pickup, vehicle, driver, ID…" autocomplete="off" spellcheck="false" aria-label="Search trips to add to route">
            <div class="pill-toggle-group transport-route-trip-picker__filters" role="group" aria-label="Filter by transport type">
              <span class="detail-item-label transport-route-trip-picker__filter-label">Type</span>
              <button type="button" class="pill-toggle pill-toggle--active" data-zd-route-trips-filter="all">All</button>
              <button type="button" class="pill-toggle" data-zd-route-trips-filter="flight">Flight</button>
              <button type="button" class="pill-toggle" data-zd-route-trips-filter="speedboat">Speed boat</button>
            </div>
          </div>
          <p id="zdRouteTripsPickerHint" class="helper-text transport-route-trip-picker__hint"></p>
          <div id="zdRouteTripsMulti" class="transport-route-trip-checkboxes" style="max-height: 200px; overflow: auto; border: 1px solid var(--color-border-strong); border-radius: var(--radius-md); padding: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
          <p id="zdRouteTripsPickerEmpty" class="helper-text text-muted transport-route-trip-picker__empty" hidden>No trips match your search or filters.</p>
        </div>
      </div>
      <div class="form-group">
        <label for="zdRouteDriver">Driver / Pilot / Captain</label>
        <input id="zdRouteDriver" type="text" value="${escapeHtml(existing?.driver || "")}" placeholder="Name">
      </div>
      <div class="form-group">
        <label for="zdRouteVehicle">Vessel name / Flight number</label>
        <input id="zdRouteVehicle" type="text" value="${escapeHtml(existing?.vehicle || "")}" placeholder="e.g. MDR-301">
      </div>
      <div class="form-group">
        <label for="zdRoutePickupTime">Pickup time</label>
        <input id="zdRoutePickupTime" type="datetime-local" value="${
          existing && existing.pickupTime
            ? toDatetimeLocalValue(existing.pickupTime)
            : new Date().toISOString().slice(0, 16)
        }">
      </div>
      <div class="form-group">
        <label for="zdRouteStatus">Status</label>
        <select id="zdRouteStatus">
          ${TRIP_STATUSES.map(
            (s) =>
              `<option value="${s}"${existing?.status === s ? " selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label for="zdRouteRate">Rate</label>
        <input id="zdRouteRate" type="text" value="${escapeHtml(existing?.rate || "")}" placeholder="—">
      </div>
      <div class="form-group">
        <label for="zdRouteAmount">Amount</label>
        <input id="zdRouteAmount" type="text" value="${escapeHtml(existing?.amount || "")}" placeholder="—">
      </div>
      <div class="form-group" style="grid-column: 1 / -1;">
        <label for="zdRouteRemarks">Remarks</label>
        <input id="zdRouteRemarks" type="text" value="${escapeHtml(existing?.remarks || "")}" placeholder="Optional notes">
      </div>
    </div>
  `;

  const tripBox = body.querySelector("#zdRouteTripsMulti");
  const searchInput = body.querySelector("#zdRouteTripsSearch");
  const hintEl = body.querySelector("#zdRouteTripsPickerHint");
  const emptyEl = body.querySelector("#zdRouteTripsPickerEmpty");
  const tripById = new Map();
  sortedTrips.forEach((t) => {
    const id = Number(t.id);
    if (!Number.isNaN(id)) tripById.set(id, t);
  });

  const selectedSet = new Set((existing?.tripIds || []).map((x) => Number(x)));
  sortedTrips.forEach((t) => {
    const id = Number(t.id);
    if (Number.isNaN(id)) return;
    const label = document.createElement("label");
    label.className = "zd-route-trip-picker-row";
    label.setAttribute("data-zd-route-trip-row", "1");
    label.setAttribute("data-zd-trip-id", String(id));
    label.style.display = "flex";
    label.style.alignItems = "flex-start";
    label.style.gap = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(id);
    cb.dataset.zdRouteTripCb = "1";
    cb.checked = selectedSet.has(id);
    const typeLabel = getTripTypeLabel(t);
    const routeName = (t.route || "").trim() || `Trip ${id}`;
    const pickupLine = formatDateTime(t.pickupTime);
    const metaBits = [t.vehicle, t.driver].filter((x) => String(x || "").trim()).join(" · ");
    label.appendChild(cb);
    const textWrap = document.createElement("span");
    textWrap.className = "zd-route-trip-picker-row__text";
    const titleLine = document.createElement("span");
    titleLine.className = "zd-route-trip-picker-row__title";
    titleLine.textContent = `${typeLabel}: ${routeName}`;
    textWrap.appendChild(titleLine);
    if (pickupLine || metaBits) {
      const sub = document.createElement("span");
      sub.className = "zd-route-trip-picker-row__sub text-muted";
      sub.textContent = [pickupLine, metaBits].filter(Boolean).join(" · ");
      textWrap.appendChild(sub);
    }
    label.appendChild(textWrap);
    tripBox.appendChild(label);
  });

  let typeFilter = "all";
  const applyRouteTripPickerFilter = () => {
    const q = String(searchInput?.value || "").trim().toLowerCase();
    const rows = tripBox.querySelectorAll("[data-zd-route-trip-row]");
    let shown = 0;
    rows.forEach((row) => {
      const id = Number(row.getAttribute("data-zd-trip-id"));
      const trip = tripById.get(id);
      if (!trip) {
        row.style.display = "none";
        return;
      }
      const tt = trip.tripType || "flight";
      const typeOk = typeFilter === "all" || tt === typeFilter;
      const searchOk = !q || haystackForRouteTripPickerTrip(trip).includes(q);
      const visible = typeOk && searchOk;
      row.style.display = visible ? "flex" : "none";
      if (visible) shown += 1;
    });
    const total = rows.length;
    if (hintEl) {
      if (total === 0) {
        hintEl.textContent = "No trips yet. Add trips in the Trips tab, then link them here.";
      } else {
        hintEl.textContent =
          shown === total
            ? `${total} trip${total === 1 ? "" : "s"}`
            : `Showing ${shown} of ${total} trips`;
      }
    }
    if (emptyEl) {
      emptyEl.hidden = !(total > 0 && shown === 0);
    }
  };

  applyRouteTripPickerFilter();
  searchInput?.addEventListener("input", applyRouteTripPickerFilter);
  body.querySelectorAll("[data-zd-route-trips-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      typeFilter = btn.getAttribute("data-zd-route-trips-filter") || "all";
      body.querySelectorAll("[data-zd-route-trips-filter]").forEach((b) =>
        b.classList.toggle("pill-toggle--active", b === btn)
      );
      applyRouteTripPickerFilter();
    });
  });

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
  saveBtn.textContent = isEdit ? "Save route" : "Add route";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", async () => {
    const checkboxes = [...body.querySelectorAll("[data-zd-route-trip-cb]")];
    const tripIds = checkboxes.filter((c) => c.checked).map((c) => Number(c.value)).filter((n) => !Number.isNaN(n));
    if (!tripIds.length) {
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Select trips", meta: "Choose at least one trip for this route." });
      }
      return;
    }
    const driver = body.querySelector("#zdRouteDriver").value.trim();
    const vehicle = body.querySelector("#zdRouteVehicle").value.trim();
    const pickupRaw = body.querySelector("#zdRoutePickupTime").value;
    const status = body.querySelector("#zdRouteStatus").value;
    const remarks = body.querySelector("#zdRouteRemarks").value.trim();
    const rate = body.querySelector("#zdRouteRate").value.trim();
    const amount = body.querySelector("#zdRouteAmount").value.trim();
    const pickupTime = pickupRaw ? new Date(pickupRaw).toISOString() : "";
    if (isEdit) {
      existing.tripIds = tripIds;
      existing.driver = driver;
      existing.vehicle = vehicle;
      existing.pickupTime = pickupTime;
      existing.status = status || "Scheduled";
      existing.remarks = remarks;
      existing.rate = rate;
      existing.amount = amount;
    } else {
      const id = newTransportRouteId();
      zeroDayTransportRoutes.push(
        normalizeTransportRoute({
          id,
          tripIds,
          createdAt: Date.now(),
          driver,
          vehicle,
          pickupTime,
          status: status || "Scheduled",
          remarks,
          rate,
          amount,
          onboardedVoterIds: [],
        })
      );
    }
    saveTransportRoutes();
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setTransportRouteFs) {
        const r = isEdit
          ? findTransportRouteById(existing.id)
          : zeroDayTransportRoutes[zeroDayTransportRoutes.length - 1];
        if (r) await api.setTransportRouteFs(r);
      }
    } catch (_) {}
    renderTransportRoutesTable();
    closeModal();
  });

  openModal({
    title: isEdit ? "Edit route" : "Add route",
    body,
    footer,
  });
}

function renderTransportRoutesTable() {
  if (!zeroDayRoutesTableBody) return;
  initTransportRoutesToolbarListeners();
  syncTransportRoutesTableHeader();
  const colSpan = getVisibleRouteColumnCount();

  if (!zeroDayTransportRoutes.length) {
    zeroDayRoutesTableBody.innerHTML = `
      <tr>
        <td colspan="${colSpan}" class="text-muted" style="text-align: center; padding: 24px;">No routes yet. Add a route and link one or more trips.</td>
      </tr>
    `;
    updateTransportRoutesSortIndicators();
    return;
  }

  const displayList = getFilteredSortedGroupedTransportRoutes();
  const dataRows = displayList.filter((x) => x.type === "row");
  if (!dataRows.length) {
    zeroDayRoutesTableBody.innerHTML = `
      <tr>
        <td colspan="${colSpan}" class="text-muted" style="text-align: center; padding: 24px;">No routes match your search or filters.</td>
      </tr>
    `;
    updateTransportRoutesSortIndicators();
    return;
  }

  const sortedForDisplay = getSortedTransportRoutesForDisplay();
  const displayNumById = new Map();
  sortedForDisplay.forEach((r, i) => displayNumById.set(String(r.id), i + 1));

  zeroDayRoutesTableBody.innerHTML = "";
  for (const item of displayList) {
    if (item.type === "group") {
      const tr = document.createElement("tr");
      tr.className = "pledges-toolbar__group-header";
      tr.innerHTML = `<td colspan="${colSpan}">${escapeHtml(item.label)}</td>`;
      zeroDayRoutesTableBody.appendChild(tr);
      continue;
    }
    const route = item.route;
    const tr = document.createElement("tr");
    tr.dataset.routeId = String(route.id);
    const dnum = displayNumById.get(String(route.id)) || 0;
    tr.innerHTML = buildRouteDataCellsHtml(route, dnum) + buildRouteActionsCellHtml(route);
    zeroDayRoutesTableBody.appendChild(tr);
  }
  updateTransportRoutesSortIndicators();
}

function bindTransportMainTabs() {
  const tabs = document.querySelectorAll("[data-transport-main-tab]");
  const panelTrips = document.getElementById("transport-panel-trips");
  const panelRoutes = document.getElementById("transport-panel-routes");
  if (!tabs.length || !panelTrips || !panelRoutes) return;
  if (document.documentElement.dataset.transportMainTabsBound === "1") return;
  document.documentElement.dataset.transportMainTabsBound = "1";

  function activate(which) {
    tabs.forEach((btn) => {
      const w = btn.getAttribute("data-transport-main-tab");
      const on = w === which;
      btn.classList.toggle("transport-main-tabs__tab--active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const showRoutes = which === "routes";
    panelTrips.classList.toggle("transport-tab-panel--hidden", showRoutes);
    panelTrips.hidden = showRoutes;
    panelRoutes.classList.toggle("transport-tab-panel--hidden", !showRoutes);
    panelRoutes.hidden = !showRoutes;
    if (showRoutes) renderTransportRoutesTable();
  }

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      activate(btn.getAttribute("data-transport-main-tab") || "trips");
    });
  });
}

function openTransportColumnsModal() {
  let keys = [...transportVisibleColumnKeys];
  const body = document.createElement("div");
  body.className = "form-group";
  const p = document.createElement("p");
  p.className = "helper-text";
  p.textContent = "Choose which columns appear in the transportation table.";
  body.appendChild(p);
  const div = document.createElement("div");
  div.style.display = "flex";
  div.style.flexDirection = "column";
  div.style.gap = "8px";
  TRIP_TABLE_COLUMN_DEFS.forEach((opt) => {
    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = keys.includes(opt.key);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!keys.includes(opt.key)) keys.push(opt.key);
      } else {
        keys = keys.filter((k) => k !== opt.key);
      }
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(opt.label));
    div.appendChild(label);
  });
  body.appendChild(div);
  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary-button";
  saveBtn.textContent = "Apply";
  saveBtn.addEventListener("click", () => {
    if (keys.length === 0) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Columns",
          meta: "Keep at least one column visible.",
        });
      }
      return;
    }
    transportVisibleColumnKeys = [...keys];
    try {
      localStorage.setItem(TRIPS_VISIBLE_COLS_KEY, JSON.stringify(transportVisibleColumnKeys));
    } catch (_) {}
    closeModal();
    renderZeroDayTripsTable();
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  openModal({ title: "Transportation columns", body, footer });
}

function openTransportRoutesColumnsModal() {
  let keys = [...transportRouteVisibleColumnKeys];
  const body = document.createElement("div");
  body.className = "form-group";
  const p = document.createElement("p");
  p.className = "helper-text";
  p.textContent = "Choose which columns appear in the transportation routes table.";
  body.appendChild(p);
  const div = document.createElement("div");
  div.style.display = "flex";
  div.style.flexDirection = "column";
  div.style.gap = "8px";
  ROUTE_TABLE_COLUMN_DEFS.forEach((opt) => {
    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = keys.includes(opt.key);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!keys.includes(opt.key)) keys.push(opt.key);
      } else {
        keys = keys.filter((k) => k !== opt.key);
      }
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(opt.label));
    div.appendChild(label);
  });
  body.appendChild(div);
  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary-button";
  saveBtn.textContent = "Apply";
  saveBtn.addEventListener("click", () => {
    if (keys.length === 0) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Columns",
          meta: "Keep at least one column visible.",
        });
      }
      return;
    }
    transportRouteVisibleColumnKeys = [...keys];
    try {
      localStorage.setItem(ROUTES_VISIBLE_COLS_KEY, JSON.stringify(transportRouteVisibleColumnKeys));
    } catch (_) {}
    closeModal();
    renderTransportRoutesTable();
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  openModal({ title: "Route table columns", body, footer });
}

function bindTransportColumnsMenuOnce() {
  if (document.documentElement.dataset.transportColumnsMenuBound === "1") return;
  document.documentElement.dataset.transportColumnsMenuBound = "1";
  document.addEventListener("click", (e) => {
    const openRoutesBtn = e.target.closest("[data-transport-routes-columns-open]");
    if (openRoutesBtn) {
      e.preventDefault();
      e.stopPropagation();
      openTransportRoutesColumnsModal();
      const wrap = openRoutesBtn.closest("[data-table-view-for]");
      if (wrap) {
        const menu = wrap.querySelector("[data-table-view-dropdown]");
        const tb = wrap.querySelector(".table-view-menu-btn");
        if (menu) menu.hidden = true;
        if (tb) tb.setAttribute("aria-expanded", "false");
      }
      return;
    }
    const openBtn = e.target.closest("[data-transport-columns-open]");
    if (!openBtn) return;
    e.preventDefault();
    e.stopPropagation();
    openTransportColumnsModal();
    const wrap = openBtn.closest("[data-table-view-for]");
    if (wrap) {
      const menu = wrap.querySelector("[data-table-view-dropdown]");
      const tb = wrap.querySelector(".table-view-menu-btn");
      if (menu) menu.hidden = true;
      if (tb) tb.setAttribute("aria-expanded", "false");
    }
  });
}

function renderZeroDayTripsTable() {
  if (!zeroDayTripsTableBody) return;
  initTransportTripsToolbarListeners();
  syncTransportTableHeader();

  const colSpan = getVisibleTripColumnCount();

  if (!zeroDayTrips.length) {
    zeroDayTripsTableBody.innerHTML = `
      <tr>
        <td colspan="${colSpan}" class="text-muted" style="text-align: center; padding: 24px;">${getEmptyTransportMessage()}</td>
      </tr>
    `;
    updateTransportTripsSortIndicators();
    renderTransportRoutesTable();
    return;
  }

  const afterType = getTransportTripsAfterTypeFilter();
  if (!afterType.length) {
    zeroDayTripsTableBody.innerHTML = `
      <tr>
        <td colspan="${colSpan}" class="text-muted" style="text-align: center; padding: 24px;">${getEmptyTransportMessage()}</td>
      </tr>
    `;
    updateTransportTripsSortIndicators();
    renderTransportRoutesTable();
    return;
  }

  const displayList = getFilteredSortedGroupedTransportTrips();
  const dataRows = displayList.filter((x) => x.type === "row");
  if (!dataRows.length) {
    zeroDayTripsTableBody.innerHTML = `
      <tr>
        <td colspan="${colSpan}" class="text-muted" style="text-align: center; padding: 24px;">No trips match your search or filters.</td>
      </tr>
    `;
    updateTransportTripsSortIndicators();
    renderTransportRoutesTable();
    return;
  }

  zeroDayTripsTableBody.innerHTML = "";
  for (const item of displayList) {
    if (item.type === "group") {
      const tr = document.createElement("tr");
      tr.className = "pledges-toolbar__group-header";
      tr.innerHTML = `<td colspan="${colSpan}">${escapeHtml(item.label)}</td>`;
      zeroDayTripsTableBody.appendChild(tr);
      continue;
    }
    const trip = item.trip;
    const tr = document.createElement("tr");
    tr.dataset.tripId = String(trip.id);
    tr.innerHTML = buildTripDataCellsHtml(trip) + buildTripActionsCellHtml(trip);
    zeroDayTripsTableBody.appendChild(tr);
  }
  updateTransportTripsSortIndicators();
  renderTransportRoutesTable();
}

function openTripForm(existing, defaultType) {
  const isEdit = !!existing;
  const tripType = existing?.tripType || defaultType || "flight";
  const typeLabel = TRIP_TYPES.find((t) => t.value === tripType)?.label || "Trip";

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="zdTripType">Type</label>
        <select id="zdTripType">
          ${TRIP_TYPES.map(
            (t) =>
              `<option value="${t.value}"${tripType === t.value ? " selected" : ""}>${t.label}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label for="zdTripRoute">Trip / Route name</label>
        <input id="zdTripRoute" type="text" value="${escapeHtml(existing?.route || "")}" placeholder="e.g. North pickup run 1">
      </div>
      <div class="form-group">
        <label for="zdTripDriver">Driver / Pilot / Captain</label>
        <input id="zdTripDriver" type="text" value="${escapeHtml(existing?.driver || "")}" placeholder="Name">
      </div>
      <div class="form-group">
        <label for="zdTripVehicle">Vessel name / Flight number</label>
        <input id="zdTripVehicle" type="text" value="${escapeHtml(existing?.vehicle || "")}" placeholder="e.g. MDR-301 or Flight XY123">
      </div>
      <div class="form-group">
        <label for="zdTripPickupTime">Pickup time</label>
        <input id="zdTripPickupTime" type="datetime-local" value="${
          existing && existing.pickupTime
            ? existing.pickupTime.slice(0, 16)
            : new Date().toISOString().slice(0, 16)
        }">
      </div>
      <div class="form-group">
        <label for="zdTripStatus">Status</label>
        <select id="zdTripStatus">
          ${TRIP_STATUSES.map(
            (s) =>
              `<option value="${s}"${existing?.status === s ? " selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group" style="grid-column: 1 / -1;">
        <label for="zdTripRemarks">Remarks</label>
        <input id="zdTripRemarks" type="text" value="${escapeHtml(existing?.remarks || "")}" placeholder="Optional route notes">
      </div>
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
  saveBtn.textContent = isEdit ? "Save changes" : "Add trip";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", async () => {
    const type = body.querySelector("#zdTripType").value;
    const route = body.querySelector("#zdTripRoute").value.trim();
    const driver = body.querySelector("#zdTripDriver").value.trim();
    const vehicle = body.querySelector("#zdTripVehicle").value.trim();
    const pickupTime = body.querySelector("#zdTripPickupTime").value;
    const status = body.querySelector("#zdTripStatus").value;
    const remarks = body.querySelector("#zdTripRemarks").value.trim();
    if (!route) return;
    if (isEdit) {
      existing.tripType = type;
      existing.route = route;
      existing.driver = driver;
      existing.vehicle = vehicle;
      existing.pickupTime = pickupTime ? new Date(pickupTime).toISOString() : "";
      existing.status = status;
      existing.remarks = remarks;
    } else {
      const nextId =
        zeroDayTrips.reduce((max, t) => Math.max(max, t.id), 0) + 1;
      zeroDayTrips.push(normalizeTrip({
        id: nextId,
        tripType: type,
        route,
        driver,
        vehicle,
        pickupTime: pickupTime ? new Date(pickupTime).toISOString() : "",
        status: status || "Scheduled",
        remarks,
        voterCount: 0,
        voterIds: [],
      }));
    }
    saveTrips();
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setTransportTripFs) {
        const t = zeroDayTrips.find((x) => x.id === (isEdit ? existing.id : zeroDayTrips[zeroDayTrips.length - 1].id));
        if (t) await api.setTransportTripFs(t);
      }
    } catch (_) {}
    renderZeroDayTripsTable();
    closeModal();
  });

  openModal({
    title: isEdit ? "Edit trip" : "Add trip",
    body,
    footer,
  });
}

function deleteTrip(id) {
  const idx = zeroDayTrips.findIndex((t) => String(t.id) === String(id));
  if (idx === -1) return;
  recordTransportTripDeleted(id);
  zeroDayTrips.splice(idx, 1);
  saveTrips();
  firebaseInitPromise
    .then((api) => {
      if (api.ready && api.deleteTransportTripFs) return api.deleteTransportTripFs(id);
    })
    .catch((err) => {
      console.warn("[ZeroDay] deleteTransportTripFs failed", id, err);
    });
  renderZeroDayTripsTable();
}

function setTripStatus(tripId, status) {
  const trip = findZeroDayTripById(tripId);
  if (!trip || !TRIP_STATUSES.includes(status)) return;
  trip.status = status;
  saveTrips();
  firebaseInitPromise.then((api) => {
    if (api.ready && api.setTransportTripFs) return api.setTransportTripFs(trip);
  }).catch(() => {});
  renderZeroDayTripsTable();
}

function openTripStatusModal(tripId) {
  const trip = findZeroDayTripById(tripId);
  if (!trip) return;
  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.flexWrap = "wrap";
  body.style.gap = "8px";
  TRIP_STATUSES.forEach((status) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = trip.status === status ? "primary-button" : "ghost-button";
    btn.textContent = status;
    btn.addEventListener("click", () => {
      setTripStatus(tripId, status);
      closeModal();
    });
    body.appendChild(btn);
  });
  openModal({ title: `Set status: ${escapeHtml(trip.route)}`, body });
}

function openTripVotersModal(tripOrRoute, opts = {}) {
  const mode = opts && opts.mode === "route" ? "route" : "trip";
  const entityId = tripOrRoute.id;
  const getLiveEntity = () =>
    mode === "route"
      ? findTransportRouteById(entityId) || tripOrRoute
      : findZeroDayTripById(entityId) || tripOrRoute;
  const title =
    mode === "route"
      ? `Route passengers – ${formatTransportRouteTripsCell(getLiveEntity())}`
      : `Assigned voters – ${tripOrRoute.route || "Route"}`;
  const body = document.createElement("div");
  body.className = "modal-body-inner modal-body-inner--with-maximize";
  let lastRenderedRows = [];

  const summary = document.createElement("div");
  summary.className = "helper-text";
  summary.style.margin = "6px 0 10px";

  const listToolbar = document.createElement("div");
  listToolbar.className = "modal-list-toolbar list-toolbar";
  listToolbar.innerHTML = `
    <div class="list-toolbar__search">
      <label for="zdTripVotersSearch" class="sr-only">Search</label>
      <input type="search" id="zdTripVotersSearch" placeholder="Search by name, ID, address, location, ballot box…">
    </div>
    <div class="list-toolbar__controls">
      <div class="field-group field-group--inline">
        <label for="zdTripVotersFilter">Filter</label>
        <select id="zdTripVotersFilter">
          <option value="all">All pledge statuses</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
          <option value="undecided">Undecided</option>
        </select>
      </div>
      <div class="field-group field-group--inline trip-filter-ballot-wrap">
        <span class="trip-filter-ballot-label" id="zdTripVotersBallotLabel">Ballot box</span>
        <div class="trip-filter-ballot-dropdown" id="zdTripVotersBallotDropdown">
          <button type="button" class="ghost-button ghost-button--small" id="zdTripVotersBallotToggle" aria-expanded="false" aria-haspopup="true" aria-controls="zdTripVotersBallotPanel">
            <span id="zdTripVotersBallotSummary">All boxes</span>
          </button>
          <div class="trip-filter-ballot-panel" id="zdTripVotersBallotPanel" hidden role="group" aria-label="Filter by ballot box">
            <label class="trip-filter-ballot-all">
              <input type="checkbox" id="zdTripVotersBallotAll" checked />
              <span>All ballot boxes</span>
            </label>
            <div class="trip-filter-ballot-list" id="zdTripVotersBallotList"></div>
          </div>
        </div>
      </div>
      <div class="field-group field-group--inline">
        <label for="zdTripVotersSort">Sort</label>
        <select id="zdTripVotersSort">
          <option value="sequence">Seq</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="id">ID Number</option>
          <option value="address">Permanent address</option>
          <option value="ballot">Ballot box</option>
          <option value="pledge">Pledge status</option>
          <option value="agent">Agent</option>
        </select>
      </div>
      <div class="field-group field-group--inline">
        <label for="zdTripVotersGroupBy">Group by</label>
        <select id="zdTripVotersGroupBy">
          <option value="none">None</option>
          <option value="pledge">Pledge status</option>
          <option value="agent">Agent</option>
          <option value="ballot">Ballot box</option>
        </select>
      </div>
      <div class="field-group field-group--inline">
        <label for="zdTripVotersPermAddr">Permanent address</label>
        <select id="zdTripVotersPermAddr"><option value="all">All addresses</option></select>
      </div>
      <div class="field-group field-group--inline">
        <label for="zdTripVotersCurrLoc">Current location</label>
        <select id="zdTripVotersCurrLoc"><option value="all">All locations</option></select>
      </div>
    </div>
  `;

  const topBar = document.createElement("div");
  topBar.className = "modal-body-toolbar";
  const maxBtn = document.createElement("button");
  maxBtn.type = "button";
  maxBtn.className = "ghost-button ghost-button--small";
  maxBtn.setAttribute("aria-label", "Maximize");
  maxBtn.textContent = "Maximize";
  maxBtn.addEventListener("click", () => {
    const modal = document.getElementById("modalBackdrop");
    const dialog = modal ? modal.querySelector(".modal") : null;
    if (!dialog) return;
    const isMax = dialog.classList.toggle("modal--maximized");
    maxBtn.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
    maxBtn.textContent = isMax ? "Restore" : "Maximize";
  });
  topBar.appendChild(maxBtn);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrapper";

  const TRIP_FILTER_EMPTY_PERM = "__TRIP_EMPTY_PERM__";
  const TRIP_FILTER_EMPTY_LOC = "__TRIP_EMPTY_LOC__";

  function distinctStringsWithEmpty(rawValues) {
    const nonEmpty = new Set();
    let hasEmpty = false;
    rawValues.forEach((raw) => {
      const t = String(raw ?? "").trim();
      if (!t) hasEmpty = true;
      else nonEmpty.add(t);
    });
    return {
      values: Array.from(nonEmpty).sort((a, b) => a.localeCompare(b, "en")),
      hasEmpty,
    };
  }

  function fillTripSelect(sel, allLabel, sortedVals, hasEmpty, emptyToken) {
    let html = `<option value="all">${allLabel}</option>`;
    if (hasEmpty) {
      html += `<option value="${emptyToken}">(Empty)</option>`;
    }
    sortedVals.forEach((v) => {
      html += `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
    });
    sel.innerHTML = html;
  }

  function selectHasValue(sel, val) {
    if (val === "all") return true;
    return [...sel.options].some((o) => o.value === val);
  }

  /** null = all ballot boxes included; Set = only these keys (subset filter). */
  let ballotMultiFilter = null;
  let prevBallotKeysSorted = [];
  /** Map voter key → trip label(s); set each render when mode === "route" (share/print/search). */
  let currentRouteTripLabelsByVoterKey = null;

  function tripVotersModalVoterKey(v) {
    return String(v.id || v.nationalId || "").trim();
  }

  function hydrateTripFieldSelects(assigned) {
    const perm = distinctStringsWithEmpty(assigned.map((v) => v.permanentAddress));
    const loc = distinctStringsWithEmpty(assigned.map((v) => v.currentLocation));

    const selP = body.querySelector("#zdTripVotersPermAddr");
    const selL = body.querySelector("#zdTripVotersCurrLoc");
    if (!selP || !selL) return;

    const prevP = selP.value;
    const prevL = selL.value;

    fillTripSelect(selP, "All addresses", perm.values, perm.hasEmpty, TRIP_FILTER_EMPTY_PERM);
    fillTripSelect(selL, "All locations", loc.values, loc.hasEmpty, TRIP_FILTER_EMPTY_LOC);

    selP.value = selectHasValue(selP, prevP) ? prevP : "all";
    selL.value = selectHasValue(selL, prevL) ? prevL : "all";
  }

  function updateBallotFilterSummary(keyCount) {
    const el = body.querySelector("#zdTripVotersBallotSummary");
    if (!el) return;
    if (keyCount === 0) {
      el.textContent = "No boxes";
      return;
    }
    if (ballotMultiFilter === null) {
      el.textContent = "All boxes";
      return;
    }
    el.textContent = `${ballotMultiFilter.size} of ${keyCount} selected`;
  }

  function hydrateBallotFilterCheckboxes(assigned) {
    const keys = [...new Set(assigned.map(voterBallotBoxLabel))].sort((a, b) =>
      a.localeCompare(b, "en")
    );
    const listEl = body.querySelector("#zdTripVotersBallotList");
    const allCb = body.querySelector("#zdTripVotersBallotAll");
    if (!listEl || !allCb) return;

    const newKeys = keys.filter((k) => !prevBallotKeysSorted.includes(k));
    prevBallotKeysSorted = keys.slice();
    if (ballotMultiFilter != null && newKeys.length) {
      newKeys.forEach((k) => ballotMultiFilter.add(k));
    }

    let html = "";
    keys.forEach((k) => {
      const checked =
        ballotMultiFilter === null ? true : ballotMultiFilter.has(k);
      html += `<label class="trip-filter-ballot-item"><input type="checkbox" data-ballot-filter="${escapeHtml(
        k
      )}"${checked ? " checked" : ""} /> <span>${escapeHtml(k)}</span></label>`;
    });
    listEl.innerHTML = html;

    const n = keys.length;
    if (ballotMultiFilter === null) {
      allCb.checked = true;
      allCb.indeterminate = false;
    } else {
      allCb.checked = ballotMultiFilter.size === n && n > 0;
      allCb.indeterminate = ballotMultiFilter.size > 0 && ballotMultiFilter.size < n;
    }
    updateBallotFilterSummary(n);
  }

  function applyTripFieldFilters(list, permVal, locVal) {
    return list.filter((v) => {
      if (permVal !== "all") {
        const p = String(v.permanentAddress || "").trim();
        if (permVal === TRIP_FILTER_EMPTY_PERM) {
          if (p) return false;
        } else if (p !== permVal) return false;
      }
      if (locVal !== "all") {
        const l = String(v.currentLocation || "").trim();
        if (locVal === TRIP_FILTER_EMPTY_LOC) {
          if (l) return false;
        } else if (l !== locVal) return false;
      }
      if (ballotMultiFilter != null) {
        if (ballotMultiFilter.size === 0) return false;
        if (!ballotMultiFilter.has(voterBallotBoxLabel(v))) return false;
      }
      return true;
    });
  }

  function applySearchFilter(list, query) {
    const q = (query || "").toLowerCase().trim();
    if (!q) return list;
    return list.filter((v) => {
      const name = (v.fullName || "").toLowerCase();
      const id = (v.id || "").toLowerCase();
      const nationalId = (v.nationalId || "").toLowerCase();
      const address = (v.permanentAddress || "").toLowerCase();
      const curLoc = (v.currentLocation || "").toLowerCase();
      const ballot = voterBallotBoxLabel(v).toLowerCase();
      const phone = (v.phone || "").toLowerCase();
      const tripBlob =
        currentRouteTripLabelsByVoterKey != null
          ? String(currentRouteTripLabelsByVoterKey.get(tripVotersModalVoterKey(v)) || "").toLowerCase()
          : "";
      return (
        name.includes(q) ||
        id.includes(q) ||
        nationalId.includes(q) ||
        address.includes(q) ||
        curLoc.includes(q) ||
        ballot.includes(q) ||
        phone.includes(q) ||
        tripBlob.includes(q)
      );
    });
  }

  function isVoterOnboardedForTrip(v) {
    const tLive = getLiveEntity();
    const set = new Set((tLive?.onboardedVoterIds || []).map(String));
    const id = String(v.id);
    const nid = String(v.nationalId || "").trim();
    return set.has(id) || (nid && set.has(nid));
  }

  function render() {
    const tLive = getLiveEntity();
    let assigned;
    let byIdsCount = 0;
    let byRouteCount = 0;
    if (mode === "route") {
      const r = collectAssignedVotersForTransportRoute(tLive);
      assigned = r.list;
      byIdsCount = r.byIdsCount;
      byRouteCount = r.byRouteCount;
      currentRouteTripLabelsByVoterKey = r.tripLabelsByVoterKey;
    } else {
      currentRouteTripLabelsByVoterKey = null;
      const r = collectAssignedVotersForTrip(tLive);
      assigned = r.list;
      byIdsCount = r.byIdsCount;
      byRouteCount = r.byRouteCount;
    }
    const obCount = Array.isArray(tLive?.onboardedVoterIds) ? tLive.onboardedVoterIds.length : 0;
    hydrateTripFieldSelects(assigned);
    hydrateBallotFilterCheckboxes(assigned);
    const filterPledge = (body.querySelector("#zdTripVotersFilter") || {}).value || "all";
    const sortBy = (body.querySelector("#zdTripVotersSort") || {}).value || "sequence";
    const groupBy = (body.querySelector("#zdTripVotersGroupBy") || {}).value || "none";
    const searchQuery = (body.querySelector("#zdTripVotersSearch") || {}).value || "";
    const permVal = (body.querySelector("#zdTripVotersPermAddr") || {}).value || "all";
    const locVal = (body.querySelector("#zdTripVotersCurrLoc") || {}).value || "all";
    let list = applySearchFilter(assigned, searchQuery);
    list = applyTripFieldFilters(list, permVal, locVal);
    if (mode === "route") {
      const nTrips = Array.isArray(tLive.tripIds) ? tLive.tripIds.length : 0;
      summary.textContent = `Showing ${list.length} of ${assigned.length} assigned (union across ${nTrips} trip(s)) · On-board: ${obCount}`;
    } else {
      summary.textContent = `Showing ${list.length} of ${assigned.length} assigned (Trip assignment: ${byIdsCount}, By route: ${byRouteCount}) · On-board: ${obCount}`;
    }
    const displayList = getModalListFilteredSortedGrouped(list, filterPledge, sortBy, groupBy);
    lastRenderedRows = displayList.filter((x) => x.type === "row").map((x) => x.voter);
    const newTable = buildTripPassengersTable(displayList, {
      includeVotedStatus: true,
      usePledgePills: true,
      isOnboarded: isVoterOnboardedForTrip,
      includeTripRemoveAction: true,
      tripPassengerMode: {
        tripId: entityId,
        getTrip: () => getLiveEntity(),
      },
      includeRouteTripColumn: mode === "route",
      getRoutePassengerTripLabels:
        mode === "route" && currentRouteTripLabelsByVoterKey
          ? (v) =>
              currentRouteTripLabelsByVoterKey.get(tripVotersModalVoterKey(v)) || "—"
          : undefined,
    });
    tableWrap.innerHTML = "";
    tableWrap.appendChild(newTable.firstElementChild);
  }

  function getTripPassengerRemarkForExport(v) {
    const tLive = getLiveEntity();
    const vid = String(v.id);
    const m = tLive?.passengerRemarksByVoterId && typeof tLive.passengerRemarksByVoterId === "object"
      ? tLive.passengerRemarksByVoterId
      : {};
    return String(m[vid] || "").trim();
  }

  function getTripPreferredPickupForExport(v) {
    const tLive = getLiveEntity();
    const vid = String(v.id);
    const m =
      tLive?.passengerPreferredPickupByVoterId &&
      typeof tLive.passengerPreferredPickupByVoterId === "object"
        ? tLive.passengerPreferredPickupByVoterId
        : {};
    const iso = m[vid] || "";
    if (!iso) return defaultPreferredPickupDisplayLocale();
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-MV", { dateStyle: "short", timeStyle: "short" });
  }

  function shareTripVotersReport() {
    if (!lastRenderedRows.length) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Nothing to share",
          meta: "No voters match the current filters.",
        });
      }
      return;
    }
    const routeLabel =
      mode === "route" ? formatTransportRouteTripsCell(getLiveEntity()) : String(tripOrRoute.route || "Route");
    const header = [
      "Seq",
      "Name",
      ...(mode === "route" ? ["Trip"] : []),
      "ID Number",
      "Phone",
      "Permanent address",
      "Ballot box",
      "Pledge",
      "Agent",
      "Voted status",
      "Preferred pickup",
      "Confirm reached",
      "Route remarks",
    ];
    const lines = [header.join("\t")];
    lastRenderedRows.forEach((v) => {
      const voted = getVotedTimeMarked(v.id) ? "Voted" : "Not voted";
      const reached = isVoterOnboardedForTrip(v) ? "Yes" : "No";
      const tripCol =
        mode === "route" && currentRouteTripLabelsByVoterKey
          ? currentRouteTripLabelsByVoterKey.get(tripVotersModalVoterKey(v)) || "—"
          : null;
      const cells = [
        sequenceAsImportedFromCsv(v),
        v.fullName || "",
        ...(tripCol != null ? [tripCol] : []),
        v.nationalId || v.id || "",
        v.phone || "",
        v.permanentAddress || "",
        v.ballotBox || v.island || "",
        getPledgeLabel(v.pledgeStatus),
        getAgentForVoter(v.id),
        voted,
        getTripPreferredPickupForExport(v),
        reached,
        getTripPassengerRemarkForExport(v),
      ];
      lines.push(cells.join("\t"));
    });
    const reportTitle =
      mode === "route" ? `Route passengers — ${routeLabel}` : `Assigned voters — ${routeLabel}`;
    const text = `${reportTitle} (${lastRenderedRows.length} voters)\n\n${lines.join("\n")}`;
    if (navigator.share) {
      navigator
        .share({ title: reportTitle, text })
        .then(() => {})
        .catch((err) => {
          if (err && err.name === "AbortError") return;
          navigator.clipboard.writeText(text).then(
            () => {
              if (typeof window.showToast === "function") window.showToast("Report copied to clipboard");
            },
            () => {
              if (window.appNotifications) {
                window.appNotifications.push({
                  title: "Share failed",
                  meta: "Could not copy to clipboard. Try Print.",
                });
              }
            }
          );
        });
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        if (typeof window.showToast === "function") window.showToast("Report copied to clipboard");
        else if (window.appNotifications) {
          window.appNotifications.push({
            title: "Copied",
            meta: "Report text copied to the clipboard — paste into email or chat.",
          });
        }
      },
      () => {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Share failed",
            meta: "Could not copy to clipboard. Try Print.",
          });
        }
      }
    );
  }

  function printTripVotersReport() {
    if (!lastRenderedRows.length) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Nothing to print",
          meta: "No voters match the current filters.",
        });
      }
      return;
    }
    const rows = [...lastRenderedRows].sort(compareVotersByBallotSequenceThenName);
    const rowsHtml = rows
      .map((v) => {
        const voted = getVotedTimeMarked(v.id) ? "Voted" : "Not voted";
        const reached = isVoterOnboardedForTrip(v) ? "Yes" : "No";
        const tripTd =
          mode === "route" && currentRouteTripLabelsByVoterKey
            ? `<td>${escapeHtml(
                currentRouteTripLabelsByVoterKey.get(tripVotersModalVoterKey(v)) || "—"
              )}</td>`
            : "";
        return `
          <tr>
            <td>${escapeHtml(sequenceAsImportedFromCsv(v))}</td>
            <td>${escapeHtml(v.fullName || "")}</td>
            ${tripTd}
            <td>${escapeHtml(v.nationalId || v.id || "")}</td>
            <td>${escapeHtml(v.phone || "")}</td>
            <td>${escapeHtml(v.permanentAddress || "")}</td>
            <td>${escapeHtml(v.ballotBox || v.island || "")}</td>
            <td>${escapeHtml(getPledgeLabel(v.pledgeStatus))}</td>
            <td>${escapeHtml(getAgentForVoter(v.id))}</td>
            <td>${escapeHtml(voted)}</td>
            <td>${escapeHtml(getTripPreferredPickupForExport(v))}</td>
            <td>${escapeHtml(reached)}</td>
            <td>${escapeHtml(getTripPassengerRemarkForExport(v))}</td>
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
          .page { max-width: 1280px; margin: 20px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.06); overflow: hidden; }
          .report-head { padding: 16px 18px; border-bottom: 1px solid #e5e7eb; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
          .report-title { margin: 0; font-size: 20px; line-height: 1.2; }
          .report-meta { margin: 4px 0 0; color: #4b5563; font-size: 13px; }
          .report-actions { display: flex; gap: 8px; }
          .btn { border: 1px solid #d1d5db; background: #fff; color: #111; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
          .btn--primary { border-color: #2563eb; background: #2563eb; color: #fff; }
          .table-wrap { padding: 10px; overflow: auto; }
          table { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; min-width: ${
            mode === "route" ? "1320px" : "1180px"
          }; }
          th, td {
            border: 1px solid #e5e7eb;
            padding: 4px 5px;
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
          @media print {
            @page { size: A4 landscape; margin: 9mm; }
            body { background: #fff; }
            .page { margin: 0; border: none; box-shadow: none; border-radius: 0; max-width: none; }
            .report-actions { display: none !important; }
            .table-wrap { padding: 0; overflow: visible; }
            table { min-width: 0; width: 100%; font-size: 8.5px; table-layout: fixed; }
            th, td { padding: 2px 3px; line-height: 1.12; }
            th { position: static; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <header class="report-head">
            <div>
              <h1 class="report-title">Assigned voters report</h1>
              <p class="report-meta">Route: ${escapeHtml(
                mode === "route" ? formatTransportRouteTripsCell(getLiveEntity()) : tripOrRoute.route || "Route"
              )} | Total: ${rows.length} | Generated: ${escapeHtml(new Date().toLocaleString("en-MV"))}</p>
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
                  <th>Seq</th>
                  <th>Name</th>
                  ${mode === "route" ? "<th>Trip</th>" : ""}
                  <th>ID Number</th>
                  <th>Phone</th>
                  <th>Permanent Address</th>
                  <th>Ballot box</th>
                  <th>Pledge</th>
                  <th>Agent</th>
                  <th>Voted status</th>
                  <th>Preferred pickup</th>
                  <th>Confirm reached</th>
                  <th>Route remarks</th>
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

  body.appendChild(topBar);
  body.appendChild(summary);
  body.appendChild(listToolbar);
  body.appendChild(tableWrap);

  tableWrap.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("input[type=checkbox][data-trip-reached-toggle]")) {
      const voterId = t.getAttribute("data-trip-reached-toggle");
      if (voterId == null || voterId === "") return;
      const p =
        mode === "route"
          ? toggleRouteVoterOnboarded(entityId, voterId)
          : toggleTripVoterOnboarded(entityId, voterId);
      p.then(() => render());
      return;
    }
  });

  tableWrap.addEventListener(
    "blur",
    (e) => {
      const t = e.target;
      if (t.matches("[data-trip-voter-phone]")) {
        const vid = t.getAttribute("data-trip-voter-phone");
        if (vid != null && vid !== "" && updateVoterPhoneFromHost) {
          updateVoterPhoneFromHost(vid, t.value);
        }
        return;
      }
      if (t.matches("[data-trip-preferred-pickup]")) {
        const vid = t.getAttribute("data-trip-preferred-pickup");
        if (vid != null && vid !== "") {
          if (mode === "route") persistRoutePassengerPreferredPickup(entityId, vid, t.value);
          else persistTripPassengerPreferredPickup(entityId, vid, t.value);
        }
        return;
      }
      if (t.matches("[data-trip-passenger-remarks]")) {
        const vid = t.getAttribute("data-trip-passenger-remarks");
        if (vid != null && vid !== "") {
          if (mode === "route") persistRoutePassengerRemarks(entityId, vid, t.value);
          else persistTripPassengerRemarks(entityId, vid, t.value);
        }
      }
    },
    true
  );

  tableWrap.addEventListener("click", (e) => {
    const removeBtn = e.target.closest("[data-trip-remove-voter]");
    if (removeBtn) {
      const voterId = removeBtn.getAttribute("data-trip-remove-voter");
      if (voterId == null || voterId === "") return;
      e.preventDefault();
      const p =
        mode === "route"
          ? removeAssignedVoterFromTransportRoute(entityId, voterId)
          : removeAssignedVoterFromTrip(entityId, voterId);
      p.then(() => render());
    }
  });

  listToolbar.querySelector("#zdTripVotersFilter").addEventListener("change", render);
  listToolbar.querySelector("#zdTripVotersSort").addEventListener("change", render);
  listToolbar.querySelector("#zdTripVotersGroupBy").addEventListener("change", render);
  listToolbar.addEventListener("change", (e) => {
    const id = e.target && e.target.id;
    if (id === "zdTripVotersPermAddr" || id === "zdTripVotersCurrLoc") {
      render();
    }
  });

  listToolbar.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.id === "zdTripVotersBallotAll") {
      const boxes = [...body.querySelectorAll("[data-ballot-filter]")];
      if (t.checked) {
        boxes.forEach((c) => {
          c.checked = true;
        });
        ballotMultiFilter = null;
      } else {
        boxes.forEach((c) => {
          c.checked = false;
        });
        ballotMultiFilter = new Set();
      }
      render();
      return;
    }
    if (t && t.matches && t.matches("[data-ballot-filter]")) {
      const boxes = [...body.querySelectorAll("[data-ballot-filter]")];
      const allCb = body.querySelector("#zdTripVotersBallotAll");
      const checked = boxes.filter((c) => c.checked).map((c) => c.getAttribute("data-ballot-filter"));
      const n = boxes.length;
      if (n === 0) {
        ballotMultiFilter = null;
      } else if (checked.length === n) {
        ballotMultiFilter = null;
        if (allCb) {
          allCb.checked = true;
          allCb.indeterminate = false;
        }
      } else {
        ballotMultiFilter = new Set(checked);
        if (allCb) {
          allCb.checked = false;
          allCb.indeterminate = checked.length > 0;
        }
      }
      render();
    }
  });

  const ballotToggle = body.querySelector("#zdTripVotersBallotToggle");
  const ballotPanel = body.querySelector("#zdTripVotersBallotPanel");
  const ballotDropdown = body.querySelector("#zdTripVotersBallotDropdown");
  function closeBallotFilterPanel() {
    if (ballotPanel) ballotPanel.hidden = true;
    if (ballotToggle) ballotToggle.setAttribute("aria-expanded", "false");
  }
  if (ballotToggle && ballotPanel) {
    ballotToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = ballotPanel.hidden;
      ballotPanel.hidden = !open;
      ballotToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  function onDocMouseDownBallotFilter(e) {
    if (!ballotDropdown || ballotPanel.hidden) return;
    if (ballotDropdown.contains(e.target)) return;
    closeBallotFilterPanel();
  }
  document.addEventListener("mousedown", onDocMouseDownBallotFilter);

  const searchEl = listToolbar.querySelector("#zdTripVotersSearch");
  if (searchEl) searchEl.addEventListener("input", render);

  render();
  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.flexWrap = "wrap";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "ghost-button";
  shareBtn.textContent = "Share";
  shareBtn.addEventListener("click", shareTripVotersReport);

  const printBtn = document.createElement("button");
  printBtn.type = "button";
  printBtn.className = "ghost-button";
  printBtn.textContent = "Print";
  printBtn.addEventListener("click", printTripVotersReport);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost-button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closeModal());

  footer.appendChild(shareBtn);
  footer.appendChild(printBtn);
  footer.appendChild(closeBtn);

  openModal({
    title,
    body,
    footer,
    startMaximized: true,
    dialogClass: "modal--wide",
    closeOnBackdropClick: false,
    closeOnEscape: false,
  });
  maxBtn.setAttribute("aria-label", "Restore");
  maxBtn.textContent = "Restore";

  const onVotersUpdated = () => render();
  document.addEventListener("voters-updated", onVotersUpdated);
  const backdrop = document.getElementById("modalBackdrop");
  const obs =
    backdrop &&
    new MutationObserver(() => {
      if (backdrop.hidden) {
        document.removeEventListener("voters-updated", onVotersUpdated);
        document.removeEventListener("mousedown", onDocMouseDownBallotFilter);
        obs.disconnect();
      }
    });
  if (backdrop && obs) obs.observe(backdrop, { attributes: true, attributeFilter: ["hidden"] });
}

function getUniqueBallotBoxes() {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const set = new Set();
  voters.forEach((v) => {
    const box = (v.ballotBox || "").trim();
    if (box) set.add(box);
  });
  return Array.from(set).sort();
}

/** Resolve share URL and short access code for a monitor (same as copy payload). */
function getMonitorShareUrls(monitor) {
  const path = window.location.pathname || "/";
  const dir = path.endsWith("/") ? path : path.replace(/[^/]+$/, "") || "/";
  const ballotBoxUrl = window.location.origin + dir + "ballot-box.html";
  const monitorUrl = `${ballotBoxUrl}?monitor=${encodeURIComponent(monitor.shareToken)}`;
  const accessCode = (monitor.shareToken || "").split("-")[1] || monitor.shareToken;
  return { monitorUrl, accessCode, ballotBoxUrl };
}

/** SVG icons for monitor share UI (copy code vs copy list URL). */
function monitorShareIconCopy() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}
function monitorShareIconLink() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 1 0-7l.7-.7a5 5 0 0 1 7 7l-.2.2"/><path d="M14 11a5 5 0 0 1 0 7l-.7.7a5 5 0 0 1-7-7l.2-.2"/></svg>`;
}

function copyMonitorAccessCodeOnly(monitorId) {
  const monitor = zeroDayMonitors.find((m) => m.id === monitorId);
  if (!monitor) return;
  const { accessCode } = getMonitorShareUrls(monitor);
  navigator.clipboard.writeText(accessCode).then(() => {
    if (typeof window.showToast === "function") window.showToast("Code copied to clipboard");
    else alert("Code copied to clipboard.");
  }).catch(() => alert("Could not copy code: " + accessCode));
}

function copyMonitorListUrlOnly(monitorId) {
  const monitor = zeroDayMonitors.find((m) => m.id === monitorId);
  if (!monitor) return;
  const { monitorUrl: url } = getMonitorShareUrls(monitor);
  navigator.clipboard.writeText(url).then(() => {
    if (typeof window.showToast === "function") window.showToast("List link copied to clipboard");
    else alert("List link copied to clipboard.");
  }).catch(() => alert("Could not copy link: " + url));
}

/** Copy full URL + code (legacy / bulk share). */
function copyMonitorLink(monitorId) {
  const monitor = zeroDayMonitors.find((m) => m.id === monitorId);
  if (!monitor) return;
  const { monitorUrl: url, accessCode } = getMonitorShareUrls(monitor);
  const payload = `${url}\nCode: ${accessCode}`;
  navigator.clipboard.writeText(payload).then(() => {
    if (typeof window.showToast === "function") window.showToast("Link and code copied to clipboard");
    else alert("Link and code copied to clipboard.");
  }).catch(() => alert("Could not copy. Link: " + url + " (Code: " + accessCode + ")"));
}

function tearDownMonitorBallotSessionListeners() {
  monitorBallotSessionUnsubs.forEach((u) => {
    try {
      u();
    } catch (_) {}
  });
  monitorBallotSessionUnsubs = [];
}

function applyMonitorSessionCell(monitorId, state) {
  const table = document.getElementById("zeroDayMonitorsTable");
  const cell = table?.querySelector(`tbody [data-monitor-session-cell="${String(monitorId)}"]`);
  if (!cell) return;
  const st =
    state && (state.status === "paused" || state.status === "closed") ? state.status : "open";
  const label = st === "open" ? "Open" : st === "paused" ? "Paused" : "Closed";
  cell.textContent = label;
  cell.className = "monitor-session-cell monitor-session-cell--" + st;
  const reason = state && String(state.pauseReason || "").trim();
  if (st === "paused" && reason) cell.setAttribute("title", "Reason: " + reason);
  else cell.removeAttribute("title");
}

async function adminSetVoteMarkingSessionForMonitor(monitor, wantOpen) {
  if (!monitor?.shareToken) return false;
  try {
    const api = await firebaseInitPromise;
    if (!api.setBallotSessionFs) return false;
    await api.setBallotSessionFs(monitor.shareToken, {
      status: wantOpen ? "open" : "closed",
      pauseReason: "",
      pausedAt: "",
    });
    return true;
  } catch (_) {
    return false;
  }
}

function wireMonitorBallotSessionCells() {
  tearDownMonitorBallotSessionListeners();
  const table = document.getElementById("zeroDayMonitorsTable");
  zeroDayMonitors.forEach((m) => {
    const cell = table?.querySelector(`tbody [data-monitor-session-cell="${String(m.id)}"]`);
    if (!cell) return;
    if (!m.shareToken) {
      cell.textContent = "—";
      cell.className = "monitor-session-cell monitor-session-cell--na";
      cell.removeAttribute("title");
      return;
    }
    cell.textContent = "…";
    cell.className = "monitor-session-cell monitor-session-cell--loading";
    cell.removeAttribute("title");
  });
  firebaseInitPromise
    .then((api) => {
      if (!api.getBallotSessionFs || !api.onBallotSessionSnapshotFs) return;
      zeroDayMonitors.forEach((m) => {
        const token = m.shareToken;
        if (!token) return;
        api
          .getBallotSessionFs(token)
          .then((s) => applyMonitorSessionCell(m.id, s))
          .catch(() => applyMonitorSessionCell(m.id, { status: "open" }));
        const unsub = api.onBallotSessionSnapshotFs(token, (s) => applyMonitorSessionCell(m.id, s));
        monitorBallotSessionUnsubs.push(unsub);
      });
    })
    .catch(() => {});
}

function closeAllMonitorRowMenus(panel) {
  if (monitorRowMenuDocClose) {
    document.removeEventListener("click", monitorRowMenuDocClose);
    monitorRowMenuDocClose = null;
  }
  const root = panel || document;
  root.querySelectorAll("[data-monitor-row-dropdown]").forEach((menu) => {
    menu.hidden = true;
  });
  root.querySelectorAll("[data-monitor-menu-trigger]").forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
  });
}

function openMonitorRowMenu(panel, wrap, menu, trigger) {
  closeAllMonitorRowMenus(panel);
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  monitorRowMenuDocClose = (ev) => {
    if (wrap.contains(ev.target)) return;
    closeAllMonitorRowMenus(panel);
  };
  requestAnimationFrame(() => document.addEventListener("click", monitorRowMenuDocClose));
}

function renderMonitorsTable() {
  if (!zeroDayMonitorsTableBody) return;
  const emptyColspan = 8;
  tearDownMonitorBallotSessionListeners();
  zeroDayMonitorsTableBody.innerHTML = "";
  if (!zeroDayMonitors.length) {
    zeroDayMonitorsTableBody.innerHTML = `
      <tr>
        <td colspan="${emptyColspan}" class="text-muted" style="text-align: center; padding: 24px;">No monitors yet. Add a monitor and assign voters from their ballot box.</td>
      </tr>
    `;
    return;
  }
  zeroDayMonitors.forEach((m) => {
    const voterCount = (m.voterIds || []).length;
    const { accessCode } = getMonitorShareUrls(m);
    const mid = String(m.id);
    const tr = document.createElement("tr");
    tr.dataset.monitorId = mid;
    tr.innerHTML = `
      <td>${escapeHtml(m.ballotBox || "—")}</td>
      <td class="data-table-col--name">${escapeHtml(m.name || "—")}</td>
      <td>${escapeHtml(m.mobile || "—")}</td>
      <td>${voterCount}</td>
      <td>
        <div class="monitor-share-cell">
          <code class="monitor-link-preview">${escapeHtml(accessCode)}</code>
          <span class="monitor-share-cell__icons" role="group" aria-label="Copy code or list link">
            <button type="button" class="vote-box-card__copy-btn monitor-share-cell__icon-btn" data-copy-monitor-code="${mid}" title="Copy code" aria-label="Copy code">${monitorShareIconCopy()}</button>
            <button type="button" class="vote-box-card__copy-btn monitor-share-cell__icon-btn" data-copy-monitor-link="${mid}" title="Copy list link" aria-label="Copy list link">${monitorShareIconLink()}</button>
          </span>
        </div>
      </td>
      <td class="monitor-session-col"><span class="monitor-session-cell monitor-session-cell--loading" data-monitor-session-cell="${mid}">…</span></td>
      <td class="monitor-admin-session-col">
        <div class="monitor-admin-session-btns" role="group" aria-label="Vote marking session for this ballot box">
          <button type="button" class="monitor-admin-session-btn monitor-admin-session-btn--open" data-admin-ballot-open="${mid}" title="Open vote marking" aria-label="Open vote marking"${
            m.shareToken ? "" : " disabled"
          }>${ADMIN_BALLOT_SESSION_OPEN_SVG}</button>
          <button type="button" class="monitor-admin-session-btn monitor-admin-session-btn--close" data-admin-ballot-close="${mid}" title="Close vote marking" aria-label="Close vote marking"${
            m.shareToken ? "" : " disabled"
          }>${ADMIN_BALLOT_SESSION_CLOSE_SVG}</button>
        </div>
      </td>
      <td class="zero-day-monitors-actions-col">
        <div class="dropdown-wrap zero-day-monitor-row-menu">
          <button type="button" class="icon-button zero-day-monitor-menu-trigger" data-monitor-menu-trigger aria-label="Monitor actions" aria-haspopup="true" aria-expanded="false" title="Actions">⋮</button>
          <div class="dropdown-menu zero-day-monitor-row-dropdown" data-monitor-row-dropdown hidden role="menu" aria-label="Monitor actions">
            <button type="button" class="dropdown-menu__item" role="menuitem" data-view-monitor="${mid}">View</button>
            <button type="button" class="dropdown-menu__item" role="menuitem" data-assign-voters="${mid}">Assign voters</button>
            <button type="button" class="dropdown-menu__item" role="menuitem" data-edit-monitor="${mid}">Edit</button>
            <button type="button" class="dropdown-menu__item" role="menuitem" data-delete-monitor="${mid}">Delete</button>
          </div>
        </div>
      </td>
    `;
    zeroDayMonitorsTableBody.appendChild(tr);
  });
  wireMonitorBallotSessionCells();
}

/** Read-only details (R in CRUD), aligned with Settings → Agents. */
function openMonitorViewModal(monitor) {
  if (!monitor) return;
  const voterCount = (monitor.voterIds || []).length;
  const { monitorUrl, accessCode } = getMonitorShareUrls(monitor);

  const body = document.createElement("div");
  body.className = "form-grid";
  body.innerHTML = `
    <div class="form-group">
      <div class="detail-item-label">Ballot box</div>
      <div class="detail-item-value">${escapeHtml(monitor.ballotBox || "—")}</div>
    </div>
    <div class="form-group">
      <div class="detail-item-label">Monitor name</div>
      <div class="detail-item-value">${escapeHtml(monitor.name || "—")}</div>
    </div>
    <div class="form-group">
      <div class="detail-item-label">Mobile</div>
      <div class="detail-item-value">${escapeHtml(monitor.mobile || "—")}</div>
    </div>
    <div class="form-group">
      <div class="detail-item-label">Assigned voters</div>
      <div class="detail-item-value">${voterCount}</div>
    </div>
    <div class="form-group" style="grid-column: 1 / -1;">
      <label class="detail-item-label">Code</label>
      <div class="monitor-modal-share-row">
        <code class="monitor-modal-share-row__code">${escapeHtml(accessCode)}</code>
        <button type="button" class="vote-box-card__copy-btn" id="monitorModalCopyCode" title="Copy code" aria-label="Copy code">${monitorShareIconCopy()}</button>
      </div>
    </div>
    <div class="form-group" style="grid-column: 1 / -1;">
      <label for="monitorViewUrlField" class="detail-item-label">List link</label>
      <div class="monitor-modal-share-row">
        <input type="text" id="monitorViewUrlField" class="input monitor-modal-share-row__input" readonly value="${escapeHtml(monitorUrl)}">
        <button type="button" class="vote-box-card__copy-btn" id="monitorModalCopyLink" title="Copy list link" aria-label="Copy list link">${monitorShareIconLink()}</button>
      </div>
    </div>
  `;

  body.querySelector("#monitorModalCopyCode")?.addEventListener("click", () => copyMonitorAccessCodeOnly(monitor.id));
  body.querySelector("#monitorModalCopyLink")?.addEventListener("click", () => copyMonitorListUrlOnly(monitor.id));

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

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "primary-button";
  editBtn.textContent = "Update monitor";
  editBtn.addEventListener("click", () => {
    closeModal();
    openAddMonitorForm(monitor);
  });

  footer.appendChild(closeBtn);
  footer.appendChild(editBtn);

  openModal({ title: "View monitor", body, footer });
}

function openAddMonitorForm(existing) {
  const isEdit = !!existing;
  const ballotBoxes = getUniqueBallotBoxes();
  const body = document.createElement("div");
  body.className = "form-grid";
  body.innerHTML = `
    <div class="form-group">
      <label for="monitorName">Monitor name <span class="text-muted">(required)</span></label>
      <input id="monitorName" class="input" type="text" value="${escapeHtml(existing?.name || "")}" placeholder="e.g. Ahmed Hassan">
    </div>
    <div class="form-group">
      <label for="monitorMobile">Mobile</label>
      <input id="monitorMobile" class="input" type="text" value="${escapeHtml(existing?.mobile || "")}" placeholder="e.g. 960 123 4567">
    </div>
    <div class="form-group">
      <label for="monitorBallotBox">Ballot box <span class="text-muted">(required)</span></label>
      <select id="monitorBallotBox" class="input agent-dropdown-select agent-dropdown-select--modal">
        <option value="">Select ballot box…</option>
        ${ballotBoxes.map((b) => `<option value="${escapeHtml(b)}"${(existing?.ballotBox || "") === b ? " selected" : ""}>${escapeHtml(b)}</option>`).join("")}
      </select>
    </div>
    ${
      !isEdit
        ? `<p class="helper-text" style="grid-column: 1 / -1;">After adding, use <strong>Assign</strong> to add all voters from this ballot box to the monitor’s list. Then use the <strong>Code</strong> and <strong>list link</strong> copy buttons to share.</p>`
        : ""
    }
    ${
      ballotBoxes.length === 0
        ? `<p class="helper-text" style="grid-column: 1 / -1;">No ballot boxes found yet. Add voters with a ballot box in <strong>Voters</strong> first, then return here.</p>`
        : ""
    }
  `;

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
  saveBtn.textContent = isEdit ? "Update monitor" : "Create monitor";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  function trySave() {
    const name = body.querySelector("#monitorName").value.trim();
    const mobile = body.querySelector("#monitorMobile").value.trim();
    const ballotBox = body.querySelector("#monitorBallotBox").value.trim();
    if (!name) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Missing fields",
          meta: "Monitor name is required.",
        });
      }
      return;
    }
    if (!ballotBox) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Missing fields",
          meta: "Select a ballot box.",
        });
      }
      return;
    }

    if (isEdit) {
      existing.name = name;
      existing.mobile = mobile;
      existing.ballotBox = ballotBox;
      existing.sequenceOffset = 0;
      saveMonitors();
      syncMonitorToFirestore(existing);
    } else {
      const nextId = zeroDayMonitors.reduce((max, m) => Math.max(max, m.id), 0) + 1;
      const newMonitor = {
        id: nextId,
        name,
        mobile,
        ballotBox,
        voterIds: [],
        shareToken: generateShareToken(),
        createdAt: new Date().toISOString(),
        sequenceOffset: 0,
      };
      zeroDayMonitors.push(newMonitor);
      saveMonitors();
      syncMonitorToFirestore(newMonitor);
    }
    renderMonitorsTable();
    subscribeVotedRealtime();
    closeModal();
  }

  saveBtn.addEventListener("click", trySave);

  openModal({
    title: isEdit ? "Update monitor" : "Create monitor",
    body,
    footer,
  });
}

async function syncMonitorToFirestore(monitor) {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.setMonitorDoc) return;
    const config = await (api.getFirestoreCampaignConfig && api.getFirestoreCampaignConfig()).catch(() => null);
    const monitoringEnabled = config && config.voteMonitoringEnabled === true;
    const voterIds = monitor.voterIds || [];
    const allVoters = votersContext ? votersContext.getAllVoters() : [];
    const pledgeRows = pledgeContextRef && typeof pledgeContextRef.getPledges === "function" ? pledgeContextRef.getPledges() : [];
    const volunteerByVoterId = new Map(pledgeRows.map((r) => [r.voterId, r.volunteer || ""]));
    const voters = voterIds
      .map((id) => allVoters.find((v) => v.id === id))
      .filter(Boolean)
      .map((v) => ({
        id: v.id,
        fullName: v.fullName || "",
        nationalId: v.nationalId || v.id || "",
        permanentAddress: v.permanentAddress || "",
        phone: v.phone || "",
        pledgeStatus: v.pledgeStatus || "undecided",
        volunteer: volunteerByVoterId.get(v.id) || "",
        sequence: v.sequence != null ? v.sequence : "",
      }));
    await api.setMonitorDoc(monitor.shareToken, {
      ballotBox: monitor.ballotBox || "",
      name: monitor.name || "",
      mobile: monitor.mobile || "",
      voterIds,
      voters,
      sequenceOffset: 0,
      monitoringEnabled,
      createdAt: monitor.createdAt || new Date().toISOString(),
    });
  } catch (_) {}
}

function assignVotersFromBallotBox(monitorId) {
  const monitor = zeroDayMonitors.find((m) => m.id === monitorId);
  if (!monitor || !votersContext) return;
  const voters = votersContext.getAllVoters();
  const ids = voters.filter((v) => (v.ballotBox || "").trim() === monitor.ballotBox).map((v) => v.id);
  monitor.voterIds = [...new Set(ids)];
  saveMonitors();
  syncMonitorToFirestore(monitor);
  renderMonitorsTable();
}

function deleteMonitorLink(monitorId) {
  const monitor = zeroDayMonitors.find((m) => m.id === monitorId);
  if (!monitor) return;
  const label = monitor.ballotBox || monitor.name || "this monitor";
  (async () => {
    const ok = await confirmDialog({
      title: "Delete monitor link",
      message: `Delete the access link for "${escapeHtml(
        label
      )}"? The monitor will be removed and the link will stop working.`,
      confirmText: "Delete link",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;
    const token = monitor.shareToken;
    const idx = zeroDayMonitors.findIndex((m) => m.id === monitorId);
    if (idx !== -1) zeroDayMonitors.splice(idx, 1);
    saveMonitors();
    firebaseInitPromise
      .then((api) => api.deleteMonitorDoc && api.deleteMonitorDoc(token))
      .catch(() => {});
    renderMonitorsTable();
    subscribeVotedRealtime();
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Monitor access link deleted",
        meta: String(label),
      });
    }
  })();
}

function getVoteBoxSummaries() {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const filter = zeroDayVoteFilter?.value || "all";
  const query = (zeroDayVoteSearch?.value || "").toLowerCase().trim();
  // Treat a voter as voted if they are in zeroDayVotedEntries OR have votedAt on their voter record
  const votedSet = new Set(zeroDayVotedEntries.map((e) => String(e.voterId)));

  const boxes = new Map();
  voters.forEach((v) => {
    const key = (v.ballotBox || v.island || "Unassigned").trim();
    if (!boxes.has(key)) {
      boxes.set(key, { box: key, total: 0, voted: 0, island: v.island || "" });
    }
    const entry = boxes.get(key);
    entry.total += 1;
    if (votedSet.has(String(v.id)) || (v.votedAt && String(v.votedAt).trim() !== "")) {
      entry.voted += 1;
    }
  });

  let list = Array.from(boxes.values());

  if (filter === "voted") list = list.filter((b) => b.voted === b.total && b.total > 0);
  if (filter === "not-voted") list = list.filter((b) => b.voted === 0 && b.total > 0);

  if (query) {
    list = list.filter(
      (b) =>
        b.box.toLowerCase().includes(query) ||
        (b.island || "").toLowerCase().includes(query)
    );
  }

  return list;
}

/** Returns { voted: voters[], notYet: voters[] } for the given ballot box key. voted entries include timeMarked. */
function getVotersByBoxSplitByVoted(boxKey) {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const key = (boxKey || "").trim();
  const boxVoters = voters.filter(
    (v) => (v.ballotBox || v.island || "Unassigned").trim() === key
  );
  const votedSet = new Map(
    zeroDayVotedEntries.map((e) => [String(e.voterId), e.timeMarked || ""])
  );
  const voted = [];
  const notYet = [];
  boxVoters.forEach((v) => {
    const fromEntries = votedSet.get(String(v.id)) || "";
    const fromVoter = v.votedAt || "";
    // Prefer synced Zero Day / monitor list over voter.votedAt so undo from the ballot link drops off the list immediately.
    const timeMarked = fromEntries || fromVoter;
    if (timeMarked != null && String(timeMarked).trim() !== "") {
      voted.push({ ...v, _timeMarked: timeMarked });
    } else {
      notYet.push(v);
    }
  });
  voted.sort(compareVotersByBallotSequenceThenName);
  notYet.sort(compareVotersByBallotSequenceThenName);
  return { voted, notYet };
}

function getPledgeLabel(status) {
  const s = (status || "").toLowerCase();
  if (s === "yes") return "Yes";
  if (s === "no") return "No";
  return "Undecided";
}

function getAgentForVoter(voterId) {
  if (!pledgeContextRef || typeof pledgeContextRef.getPledges !== "function")
    return "";
  const rows = pledgeContextRef.getPledges();
  const row = rows.find((r) => sameVoterId(r.voterId, voterId));
  return (row && row.volunteer) != null ? String(row.volunteer) : "";
}

/** Ballot box display/sort/filter key (Transportation routes + shared modals). */
function voterBallotBoxLabel(v) {
  if (!v) return "Unassigned";
  return String(v.ballotBox || v.island || "Unassigned").trim();
}

/** Returns displayList: array of { type: "row", voter } or { type: "group", label }. */
function getModalListFilteredSortedGrouped(voters, filterPledge, sortBy, groupBy) {
  let list = voters.filter((v) => {
    if (filterPledge !== "all") {
      const s = (v.pledgeStatus || "undecided").toLowerCase();
      if (filterPledge === "yes" && s !== "yes") return false;
      if (filterPledge === "no" && s !== "no") return false;
      if (filterPledge === "undecided" && s !== "undecided") return false;
    }
    return true;
  });

  const cmp = (a, b) => {
    switch (sortBy) {
      case "sequence":
        return compareVotersByBallotSequenceThenName(a, b);
      case "name-desc":
        return (b.fullName || "").localeCompare(a.fullName || "", "en");
      case "name-asc":
        return (a.fullName || "").localeCompare(b.fullName || "", "en");
      case "id":
        return (a.nationalId || a.id || "").localeCompare(b.nationalId || b.id || "", "en");
      case "address":
        return (a.permanentAddress || "").localeCompare(b.permanentAddress || "", "en");
      case "pledge":
        return (a.pledgeStatus || "").localeCompare(b.pledgeStatus || "", "en");
      case "agent": {
        const ag = getAgentForVoter(a.id);
        const bg = getAgentForVoter(b.id);
        return ag.localeCompare(bg, "en");
      }
      case "ballot":
        return voterBallotBoxLabel(a).localeCompare(voterBallotBoxLabel(b), "en");
      case "time":
        return (a._timeMarked || "").localeCompare(b._timeMarked || "", "en");
      default:
        return compareVotersByBallotSequenceThenName(a, b);
    }
  };
  list = list.slice().sort(cmp);

  if (groupBy === "none") {
    return list.map((v) => ({ type: "row", voter: v }));
  }

  const getGroupKey = (v) => {
    if (groupBy === "pledge") return v.pledgeStatus || "undecided";
    if (groupBy === "agent") return getAgentForVoter(v.id) || "(No agent)";
    if (groupBy === "ballot") return voterBallotBoxLabel(v);
    return "";
  };
  const displayList = [];
  let lastKey = null;
  list.forEach((v) => {
    const key = getGroupKey(v);
    const label = groupBy === "pledge" ? getPledgeLabel(key) : String(key);
    if (key !== lastKey) {
      displayList.push({ type: "group", label });
      lastKey = key;
    }
    displayList.push({ type: "row", voter: v });
  });
  return displayList;
}

/** Trip route modal: editable mobile, preferred pickup, confirm reached, route-specific remarks. */
function buildTripPassengersTable(displayList, options = {}) {
  const tripPm = options.tripPassengerMode;
  const tripId = tripPm?.tripId;
  const getTrip = typeof tripPm?.getTrip === "function" ? tripPm.getTrip : () => null;
  const includeVotedStatus = !!options.includeVotedStatus;
  const usePledgePills = !!options.usePledgePills;
  const includeTripRemoveAction = !!options.includeTripRemoveAction;
  const isOnboarded = typeof options.isOnboarded === "function" ? options.isOnboarded : () => false;
  const getRouteTripLbl =
    typeof options.getRoutePassengerTripLabels === "function"
      ? options.getRoutePassengerTripLabels
      : null;
  const includeRouteTripColumn = !!options.includeRouteTripColumn && getRouteTripLbl;

  const columns = ["Seq", "Image", "Name"];
  if (includeRouteTripColumn) columns.push("Trip");
  columns.push(
    "ID Number",
    "Permanent Address",
    "Mobile",
    "Ballot box",
    "Pledge",
    "Agent"
  );
  if (includeVotedStatus) columns.push("Voted status");
  columns.push("Preferred pickup", "Confirm reached");
  if (includeTripRemoveAction) columns.push("Actions");
  columns.push("Remarks");
  const colCount = columns.length;

  const wrap = document.createElement("div");
  wrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "data-table data-table--trip-passengers";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr>" +
    columns
      .map((c) =>
        c === "Seq"
          ? `<th class="data-table-col--seq">${escapeHtml(c)}</th>`
          : c === "Name"
            ? `<th class="data-table-col--name">${escapeHtml(c)}</th>`
            : c === "Trip"
              ? `<th class="data-table-col--trip-assignment">${escapeHtml(c)}</th>`
              : `<th>${escapeHtml(c)}</th>`
      )
      .join("") +
    "</tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  const dataRows = displayList.filter((x) => x.type === "row");
  if (dataRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="text-muted" style="text-align:center;padding:16px;">No voters.</td></tr>`;
  } else {
    displayList.forEach((item) => {
      if (item.type === "group") {
        const tr = document.createElement("tr");
        tr.className = "list-toolbar__group-header";
        tr.innerHTML = `<td colspan="${colCount}">${escapeHtml(item.label)}</td>`;
        tbody.appendChild(tr);
        return;
      }
      const v = item.voter;
      const tLive = getTrip();
      const vid = String(v.id);
      const prefRaw =
        tLive?.passengerPreferredPickupByVoterId &&
        typeof tLive.passengerPreferredPickupByVoterId === "object"
          ? tLive.passengerPreferredPickupByVoterId[vid] || ""
          : "";
      const prefLocal = prefRaw
        ? toDatetimeLocalValue(prefRaw)
        : DEFAULT_PREFERRED_PICKUP_DATETIME_LOCAL;
      const routeRemarks =
        tLive?.passengerRemarksByVoterId && typeof tLive.passengerRemarksByVoterId === "object"
          ? tLive.passengerRemarksByVoterId[vid] || ""
          : "";
      const reached = isOnboarded(v);
      const phoneVal = v.phone != null ? String(v.phone) : "";

      const pledgeLabel = getPledgeLabel(v.pledgeStatus);
      const pledgeClass =
        v.pledgeStatus === "yes"
          ? "pledge-pill pledge-pill--pledged"
          : v.pledgeStatus === "no"
            ? "pledge-pill pledge-pill--not-pledged"
            : "pledge-pill pledge-pill--undecided";
      const agent = getAgentForVoter(v.id);
      const votedTime = getVotedTimeMarked(v.id);
      const votedCell = votedTime
        ? '<span class="pledge-pill pledge-pill--pledged">Voted</span>'
        : '<span class="pledge-pill pledge-pill--undecided">Not voted</span>';
      const rawId = (v.nationalId || v.id || "").toString().trim().replace(/\s+/g, "");
      const photoSrc = rawId ? "photos/" + rawId + ".jpg" : "";
      const imageCell = photoSrc
        ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(
            photoSrc
          )}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(
            (v.fullName || v.id || "?")
              .toString()
              .split(/\s+/)
              .map((part) => part[0]?.toUpperCase() || "")
              .join("") || "?"
          )}</div></div>`
        : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(
            (v.fullName || v.id || "?")
              .toString()
              .split(/\s+/)
              .map((part) => part[0]?.toUpperCase() || "")
              .join("") || "?"
          )}</div></div>`;

      const row = [
        sequenceAsImportedFromCsv(v),
        imageCell,
        v.fullName != null ? v.fullName : "",
      ];
      if (includeRouteTripColumn) {
        row.push({
          html: `<span class="trip-passenger-trip-cell">${escapeHtml(String(getRouteTripLbl(v)))}</span>`,
        });
      }
      row.push(
        v.nationalId != null ? v.nationalId : (v.id != null ? v.id : ""),
        v.permanentAddress != null ? v.permanentAddress : "",
        {
          html: `<input type="tel" class="input input--trip-cell" data-trip-voter-phone="${escapeHtml(
            vid
          )}" value="${escapeHtml(phoneVal)}" aria-label="Mobile number" autocomplete="off" />`,
        },
        voterBallotBoxLabel(v),
        usePledgePills
          ? { html: `<span class="${escapeHtml(pledgeClass)}">${escapeHtml(pledgeLabel)}</span>` }
          : pledgeLabel,
        agent
      );
      if (includeVotedStatus) row.push({ html: votedCell });
      row.push({
        html: `<input type="datetime-local" class="input input--trip-cell" data-trip-preferred-pickup="${escapeHtml(
          vid
        )}" value="${escapeHtml(prefLocal)}" aria-label="Preferred pickup time" />`,
      });
      row.push({
        html: `<label class="trip-passenger-reached-label"><input type="checkbox" data-trip-reached-toggle="${escapeHtml(
          vid
        )}"${reached ? " checked" : ""} aria-label="Confirm reached" /></label>`,
      });
      if (includeTripRemoveAction) {
        row.push(
          `<button type="button" class="ghost-button ghost-button--small ghost-button--danger" data-trip-remove-voter="${escapeHtml(
            String(v.id)
          )}">Remove from route</button>`
        );
      }
      row.push({
        html: `<input type="text" class="input input--trip-cell input--trip-remarks" data-trip-passenger-remarks="${escapeHtml(
          vid
        )}" value="${escapeHtml(routeRemarks)}" placeholder="Remarks" aria-label="Route remarks" />`,
      });

      const tr = document.createElement("tr");
      const [seqVal, imageHtml, ...rest] = row;
      const restTds = rest.map((cell, idx) => {
        let colCls = "";
        if (idx === 0) colCls = "data-table-col--name";
        const clsAttr = colCls ? ` class="${colCls}"` : "";
        if (typeof cell === "string" && cell.startsWith("<button")) {
          return `<td${clsAttr}>${cell}</td>`;
        }
        if (cell && typeof cell === "object" && typeof cell.html === "string") {
          return `<td${clsAttr}>${cell.html}</td>`;
        }
        return `<td${clsAttr}>${escapeHtml(String(cell))}</td>`;
      });
      tr.innerHTML =
        `<td class="data-table-col--seq">${escapeHtml(String(seqVal))}</td><td>${imageHtml}</td>` +
        restTds.join("");
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (tripId != null) {
    wrap.dataset.tripPassengerTripId = String(tripId);
  }
  return wrap;
}

function buildTableFromDisplayList(displayList, options = {}) {
  const includeTimeVoted = !!options.includeTimeVoted;
  const showUnmarkAction = !!options.showUnmarkAction;
  const includeVotedStatus = !!options.includeVotedStatus;
  const usePledgePills = !!options.usePledgePills;
  const includeOnboardedColumn = typeof options.isOnboarded === "function";
  const includeTripRemoveAction = !!options.includeTripRemoveAction;
  const columns = [
    "Seq",
    "Image",
    "Name",
    "ID Number",
    "Permanent Address",
    "Phone",
    "Ballot box",
    "Pledge",
    "Agent",
  ];
  if (includeVotedStatus) columns.push("Voted status");
  if (includeTimeVoted) columns.push("Time voted");
  if (includeOnboardedColumn) columns.push("On-board");
  if (includeTripRemoveAction) columns.push("Actions");
  if (showUnmarkAction) columns.push("Actions");
  const colCount = columns.length;

  const wrap = document.createElement("div");
  wrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr>" +
    columns
      .map((c) =>
        c === "Seq"
          ? `<th class="data-table-col--seq">${escapeHtml(c)}</th>`
          : c === "Name"
            ? `<th class="data-table-col--name">${escapeHtml(c)}</th>`
            : `<th>${escapeHtml(c)}</th>`
      )
      .join("") +
    "</tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  const dataRows = displayList.filter((x) => x.type === "row");
  if (dataRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="text-muted" style="text-align:center;padding:16px;">No voters.</td></tr>`;
  } else {
    displayList.forEach((item) => {
      if (item.type === "group") {
        const tr = document.createElement("tr");
        tr.className = "list-toolbar__group-header";
        tr.innerHTML = `<td colspan="${colCount}">${escapeHtml(item.label)}</td>`;
        tbody.appendChild(tr);
        return;
      }
      const v = item.voter;
      const pledgeLabel = getPledgeLabel(v.pledgeStatus);
      const pledgeClass =
        v.pledgeStatus === "yes"
          ? "pledge-pill pledge-pill--pledged"
          : v.pledgeStatus === "no"
            ? "pledge-pill pledge-pill--not-pledged"
            : "pledge-pill pledge-pill--undecided";
      const agent = getAgentForVoter(v.id);
      const votedTime = getVotedTimeMarked(v.id);
      const votedCell = votedTime
        ? '<span class="pledge-pill pledge-pill--pledged">Voted</span>'
        : '<span class="pledge-pill pledge-pill--undecided">Not voted</span>';
      const rawId = (v.nationalId || v.id || "").toString().trim().replace(/\s+/g, "");
      const photoSrc = rawId ? "photos/" + rawId + ".jpg" : "";
      const imageCell = photoSrc
        ? `<div class="avatar-cell"><img class="avatar-img" src="${escapeHtml(
            photoSrc
          )}" alt="" onerror="var s=this.src;if(s.endsWith('.jpg')){this.src=s.slice(0,-4)+'.jpeg';return;}if(s.endsWith('.jpeg')){this.src=s.slice(0,-5)+'.png';return;}this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex';"><div class="avatar-circle avatar-circle--fallback" style="display:none">${escapeHtml(
            (v.fullName || v.id || "?")
              .toString()
              .split(/\s+/)
              .map((part) => part[0]?.toUpperCase() || "")
              .join("") || "?"
          )}</div></div>`
        : `<div class="avatar-cell"><div class="avatar-circle">${escapeHtml(
            (v.fullName || v.id || "?")
              .toString()
              .split(/\s+/)
              .map((part) => part[0]?.toUpperCase() || "")
              .join("") || "?"
          )}</div></div>`;

      const row = [
        sequenceAsImportedFromCsv(v),
        imageCell,
        v.fullName != null ? v.fullName : "",
        v.nationalId != null ? v.nationalId : (v.id != null ? v.id : ""),
        v.permanentAddress != null ? v.permanentAddress : "",
        v.phone != null ? v.phone : "",
        voterBallotBoxLabel(v),
        usePledgePills
          ? { html: `<span class="${escapeHtml(pledgeClass)}">${escapeHtml(pledgeLabel)}</span>` }
          : pledgeLabel,
        agent,
      ];
      if (includeVotedStatus) row.push({ html: votedCell });
      if (includeTimeVoted) row.push(formatDateTime(v._timeMarked));
      if (includeOnboardedColumn) {
        const on = options.isOnboarded(v);
        row.push({
          html: `<div class="trip-voter-onboard-cell">
            <span class="${on ? "pledge-pill pledge-pill--pledged" : "pledge-pill pledge-pill--undecided"}">${on ? "On-board" : "Pending"}</span>
            <button type="button" class="ghost-button ghost-button--small" data-trip-onboard-toggle="${escapeHtml(String(v.id))}">${on ? "Undo" : "Mark on-board"}</button>
          </div>`,
        });
      }
      if (includeTripRemoveAction) {
        row.push(
          `<button type="button" class="ghost-button ghost-button--small ghost-button--danger" data-trip-remove-voter="${escapeHtml(
            String(v.id)
          )}">Remove from route</button>`
        );
      }
      if (showUnmarkAction) {
        row.push(
          `<button type="button" class="ghost-button ghost-button--small" data-unmark-voted="${escapeHtml(
            String(v.id)
          )}">Mark not voted</button>`
        );
      }
      const tr = document.createElement("tr");
      const [seqVal, imageHtml, ...rest] = row;
      const restTds = rest.map((cell, idx) => {
        let colCls = "";
        if (idx === 0) colCls = "data-table-col--name";
        const clsAttr = colCls ? ` class="${colCls}"` : "";
        if (typeof cell === "string" && cell.startsWith("<button")) {
          return `<td${clsAttr}>${cell}</td>`;
        }
        if (cell && typeof cell === "object" && typeof cell.html === "string") {
          return `<td${clsAttr}>${cell.html}</td>`;
        }
        return `<td${clsAttr}>${escapeHtml(String(cell))}</td>`;
      });
      tr.innerHTML =
        `<td class="data-table-col--seq">${escapeHtml(String(seqVal))}</td><td>${imageHtml}</td>` +
        restTds.join("");
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function openBoxVoterListModal(boxKey, kind) {
  const includeTimeVoted = kind === "voted";
  // Title will be kept generic; counts are reflected in the table itself.
  const title =
    kind === "voted" ? `Voted – ${boxKey}` : `Not yet voted – ${boxKey}`;

  const body = document.createElement("div");
  body.className = "modal-body-inner modal-body-inner--with-maximize";

  const listToolbar = document.createElement("div");
  listToolbar.className = "modal-list-toolbar list-toolbar";
  listToolbar.innerHTML = `
    <div class="list-toolbar__search">
      <label for="zdModalListSearch" class="sr-only">Search</label>
      <input type="search" id="zdModalListSearch" placeholder="Search by name, ID, address…">
    </div>
    <div class="list-toolbar__controls">
      <div class="field-group field-group--inline">
        <label for="zdModalListFilter">Filter</label>
        <select id="zdModalListFilter">
          <option value="all">All pledge statuses</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
          <option value="undecided">Undecided</option>
        </select>
      </div>
      <div class="field-group field-group--inline">
        <label for="zdModalListSort">Sort</label>
        <select id="zdModalListSort">
          <option value="sequence">Seq</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="id">ID Number</option>
          <option value="address">Permanent address</option>
          <option value="pledge">Pledge status</option>
          <option value="agent">Agent</option>
          ${includeTimeVoted ? '<option value="time">Time voted</option>' : ""}
        </select>
      </div>
      <div class="field-group field-group--inline">
        <label for="zdModalListGroupBy">Group by</label>
        <select id="zdModalListGroupBy">
          <option value="none">None</option>
          <option value="pledge">Pledge status</option>
          <option value="agent">Agent</option>
        </select>
      </div>
      ${
        kind === "voted"
          ? `<div class="field-group field-group--inline">
               <button type="button" class="ghost-button ghost-button--danger" id="zdUnmarkAllVotedButton">
                 Mark all not voted
               </button>
             </div>`
          : ""
      }
    </div>
  `;

  const topBar = document.createElement("div");
  topBar.className = "modal-body-toolbar";
  const maxBtn = document.createElement("button");
  maxBtn.type = "button";
  maxBtn.className = "ghost-button ghost-button--small";
  maxBtn.setAttribute("aria-label", "Maximize");
  maxBtn.textContent = "Maximize";
  maxBtn.addEventListener("click", () => {
    const modal = document.getElementById("modalBackdrop");
    const dialog = modal ? modal.querySelector(".modal") : null;
    if (!dialog) return;
    const isMax = dialog.classList.toggle("modal--maximized");
    maxBtn.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
    maxBtn.textContent = isMax ? "Restore" : "Maximize";
  });
  topBar.appendChild(maxBtn);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrapper";

  function applySearchFilter(list, query) {
    const q = (query || "").toLowerCase().trim();
    if (!q) return list;
    return list.filter((v) => {
      const name = (v.fullName || "").toLowerCase();
      const id = (v.id || "").toLowerCase();
      const nationalId = (v.nationalId || "").toLowerCase();
      const address = (v.permanentAddress || "").toLowerCase();
      const phone = (v.phone || "").toLowerCase();
      return (
        name.includes(q) ||
        id.includes(q) ||
        nationalId.includes(q) ||
        address.includes(q) ||
        phone.includes(q)
      );
    });
  }

  function render() {
    const { voted, notYet } = getVotersByBoxSplitByVoted(boxKey);
    const voters = kind === "voted" ? voted : notYet;
    const filterPledge = (body.querySelector("#zdModalListFilter") || {}).value || "all";
    const sortBy = (body.querySelector("#zdModalListSort") || {}).value || "sequence";
    const groupBy = (body.querySelector("#zdModalListGroupBy") || {}).value || "none";
    const searchQuery = (body.querySelector("#zdModalListSearch") || {}).value || "";
    let list = applySearchFilter(voters, searchQuery);
    const displayList = getModalListFilteredSortedGrouped(list, filterPledge, sortBy, groupBy);
    const newTable = buildTableFromDisplayList(displayList, {
      includeTimeVoted,
      showUnmarkAction: kind === "voted",
    });
    tableWrap.innerHTML = "";
    tableWrap.appendChild(newTable.firstElementChild);
  }

  body.appendChild(topBar);
  body.appendChild(listToolbar);
  body.appendChild(tableWrap);

  listToolbar.querySelector("#zdModalListFilter").addEventListener("change", render);
  listToolbar.querySelector("#zdModalListSort").addEventListener("change", render);
  listToolbar.querySelector("#zdModalListGroupBy").addEventListener("change", render);
  const searchEl = listToolbar.querySelector("#zdModalListSearch");
  if (searchEl) searchEl.addEventListener("input", render);

  if (kind === "voted") {
    // Bulk: mark all voters in this box as not voted (password protected)
    listToolbar.querySelector("#zdUnmarkAllVotedButton")?.addEventListener("click", () => {
      const { voted } = getVotersByBoxSplitByVoted(boxKey);
      if (!voted.length) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "No voted voters",
            meta: "There are no voted voters in this ballot box to mark as not voted.",
          });
        }
        return;
      }

      const body = document.createElement("div");
      body.className = "form-grid";
      body.innerHTML = `
        <div class="form-group">
          <p class="helper-text" style="margin-bottom:8px;">
            Mark <strong>${voted.length}</strong> voters in <strong>${escapeHtml(
              boxKey
            )}</strong> as <strong>Not voted</strong>. This will clear their voted status across the application.
          </p>
          <label for="zdUnmarkAllPassword">Password</label>
          <input id="zdUnmarkAllPassword" type="password" class="input" autocomplete="off" placeholder="Enter password to confirm">
          <p class="helper-text">This action cannot be undone.</p>
        </div>
      `;

      const footer = document.createElement("div");
      footer.className = "form-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "ghost-button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => closeModal());
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "primary-button primary-button--danger";
      confirmBtn.textContent = "Mark all not voted";
      confirmBtn.addEventListener("click", async () => {
        const input = body.querySelector("#zdUnmarkAllPassword");
        const password = (input && input.value) || "";
        if (password !== "PNC@2026") {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Incorrect password",
              meta: "Bulk mark not voted was cancelled.",
            });
          }
          return;
        }
        const latest = getVotersByBoxSplitByVoted(boxKey).voted;
        if (!latest.length) {
          closeModal();
          return;
        }
        const idSet = new Set(latest.map((v) => String(v.id)));
        // Remove from local Zero Day voted entries
        zeroDayVotedEntries = zeroDayVotedEntries.filter(
          (e) => !idSet.has(String(e.voterId))
        );
        saveVotedEntries();
        notifyVotedEntriesUpdated();
        // Clear votedAt on voter docs in Firestore and delete monitor voted entries
        try {
          const api = await firebaseInitPromise;
          if (api.ready && api.setVoterFs) {
            const all = votersContext ? votersContext.getAllVoters() : [];
            const toUpdate = all.filter(
              (v) =>
                idSet.has(String(v.id)) || idSet.has(String(v.nationalId))
            );
            await Promise.all(
              toUpdate.map((v) =>
                api.setVoterFs({
                  ...v,
                  votedAt: "",
                })
              )
            );
          }
          // Also remove voted entries from monitors/{token}/voted in Firestore
          if (api.ready && api.deleteVotedForMonitor) {
            loadMonitors();
            const monitor = zeroDayMonitors.find(
              (m) => (m.ballotBox || "").trim() === boxKey
            );
            if (monitor && monitor.shareToken) {
              const token = monitor.shareToken;
              await Promise.all(
                Array.from(idSet).map((id) =>
                  api.deleteVotedForMonitor(token, id)
                )
              );
            }
          }
        } catch (_) {}
        renderZeroDayVoteTable();
        render();
        closeModal();
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);

      openModal({
        title: "Mark all as not voted",
        body,
        footer,
      });
    });

    // Row-level: mark a single voter as not voted
    tableWrap.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-unmark-voted]");
      if (!btn) return;
      const voterId = btn.getAttribute("data-unmark-voted");
      if (!voterId) return;
      const ok = await confirmDialog({
        title: "Mark not voted",
        message: `Mark this voter as not voted for ballot box ${escapeHtml(
          boxKey
        )}? This will remove their voted status from Zero Day and the voter database.`,
        confirmText: "Mark not voted",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;
      await clearVotedForVoter(voterId);
      renderZeroDayVoteTable();
      render();
    });
  }

  function zdReportBallotBoxLabel(v) {
    const box = String(v && v.ballotBox != null ? v.ballotBox : "").trim();
    const loc = String(v && v.currentLocation != null ? v.currentLocation : "").trim();
    if (box.toLowerCase() === "others" && loc) return `Others - ${loc}`;
    const fromIsland = v && v.island != null ? String(v.island).trim() : "";
    return box || fromIsland || "—";
  }

  function zdAbsolutePhotoUrl(v) {
    const rawId = (v.nationalId || v.id || "").toString().trim().replace(/\s+/g, "");
    if (!rawId) return "";
    const rel = `photos/${rawId}.jpg`;
    try {
      return new URL(rel, window.location.href).href;
    } catch (_) {
      return rel;
    }
  }

  function getVisibleVotersFlat() {
    const { voted, notYet } = getVotersByBoxSplitByVoted(boxKey);
    const base = kind === "voted" ? voted : notYet;
    const filterPledge = (body.querySelector("#zdModalListFilter") || {}).value || "all";
    const sortBy = (body.querySelector("#zdModalListSort") || {}).value || "sequence";
    const searchQuery = (body.querySelector("#zdModalListSearch") || {}).value || "";
    let list = applySearchFilter(base, searchQuery);
    const displayList = getModalListFilteredSortedGrouped(list, filterPledge, sortBy, "none");
    return displayList.filter((x) => x.type === "row").map((x) => x.voter);
  }

  function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function downloadBoxVoterCsv() {
    const rows = getVisibleVotersFlat();
    if (!rows.length) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Nothing to export",
          meta: "No voters match the current filters.",
        });
      }
      return;
    }
    const headers = [
      "Seq",
      "Name",
      "ID Number",
      "Phone",
      "Permanent Address",
      "Ballot box",
      "Pledge",
      "Agent",
    ];
    if (kind === "voted") headers.push("Time voted");
    const lines = [headers.map(csvEscape).join(",")];
    rows.forEach((v) => {
      const agent = getAgentForVoter(v.id);
      const cols = [
        sequenceAsImportedFromCsv(v),
        v.fullName || "",
        v.nationalId || v.id || "",
        v.phone || "",
        v.permanentAddress || "",
        zdReportBallotBoxLabel(v),
        getPledgeLabel(v.pledgeStatus),
        agent,
      ];
      if (kind === "voted") cols.push(formatDateTime(v._timeMarked) || "");
      lines.push(cols.map(csvEscape).join(","));
    });
    const csv = lines.join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeBox = String(boxKey || "ballot-box")
      .trim()
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 60);
    const kindSlug = kind === "voted" ? "voted" : "not-yet-voted";
    a.download = `zero-day-${kindSlug}-${safeBox}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function printBoxVoterReport() {
    const rows = getVisibleVotersFlat();
    if (!rows.length) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Nothing to print",
          meta: "No voters match the current filters.",
        });
      }
      return;
    }
    const printRows = [...rows].sort(compareVotersByBallotSequenceThenName);
    const reportTitle = kind === "voted" ? "Voted report" : "Not yet voted report";
    const subtitle =
      kind === "voted"
        ? `Ballot box: ${boxKey} | Voted voters | Total: ${printRows.length}`
        : `Ballot box: ${boxKey} | Not yet voted | Total: ${printRows.length}`;
    const timeColHeader = kind === "voted" ? "Time voted" : "Voted at";
    const rowsHtml = printRows
      .map((v) => {
        const agent = getAgentForVoter(v.id);
        const abs = zdAbsolutePhotoUrl(v);
        const photoTd = abs
          ? `<td class="col-photo"><img src="${escapeHtml(abs)}" alt="" /></td>`
          : `<td class="col-photo">—</td>`;
        const timeCell =
          kind === "voted"
            ? escapeHtml(formatDateTime(v._timeMarked) || "")
            : escapeHtml("—");
        return `
          <tr>
            <td>${escapeHtml(sequenceAsImportedFromCsv(v))}</td>
            ${photoTd}
            <td>${escapeHtml(v.fullName || "")}</td>
            <td>${escapeHtml(v.nationalId || v.id || "")}</td>
            <td>${escapeHtml(v.phone || "")}</td>
            <td>${escapeHtml(v.permanentAddress || "")}</td>
            <td>${escapeHtml(zdReportBallotBoxLabel(v))}</td>
            <td>${escapeHtml(getPledgeLabel(v.pledgeStatus))}</td>
            <td>${escapeHtml(agent)}</td>
            <td>${timeCell}</td>
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
        <title>${escapeHtml(reportTitle)} — ${escapeHtml(boxKey)}</title>
        <style>
          :root { color-scheme: light; }
          body { font-family: Arial, sans-serif; margin: 0; color: #111; background: #f5f7fb; }
          .page { max-width: 1280px; margin: 20px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.06); overflow: hidden; }
          .report-head { padding: 16px 18px; border-bottom: 1px solid #e5e7eb; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
          .report-title { margin: 0; font-size: 20px; line-height: 1.2; }
          .report-meta { margin: 4px 0 0; color: #4b5563; font-size: 13px; }
          .report-actions { display: flex; gap: 8px; }
          .btn { border: 1px solid #d1d5db; background: #fff; color: #111; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
          .btn--primary { border-color: #2563eb; background: #2563eb; color: #fff; }
          .table-wrap { padding: 10px; overflow: auto; }
          table { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; min-width: 1020px; }
          th, td {
            border: 1px solid #e5e7eb;
            padding: 4px 5px;
            text-align: left;
            vertical-align: middle;
            line-height: 1.2;
            white-space: normal;
            overflow-wrap: anywhere;
            word-break: break-word;
            hyphens: auto;
          }
          th { background: #f9fafb; font-weight: 600; position: sticky; top: 0; z-index: 1; }
          tbody tr:nth-child(odd) { background: #fcfcfd; }
          .col-photo { width: 52px; text-align: center; vertical-align: middle; }
          .col-photo img { display: block; margin: 0 auto; max-height: 44px; max-width: 48px; width: auto; height: auto; object-fit: cover; border-radius: 4px; }
          .col-seq { width: 4%; }
          .col-name { width: 13%; }
          .col-id { width: 9%; }
          .col-phone { width: 8%; }
          .col-address { width: 20%; }
          .col-box { width: 8%; }
          .col-pledge { width: 6%; }
          .col-agent { width: 10%; }
          .col-time { width: 9%; }
          @media print {
            @page { size: A4 landscape; margin: 9mm; }
            body { background: #fff; }
            .page { margin: 0; border: none; box-shadow: none; border-radius: 0; max-width: none; }
            .report-actions { display: none !important; }
            .table-wrap { padding: 0; overflow: visible; }
            table { min-width: 0; width: 100%; font-size: 8.5px; table-layout: fixed; }
            th, td { padding: 2px 3px; line-height: 1.12; }
            th { position: static; }
            .col-photo img { max-height: 36px; max-width: 40px; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <header class="report-head">
            <div>
              <h1 class="report-title">${escapeHtml(reportTitle)}</h1>
              <p class="report-meta">${escapeHtml(subtitle)} | Generated: ${escapeHtml(
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
                  <th class="col-photo">Photo</th>
                  <th class="col-name">Name</th>
                  <th class="col-id">ID Number</th>
                  <th class="col-phone">Phone</th>
                  <th class="col-address">Permanent Address</th>
                  <th class="col-box">Ballot box</th>
                  <th class="col-pledge">Pledge</th>
                  <th class="col-agent">Agent</th>
                  <th class="col-time">${escapeHtml(timeColHeader)}</th>
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

  async function shareBoxVoterReport() {
    const rows = getVisibleVotersFlat();
    if (!rows.length) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Nothing to share",
          meta: "No voters match the current filters.",
        });
      }
      return;
    }
    const reportTitle = kind === "voted" ? `Voted — ${boxKey}` : `Not yet voted — ${boxKey}`;
    const header = [
      "Seq",
      "Name",
      "ID Number",
      "Phone",
      "Permanent address",
      "Ballot box",
      "Pledge",
      "Agent",
    ];
    if (kind === "voted") header.push("Time voted");
    const lines = [header.join("\t")];
    rows.forEach((v) => {
      const agent = getAgentForVoter(v.id);
      const cells = [
        sequenceAsImportedFromCsv(v),
        v.fullName || "",
        v.nationalId || v.id || "",
        v.phone || "",
        v.permanentAddress || "",
        zdReportBallotBoxLabel(v),
        getPledgeLabel(v.pledgeStatus),
        agent,
      ];
      if (kind === "voted") cells.push(formatDateTime(v._timeMarked) || "");
      lines.push(cells.join("\t"));
    });
    const text = `${reportTitle} (${rows.length} voters)\n\n${lines.join("\n")}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: reportTitle, text });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      if (typeof window.showToast === "function") window.showToast("Report copied to clipboard");
      else if (window.appNotifications) {
        window.appNotifications.push({
          title: "Copied",
          meta: "Report text copied to the clipboard — paste into email or chat.",
        });
      }
    } catch (_) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Share failed",
          meta: "Could not copy to clipboard. Try Print or Download CSV.",
        });
      }
    }
  }

  render();

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.flexWrap = "wrap";
  footer.style.gap = "8px";
  footer.style.justifyContent = "flex-end";

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "ghost-button";
  shareBtn.textContent = "Share";
  shareBtn.addEventListener("click", () => shareBoxVoterReport());

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "ghost-button";
  downloadBtn.textContent = "Download CSV";
  downloadBtn.addEventListener("click", downloadBoxVoterCsv);

  const printBtn = document.createElement("button");
  printBtn.type = "button";
  printBtn.className = "ghost-button";
  printBtn.textContent = "Print";
  printBtn.addEventListener("click", printBoxVoterReport);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost-button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closeModal());

  footer.appendChild(shareBtn);
  footer.appendChild(downloadBtn);
  footer.appendChild(printBtn);
  footer.appendChild(closeBtn);

  openModal({
    title,
    body,
    footer,
    startMaximized: true,
    dialogClass: "modal--wide",
    closeOnBackdropClick: false,
    closeOnEscape: false,
  });
  maxBtn.setAttribute("aria-label", "Restore");
  maxBtn.textContent = "Restore";

  function refreshBoxModalIfOpen() {
    const backdrop = document.getElementById("modalBackdrop");
    if (!backdrop || backdrop.hidden || !body.isConnected) return;
    render();
  }

  const onVotedEntriesSync = () => refreshBoxModalIfOpen();
  const onVotersSync = () => refreshBoxModalIfOpen();
  const onZeroDayRefresh = () => refreshBoxModalIfOpen();
  document.addEventListener("voted-entries-updated", onVotedEntriesSync);
  document.addEventListener("voters-updated", onVotersSync);
  document.addEventListener("zero-day-refresh", onZeroDayRefresh);

  void (async () => {
    try {
      await syncVotedFromFirestore();
      if (votersContext && typeof votersContext.getAllVoters === "function") {
        mergeVotedAtFromVoters(votersContext.getAllVoters());
      }
    } catch (_) {}
    refreshBoxModalIfOpen();
  })();

  let modalVotePollId = null;
  modalVotePollId = setInterval(() => {
    if (zeroDaySyncIntervalId != null) return;
    void syncVotedFromFirestore();
  }, ZERO_DAY_SYNC_INTERVAL_MS);

  const backdrop = document.getElementById("modalBackdrop");
  const obs =
    backdrop &&
    new MutationObserver(() => {
      if (backdrop.hidden) {
        document.removeEventListener("voted-entries-updated", onVotedEntriesSync);
        document.removeEventListener("voters-updated", onVotersSync);
        document.removeEventListener("zero-day-refresh", onZeroDayRefresh);
        if (modalVotePollId != null) {
          clearInterval(modalVotePollId);
          modalVotePollId = null;
        }
        obs.disconnect();
      }
    });
  if (backdrop && obs) obs.observe(backdrop, { attributes: true, attributeFilter: ["hidden"] });
}

/** Gets or creates a monitor for the ballot box (same grouping as cards: ballotBox || island || "Unassigned"). Always refreshes voter list so Firestore has current voters. Returns the monitor (does not copy link). */
function getOrEnsureMonitorForBallotBox(ballotBox) {
  const boxKey = (ballotBox || "").trim();
  const allVoters = votersContext ? votersContext.getAllVoters() : [];
  const ids = allVoters
    .filter((v) => (v.ballotBox || v.island || "Unassigned").trim() === boxKey)
    .map((v) => v.id);
  const voterIds = [...new Set(ids)];

  let monitor = zeroDayMonitors.find((m) => (m.ballotBox || "").trim() === boxKey);
  if (!monitor) {
    const nextId =
      zeroDayMonitors.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    monitor = {
      id: nextId,
      name: "",
      mobile: "",
      ballotBox: boxKey,
      voterIds,
      shareToken: generateShareToken(),
      sequenceOffset: 0,
    };
    zeroDayMonitors.push(monitor);
  } else {
    monitor.voterIds = voterIds;
  }
  saveMonitors();
  syncMonitorToFirestore(monitor);
  renderMonitorsTable();
  subscribeVotedRealtime();
  return monitor;
}

function ensureMonitorForBallotBox(ballotBox) {
  const monitor = getOrEnsureMonitorForBallotBox(ballotBox);
  copyMonitorListUrlOnly(monitor.id);
}

function renderZeroDayVoteTable() {
  if (!zeroDayVoteCardsContainer) return;
  zeroDayVoteCardsContainer.innerHTML = "";
  const boxes = getVoteBoxSummaries();
  const total = boxes.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (zeroDayVoteCurrentPage > totalPages) zeroDayVoteCurrentPage = totalPages;
  const start = (zeroDayVoteCurrentPage - 1) * PAGE_SIZE;
  const pageBoxes = boxes.slice(start, start + PAGE_SIZE);

  if (boxes.length === 0) {
    const div = document.createElement("div");
    div.className = "helper-text";
    div.style.padding = "12px 0";
    div.textContent =
      votersContext && votersContext.getAllVoters().length > 0
        ? "No ballot boxes match the current filter."
        : "Ballot boxes will appear here once voters are imported in Settings → Data.";
    zeroDayVoteCardsContainer.appendChild(div);
  } else {
    pageBoxes.forEach((box) => {
      const card = document.createElement("div");
      card.className = "vote-box-card";
      const boxKey = (box.box || "").trim();
      const boxVoters = votersContext
        ? votersContext
            .getAllVoters()
            .filter((v) => (v.ballotBox || v.island || "Unassigned").trim() === boxKey)
        : [];
      const percentage =
        box.total === 0 ? 0 : Math.round((box.voted / box.total) * 100);
      const notYet = Math.max(0, box.total - box.voted);
      const votedPct = box.total === 0 ? 0 : (box.voted / box.total) * 100;
      const pledgeYes = boxVoters.filter((v) => (v.pledgeStatus || "undecided") === "yes").length;
      const pledgeNo = boxVoters.filter((v) => (v.pledgeStatus || "undecided") === "no").length;
      const pledgeUndecided = Math.max(0, box.total - pledgeYes - pledgeNo);
      const pledgeYesPct = box.total === 0 ? 0 : (pledgeYes / box.total) * 100;
      const pledgeNoPct = box.total === 0 ? 0 : (pledgeNo / box.total) * 100;
      const pledgeUndecidedPct = Math.max(0, 100 - pledgeYesPct - pledgeNoPct);
      const badgeClass =
        percentage >= 100
          ? "vote-box-card__badge--full"
          : percentage > 0
            ? "vote-box-card__badge--partial"
            : "vote-box-card__badge--none";
      const monitorForBox = zeroDayMonitors.find((m) => (m.ballotBox || "").trim() === boxKey);
      const mid = monitorForBox ? String(monitorForBox.id) : "";
      const codeDisplay = monitorForBox ? getMonitorShareUrls(monitorForBox).accessCode : "";
      const codeCopyAttr = mid
        ? `data-copy-monitor-code="${mid}"`
        : `data-copy-monitor-code-for-box="${escapeHtml(boxKey)}"`;
      const linkCopyAttr = mid
        ? `data-copy-monitor-link="${mid}"`
        : `data-copy-monitor-link-for-box="${escapeHtml(boxKey)}"`;
      card.innerHTML = `
        <div class="vote-box-card__header">
          <div>
            <div class="vote-box-card__title-wrap">
              <span class="vote-box-card__title">${escapeHtml(box.box)}</span>
            </div>
            <div class="vote-box-card__meta">${escapeHtml(box.island || "")}</div>
            <div class="vote-box-card__code-row">
              <span class="vote-box-card__code-label">Code</span>
              <code class="vote-box-card__code-value">${escapeHtml(codeDisplay || "—")}</code>
              <button type="button" class="vote-box-card__copy-btn" ${codeCopyAttr} title="Copy code" aria-label="Copy code">${monitorShareIconCopy()}</button>
              <button type="button" class="vote-box-card__copy-btn" ${linkCopyAttr} title="Copy list link" aria-label="Copy list link">${monitorShareIconLink()}</button>
            </div>
          </div>
          <span class="vote-box-card__badge ${badgeClass}">${percentage}% voted</span>
        </div>
        <div class="vote-box-card__progress" role="img" aria-label="${percentage}% voted">
          <span class="vote-box-card__progress-seg vote-box-card__progress-seg--voted" style="width:${votedPct}%"></span>
          <span class="vote-box-card__progress-seg vote-box-card__progress-seg--not-yet" style="width:${100 - votedPct}%"></span>
        </div>
        <div class="vote-box-card__legend">
          <span class="vote-box-card__legend-item"><i class="vote-box-card__dot vote-box-card__dot--voted"></i>Turnout</span>
          <span class="vote-box-card__legend-item"><i class="vote-box-card__dot vote-box-card__dot--not-yet"></i>Not yet</span>
        </div>
        <div class="vote-box-card__stats">
          <span><strong>Total:</strong> ${box.total}</span>
          <span><strong>Voted:</strong> ${box.voted}</span>
          <span><strong>Not yet:</strong> ${notYet}</span>
        </div>
        <div class="vote-box-card__subhead">Pledge graph</div>
        <div class="vote-box-card__progress vote-box-card__progress--pledge" role="img" aria-label="Pledge distribution: Yes ${pledgeYes}, No ${pledgeNo}, Undecided ${pledgeUndecided}">
          <span class="vote-box-card__progress-seg vote-box-card__progress-seg--pledge-yes" style="width:${pledgeYesPct}%"></span>
          <span class="vote-box-card__progress-seg vote-box-card__progress-seg--pledge-no" style="width:${pledgeNoPct}%"></span>
          <span class="vote-box-card__progress-seg vote-box-card__progress-seg--pledge-undecided" style="width:${pledgeUndecidedPct}%"></span>
        </div>
        <div class="vote-box-card__stats vote-box-card__stats--compact">
          <span><strong>Yes:</strong> ${pledgeYes}</span>
          <span><strong>No:</strong> ${pledgeNo}</span>
          <span><strong>Undecided:</strong> ${pledgeUndecided}</span>
        </div>
        <div class="vote-box-card__actions">
          <div class="vote-box-card__session-btns" role="group" aria-label="Open or close vote marking for this ballot box">
            <button type="button" class="monitor-admin-session-btn monitor-admin-session-btn--open vote-box-card__sess-btn" data-vote-card-ballot-open="${escapeHtml(
              boxKey
            )}" title="Open vote marking" aria-label="Open vote marking">${ADMIN_BALLOT_SESSION_OPEN_SVG}</button>
            <button type="button" class="monitor-admin-session-btn monitor-admin-session-btn--close vote-box-card__sess-btn" data-vote-card-ballot-close="${escapeHtml(
              boxKey
            )}" title="Close vote marking" aria-label="Close vote marking">${ADMIN_BALLOT_SESSION_CLOSE_SVG}</button>
          </div>
          <div class="vote-box-card__view-btns" role="group" aria-label="View voter lists">
            <button type="button" class="ghost-button ghost-button--small vote-box-card__view-btn vote-box-card__view-btn--voted" data-view-voted="${escapeHtml(
              box.box
            )}" title="View voted" aria-label="View voted">${VOTE_BOX_VIEW_VOTED_SVG}</button>
            <button type="button" class="ghost-button ghost-button--small vote-box-card__view-btn vote-box-card__view-btn--not-yet" data-view-not-yet="${escapeHtml(
              box.box
            )}" title="View not yet" aria-label="View not yet">${VOTE_BOX_VIEW_NOT_YET_SVG}</button>
          </div>
        </div>
      `;
      zeroDayVoteCardsContainer.appendChild(card);
    });
  }

  if (zeroDayVotePaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    zeroDayVotePaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${zeroDayVoteCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${zeroDayVoteCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${zeroDayVoteCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    zeroDayVotePaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && zeroDayVoteCurrentPage > 1)
          zeroDayVoteCurrentPage--;
        if (btn.dataset.page === "next" && zeroDayVoteCurrentPage < totalPages)
          zeroDayVoteCurrentPage++;
        renderZeroDayVoteTable();
      });
    });
  }
}

function openMarkVotedModal() {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const votedSet = new Set(zeroDayVotedEntries.map((e) => String(e.voterId)));
  const notVotedYet = voters.filter((v) => !votedSet.has(String(v.id)));

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="zdMarkVoter">Voter</label>
        <select id="zdMarkVoter">
          <option value="">Select a voter…</option>
          ${notVotedYet
            .map(
              (v) =>
                `<option value="${escapeHtml(v.id)}">${escapeHtml(v.fullName || v.id)} ${v.nationalId ? "(" + escapeHtml(v.nationalId) + ")" : ""}</option>`
            )
            .join("")}
        </select>
      </div>
      <div class="form-group">
        <label for="zdMarkTime">Time marked</label>
        <input id="zdMarkTime" type="datetime-local" value="${new Date().toISOString().slice(0, 16)}">
      </div>
    </div>
    ${notVotedYet.length === 0 ? '<p class="helper-text">All voters in the list have already been marked as voted.</p>' : ""}
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
  saveBtn.textContent = "Mark as voted";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  if (notVotedYet.length === 0) saveBtn.disabled = true;

  saveBtn.addEventListener("click", async () => {
    const voterId = body.querySelector("#zdMarkVoter").value.trim();
    const timeVal = body.querySelector("#zdMarkTime").value;
    if (!voterId) return;
    const timeMarked = timeVal ? new Date(timeVal).toISOString() : new Date().toISOString();
    zeroDayVotedEntries.push({ voterId, timeMarked });
    saveVotedEntries();
    // Write to Firestore so ballot box link and other devices see the update; sync to voter doc
    try {
      const api = await firebaseInitPromise;
      const voter = voters.find((v) => sameVoterId(v.id, voterId));
      if (api.ready) {
        if (api.setVotedForMonitor) {
          const boxKey = voter
            ? ((voter.ballotBox || voter.island || "").trim() || "Unassigned")
            : "";
          if (boxKey) {
            const monitor = getOrEnsureMonitorForBallotBox(boxKey);
            if (monitor?.shareToken) await api.setVotedForMonitor(monitor.shareToken, voterId, timeMarked);
          }
        }
        // Sync voted status to voter document so Voters list and reports stay in sync
        if (voter && api.setVoterFs) await api.setVoterFs({ ...voter, votedAt: timeMarked });
        else if (api.setVoterVotedAtFs) await api.setVoterVotedAtFs(voterId, timeMarked);
      }
    } catch (_) {}
    renderZeroDayVoteTable();
    notifyVotedEntriesUpdated();
    if (window.appNotifications) {
      const voter = voters.find((v) => sameVoterId(v.id, voterId));
      window.appNotifications.push({
        title: "Voter marked as voted",
        meta: voter ? `${voter.fullName} • ${voter.nationalId || ""}` : voterId,
      });
    }
    closeModal();
  });

  openModal({
    title: "Mark voter as voted",
    body,
    footer,
  });
}

function bindZeroDayToolbar() {
  const go = () => {
    zeroDayVoteCurrentPage = 1;
    renderZeroDayVoteTable();
  };
  if (zeroDayVoteSearch) zeroDayVoteSearch.addEventListener("input", go);
  if (zeroDayVoteFilter) zeroDayVoteFilter.addEventListener("change", go);
}

function bindTransportMenu() {
  if (!zeroDayTransportMenuButton || !zeroDayTransportMenu) return;
  zeroDayTransportMenuButton.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = zeroDayTransportMenu.hidden;
    zeroDayTransportMenu.hidden = !willOpen;
    zeroDayTransportMenuButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });
  zeroDayTransportMenu.querySelectorAll("[data-transport-view]").forEach((item) => {
    item.addEventListener("click", () => {
      transportViewFilter = item.getAttribute("data-transport-view");
      zeroDayTransportMenu.hidden = true;
      zeroDayTransportMenuButton.setAttribute("aria-expanded", "false");
      renderZeroDayTripsTable();
    });
  });
  document.addEventListener("click", (e) => {
    if (zeroDayTransportMenu.hidden) return;
    if (zeroDayTransportMenuButton?.contains(e.target) || zeroDayTransportMenu?.contains(e.target)) return;
    zeroDayTransportMenu.hidden = true;
    zeroDayTransportMenuButton?.setAttribute("aria-expanded", "false");
  });
}

export function initZeroDayModule(votersContextParam, options = {}) {
  votersContext = votersContextParam || null;
  pledgeContextRef = options.pledgesContext || null;
  updateVoterPhoneFromHost =
    typeof options.updateVoterPhone === "function" ? options.updateVoterPhone : null;
  loadVotedEntries();
  loadMonitors();
  loadTrips();
  loadTransportRoutes();
  initTransportVisibleColumns();
  initTransportRoutesVisibleColumns();
  bindTransportColumnsMenuOnce();
  initZeroDayTabs();
  bindTransportMenu();
  bindTransportMainTabs();
  renderZeroDayTripsTable();
  renderTransportRoutesTable();
  renderZeroDayVoteTable();
  renderMonitorsTable();
  bindZeroDayToolbar();

  if (!monitorBallotSessionVisibilityBound) {
    monitorBallotSessionVisibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      firebaseInitPromise
        .then((api) => {
          if (!api.getBallotSessionFs) return;
          const tbl = document.getElementById("zeroDayMonitorsTable");
          if (!tbl) return;
          zeroDayMonitors.forEach((m) => {
            if (!m.shareToken) return;
            if (!tbl.querySelector(`tbody [data-monitor-session-cell="${String(m.id)}"]`)) return;
            api
              .getBallotSessionFs(m.shareToken)
              .then((s) => applyMonitorSessionCell(m.id, s))
              .catch(() => {});
          });
        })
        .catch(() => {});
    });
  }

  firebaseInitPromise.then((api) => {
    if (!api.ready || !api.getAllTransportTripsFs) return;
    api
      .getAllTransportTripsFs()
      .then(async (remote) => {
        if (!Array.isArray(remote)) return;
        const localBefore = zeroDayTrips.slice();
        zeroDayTrips = mergeTransportTripLists(localBefore, remote.map(normalizeTrip));
        saveTrips();
        renderZeroDayTripsTable();
        renderTransportRoutesTable();
        try {
          await flushTransportTripsToFirestore();
        } catch (e) {
          console.warn("[ZeroDay] flush transport trips after initial merge", e);
        }
      })
      .catch(() => {});
    if (api.onTransportTripsSnapshotFs) {
      transportTripsUnsubscribe = api.onTransportTripsSnapshotFs((items) => {
        if (!Array.isArray(items)) return;
        const remote = items.map(normalizeTrip);
        zeroDayTrips = mergeTransportTripLists(zeroDayTrips, remote);
        saveTrips();
        renderZeroDayTripsTable();
        renderTransportRoutesTable();
      });
    }
    if (api.getAllTransportRoutesFs) {
      api
        .getAllTransportRoutesFs()
        .then(async (remote) => {
          if (!Array.isArray(remote)) return;
          const localBefore = zeroDayTransportRoutes.slice();
          zeroDayTransportRoutes = mergeTransportRouteLists(
            localBefore,
            remote.map(normalizeTransportRoute)
          );
          saveTransportRoutes();
          renderTransportRoutesTable();
          try {
            await flushTransportRoutesToFirestore();
          } catch (e) {
            console.warn("[ZeroDay] flush transport routes after initial merge", e);
          }
        })
        .catch(() => {});
    }
    if (api.onTransportRoutesSnapshotFs) {
      transportRoutesUnsubscribe = api.onTransportRoutesSnapshotFs((items) => {
        if (!Array.isArray(items)) return;
        zeroDayTransportRoutes = mergeTransportRouteLists(
          zeroDayTransportRoutes,
          items.map(normalizeTransportRoute)
        );
        saveTransportRoutes();
        renderTransportRoutesTable();
      });
    }
  }).catch(() => {});

  if (zeroDayAddTripButton) {
    zeroDayAddTripButton.addEventListener("click", () => openTripForm(null));
  }

  const zeroDayAddRouteButton = document.getElementById("zeroDayAddRouteButton");
  if (zeroDayAddRouteButton) {
    zeroDayAddRouteButton.addEventListener("click", () => openRouteForm(null));
  }

  if (zeroDayAddMonitorButton) {
    zeroDayAddMonitorButton.addEventListener("click", () => openAddMonitorForm(null));
  }

  const monitorsPanel = document.getElementById("zero-day-tab-monitors");
  if (monitorsPanel) {
    monitorsPanel.addEventListener("click", (e) => {
      const menuTrigger = e.target.closest("[data-monitor-menu-trigger]");
      if (menuTrigger) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = menuTrigger.closest(".zero-day-monitor-row-menu");
        const menu = wrap?.querySelector("[data-monitor-row-dropdown]");
        if (!menu) return;
        if (!menu.hidden) {
          closeAllMonitorRowMenus(monitorsPanel);
          return;
        }
        openMonitorRowMenu(monitorsPanel, wrap, menu, menuTrigger);
        return;
      }

      const viewBtn = e.target.closest("[data-view-monitor]");
      const assignBtn = e.target.closest("[data-assign-voters]");
      const copyCodeBtn = e.target.closest("[data-copy-monitor-code]");
      const copyLinkBtn = e.target.closest("[data-copy-monitor-link]");
      const editBtn = e.target.closest("[data-edit-monitor]");
      const deleteBtn = e.target.closest("[data-delete-monitor]");
      const adminBallotOpen = e.target.closest("[data-admin-ballot-open]");
      const adminBallotClose = e.target.closest("[data-admin-ballot-close]");
      if (adminBallotOpen || adminBallotClose) {
        e.preventDefault();
        const id = Number(
          adminBallotOpen?.getAttribute("data-admin-ballot-open") ||
            adminBallotClose?.getAttribute("data-admin-ballot-close")
        );
        const monitor = zeroDayMonitors.find((m) => m.id === id);
        if (!monitor?.shareToken) return;
        const wantOpen = !!adminBallotOpen;
        void (async () => {
          const ok = await adminSetVoteMarkingSessionForMonitor(monitor, wantOpen);
          if (typeof window.showToast === "function") {
            window.showToast(
              ok
                ? wantOpen
                  ? "Vote marking opened for this ballot box."
                  : "Vote marking closed for this ballot box."
                : "Could not update vote marking session."
            );
          }
        })();
        return;
      }
      if (viewBtn) {
        closeAllMonitorRowMenus(monitorsPanel);
        const id = Number(viewBtn.getAttribute("data-view-monitor"));
        const monitor = zeroDayMonitors.find((m) => m.id === id);
        if (monitor) openMonitorViewModal(monitor);
      } else if (assignBtn) {
        closeAllMonitorRowMenus(monitorsPanel);
        const id = Number(assignBtn.getAttribute("data-assign-voters"));
        assignVotersFromBallotBox(id);
      } else if (copyCodeBtn) {
        const id = Number(copyCodeBtn.getAttribute("data-copy-monitor-code"));
        copyMonitorAccessCodeOnly(id);
      } else if (copyLinkBtn) {
        const id = Number(copyLinkBtn.getAttribute("data-copy-monitor-link"));
        copyMonitorListUrlOnly(id);
      } else if (editBtn) {
        closeAllMonitorRowMenus(monitorsPanel);
        const id = Number(editBtn.getAttribute("data-edit-monitor"));
        const monitor = zeroDayMonitors.find((m) => m.id === id);
        if (monitor) openAddMonitorForm(monitor);
      } else if (deleteBtn) {
        closeAllMonitorRowMenus(monitorsPanel);
        const id = Number(deleteBtn.getAttribute("data-delete-monitor"));
        deleteMonitorLink(id);
      }
    });
  }

  const transportPanel = document.getElementById("module-transportation");
  if (transportPanel) {
    transportPanel.addEventListener(
      "blur",
      (e) => {
        const inpRoute = e.target.closest("[data-route-meta-field]");
        if (inpRoute && transportPanel.contains(inpRoute)) {
          const rid = inpRoute.getAttribute("data-route-id");
          const field = inpRoute.getAttribute("data-route-meta-field");
          if (rid != null && rid !== "" && field && ROUTE_TABLE_EDITABLE_FIELDS.has(field)) {
            const raw =
              field === "pickupTime" ? inpRoute.value : String(inpRoute.value || "").trim();
            persistRouteMetaField(rid, field, raw);
          }
          return;
        }
        const inp = e.target.closest("[data-trip-meta-field]");
        if (!inp || !transportPanel.contains(inp)) return;
        const tid = inp.getAttribute("data-trip-id");
        const field = inp.getAttribute("data-trip-meta-field");
        if (tid == null || tid === "" || !field || !TRIP_TABLE_EDITABLE_FIELDS.has(field)) return;
        const raw =
          field === "pickupTime" ? inp.value : String(inp.value || "").trim();
        persistTripMetaField(tid, field, raw);
      },
      true
    );
    transportPanel.addEventListener("click", (e) => {
      const rStatus = e.target.closest("[data-route-status]");
      const rVoters = e.target.closest("[data-view-route-voters]");
      const rEdit = e.target.closest("[data-edit-route]");
      const rDel = e.target.closest("[data-delete-route]");
      if (rStatus) {
        openTransportRouteStatusModal(rStatus.getAttribute("data-route-status"));
        return;
      }
      if (rVoters) {
        const route = findTransportRouteById(rVoters.getAttribute("data-view-route-voters"));
        if (route) openTransportRouteVotersModal(route);
        return;
      }
      if (rEdit) {
        const route = findTransportRouteById(rEdit.getAttribute("data-edit-route"));
        if (route) openRouteForm(route);
        return;
      }
      if (rDel) {
        deleteTransportRoute(rDel.getAttribute("data-delete-route"));
        return;
      }
      const statusBtn = e.target.closest("[data-trip-status]");
      const viewBtn = e.target.closest("[data-view-trip-voters]");
      const editBtn = e.target.closest("[data-edit-trip]");
      const deleteBtn = e.target.closest("[data-delete-trip]");
      if (statusBtn) {
        openTripStatusModal(statusBtn.getAttribute("data-trip-status"));
      } else if (viewBtn) {
        const trip = findZeroDayTripById(viewBtn.getAttribute("data-view-trip-voters"));
        if (trip) openTripVotersModal(trip);
      } else if (editBtn) {
        const trip = findZeroDayTripById(editBtn.getAttribute("data-edit-trip"));
        if (trip) openTripForm(trip);
      } else if (deleteBtn) {
        deleteTrip(deleteBtn.getAttribute("data-delete-trip"));
      }
    });
  }

  const zeroDayTransportAllExcel = document.getElementById("zeroDayTransportAllExcel");
  const zeroDayTransportAllPrint = document.getElementById("zeroDayTransportAllPrint");
  const zeroDayTransportAllShare = document.getElementById("zeroDayTransportAllShare");
  if (zeroDayTransportAllExcel) {
    zeroDayTransportAllExcel.addEventListener("click", () => {
      const snaps = getAllVisibleTripSnapshots();
      if (snaps.length) downloadTransportTripsReportCsv(snaps);
      else if (window.appNotifications) {
        window.appNotifications.push({
          title: "No trips",
          meta: "Add a trip, adjust the type menu, or clear search and filters.",
        });
      }
    });
  }
  if (zeroDayTransportAllPrint) {
    zeroDayTransportAllPrint.addEventListener("click", () => {
      const snaps = getAllVisibleTripSnapshots();
      if (snaps.length) openTransportTripsReportWindow(snaps, false);
      else if (window.appNotifications) {
        window.appNotifications.push({
          title: "No trips",
          meta: "Add a trip, adjust the type menu, or clear search and filters.",
        });
      }
    });
  }
  if (zeroDayTransportAllShare) {
    zeroDayTransportAllShare.addEventListener("click", () => {
      const snaps = getAllVisibleTripSnapshots();
      if (snaps.length) shareTransportTripsReport(snaps);
      else if (window.appNotifications) {
        window.appNotifications.push({
          title: "No trips",
          meta: "Add a trip, adjust the type menu, or clear search and filters.",
        });
      }
    });
  }

  const zeroDayTransportRoutesExcel = document.getElementById("zeroDayTransportRoutesExcel");
  const zeroDayTransportRoutesPrint = document.getElementById("zeroDayTransportRoutesPrint");
  const zeroDayTransportRoutesShare = document.getElementById("zeroDayTransportRoutesShare");
  if (zeroDayTransportRoutesExcel) {
    zeroDayTransportRoutesExcel.addEventListener("click", () => {
      const snaps = getAllVisibleRouteSnapshots();
      if (snaps.length) downloadTransportRoutesReportCsv(snaps);
      else if (window.appNotifications) {
        window.appNotifications.push({
          title: "No routes",
          meta: "Add a route or clear search and filters.",
        });
      }
    });
  }
  if (zeroDayTransportRoutesPrint) {
    zeroDayTransportRoutesPrint.addEventListener("click", () => {
      const snaps = getAllVisibleRouteSnapshots();
      if (snaps.length) openTransportRoutesReportWindow(snaps, false);
      else if (window.appNotifications) {
        window.appNotifications.push({
          title: "No routes",
          meta: "Add a route or clear search and filters.",
        });
      }
    });
  }
  if (zeroDayTransportRoutesShare) {
    zeroDayTransportRoutesShare.addEventListener("click", () => {
      const snaps = getAllVisibleRouteSnapshots();
      if (snaps.length) void shareTransportRoutesReport(snaps);
      else if (window.appNotifications) {
        window.appNotifications.push({
          title: "No routes",
          meta: "Add a route or clear search and filters.",
        });
      }
    });
  }

  if (zeroDayMarkVotedButton) {
    zeroDayMarkVotedButton.addEventListener("click", openMarkVotedModal);
  }

  document.addEventListener("zero-day-refresh", () => {
    zeroDayVoteCurrentPage = 1;
    renderZeroDayVoteTable();
  });

  document.addEventListener("voters-updated", () => {
    renderZeroDayVoteTable();
    renderZeroDayTripsTable();
  });

  const zeroDaySyncVotedBtn = document.getElementById("zeroDaySyncVotedBtn");

  function setSyncButtonState(syncing) {
    zeroDaySyncInProgress = syncing;
    if (!zeroDaySyncVotedBtn) return;
    if (syncing) {
      zeroDaySyncVotedBtn.disabled = true;
      zeroDaySyncVotedBtn.textContent = "Syncing Votes";
      zeroDaySyncVotedBtn.classList.add("zero-day-sync-syncing");
    } else {
      zeroDaySyncVotedBtn.disabled = false;
      zeroDaySyncVotedBtn.textContent = "Sync votes";
      zeroDaySyncVotedBtn.classList.remove("zero-day-sync-syncing");
    }
  }

  async function runSyncVotes(showToast = false) {
    if (zeroDaySyncInProgress) return;
    setSyncButtonState(true);
    try {
      await syncVotedFromFirestore();
      zeroDayVoteCurrentPage = 1;
      renderZeroDayVoteTable();
      if (showToast && typeof window.showToast === "function") window.showToast("Votes synced from ballot box links.");
    } finally {
      setSyncButtonState(false);
    }
  }

  if (zeroDaySyncVotedBtn) {
    zeroDaySyncVotedBtn.addEventListener("click", () => runSyncVotes(true));
  }

  async function updateAllMonitorsMonitoringEnabled(enabled) {
    try {
      const api = await firebaseInitPromise;
      if (!api.ready || !api.setMonitorDoc) return;
      loadMonitors();
      for (const m of zeroDayMonitors) {
        if (m.shareToken) await api.setMonitorDoc(m.shareToken, { monitoringEnabled: !!enabled });
      }
    } catch (_) {}
  }

  const zeroDayMonitorVotesToggle = document.getElementById("zeroDayMonitorVotesToggle");
  if (zeroDayMonitorVotesToggle) {
    zeroDayMonitorVotesToggle.addEventListener("change", async () => {
      const enabled = zeroDayMonitorVotesToggle.checked;
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.setVoteMonitoringEnabled) await api.setVoteMonitoringEnabled(enabled);
        await updateAllMonitorsMonitoringEnabled(enabled);
        if (enabled) {
          runSyncVotes();
          if (zeroDaySyncIntervalId != null) clearInterval(zeroDaySyncIntervalId);
          zeroDaySyncIntervalId = setInterval(runSyncVotes, ZERO_DAY_SYNC_INTERVAL_MS);
        } else {
          if (zeroDaySyncIntervalId != null) {
            clearInterval(zeroDaySyncIntervalId);
            zeroDaySyncIntervalId = null;
          }
        }
      } catch (_) {}
    });
  }

  firebaseInitPromise.then(async (api) => {
    if (!api.ready || !api.getVotedForMonitor) return;
    await syncVotedFromFirestore();
    zeroDayVoteCurrentPage = 1;
    renderZeroDayVoteTable();
    subscribeVotedRealtime();
    const monitoringEnabled = api.getVoteMonitoringEnabled ? await api.getVoteMonitoringEnabled() : true;
    if (zeroDayMonitorVotesToggle) {
      zeroDayMonitorVotesToggle.checked = monitoringEnabled;
      zeroDayMonitorVotesToggle.setAttribute("aria-checked", monitoringEnabled ? "true" : "false");
    }
    if (monitoringEnabled) {
      if (zeroDaySyncIntervalId != null) clearInterval(zeroDaySyncIntervalId);
      zeroDaySyncIntervalId = setInterval(runSyncVotes, ZERO_DAY_SYNC_INTERVAL_MS);
    }
  }).catch(() => {});

  if (zeroDayVoteCardsContainer) {
    zeroDayVoteCardsContainer.addEventListener("click", (e) => {
      const copyCodeBtn = e.target.closest("[data-copy-monitor-code], [data-copy-monitor-code-for-box]");
      const copyLinkBtn = e.target.closest("[data-copy-monitor-link], [data-copy-monitor-link-for-box]");
      const viewVotedBtn = e.target.closest("[data-view-voted]");
      const viewNotYetBtn = e.target.closest("[data-view-not-yet]");
      const voteCardOpen = e.target.closest("[data-vote-card-ballot-open]");
      const voteCardClose = e.target.closest("[data-vote-card-ballot-close]");

      if (voteCardOpen || voteCardClose) {
        const boxKeyRaw =
          voteCardOpen?.getAttribute("data-vote-card-ballot-open") ||
          voteCardClose?.getAttribute("data-vote-card-ballot-close");
        const boxKeyCtl = (boxKeyRaw || "").trim();
        if (!boxKeyCtl) return;
        const wantOpen = !!voteCardOpen;
        let monitor = zeroDayMonitors.find((m) => (m.ballotBox || "").trim() === boxKeyCtl);
        if (!monitor) monitor = getOrEnsureMonitorForBallotBox(boxKeyCtl);
        void (async () => {
          const ok = await adminSetVoteMarkingSessionForMonitor(monitor, wantOpen);
          if (typeof window.showToast === "function") {
            window.showToast(
              ok
                ? wantOpen
                  ? "Vote marking opened for this ballot box."
                  : "Vote marking closed for this ballot box."
                : "Could not update vote marking session."
            );
          }
        })();
        return;
      }

      if (copyCodeBtn) {
        const idAttr = copyCodeBtn.getAttribute("data-copy-monitor-code");
        const boxAttr = copyCodeBtn.getAttribute("data-copy-monitor-code-for-box");
        if (idAttr) {
          copyMonitorAccessCodeOnly(Number(idAttr));
        } else if (boxAttr) {
          const m = getOrEnsureMonitorForBallotBox(boxAttr);
          copyMonitorAccessCodeOnly(m.id);
        }
        return;
      }
      if (copyLinkBtn) {
        const idAttr = copyLinkBtn.getAttribute("data-copy-monitor-link");
        const boxAttr = copyLinkBtn.getAttribute("data-copy-monitor-link-for-box");
        if (idAttr) {
          copyMonitorListUrlOnly(Number(idAttr));
        } else if (boxAttr) {
          const m = getOrEnsureMonitorForBallotBox(boxAttr);
          copyMonitorListUrlOnly(m.id);
        }
        return;
      }
      if (viewVotedBtn) {
        const box = viewVotedBtn.getAttribute("data-view-voted");
        if (box) openBoxVoterListModal(box, "voted");
        return;
      }
      if (viewNotYetBtn) {
        const box = viewNotYetBtn.getAttribute("data-view-not-yet");
        if (box) openBoxVoterListModal(box, "not-yet");
        return;
      }
    });
  }
}

const MONITOR_VIEW_PAGE_SIZE = 15;
const MONITOR_UNLOCK_STORAGE_PREFIX = "monitorUnlocked_";
let monitorViewCurrentPage = 1;

function getMonitorAccessCode(monitor) {
  const token = (monitor && monitor.shareToken) || "";
  const part = token.split("-")[1];
  return part || token;
}

export function initMonitorView(token, votersContextParam, options = {}) {
  const isRemote = options.remoteMonitor != null;
  const isBallotBoxOnly = !!(options.ballotBoxOnly && votersContextParam);
  const preventLocalMonitorFallback = options.preventLocalMonitorFallback === true;
  const monitoringDisabled = options.monitoringDisabled === true;
  /** ballot-box.html standalone page — professional copy and document title */
  const standaloneBallotPage = options.standaloneBallotPage === true;
  let monitor = options.remoteMonitor;
  let assignedVoters = [];
  /** Mutable array from ballot-box.html, or null when using shared `zeroDayVotedEntries` (admin / embedded). */
  let remoteVotedEntriesRef = options.remoteVotedEntries != null ? options.remoteVotedEntries : null;

  if (isBallotBoxOnly) {
    loadVotedEntries();
    const allVoters = votersContextParam.getAllVoters();
    const boxKey = (options.ballotBoxOnly || "").trim();
    assignedVoters = allVoters.filter(
      (v) => (v.ballotBox || v.island || "Unassigned").trim() === boxKey
    );
    monitor = { ballotBox: options.ballotBoxOnly, voterIds: assignedVoters.map((v) => v.id) };
  } else if (!isRemote) {
    if (preventLocalMonitorFallback) {
      monitor = null;
      assignedVoters = [];
    } else {
    loadMonitors();
    loadVotedEntries();
    monitor = zeroDayMonitors.find((m) => m.shareToken === token);
    const allVoters = (votersContextParam && votersContextParam.getAllVoters) ? votersContextParam.getAllVoters() : [];
    const voterIds = monitor ? (monitor.voterIds || []) : [];
    const voterIdsSet = new Set(voterIds.map((id) => String(id)));
    if (voterIdsSet.size > 0) {
      assignedVoters = allVoters.filter((v) => voterIdsSet.has(String(v.id)));
    } else if (monitor && monitor.ballotBox) {
      const boxKey = String(monitor.ballotBox || "").trim();
      assignedVoters = allVoters.filter(
        (v) => (v.ballotBox || v.island || "Unassigned").trim() === boxKey
      );
    } else {
      assignedVoters = [];
    }
    }
  } else {
    const voters = options.remoteMonitor.voters || [];
    assignedVoters = voters.map((v) => ({
      id: v.id,
      fullName: v.fullName || "",
      nationalId: v.nationalId || v.id || "",
      permanentAddress: v.permanentAddress || "",
      phone: v.phone || "",
      pledgeStatus: v.pledgeStatus || "undecided",
      volunteer: v.volunteer || "",
      sequence: v.sequence != null ? v.sequence : "",
    }));
  }

  if (isRemote && remoteVotedEntriesRef == null) {
    remoteVotedEntriesRef = [];
  }

  /** Always read current voted list — zeroDayVotedEntries is reassigned when admin syncs/clears votes. */
  function getVotedEntries() {
    return remoteVotedEntriesRef != null ? remoteVotedEntriesRef : zeroDayVotedEntries;
  }

  assignedVoters.sort(compareVotersByBallotSequenceThenName);

  loadMonitors();

  const monitorViewEl = document.getElementById("monitor-view");
  const gateEl = document.getElementById("monitor-view-gate");
  const contentEl = document.getElementById("monitor-view-content");
  const monitorViewTitle = document.getElementById("monitorViewTitle");
  const monitorViewSubtitle = document.getElementById("monitorViewSubtitle");
  const monitorViewSearch = document.getElementById("monitorViewSearch");
  const monitorViewSearchBtn = document.getElementById("monitorViewSearchBtn");
  const monitorViewResult = document.getElementById("monitorViewResult");

  if (!monitorViewEl) return;

  if (!monitor) {
    monitorViewEl.hidden = false;
    monitorViewEl.setAttribute("data-state", "invalid");
    const existingMsg = document.getElementById("monitor-view-invalid-msg");
    const invalidReason = options.invalidReason || (token ? "not_found" : "no_token");
    const messages = {
      no_token: {
        title: "No ballot box link",
        hint: "Open the ballot box using the full link shared by your Campaign Manager (it should include the access code).",
      },
      offline: {
        title: "Cannot reach campaign data",
        hint: "This ballot box link needs internet access to load monitor and voter records. Check your connection and try again.",
      },
      not_found: {
        title: "Link not found",
        hint: "No ballot box link was found in the campaign database for this address. Ask your Campaign Manager to open Zero Day → Manage Monitors in the main app while online, create/refresh the monitor for this ballot box, then share the new link and access code with you.",
      },
      default: {
        title: "Invalid or expired link",
        hint: "This ballot box link is not valid or has expired. Ask your Campaign Manager for a new link and access code.",
      },
    };
    const text = messages[invalidReason] || messages.default;
    if (standaloneBallotPage) {
      monitorViewEl.classList.add("monitor-view--standalone-ballot");
      document.title = "Vote marking · Link unavailable";
    }
    if (!existingMsg) {
      const msg = document.createElement("div");
      msg.id = "monitor-view-invalid-msg";
      msg.className = "monitor-view-gate";
      msg.setAttribute("role", "alert");
      msg.innerHTML = `
        <div class="monitor-view-gate__card">
          <h2 class="monitor-view-gate__title">${escapeHtml(text.title)}</h2>
          <p class="monitor-view-gate__hint">${escapeHtml(text.hint)}</p>
        </div>
      `;
      monitorViewEl.appendChild(msg);
    } else {
      const titleEl = existingMsg.querySelector(".monitor-view-gate__title");
      const hintEl = existingMsg.querySelector(".monitor-view-gate__hint");
      if (titleEl) titleEl.textContent = text.title;
      if (hintEl) hintEl.textContent = text.hint;
    }
    return;
  }

  if (!monitor.shareToken && token) monitor.shareToken = token;

  const invalidMsg = document.getElementById("monitor-view-invalid-msg");
  if (invalidMsg) invalidMsg.remove();

  if (standaloneBallotPage) {
    monitorViewEl.classList.add("monitor-view--standalone-ballot");
  }

  let ballotSessionStatus = "open";
  let ballotSessionPauseReason = "";
  let ballotSessionPausedAt = "";
  let ballotSessionUnsub = null;
  let ballotSessionApi = options.ballotSession || null;
  let pauseOverlayTimerId = null;
  let markVotedToastTimer = null;
  let markVotedToastHideTimer = null;
  let markVotedToastEl = null;
  let monitorWorkspaceOpened = false;
  let remoteVotedSnapshotUnsub = null;

  /** Local/admin monitor: zeroDayVotedEntries is reassigned when votes are cleared in Zero Day — refresh this UI. */
  function onVotedEntriesChangedFromAdmin() {
    renderMonitorViewHeader();
    updateMonitorSearchUi();
  }
  if (remoteVotedEntriesRef == null) {
    document.addEventListener("voted-entries-updated", onVotedEntriesChangedFromAdmin);
  }
  firebaseInitPromise
    .then((api) => {
      if (!token || remoteVotedEntriesRef == null || !api?.onVotedSnapshotForMonitor) return;
      remoteVotedSnapshotUnsub = api.onVotedSnapshotForMonitor(token, (entries) => {
        remoteVotedEntriesRef.length = 0;
        remoteVotedEntriesRef.push(...entries);
        renderMonitorViewHeader();
        updateMonitorSearchUi();
      });
    })
    .catch(() => {});

  function loadLocalBallotSession() {
    try {
      if (!token) return;
      const raw = localStorage.getItem(MONITOR_BALLOT_SESSION_PREFIX + token);
      if (!raw) {
        ballotSessionStatus = "open";
        ballotSessionPauseReason = "";
        ballotSessionPausedAt = "";
        return;
      }
      const s = JSON.parse(raw);
      ballotSessionStatus = s.status === "paused" || s.status === "closed" ? s.status : "open";
      ballotSessionPauseReason = String(s.pauseReason || "");
      ballotSessionPausedAt = String(s.pausedAt || "");
    } catch (_) {}
  }

  function saveLocalBallotSession() {
    try {
      if (!token) return;
      localStorage.setItem(
        MONITOR_BALLOT_SESSION_PREFIX + token,
        JSON.stringify({
          status: ballotSessionStatus,
          pauseReason: ballotSessionPauseReason,
          pausedAt: ballotSessionPausedAt,
        })
      );
    } catch (_) {}
  }

  async function ensureBallotSessionApi() {
    if (ballotSessionApi) return;
    if (!token) return;
    try {
      const api = await firebaseInitPromise;
      if (api && api.getBallotSessionFs) {
        ballotSessionApi = {
          get: () => api.getBallotSessionFs(token),
          set: (d) => api.setBallotSessionFs(token, d),
          subscribe: (cb) => api.onBallotSessionSnapshotFs(token, cb),
        };
      }
    } catch (_) {}
  }

  function getCurrentDisplayedVoter() {
    const vid = monitorViewResult?.querySelector("[data-voter-id]")?.getAttribute("data-voter-id");
    if (!vid) return null;
    return assignedVoters.find((x) => String(x.id) === String(vid)) || null;
  }

  function renderGateBallotSessionStatus() {
    const el = document.getElementById("monitorGateBallotSession");
    if (!el) return;
    const sess =
      ballotSessionStatus === "paused"
        ? "paused"
        : ballotSessionStatus === "closed"
          ? "closed"
          : "open";
    el.className =
      "monitor-view-gate__session-status monitor-view-gate__session-status--" + sess;
    el.hidden = false;
    if (sess === "open") {
      el.innerHTML =
        "<strong>Live session:</strong> Open — vote marking is allowed for everyone using this link.";
    } else if (sess === "paused") {
      const r = ballotSessionPauseReason.trim() || "—";
      el.innerHTML =
        "<strong>Live session: Paused</strong> — search and marking stay on hold until the session is opened. Reason: " +
        escapeHtml(r);
    } else {
      el.innerHTML =
        "<strong>Live session: Closed</strong> — marking is disabled for this link until someone opens the session.";
    }
  }

  /** Gate shows live Firestore session; workspace shows bar, header, overlay, search. */
  function syncBallotSessionUi() {
    renderGateBallotSessionStatus();
    if (monitorViewEl.getAttribute("data-state") !== "list") return;
    renderBallotSessionBar();
    renderMonitorViewHeader();
    renderPauseOverlay();
    updateMonitorSearchUi();
    const v = getCurrentDisplayedVoter();
    if (v && !standaloneBallotPage) renderMonitorViewResult(v);
  }

  function applyBallotSessionState(state, opts = {}) {
    if (!state) return;
    const skipLocal = opts.skipLocalPersistence === true;
    ballotSessionStatus =
      state.status === "paused" || state.status === "closed" ? state.status : "open";
    ballotSessionPauseReason = String(state.pauseReason || "");
    ballotSessionPausedAt = String(state.pausedAt || "");
    if (token && !skipLocal) saveLocalBallotSession();
    syncBallotSessionUi();
  }

  /** One shared init + listener per monitor view; concurrent awaiters join the same promise. */
  let ballotSessionInitPromise = null;

  async function initBallotSessionSubscription() {
    if (ballotSessionInitPromise) {
      await ballotSessionInitPromise;
      syncBallotSessionUi();
      return;
    }
    ballotSessionInitPromise = (async () => {
      await ensureBallotSessionApi();
      if (ballotSessionUnsub) {
        ballotSessionUnsub();
        ballotSessionUnsub = null;
      }
      if (ballotSessionApi) {
        try {
          const initial = await ballotSessionApi.get();
          applyBallotSessionState(initial);
        } catch (err) {
          console.warn("[Monitor] ballot session initial load failed", err?.message || err);
          // Do not load localStorage here — it often still says "open" from an old visit while
          // Firestore already has paused/closed. Wait for the snapshot listener to deliver truth.
          applyBallotSessionState(
            { status: "open", pauseReason: "", pausedAt: "" },
            { skipLocalPersistence: true }
          );
        }
        ballotSessionUnsub = ballotSessionApi.subscribe((state) => {
          applyBallotSessionState(state);
        });
      } else {
        loadLocalBallotSession();
        applyBallotSessionState({
          status: ballotSessionStatus,
          pauseReason: ballotSessionPauseReason,
          pausedAt: ballotSessionPausedAt,
        });
      }
    })();
    await ballotSessionInitPromise;
    syncBallotSessionUi();
  }

  async function persistBallotSession(status, pauseReason) {
    const nowIso = new Date().toISOString();
    const st = status === "paused" || status === "closed" ? status : "open";
    const resolvedPauseReason = st === "paused" ? String(pauseReason || "") : "";
    const resolvedPausedAt = st === "paused" ? nowIso : "";
    const applyResolved = () => {
      applyBallotSessionState({
        status: st,
        pauseReason: resolvedPauseReason,
        pausedAt: resolvedPausedAt,
      });
      saveLocalBallotSession();
    };
    if (ballotSessionApi) {
      try {
        await ballotSessionApi.set({
          status,
          pauseReason: status === "paused" ? pauseReason : "",
          pausedAt: status === "paused" ? nowIso : "",
        });
        // Apply immediately so UI updates even if the snapshot listener is slow or misconfigured.
        applyResolved();
      } catch (e) {
        console.warn("[Monitor] ballot session save failed", e);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not sync session to the server",
            meta: String(
              e?.message ||
                e ||
                "Session updated on this device only. Check network and Firestore rules for monitors/.../ballotSession."
            ),
          });
        }
        // Still apply locally so Open / Pause / Close keep working offline or when rules fail.
        applyResolved();
      }
      return;
    }
    ballotSessionStatus = status === "paused" || status === "closed" ? status : "open";
    ballotSessionPauseReason = ballotSessionStatus === "paused" ? String(pauseReason || "") : "";
    ballotSessionPausedAt = ballotSessionStatus === "paused" ? nowIso : "";
    saveLocalBallotSession();
    applyBallotSessionState({
      status: ballotSessionStatus,
      pauseReason: ballotSessionPauseReason,
      pausedAt: ballotSessionPausedAt,
    });
  }

  async function openBallotSession() {
    await persistBallotSession("open", "");
  }

  async function closeBallotSession() {
    await persistBallotSession("closed", "");
  }

  function ensureMonitorWorkArea() {
    if (!contentEl) return null;
    let wrap = document.getElementById("monitor-view-work-area");
    if (wrap) return wrap;
    const bar = document.getElementById("monitor-view-session-bar");
    const header = contentEl.querySelector(".monitor-view__header");
    const toolbar = contentEl.querySelector(".monitor-view__toolbar");
    const result = document.getElementById("monitorViewResult");
    if (!header || !toolbar || !result) return null;
    wrap = document.createElement("div");
    wrap.id = "monitor-view-work-area";
    wrap.className = "monitor-view-work-area";
    if (bar) bar.after(wrap);
    else contentEl.insertBefore(wrap, header);
    wrap.appendChild(header);
    wrap.appendChild(toolbar);
    wrap.appendChild(result);
    return wrap;
  }

  function attachSlideToOpen(overlayEl) {
    const track = overlayEl.querySelector("[data-slide-track]");
    const thumb = overlayEl.querySelector("[data-slide-thumb]");
    if (!track || !thumb) return;

    const pad = 6;

    function maxOffset() {
      return Math.max(0, track.clientWidth - 2 * pad - thumb.clientWidth);
    }

    function clamp(v) {
      const m = maxOffset();
      return Math.max(0, Math.min(m, v));
    }

    function offsetFromClientX(clientX) {
      const rect = track.getBoundingClientRect();
      const x = clientX - rect.left - pad - thumb.clientWidth / 2;
      return clamp(x);
    }

    function setThumbOffset(o) {
      thumb.style.transform = `translate(${pad + o}px, -50%)`;
    }

    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);

      function onMove(ev) {
        ev.preventDefault();
        const o = offsetFromClientX(ev.clientX);
        setThumbOffset(o);
      }

      function onUp(ev) {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        try {
          thumb.releasePointerCapture(e.pointerId);
        } catch (_) {}
        const o = offsetFromClientX(ev.clientX);
        const m = maxOffset();
        if (m > 0 && o / m >= 0.88) {
          void openBallotSession();
        } else {
          setThumbOffset(0);
        }
      }

      document.addEventListener("pointermove", onMove, { passive: false });
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    });
  }

  function clearPauseOverlayTimer() {
    if (pauseOverlayTimerId != null) {
      clearInterval(pauseOverlayTimerId);
      pauseOverlayTimerId = null;
    }
  }

  function formatPauseElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function startPauseOverlayTimer(overlay) {
    clearPauseOverlayTimer();
    const el = overlay.querySelector("[data-pause-timer]");
    if (!el) return;
    const tick = () => {
      const t0 = ballotSessionPausedAt ? new Date(ballotSessionPausedAt).getTime() : Date.now();
      if (Number.isNaN(t0)) {
        el.textContent = "—";
        return;
      }
      el.textContent = formatPauseElapsed(Date.now() - t0);
    };
    tick();
    pauseOverlayTimerId = setInterval(tick, 1000);
  }

  function renderPauseOverlay() {
    const existing = document.getElementById("monitor-pause-overlay");
    if (!contentEl || monitoringDisabled) {
      existing?.remove();
      clearPauseOverlayTimer();
      return;
    }
    if (ballotSessionStatus !== "paused") {
      existing?.remove();
      clearPauseOverlayTimer();
      return;
    }
    const wrap = standaloneBallotPage ? null : ensureMonitorWorkArea();
    if (!standaloneBallotPage && !wrap) return;

    let overlay = document.getElementById("monitor-pause-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "monitor-pause-overlay";
    }
    const parentEl = standaloneBallotPage ? document.body : wrap;
    parentEl.appendChild(overlay);

    const pausedAtDisplay = ballotSessionPausedAt
      ? formatDateTime(ballotSessionPausedAt)
      : "—";
    const reasonDisplay =
      ballotSessionPauseReason.trim() || "—";
    overlay.className =
      "monitor-pause-overlay" +
      (standaloneBallotPage ? " monitor-pause-overlay--fullscreen" : "");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "monitorPauseOverlayTitle");
    const openControlsHtml = `
        <div class="monitor-slide-open" aria-label="Slide to resume vote marking">
          <div class="monitor-slide-open__track" data-slide-track>
            <span class="monitor-slide-open__hint">Slide to resume →</span>
            <div class="monitor-slide-open__thumb" data-slide-thumb role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Slide to resume marking"></div>
          </div>
        </div>
        <button type="button" class="monitor-pause-overlay__open-btn" data-pause-open-btn>Resume vote marking</button>
      `;
    overlay.innerHTML = `
      <div class="monitor-pause-overlay__backdrop"></div>
      <div class="monitor-pause-overlay__card">
        <h2 id="monitorPauseOverlayTitle" class="monitor-pause-overlay__title">Ballot box paused</h2>
        <div class="monitor-pause-overlay__timer-wrap">
          <span class="monitor-pause-overlay__timer-label">Time paused</span>
          <div class="monitor-pause-overlay__timer" data-pause-timer aria-live="polite">00:00</div>
        </div>
        <p class="monitor-pause-overlay__line"><span class="monitor-pause-overlay__label">Paused at</span> ${escapeHtml(pausedAtDisplay)}</p>
        <p class="monitor-pause-overlay__line monitor-pause-overlay__reason"><span class="monitor-pause-overlay__label">Reason</span> ${escapeHtml(reasonDisplay)}</p>
        ${openControlsHtml}
      </div>
    `;
    overlay.querySelector("[data-pause-open-btn]")?.addEventListener("click", () => void openBallotSession());
    attachSlideToOpen(overlay);
    startPauseOverlayTimer(overlay);
  }

  function pauseBallotSessionModal() {
    const wrap = document.createElement("div");
    wrap.className = "monitor-pause-modal__body";
    const label = document.createElement("label");
    label.textContent = "Reason for pause";
    label.setAttribute("for", "monitorPauseReasonInput");
    const ta = document.createElement("textarea");
    ta.id = "monitorPauseReasonInput";
    ta.className = "monitor-pause-modal__textarea";
    ta.rows = 3;
    ta.placeholder = "Enter why voting is paused (shown to monitors).";
    wrap.appendChild(label);
    wrap.appendChild(ta);
    const footerDiv = document.createElement("div");
    footerDiv.className = "modal-footer-row";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost-button";
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "monitor-session-bar__btn monitor-session-bar__btn--pause";
    saveBtn.textContent = "Pause & save";
    cancelBtn.addEventListener("click", () => closeModal());
    saveBtn.addEventListener("click", async () => {
      const reason = (ta.value || "").trim();
      closeModal();
      await persistBallotSession("paused", reason || "Paused");
    });
    footerDiv.appendChild(cancelBtn);
    footerDiv.appendChild(saveBtn);
    openModal({ title: "Pause ballot box", body: wrap, footer: footerDiv, hideMaximize: true });
  }

  function renderBallotSessionBar() {
    if (!contentEl || monitoringDisabled) return;
    let bar = document.getElementById("monitor-view-session-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "monitor-view-session-bar";
      bar.className = "monitor-session-bar";
    }
    const header = contentEl.querySelector(".monitor-view__header");
    if (header && header.parentNode) {
      header.insertAdjacentElement("afterend", bar);
    } else if (!bar.parentNode) {
      contentEl.insertBefore(bar, contentEl.firstChild);
    }
    const statusLabel =
      ballotSessionStatus === "open"
        ? "Open"
        : ballotSessionStatus === "paused"
          ? "Paused"
          : "Closed";
    const pauseBanner =
      ballotSessionStatus === "closed"
        ? `<div class="monitor-session-bar__pause-banner monitor-session-bar__pause-banner--closed" role="status">Ballot box is closed. Marking is disabled.</div>`
        : "";
    const openDisabled = ballotSessionStatus === "open";
    const pauseDisabled = ballotSessionStatus !== "open";
    const closeDisabled = ballotSessionStatus === "closed";
    const iconOpen = `<svg class="monitor-session-bar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4V8z" fill="currentColor" stroke="none"/></svg>`;
    const iconPause = `<svg class="monitor-session-bar__icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
    const iconClose = `<svg class="monitor-session-bar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    const iconHistory = `<svg class="monitor-session-bar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>`;
    const closeBtnHtml = standaloneBallotPage
      ? ""
      : `<button type="button" class="monitor-session-bar__btn monitor-session-bar__btn--close monitor-session-bar__btn--icon" data-session-action="close" aria-label="Close session"${
          closeDisabled ? ' disabled title="Already closed"' : ' title="Close marking for this session"'
        }>${iconClose}</button>`;
    const openBtnHtml = standaloneBallotPage
      ? ""
      : `<button type="button" class="monitor-session-bar__btn monitor-session-bar__btn--open monitor-session-bar__btn--icon" data-session-action="open" aria-label="Open session"${
          openDisabled
            ? " disabled title=\"Session is already open\""
            : ' title="Resume marking (after pause or close)"'
        }>${iconOpen}</button>`;
    bar.innerHTML = `
      <div class="monitor-session-bar__controls">
        <span class="monitor-session-bar__status">Session: <strong>${escapeHtml(statusLabel)}</strong></span>
        <div class="monitor-session-bar__buttons monitor-session-bar__buttons--icons">
          ${openBtnHtml}
          <button type="button" class="monitor-session-bar__btn monitor-session-bar__btn--pause monitor-session-bar__btn--icon" data-session-action="pause" aria-label="Pause session"${
            pauseDisabled
              ? ` disabled title="${ballotSessionStatus === "paused" ? "Already paused" : ballotSessionStatus === "closed" ? "Open the session first" : ""}"`
              : ' title="Pause with a reason"'
          }>${iconPause}</button>
          ${closeBtnHtml}
          <button type="button" class="monitor-session-bar__btn monitor-session-bar__btn--history monitor-session-bar__btn--icon" data-session-action="history" aria-label="Voters marked voted" title="Voters marked voted from this link">${iconHistory}</button>
        </div>
      </div>
      ${pauseBanner}
    `;
    bar.querySelectorAll("[data-session-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-session-action");
        if (action === "open") void openBallotSession();
        if (action === "pause") void pauseBallotSessionModal();
        if (action === "close") void closeBallotSession();
        if (action === "history") openVotedHistoryModal();
      });
    });
  }

  function openVotedHistoryModal() {
    const sorted = [...getVotedEntries()].sort((a, b) => {
      const ta = new Date(a.timeMarked || 0).getTime();
      const tb = new Date(b.timeMarked || 0).getTime();
      return tb - ta;
    });
    const rowsHtml = sorted
      .map((e) => {
        const vv = assignedVoters.find((x) => sameVoterId(x.id, e.voterId));
        const seq = vv ? sequenceAsImportedFromCsv(vv) : "";
        const name = vv ? vv.fullName || "" : "(unknown)";
        const idPart = vv ? vv.nationalId || vv.id || "" : String(e.voterId);
        const addr = vv ? vv.permanentAddress || "" : "";
        const t = e.timeMarked ? formatDateTime(e.timeMarked) : "";
        return `<tr><td>${escapeHtml(t)}</td><td>${escapeHtml(String(seq))}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(String(idPart))}</td><td>${escapeHtml(addr)}</td></tr>`;
      })
      .join("");
    const body = document.createElement("div");
    body.className = "monitor-voted-history";
    body.innerHTML =
      sorted.length > 0
        ? `<div class="monitor-voted-history__scroll"><table class="monitor-voted-history__table"><thead><tr><th>Time</th><th>Seq</th><th>Name</th><th>ID</th><th>Permanent address</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`
        : `<p class="monitor-voted-history__empty">No voters marked voted yet.</p>`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "primary-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => closeModal());
    const footerDiv = document.createElement("div");
    footerDiv.className = "modal-footer-row";
    footerDiv.appendChild(closeBtn);
    openModal({
      title: "Voters marked voted",
      body,
      footer: footerDiv,
      dialogClass: "modal--wide",
    });
  }

  function canMarkVoted() {
    return !monitoringDisabled && ballotSessionStatus === "open";
  }

  /** Search / toolbar follow the same rules as marking: only when session is open and monitoring is on. */
  function updateMonitorSearchUi() {
    const allow = canMarkVoted();
    if (monitorViewSearch) {
      monitorViewSearch.disabled = !allow;
      monitorViewSearch.classList.toggle("monitor-view__search--session-blocked", !allow);
    }
    if (monitorViewSearchBtn) {
      monitorViewSearchBtn.disabled = !allow;
      monitorViewSearchBtn.classList.toggle("monitor-toolbar__btn--session-blocked", !allow);
    }
    const toolbar = contentEl?.querySelector(".monitor-view__toolbar");
    if (toolbar) toolbar.classList.toggle("monitor-view__toolbar--session-blocked", !allow);
  }

  function clearStandaloneStrip() {
    const strip = document.getElementById("monitorStandaloneStrip");
    if (!strip) return;
    strip.innerHTML = "";
    strip.hidden = true;
    strip.className = "monitor-standalone-strip";
  }

  function hideMarkVotedToast() {
    if (markVotedToastTimer) clearInterval(markVotedToastTimer);
    markVotedToastTimer = null;
    if (markVotedToastHideTimer) clearTimeout(markVotedToastHideTimer);
    markVotedToastHideTimer = null;
    if (markVotedToastEl) {
      markVotedToastEl.remove();
      markVotedToastEl = null;
    }
    clearStandaloneStrip();
  }

  function attachMarkVotedToastTimers(rootEl, opts = {}) {
    const durationMs =
      typeof opts.durationMs === "number" && opts.durationMs > 0 ? opts.durationMs : 10000;
    const showCountdown = opts.showCountdown !== false;
    const countdownEl = rootEl.querySelector("[data-toast-countdown]");
    if (showCountdown && countdownEl) {
      let sec = Math.max(1, Math.ceil(durationMs / 1000));
      countdownEl.textContent = String(sec);
      markVotedToastTimer = setInterval(() => {
        sec -= 1;
        if (countdownEl) countdownEl.textContent = String(Math.max(0, sec));
        if (sec <= 0) hideMarkVotedToast();
      }, 1000);
    }
    markVotedToastHideTimer = setTimeout(() => hideMarkVotedToast(), durationMs);
  }

  const undoIconSvg = `<svg class="monitor-standalone-strip__undo-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></svg>`;

  /** @param undoVoterId Same id written to voted entries / Firestore (required for undo to match). */
  function showMarkVotedToast(voter, undoVoterId) {
    hideMarkVotedToast();
    const seq = sequenceAsImportedFromCsv(voter);
    const id = voter.nationalId || voter.id || "";
    const addr = voter.permanentAddress || "";
    const undoKey =
      undoVoterId != null && String(undoVoterId).trim() !== ""
        ? undoVoterId
        : voter.nationalId || voter.id;
    if (standaloneBallotPage) {
      const strip = document.getElementById("monitorStandaloneStrip");
      if (!strip) return;
      strip.hidden = false;
      strip.className = "monitor-standalone-strip monitor-standalone-strip--success";
      const line =
        escapeHtml(voter.fullName || "") +
        " · " +
        escapeHtml(String(id)) +
        " · " +
        escapeHtml(addr);
      strip.innerHTML = `
      <div class="monitor-standalone-strip__inner">
        <p class="monitor-standalone-strip__line">${line}</p>
        <div class="monitor-standalone-strip__actions">
          <button type="button" class="monitor-standalone-strip__undo" data-toast-undo aria-label="Undo mark voted" title="Undo mark voted">${undoIconSvg}</button>
        </div>
        <span class="monitor-standalone-strip__timer" aria-live="polite"><span data-toast-countdown>10</span>s</span>
      </div>
    `;
      markVotedToastEl = null;
      attachMarkVotedToastTimers(strip);
      strip.querySelector("[data-toast-undo]")?.addEventListener("click", async () => {
        hideMarkVotedToast();
        await undoMarkVoted(undoKey);
      });
      return;
    }

    const el = document.createElement("div");
    el.className = "monitor-mark-voted-toast";
    el.setAttribute("role", "status");
    el.innerHTML = `
      <div class="monitor-mark-voted-toast__inner">
        <div class="monitor-mark-voted-toast__title">Marked as voted</div>
        <div class="monitor-mark-voted-toast__row"><span>Seq</span><strong>${escapeHtml(String(seq))}</strong></div>
        <div class="monitor-mark-voted-toast__row"><span>Name</span><strong>${escapeHtml(voter.fullName || "")}</strong></div>
        <div class="monitor-mark-voted-toast__row"><span>ID</span><strong>${escapeHtml(String(id))}</strong></div>
        <div class="monitor-mark-voted-toast__row"><span>Address</span><strong>${escapeHtml(addr)}</strong></div>
        <div class="monitor-mark-voted-toast__actions monitor-mark-voted-toast__actions--icons">
          <button type="button" class="monitor-session-bar__btn monitor-session-bar__btn--undo monitor-session-bar__btn--icon" data-toast-undo aria-label="Undo mark voted" title="Undo mark voted">
            <svg class="monitor-session-bar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></svg>
          </button>
          <button type="button" class="monitor-session-bar__btn monitor-session-bar__btn--dismiss monitor-session-bar__btn--icon" data-toast-dismiss aria-label="Dismiss" title="Dismiss">
            <svg class="monitor-session-bar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="monitor-mark-voted-toast__timer" aria-live="polite"><span data-toast-countdown>10</span>s</div>
      </div>
    `;
    const mount = monitorViewEl || document.body;
    mount.appendChild(el);
    markVotedToastEl = el;
    attachMarkVotedToastTimers(el);
    el.querySelector("[data-toast-undo]")?.addEventListener("click", async () => {
      hideMarkVotedToast();
      await undoMarkVoted(undoKey);
    });
    el.querySelector("[data-toast-dismiss]")?.addEventListener("click", () => hideMarkVotedToast());
  }

  async function undoMarkVoted(voterId) {
    const ve = getVotedEntries();
    const idx = ve.findIndex((e) => sameVoterId(e.voterId, voterId));
    if (idx >= 0) ve.splice(idx, 1);
    if (options.onDeleteVoted) {
      await options.onDeleteVoted(token, voterId).catch(() => {});
    } else {
      try {
        const api = await firebaseInitPromise;
        if (api.deleteVotedForMonitor) await api.deleteVotedForMonitor(token, voterId);
      } catch (_) {}
    }
    if (!isRemote) saveVotedEntries();
    if (isRemote && options.onRefreshVoted) await options.onRefreshVoted().catch(() => {});
    renderMonitorViewHeader();
    const v = findAssignedVoterForMark(voterId);
    if (v && monitorViewResult && !standaloneBallotPage) renderMonitorViewResult(v);

    try {
      const api = await firebaseInitPromise;
      if (api?.clearVoterVotedAtFs) await api.clearVoterVotedAtFs(voterId).catch(() => {});
    } catch (_) {}

    notifyVotedEntriesUpdated();
    renderZeroDayVoteTable();
  }

  if (isBallotBoxOnly) {
    monitorViewEl.setAttribute("data-state", "list");
    void (async () => {
      await initBallotSessionSubscription();
      await showMonitorContent();
      const header = monitorViewEl.querySelector(".monitor-view__header");
      if (header && typeof options.onClose === "function") {
        const existingBack = header.querySelector("[data-monitor-back]");
        if (existingBack) existingBack.remove();
        const backBtn = document.createElement("button");
        backBtn.type = "button";
        backBtn.className = "ghost-button ghost-button--small";
        backBtn.setAttribute("data-monitor-back", "true");
        backBtn.textContent = "Back to Vote Marking";
        backBtn.addEventListener("click", () => options.onClose());
        header.insertBefore(backBtn, header.firstChild);
      }
    })();
    return;
  }

  monitorViewEl.setAttribute("data-state", "gate");

  function searchVoters(query) {
    const q = (query || "").trim();
    if (!q) return [];

    // Exact match by ID / National ID / ballot-box sequence (as imported / stored)
    const exact = assignedVoters.find((v) => {
      const qt = q.trim();
      const seqDisplay = String(sequenceAsImportedFromCsv(v)).trim();
      return (
        String(v.id || "").toLowerCase() === q.toLowerCase() ||
        String(v.nationalId || "").toLowerCase() === q.toLowerCase() ||
        seqDisplay === qt
      );
    });
    if (exact) return [exact];

    // Fuzzy match by name: contains query (case-insensitive)
    const qLower = q.toLowerCase();
    const byName = assignedVoters.filter((v) =>
      String(v.fullName || "").toLowerCase().includes(qLower)
    );
    return byName;
  }

  function getAgent(v) {
    const name =
      v.volunteer != null
        ? v.volunteer
        : (pledgeContextRef && typeof pledgeContextRef.getPledges === "function"
            ? (pledgeContextRef.getPledges().find((r) => r.voterId === v.id) || {})
                .volunteer || ""
            : "");

    if (!name) return { label: "", phone: "" };

    let phone = "";
    try {
      const agents = typeof getAgents === "function" ? getAgents() : [];
      const match = agents.find(
        (a) => a && a.name && a.name.toLowerCase() === name.toLowerCase()
      );
      if (match && match.phone) phone = match.phone;
    } catch (_) {
      // fall back to name only if anything goes wrong
    }

    // Fallback: for remote/monitor links where agents list isn't available in this browser,
    // use the monitor's mobile number if present.
    if (!phone && monitor && monitor.mobile) {
      phone = monitor.mobile;
    }

    const label = phone ? `${name} • ${phone}` : name;
    return { label, phone };
  }

  let monitorViewStartedAt = null;

  function renderMonitorViewHeader() {
    const header = monitorViewEl.querySelector(".monitor-view__header");
    if (!header) return;
    const backBtn = header.querySelector("[data-monitor-back]");
    if (!monitorViewStartedAt) monitorViewStartedAt = new Date().toISOString();
    const fragment = document.createDocumentFragment();
    if (backBtn) fragment.appendChild(backBtn);
    const main = document.createElement("div");
    main.className =
      "monitor-view__header-main" +
      (standaloneBallotPage ? " monitor-view__header-main--standalone" : "");
    const subtitleText = "Search by name, ID, or ballot-box sequence (as shown).";
    const titleEscaped = escapeHtml(monitor.ballotBox || "Ballot box");
    const subtitleEscaped = escapeHtml(subtitleText);

    if (standaloneBallotPage) {
      const total = assignedVoters.length;
      const voted = getVotedEntries().length;
      const pct = total > 0 ? Math.min(100, Math.round((voted / total) * 100)) : 0;
      main.innerHTML =
        '<div class="ballot-dash-head">' +
        '<div class="ballot-dash-head__titles">' +
        '<h1 id="monitorViewTitle" class="monitor-view__title ballot-dash-title">' +
        titleEscaped +
        "</h1>" +
        "</div>" +
        '<div class="ballot-dash-progress-row">' +
        '<div class="ballot-dash-progress">' +
        '<div class="ballot-dash-progress__track">' +
        '<div class="ballot-dash-progress__fill" style="width:' +
        pct +
        '%"></div>' +
        "</div>" +
        '<span class="ballot-dash-progress__text">' +
        escapeHtml(String(voted)) +
        " / " +
        escapeHtml(String(total)) +
        " voted (" +
        escapeHtml(String(pct)) +
        "%)</span>" +
        "</div>" +
        "</div>" +
        "</div>";
    } else {
      main.innerHTML =
        "<h1 id=\"monitorViewTitle\" class=\"monitor-view__title\">" +
        titleEscaped +
        "</h1>" +
        "<div class=\"monitor-view__header-stats\">" +
        "<span class=\"monitor-view__stat\"><strong>Started:</strong> " +
        escapeHtml(formatDateTime(monitorViewStartedAt)) +
        "</span>" +
        "<span class=\"monitor-view__stat\"><strong>Voters:</strong> " +
        String(assignedVoters.length) +
        "</span>" +
        "<span class=\"monitor-view__stat\"><strong>Session:</strong> " +
        (ballotSessionStatus === "open"
          ? "Open"
          : ballotSessionStatus === "paused"
            ? "Paused"
            : "Closed") +
        "</span>" +
        "<span class=\"monitor-view__stat\"><strong>Voted:</strong> " +
        String(getVotedEntries().length) +
        "</span>" +
        "</div>" +
        "<p class=\"monitor-view__subtitle\" id=\"monitorViewSubtitle\">" +
        subtitleEscaped +
        "</p>";
    }
    fragment.appendChild(main);
    header.innerHTML = "";
    header.appendChild(fragment);
    if (standaloneBallotPage && typeof document !== "undefined") {
      const box = String(monitor.ballotBox || "").trim();
      const namePart = String(monitor.name || "").trim();
      const label = box || namePart || "Vote marking";
      document.title = `${label} · Vote marking`;
    }
  }

  function findAssignedVoterForMark(voterId) {
    return (
      assignedVoters.find((x) => sameVoterId(x.id, voterId)) ||
      assignedVoters.find((x) => sameVoterId(x.nationalId, voterId))
    );
  }

  function markVoterVoted(voterId) {
    const timeMarked = new Date().toISOString();
    const ve = getVotedEntries();
    const idx = ve.findIndex((e) => sameVoterId(e.voterId, voterId));
    if (idx >= 0) ve[idx].timeMarked = timeMarked;
    else ve.push({ voterId, timeMarked });

    const v = findAssignedVoterForMark(voterId);

    // When the monitor view is opened inside the admin app, `isRemote` can be false.
    // Still write to Firestore so "Vote Marking Ballot Box" cards update across refresh/devices.
    if (options.onSaveVoted) {
      options.onSaveVoted(token, voterId, timeMarked).catch(() => {});
    } else {
      void firebaseInitPromise
        .then((api) => {
          if (!api?.ready) return;
          if (api.setVotedForMonitor)
            api.setVotedForMonitor(token, voterId, timeMarked).catch(() => {});
          const staff = api.auth && api.auth.currentUser;
          if (staff && api.setVoterVotedAtFs)
            api.setVoterVotedAtFs(voterId, timeMarked).catch(() => {});
        })
        .catch(() => {});
    }

    if (!isRemote) saveVotedEntries();
    renderMonitorViewHeader();
    if (v && monitorViewResult && !standaloneBallotPage) renderMonitorViewResult(v);
    const toastVoter =
      v ||
      (() => {
        const idStr = String(voterId || "").trim();
        return idStr
          ? {
              id: voterId,
              nationalId: voterId,
              fullName: "",
              permanentAddress: "",
            }
          : null;
      })();
    if (toastVoter) showMarkVotedToast(toastVoter, voterId);

    // Refresh card grid on the admin page for immediate feedback.
    renderZeroDayVoteTable();
  }

  function renderMonitorNotFound(query) {
    if (!monitorViewResult) return;
    const q = (query || "").trim();
    const rowHtml = q
      ? `<div class="monitor-view-result-notice__row"><span>Seq / ID</span><strong>${escapeHtml(q)}</strong></div>`
      : "";
    monitorViewResult.innerHTML = `
      <div class="monitor-view-result-notice monitor-view-result-notice--error" role="status">
        <div class="monitor-view-result-notice__title">No voter found</div>
        ${rowHtml}
        <p class="monitor-view-result-notice__hint">No match for that ID or ballot-box sequence. Please check and try again.</p>
      </div>
    `;
    if (monitorViewSearch) monitorViewSearch.value = "";
  }

  function renderMonitorViewResult(voterOrNull) {
    if (!monitorViewResult) return;
    if (standaloneBallotPage) {
      if (!voterOrNull) {
        monitorViewResult.innerHTML = "";
        return;
      }
      monitorViewResult.innerHTML = "";
      return;
    }
    const pledgeLabel = (s) => (s === "yes" ? "Yes" : s === "no" ? "No" : "Undecided");
    const pledgePillClass = (s) =>
      s === "yes" ? "pledge-pill pledge-pill--pledged" : s === "no" ? "pledge-pill pledge-pill--not-pledged" : "pledge-pill pledge-pill--undecided";

    if (!voterOrNull) {
      renderMonitorNotFound("");
      return;
    }

    const voter = voterOrNull;
    const timeMarked = getVotedEntries().find((e) => sameVoterId(e.voterId, voter.id))?.timeMarked;
    const agent = getAgent(voter);

    monitorViewResult.innerHTML = `
      <div class="monitor-voter-card" data-voter-id="${escapeHtml(voter.id)}">
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">Name</span>
          <span class="monitor-voter-card__value">${escapeHtml(voter.fullName || "")}</span>
        </div>
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">ID Number</span>
          <span class="monitor-voter-card__value">${escapeHtml(voter.nationalId || voter.id || "")}</span>
        </div>
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">Sequence</span>
          <span class="monitor-voter-card__value">${escapeHtml(String(sequenceAsImportedFromCsv(voter)))}</span>
        </div>
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">Permanent Address</span>
          <span class="monitor-voter-card__value">${escapeHtml(voter.permanentAddress || "")}</span>
        </div>
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">Mobile</span>
          <span class="monitor-voter-card__value">${escapeHtml(voter.phone || "")}</span>
        </div>
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">Agent</span>
          <span class="monitor-voter-card__value">${escapeHtml(agent.label || "")}</span>
        </div>
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">Pledge</span>
          <span class="monitor-voter-card__value"><span class="${pledgePillClass(voter.pledgeStatus || "undecided")}">${pledgeLabel(voter.pledgeStatus || "undecided")}</span></span>
        </div>
        <div class="monitor-voter-card__row">
          <span class="monitor-voter-card__label">Vote status</span>
          <span class="monitor-voter-card__value">${timeMarked ? '<span class="pledge-pill pledge-pill--pledged">Voted</span> ' + formatDateTime(timeMarked) : '<span class="pledge-pill pledge-pill--undecided">Not voted</span>'}</span>
        </div>
        ${canMarkVoted() && !timeMarked ? `<div class="monitor-voter-card__action"><button type="button" class="monitor-mark-voted-icon-btn" data-monitor-mark-voted="${escapeHtml(voter.id)}" aria-label="Mark as voted" title="Mark as voted"><svg class="monitor-mark-voted-icon-btn__svg" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg></button></div>` : ""}
      </div>
    `;

    if (canMarkVoted()) {
      monitorViewResult.querySelector("[data-monitor-mark-voted]")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-monitor-mark-voted]");
        const vid = btn?.getAttribute("data-monitor-mark-voted");
        if (vid) markVoterVoted(vid);
      });
    }
  }

  function renderStandaloneMultiPick(matches) {
    if (!monitorViewResult) return;
    const rowsHtml = matches
      .slice(0, 25)
      .map((v) => {
        const idPart = v.nationalId || v.id || "";
        const addr = v.permanentAddress || "";
        const line = [v.fullName || "", idPart, addr]
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .join(" · ");
        return `<button type="button" class="monitor-view-result__match monitor-view-result__match--oneline" data-standalone-mark-id="${escapeHtml(
          v.id
        )}">${escapeHtml(line || v.fullName || idPart || "")}</button>`;
      })
      .join("");
    monitorViewResult.innerHTML = `
      <p class="monitor-view-result__hint" role="status">Several voters match—tap the correct row to mark voted, or narrow your entry.</p>
      <div class="monitor-view-result__list monitor-view-result__list--compact" role="list">${rowsHtml}</div>
    `;
    monitorViewResult.querySelectorAll("[data-standalone-mark-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!canMarkVoted()) return;
        const id = btn.getAttribute("data-standalone-mark-id");
        const v = assignedVoters.find((x) => String(x.id) === String(id));
        if (!v) return;
        const timeMarked = getVotedEntries().find((e) => sameVoterId(e.voterId, v.id))?.timeMarked;
        if (timeMarked) {
          renderStandaloneFeedback("That voter is already marked as voted.");
          return;
        }
        markVoterVoted(v.id);
        if (monitorViewSearch) monitorViewSearch.value = "";
        monitorViewResult.innerHTML = "";
      });
    });
  }

  function renderStandaloneFeedback(message) {
    hideMarkVotedToast();
    const strip = document.getElementById("monitorStandaloneStrip");
    if (!strip) return;
    strip.hidden = false;
    strip.className = "monitor-standalone-strip monitor-standalone-strip--error";
    strip.innerHTML = `
      <div class="monitor-standalone-strip__inner monitor-standalone-strip__inner--error">
        <p class="monitor-standalone-strip__text" role="status">${escapeHtml(message)}</p>
      </div>
    `;
    attachMarkVotedToastTimers(strip, { durationMs: 3000, showCountdown: false });
    if (monitorViewSearch) monitorViewSearch.value = "";
    if (monitorViewResult) monitorViewResult.innerHTML = "";
  }

  function renderStandaloneNotFound(query) {
    hideMarkVotedToast();
    const strip = document.getElementById("monitorStandaloneStrip");
    if (!strip) return;
    const q = (query || "").trim();
    const rowHtml = q
      ? `<div class="monitor-standalone-strip__toast-row"><span>Seq / ID</span><strong>${escapeHtml(q)}</strong></div>`
      : "";
    strip.hidden = false;
    strip.className = "monitor-standalone-strip monitor-standalone-strip--error";
    strip.innerHTML = `
      <div class="monitor-standalone-strip__inner monitor-standalone-strip__inner--notfound">
        <div class="monitor-standalone-strip__toast-title">No voter found</div>
        ${rowHtml}
        <p class="monitor-standalone-strip__toast-note">No match for that ID or ballot-box sequence. Try again.</p>
      </div>
    `;
    attachMarkVotedToastTimers(strip, { durationMs: 3000, showCountdown: false });
    if (monitorViewSearch) monitorViewSearch.value = "";
    if (monitorViewResult) monitorViewResult.innerHTML = "";
  }

  function doStandaloneMarkVoted() {
    if (!canMarkVoted()) return;
    const query = (monitorViewSearch?.value || "").trim();
    if (!query) {
      if (monitorViewResult) monitorViewResult.innerHTML = "";
      return;
    }
    const matches = searchVoters(query);
    if (!matches.length) {
      renderStandaloneNotFound(query);
      return;
    }
    if (matches.length === 1) {
      const v = matches[0];
      const timeMarked = getVotedEntries().find((e) => sameVoterId(e.voterId, v.id))?.timeMarked;
      if (timeMarked) {
        renderStandaloneFeedback("This voter is already marked as voted.");
        return;
      }
      markVoterVoted(v.id);
      if (monitorViewSearch) monitorViewSearch.value = "";
      if (monitorViewResult) monitorViewResult.innerHTML = "";
      return;
    }
    renderStandaloneMultiPick(matches);
  }

  function doSearch() {
    if (!canMarkVoted()) return;
    const query = (monitorViewSearch?.value || "").trim();
    if (!query) {
      if (monitorViewResult) monitorViewResult.innerHTML = "";
      return;
    }
    const matches = searchVoters(query);
    if (!matches.length) {
      renderMonitorNotFound(query);
      return;
    }
    if (matches.length === 1) {
      renderMonitorViewResult(matches[0]);
      return;
    }

    // Render a simple list of matching names; clicking a row shows full card.
    const rowsHtml = matches
      .slice(0, 25)
      .map(
        (v) => `
        <button type="button" class="monitor-view-result__match" data-monitor-match-id="${escapeHtml(
          v.id
        )}">
          <span class="monitor-view-result__match-name">${escapeHtml(
            v.fullName || ""
          )}</span>
          <span class="monitor-view-result__match-meta">${escapeHtml(
            v.nationalId || v.id || ""
          )}${
            " • Seq " + escapeHtml(String(sequenceAsImportedFromCsv(v)))
          }</span>
        </button>`
      )
      .join("");

    monitorViewResult.innerHTML = `
      <div class="monitor-view-result__list" role="list">
        ${rowsHtml}
      </div>
    `;

    monitorViewResult
      .querySelectorAll("[data-monitor-match-id]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-monitor-match-id");
          const v = assignedVoters.find((x) => String(x.id) === String(id));
          renderMonitorViewResult(v || null);
        });
      });
  }

  async function showMonitorContent() {
    if (monitorWorkspaceOpened) return;
    await initBallotSessionSubscription();

    monitorWorkspaceOpened = true;

    monitorViewEl.setAttribute("data-state", "list");
    if (contentEl) {
      contentEl.hidden = false;
      contentEl.setAttribute("aria-hidden", "false");
      contentEl.style.display = "";
    }
    if (monitorViewEl) monitorViewEl.hidden = false;
    if (monitorViewResult) monitorViewResult.innerHTML = "";

    if (standaloneBallotPage && contentEl && !document.getElementById("monitorStandaloneStrip")) {
      const strip = document.createElement("div");
      strip.id = "monitorStandaloneStrip";
      strip.className = "monitor-standalone-strip";
      strip.hidden = true;
      strip.setAttribute("aria-live", "polite");
      const hdr = contentEl.querySelector(".monitor-view__header");
      const toolbar = contentEl.querySelector(".monitor-view__toolbar");
      if (hdr && toolbar) hdr.insertAdjacentElement("afterend", strip);
      else if (toolbar) toolbar.insertAdjacentElement("beforebegin", strip);
      else contentEl.insertBefore(strip, contentEl.firstChild);
    }

    // Session state already streams from Firestore (subscription started at init); paint workspace UI.
    syncBallotSessionUi();

    if (monitoringDisabled) {
      updateMonitorSearchUi();
      const msgEl = document.createElement("p");
      msgEl.className = "monitor-view-result__empty";
      msgEl.setAttribute("role", "status");
      msgEl.textContent = "Monitoring is disabled by Campaign Office.";
      if (monitorViewResult) monitorViewResult.appendChild(msgEl);
    } else {
      updateMonitorSearchUi();
      const markAction = standaloneBallotPage ? doStandaloneMarkVoted : doSearch;
      if (monitorViewSearchBtn) monitorViewSearchBtn.addEventListener("click", markAction);
      if (monitorViewSearch) {
        if (standaloneBallotPage) {
          monitorViewSearch.addEventListener("focus", (e) => {
            const t = e.target;
            if (t && t.id === "monitorViewSearch") t.blur();
          });
        }
        monitorViewSearch.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            markAction();
          }
        });
      }
    }
  }

  monitorViewEl.hidden = false;

  const gateForm = document.getElementById("monitorViewGateForm");
  const gateInput = document.getElementById("monitorViewAccessCode");
  const gateError = document.getElementById("monitorViewGateError");
  const expectedCode = (getMonitorAccessCode(monitor) || "").trim();

  if (gateForm && gateInput) {
    gateForm.addEventListener("submit", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entered = (gateInput.value || "").trim();
      if (gateError) {
        gateError.hidden = true;
        gateError.textContent = "";
      }
      if (!entered) {
        if (gateError) {
          gateError.hidden = false;
          gateError.textContent = "Please enter the access code.";
        }
        return;
      }
      if (entered.toLowerCase() !== expectedCode.toLowerCase()) {
        if (gateError) {
          gateError.hidden = false;
          gateError.textContent = "Incorrect access code. Please ask your Campaign Manager for the code.";
        }
        return;
      }
      showMonitorContent();
    });
  }

  // Same ballot session doc as ballot-box.html — admins and monitors see one shared Open / Paused / Closed state.
  void initBallotSessionSubscription();
}

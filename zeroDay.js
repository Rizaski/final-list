/**
 * Zero Day module: Transportation Management & Vote Marking
 * Election day transport trips and voter vote-marking.
 */

import { openModal, closeModal, confirmDialog } from "./ui.js";
import { firebaseInitPromise } from "./firebase.js";
import { getAgents } from "./settings.js";

const zeroDayAddTripButton = document.getElementById("zeroDayAddTripButton");
const zeroDayTransportMenuButton = document.getElementById("zeroDayTransportMenuButton");
const zeroDayTransportMenu = document.getElementById("zeroDayTransportMenu");
const zeroDayMarkVotedButton = document.getElementById("zeroDayMarkVotedButton");
const zeroDayVoteSearch = document.getElementById("zeroDayVoteSearch");
const zeroDayVoteFilter = document.getElementById("zeroDayVoteFilter");
const zeroDayTripsTableBody = document.querySelector("#zeroDayTripsTable tbody");
const zeroDayVoteCardsContainer = document.getElementById("zeroDayVoteCards");
const zeroDayVotePaginationEl = document.getElementById("zeroDayVotePagination");
const zeroDayAddMonitorButton = document.getElementById("zeroDayAddMonitorButton");
const zeroDayMonitorsTableBody = document.querySelector("#zeroDayMonitorsTable tbody");

const TRIP_TYPES = [
  { value: "flight", label: "Flight" },
  { value: "speedboat", label: "Speed boat" },
];
const TRIP_STATUSES = ["Scheduled", "In progress", "Completed"];
const PAGE_SIZE = 15;
const MONITORS_STORAGE_KEY = "zero-day-monitors";
const VOTED_STORAGE_KEY = "zero-day-voted";
const TRIPS_STORAGE_KEY = "zero-day-trips";

let zeroDayTrips = [];
let transportTripsUnsubscribe = null;
let zeroDayVotedEntries = []; // { voterId, timeMarked }
let zeroDayMonitors = []; // { id, name, mobile, ballotBox, voterIds: [], shareToken }
let votersContext = null;
let pledgeContextRef = null; // optional: { getPledges() } for agent lookup and sync
let zeroDayVoteCurrentPage = 1;
let transportViewFilter = "all"; // "all" | "flight" | "speedboat"
let votedRealtimeUnsubscribes = []; // unsubscribe fns for Firestore voted listeners
const votedByMonitor = {}; // token -> [{ voterId, timeMarked }] from real-time snapshots
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
  const trip = normalizeTrip({
    id: nextId,
    tripType,
    route,
    driver: "",
    vehicle: "",
    pickupTime: "",
    status: "Scheduled",
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

function loadTrips() {
  try {
    const raw = localStorage.getItem(TRIPS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) zeroDayTrips = parsed.map(normalizeTrip);
    }
  } catch (_) {}
}

function saveTrips() {
  try {
    localStorage.setItem(TRIPS_STORAGE_KEY, JSON.stringify(zeroDayTrips));
  } catch (_) {}
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
  };
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
    const existingById = new Map(zeroDayVotedEntries.map((e) => [String(e.voterId), e.timeMarked]));
    for (const m of zeroDayMonitors) {
      const token = m.shareToken;
      if (!token) continue;
      const entries = await api.getVotedForMonitor(token);
      for (const { voterId, timeMarked } of entries) {
        const key = String(voterId);
        const existing = existingById.get(key);
        if (!existing || (timeMarked && timeMarked > (existing || ""))) {
          existingById.set(key, timeMarked || existing || "");
        }
      }
    }
    zeroDayVotedEntries = Array.from(existingById.entries()).map(([voterId, timeMarked]) => ({ voterId, timeMarked: timeMarked || "" }));
    saveVotedEntries();
    notifyVotedEntriesUpdated();
  } catch (_) {}
}

/** Merges votedByMonitor (from real-time Firestore) with local zeroDayVotedEntries and refreshes UI. */
function mergeRealtimeVotedIntoLocal() {
  loadVotedEntries();
  const existingById = new Map(zeroDayVotedEntries.map((e) => [String(e.voterId), e.timeMarked]));
  for (const token of Object.keys(votedByMonitor)) {
    const entries = votedByMonitor[token];
    if (!Array.isArray(entries)) continue;
    for (const { voterId, timeMarked } of entries) {
      const key = String(voterId);
      const existing = existingById.get(key);
      if (!existing || (timeMarked && timeMarked > (existing || ""))) {
        existingById.set(key, timeMarked || existing || "");
      }
    }
  }
  zeroDayVotedEntries = Array.from(existingById.entries()).map(([voterId, timeMarked]) => ({ voterId, timeMarked: timeMarked || "" }));
  saveVotedEntries();
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
  const tabButtons = document.querySelectorAll("[data-zero-day-tab]");
  const panels = document.querySelectorAll(".zero-day-tabs__panel");

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

  switchToTab("transport");
}

function getFilteredTransportTrips() {
  let list = zeroDayTrips;
  if (transportViewFilter === "flight") list = list.filter((t) => t.tripType === "flight");
  else if (transportViewFilter === "speedboat") list = list.filter((t) => t.tripType === "speedboat");
  return [...list].sort((a, b) => {
    const ta = a.pickupTime ? new Date(a.pickupTime).getTime() : 0;
    const tb = b.pickupTime ? new Date(b.pickupTime).getTime() : 0;
    return ta - tb;
  });
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
  const voters = votersContext ? votersContext.getAllVoters() : [];
  if (!voters.length) {
    return trip?.voterCount != null ? trip.voterCount : byIds.length;
  }
  const normalizeRoute = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  const routeKey = normalizeRoute(trip?.route || "");
  const dedup = new Set();
  byIds.forEach((id) => {
    if (id != null && String(id).trim()) dedup.add(String(id));
  });
  if (routeKey) {
    voters.forEach((v) => {
      if (!v || v.transportNeeded !== true) return;
      const r = normalizeRoute(v.transportRoute);
      if (!r) return;
      if (r === routeKey || r.includes(routeKey) || routeKey.includes(r)) {
        const key = v.id != null ? String(v.id) : v.nationalId != null ? String(v.nationalId) : "";
        if (key) dedup.add(key);
      }
    });
  }
  return dedup.size;
}

function renderZeroDayTripsTable() {
  if (!zeroDayTripsTableBody) return;
  const trips = getFilteredTransportTrips();
  zeroDayTripsTableBody.innerHTML = "";
  if (!trips.length) {
    zeroDayTripsTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="text-muted" style="text-align: center; padding: 24px;">${getEmptyTransportMessage()}</td>
      </tr>
    `;
    return;
  }
  trips.forEach((trip) => {
    const tripTypeEntry = TRIP_TYPES.find((t) => t.value === trip.tripType);
    const typeLabel = (tripTypeEntry && tripTypeEntry.label) != null ? tripTypeEntry.label : (trip.tripType != null ? trip.tripType : "–");
    const count = getTripAssignedVoterCount(trip);
    const statusClass = tripStatusBadgeClass(trip.status);
    const tr = document.createElement("tr");
    tr.dataset.tripId = String(trip.id);
    tr.innerHTML = `
      <td><span class="badge badge--unknown">${escapeHtml(typeLabel)}</span></td>
      <td>${escapeHtml(trip.route)}</td>
      <td>${escapeHtml(trip.vehicle)}</td>
      <td>${escapeHtml(trip.driver)}</td>
      <td>${formatDateTime(trip.pickupTime)}</td>
      <td>${count}</td>
      <td><span class="${escapeHtml(statusClass)}">${escapeHtml(trip.status)}</span></td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="ghost-button ghost-button--small" data-trip-status="${trip.id}" title="Change status" aria-label="Change status">Status</button>
        <button class="ghost-button ghost-button--small" data-assign-trip="${trip.id}" title="Assign voters">Assign</button>
        <button class="ghost-button ghost-button--small" data-view-trip-voters="${trip.id}" title="View voters">View voters</button>
        <button class="ghost-button ghost-button--small" data-edit-trip="${trip.id}">Edit</button>
        <button class="ghost-button ghost-button--small" data-delete-trip="${trip.id}" aria-label="Delete">Delete</button>
      </td>
    `;
    zeroDayTripsTableBody.appendChild(tr);
  });
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
    if (!route) return;
    if (isEdit) {
      existing.tripType = type;
      existing.route = route;
      existing.driver = driver;
      existing.vehicle = vehicle;
      existing.pickupTime = pickupTime ? new Date(pickupTime).toISOString() : "";
      existing.status = status;
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
  const idx = zeroDayTrips.findIndex((t) => t.id === id);
  if (idx === -1) return;
  zeroDayTrips.splice(idx, 1);
  saveTrips();
  firebaseInitPromise.then((api) => {
    if (api.ready && api.deleteTransportTripFs) return api.deleteTransportTripFs(id);
  }).catch(() => {});
  renderZeroDayTripsTable();
}

function setTripStatus(tripId, status) {
  const trip = zeroDayTrips.find((t) => t.id === tripId);
  if (!trip || !TRIP_STATUSES.includes(status)) return;
  trip.status = status;
  saveTrips();
  firebaseInitPromise.then((api) => {
    if (api.ready && api.setTransportTripFs) return api.setTransportTripFs(trip);
  }).catch(() => {});
  renderZeroDayTripsTable();
}

function openTripStatusModal(tripId) {
  const trip = zeroDayTrips.find((t) => t.id === tripId);
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

function openTripVotersModal(trip) {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const ids = new Set((trip.voterIds || []).map(String));
  const normalizeRoute = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  const assignedByIds = voters.filter((v) => {
    const id = v && v.id != null ? String(v.id) : "";
    const nationalId = v && v.nationalId != null ? String(v.nationalId) : "";
    return ids.has(id) || ids.has(nationalId);
  });
  // Also include voters who requested transport for this route via Voters List detail view
  const routeKey = normalizeRoute(trip.route);
  const assignedByRoute = routeKey
    ? voters.filter((v) => {
        if (!v || v.transportNeeded !== true) return false;
        const r = normalizeRoute(v.transportRoute);
        if (!r) return false;
        // Prefer exact match, but allow small variations (e.g. extra words, spacing)
        return r === routeKey || r.includes(routeKey) || routeKey.includes(r);
      })
    : [];
  const assigned = (() => {
    const byId = new Map();
    [...assignedByIds, ...assignedByRoute].forEach((v) => {
      if (!v) return;
      const k = String(v.id || v.nationalId || "");
      if (!k) return;
      byId.set(k, v);
    });
    return Array.from(byId.values());
  })();

  const title = `Assigned voters – ${trip.route || "Route"}`;
  const body = document.createElement("div");
  body.className = "modal-body-inner modal-body-inner--with-maximize";

  const summary = document.createElement("div");
  summary.className = "helper-text";
  summary.style.margin = "6px 0 10px";
  summary.textContent = `Matched ${assigned.length} voters (Trip assignment: ${assignedByIds.length}, By route: ${assignedByRoute.length})`;

  const listToolbar = document.createElement("div");
  listToolbar.className = "modal-list-toolbar list-toolbar";
  listToolbar.innerHTML = `
    <div class="list-toolbar__search">
      <label for="zdTripVotersSearch" class="sr-only">Search</label>
      <input type="search" id="zdTripVotersSearch" placeholder="Search by name, ID, address…">
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
      <div class="field-group field-group--inline">
        <label for="zdTripVotersSort">Sort</label>
        <select id="zdTripVotersSort">
          <option value="sequence">Seq</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="id">ID Number</option>
          <option value="address">Permanent address</option>
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
        </select>
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
    const filterPledge = (body.querySelector("#zdTripVotersFilter") || {}).value || "all";
    const sortBy = (body.querySelector("#zdTripVotersSort") || {}).value || "sequence";
    const groupBy = (body.querySelector("#zdTripVotersGroupBy") || {}).value || "none";
    const searchQuery = (body.querySelector("#zdTripVotersSearch") || {}).value || "";
    let list = applySearchFilter(assigned, searchQuery);
    const displayList = getModalListFilteredSortedGrouped(list, filterPledge, sortBy, groupBy);
    const newTable = buildTableFromDisplayList(displayList, {
      includeVotedStatus: true,
      includeTimeVoted: false,
      showUnmarkAction: false,
      usePledgePills: true,
    });
    tableWrap.innerHTML = "";
    tableWrap.appendChild(newTable.firstElementChild);
  }

  body.appendChild(topBar);
  body.appendChild(summary);
  body.appendChild(listToolbar);
  body.appendChild(tableWrap);

  listToolbar.querySelector("#zdTripVotersFilter").addEventListener("change", render);
  listToolbar.querySelector("#zdTripVotersSort").addEventListener("change", render);
  listToolbar.querySelector("#zdTripVotersGroupBy").addEventListener("change", render);
  const searchEl = listToolbar.querySelector("#zdTripVotersSearch");
  if (searchEl) searchEl.addEventListener("input", render);

  render();
  openModal({ title, body });
}

function openAssignVotersModal(trip) {
  const voters = votersContext ? votersContext.getAllVoters() : [];
  const assignedSet = new Set((trip.voterIds || []).map(String));
  const body = document.createElement("div");
  body.className = "form-group";
  body.innerHTML = `<p class="helper-text" style="margin-bottom:8px">Select voters to assign to <strong>${escapeHtml(trip.route)}</strong>. Assigned count will update the trip.</p>`;
  const list = document.createElement("div");
  list.style.maxHeight = "320px";
  list.style.overflowY = "auto";
  list.style.border = "1px solid var(--color-border, #e5e7eb)";
  list.style.borderRadius = "6px";
  list.style.padding = "8px";
  const boxes = getUniqueBallotBoxes();
  boxes.forEach((box) => {
    const inBox = voters.filter((v) => (v.ballotBox || "").trim() === box);
    if (!inBox.length) return;
    const heading = document.createElement("div");
    heading.style.fontWeight = "600";
    heading.style.marginTop = "8px";
    heading.style.marginBottom = "4px";
    heading.textContent = box;
    list.appendChild(heading);
    inBox.forEach((v) => {
      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "8px";
      label.style.padding = "4px 0";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = assignedSet.has(String(v.id));
      cb.dataset.voterId = String(v.id);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(`${v.fullName || v.id} ${(v.nationalId || "").slice(0, 12)}`));
      list.appendChild(label);
    });
  });
  if (!boxes.length) {
    list.innerHTML = "<p class=\"text-muted\">No voters with ballot box. Import voters first.</p>";
  }
  body.appendChild(list);
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
  saveBtn.textContent = "Save assignment";
  saveBtn.addEventListener("click", async () => {
    const checked = list.querySelectorAll("input[type=checkbox]:checked");
    const voterIds = Array.from(checked).map((el) => el.dataset.voterId);
    trip.voterIds = voterIds;
    trip.voterCount = voterIds.length;
    saveTrips();
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.setTransportTripFs) await api.setTransportTripFs(trip);
    } catch (_) {}
    renderZeroDayTripsTable();
    closeModal();
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  openModal({ title: "Assign voters to trip", body, footer });
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

function renderMonitorsTable() {
  if (!zeroDayMonitorsTableBody) return;
  zeroDayMonitorsTableBody.innerHTML = "";
  if (!zeroDayMonitors.length) {
    zeroDayMonitorsTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-muted" style="text-align: center; padding: 24px;">No monitors yet. Add a monitor and assign voters from their ballot box.</td>
      </tr>
    `;
    return;
  }
  const voters = votersContext ? votersContext.getAllVoters() : [];
  zeroDayMonitors.forEach((m) => {
    const voterCount = (m.voterIds || []).length;
    const path = window.location.pathname || "/";
    const dir = path.endsWith("/") ? path : path.replace(/[^/]+$/, "") || "/";
    const ballotBoxUrl = window.location.origin + dir + "ballot-box.html";
    const monitorUrl = `${ballotBoxUrl}?monitor=${encodeURIComponent(m.shareToken)}`;
    const accessCode = (m.shareToken || "").split("-")[1] || m.shareToken;
    const tr = document.createElement("tr");
    tr.dataset.monitorId = String(m.id);
    tr.innerHTML = `
      <td colspan="5">
        <div class="monitor-card">
          <div class="monitor-card__ballot">
            <span class="monitor-card__ballot-title">${escapeHtml(m.ballotBox || "Ballot box")}</span>
            <span class="monitor-card__ballot-meta">Ballot access for assigned monitor</span>
          </div>
          <div>
            <div class="monitor-card__monitor">
              <span><strong>Monitor:</strong> ${escapeHtml(m.name || "—")}</span>
              <span><strong>Mobile:</strong> ${escapeHtml(m.mobile || "—")}</span>
              <span class="monitor-card__voters"><strong>Voters:</strong> ${voterCount}</span>
            </div>
            <div class="monitor-card__link">
              <span><strong>Link:</strong> <code class="monitor-link-preview">${escapeHtml(monitorUrl)}</code></span>
              <span class="monitor-card__access"><strong>Access code:</strong> ${escapeHtml(accessCode)}</span>
            </div>
          </div>
          <div class="monitor-card__actions">
            <button class="ghost-button ghost-button--small" data-assign-voters="${m.id}" title="Assign voters from this ballot box">Assign voters</button>
            <button class="ghost-button ghost-button--small" data-copy-link="${m.id}" title="Copy link &amp; code">Copy link</button>
            <button class="ghost-button ghost-button--small" data-delete-monitor="${m.id}" title="Delete this monitor and its access link">Delete link</button>
          </div>
        </div>
      </td>
    `;
    zeroDayMonitorsTableBody.appendChild(tr);
  });
}

function openAddMonitorForm(existing) {
  const isEdit = !!existing;
  const ballotBoxes = getUniqueBallotBoxes();
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="monitorName">Monitor name</label>
        <input id="monitorName" type="text" value="${escapeHtml(existing?.name || "")}" placeholder="e.g. Ahmed Hassan">
      </div>
      <div class="form-group">
        <label for="monitorMobile">Mobile</label>
        <input id="monitorMobile" type="text" value="${escapeHtml(existing?.mobile || "")}" placeholder="e.g. 960 123 4567">
      </div>
      <div class="form-group">
        <label for="monitorBallotBox">Ballot box</label>
        <select id="monitorBallotBox">
          <option value="">Select ballot box…</option>
          ${ballotBoxes.map((b) => `<option value="${escapeHtml(b)}"${(existing?.ballotBox || "") === b ? " selected" : ""}>${escapeHtml(b)}</option>`).join("")}
        </select>
      </div>
    </div>
    ${!isEdit ? "<p class=\"helper-text\">After adding, use “Assign voters” to add all voters from this ballot box to the monitor’s list. Then use “Copy link” to share.</p>" : ""}
  `;

  const footer = document.createElement("div");
  const saveBtn = document.createElement("button");
  saveBtn.className = "primary-button";
  saveBtn.textContent = isEdit ? "Save changes" : "Add monitor";
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", () => {
    const name = body.querySelector("#monitorName").value.trim();
    const mobile = body.querySelector("#monitorMobile").value.trim();
    const ballotBox = body.querySelector("#monitorBallotBox").value.trim();
    if (!name || !ballotBox) return;

    if (isEdit) {
      existing.name = name;
      existing.mobile = mobile;
      existing.ballotBox = ballotBox;
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
      };
      zeroDayMonitors.push(newMonitor);
      saveMonitors();
      syncMonitorToFirestore(newMonitor);
    }
    renderMonitorsTable();
    subscribeVotedRealtime();
    closeModal();
  });

  openModal({
    title: isEdit ? "Edit monitor" : "Add monitor",
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

function copyMonitorLink(monitorId) {
  const monitor = zeroDayMonitors.find((m) => m.id === monitorId);
  if (!monitor) return;
  const path = window.location.pathname || "/";
  const dir = path.endsWith("/") ? path : path.replace(/[^/]+$/, "") || "/";
  const ballotBoxUrl = window.location.origin + dir + "ballot-box.html";
  const url = `${ballotBoxUrl}?monitor=${encodeURIComponent(monitor.shareToken)}`;
  const accessCode = (monitor.shareToken || "").split("-")[1] || monitor.shareToken;
  const payload = `${url}\nAccess code: ${accessCode}`;
  navigator.clipboard.writeText(payload).then(() => {
    if (typeof window.showToast === "function") window.showToast("Link and access code copied to clipboard");
    else alert("Link and access code copied to clipboard.");
  }).catch(() => alert("Could not copy. Link: " + url + " (Access code: " + accessCode + ")"));
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
    const timeMarked = fromVoter || fromEntries;
    if (timeMarked != null && String(timeMarked).trim() !== "") {
      voted.push({ ...v, _timeMarked: timeMarked });
    } else {
      notYet.push(v);
    }
  });
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
        return (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
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
      case "time":
        return (a._timeMarked || "").localeCompare(b._timeMarked || "", "en");
      default:
        return (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
    }
  };
  list = list.slice().sort(cmp);

  if (groupBy === "none") {
    return list.map((v) => ({ type: "row", voter: v }));
  }

  const getGroupKey = (v) => {
    if (groupBy === "pledge") return v.pledgeStatus || "undecided";
    if (groupBy === "agent") return getAgentForVoter(v.id) || "(No agent)";
    return "";
  };
  const displayList = [];
  let lastKey = null;
  list.forEach((v) => {
    const key = getGroupKey(v);
    const label = groupBy === "pledge" ? getPledgeLabel(key) : key;
    if (key !== lastKey) {
      displayList.push({ type: "group", label });
      lastKey = key;
    }
    displayList.push({ type: "row", voter: v });
  });
  return displayList;
}

function buildTableFromDisplayList(displayList, options = {}) {
  const includeTimeVoted = !!options.includeTimeVoted;
  const showUnmarkAction = !!options.showUnmarkAction;
  const includeVotedStatus = !!options.includeVotedStatus;
  const usePledgePills = !!options.usePledgePills;
  const columns = [
    "Image",
    "Seq",
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
  if (showUnmarkAction) columns.push("Actions");
  const colCount = columns.length;

  const wrap = document.createElement("div");
  wrap.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr>" +
    columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("") +
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
        imageCell,
        v.sequence != null ? v.sequence : "",
        v.fullName != null ? v.fullName : "",
        v.nationalId != null ? v.nationalId : (v.id != null ? v.id : ""),
        v.permanentAddress != null ? v.permanentAddress : "",
        v.phone != null ? v.phone : "",
        v.ballotBox || (v.island != null ? v.island : ""),
        usePledgePills
          ? { html: `<span class="${escapeHtml(pledgeClass)}">${escapeHtml(pledgeLabel)}</span>` }
          : pledgeLabel,
        agent,
      ];
      if (includeVotedStatus) row.push({ html: votedCell });
      if (includeTimeVoted) row.push(formatDateTime(v._timeMarked));
      if (showUnmarkAction) {
        row.push(
          `<button type="button" class="ghost-button ghost-button--small" data-unmark-voted="${escapeHtml(
            String(v.id)
          )}">Mark not voted</button>`
        );
      }
      const tr = document.createElement("tr");
      const [imageHtml, ...rest] = row;
      tr.innerHTML =
        `<td>${imageHtml}</td>` +
        rest
          .map((cell) =>
            typeof cell === "string" && cell.startsWith("<button")
              ? `<td>${cell}</td>`
              : cell && typeof cell === "object" && typeof cell.html === "string"
                ? `<td>${cell.html}</td>`
                : `<td>${escapeHtml(String(cell))}</td>`
          )
          .join("");
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

  render();
  openModal({ title, body });
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
  copyMonitorLink(monitor.id);
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
      const percentage =
        box.total === 0 ? 0 : Math.round((box.voted / box.total) * 100);
      const notYet = Math.max(0, box.total - box.voted);
      const votedPct = box.total === 0 ? 0 : (box.voted / box.total) * 100;
      const badgeClass =
        percentage >= 100
          ? "vote-box-card__badge--full"
          : percentage > 0
            ? "vote-box-card__badge--partial"
            : "vote-box-card__badge--none";
      card.innerHTML = `
        <div class="vote-box-card__header">
          <div>
            <div class="vote-box-card__title-wrap">
              <span class="vote-box-card__title">${escapeHtml(box.box)}</span>
              <button type="button" class="vote-box-card__copy-btn" data-copy-code="${escapeHtml(
                box.box
              )}" title="Copy access code" aria-label="Copy access code">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>
            <div class="vote-box-card__meta">${escapeHtml(box.island || "")}</div>
          </div>
          <span class="vote-box-card__badge ${badgeClass}">${percentage}% voted</span>
        </div>
        <div class="vote-box-card__progress" role="img" aria-label="${percentage}% voted">
          <span class="vote-box-card__progress-seg vote-box-card__progress-seg--voted" style="width:${votedPct}%"></span>
          <span class="vote-box-card__progress-seg vote-box-card__progress-seg--not-yet" style="width:${100 - votedPct}%"></span>
        </div>
        <div class="vote-box-card__stats">
          <span><strong>Total:</strong> ${box.total}</span>
          <span><strong>Voted:</strong> ${box.voted}</span>
          <span><strong>Not yet:</strong> ${notYet}</span>
        </div>
        <div class="vote-box-card__actions">
          <button type="button" class="ghost-button ghost-button--small" data-view-voted="${escapeHtml(
            box.box
          )}">View voted</button>
          <button type="button" class="ghost-button ghost-button--small" data-view-not-yet="${escapeHtml(
            box.box
          )}">View not yet</button>
          <button type="button" class="ghost-button ghost-button--small" data-open-box="${escapeHtml(
            box.box
          )}">Open list</button>
          <button type="button" class="ghost-button ghost-button--small" data-share-box="${escapeHtml(
            box.box
          )}">Share monitor link</button>
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
  loadVotedEntries();
  loadMonitors();
  loadTrips();
  initZeroDayTabs();
  bindTransportMenu();
  renderZeroDayTripsTable();
  renderZeroDayVoteTable();
  renderMonitorsTable();
  bindZeroDayToolbar();

  firebaseInitPromise.then((api) => {
    if (!api.ready || !api.getAllTransportTripsFs) return;
    api.getAllTransportTripsFs().then((remote) => {
      if (Array.isArray(remote) && remote.length > 0) {
        zeroDayTrips = remote.map(normalizeTrip);
        saveTrips();
      }
      renderZeroDayTripsTable();
    }).catch(() => {});
    if (api.onTransportTripsSnapshotFs) {
      transportTripsUnsubscribe = api.onTransportTripsSnapshotFs((items) => {
        if (Array.isArray(items)) {
          zeroDayTrips = items.map(normalizeTrip);
          saveTrips();
          renderZeroDayTripsTable();
        }
      });
    }
  }).catch(() => {});

  if (zeroDayAddTripButton) {
    zeroDayAddTripButton.addEventListener("click", () => openTripForm(null));
  }

  if (zeroDayAddMonitorButton) {
    zeroDayAddMonitorButton.addEventListener("click", () => openAddMonitorForm(null));
  }

  const monitorsPanel = document.getElementById("zero-day-tab-monitors");
  if (monitorsPanel) {
    monitorsPanel.addEventListener("click", (e) => {
      const assignBtn = e.target.closest("[data-assign-voters]");
      const copyBtn = e.target.closest("[data-copy-link]");
      const deleteBtn = e.target.closest("[data-delete-monitor]");
      if (assignBtn) {
        const id = Number(assignBtn.getAttribute("data-assign-voters"));
        assignVotersFromBallotBox(id);
      } else if (copyBtn) {
        const id = Number(copyBtn.getAttribute("data-copy-link"));
        copyMonitorLink(id);
      } else if (deleteBtn) {
        const id = Number(deleteBtn.getAttribute("data-delete-monitor"));
        deleteMonitorLink(id);
      }
    });
  }

  const transportPanel = document.getElementById("zero-day-tab-transport");
  if (transportPanel) {
    transportPanel.addEventListener("click", (e) => {
      const statusBtn = e.target.closest("[data-trip-status]");
      const assignBtn = e.target.closest("[data-assign-trip]");
      const viewBtn = e.target.closest("[data-view-trip-voters]");
      const editBtn = e.target.closest("[data-edit-trip]");
      const deleteBtn = e.target.closest("[data-delete-trip]");
      if (statusBtn) {
        const id = Number(statusBtn.getAttribute("data-trip-status"));
        openTripStatusModal(id);
      } else if (assignBtn) {
        const id = Number(assignBtn.getAttribute("data-assign-trip"));
        const trip = zeroDayTrips.find((t) => t.id === id);
        if (trip) openAssignVotersModal(trip);
      } else if (viewBtn) {
        const id = Number(viewBtn.getAttribute("data-view-trip-voters"));
        const trip = zeroDayTrips.find((t) => t.id === id);
        if (trip) openTripVotersModal(trip);
      } else if (editBtn) {
        const id = Number(editBtn.getAttribute("data-edit-trip"));
        const trip = zeroDayTrips.find((t) => t.id === id);
        if (trip) openTripForm(trip);
      } else if (deleteBtn) {
        const id = Number(deleteBtn.getAttribute("data-delete-trip"));
        deleteTrip(id);
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
      const copyBtn = e.target.closest("[data-copy-code]");
      const viewVotedBtn = e.target.closest("[data-view-voted]");
      const viewNotYetBtn = e.target.closest("[data-view-not-yet]");
      const openBtn = e.target.closest("[data-open-box]");
      const shareBtn = e.target.closest("[data-share-box]");

      if (copyBtn) {
        const code = copyBtn.getAttribute("data-copy-code");
        if (code) {
          navigator.clipboard
            .writeText(code)
            .then(() => {
              if (typeof window.showToast === "function") {
                window.showToast("Access code copied to clipboard.");
              }
            })
            .catch(() => {});
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
      if (openBtn) {
        const box = openBtn.getAttribute("data-open-box");
        if (box && votersContext) {
          const monitor = getOrEnsureMonitorForBallotBox(box);
          const path = window.location.pathname || "/";
          const dir = path.endsWith("/") ? path : path.replace(/[^/]+$/, "") || "/";
          const ballotBoxUrl = window.location.origin + dir + "ballot-box.html";
          const url = `${ballotBoxUrl}?monitor=${encodeURIComponent(monitor.shareToken)}`;
          window.open(url, "_blank", "noopener,noreferrer");
          if (typeof window.showToast === "function") {
            window.showToast("List opened in new tab. Share that tab’s URL to view from another browser.");
          }
        }
      } else if (shareBtn) {
        const box = shareBtn.getAttribute("data-share-box");
        if (box) ensureMonitorForBallotBox(box);
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
  const monitoringDisabled = options.monitoringDisabled === true;
  let monitor = options.remoteMonitor;
  let assignedVoters = [];
  let votedEntries = options.remoteVotedEntries != null ? options.remoteVotedEntries : [];

  if (isBallotBoxOnly) {
    loadVotedEntries();
    const allVoters = votersContextParam.getAllVoters();
    const boxKey = (options.ballotBoxOnly || "").trim();
    assignedVoters = allVoters.filter(
      (v) => (v.ballotBox || v.island || "Unassigned").trim() === boxKey
    );
    monitor = { ballotBox: options.ballotBoxOnly, voterIds: assignedVoters.map((v) => v.id) };
    votedEntries = zeroDayVotedEntries;
  } else if (!isRemote) {
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
    votedEntries = zeroDayVotedEntries;
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

  if (isBallotBoxOnly) {
    monitorViewEl.setAttribute("data-state", "list");
    showMonitorContent();
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
    return;
  }

  monitorViewEl.setAttribute("data-state", "gate");

  function searchVoters(query) {
    const q = (query || "").trim();
    if (!q) return [];

    // Exact match by ID / National ID / Sequence
    const exact = assignedVoters.find(
      (v) =>
        String(v.id || "").toLowerCase() === q.toLowerCase() ||
        String(v.nationalId || "").toLowerCase() === q.toLowerCase() ||
        String(v.sequence != null ? v.sequence : "").trim() === q.trim()
    );
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
    main.className = "monitor-view__header-main";
    main.innerHTML =
      "<h1 id=\"monitorViewTitle\" class=\"monitor-view__title\">" +
      escapeHtml(monitor.ballotBox || "Ballot box") +
      "</h1>" +
      "<div class=\"monitor-view__header-stats\">" +
      "<span class=\"monitor-view__stat\"><strong>Started:</strong> " +
      escapeHtml(formatDateTime(monitorViewStartedAt)) +
      "</span>" +
      "<span class=\"monitor-view__stat\"><strong>Voters:</strong> " +
      String(assignedVoters.length) +
      "</span>" +
      "<span class=\"monitor-view__stat\"><strong>Voted:</strong> " +
      String(votedEntries.length) +
      "</span>" +
      "</div>" +
      "<p class=\"monitor-view__subtitle\" id=\"monitorViewSubtitle\">Search by name, ID, or Sequence to find a voter.</p>";
    fragment.appendChild(main);
    header.innerHTML = "";
    header.appendChild(fragment);
  }

  function markVoterVoted(voterId) {
    const timeMarked = new Date().toISOString();
    const idx = votedEntries.findIndex((e) => sameVoterId(e.voterId, voterId));
    if (idx >= 0) votedEntries[idx].timeMarked = timeMarked;
    else votedEntries.push({ voterId, timeMarked });
    if (isRemote && options.onSaveVoted) options.onSaveVoted(token, voterId, timeMarked).catch(() => {});
    else saveVotedEntries();
    renderMonitorViewHeader();
    const v = assignedVoters.find((x) => sameVoterId(x.id, voterId));
    if (v && monitorViewResult) renderMonitorViewResult(v);
  }

  function renderMonitorViewResult(voterOrNull) {
    if (!monitorViewResult) return;
    const pledgeLabel = (s) => (s === "yes" ? "Yes" : s === "no" ? "No" : "Undecided");
    const pledgePillClass = (s) =>
      s === "yes" ? "pledge-pill pledge-pill--pledged" : s === "no" ? "pledge-pill pledge-pill--not-pledged" : "pledge-pill pledge-pill--undecided";

    if (!voterOrNull) {
      monitorViewResult.innerHTML = `
        <p class="monitor-view-result__empty" role="status">No voter found with that ID or Sequence. Please check and try again.</p>
      `;
      return;
    }

    const voter = voterOrNull;
    const timeMarked = votedEntries.find((e) => sameVoterId(e.voterId, voter.id))?.timeMarked;
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
        ${!monitoringDisabled && !timeMarked ? `<div class="monitor-voter-card__action"><button type="button" class="primary-button" data-monitor-mark-voted="${escapeHtml(voter.id)}">Mark voted</button></div>` : ""}
      </div>
    `;

    if (!monitoringDisabled) {
      monitorViewResult.querySelector("[data-monitor-mark-voted]")?.addEventListener("click", (e) => {
        const vid = e.target.getAttribute("data-monitor-mark-voted");
        if (vid) markVoterVoted(vid);
      });
    }
  }

  function doSearch() {
    const query = (monitorViewSearch?.value || "").trim();
    if (!query) {
      if (monitorViewResult) monitorViewResult.innerHTML = "";
      return;
    }
    const matches = searchVoters(query);
    if (!matches.length) {
      renderMonitorViewResult(null);
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
            v.sequence != null && v.sequence !== ""
              ? " • Seq " + escapeHtml(String(v.sequence))
              : ""
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

  function showMonitorContent() {
    monitorViewEl.setAttribute("data-state", "list");
    renderMonitorViewHeader();
    if (contentEl) contentEl.setAttribute("aria-hidden", "false");
    if (monitorViewEl) monitorViewEl.hidden = false;
    if (monitorViewResult) monitorViewResult.innerHTML = "";

    if (monitoringDisabled) {
      if (monitorViewSearch) monitorViewSearch.disabled = true;
      if (monitorViewSearchBtn) monitorViewSearchBtn.disabled = true;
      const msgEl = document.createElement("p");
      msgEl.className = "monitor-view-result__empty";
      msgEl.setAttribute("role", "status");
      msgEl.textContent = "Monitoring is disabled by Campaign Office.";
      if (monitorViewResult) monitorViewResult.appendChild(msgEl);
    } else {
      if (monitorViewSearch) monitorViewSearch.disabled = false;
      if (monitorViewSearchBtn) monitorViewSearchBtn.disabled = false;
      if (monitorViewSearchBtn) monitorViewSearchBtn.addEventListener("click", doSearch);
      if (monitorViewSearch) {
        monitorViewSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });
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
}

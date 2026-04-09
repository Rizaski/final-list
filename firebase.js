/**
 * Firebase Integration — Auth + Firestore.
 * Defensive init so the app works when Firebase is unavailable (e.g. network, CORS).
 * Exports firebaseInitPromise → { auth, db, ...authFns, getFirestoreCampaignConfig, setFirestoreCampaignConfig, updateFirestoreCampaignConfig, deleteFirestoreCampaignConfig }.
 * CRUD for campaign config: Read (get), Create/Replace (set), Update (patch), Delete.
 */
/** Newer builds improve Identity Platform / SMS MFA + reCAPTCHA; v10+ uses RecaptchaVerifier(auth, container, params). */
const FIREBASE_SDK_VERSION = "10.14.1";
const SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

const firebaseConfig = {
  apiKey: "AIzaSyAIWXqnozfELzrhr16VDkceNwANpT3t7iU",
  authDomain: "myapplication-8f39e.firebaseapp.com",
  databaseURL: "https://myapplication-8f39e-default-rtdb.firebaseio.com",
  projectId: "myapplication-8f39e",
  storageBucket: "myapplication-8f39e.firebasestorage.app",
  messagingSenderId: "686599756280",
  appId: "1:686599756280:web:3be8fc521b39ba10e31e0d",
  measurementId: "G-5KW10W5549",
};

/**
 * Public reCAPTCHA v2 site key for this web app (reCAPTCHA Admin / domain allow-list).
 * Do not pass this to Firebase `RecaptchaVerifier`: the SDK forbids `sitekey` in parameters
 * and loads the project key via Identity Toolkit (`getRecaptchaParams`). Use for App Check
 * (`ReCaptchaV3Provider`) if you add it later, or to mirror hostnames in reCAPTCHA settings.
 */
export const RECAPTCHA_SITE_KEY = "6LetFKwsAAAAACdl54MwRHqk4qZgjtXJP80ENTzL";

const noopUnsubscribe = () => {};
const noopPromise = () => Promise.resolve();

const CAMPAIGN_CONFIG_COLLECTION = "campaign";
const CAMPAIGN_CONFIG_DOC = "config";
const MONITORS_COLLECTION = "monitors";
const VOTER_LISTS_COLLECTION = "voterLists";
const VOTER_LIST_SHARES_COLLECTION = "voterListShares";
const PLEDGED_REPORT_SHARES_COLLECTION = "pledgedReportShares";
const EVENT_PARTICIPANT_SHARES_COLLECTION = "eventParticipantShares";
const CAMPAIGN_USERS_COLLECTION = "campaignUsers";
const EVENTS_COLLECTION = "events";
const TRANSPORT_TRIPS_COLLECTION = "transportTrips";
const TRANSPORT_ROUTES_COLLECTION = "transportRoutes";
/** Read-only snapshots + admin archive writes (Settings → Campaign). */
const CAMPAIGN_ARCHIVES_COLLECTION = "campaignArchives";
/** Matches default label in archiveCampaignSnapshotFs when none provided. */
const DEFAULT_ARCHIVE_LABEL = "archived campaign";
const CAMPAIGN_WORKSPACES_COLLECTION = "campaignWorkspaces";
const ACTIVE_CAMPAIGN_WORKSPACE_STORAGE_KEY = "active-campaign-workspace";
const LEGACY_CAMPAIGN_WORKSPACE_ID = "default";

/** Canonical strings — must match Settings “Type of campaign” and main.js header mapping. */
export const WORKSPACE_CAMPAIGN_TYPES = [
  "Local Council Election",
  "Parliamentary Election",
  "Presidential Election",
];

export function normalizeWorkspaceCampaignType(value) {
  const s = String(value == null ? "" : value).trim();
  if (WORKSPACE_CAMPAIGN_TYPES.includes(s)) return s;
  const lower = s.toLowerCase();
  if (lower.includes("local council") || lower === "local") return WORKSPACE_CAMPAIGN_TYPES[0];
  if (lower.includes("parliament")) return WORKSPACE_CAMPAIGN_TYPES[1];
  if (lower.includes("president")) return WORKSPACE_CAMPAIGN_TYPES[2];
  return WORKSPACE_CAMPAIGN_TYPES[0];
}

const UNSCOPED_COLLECTIONS = new Set([
  MONITORS_COLLECTION,
  VOTER_LIST_SHARES_COLLECTION,
  PLEDGED_REPORT_SHARES_COLLECTION,
  EVENT_PARTICIPANT_SHARES_COLLECTION,
]);

function normalizeCampaignWorkspaceId(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (!raw) return LEGACY_CAMPAIGN_WORKSPACE_ID;
  const cleaned = raw
    .replace(/[^a-z0-9-_ ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || LEGACY_CAMPAIGN_WORKSPACE_ID;
}

export function getActiveCampaignWorkspaceId() {
  try {
    return normalizeCampaignWorkspaceId(
      localStorage.getItem(ACTIVE_CAMPAIGN_WORKSPACE_STORAGE_KEY)
    );
  } catch (_) {
    return LEGACY_CAMPAIGN_WORKSPACE_ID;
  }
}

export function setActiveCampaignWorkspaceId(workspaceId) {
  const normalized = normalizeCampaignWorkspaceId(workspaceId);
  try {
    localStorage.setItem(ACTIVE_CAMPAIGN_WORKSPACE_STORAGE_KEY, normalized);
  } catch (_) {}
  return normalized;
}

export const firebaseInitPromise = (async () => {
  try {
    const appMod = await import(`${SDK_BASE}/firebase-app.js`);
    const authMod = await import(`${SDK_BASE}/firebase-auth.js`);
    const app = appMod.getApps().length
      ? appMod.getApp()
      : appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    // Localize Auth UI, reCAPTCHA, and SMS where supported (Firebase Auth i18n).
    if (typeof authMod.useDeviceLanguage === "function") {
      authMod.useDeviceLanguage(auth);
    } else {
      try {
        const lang =
          typeof navigator !== "undefined" && navigator.language
            ? String(navigator.language).split("-")[0]
            : "en";
        auth.languageCode = lang;
      } catch (_) {}
    }
    // Opt-in: localStorage.setItem("firebaseAuthAppVerificationDisabled","true") — only for Firebase *test* phone flows per docs.
    try {
      if (
        typeof localStorage !== "undefined" &&
        localStorage.getItem("firebaseAuthAppVerificationDisabled") === "true" &&
        auth.settings
      ) {
        auth.settings.appVerificationDisabledForTesting = true;
        console.warn(
          "[Firebase] appVerificationDisabledForTesting is on (localStorage firebaseAuthAppVerificationDisabled). Use only with console test numbers."
        );
      }
    } catch (_) {}

    let db = null;
    let getFirestoreCampaignConfig = () => Promise.resolve(null);
    let setFirestoreCampaignConfig = () => Promise.resolve();
    let updateFirestoreCampaignConfig = () => Promise.resolve();
    let deleteFirestoreCampaignConfig = () => Promise.resolve();
    let getVoteMonitoringEnabled = () => Promise.resolve(true);
    let setVoteMonitoringEnabled = () => Promise.resolve();
    let getMonitorByToken = () => Promise.resolve(null);
    let setMonitorDoc = () => Promise.resolve();
    let getVotedForMonitor = () => Promise.resolve([]);
    let setVotedForMonitor = () => Promise.resolve();
    let deleteVotedForMonitor = () => Promise.resolve();
    let onVotedSnapshotForMonitor = () => noopUnsubscribe;
    let getBallotSessionFs = async () => ({ status: "open", pauseReason: "", pausedAt: "" });
    let setBallotSessionFs = async () => {};
    let onBallotSessionSnapshotFs = () => noopUnsubscribe;
    let deleteMonitorDoc = () => Promise.resolve();

    // Firestore-backed collections for core data (default to no-op so callers can always call these safely)
    let getAllVotersFs = async () => [];
    let setVoterFs = async () => {};
    /** Write many voter docs using Firestore batches (500 ops/batch) — used for CSV import. */
    let setVotersBatchFs = async () => {};
    /** Merge only `referendumVote` on the voter doc (small payload, reliable field write). */
    let setVoterReferendumVoteFs = async () => {};
    /** Merge only `referendumNotes` on the voter doc. */
    let setVoterReferendumNotesFs = async () => {};
    /** Merge one key inside `candidatePledges` without replacing the whole map (avoids losing other candidates). */
    let setVoterCandidatePledgeFs = async () => {};
    let setVoterVotedAtFs = async () => {};
    /** Remove `votedAt` from the voter doc (undo from vote marking). Requires signed-in user per rules. */
    let clearVoterVotedAtFs = async () => {};
    let deleteVoterFs = async () => {};
    /** Delete every document in the voters collection using Firestore batches (max 500 writes/batch). */
    let deleteAllVotersFs = async () => {};
    let onVotersSnapshotFs = () => noopUnsubscribe;

    let getAllAgentsFs = async () => [];
    let setAgentFs = async () => {};
    let deleteAgentFs = async () => {};
    let onAgentsSnapshotFs = () => noopUnsubscribe;

    // Candidates collection helpers (filled in when Firestore loads)
    let getAllCandidatesFs = async () => [];
    let setCandidateFs = async () => {};
    let deleteCandidateFs = async () => {};
    let onCandidatesSnapshotFs = () => noopUnsubscribe;

    // Events collection helpers
    let getAllEventsFs = async () => [];
    let setEventFs = async () => {};
    let deleteEventFs = async () => {};
    let onEventsSnapshotFs = () => noopUnsubscribe;

    let getAllTransportTripsFs = async () => [];
    let setTransportTripFs = async () => {};
    let deleteTransportTripFs = async () => {};
    let onTransportTripsSnapshotFs = () => noopUnsubscribe;

    let getAllTransportRoutesFs = async () => [];
    let setTransportRouteFs = async () => {};
    let deleteTransportRouteFs = async () => {};
    let onTransportRoutesSnapshotFs = () => noopUnsubscribe;

    let getAllVoterListsFs = async () => [];
    let getVoterListFs = async () => null;
    let getVoterListFromServerFs = async () => null;
    let setVoterListFs = async () => {};
    let deleteVoterListFs = async () => {};
    let onVoterListsSnapshotFs = () => noopUnsubscribe;
    let getListShareByToken = async () => null;
    let setListShareFs = async () => {};
    let getPledgedReportShareByTokenFs = async () => null;
    let setPledgedReportShareFs = async () => {};
    let getEventParticipantShareByTokenFs = async () => null;
    let setEventParticipantShareFs = async () => {};
    let getEventParticipantRowsFs = async () => [];
    let getEventParticipantRowsFromServerFs = async () => [];
    let setEventParticipantRowFs = async () => {};
    let deleteEventParticipantRowFs = async () => {};
    let onEventParticipantRowsSnapshotFs = () => noopUnsubscribe;
    let getCampaignUserByEmailFs = async () => null;
    let getAllCampaignUsersFs = async () => [];
    let setCampaignUserFs = async () => {};
    let deleteCampaignUserFs = async () => {};
    let setListShareStatusFs = async () => {};
    let getListShareStatusFs = async () => [];
    let onListShareStatusSnapshotFs = () => noopUnsubscribe;
    let getListStatusByVoterIdFs = async () => [];

    let listCampaignArchivesFs = async () => [];
    let pruneDuplicateCampaignArchivesFs = async (_preferKeepId) => {};
    let archiveCampaignSnapshotFs = async () => ({
      ok: false,
      error: "Firestore not initialized",
    });
    let getArchivedVotersFs = async () => [];
    let getArchivedArchiveRootFs = async () => null;
    let getArchivedSegmentFs = async () => [];
    let getArchivedMonitorsFs = async () => [];
    let deleteCampaignArchiveFs = async () => {};
    let wipeActiveCampaignDataFs = async () => ({
      ok: false,
      error: "Firestore not initialized",
    });
    let listCampaignWorkspacesFs = async () => [
      {
        id: LEGACY_CAMPAIGN_WORKSPACE_ID,
        name: "Default campaign",
        campaignType: normalizeWorkspaceCampaignType(WORKSPACE_CAMPAIGN_TYPES[0]),
        constituency: "",
        island: "",
      },
    ];
    let createCampaignWorkspaceFs = async (_payload) => ({
      ok: false,
      error: "Firestore not initialized",
    });
    let updateCampaignWorkspaceDetailsFs = async () => ({
      ok: false,
      error: "Firestore not initialized",
    });
    let setActiveCampaignWorkspaceFs = async (workspaceId) => ({
      ok: true,
      workspaceId: setActiveCampaignWorkspaceId(workspaceId),
    });

    try {
      const firestoreMod = await import(`${SDK_BASE}/firebase-firestore.js`);
      // Prefer long-polling over WebChannel when QUIC/WebChannel fails (e.g. net::ERR_QUIC_PROTOCOL_ERROR,
      // Listen 400) on some networks, VPNs, or proxies. Must use initializeFirestore (not getFirestore)
      // so this runs before any Firestore use.
      db = firestoreMod.initializeFirestore(app, {
        experimentalForceLongPolling: true,
        ignoreUndefinedProperties: true,
      });
      const getScopeId = () => getActiveCampaignWorkspaceId();
      const scopedPath = (...segments) => {
        if (segments.length && UNSCOPED_COLLECTIONS.has(String(segments[0] || ""))) {
          return segments;
        }
        const scopeId = getScopeId();
        if (scopeId === LEGACY_CAMPAIGN_WORKSPACE_ID) return segments;
        return [CAMPAIGN_WORKSPACES_COLLECTION, scopeId, ...segments];
      };
      const scopedCollection = (...segments) =>
        firestoreMod.collection(db, ...scopedPath(...segments));
      const scopedDoc = (...segments) => firestoreMod.doc(db, ...scopedPath(...segments));
      const globalCollection = (...segments) => firestoreMod.collection(db, ...segments);
      const globalDoc = (...segments) => firestoreMod.doc(db, ...segments);
      /** Avoid "Uncaught Error in snapshot listener" when rules/auth deny; log once per path. */
      const onSnapshotSafe = (ref, onNext, label) =>
        firestoreMod.onSnapshot(ref, onNext, (err) => {
          console.warn(`[Firestore] listener ${label}:`, err?.code || "", err?.message || err);
        });
      listCampaignWorkspacesFs = async () => {
        try {
          let defaultCampaignType = normalizeWorkspaceCampaignType(WORKSPACE_CAMPAIGN_TYPES[0]);
          let defaultLabel = "Default campaign";
          let defaultConstituency = "";
          let defaultIsland = "";
          try {
            const defaultCfgRef = firestoreMod.doc(db, CAMPAIGN_CONFIG_COLLECTION, CAMPAIGN_CONFIG_DOC);
            const defaultSnap = await firestoreMod.getDoc(defaultCfgRef);
            if (defaultSnap && defaultSnap.exists()) {
              const d = defaultSnap.data() || {};
              defaultCampaignType = normalizeWorkspaceCampaignType(d.campaignType);
              defaultConstituency = String(d.constituency || "").trim();
              defaultIsland = String(d.island || "").trim();
              const cn = String(d.campaignName || "").trim();
              if (cn) defaultLabel = cn;
            }
          } catch (_) {}

          const col = globalCollection(CAMPAIGN_WORKSPACES_COLLECTION);
          const snap = await firestoreMod.getDocs(col);
          const out = snap.docs.map((d) => {
            const data = d.data() || {};
            return {
              id: d.id,
              ...data,
              campaignType: normalizeWorkspaceCampaignType(data.campaignType),
              constituency: String(data.constituency || "").trim(),
              island: String(data.island || "").trim(),
            };
          });
          out.sort((a, b) =>
            String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, {
              sensitivity: "base",
            })
          );
          return [
            {
              id: LEGACY_CAMPAIGN_WORKSPACE_ID,
              name: defaultLabel,
              campaignType: defaultCampaignType,
              constituency: defaultConstituency,
              island: defaultIsland,
            },
            ...out,
          ];
        } catch (_) {
          return [
            {
              id: LEGACY_CAMPAIGN_WORKSPACE_ID,
              name: "Default campaign",
              campaignType: normalizeWorkspaceCampaignType(WORKSPACE_CAMPAIGN_TYPES[0]),
              constituency: "",
              island: "",
            },
          ];
        }
      };
      createCampaignWorkspaceFs = async (payload) => {
        try {
          const proposedId = normalizeCampaignWorkspaceId(payload?.id || payload?.name);
          if (!proposedId || proposedId === LEGACY_CAMPAIGN_WORKSPACE_ID) {
            return { ok: false, error: "Please choose a different campaign id." };
          }
          const name = String(payload?.name || proposedId).trim() || proposedId;
          const campaignType = normalizeWorkspaceCampaignType(payload?.campaignType);
          const constituency = String(payload?.constituency != null ? payload.constituency : "").trim();
          const island = String(payload?.island != null ? payload.island : "").trim();
          const ref = globalDoc(CAMPAIGN_WORKSPACES_COLLECTION, proposedId);
          const existing = await firestoreMod.getDoc(ref);
          if (existing && existing.exists()) {
            return { ok: false, error: "Campaign id already exists." };
          }
          const nowIso = new Date().toISOString();
          await firestoreMod.setDoc(ref, {
            id: proposedId,
            name,
            campaignType,
            constituency,
            island,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
          const cfgRef = firestoreMod.doc(
            db,
            CAMPAIGN_WORKSPACES_COLLECTION,
            proposedId,
            CAMPAIGN_CONFIG_COLLECTION,
            CAMPAIGN_CONFIG_DOC
          );
          await firestoreMod.setDoc(
            cfgRef,
            {
              campaignName: name,
              campaignType,
              constituency,
              island,
              showPledgesNav: true,
              voteMonitoringEnabled: false,
              monitorShareTokens: [],
            },
            { merge: true }
          );
          return { ok: true, workspaceId: proposedId };
        } catch (e) {
          return { ok: false, error: String(e?.message || e || "Could not create campaign") };
        }
      };
      updateCampaignWorkspaceDetailsFs = async (payload = {}) => {
        const wid = normalizeCampaignWorkspaceId(payload.workspaceId);
        const ct =
          payload.campaignType != null
            ? normalizeWorkspaceCampaignType(payload.campaignType)
            : null;
        const constituency =
          payload.constituency != null ? String(payload.constituency).trim() : null;
        const island = payload.island != null ? String(payload.island).trim() : null;
        try {
          const cfgPatch = {};
          if (ct != null) cfgPatch.campaignType = ct;
          if (constituency != null) cfgPatch.constituency = constituency;
          if (island != null) cfgPatch.island = island;

          if (wid === LEGACY_CAMPAIGN_WORKSPACE_ID) {
            const cfgRef = firestoreMod.doc(db, CAMPAIGN_CONFIG_COLLECTION, CAMPAIGN_CONFIG_DOC);
            const snap = await firestoreMod.getDoc(cfgRef);
            const prev = snap && snap.exists() ? snap.data() || {} : {};
            await firestoreMod.setDoc(cfgRef, { ...prev, ...cfgPatch }, { merge: true });
            return { ok: true, workspaceId: wid };
          }
          const wref = globalDoc(CAMPAIGN_WORKSPACES_COLLECTION, wid);
          const wsnap = await firestoreMod.getDoc(wref);
          if (!wsnap || !wsnap.exists()) {
            return { ok: false, error: "Campaign workspace not found." };
          }
          const wPatch = { updatedAt: new Date().toISOString() };
          if (ct != null) wPatch.campaignType = ct;
          if (constituency != null) wPatch.constituency = constituency;
          if (island != null) wPatch.island = island;
          await firestoreMod.setDoc(wref, wPatch, { merge: true });
          const cfgRef = firestoreMod.doc(
            db,
            CAMPAIGN_WORKSPACES_COLLECTION,
            wid,
            CAMPAIGN_CONFIG_COLLECTION,
            CAMPAIGN_CONFIG_DOC
          );
          const csnap = await firestoreMod.getDoc(cfgRef);
          const cprev = csnap && csnap.exists() ? csnap.data() || {} : {};
          await firestoreMod.setDoc(cfgRef, { ...cprev, ...cfgPatch }, { merge: true });
          return { ok: true, workspaceId: wid };
        } catch (e) {
          return { ok: false, error: String(e?.message || e || "Could not update workspace") };
        }
      };
      setActiveCampaignWorkspaceFs = async (workspaceId) => {
        const next = normalizeCampaignWorkspaceId(workspaceId);
        if (next === LEGACY_CAMPAIGN_WORKSPACE_ID) {
          setActiveCampaignWorkspaceId(next);
          return { ok: true, workspaceId: next };
        }
        try {
          const ref = globalDoc(CAMPAIGN_WORKSPACES_COLLECTION, next);
          const snap = await firestoreMod.getDoc(ref);
          if (!snap || !snap.exists()) {
            return { ok: false, error: "Campaign not found." };
          }
          setActiveCampaignWorkspaceId(next);
          return { ok: true, workspaceId: next };
        } catch (e) {
          return { ok: false, error: String(e?.message || e || "Could not switch campaign") };
        }
      };
      const configRef = scopedDoc( CAMPAIGN_CONFIG_COLLECTION, CAMPAIGN_CONFIG_DOC);
      // Read
      getFirestoreCampaignConfig = async () => {
        const snap = await firestoreMod.getDoc(configRef);
        if (snap && snap.exists()) return snap.data();
        return null;
      };
      getVoteMonitoringEnabled = async () => {
        const config = await getFirestoreCampaignConfig();
        return config && config.voteMonitoringEnabled === true;
      };
      setVoteMonitoringEnabled = async (enabled) => {
        const config = (await getFirestoreCampaignConfig()) || {};
        await firestoreMod.setDoc(configRef, { ...config, voteMonitoringEnabled: !!enabled }, { merge: true });
      };
      setFirestoreCampaignConfig = (data) =>
        firestoreMod.setDoc(configRef, data || {}, { merge: true });
      updateFirestoreCampaignConfig = (data) => {
        if (!data || typeof data !== "object") return Promise.resolve();
        return firestoreMod.updateDoc(configRef, data);
      };
      deleteFirestoreCampaignConfig = () => firestoreMod.deleteDoc(configRef);

      getMonitorByToken = async (token) => {
        if (!token) return null;
        const ref = scopedDoc( MONITORS_COLLECTION, String(token));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setMonitorDoc = async (token, data) => {
        if (!token) return;
        const ref = scopedDoc( MONITORS_COLLECTION, String(token));
        await firestoreMod.setDoc(ref, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
      };
      getVotedForMonitor = async (token) => {
        if (!token) return [];
        const ref = scopedCollection( MONITORS_COLLECTION, String(token), "voted");
        const snap = await firestoreMod.getDocs(ref);
        return snap.docs.map((d) => ({ voterId: d.id, timeMarked: d.data().timeMarked }));
      };
      setVotedForMonitor = async (token, voterId, timeMarked) => {
        if (!token || !voterId) return;
        const ref = scopedDoc(
          MONITORS_COLLECTION,
          String(token),
          "voted",
          String(voterId)
        );
        await firestoreMod.setDoc(ref, {
          timeMarked: timeMarked || new Date().toISOString(),
        });
      };
      deleteVotedForMonitor = async (token, voterId) => {
        if (!token || !voterId) return;
        const ref = scopedDoc(
          MONITORS_COLLECTION,
          String(token),
          "voted",
          String(voterId)
        );
        await firestoreMod.deleteDoc(ref);
      };
      onVotedSnapshotForMonitor = (token, handler) => {
        if (!token || typeof handler !== "function") return noopUnsubscribe;
        const ref = scopedCollection( MONITORS_COLLECTION, String(token), "voted");
        return onSnapshotSafe(
          ref,
          (snap) => {
            const entries = snap.docs.map((d) => ({ voterId: d.id, timeMarked: d.data().timeMarked }));
            handler(entries);
          },
          `monitors/${String(token)}/voted`
        );
      };

      const BALLOT_SESSION_DOC = "settings";
      const ballotSessionDocRef = (token) =>
        scopedDoc(
          MONITORS_COLLECTION,
          String(token),
          "ballotSession",
          BALLOT_SESSION_DOC
        );
      getBallotSessionFs = async (token) => {
        if (!token) return { status: "open", pauseReason: "", pausedAt: "" };
        const ref = ballotSessionDocRef(token);
        let snap;
        try {
          // Prefer server so a new browser/session never shows "open" from empty local cache
          // while another device has already set paused/closed.
          if (typeof firestoreMod.getDocFromServer === "function") {
            snap = await firestoreMod.getDocFromServer(ref);
          } else {
            snap = await firestoreMod.getDoc(ref);
          }
        } catch (_) {
          snap = await firestoreMod.getDoc(ref);
        }
        if (!snap.exists()) return { status: "open", pauseReason: "", pausedAt: "" };
        const d = snap.data() || {};
        const status =
          d.status === "paused" || d.status === "closed" ? d.status : "open";
        return {
          status,
          pauseReason: String(d.pauseReason || ""),
          pausedAt: String(d.pausedAt || ""),
        };
      };
      setBallotSessionFs = async (token, data) => {
        if (!token || !data || typeof data !== "object") return;
        const status =
          data.status === "paused" || data.status === "closed" ? data.status : "open";
        const pauseReason = status === "paused" ? String(data.pauseReason || "") : "";
        const pausedAt =
          status === "paused"
            ? String(data.pausedAt || new Date().toISOString())
            : "";
        await firestoreMod.setDoc(ballotSessionDocRef(token), {
          status,
          pauseReason,
          pausedAt,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      };
      onBallotSessionSnapshotFs = (token, handler) => {
        if (!token || typeof handler !== "function") return noopUnsubscribe;
        const ref = ballotSessionDocRef(token);
        const label = `monitors/${String(token)}/ballotSession`;
        const onNext = (snap) => {
          if (!snap.exists()) {
            handler({ status: "open", pauseReason: "", pausedAt: "" });
            return;
          }
          const d = snap.data() || {};
          const status =
            d.status === "paused" || d.status === "closed" ? d.status : "open";
          handler({
            status,
            pauseReason: String(d.pauseReason || ""),
            pausedAt: String(d.pausedAt || ""),
          });
        };
        const onErr = (err) => {
          console.warn(`[Firestore] listener ${label}:`, err?.code || "", err?.message || err);
        };
        // includeMetadataChanges: emit when cache ↔ server reconciles so UI updates without refresh.
        try {
          return firestoreMod.onSnapshot(
            ref,
            { includeMetadataChanges: true },
            onNext,
            onErr
          );
        } catch (_) {
          return firestoreMod.onSnapshot(ref, onNext, onErr);
        }
      };

      deleteMonitorDoc = async (token) => {
        if (!token) return;
        const ref = scopedDoc( MONITORS_COLLECTION, String(token));
        await firestoreMod.deleteDoc(ref);
      };

      // Voters collection
      const VOTERS_COLLECTION = "voters";
      const votersColRef = scopedCollection( VOTERS_COLLECTION);

      /** Page through the whole collection (Firestore has per-response limits on large sets). */
      const fetchAllVoterDocs = async (getDocsImpl) => {
        const PAGE = 500;
        const out = [];
        let lastDoc = null;
        try {
          const docId = firestoreMod.documentId();
          for (;;) {
            const parts = [firestoreMod.orderBy(docId), firestoreMod.limit(PAGE)];
            if (lastDoc) parts.push(firestoreMod.startAfter(lastDoc));
            const q = firestoreMod.query(votersColRef, ...parts);
            const snap = await getDocsImpl(q);
            if (snap.empty) break;
            out.push(...snap.docs);
            if (snap.docs.length < PAGE) break;
            lastDoc = snap.docs[snap.docs.length - 1];
          }
        } catch (err) {
          console.warn("[Firestore] Paged voters fetch failed; trying single collection read", err?.message || err);
          const snap = await getDocsImpl(votersColRef);
          return snap.docs || [];
        }
        return out;
      };

      /**
       * @param {{ fromServer?: boolean }} [opts] Pass `{ fromServer: true }` to prefer a server read (e.g. CSV export).
       * Falls back to cache if the server request fails (offline, cold start, etc.).
       */
      getAllVotersFs = async (opts) => {
        const fromServer = opts && opts.fromServer === true;
        const mapSnaps = (snaps) =>
          snaps.map((d) => ({ ...(d.data() || {}), id: d.id }));
        if (fromServer && typeof firestoreMod.getDocsFromServer === "function") {
          try {
            const snaps = await fetchAllVoterDocs(firestoreMod.getDocsFromServer.bind(firestoreMod));
            return mapSnaps(snaps);
          } catch (err) {
            console.warn("[Firestore] getAllVotersFs fromServer failed; using cache", err?.code || "", err?.message || err);
          }
        }
        const snaps = await fetchAllVoterDocs(firestoreMod.getDocs.bind(firestoreMod));
        return mapSnaps(snaps);
      };

      setVoterFs = async (voter) => {
        if (!voter || !voter.id) return;
        const ref = scopedDoc( VOTERS_COLLECTION, String(voter.id));
        await firestoreMod.setDoc(ref, voter, { merge: true });
      };

      setVoterCandidatePledgeFs = async (voterId, candidateId, status) => {
        if (voterId == null || voterId === "") return;
        const cid = String(candidateId);
        const s =
          status === "yes" || status === "no" || status === "undecided" ? status : "undecided";
        const ref = scopedDoc( VOTERS_COLLECTION, String(voterId));
        const fieldPath = `candidatePledges.${cid}`;
        await firestoreMod.updateDoc(ref, { [fieldPath]: s });
      };

      setVotersBatchFs = async (voters) => {
        if (!Array.isArray(voters) || voters.length === 0) return;
        const sanitize = (v) => {
          const o = {};
          for (const [k, val] of Object.entries(v || {})) {
            if (val !== undefined) o[k] = val;
          }
          return o;
        };
        if (typeof firestoreMod.writeBatch === "function") {
          const MAX_BATCH = 500;
          for (let i = 0; i < voters.length; i += MAX_BATCH) {
            const batch = firestoreMod.writeBatch(db);
            voters.slice(i, i + MAX_BATCH).forEach((v) => {
              if (!v || v.id == null || v.id === "") return;
              const ref = scopedDoc( VOTERS_COLLECTION, String(v.id));
              batch.set(ref, sanitize(v), { merge: true });
            });
            await batch.commit();
          }
          return;
        }
        const chunkSize = 40;
        for (let i = 0; i < voters.length; i += chunkSize) {
          await Promise.all(
            voters.slice(i, i + chunkSize).map((v) => {
              if (!v || !v.id) return Promise.resolve();
              const ref = scopedDoc( VOTERS_COLLECTION, String(v.id));
              return firestoreMod.setDoc(ref, sanitize(v), { merge: true });
            })
          );
        }
      };

      setVoterReferendumVoteFs = async (voterId, referendumVote) => {
        if (voterId == null || voterId === "") return;
        const ref = scopedDoc( VOTERS_COLLECTION, String(voterId));
        const next =
          referendumVote === "yes" || referendumVote === "no" ? referendumVote : "undecided";
        await firestoreMod.setDoc(ref, { referendumVote: next }, { merge: true });
      };

      setVoterReferendumNotesFs = async (voterId, referendumNotes) => {
        if (voterId == null || voterId === "") return;
        const ref = scopedDoc( VOTERS_COLLECTION, String(voterId));
        const text = referendumNotes == null ? "" : String(referendumNotes);
        await firestoreMod.setDoc(ref, { referendumNotes: text }, { merge: true });
      };

      setVoterVotedAtFs = async (voterId, timeMarked) => {
        if (!voterId) return;
        const ref = scopedDoc( VOTERS_COLLECTION, String(voterId));
        await firestoreMod.setDoc(ref, { votedAt: timeMarked || new Date().toISOString() }, { merge: true });
      };

      clearVoterVotedAtFs = async (voterId) => {
        if (!voterId) return;
        const ref = scopedDoc( VOTERS_COLLECTION, String(voterId));
        const del = firestoreMod.deleteField && firestoreMod.deleteField();
        if (del !== undefined) {
          await firestoreMod.updateDoc(ref, { votedAt: del });
        } else {
          await firestoreMod.setDoc(ref, { votedAt: "" }, { merge: true });
        }
      };

      deleteVoterFs = async (id) => {
        if (!id) return;
        const ref = scopedDoc( VOTERS_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };

      deleteAllVotersFs = async () => {
        const docs = await fetchAllVoterDocs(firestoreMod.getDocs.bind(firestoreMod));
        if (typeof firestoreMod.writeBatch === "function") {
          const MAX_BATCH = 500;
          for (let i = 0; i < docs.length; i += MAX_BATCH) {
            const batch = firestoreMod.writeBatch(db);
            docs.slice(i, i + MAX_BATCH).forEach((docSnap) => {
              batch.delete(docSnap.ref);
            });
            await batch.commit();
          }
          return;
        }
        const chunkSize = 25;
        for (let i = 0; i < docs.length; i += chunkSize) {
          await Promise.all(
            docs.slice(i, i + chunkSize).map((docSnap) => firestoreMod.deleteDoc(docSnap.ref))
          );
        }
      };

      onVotersSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return onSnapshotSafe(
          votersColRef,
          (snap) => {
            const items = snap.docs.map((d) => ({ ...(d.data() || {}), id: d.id }));
            handler(items);
          },
          "voters"
        );
      };

      // Agents collection
      const AGENTS_COLLECTION = "agents";
      const agentsColRef = scopedCollection( AGENTS_COLLECTION);

      getAllAgentsFs = async () => {
        const snap = await firestoreMod.getDocs(agentsColRef);
        // Document id must win — stored `id` field in data would overwrite d.id and break delete/update.
        return snap.docs.map((d) => ({ ...(d.data() || {}), id: d.id }));
      };

      setAgentFs = async (agent) => {
        if (!agent || agent.id == null || agent.id === "") return;
        const docId = String(agent.id).trim();
        const ref = scopedDoc( AGENTS_COLLECTION, docId);
        // Do not store `id` in document body — only the path id is canonical (avoids mismatch with delete/read).
        const { id: _drop, ...rest } = agent;
        const payload = {};
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) payload[key] = value;
        }
        await firestoreMod.setDoc(ref, payload, { merge: true });
      };

      deleteAgentFs = async (id) => {
        if (!id) return;
        const ref = scopedDoc( AGENTS_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };

      onAgentsSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return onSnapshotSafe(
          agentsColRef,
          (snap) => {
            const items = snap.docs.map((d) => ({ ...(d.data() || {}), id: d.id }));
            handler(items);
          },
          "agents"
        );
      };

      // Candidates collection
      const CANDIDATES_COLLECTION = "candidates";
      const candidatesColRef = scopedCollection( CANDIDATES_COLLECTION);

      getAllCandidatesFs = async () => {
        const snap = await firestoreMod.getDocs(candidatesColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };

      setCandidateFs = async (candidate) => {
        if (!candidate || candidate.id == null || candidate.id === "") return;
        const ref = scopedDoc( CANDIDATES_COLLECTION, String(candidate.id));
        // Firestore does not accept undefined; strip or replace so writes succeed.
        const data = {};
        for (const [key, value] of Object.entries(candidate)) {
          if (value !== undefined) data[key] = value;
        }
        await firestoreMod.setDoc(ref, data, { merge: true });
      };

      deleteCandidateFs = async (id) => {
        if (!id) return;
        const ref = scopedDoc( CANDIDATES_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };

      onCandidatesSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return onSnapshotSafe(
          candidatesColRef,
          (snap) => {
            const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            handler(items);
          },
          "candidates"
        );
      };

      // Voter lists (saved lists)
      const voterListsColRef = scopedCollection( VOTER_LISTS_COLLECTION);
      getAllVoterListsFs = async () => {
        const snap = await firestoreMod.getDocs(voterListsColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };
      getVoterListFs = async (listId) => {
        if (!listId) return null;
        const ref = scopedDoc( VOTER_LISTS_COLLECTION, String(listId));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      getVoterListFromServerFs = async (listId) => {
        if (!listId) return null;
        const ref = scopedDoc( VOTER_LISTS_COLLECTION, String(listId));
        const getDocFromServer = firestoreMod.getDocFromServer || firestoreMod.getDoc;
        const snap = await getDocFromServer(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setVoterListFs = async (list) => {
        if (!list || !list.id) return;
        const ref = scopedDoc( VOTER_LISTS_COLLECTION, String(list.id));
        const data = { ...list, updatedAt: new Date().toISOString() };
        delete data.id;
        await firestoreMod.setDoc(ref, data, { merge: true });
      };
      deleteVoterListFs = async (listId) => {
        if (!listId) return;
        const ref = scopedDoc( VOTER_LISTS_COLLECTION, String(listId));
        await firestoreMod.deleteDoc(ref);
      };
      onVoterListsSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return onSnapshotSafe(
          voterListsColRef,
          (snap) => {
            handler(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          },
          "voterLists"
        );
      };

      // Shared list (candidate link) – doc id = token
      getListShareByToken = async (token) => {
        if (!token) return null;
        const ref = scopedDoc( VOTER_LIST_SHARES_COLLECTION, String(token));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setListShareFs = async (token, data) => {
        if (!token) return;
        const ref = scopedDoc( VOTER_LIST_SHARES_COLLECTION, String(token));
        await firestoreMod.setDoc(ref, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
      };
      getPledgedReportShareByTokenFs = async (token) => {
        if (!token) return null;
        const ref = scopedDoc( PLEDGED_REPORT_SHARES_COLLECTION, String(token));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setPledgedReportShareFs = async (token, data) => {
        if (!token) return;
        const ref = scopedDoc( PLEDGED_REPORT_SHARES_COLLECTION, String(token));
        await firestoreMod.setDoc(ref, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
      };
      // Event participants share (doc id = token, collaborative row edits in subcollection)
      getEventParticipantShareByTokenFs = async (token) => {
        if (!token) return null;
        const ref = scopedDoc( EVENT_PARTICIPANT_SHARES_COLLECTION, String(token));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setEventParticipantShareFs = async (token, data) => {
        if (!token) return;
        const ref = scopedDoc( EVENT_PARTICIPANT_SHARES_COLLECTION, String(token));
        await firestoreMod.setDoc(ref, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
      };
      getEventParticipantRowsFs = async (token) => {
        if (!token) return [];
        const ref = scopedCollection( EVENT_PARTICIPANT_SHARES_COLLECTION, String(token), "rows");
        const snap = await firestoreMod.getDocs(ref);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };
      getEventParticipantRowsFromServerFs = async (token) => {
        if (!token) return [];
        const ref = scopedCollection( EVENT_PARTICIPANT_SHARES_COLLECTION, String(token), "rows");
        const getDocsFromServer = firestoreMod.getDocsFromServer || firestoreMod.getDocs;
        const snap = await getDocsFromServer(ref);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };
      setEventParticipantRowFs = async (token, rowId, data) => {
        if (!token || !rowId) return;
        const ref = scopedDoc(
          EVENT_PARTICIPANT_SHARES_COLLECTION,
          String(token),
          "rows",
          String(rowId)
        );
        await firestoreMod.setDoc(ref, { ...(data || {}), updatedAt: new Date().toISOString() }, { merge: true });
      };
      deleteEventParticipantRowFs = async (token, rowId) => {
        if (!token || !rowId) return;
        const ref = scopedDoc(
          EVENT_PARTICIPANT_SHARES_COLLECTION,
          String(token),
          "rows",
          String(rowId)
        );
        await firestoreMod.deleteDoc(ref);
      };
      onEventParticipantRowsSnapshotFs = (token, handler) => {
        if (!token || typeof handler !== "function") return noopUnsubscribe;
        const ref = scopedCollection( EVENT_PARTICIPANT_SHARES_COLLECTION, String(token), "rows");
        return onSnapshotSafe(
          ref,
          (snap) => {
            handler(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          },
          `eventParticipantShares/${String(token)}/rows`
        );
      };
      const campaignUsersColRef = scopedCollection( CAMPAIGN_USERS_COLLECTION);
      getCampaignUserByEmailFs = async (email) => {
        if (!email) return null;
        const id = String(email).toLowerCase().trim();
        if (!id) return null;
        const ref = scopedDoc( CAMPAIGN_USERS_COLLECTION, id);
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { email: id, ...snap.data() };
        return null;
      };
      getAllCampaignUsersFs = async () => {
        const snap = await firestoreMod.getDocs(campaignUsersColRef);
        return snap.docs.map((d) => ({ email: d.id, ...d.data() }));
      };
      setCampaignUserFs = async (user) => {
        if (!user || !user.email) return;
        const id = String(user.email).toLowerCase().trim();
        if (!id) return;
        const ref = scopedDoc( CAMPAIGN_USERS_COLLECTION, id);
        await firestoreMod.setDoc(ref, {
          email: id,
          displayName: user.displayName || "",
          role: user.role === "candidate" ? "candidate" : "admin",
          candidateId: user.candidateId != null ? String(user.candidateId) : "",
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      };
      deleteCampaignUserFs = async (email) => {
        if (!email) return;
        const id = String(email).toLowerCase().trim();
        if (!id) return;
        const ref = scopedDoc( CAMPAIGN_USERS_COLLECTION, id);
        await firestoreMod.deleteDoc(ref);
      };
      setListShareStatusFs = async (token, voterId, status) => {
        if (!token || !voterId) return;
        const ref = scopedDoc( VOTER_LIST_SHARES_COLLECTION, String(token), "status", String(voterId));
        await firestoreMod.setDoc(ref, { status: status || "", updatedAt: new Date().toISOString() });
      };
      getListShareStatusFs = async (token) => {
        if (!token) return [];
        const ref = scopedCollection( VOTER_LIST_SHARES_COLLECTION, String(token), "status");
        const snap = await firestoreMod.getDocs(ref);
        return snap.docs.map((d) => ({ voterId: d.id, ...d.data() }));
      };
      onListShareStatusSnapshotFs = (token, handler) => {
        if (!token || typeof handler !== "function") return noopUnsubscribe;
        const ref = scopedCollection( VOTER_LIST_SHARES_COLLECTION, String(token), "status");
        return onSnapshotSafe(
          ref,
          (snap) => {
            handler(snap.docs.map((d) => ({ voterId: d.id, ...d.data() })));
          },
          `voterListShares/${String(token)}/status`
        );
      };
      getListStatusByVoterIdFs = async (voterId) => {
        const lists = await firestoreMod.getDocs(voterListsColRef);
        const out = [];
        for (const listDoc of lists.docs) {
          const list = listDoc.data();
          const shareToken = list.shareToken;
          if (!shareToken) continue;
          const statusRef = scopedDoc( VOTER_LIST_SHARES_COLLECTION, shareToken, "status", String(voterId));
          const statusSnap = await firestoreMod.getDoc(statusRef);
          if (statusSnap && statusSnap.exists()) {
            out.push({ listId: listDoc.id, listName: list.name, shareToken, ...statusSnap.data() });
          }
        }
        return out;
      };

      // Events collection
      const eventsColRef = scopedCollection( EVENTS_COLLECTION);
      getAllEventsFs = async () => {
        const snap = await firestoreMod.getDocs(eventsColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };
      setEventFs = async (id, data) => {
        if (!id) return;
        const ref = scopedDoc( EVENTS_COLLECTION, String(id));
        await firestoreMod.setDoc(ref, { ...data }, { merge: true });
      };
      deleteEventFs = async (id) => {
        if (!id) return;
        const ref = scopedDoc( EVENTS_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };
      onEventsSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return onSnapshotSafe(
          eventsColRef,
          (snap) => {
            handler(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          },
          "events"
        );
      };

      // Zero Day transport trips
      const transportTripsColRef = scopedCollection( TRANSPORT_TRIPS_COLLECTION);
      getAllTransportTripsFs = async () => {
        const snap = await firestoreMod.getDocs(transportTripsColRef);
        return snap.docs.map((d) => {
          const id = Number(d.id);
          const data = d.data();
          return { id: isNaN(id) ? d.id : id, ...data, voterIds: Array.isArray(data.voterIds) ? data.voterIds : [] };
        });
      };
      setTransportTripFs = async (trip) => {
        if (!trip || trip.id == null) return;
        const ref = scopedDoc( TRANSPORT_TRIPS_COLLECTION, String(trip.id));
        const data = {
          tripType: trip.tripType,
          route: trip.route,
          driver: trip.driver || "",
          vehicle: trip.vehicle || "",
          pickupTime: trip.pickupTime || "",
          status: trip.status || "Scheduled",
          voterCount: trip.voterCount != null ? trip.voterCount : 0,
          voterIds: Array.isArray(trip.voterIds) ? trip.voterIds : [],
          onboardedVoterIds: Array.isArray(trip.onboardedVoterIds) ? trip.onboardedVoterIds : [],
          excludedVoterIds: Array.isArray(trip.excludedVoterIds) ? trip.excludedVoterIds : [],
          remarks: trip.remarks != null ? String(trip.remarks) : "",
          rate: trip.rate != null ? String(trip.rate) : "",
          amount: trip.amount != null ? String(trip.amount) : "",
          passengerPreferredPickupByVoterId:
            trip.passengerPreferredPickupByVoterId &&
            typeof trip.passengerPreferredPickupByVoterId === "object"
              ? trip.passengerPreferredPickupByVoterId
              : {},
          passengerRemarksByVoterId:
            trip.passengerRemarksByVoterId && typeof trip.passengerRemarksByVoterId === "object"
              ? trip.passengerRemarksByVoterId
              : {},
        };
        await firestoreMod.setDoc(ref, data, { merge: true });
      };
      deleteTransportTripFs = async (tripId) => {
        if (tripId == null) return;
        const ref = scopedDoc( TRANSPORT_TRIPS_COLLECTION, String(tripId));
        await firestoreMod.deleteDoc(ref);
      };
      onTransportTripsSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return onSnapshotSafe(
          transportTripsColRef,
          (snap) => {
            handler(snap.docs.map((d) => {
              const id = Number(d.id);
              const data = d.data();
              return { id: isNaN(id) ? d.id : id, ...data, voterIds: Array.isArray(data.voterIds) ? data.voterIds : [] };
            }));
          },
          "transportTrips"
        );
      };

      const transportRoutesColRef = scopedCollection( TRANSPORT_ROUTES_COLLECTION);
      getAllTransportRoutesFs = async () => {
        const snap = await firestoreMod.getDocs(transportRoutesColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };
      setTransportRouteFs = async (route) => {
        if (!route || route.id == null) return;
        const ref = scopedDoc( TRANSPORT_ROUTES_COLLECTION, String(route.id));
        const data = {
          tripIds: Array.isArray(route.tripIds) ? route.tripIds.map((x) => (typeof x === "number" ? x : Number(x))) : [],
          createdAt:
            typeof route.createdAt === "number" && !Number.isNaN(route.createdAt)
              ? route.createdAt
              : Date.now(),
          driver: route.driver || "",
          vehicle: route.vehicle || "",
          pickupTime: route.pickupTime || "",
          status: route.status || "Scheduled",
          remarks: route.remarks != null ? String(route.remarks) : "",
          rate: route.rate != null ? String(route.rate) : "",
          amount: route.amount != null ? String(route.amount) : "",
          onboardedVoterIds: Array.isArray(route.onboardedVoterIds) ? route.onboardedVoterIds.map(String) : [],
          passengerPreferredPickupByVoterId:
            route.passengerPreferredPickupByVoterId &&
            typeof route.passengerPreferredPickupByVoterId === "object"
              ? route.passengerPreferredPickupByVoterId
              : {},
          passengerRemarksByVoterId:
            route.passengerRemarksByVoterId && typeof route.passengerRemarksByVoterId === "object"
              ? route.passengerRemarksByVoterId
              : {},
        };
        await firestoreMod.setDoc(ref, data, { merge: true });
      };
      deleteTransportRouteFs = async (routeId) => {
        if (routeId == null) return;
        const ref = scopedDoc( TRANSPORT_ROUTES_COLLECTION, String(routeId));
        await firestoreMod.deleteDoc(ref);
      };
      onTransportRoutesSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return onSnapshotSafe(
          transportRoutesColRef,
          (snap) => {
            handler(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          },
          "transportRoutes"
        );
      };

      const deleteCollectionDocs = async (colRef) => {
        const snap = await firestoreMod.getDocs(colRef);
        const docs = snap.docs;
        if (!docs.length) return;
        const MAX = 450;
        if (typeof firestoreMod.writeBatch === "function") {
          for (let i = 0; i < docs.length; i += MAX) {
            const batch = firestoreMod.writeBatch(db);
            docs.slice(i, i + MAX).forEach((d) => batch.delete(d.ref));
            await batch.commit();
          }
          return;
        }
        for (const d of docs) await firestoreMod.deleteDoc(d.ref);
      };

      const deleteActiveMonitorTree = async (token) => {
        if (!token) return;
        const t = String(token);
        await deleteCollectionDocs(
          scopedCollection( MONITORS_COLLECTION, t, "voted")
        );
        const bsRef = scopedDoc(
          MONITORS_COLLECTION,
          t,
          "ballotSession",
          "settings"
        );
        try {
          await firestoreMod.deleteDoc(bsRef);
        } catch (_) {}
        await deleteMonitorDoc(t);
      };

      const writeArchivedDocsBatch = async (archiveId, segment, items, idField) => {
        const field = idField || "id";
        const valid = (Array.isArray(items) ? items : []).filter(
          (item) => item && item[field] != null && item[field] !== ""
        );
        for (let i = 0; i < valid.length; i += 450) {
          const batch = firestoreMod.writeBatch(db);
          valid.slice(i, i + 450).forEach((item) => {
            const docId = String(item[field]);
            const ref = scopedDoc(
              CAMPAIGN_ARCHIVES_COLLECTION,
              archiveId,
              segment,
              docId
            );
            const { id: _drop, ...rest } = item;
            const payload = {};
            for (const [k, v] of Object.entries(rest)) {
              if (v !== undefined) payload[k] = v;
            }
            batch.set(ref, payload, { merge: true });
          });
          await batch.commit();
        }
      };

      archiveCampaignSnapshotFs = async ({ label, monitorTokens, onProgress } = {}) => {
        const report = (pct, message) => {
          if (typeof onProgress !== "function") return;
          try {
            onProgress({
              percent: Math.min(100, Math.max(0, Math.round(pct))),
              message: String(message || ""),
            });
          } catch (_) {}
        };
        try {
          report(0, "Preparing archive…");
          const archivesCol = scopedCollection( CAMPAIGN_ARCHIVES_COLLECTION);
          const archiveRef = firestoreMod.doc(archivesCol);
          const archiveId = archiveRef.id;
          const nowIso = new Date().toISOString();
          report(2, "Reading campaign configuration…");
          const cfg = (await getFirestoreCampaignConfig()) || {};
          const tokens = Array.isArray(monitorTokens)
            ? [...new Set(monitorTokens.map((x) => String(x).trim()).filter(Boolean))]
            : [];

          report(5, "Loading voters from Firestore…");
          const voters = await getAllVotersFs();
          report(10, "Loading agents and candidates…");
          const agents = await getAllAgentsFs();
          const candidates = await getAllCandidatesFs();
          report(14, "Loading events…");
          const events = await getAllEventsFs();
          report(17, "Loading transport trips and routes…");
          const trips = await getAllTransportTripsFs();
          const routes = await getAllTransportRoutesFs();
          report(20, "Loading voter lists…");
          const lists = await getAllVoterListsFs();

          report(22, "Writing archive metadata…");
          await firestoreMod.setDoc(archiveRef, {
            label: String(label || "").trim() || "Archived campaign",
            archivedAt: nowIso,
            exportVersion: 1,
            campaignNameSnapshot: String(cfg.campaignName || ""),
            stats: {
              voters: voters.length,
              agents: agents.length,
              candidates: candidates.length,
              events: events.length,
              transportTrips: trips.length,
              transportRoutes: routes.length,
              voterLists: lists.length,
              monitorTokens: tokens.length,
            },
            configSnapshot: cfg,
          });

          const votersToArchive = voters.filter((v) => v && v.id != null);
          const vBatchCount = Math.max(1, Math.ceil(votersToArchive.length / 450));
          for (let bi = 0, i = 0; i < votersToArchive.length; bi++, i += 450) {
            const batch = firestoreMod.writeBatch(db);
            const chunk = votersToArchive.slice(i, i + 450);
            const doneAfter = Math.min(i + chunk.length, votersToArchive.length);
            report(
              24 + Math.round(((bi + 1) / vBatchCount) * 38),
              votersToArchive.length
                ? `Copying voters to archive… (${doneAfter} of ${votersToArchive.length})`
                : "Copying voters…"
            );
            chunk.forEach((v) => {
              const vid = String(v.id);
              const ref = scopedDoc(
                CAMPAIGN_ARCHIVES_COLLECTION,
                archiveId,
                "voters",
                vid
              );
              const { id: _drop, ...rest } = v;
              const payload = {};
              for (const [k, val] of Object.entries(rest)) {
                if (val !== undefined) payload[k] = val;
              }
              batch.set(ref, payload, { merge: true });
            });
            await batch.commit();
          }

          report(64, "Copying agents to archive…");
          await writeArchivedDocsBatch(archiveId, "agents", agents, "id");
          report(69, "Copying candidates to archive…");
          await writeArchivedDocsBatch(archiveId, "candidates", candidates, "id");
          report(73, "Copying events to archive…");
          await writeArchivedDocsBatch(archiveId, "events", events, "id");
          report(77, "Copying transport trips to archive…");
          await writeArchivedDocsBatch(archiveId, "transportTrips", trips, "id");
          report(81, "Copying transport routes to archive…");
          await writeArchivedDocsBatch(archiveId, "transportRoutes", routes, "id");
          report(85, "Copying voter lists to archive…");
          await writeArchivedDocsBatch(archiveId, "voterLists", lists, "id");

          const nTok = tokens.length;
          if (!nTok) report(95, "No ballot monitors to archive.");
          for (let ti = 0; ti < tokens.length; ti++) {
            const tok = tokens[ti];
            report(
              88 + Math.round(((ti + 1) / nTok) * 11),
              `Archiving ballot monitors… (${ti + 1} of ${nTok})`
            );
            const mon = await getMonitorByToken(tok);
            if (!mon) continue;
            const mref = scopedDoc(
              CAMPAIGN_ARCHIVES_COLLECTION,
              archiveId,
              "archivedMonitors",
              String(tok)
            );
            const { id: _mid, ...mrest } = mon;
            await firestoreMod.setDoc(mref, mrest, { merge: true });

            const votedEntries = await getVotedForMonitor(tok);
            for (let i = 0; i < votedEntries.length; i += 450) {
              const batch = firestoreMod.writeBatch(db);
              votedEntries.slice(i, i + 450).forEach((e) => {
                const ref = scopedDoc(
                  CAMPAIGN_ARCHIVES_COLLECTION,
                  archiveId,
                  "archivedMonitors",
                  String(tok),
                  "voted",
                  String(e.voterId)
                );
                batch.set(ref, { timeMarked: e.timeMarked || "" });
              });
              await batch.commit();
            }

            const sess = await getBallotSessionFs(tok);
            const bsRef = scopedDoc(
              CAMPAIGN_ARCHIVES_COLLECTION,
              archiveId,
              "archivedMonitors",
              String(tok),
              "ballotSession",
              "settings"
            );
            await firestoreMod.setDoc(bsRef, sess, { merge: true });
          }

          report(100, "Archive snapshot complete.");
          try {
            await pruneDuplicateCampaignArchivesFs(archiveId);
          } catch (_) {}
          return { ok: true, archiveId };
        } catch (e) {
          console.warn("[Firebase] archiveCampaignSnapshotFs", e);
          return { ok: false, error: String(e?.message || e || "Archive failed") };
        }
      };

      const ARCHIVED_FLAT_SEGMENTS = new Set([
        "voters",
        "agents",
        "candidates",
        "events",
        "transportTrips",
        "transportRoutes",
        "voterLists",
      ]);

      const readArchivedFlatSegment = async (archiveId, segment) => {
        if (!archiveId || !ARCHIVED_FLAT_SEGMENTS.has(segment)) return [];
        try {
          const col = scopedCollection( CAMPAIGN_ARCHIVES_COLLECTION, archiveId, segment);
          const snap = await firestoreMod.getDocs(col);
          return snap.docs.map((d) => ({ ...(d.data() || {}), id: d.id }));
        } catch (e) {
          console.warn("[Firebase] readArchivedFlatSegment", segment, e);
          return [];
        }
      };

      getArchivedArchiveRootFs = async (archiveId) => {
        if (!archiveId) return null;
        try {
          const ref = scopedDoc( CAMPAIGN_ARCHIVES_COLLECTION, String(archiveId));
          const snap = await firestoreMod.getDoc(ref);
          if (!snap || !snap.exists()) return null;
          return { id: snap.id, ...snap.data() };
        } catch (e) {
          console.warn("[Firebase] getArchivedArchiveRootFs", e);
          return null;
        }
      };

      getArchivedSegmentFs = async (archiveId, segment) => readArchivedFlatSegment(archiveId, segment);

      getArchivedVotersFs = async (archiveId) => readArchivedFlatSegment(archiveId, "voters");

      getArchivedMonitorsFs = async (archiveId) => {
        if (!archiveId) return [];
        try {
          const col = scopedCollection( CAMPAIGN_ARCHIVES_COLLECTION, archiveId, "archivedMonitors");
          const snap = await firestoreMod.getDocs(col);
          return snap.docs.map((d) => {
            const data = d.data() || {};
            return { id: d.id, shareToken: d.id, ...data };
          });
        } catch (e) {
          console.warn("[Firebase] getArchivedMonitorsFs", e);
          return [];
        }
      };

      deleteCampaignArchiveFs = async (archiveId) => {
        if (!archiveId) return { ok: false };
        try {
          const segDelete = async (segment) => {
            const col = scopedCollection( CAMPAIGN_ARCHIVES_COLLECTION, archiveId, segment);
            await deleteCollectionDocs(col);
          };
          await segDelete("voters");
          await segDelete("agents");
          await segDelete("candidates");
          await segDelete("events");
          await segDelete("transportTrips");
          await segDelete("transportRoutes");
          await segDelete("voterLists");
          const monCol = scopedCollection( CAMPAIGN_ARCHIVES_COLLECTION, archiveId, "archivedMonitors");
          const monSnap = await firestoreMod.getDocs(monCol);
          for (const md of monSnap.docs) {
            const tok = md.id;
            await deleteCollectionDocs(
              scopedCollection(
                CAMPAIGN_ARCHIVES_COLLECTION,
                archiveId,
                "archivedMonitors",
                tok,
                "voted"
              )
            );
            const bsRef = scopedDoc(
              CAMPAIGN_ARCHIVES_COLLECTION,
              archiveId,
              "archivedMonitors",
              tok,
              "ballotSession",
              "settings"
            );
            try {
              await firestoreMod.deleteDoc(bsRef);
            } catch (_) {}
            await firestoreMod.deleteDoc(md.ref);
          }
          await firestoreMod.deleteDoc(scopedDoc( CAMPAIGN_ARCHIVES_COLLECTION, archiveId));
          return { ok: true };
        } catch (e) {
          console.warn("[Firebase] deleteCampaignArchiveFs", e);
          return { ok: false, error: String(e?.message || e) };
        }
      };

      /** Same normalized label → keep most recent archivedAt (ties: prefer preferKeepId). Default label + identical stats within 10 min → keep one. */
      pruneDuplicateCampaignArchivesFs = async (preferKeepId) => {
        try {
          const keepFirst = (a, b) => {
            const prefer = preferKeepId ? String(preferKeepId) : "";
            if (prefer && a.id === prefer) return -1;
            if (prefer && b.id === prefer) return 1;
            const t = String(b.archivedAt || "").localeCompare(String(a.archivedAt || ""));
            if (t !== 0) return t;
            return String(b.id).localeCompare(String(a.id));
          };
          const col = scopedCollection( CAMPAIGN_ARCHIVES_COLLECTION);
          const snap = await firestoreMod.getDocs(col);
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          const toDelete = new Set();

          const normLabel = (r) => String(r.label || "").trim().toLowerCase();

          const byLabel = new Map();
          for (const r of rows) {
            const k = normLabel(r);
            if (!k || k === DEFAULT_ARCHIVE_LABEL) continue;
            if (!byLabel.has(k)) byLabel.set(k, []);
            byLabel.get(k).push(r);
          }
          for (const group of byLabel.values()) {
            if (group.length <= 1) continue;
            group.sort(keepFirst);
            for (let i = 1; i < group.length; i++) {
              toDelete.add(group[i].id);
            }
          }

          const defaults = rows.filter((r) => {
            const k = normLabel(r);
            return (!k || k === DEFAULT_ARCHIVE_LABEL) && !toDelete.has(r.id);
          });
          const defGroups = new Map();
          for (const r of defaults) {
            const sig = `${JSON.stringify(r.stats || {})}\0${String(r.campaignNameSnapshot || "")}`;
            if (!defGroups.has(sig)) defGroups.set(sig, []);
            defGroups.get(sig).push(r);
          }
          const TEN_MIN_MS = 10 * 60 * 1000;
          for (const group of defGroups.values()) {
            if (group.length <= 1) continue;
            const times = group.map((r) => new Date(r.archivedAt || 0).getTime());
            const spread = Math.max(...times) - Math.min(...times);
            if (spread > TEN_MIN_MS) continue;
            group.sort(keepFirst);
            for (let i = 1; i < group.length; i++) {
              toDelete.add(group[i].id);
            }
          }

          for (const id of toDelete) {
            await deleteCampaignArchiveFs(id);
          }
        } catch (e) {
          console.warn("[Firebase] pruneDuplicateCampaignArchivesFs", e);
        }
      };

      listCampaignArchivesFs = async () => {
        try {
          await pruneDuplicateCampaignArchivesFs(null);
          const col = scopedCollection( CAMPAIGN_ARCHIVES_COLLECTION);
          const snap = await firestoreMod.getDocs(col);
          const out = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          out.sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")));
          return out;
        } catch (e) {
          console.warn("[Firebase] listCampaignArchivesFs", e);
          return [];
        }
      };

      wipeActiveCampaignDataFs = async ({ monitorTokens, onProgress } = {}) => {
        const report = (pct, message) => {
          if (typeof onProgress !== "function") return;
          try {
            onProgress({
              percent: Math.min(100, Math.max(0, Math.round(pct))),
              message: String(message || ""),
            });
          } catch (_) {}
        };
        try {
          const tokens = Array.isArray(monitorTokens)
            ? [...new Set(monitorTokens.map((x) => String(x).trim()).filter(Boolean))]
            : [];
          report(0, "Removing active voters…");
          await deleteAllVotersFs();
          report(8, "Loading agents to remove…");
          const agents = await getAllAgentsFs();
          const nA = agents.length;
          for (let i = 0; i < agents.length; i++) {
            await deleteAgentFs(agents[i].id);
            report(
              nA ? 8 + Math.round(((i + 1) / nA) * 10) : 18,
              nA ? `Removing agents… (${i + 1} of ${nA})` : "Removing agents…"
            );
          }
          report(20, "Loading candidates to remove…");
          const candidates = await getAllCandidatesFs();
          const nC = candidates.length;
          for (let i = 0; i < candidates.length; i++) {
            await deleteCandidateFs(candidates[i].id);
            report(
              nC ? 20 + Math.round(((i + 1) / nC) * 10) : 30,
              nC ? `Removing candidates… (${i + 1} of ${nC})` : "Removing candidates…"
            );
          }
          report(32, "Loading events to remove…");
          const events = await getAllEventsFs();
          const nE = events.length;
          for (let i = 0; i < events.length; i++) {
            await deleteEventFs(events[i].id);
            report(
              nE ? 32 + Math.round(((i + 1) / nE) * 8) : 40,
              nE ? `Removing events… (${i + 1} of ${nE})` : "Removing events…"
            );
          }
          report(42, "Loading transport trips to remove…");
          const trips = await getAllTransportTripsFs();
          const nT = trips.length;
          for (let i = 0; i < trips.length; i++) {
            await deleteTransportTripFs(trips[i].id);
            report(
              nT ? 42 + Math.round(((i + 1) / nT) * 8) : 50,
              nT ? `Removing transport trips… (${i + 1} of ${nT})` : "Removing transport trips…"
            );
          }
          report(52, "Loading transport routes to remove…");
          const routes = await getAllTransportRoutesFs();
          const nR = routes.length;
          for (let i = 0; i < routes.length; i++) {
            await deleteTransportRouteFs(routes[i].id);
            report(
              nR ? 52 + Math.round(((i + 1) / nR) * 8) : 60,
              nR ? `Removing transport routes… (${i + 1} of ${nR})` : "Removing transport routes…"
            );
          }
          report(62, "Loading voter lists to remove…");
          const lists = await getAllVoterListsFs();
          const nL = lists.length;
          for (let i = 0; i < lists.length; i++) {
            await deleteVoterListFs(lists[i].id);
            report(
              nL ? 62 + Math.round(((i + 1) / nL) * 8) : 70,
              nL ? `Removing voter lists… (${i + 1} of ${nL})` : "Removing voter lists…"
            );
          }

          const nTok = tokens.length;
          if (!nTok) report(84, "No ballot monitors to remove.");
          for (let ti = 0; ti < tokens.length; ti++) {
            const tok = tokens[ti];
            report(
              72 + Math.round(((ti + 1) / nTok) * 12),
              `Removing ballot monitors… (${ti + 1} of ${nTok})`
            );
            await deleteActiveMonitorTree(tok);
          }

          report(86, "Removing shared list links…");
          const sharesSnap = await firestoreMod.getDocs(
            scopedCollection( VOTER_LIST_SHARES_COLLECTION)
          );
          const shareDocs = sharesSnap.docs;
          for (let si = 0; si < shareDocs.length; si++) {
            const d = shareDocs[si];
            const token = d.id;
            report(
              shareDocs.length
                ? 86 + Math.round(((si + 1) / shareDocs.length) * 5)
                : 91,
              shareDocs.length
                ? `Clearing voter list shares… (${si + 1} of ${shareDocs.length})`
                : "Clearing voter list shares…"
            );
            await deleteCollectionDocs(
              scopedCollection( VOTER_LIST_SHARES_COLLECTION, token, "status")
            );
            await firestoreMod.deleteDoc(d.ref);
          }
          if (!shareDocs.length) report(91, "No voter list shares to clear.");
          report(92, "Removing pledged report shares…");
          const pledgedSnap = await firestoreMod.getDocs(
            scopedCollection( PLEDGED_REPORT_SHARES_COLLECTION)
          );
          for (const d of pledgedSnap.docs) {
            await firestoreMod.deleteDoc(d.ref);
          }
          report(95, "Removing event participant shares…");
          const evPartSnap = await firestoreMod.getDocs(
            scopedCollection( EVENT_PARTICIPANT_SHARES_COLLECTION)
          );
          const evDocs = evPartSnap.docs;
          for (let ei = 0; ei < evDocs.length; ei++) {
            const d = evDocs[ei];
            report(
              evDocs.length
                ? 95 + Math.round(((ei + 1) / evDocs.length) * 3)
                : 98,
              evDocs.length
                ? `Clearing event shares… (${ei + 1} of ${evDocs.length})`
                : "Clearing event shares…"
            );
            await deleteCollectionDocs(
              scopedCollection( EVENT_PARTICIPANT_SHARES_COLLECTION, d.id, "rows")
            );
            await firestoreMod.deleteDoc(d.ref);
          }
          if (!evDocs.length) report(98, "No event participant shares to clear.");

          report(99, "Resetting campaign settings…");
          await setFirestoreCampaignConfig({
            campaignName: "New campaign",
            campaignType: "Local Council Election",
            constituency: "",
            island: "",
            monitorShareTokens: [],
            voteMonitoringEnabled: false,
            showPledgesNav: true,
          });
          report(100, "Workspace cleared.");
          return { ok: true };
        } catch (e) {
          console.warn("[Firebase] wipeActiveCampaignDataFs", e);
          return { ok: false, error: String(e?.message || e || "Wipe failed") };
        }
      };
    } catch (fsErr) {
      // Make Firestore mandatory as well – if this fails, fail overall Firebase init.
      console.error(
        "[Firebase] Firestore initialization failed. App cannot run without Firestore.",
        fsErr
      );
      throw fsErr;
    }

    return {
      auth,
      db,
      /** For admin links (e.g. MFA troubleshooting) — same as firebaseConfig.projectId */
      projectId: firebaseConfig.projectId,
      ready: true,
      onAuthStateChanged: authMod.onAuthStateChanged.bind(null, auth),
      signOut: () => authMod.signOut(auth),
      signInWithEmailAndPassword: authMod.signInWithEmailAndPassword.bind(null, auth),
      createUserWithEmailAndPassword: authMod.createUserWithEmailAndPassword.bind(null, auth),
      sendEmailVerification: authMod.sendEmailVerification,
      /** SMS MFA after email/password (users must enroll a phone factor in Firebase). */
      getMultiFactorResolver: (error) => authMod.getMultiFactorResolver(auth, error),
      PhoneAuthProvider: authMod.PhoneAuthProvider,
      PhoneMultiFactorGenerator: authMod.PhoneMultiFactorGenerator,
      // v10+: (auth, containerOrId, parameters). v9.x was (container, parameters, auth).
      // Never set `sitekey` — the SDK loads the project key via Identity Toolkit.
      createRecaptchaVerifier: (containerId, parameters) =>
        new authMod.RecaptchaVerifier(auth, containerId, parameters || {}),
      getActiveCampaignWorkspaceId,
      setActiveCampaignWorkspaceFs,
      listCampaignWorkspacesFs,
      createCampaignWorkspaceFs,
      updateCampaignWorkspaceDetailsFs,
      getFirestoreCampaignConfig,
      setFirestoreCampaignConfig,
      updateFirestoreCampaignConfig,
      deleteFirestoreCampaignConfig,
      getVoteMonitoringEnabled,
      setVoteMonitoringEnabled,
      getMonitorByToken,
      setMonitorDoc,
      getVotedForMonitor,
      setVotedForMonitor,
      deleteVotedForMonitor,
      onVotedSnapshotForMonitor,
      getBallotSessionFs,
      setBallotSessionFs,
      onBallotSessionSnapshotFs,
      deleteMonitorDoc,
      // Firestore-backed core collections
      getAllVotersFs,
      setVoterFs,
      setVotersBatchFs,
      setVoterReferendumVoteFs,
      setVoterReferendumNotesFs,
      setVoterCandidatePledgeFs,
      setVoterVotedAtFs,
      clearVoterVotedAtFs,
      deleteVoterFs,
      deleteAllVotersFs,
      onVotersSnapshotFs,
      getAllAgentsFs,
      setAgentFs,
      deleteAgentFs,
      onAgentsSnapshotFs,
      getAllCandidatesFs,
      setCandidateFs,
      deleteCandidateFs,
      onCandidatesSnapshotFs,
      getAllVoterListsFs,
      getVoterListFs,
      getVoterListFromServerFs,
      setVoterListFs,
      deleteVoterListFs,
      onVoterListsSnapshotFs,
      getListShareByToken,
      setListShareFs,
      getPledgedReportShareByTokenFs,
      setPledgedReportShareFs,
      getEventParticipantShareByTokenFs,
      setEventParticipantShareFs,
      getEventParticipantRowsFs,
      getEventParticipantRowsFromServerFs,
      setEventParticipantRowFs,
      deleteEventParticipantRowFs,
      onEventParticipantRowsSnapshotFs,
      getCampaignUserByEmailFs,
      getAllCampaignUsersFs,
      setCampaignUserFs,
      deleteCampaignUserFs,
      setListShareStatusFs,
      getListShareStatusFs,
      onListShareStatusSnapshotFs,
      getListStatusByVoterIdFs,
      getAllEventsFs,
      setEventFs,
      deleteEventFs,
      onEventsSnapshotFs,
      getAllTransportTripsFs,
      setTransportTripFs,
      deleteTransportTripFs,
      onTransportTripsSnapshotFs,
      getAllTransportRoutesFs,
      setTransportRouteFs,
      deleteTransportRouteFs,
      onTransportRoutesSnapshotFs,
      listCampaignArchivesFs,
      pruneDuplicateCampaignArchivesFs,
      archiveCampaignSnapshotFs,
      getArchivedVotersFs,
      getArchivedArchiveRootFs,
      getArchivedSegmentFs,
      getArchivedMonitorsFs,
      deleteCampaignArchiveFs,
      wipeActiveCampaignDataFs,
    };
  } catch (err) {
    console.error(
      "[Firebase] Initialization failed — app cannot run without Firebase. Check network/config and reload.",
      err
    );
    // Make Firebase mandatory: propagate the error so callers know init failed.
    throw err;
  }
})();

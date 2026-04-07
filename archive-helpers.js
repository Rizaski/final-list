/**
 * Campaign archive / wipe — localStorage + monitor token discovery (no import from zeroDay.js to avoid circular deps).
 */
import { firebaseInitPromise } from "./firebase.js";
import { AGENTS_STORAGE_KEY } from "./agents-context.js";

const MONITORS_STORAGE_KEY = "zero-day-monitors";
const VOTED_STORAGE_KEY = "zero-day-voted";
const TRIPS_STORAGE_KEY = "zero-day-trips";
const TRIPS_DELETED_IDS_KEY = "zero-day-transport-trips-deleted-ids";
const ROUTES_STORAGE_KEY = "zero-day-transport-routes";
const ROUTES_DELETED_IDS_KEY = "zero-day-transport-routes-deleted-ids";
const TRIPS_VISIBLE_COLS_KEY = "zero-day-trips-visible-columns";
const ROUTES_VISIBLE_COLS_KEY = "zero-day-routes-visible-columns";
const MONITOR_BALLOT_SESSION_PREFIX = "monitor_ballot_session_";
const VOTERS_STORAGE_KEY = "voters-data";
const CANDIDATES_STORAGE_KEY = "candidates-data";
const CAMPAIGN_STORAGE_KEY = "campaign-config";

export async function getMonitorTokensForArchive() {
  const tokenSet = new Set();
  try {
    const raw = localStorage.getItem(MONITORS_STORAGE_KEY);
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) {
      for (const m of parsed) {
        const tok = m && m.shareToken;
        if (tok) tokenSet.add(String(tok).trim());
      }
    }
  } catch (_) {}
  try {
    const api = await firebaseInitPromise;
    if (api?.ready && api.getFirestoreCampaignConfig) {
      const config = await api.getFirestoreCampaignConfig();
      const extra = config && config.monitorShareTokens;
      if (Array.isArray(extra)) {
        for (const t of extra) {
          const s = String(t || "").trim();
          if (s) tokenSet.add(s);
        }
      }
    }
  } catch (_) {}
  return Array.from(tokenSet);
}

export function clearLocalCampaignWorkspaceCache() {
  const keys = [
    VOTERS_STORAGE_KEY,
    CANDIDATES_STORAGE_KEY,
    AGENTS_STORAGE_KEY,
    CAMPAIGN_STORAGE_KEY,
    MONITORS_STORAGE_KEY,
    VOTED_STORAGE_KEY,
    TRIPS_STORAGE_KEY,
    TRIPS_DELETED_IDS_KEY,
    ROUTES_STORAGE_KEY,
    ROUTES_DELETED_IDS_KEY,
    TRIPS_VISIBLE_COLS_KEY,
    ROUTES_VISIBLE_COLS_KEY,
  ];
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch (_) {}
  }
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(MONITOR_BALLOT_SESSION_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch (_) {}
}

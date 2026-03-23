/**
 * Agent list visibility + validation (no import from voters/settings to avoid cycles).
 */
const AUTH_STORAGE_KEY = "campaign-auth-user";
export const AGENTS_STORAGE_KEY = "agents-data";

export function parseViewerFromStorage() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return { isAdmin: false, role: "staff", candidateId: null };
    const p = JSON.parse(raw);
    const role =
      p?.role === "candidate" ? "candidate" : p?.role === "admin" ? "admin" : "staff";
    return {
      // Treat role admin like isAdmin so delete/edit agents works if only role was persisted.
      isAdmin: Boolean(p?.isAdmin) || role === "admin",
      role,
      candidateId: p?.candidateId != null && String(p.candidateId).trim() ? String(p.candidateId).trim() : null,
    };
  } catch (_) {
    return { isAdmin: false, role: "staff", candidateId: null };
  }
}

function agentCandidateScopeId(a) {
  const raw = a && a.candidateId;
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  if (!s || s === "undefined" || s === "null") return "";
  return s;
}

/**
 * Visibility:
 * - Admin: all agents.
 * - Candidate login: only agents whose `candidateId` matches that candidate (not unscoped / not other candidates).
 * - Staff: agents with no candidateId (campaign-wide / unscoped only).
 */
export function filterAgentsForViewer(agents) {
  if (!Array.isArray(agents)) return [];
  const u = parseViewerFromStorage();
  if (u.isAdmin) return [...agents];
  if (u.role === "candidate" && u.candidateId) {
    return agents.filter((a) => agentCandidateScopeId(a) === u.candidateId);
  }
  // Staff and other roles: only agents not scoped to a specific candidate
  return agents.filter((a) => !agentCandidateScopeId(a));
}

export function getAgentsFromStorage() {
  try {
    const raw = localStorage.getItem(AGENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Agent full name: at least first + last word.
 * Allows normal real-world entry styles (upper/lower/title case, hyphen/apostrophe).
 */
export function isProperAgentFullName(name) {
  const s = String(name || "").trim();
  if (!s) return false;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const wordOk = (w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w);
  return parts.every(wordOk);
}

export function formatAgentNameHint() {
  return "Use first and last name, e.g. Ahmed Hassan.";
}

/** localStorage key for per-candidate pledged-voter → agent name assignments */
export function candidatePledgedAgentStorageKey(candidateId) {
  return `candidatePledgedAgentAssignments:v2:${String(candidateId)}`;
}

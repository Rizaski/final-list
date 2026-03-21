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
    return {
      isAdmin: Boolean(p?.isAdmin),
      role: p?.role === "candidate" ? "candidate" : p?.role === "admin" ? "admin" : "staff",
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
 * Agents tied to a candidate (agent.candidateId set) are visible only to admin and that candidate's login.
 * Agents with no candidateId are visible to everyone (including staff).
 */
export function filterAgentsForViewer(agents) {
  if (!Array.isArray(agents)) return [];
  const u = parseViewerFromStorage();
  if (u.isAdmin) return [...agents];
  if (u.role === "candidate" && u.candidateId) {
    return agents.filter((a) => {
      const cid = agentCandidateScopeId(a);
      if (!cid) return true;
      return cid === u.candidateId;
    });
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
 * "Proper" full name: at least first + last name, each word capitalized (Latin letters), optional middle names.
 */
export function isProperAgentFullName(name) {
  const s = String(name || "").trim();
  if (!s) return false;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const wordOk = (w) => /^[A-Z][a-z]+(?:-[A-Za-z]+)?$/.test(w);
  return parts.every(wordOk);
}

export function formatAgentNameHint() {
  return "Use title case with first and last name, e.g. Ahmed Hassan.";
}

/** localStorage key for per-candidate pledged-voter → agent name assignments */
export function candidatePledgedAgentStorageKey(candidateId) {
  return `candidatePledgedAgentAssignments:v2:${String(candidateId)}`;
}

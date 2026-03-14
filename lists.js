/**
 * Voter lists: create lists from search, open in workspace, share links, list status sync.
 */
import { firebaseInitPromise } from "./firebase.js";

const LIST_STATUS_VALUES = ["", "in_progress", "need_assistance", "completed"];
const LIST_STATUS_LABELS = { "": "—", in_progress: "In Progress", need_assistance: "Need Assistance", completed: "Completed" };

let listStatusMap = {}; // voterId -> [{ listId, listName, shareToken, status, updatedAt }]
let listStatusListeners = [];
let statusUnsubscribes = [];

function notifyListStatusListeners() {
  listStatusListeners.forEach((cb) => { try { cb(); } catch (_) {} });
}

export function getListStatusByVoterId(voterId) {
  return listStatusMap[voterId] || [];
}

export function getListStatusLabel(status) {
  return LIST_STATUS_LABELS[status] || status || "—";
}

export function getListStatusValues() {
  return LIST_STATUS_VALUES.filter(Boolean);
}

export function onListStatusChange(callback) {
  if (typeof callback !== "function") return () => {};
  listStatusListeners.push(callback);
  return () => {
    const i = listStatusListeners.indexOf(callback);
    if (i !== -1) listStatusListeners.splice(i, 1);
  };
}

export async function startListStatusSync() {
  const api = await firebaseInitPromise;
  if (!api.ready || !api.getAllVoterListsFs || !api.onListShareStatusSnapshotFs) return;
  statusUnsubscribes.forEach((u) => { try { u(); } catch (_) {} });
  statusUnsubscribes = [];
  listStatusMap = {};

  const lists = await api.getAllVoterListsFs();
  const shared = (Array.isArray(lists) ? lists : []).filter((l) => l.shareToken);

  shared.forEach((list) => {
    const token = list.shareToken;
    const listName = list.name || list.id;
    const listId = list.id;
    const unsub = api.onListShareStatusSnapshotFs(token, (items) => {
      const byVoter = {};
      (items || []).forEach((item) => {
        const vid = item.voterId;
        if (!byVoter[vid]) byVoter[vid] = [];
        byVoter[vid].push({ listId, listName, shareToken: token, status: item.status || "", updatedAt: item.updatedAt });
      });
      Object.keys(byVoter).forEach((vid) => {
        listStatusMap[vid] = (listStatusMap[vid] || []).filter((e) => e.shareToken !== token);
        listStatusMap[vid].push(...byVoter[vid]);
      });
      // Remove status for voters no longer in this list's status collection
      const currentVoterIds = new Set(Object.keys(byVoter));
      Object.keys(listStatusMap).forEach((vid) => {
        listStatusMap[vid] = listStatusMap[vid].filter((e) => e.shareToken !== token || currentVoterIds.has(vid));
        if (listStatusMap[vid].length === 0) delete listStatusMap[vid];
      });
      notifyListStatusListeners();
    });
    statusUnsubscribes.push(unsub);
  });

  notifyListStatusListeners();
}

function generateId() {
  return "list-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function generateToken() {
  return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

export async function createList(name, voterIds) {
  const api = await firebaseInitPromise;
  if (!api.ready || !api.setVoterListFs) throw new Error("Firebase not ready");
  const id = generateId();
  const list = {
    id,
    name: String(name || "Untitled list").trim() || "Untitled list",
    voterIds: Array.isArray(voterIds) ? voterIds : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await api.setVoterListFs(list);
  return list;
}

export async function getLists() {
  const api = await firebaseInitPromise;
  if (!api.ready || !api.getAllVoterListsFs) return [];
  const lists = await api.getAllVoterListsFs();
  return Array.isArray(lists) ? lists : [];
}

export async function getList(listId) {
  const api = await firebaseInitPromise;
  if (!api.ready || !api.getVoterListFs || !listId) return null;
  return api.getVoterListFs(listId);
}

/** Fetch list from server (bypass cache) so list workspace always gets current voterIds. */
export async function getListFromServer(listId) {
  const api = await firebaseInitPromise;
  if (!api.ready || !listId) return null;
  if (api.getVoterListFromServerFs) return api.getVoterListFromServerFs(listId);
  return api.getVoterListFs ? api.getVoterListFs(listId) : null;
}

export async function saveList(list) {
  const api = await firebaseInitPromise;
  if (!api.ready || !api.setVoterListFs || !list?.id) return;
  const payload = { ...list, updatedAt: new Date().toISOString() };
  await api.setVoterListFs(payload);
}

export async function deleteList(listId) {
  const api = await firebaseInitPromise;
  if (!api.ready || !api.deleteVoterListFs || !listId) return;
  await api.deleteVoterListFs(listId);
}

export async function createShareLink(listId, voterSnapshots) {
  const api = await firebaseInitPromise;
  if (!api.ready || !api.getVoterListFs || !api.setListShareFs || !api.setVoterListFs) throw new Error("Firebase not ready");
  const list = await api.getVoterListFs(listId);
  if (!list) throw new Error("List not found");
  const token = generateToken();
  const payload = {
    name: list.name || "Shared list",
    voterIds: list.voterIds || [],
    assignedCandidateId: list.assignedCandidateId || "",
    assignedAgentId: list.assignedAgentId || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    voters: Array.isArray(voterSnapshots) ? voterSnapshots : [],
  };
  await api.setListShareFs(token, payload);
  const updatedList = { ...list, shareToken: token, updatedAt: new Date().toISOString() };
  await api.setVoterListFs(updatedList);
  const base = window.location.origin + (window.location.pathname || "") + (window.location.pathname.endsWith("/") ? "" : "/").replace(/index\.html$/, "");
  const listViewUrl = base + (base.endsWith("/") ? "" : "/") + "list-view.html?token=" + encodeURIComponent(token);
  return { token, url: listViewUrl };
}

export function openListWorkspace(listId) {
  const base = window.location.origin + (window.location.pathname || "").replace(/[^/]+$/, "");
  const url = base + "list-workspace.html?listId=" + encodeURIComponent(listId);
  window.open(url, "_blank", "noopener,noreferrer");
}

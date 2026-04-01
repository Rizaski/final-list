/**
 * Standalone ballot box page: works from any device with internet (no login required).
 * Tries Firestore first (monitor + voters + voted). Requires firestore.rules that allow
 * unauthenticated get on monitors/{token} and read/write on monitors/{token}/voted/*.
 * Falls back to localStorage if Firestore is unavailable (same browser only).
 */
import { firebaseInitPromise } from "./firebase.js";
import { initMonitorView } from "./zeroDay.js";

const params = new URLSearchParams(window.location.search);
const token = params.get("monitor") || "";

const standaloneOpts = { standaloneBallotPage: true };

initBallotBoxChrome();

function hideBallotBoxLoading() {
  const el = document.getElementById("ballotBoxLoading");
  if (el) {
    el.hidden = true;
    el.setAttribute("aria-busy", "false");
  }
}

/** App bar: connection status + local time (professional context for monitors). */
function initBallotBoxChrome() {
  const stat = document.getElementById("ballotBoxOnlineStatus");
  const clock = document.getElementById("ballotBoxClock");
  let clockTimer = null;

  function syncOnline() {
    if (!stat) return;
    const on = navigator.onLine;
    stat.textContent = on ? "Connected" : "Offline";
    stat.className =
      "ballot-box-pill " + (on ? "ballot-box-pill--success" : "ballot-box-pill--danger");
    stat.setAttribute("aria-label", on ? "Network connected" : "Working offline");
  }

  function syncClock() {
    if (!clock) return;
    const d = new Date();
    clock.textContent = d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    clock.setAttribute("datetime", d.toISOString());
  }

  syncOnline();
  syncClock();
  clockTimer = setInterval(syncClock, 30000);
  window.addEventListener("online", syncOnline);
  window.addEventListener("offline", syncOnline);

  window.addEventListener(
    "beforeunload",
    () => {
      if (clockTimer) clearInterval(clockTimer);
    },
    { once: true }
  );
}

async function main() {
  const strictStandaloneOpts = {
    ...standaloneOpts,
    preventLocalMonitorFallback: true,
  };
  try {
    if (!token) {
      initMonitorView("", null, strictStandaloneOpts);
      return;
    }

    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getMonitorByToken && api.getVotedForMonitor && api.setVotedForMonitor) {
        const monitor = await api.getMonitorByToken(token);
        if (monitor) {
          const remoteVotedEntries = await api.getVotedForMonitor(token);
          const monitoringDisabled = monitor.monitoringEnabled === false;
          const remoteMonitor = {
            shareToken: token,
            ballotBox: monitor.ballotBox || "",
            name: monitor.name || "",
            mobile: monitor.mobile || "",
            voterIds: monitor.voterIds || [],
            voters: monitor.voters || [],
          };
          initMonitorView(token, null, {
            ...strictStandaloneOpts,
            remoteMonitor,
            remoteVotedEntries,
            monitoringDisabled,
            ballotSession:
              api.getBallotSessionFs && api.setBallotSessionFs && api.onBallotSessionSnapshotFs
                ? {
                    get: () => api.getBallotSessionFs(token),
                    set: (d) => api.setBallotSessionFs(token, d),
                    subscribe: (cb) => api.onBallotSessionSnapshotFs(token, cb),
                  }
                : undefined,
            onSaveVoted: monitoringDisabled ? undefined : async (t, voterId, timeMarked) => {
              await api.setVotedForMonitor(t, voterId, timeMarked);
              const staff = api.auth && api.auth.currentUser;
              if (staff && api.setVoterVotedAtFs) await api.setVoterVotedAtFs(voterId, timeMarked);
            },
            onDeleteVoted: monitoringDisabled
              ? undefined
              : async (t, voterId) => {
                  await api.deleteVotedForMonitor(t, voterId);
                },
            onRefreshVoted: async () => {
              const entries = await api.getVotedForMonitor(token);
              remoteVotedEntries.length = 0;
              remoteVotedEntries.push(...entries);
            },
          });
          return;
        }
      }
      // Firestore is reachable, but no monitor exists for this token.
      initMonitorView(token, null, { ...strictStandaloneOpts, invalidReason: "not_found" });
      return;
    } catch (err) {
      console.warn("[Ballot box] Firestore error (check connection and deployed rules):", err.message || err);
      initMonitorView(token, null, { ...strictStandaloneOpts, invalidReason: "offline" });
      return;
    }
  } finally {
    hideBallotBoxLoading();
  }
}

main();

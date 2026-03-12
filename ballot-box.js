/**
 * Standalone ballot box page: works from any device with internet.
 * Tries Firestore first (monitor + voters + voted). Falls back to localStorage (same browser only).
 */
import { firebaseInitPromise } from "./firebase.js";
import { getVotersContextForStandalone } from "./voters.js";
import { initMonitorView } from "./zeroDay.js";

const params = new URLSearchParams(window.location.search);
const token = params.get("monitor") || "";

async function main() {
  if (!token) {
    initMonitorView("", null);
    return;
  }

  try {
    const api = await firebaseInitPromise;
    if (api.ready && api.getMonitorByToken && api.getVotedForMonitor && api.setVotedForMonitor) {
      const monitor = await api.getMonitorByToken(token);
      if (monitor) {
        const remoteVotedEntries = await api.getVotedForMonitor(token);
        const remoteMonitor = {
          shareToken: token,
          ballotBox: monitor.ballotBox || "",
          name: monitor.name || "",
          mobile: monitor.mobile || "",
          voterIds: monitor.voterIds || [],
          voters: monitor.voters || [],
        };
        initMonitorView(token, null, {
          remoteMonitor,
          remoteVotedEntries,
          onSaveVoted: (t, voterId, timeMarked) => api.setVotedForMonitor(t, voterId, timeMarked),
          onRefreshVoted: async () => {
            const entries = await api.getVotedForMonitor(token);
            remoteVotedEntries.length = 0;
            remoteVotedEntries.push(...entries);
          },
        });
        return;
      }
    }
  } catch (err) {
    console.warn("[Ballot box] Firestore error (use same browser or deploy rules):", err.message || err);
  }

  const votersContext = getVotersContextForStandalone();
  initMonitorView(token, votersContext);
}

main();

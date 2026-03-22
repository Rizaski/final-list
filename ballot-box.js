/**
 * Standalone ballot box page: works from any device with internet (no login required).
 * Tries Firestore first (monitor + voters + voted). Requires firestore.rules that allow
 * unauthenticated get on monitors/{token} and read/write on monitors/{token}/voted/*.
 * Falls back to localStorage if Firestore is unavailable (same browser only).
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
          remoteMonitor,
          remoteVotedEntries,
          monitoringDisabled,
          onSaveVoted: monitoringDisabled ? undefined : async (t, voterId, timeMarked) => {
            await api.setVotedForMonitor(t, voterId, timeMarked);
            // Voter documents require signed-in staff; standalone links only update monitors/.../voted.
            const staff = api.auth && api.auth.currentUser;
            if (staff && api.setVoterVotedAtFs) await api.setVoterVotedAtFs(voterId, timeMarked);
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
  } catch (err) {
    console.warn("[Ballot box] Firestore error (check connection and deployed rules):", err.message || err);
  }

  const votersContext = getVotersContextForStandalone();
  initMonitorView(token, votersContext);
}

main();

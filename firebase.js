/**
 * Firebase Integration — Auth + Firestore.
 * Defensive init so the app works when Firebase is unavailable (e.g. network, CORS).
 * Exports firebaseInitPromise → { auth, db, ...authFns, getFirestoreCampaignConfig, setFirestoreCampaignConfig, updateFirestoreCampaignConfig, deleteFirestoreCampaignConfig }.
 * CRUD for campaign config: Read (get), Create/Replace (set), Update (patch), Delete.
 */
const FIREBASE_SDK_VERSION = "9.22.2";
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

const noopUnsubscribe = () => {};
const noopPromise = () => Promise.resolve();

const CAMPAIGN_CONFIG_COLLECTION = "campaign";
const CAMPAIGN_CONFIG_DOC = "config";
const MONITORS_COLLECTION = "monitors";
const VOTER_LISTS_COLLECTION = "voterLists";
const VOTER_LIST_SHARES_COLLECTION = "voterListShares";

export const firebaseInitPromise = (async () => {
  try {
    const appMod = await import(`${SDK_BASE}/firebase-app.js`);
    const authMod = await import(`${SDK_BASE}/firebase-auth.js`);
    const app = appMod.getApps().length
      ? appMod.getApp()
      : appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);

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
    let onVotedSnapshotForMonitor = () => noopUnsubscribe;
    let deleteMonitorDoc = () => Promise.resolve();

    // Firestore-backed collections for core data (default to no-op so callers can always call these safely)
    let getAllVotersFs = async () => [];
    let setVoterFs = async () => {};
    let deleteVoterFs = async () => {};
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

    let getAllVoterListsFs = async () => [];
    let getVoterListFs = async () => null;
    let getVoterListFromServerFs = async () => null;
    let setVoterListFs = async () => {};
    let deleteVoterListFs = async () => {};
    let onVoterListsSnapshotFs = () => noopUnsubscribe;
    let getListShareByToken = async () => null;
    let setListShareFs = async () => {};
    let setListShareStatusFs = async () => {};
    let getListShareStatusFs = async () => [];
    let onListShareStatusSnapshotFs = () => noopUnsubscribe;
    let getListStatusByVoterIdFs = async () => [];

    try {
      const firestoreMod = await import(`${SDK_BASE}/firebase-firestore.js`);
      db = firestoreMod.getFirestore(app);
      const configRef = firestoreMod.doc(db, CAMPAIGN_CONFIG_COLLECTION, CAMPAIGN_CONFIG_DOC);
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
        const ref = firestoreMod.doc(db, MONITORS_COLLECTION, String(token));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setMonitorDoc = async (token, data) => {
        if (!token) return;
        const ref = firestoreMod.doc(db, MONITORS_COLLECTION, String(token));
        await firestoreMod.setDoc(ref, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
      };
      getVotedForMonitor = async (token) => {
        if (!token) return [];
        const ref = firestoreMod.collection(db, MONITORS_COLLECTION, String(token), "voted");
        const snap = await firestoreMod.getDocs(ref);
        return snap.docs.map((d) => ({ voterId: d.id, timeMarked: d.data().timeMarked }));
      };
      setVotedForMonitor = async (token, voterId, timeMarked) => {
        if (!token || !voterId) return;
        const ref = firestoreMod.doc(db, MONITORS_COLLECTION, String(token), "voted", String(voterId));
        await firestoreMod.setDoc(ref, { timeMarked: timeMarked || new Date().toISOString() });
      };
      onVotedSnapshotForMonitor = (token, handler) => {
        if (!token || typeof handler !== "function") return noopUnsubscribe;
        const ref = firestoreMod.collection(db, MONITORS_COLLECTION, String(token), "voted");
        return firestoreMod.onSnapshot(ref, (snap) => {
          const entries = snap.docs.map((d) => ({ voterId: d.id, timeMarked: d.data().timeMarked }));
          handler(entries);
        });
      };
      deleteMonitorDoc = async (token) => {
        if (!token) return;
        const ref = firestoreMod.doc(db, MONITORS_COLLECTION, String(token));
        await firestoreMod.deleteDoc(ref);
      };

      // Voters collection
      const VOTERS_COLLECTION = "voters";
      const votersColRef = firestoreMod.collection(db, VOTERS_COLLECTION);

      getAllVotersFs = async () => {
        const snap = await firestoreMod.getDocs(votersColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };

      setVoterFs = async (voter) => {
        if (!voter || !voter.id) return;
        const ref = firestoreMod.doc(db, VOTERS_COLLECTION, String(voter.id));
        await firestoreMod.setDoc(ref, voter, { merge: true });
      };

      deleteVoterFs = async (id) => {
        if (!id) return;
        const ref = firestoreMod.doc(db, VOTERS_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };

      onVotersSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return firestoreMod.onSnapshot(votersColRef, (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          handler(items);
        });
      };

      // Agents collection
      const AGENTS_COLLECTION = "agents";
      const agentsColRef = firestoreMod.collection(db, AGENTS_COLLECTION);

      getAllAgentsFs = async () => {
        const snap = await firestoreMod.getDocs(agentsColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };

      setAgentFs = async (agent) => {
        if (!agent || !agent.id) return;
        const ref = firestoreMod.doc(db, AGENTS_COLLECTION, String(agent.id));
        await firestoreMod.setDoc(ref, agent, { merge: true });
      };

      deleteAgentFs = async (id) => {
        if (!id) return;
        const ref = firestoreMod.doc(db, AGENTS_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };

      onAgentsSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return firestoreMod.onSnapshot(agentsColRef, (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          handler(items);
        });
      };

      // Candidates collection
      const CANDIDATES_COLLECTION = "candidates";
      const candidatesColRef = firestoreMod.collection(db, CANDIDATES_COLLECTION);

      getAllCandidatesFs = async () => {
        const snap = await firestoreMod.getDocs(candidatesColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };

      setCandidateFs = async (candidate) => {
        if (!candidate || candidate.id == null || candidate.id === "") return;
        const ref = firestoreMod.doc(db, CANDIDATES_COLLECTION, String(candidate.id));
        // Firestore does not accept undefined; strip or replace so writes succeed.
        const data = {};
        for (const [key, value] of Object.entries(candidate)) {
          if (value !== undefined) data[key] = value;
        }
        await firestoreMod.setDoc(ref, data, { merge: true });
      };

      deleteCandidateFs = async (id) => {
        if (!id) return;
        const ref = firestoreMod.doc(db, CANDIDATES_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };

      onCandidatesSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return firestoreMod.onSnapshot(candidatesColRef, (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          handler(items);
        });
      };

      // Voter lists (saved lists)
      const voterListsColRef = firestoreMod.collection(db, VOTER_LISTS_COLLECTION);
      getAllVoterListsFs = async () => {
        const snap = await firestoreMod.getDocs(voterListsColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };
      getVoterListFs = async (listId) => {
        if (!listId) return null;
        const ref = firestoreMod.doc(db, VOTER_LISTS_COLLECTION, String(listId));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      getVoterListFromServerFs = async (listId) => {
        if (!listId) return null;
        const ref = firestoreMod.doc(db, VOTER_LISTS_COLLECTION, String(listId));
        const getDocFromServer = firestoreMod.getDocFromServer || firestoreMod.getDoc;
        const snap = await getDocFromServer(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setVoterListFs = async (list) => {
        if (!list || !list.id) return;
        const ref = firestoreMod.doc(db, VOTER_LISTS_COLLECTION, String(list.id));
        const data = { ...list, updatedAt: new Date().toISOString() };
        delete data.id;
        await firestoreMod.setDoc(ref, data, { merge: true });
      };
      deleteVoterListFs = async (listId) => {
        if (!listId) return;
        const ref = firestoreMod.doc(db, VOTER_LISTS_COLLECTION, String(listId));
        await firestoreMod.deleteDoc(ref);
      };
      onVoterListsSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return firestoreMod.onSnapshot(voterListsColRef, (snap) => {
          handler(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        });
      };

      // Shared list (candidate link) – doc id = token
      getListShareByToken = async (token) => {
        if (!token) return null;
        const ref = firestoreMod.doc(db, VOTER_LIST_SHARES_COLLECTION, String(token));
        const snap = await firestoreMod.getDoc(ref);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
        return null;
      };
      setListShareFs = async (token, data) => {
        if (!token) return;
        const ref = firestoreMod.doc(db, VOTER_LIST_SHARES_COLLECTION, String(token));
        await firestoreMod.setDoc(ref, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
      };
      setListShareStatusFs = async (token, voterId, status) => {
        if (!token || !voterId) return;
        const ref = firestoreMod.doc(db, VOTER_LIST_SHARES_COLLECTION, String(token), "status", String(voterId));
        await firestoreMod.setDoc(ref, { status: status || "", updatedAt: new Date().toISOString() });
      };
      getListShareStatusFs = async (token) => {
        if (!token) return [];
        const ref = firestoreMod.collection(db, VOTER_LIST_SHARES_COLLECTION, String(token), "status");
        const snap = await firestoreMod.getDocs(ref);
        return snap.docs.map((d) => ({ voterId: d.id, ...d.data() }));
      };
      onListShareStatusSnapshotFs = (token, handler) => {
        if (!token || typeof handler !== "function") return noopUnsubscribe;
        const ref = firestoreMod.collection(db, VOTER_LIST_SHARES_COLLECTION, String(token), "status");
        return firestoreMod.onSnapshot(ref, (snap) => {
          handler(snap.docs.map((d) => ({ voterId: d.id, ...d.data() })));
        });
      };
      getListStatusByVoterIdFs = async (voterId) => {
        const lists = await firestoreMod.getDocs(voterListsColRef);
        const out = [];
        for (const listDoc of lists.docs) {
          const list = listDoc.data();
          const shareToken = list.shareToken;
          if (!shareToken) continue;
          const statusRef = firestoreMod.doc(db, VOTER_LIST_SHARES_COLLECTION, shareToken, "status", String(voterId));
          const statusSnap = await firestoreMod.getDoc(statusRef);
          if (statusSnap && statusSnap.exists()) {
            out.push({ listId: listDoc.id, listName: list.name, shareToken, ...statusSnap.data() });
          }
        }
        return out;
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
      ready: true,
      onAuthStateChanged: authMod.onAuthStateChanged.bind(null, auth),
      signOut: () => authMod.signOut(auth),
      signInWithEmailAndPassword: authMod.signInWithEmailAndPassword.bind(null, auth),
      createUserWithEmailAndPassword: authMod.createUserWithEmailAndPassword.bind(null, auth),
      sendEmailVerification: authMod.sendEmailVerification,
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
      onVotedSnapshotForMonitor,
      deleteMonitorDoc,
      // Firestore-backed core collections
      getAllVotersFs,
      setVoterFs,
      deleteVoterFs,
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
      setListShareStatusFs,
      getListShareStatusFs,
      onListShareStatusSnapshotFs,
      getListStatusByVoterIdFs,
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

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
    let getMonitorByToken = () => Promise.resolve(null);
    let setMonitorDoc = () => Promise.resolve();
    let getVotedForMonitor = () => Promise.resolve([]);
    let setVotedForMonitor = () => Promise.resolve();
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
      getMonitorByToken,
      setMonitorDoc,
      getVotedForMonitor,
      setVotedForMonitor,
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

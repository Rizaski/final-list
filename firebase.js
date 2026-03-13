/**
 * Firebase Integration — Auth + Firestore.
 * Defensive init so the app works when Firebase is unavailable (e.g. network, CORS).
 * Exports firebaseInitPromise → { auth, db, ...authFns, getFirestoreCampaignConfig, setFirestoreCampaignConfig, updateFirestoreCampaignConfig, deleteFirestoreCampaignConfig }.
 * CRUD for campaign config: Read (get), Create/Replace (set), Update (patch), Delete.
 */
const FIREBASE_SDK_VERSION = "9.22.2";
const SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

const firebaseConfig = {
  apiKey: "AIzaSyBHdQew7S2YnYHZ5UziNAyfpOK0nbYJyRA",
  authDomain: "otptesting-dd3be.firebaseapp.com",
  projectId: "otptesting-dd3be",
  storageBucket: "otptesting-dd3be.firebasestorage.app",
  messagingSenderId: "613044450374",
  appId: "1:613044450374:web:26d2a3384938e4de27c647",
  measurementId: "G-J9M7NJTFJD",
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

    // Firestore-backed collections for core data
    let getAllVotersFs = async () => [];
    let setVoterFs = async () => {};
    let deleteVoterFs = async () => {};
    let onVotersSnapshotFs = () => noopUnsubscribe;

    let getAllAgentsFs = async () => [];
    let setAgentFs = async () => {};
    let deleteAgentFs = async () => {};
    let onAgentsSnapshotFs = () => noopUnsubscribe;

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

      let getAllCandidatesFs = async () => {
        const snap = await firestoreMod.getDocs(candidatesColRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };

      let setCandidateFs = async (candidate) => {
        if (!candidate || !candidate.id) return;
        const ref = firestoreMod.doc(db, CANDIDATES_COLLECTION, String(candidate.id));
        await firestoreMod.setDoc(ref, candidate, { merge: true });
      };

      let deleteCandidateFs = async (id) => {
        if (!id) return;
        const ref = firestoreMod.doc(db, CANDIDATES_COLLECTION, String(id));
        await firestoreMod.deleteDoc(ref);
      };

      let onCandidatesSnapshotFs = (handler) => {
        if (typeof handler !== "function") return noopUnsubscribe;
        return firestoreMod.onSnapshot(candidatesColRef, (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          handler(items);
        });
      };
    } catch (fsErr) {
      console.warn("[Firebase] Firestore init failed — campaign config will use localStorage only.", fsErr);
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
    console.warn(
      "[Firebase] Initialization failed — auth disabled. Use demo mode or check network/config.",
      err
    );
    return {
      auth: null,
      db: null,
      ready: false,
      onAuthStateChanged: () => noopUnsubscribe,
      signOut: noopPromise,
      signInWithEmailAndPassword: () => Promise.reject(new Error("Firebase unavailable")),
      createUserWithEmailAndPassword: () => Promise.reject(new Error("Firebase unavailable")),
      getFirestoreCampaignConfig: () => Promise.resolve(null),
      setFirestoreCampaignConfig: () => Promise.resolve(),
      updateFirestoreCampaignConfig: () => Promise.resolve(),
      deleteFirestoreCampaignConfig: () => Promise.resolve(),
      getMonitorByToken: () => Promise.resolve(null),
      setMonitorDoc: () => Promise.resolve(),
      getVotedForMonitor: () => Promise.resolve([]),
      setVotedForMonitor: () => Promise.resolve(),
      deleteMonitorDoc: () => Promise.resolve(),
    };
  }
})();

# Dhuvaafaru Campaign Portal

Campaign console for managing voters, pledges, events, and zero-day operations. Uses **Firebase Auth** for sign-in and **Firestore** for campaign config sync.

## Running locally

Firebase requires a **secure context** (HTTP/HTTPS). Opening `index.html` via `file://` will not work for Auth/Firestore; use a local server.

### Option 1: Firebase CLI

```bash
npm install -g firebase-tools
firebase login
firebase serve
```

Then open **http://localhost:5000** (or the URL shown).

### Option 2: Node (serve)

```bash
npx serve .
```

Then open the URL shown (e.g. http://localhost:3000).

### Option 3: Python

```bash
# Python 3
python -m http.server 8080
```

Then open **http://localhost:8080**.

## Firebase setup

1. Create a project in [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** → Sign-in method → **Email/Password**.
3. Create a **Firestore Database** (start in test mode or add rules).
4. Copy your project config into `firebase.js` (replace `firebaseConfig`).
5. (Optional) Deploy Firestore rules from `firestore.rules`: add `"firestore": { "rules": "firestore.rules" }` to `firebase.json`, then run `firebase deploy --only firestore:rules`.

Campaign config is stored in Firestore at `campaign/config`. Rules in `firestore.rules` allow read/write for authenticated users.

## Deploy to Firebase Hosting

```bash
firebase login
firebase init hosting   # choose current directory as public, single-page app
firebase deploy
```

Your app will be served at `https://<project-id>.web.app`.

### Voters list not showing when deployed

If the voters list is empty after deployment (but works locally), do this:

1. **Add your deployment domain to Firebase**
   - [Firebase Console](https://console.firebase.google.com/) → your project → **Authentication** → **Settings** → **Authorized domains**.
   - Add the exact domain (e.g. `your-site.github.io`, `your-app.netlify.app`, or your custom domain). Without this, sign-in and Firestore reads can fail.

2. **Deploy Firestore rules**
   - Ensure `firestore.rules` is deployed (see “Firebase setup” above). If rules are missing or don’t allow read for authenticated users, the voters list will stay empty.

3. **Check the browser console**
   - After logging in, open DevTools → Console. If you see `[Voters] Failed to load from Firebase`, the message will include the reason (e.g. permission denied, network error).

## Login

- **Email + password**: Use Firebase Auth (works when the app is served over HTTP/HTTPS).
- **Dummy login (demo)**: Signs you in without Firebase; use when offline or for quick testing.

import "./ui.js";
import { firebaseInitPromise } from "./firebase.js";
import {
  initVotersModule,
  getVoterStats,
  getPledgeByBallotBox,
  refreshVotersFromFirestore,
  syncCandidateAssignmentsToFirebase,
  updateVoterPhone,
} from "./voters.js";
import { initPledgesModule, getPledgeStatsFromPledges } from "./pledges.js";
import { initEventsModule, getUpcomingEventsSummary, refreshEventsFromFirestore } from "./events.js";
import { initReportsModule } from "./reports.js";
import {
  initSettingsModule,
  getCampaignConfig,
  syncCampaignConfigFromFirestore,
  refreshAgentsFromFirestore,
  refreshCandidatesFromFirestore,
  openAddAgentModal,
  applySettingsTabsVisibility,
} from "./settings.js";
import { initCallsModule } from "./calls.js";
import {
  initZeroDayModule,
  initMonitorView,
  syncVotedFromFirestore,
  refreshTransportTripsFromFirestore,
  refreshTransportRoutesFromFirestore,
} from "./zeroDay.js";
import { initDoorToDoorModule } from "./doorToDoor.js";
import { initTableViewMenus } from "./table-view-menu.js";

/** Firestore ballot session — same doc as ballot-box.html (`monitors/{token}/ballotSession/settings`). */
function getMonitorBallotSessionOpts(api, monitorToken) {
  if (!api || !monitorToken) return undefined;
  if (!api.getBallotSessionFs || !api.setBallotSessionFs || !api.onBallotSessionSnapshotFs) {
    return undefined;
  }
  const t = String(monitorToken);
  return {
    get: () => api.getBallotSessionFs(t),
    set: (d) => api.setBallotSessionFs(t, d),
    subscribe: (cb) => api.onBallotSessionSnapshotFs(t, cb),
  };
}

const modulesMap = {
  dashboard: document.getElementById("module-dashboard"),
  voters: document.getElementById("module-voters"),
  pledges: document.getElementById("module-pledges"),
  "door-to-door": document.getElementById("module-door-to-door"),
  events: document.getElementById("module-events"),
  reports: document.getElementById("module-reports"),
  calls: document.getElementById("module-calls"),
  "zero-day": document.getElementById("module-zero-day"),
  transportation: document.getElementById("module-transportation"),
  settings: document.getElementById("module-settings"),
};

const navButtons = Array.from(document.querySelectorAll(".nav-item"));
const SETTINGS_MODULE_KEY = "settings";
const ADMIN_EMAIL = "alirixamv@gmail.com";
const AUTH_STORAGE_KEY = "campaign-auth-user";

/** Log Firebase Auth errors with server payload (internal-error often hides detail in customData). */
function logFirebaseAuthError(context, err, opts = {}) {
  if (!err) {
    console.error(context, "(no error object)");
    return;
  }
  const payload = { code: err.code, message: err.message, name: err.name };
  try {
    const cd = err.customData;
    if (cd && typeof cd === "object") {
      payload.customDataKeys = Object.keys(cd);
      for (const k of Object.keys(cd)) {
        try {
          const v = cd[k];
          payload[`customData.${k}`] =
            v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        } catch (_) {}
      }
      const sr = cd._serverResponse;
      if (sr !== undefined && payload.serverResponse === undefined) {
        payload.serverResponse = typeof sr === "string" ? sr : JSON.stringify(sr);
      }
    }
  } catch (_) {}
  try {
    if (typeof err.toJSON === "function") {
      payload.errToJSON = err.toJSON();
    }
  } catch (_) {}
  console.error(context, payload, err);
  if (opts.mfaSignInStart) {
    console.warn(
      "[Auth] If the Network tab shows HTTP 500 on identitytoolkit.googleapis.com/.../mfaSignIn:start, the SMS step was rejected " +
      "on Google’s servers (often SMS regional policy, unsupported/blocked carrier or country, or project SMS settings). " +
      "Fix in Firebase Console → Authentication (SMS region policy, test phone numbers, MFA / Identity Platform billing), " +
      "not in app code. Generic JSON: { error: { code: 500, message: \"Internal error encountered.\" } }."
    );
  }
}

function authErrorMessageForUi(err, opts = {}) {
  if (!err || typeof err.message !== "string") {
    return "Something went wrong. Try again.";
  }
  const code = err.code || "";
  const msg = err.message.trim();

  if (code === "auth/invalid-credential" || code === "auth/wrong-password") {
    return "Incorrect email or password.";
  }
  if (code === "auth/user-not-found") {
    return "No account found for this email.";
  }
  if (code === "auth/user-disabled") {
    return "This account has been disabled.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many sign-in attempts. Wait a few minutes and try again.";
  }

  const isInternal =
    code === "auth/internal-error" ||
    code === "auth/internal-error-encountered" ||
    /internal-error/i.test(code);
  if (isInternal) {
    const looksGeneric = /^Firebase:\s*Error \(auth\/internal-error(-encountered)?\)\.?\s*$/i.test(msg);
    if (!looksGeneric && msg.length > 0) {
      return msg;
    }
    if (opts.mfaSignInStart) {
      return (
        "SMS could not be sent: Google returned a server error for this project (not fixable in the app). " +
        "An administrator must open Firebase Console → Authentication → SMS / multi-factor and allow the SMS region for the " +
        "enrolled phone’s country, verify billing/Identity Platform, or remove SMS MFA from this user so they can sign in " +
        "with email/password only. Use “Resend code” after changing settings, or contact Firebase Support with error mfaSignIn:start 500."
      );
    }
    return (
      "Authentication returned an internal error. Use https:// (not a file:// page), add this hostname under " +
      "Firebase Console → Authentication → Settings → Authorized domains, ensure SMS MFA / Identity Platform is set up " +
      "(billing + SMS region policy), and in Google Cloud → APIs & Services → Credentials ensure your Browser key allows " +
      "this origin if you use HTTP referrer restrictions. Check the browser console for customData / serverResponse."
    );
  }
  return err.message;
}

/**
 * SMS MFA after email/password (enrolled phone second factor).
 *
 * **Sign-in** (this file): after `auth/multi-factor-auth-required`, use
 *   `{ multiFactorHint, session: resolver.session }` — NOT `phoneNumber` + enrollment session.
 * **Enrollment** (signed-in user adds SMS): `multiFactor(user).getSession()` then
 *   `{ phoneNumber: '+1…', session: multiFactorSession }` — different options shape.
 *
 * Primary phone sign-in uses `signInWithPhoneNumber`, not this flow.
 */
const mfaLoginState = {
  resolver: null,
  verificationId: null,
  recaptchaVerifier: null,
  /** Widget id from RecaptchaVerifier.render(); used with grecaptcha.reset on errors (Firebase phone/MFA docs). */
  recaptchaWidgetId: null,
};

/**
 * Resolver hints must include a phone MultiFactorInfo with `factorId` and `uid`.
 * Using `hints[0]` when the first factor is not phone causes internal/provider errors.
 */
function pickPhoneMultiFactorHint(resolver, PhoneAuthProviderCls) {
  if (!resolver || !Array.isArray(resolver.hints) || resolver.hints.length === 0) {
    return null;
  }
  const phoneFactorId =
    PhoneAuthProviderCls && typeof PhoneAuthProviderCls.PROVIDER_ID === "string"
      ? PhoneAuthProviderCls.PROVIDER_ID
      : "phone";
  return (
    resolver.hints.find(
      (h) =>
        h &&
        typeof h === "object" &&
        h.factorId === phoneFactorId &&
        typeof h.uid === "string" &&
        h.uid.length > 0
    ) || null
  );
}

function resetMfaGrecaptchaWidget() {
  const wid = mfaLoginState.recaptchaWidgetId;
  mfaLoginState.recaptchaWidgetId = null;
  if (wid == null) return;
  try {
    if (typeof window.grecaptcha !== "undefined" && typeof window.grecaptcha.reset === "function") {
      window.grecaptcha.reset(wid);
    }
  } catch (_) {}
}

/** Id of the MFA invisible reCAPTCHA mount node (must match index.html). */
const MFA_RECAPTCHA_CONTAINER_ID = "loginMfaRecaptcha";

/**
 * Invisible RecaptchaVerifier.clear() does not fully unregister reCAPTCHA with Google's loader.
 * Clearing innerHTML still leaves "reCAPTCHA has already been rendered in this element" on retry.
 * Replace the mount node so each attempt uses a fresh DOM element (same id for Firebase lookup).
 */
function replaceMfaRecaptchaMountElement() {
  const oldEl = document.getElementById(MFA_RECAPTCHA_CONTAINER_ID);
  if (!oldEl || !oldEl.parentNode) return;
  try {
    const next = document.createElement("div");
    next.id = MFA_RECAPTCHA_CONTAINER_ID;
    next.className = oldEl.className || "login-mfa-recaptcha";
    if (oldEl.getAttribute("aria-label")) {
      next.setAttribute("aria-label", oldEl.getAttribute("aria-label"));
    } else {
      next.setAttribute("aria-label", "Security check");
    }
    oldEl.replaceWith(next);
  } catch (_) {}
}

/**
 * Tear down reCAPTCHA before a new verifier. If we replace the DOM immediately after clear(),
 * grecaptcha can throw "Cannot read properties of null (reading 'style')" — wait so callbacks finish.
 */
async function teardownMfaRecaptchaVerifier() {
  resetMfaGrecaptchaWidget();
  const hadVerifier = Boolean(mfaLoginState.recaptchaVerifier);
  if (mfaLoginState.recaptchaVerifier) {
    try {
      mfaLoginState.recaptchaVerifier.clear();
    } catch (_) {}
    mfaLoginState.recaptchaVerifier = null;
  }
  if (hadVerifier) {
    await new Promise((r) => setTimeout(r, 450));
  }
  replaceMfaRecaptchaMountElement();
}

function resetLoginStepsUi() {
  mfaLoginState.resolver = null;
  mfaLoginState.verificationId = null;
  void teardownMfaRecaptchaVerifier();
  const stepCred = document.getElementById("loginStepCredentials");
  const stepMfa = document.getElementById("loginStepMfa");
  if (stepCred) stepCred.hidden = false;
  if (stepMfa) stepMfa.hidden = true;
  const mfaCode = document.getElementById("loginMfaCode");
  if (mfaCode) mfaCode.value = "";
  const mfaErr = document.getElementById("loginMfaError");
  if (mfaErr) mfaErr.textContent = "";
  const mfaStatus = document.getElementById("loginMfaStatus");
  if (mfaStatus) mfaStatus.textContent = "";
  const mfaHint = document.getElementById("loginMfaHint");
  if (mfaHint) mfaHint.textContent = "";
}

function showLoginMfaStep(resolver, firebaseApi) {
  mfaLoginState.resolver = resolver;
  const stepCred = document.getElementById("loginStepCredentials");
  const stepMfa = document.getElementById("loginStepMfa");
  const hintEl = document.getElementById("loginMfaHint");
  if (stepCred) stepCred.hidden = true;
  if (stepMfa) stepMfa.hidden = false;
  const PhoneCls = firebaseApi && firebaseApi.PhoneAuthProvider;
  const hint = pickPhoneMultiFactorHint(resolver, PhoneCls);
  if (hintEl && hint) {
    const phone = hint.phoneNumber || hint.displayName || "your phone";
    hintEl.textContent = `Code will be sent to ${phone}.`;
  } else if (hintEl) {
    hintEl.textContent = "Enter the SMS code sent to your enrolled phone number.";
  }
}

async function sendMfaSmsToEnrolledPhone(firebaseApi, { statusEl, errorEl } = {}) {
  if (errorEl) errorEl.textContent = "";
  const resolver = mfaLoginState.resolver;
  if (!resolver || !Array.isArray(resolver.hints) || resolver.hints.length === 0) {
    if (errorEl) errorEl.textContent = "No SMS second factor is enrolled for this account.";
    return false;
  }
  if (resolver.session == null || typeof resolver.session !== "object") {
    if (errorEl) {
      errorEl.textContent =
        "Multi-factor session is missing or invalid. Return to email/password and sign in again.";
    }
    return false;
  }
  const hint = pickPhoneMultiFactorHint(resolver, firebaseApi && firebaseApi.PhoneAuthProvider);
  if (!hint) {
    if (errorEl) {
      errorEl.textContent =
        "No phone second factor found in this sign-in challenge. If you use another factor type, use an account with SMS MFA enrolled.";
    }
    return false;
  }
  if (!firebaseApi || !firebaseApi.auth) {
    if (errorEl) errorEl.textContent = "Authentication is not initialized.";
    return false;
  }

  const phoneInfoOptions = {
    multiFactorHint: hint,
    session: resolver.session,
  };

  try {
    if (statusEl) statusEl.textContent = "Sending code…";
    await teardownMfaRecaptchaVerifier();
    mfaLoginState.recaptchaWidgetId = null;
    const mountEl = document.getElementById(MFA_RECAPTCHA_CONTAINER_ID);
    if (!mountEl) {
      throw new Error("MFA reCAPTCHA mount node missing");
    }
    mfaLoginState.recaptchaVerifier = firebaseApi.createRecaptchaVerifier(mountEl, {
      size: "invisible",
    });
    const phoneAuth = new firebaseApi.PhoneAuthProvider(firebaseApi.auth);
    mfaLoginState.verificationId = await phoneAuth.verifyPhoneNumber(
      phoneInfoOptions,
      mfaLoginState.recaptchaVerifier
    );
    if (statusEl) statusEl.textContent = "Code sent. Enter it below.";
    return true;
  } catch (err) {
    logFirebaseAuthError("[Auth] MFA send SMS failed", err, { mfaSignInStart: true });
    await teardownMfaRecaptchaVerifier();
    if (errorEl) {
      errorEl.textContent =
        authErrorMessageForUi(err, { mfaSignInStart: true }) || "Could not send SMS code. Try again.";
    }
    if (statusEl) statusEl.textContent = "";
    return false;
  }
}

async function completeMfaSignIn(firebaseApi, verifyBtn, codeInput, errorEl) {
  if (errorEl) errorEl.textContent = "";
  const code = codeInput && codeInput.value ? codeInput.value.trim() : "";
  if (!code) {
    if (errorEl) errorEl.textContent = "Enter the SMS code.";
    return;
  }
  if (!mfaLoginState.verificationId || !mfaLoginState.resolver) {
    if (errorEl) errorEl.textContent = "Session expired. Go back and sign in again.";
    return;
  }
  const btnText = verifyBtn.querySelector(".btn__text");
  const defaultText = btnText ? btnText.textContent : verifyBtn.textContent;
  verifyBtn.disabled = true;
  verifyBtn.classList.add("btn--loading");
  if (btnText) btnText.textContent = "Verifying…";
  const spinner = document.createElement("span");
  spinner.className = "spinner--btn";
  spinner.setAttribute("aria-hidden", "true");
  verifyBtn.appendChild(spinner);
  try {
    const cred = firebaseApi.PhoneAuthProvider.credential(mfaLoginState.verificationId, code);
    const assertion = firebaseApi.PhoneMultiFactorGenerator.assertion(cred);
    await mfaLoginState.resolver.resolveSignIn(assertion);
  } catch (err) {
    logFirebaseAuthError("[Auth] MFA verification failed", err);
    if (errorEl) {
      errorEl.textContent = authErrorMessageForUi(err) || "Invalid code. Try again.";
    }
  } finally {
    verifyBtn.classList.remove("btn--loading");
    const sp = verifyBtn.querySelector(".spinner--btn");
    if (sp) sp.remove();
    if (btnText) btnText.textContent = defaultText;
    verifyBtn.disabled = false;
  }
}

function getCurrentUser() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const role =
      parsed.role === "candidate" ? "candidate" : parsed.role === "admin" ? "admin" : "staff";
    return {
      email: String(parsed.email || ""),
      name: String(parsed.name || "Campaign User"),
      isAdmin: Boolean(parsed.isAdmin) || role === "admin",
      role,
      candidateId: parsed.candidateId != null ? String(parsed.candidateId) : null,
    };
  } catch (_) {
    return null;
  }
}

function applyPledgesNavVisibility() {
  const user = getCurrentUser();
  const isCandidateOnly = user?.role === "candidate" && user?.candidateId;
  const pledgesBtn = document.querySelector('.nav-item[data-module="pledges"]');
  if (!pledgesBtn) return;
  const cfg = getCampaignConfig();
  const show = cfg.showPledgesNav !== false;
  /** Class + !important survives applyUserToShell clearing inline display on other nav items */
  pledgesBtn.classList.toggle("nav-item--hidden-sidebar", isCandidateOnly || !show);
  pledgesBtn.style.removeProperty("display");
  const activePledges = document.querySelector(
    '.nav-item.nav-item--active[data-module="pledges"]'
  );
  if (isCandidateOnly && activePledges) {
    switchModule("voters");
  } else if (!show && !isCandidateOnly && activePledges) {
    switchModule("dashboard");
  }
}

function setCurrentUser(user) {
  if (!user) {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (_) {}
    return;
  }
  try {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        email: user.email,
        name: user.name,
        isAdmin: user.isAdmin,
        role: user.role || "staff",
        candidateId: user.candidateId != null ? user.candidateId : null,
      })
    );
  } catch (_) {}
}

function applyUserToShell(user) {
  const appShell = document.querySelector(".app-shell");
  const loginView = document.getElementById("login-view");
  const email = user?.email || "";
  const name =
    user?.name ||
    (email ? email.split("@")[0].replace(/\./g, " ") : "Campaign User");

  const initial = name.trim().charAt(0).toUpperCase() || "A";

  const headerAvatar = document.querySelector(".user-avatar");
  const headerName = document.querySelector(".user-name");
  const headerRole = document.querySelector(".user-role");
  const menuAvatar = document.querySelector(".user-menu__avatar span");
  const menuName = document.querySelector(".user-menu__name");
  const menuRole = document.querySelector(".user-menu__role");

  if (headerAvatar) headerAvatar.textContent = initial;
  if (headerName) headerName.textContent = name;
  if (headerRole) {
    if (user?.role === "candidate" && user?.candidateId) headerRole.textContent = "Candidate";
    else headerRole.textContent = user?.isAdmin ? "Admin" : "Campaign Staff";
  }
  if (menuAvatar) menuAvatar.textContent = initial;
  if (menuName) menuName.textContent = name;
  if (menuRole) {
    if (user?.role === "candidate" && user?.candidateId) menuRole.textContent = "Candidate";
    else menuRole.textContent = user?.isAdmin ? "Administrator" : "Staff";
  }

  const settingsNavItem = document.querySelector(
    '.nav-item[data-module="settings"]'
  );
  if (settingsNavItem) {
    const showSettings =
      user?.isAdmin || (user?.role === "candidate" && user?.candidateId);
    settingsNavItem.style.display = showSettings ? "flex" : "none";
  }

  // Candidate users: Voters, Reports, and Settings (pledge CSV only)
  const isCandidateOnly = user?.role === "candidate" && user?.candidateId;
  navButtons.forEach((btn) => {
    const moduleKey = btn.dataset.module;
    if (moduleKey === "settings") return; // already handled above
    if (isCandidateOnly) {
      const allowed = moduleKey === "voters" || moduleKey === "reports";
      btn.style.display = allowed ? "flex" : "none";
    } else {
      btn.style.display = "";
    }
  });

  applyPledgesNavVisibility();

  // Show main app shell; hide login view (defensively set both hidden and display).
  if (appShell) {
    appShell.hidden = false;
    appShell.style.display = "";
  }
  if (loginView) {
    loginView.hidden = true;
    loginView.style.display = "none";
  }
  if (user) {
    resetLoginStepsUi();
  }
  try {
    applySettingsTabsVisibility();
  } catch (_) {}
}

function notifyAdminOfLockout(email) {
  const meta = `Suspicious login behaviour for ${email} at ${new Date().toLocaleString()}`;
  if (window.appNotifications) {
    window.appNotifications.push({
      title: "Login notice",
      meta,
    });
  }
  console.info("[Auth] Notify admin:", meta);
}

function switchModule(key) {
  const currentUser = getCurrentUser();
  const candidateOk =
    currentUser?.role === "candidate" &&
    currentUser?.candidateId &&
    (key === "reports" || key === "voters" || key === SETTINGS_MODULE_KEY);
  if (
    key === SETTINGS_MODULE_KEY &&
    !currentUser?.isAdmin &&
    !(currentUser?.role === "candidate" && currentUser?.candidateId)
  ) {
    return;
  }
  if (
    currentUser?.role === "candidate" &&
    currentUser?.candidateId &&
    !candidateOk
  ) {
    return;
  }
  if (key === "pledges" && getCampaignConfig().showPledgesNav === false) {
    return;
  }
  Object.entries(modulesMap).forEach(([moduleKey, el]) => {
    if (!el) return;
    el.classList.toggle("module--active", moduleKey === key);
  });
  navButtons.forEach((btn) => {
    btn.classList.toggle(
      "nav-item--active",
      btn.dataset.module === key
    );
  });
  // Sync voted data from Firestore when opening Voters so Ballot Box link marks show in Voted column
  if (key === "voters") syncVotedFromFirestore().catch(() => {});
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  const btn = document.getElementById("sidebarToggle");
  if (btn) btn.setAttribute("aria-label", "Open menu");
}

function openSidebar() {
  document.body.classList.add("sidebar-open");
  const btn = document.getElementById("sidebarToggle");
  if (btn) btn.setAttribute("aria-label", "Close menu");
}

function toggleSidebar() {
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  if (isMobile) {
    document.body.classList.toggle("sidebar-open");
  } else {
    document.body.classList.toggle("sidebar-collapsed");
  }
  const btn = document.getElementById("sidebarToggle");
  if (btn) {
    const isCollapsed = document.body.classList.contains("sidebar-collapsed");
    const isOpen = document.body.classList.contains("sidebar-open");
    if (isMobile) {
      btn.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
    } else {
      btn.setAttribute(
        "aria-label",
        isCollapsed ? "Expand sidebar" : "Collapse sidebar"
      );
    }
  }
}

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.module;
    switchModule(key);
    closeSidebar();
  });
});

const sidebarToggle = document.getElementById("sidebarToggle");
const sidebarOverlay = document.getElementById("sidebarOverlay");
if (sidebarToggle) {
  sidebarToggle.addEventListener("click", (e) => {
    e.preventDefault();
    toggleSidebar();
  });
}
const sidebarCollapseButton = document.getElementById("sidebarCollapseButton");
if (sidebarCollapseButton) {
  sidebarCollapseButton.addEventListener("click", (e) => {
    e.preventDefault();
    toggleSidebar();
  });
}
if (sidebarOverlay) {
  sidebarOverlay.addEventListener("click", closeSidebar);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("sidebar-open")) {
    closeSidebar();
  }
});

// User profile dropdown
const userProfileToggle = document.getElementById("userProfileToggle");
const userMenu = document.getElementById("userMenu");
const profileButton = document.getElementById("profileButton");
const notificationButton = document.getElementById("notificationButton");
const notificationPanel = document.getElementById("notificationPanel");
const notificationList = document.getElementById("notificationList");
const notificationDot = document.getElementById("notificationDot");
const notificationClearButton = document.getElementById("notificationClearButton");

let notifications = [];

function closeUserMenu() {
  if (!userMenu || !userProfileToggle) return;
  userMenu.classList.remove("user-menu--open");
  userProfileToggle.setAttribute("aria-expanded", "false");
}

function renderNotifications() {
  if (!notificationList) return;
  notificationList.innerHTML = "";
  if (!notifications.length) {
    const li = document.createElement("li");
    li.className = "notification-list__empty";
    li.textContent = "No notifications yet.";
    notificationList.appendChild(li);
  } else {
    notifications.forEach((n) => {
      const li = document.createElement("li");
      li.className = "notification-list__item";
      li.innerHTML = `
        <div class="notification-list__title">${n.title}</div>
        <div class="notification-list__meta">${n.meta}</div>
      `;
      notificationList.appendChild(li);
    });
  }
  if (notificationDot) {
    notificationDot.style.display = notifications.length ? "block" : "none";
  }
}

function pushNotification({ title, meta }) {
  notifications.unshift({
    id: Date.now(),
    title,
    meta,
  });
  if (notifications.length > 20) {
    notifications = notifications.slice(0, 20);
  }
  renderNotifications();
}

window.appNotifications = {
  push: pushNotification,
};

/**
 * Short-lived toast bottom-left (matches shell branding). Bell panel lists still use appNotifications.push.
 */
function showAppToast({ title, meta = "", durationMs = 6500, variant = "success" }) {
  const region = document.getElementById("appToastRegion");
  if (!region) return;
  const toast = document.createElement("div");
  toast.className = `app-toast app-toast--${variant}`;
  toast.setAttribute("role", "status");
  const tEl = document.createElement("div");
  tEl.className = "app-toast__title";
  tEl.textContent = title || "";
  const mEl = document.createElement("div");
  mEl.className = "app-toast__meta";
  mEl.textContent = meta || "";
  toast.appendChild(tEl);
  toast.appendChild(mEl);
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("app-toast--visible"));
  window.setTimeout(() => {
    toast.classList.remove("app-toast--visible");
    window.setTimeout(() => toast.remove(), 280);
  }, durationMs);
}

window.showAppToast = showAppToast;

function toggleUserMenu() {
  if (!userMenu || !userProfileToggle) return;
  const isOpen = userMenu.classList.toggle("user-menu--open");
  userProfileToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

if (userProfileToggle && userMenu) {
  userProfileToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleUserMenu();
  });
}

if (notificationButton && notificationPanel) {
  // Ensure we start in a closed state
  notificationPanel.hidden = true;
  notificationPanel.style.display = "none";
  notificationButton.setAttribute("aria-expanded", "false");
  renderNotifications();

  notificationButton.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCurrentlyHidden =
      notificationPanel.hidden ||
      notificationPanel.style.display === "none";

    const willOpen = isCurrentlyHidden;

    notificationPanel.hidden = !willOpen;
    notificationPanel.style.display = willOpen ? "block" : "none";
    notificationButton.setAttribute("aria-expanded", willOpen ? "true" : "false");

    if (willOpen && notificationDot) {
      notificationDot.style.display = notifications.length ? "block" : "none";
    }
  });
}

if (notificationClearButton) {
  notificationClearButton.addEventListener("click", () => {
    notifications = [];
    renderNotifications();
  });
}

const sidebarRefreshBtn = document.getElementById("sidebarRefreshBtn");
const refreshButtonEl = document.getElementById("refreshButton");
if (sidebarRefreshBtn && refreshButtonEl) {
  sidebarRefreshBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    refreshButtonEl.click();
    if (window.matchMedia("(max-width: 768px)").matches) closeSidebar();
  });
}

const sidebarNotificationsBtn = document.getElementById("sidebarNotificationsBtn");
if (sidebarNotificationsBtn && notificationButton) {
  sidebarNotificationsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    notificationButton.click();
  });
}

const sidebarSearchFocusBtn = document.getElementById("sidebarSearchFocusBtn");
const globalSearchInput = document.getElementById("globalSearch");
if (sidebarSearchFocusBtn && globalSearchInput) {
  sidebarSearchFocusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    globalSearchInput.focus();
    try {
      globalSearchInput.select();
    } catch (_) {}
    if (window.matchMedia("(max-width: 768px)").matches) closeSidebar();
  });
}

document.addEventListener("click", (e) => {
  if (
    userMenu &&
    userProfileToggle &&
    userMenu.classList.contains("user-menu--open") &&
    !userMenu.contains(e.target) &&
    !userProfileToggle.contains(e.target)
  ) {
    closeUserMenu();
  }

  if (notificationPanel && notificationButton) {
    if (
      !(notificationPanel.hidden || notificationPanel.style.display === "none") &&
      !notificationPanel.contains(e.target) &&
      !notificationButton.contains(e.target)
    ) {
      notificationPanel.hidden = true;
      notificationPanel.style.display = "none";
      notificationButton.setAttribute("aria-expanded", "false");
    }
  }
});

if (profileButton) {
  profileButton.addEventListener("click", () => {
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Profile coming soon",
        meta: "User account details and preferences will be available in a future update.",
      });
    } else {
      console.info("[Profile] Profile view is not implemented yet.");
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeUserMenu();
    if (
      notificationPanel &&
      notificationButton &&
      !(notificationPanel.hidden || notificationPanel.style.display === "none")
    ) {
      notificationPanel.hidden = true;
      notificationPanel.style.display = "none";
      notificationButton.setAttribute("aria-expanded", "false");
    }
  }
});

document.querySelectorAll("[data-open-module]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-open-module");
    switchModule(key);
  });
});

const electionTypeSelect = document.getElementById("electionType");
const constituencySelect = document.getElementById("constituency");

const ELECTION_TYPE_MAP = [
  { campaign: "Local Council Election", value: "local", label: "Local Council" },
  { campaign: "Parliamentary Election", value: "parliamentary", label: "Parliamentary" },
  { campaign: "Presidential Election", value: "presidential", label: "Presidential" },
];

function applyElectionTypeFromCampaign() {
  if (!electionTypeSelect) return;
  const config = getCampaignConfig();
  const campaignType = (config.campaignType || "Local Council Election").trim();
  const mapped = ELECTION_TYPE_MAP.find((m) => m.campaign === campaignType) || ELECTION_TYPE_MAP[0];
  electionTypeSelect.innerHTML = `<option value="${mapped.value}">${mapped.label}</option>`;
  electionTypeSelect.value = mapped.value;
}

function getDashboardScope() {
  return {
    electionType: electionTypeSelect ? electionTypeSelect.value : "local",
    constituency: constituencySelect ? constituencySelect.value : "",
  };
}

function handleScopeChange() {
  const scope = getDashboardScope();
  refreshDashboard(scope);
}

applyElectionTypeFromCampaign();
electionTypeSelect.addEventListener("change", handleScopeChange);
constituencySelect.addEventListener("change", handleScopeChange);

document.addEventListener("campaign-config-changed", () => {
  applyElectionTypeFromCampaign();
  handleScopeChange();
  applyPledgesNavVisibility();
});

// Keep dashboard stats and charts up to date when data changes in other modules.
document.addEventListener("voters-updated", () => {
  const scope = getDashboardScope();
  refreshDashboard(scope);
});
document.addEventListener("pledges-updated", () => {
  const scope = getDashboardScope();
  refreshDashboard(scope);
});
document.addEventListener("events-updated", () => {
  const scope = getDashboardScope();
  refreshDashboard(scope);
});

if (globalSearchInput) {
  globalSearchInput.addEventListener("input", () => {
    const query = globalSearchInput.value.trim();
    document.dispatchEvent(
      new CustomEvent("global-search", {
        detail: { query },
      })
    );
  });
}

function renderDashboardStats(stats) {
  const totalVotersEl = document.getElementById("statTotalVoters");
  const totalVotersMetaEl = document.getElementById("statTotalVotersMeta");
  const pledgedVotersEl = document.getElementById("statPledgedVoters");
  const pledgePercentEl = document.getElementById("statPledgePercentage");
  const ballotBoxesEl = document.getElementById("statBallotBoxes");
  const upcomingEventsEl = document.getElementById("statUpcomingEvents");

  totalVotersEl.textContent = stats.totalVoters.toLocaleString("en-MV");
  if (totalVotersMetaEl) {
    const dup = stats.duplicateNationalIdRows || 0;
    const distinct = stats.distinctNationalIds;
    if (dup > 0 && typeof distinct === "number") {
      totalVotersMetaEl.textContent = `${dup.toLocaleString(
        "en-MV"
      )} extra row(s): same national ID appears more than once · ${distinct.toLocaleString(
        "en-MV"
      )} unique national IDs`;
    } else {
      totalVotersMetaEl.textContent = "Across selected scope";
    }
  }
  pledgedVotersEl.textContent = stats.pledgedCount.toLocaleString("en-MV");
  pledgePercentEl.textContent = `${stats.pledgePercentage.toFixed(1)}%`;

  if (ballotBoxesEl && typeof stats.ballotBoxes === "number") {
    ballotBoxesEl.textContent = stats.ballotBoxes.toLocaleString("en-MV");
  }
  if (upcomingEventsEl && typeof stats.upcomingEvents === "number") {
    upcomingEventsEl.textContent = stats.upcomingEvents.toLocaleString("en-MV");
  }

  // Brief pulse animation on stat cards when values update
  document.querySelectorAll(".grid--stats .stat-card").forEach((card) => {
    card.classList.add("stat-card--updated");
    clearTimeout(card._pulseTimeout);
    card._pulseTimeout = setTimeout(() => card.classList.remove("stat-card--updated"), 500);
  });
}

function renderDashboardUpcomingEvents(eventsSummary) {
  const list = document.getElementById("dashboardUpcomingEvents");
  list.innerHTML = "";
  eventsSummary.forEach((item) => {
    const li = document.createElement("li");
    li.className = "timeline-item";
    li.innerHTML = `
      <div class="timeline-item__time">${item.dateLabel}</div>
      <div class="timeline-item__content">
        <div><strong>${item.name}</strong> – ${item.location}</div>
        <div class="helper-text">${item.scope} • ${item.team}</div>
      </div>
    `;
    list.appendChild(li);
  });
}

function renderDashboardSupportChart(items) {
  const container = document.getElementById("dashboardSupportChart");
  if (!container) return;
  container.innerHTML = "";
  if (!items.length) {
    const div = document.createElement("div");
    div.className = "helper-text";
    div.textContent = "No data yet. Import voters to see pledge distribution by ballot box.";
    container.appendChild(div);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "chart-bar";
    row.innerHTML = `
      <div class="chart-bar__label">${item.label}</div>
      <div class="chart-bar__track">
        <div class="chart-bar__fill chart-bar__fill--primary" style="width:${item.value.toFixed(
          1
        )}%"></div>
      </div>
      <div class="chart-bar__value">${item.value.toFixed(1)}% pledged</div>
    `;
    container.appendChild(row);
  });
}

function renderDashboardActivity(activityItems) {
  const list = document.getElementById("dashboardRecentActivity");
  list.innerHTML = "";
  activityItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "activity-item";
    li.innerHTML = `
      <div>
        <div>${item.description}</div>
        <div class="activity-meta">${item.meta}</div>
      </div>
      <span class="pill pill--neutral">${item.category}</span>
    `;
    list.appendChild(li);
  });
}

function refreshDashboard(scope) {
  const voterStats = getVoterStats(scope);
  const pledgeStats = getPledgeStatsFromPledges(scope);
  const upcomingEvents = getUpcomingEventsSummary(scope);
  const pledgeByBox = getPledgeByBallotBox();

  const combinedStats = {
    totalVoters: voterStats.totalVoters,
    pledgedCount: pledgeStats.pledgedCount,
    pledgePercentage:
      voterStats.totalVoters === 0
        ? 0
        : (pledgeStats.pledgedCount / voterStats.totalVoters) * 100,
    ballotBoxes: pledgeByBox.length,
    upcomingEvents: upcomingEvents.length,
    distinctNationalIds: voterStats.distinctNationalIds,
    duplicateNationalIdRows: voterStats.duplicateNationalIdRows,
  };
  renderDashboardStats(combinedStats);

  renderDashboardUpcomingEvents(upcomingEvents);

  renderDashboardSupportChart(pledgeByBox);

  const activityItems = [];
  if (voterStats.totalVoters === 0 && upcomingEvents.length === 0) {
    activityItems.push({
      description: "No campaign activity yet.",
      meta: "Start by importing voters or adding events.",
      category: "System",
    });
  } else {
    activityItems.push({
      description: `${voterStats.totalVoters} voters currently in the system.`,
      meta: "Voters module",
      category: "Voters",
    });
    if (pledgeStats.pledgedCount > 0) {
      activityItems.push({
        description: `${pledgeStats.pledgedCount} voters marked as pledged.`,
        meta: "Pledges module",
        category: "Pledges",
      });
    }
    if (upcomingEvents.length > 0) {
      activityItems.push({
        description: `${upcomingEvents.length} upcoming campaign event${
          upcomingEvents.length > 1 ? "s" : ""
        }.`,
        meta: "Events module",
        category: "Events",
      });
    }
  }
  renderDashboardActivity(activityItems);
}

async function startAppModules(firebaseApi) {
  if (startAppModules._started) return;
  startAppModules._started = true;
  console.log("[App] Starting application modules…");

  const votersContext = await initVotersModule(getCurrentUser, { openAddAgentModal });
  const monitorToken = new URLSearchParams(window.location.search).get("monitor");

  if (monitorToken) {
    const appShell = document.querySelector(".app-shell");
    const monitorView = document.getElementById("monitor-view");
    if (appShell) appShell.hidden = true;
    if (monitorView) monitorView.hidden = false;
    initMonitorView(monitorToken, votersContext, {
      ballotSession: getMonitorBallotSessionOpts(firebaseApi, monitorToken),
    });
    return;
  }

  const pledgesContext = initPledgesModule(votersContext);
  initTableViewMenus();
  initDoorToDoorModule(votersContext);
  const eventsContext = initEventsModule();
  const callsContext = initCallsModule(votersContext);
  initReportsModule({ votersContext, pledgesContext, eventsContext, getCurrentUser });
  initZeroDayModule(votersContext, { pledgesContext, updateVoterPhone });
  initSettingsModule();
  syncCampaignConfigFromFirestore();
  applyElectionTypeFromCampaign();
  handleScopeChange();
  applyPledgesNavVisibility();

  const refreshBtn = document.getElementById("refreshButton");
  const refreshStatusEl = document.getElementById("refreshStatus");
  if (refreshBtn && refreshStatusEl) {
    let refreshInProgress = false;
    const runTopbarRefresh = async (isAuto = false) => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      refreshStatusEl.textContent = "Syncing…";
      refreshStatusEl.classList.add("topbar__refresh-status--active");
      refreshBtn.disabled = true;
      refreshBtn.classList.add("topbar__refresh-btn--spinning");
      try {
        await syncCampaignConfigFromFirestore();
        applyElectionTypeFromCampaign();
        handleScopeChange();
        applyPledgesNavVisibility();
        await syncCandidateAssignmentsToFirebase();
        await Promise.all([
          refreshVotersFromFirestore(),
          refreshAgentsFromFirestore(),
          refreshCandidatesFromFirestore(),
          refreshEventsFromFirestore(),
          refreshTransportTripsFromFirestore(),
          refreshTransportRoutesFromFirestore(),
        ]);
        await syncVotedFromFirestore();
        const scope = {
          electionType: electionTypeSelect.value,
          constituency: constituencySelect.value,
        };
        refreshDashboard(scope);
        document.dispatchEvent(new CustomEvent("zero-day-refresh"));
        refreshStatusEl.textContent = isAuto ? "Auto-sync completed" : "Syncing completed";
      } finally {
        refreshInProgress = false;
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("topbar__refresh-btn--spinning");
        setTimeout(() => {
          refreshStatusEl.textContent = "";
          refreshStatusEl.classList.remove("topbar__refresh-status--active");
        }, 2000);
      }
    };
    refreshBtn.addEventListener("click", () => {
      void runTopbarRefresh(false);
    });
    // Auto-run the same top-header refresh flow every 5 minutes.
    setInterval(() => {
      void runTopbarRefresh(true);
    }, 300000);
  }
}

async function handleAuthenticatedUser(firebaseApi, fbUser) {
  if (!fbUser) return;
  try {
    console.log("[Auth] Authenticated user detected", fbUser.email);
    const email = (fbUser.email || "").toLowerCase();
    let name =
      fbUser.displayName ||
      (email ? email.split("@")[0].replace(/\./g, " ") : "Campaign User");
    let role = "staff";
    let candidateId = null;
    let isAdmin = email === ADMIN_EMAIL.toLowerCase();
    if (firebaseApi.ready && firebaseApi.getCampaignUserByEmailFs) {
      try {
        const cu = await firebaseApi.getCampaignUserByEmailFs(email);
        if (cu) {
          if (cu.displayName && String(cu.displayName).trim()) name = String(cu.displayName).trim();
          role = cu.role === "candidate" ? "candidate" : cu.role === "admin" ? "admin" : "staff";
          candidateId = cu.candidateId != null && String(cu.candidateId).trim() ? String(cu.candidateId).trim() : null;
          isAdmin = role === "admin" || isAdmin;
        }
      } catch (_) {}
    }
    const user = { email, name, isAdmin, role, candidateId };
    setCurrentUser(user);
    applyUserToShell(user);
    switchModule(user?.role === "candidate" && user?.candidateId ? "voters" : "dashboard");
    const appLoader = document.getElementById("appLoaderOverlay");
    if (appLoader) {
      appLoader.hidden = false;
    }
    try {
      await startAppModules(firebaseApi);
    } catch (err) {
      console.error("[App] Failed to initialize modules after login", err);
    } finally {
      if (appLoader) {
        appLoader.hidden = true;
      }
    }
  } catch (err) {
    console.error("[App] Failed to apply authenticated user", err);
  }
}

async function boot() {
  console.log("[App] boot() starting – waiting for Firebase init…");
  let firebaseApi;
  try {
    firebaseApi = await firebaseInitPromise;
  } catch (err) {
    console.error("[App] Firebase failed to initialize. App cannot start without Firebase.", err);
    const loginError = document.getElementById("loginError");
    const loginView = document.getElementById("login-view");
    const appShell = document.querySelector(".app-shell");
    if (appShell) {
      appShell.hidden = true;
      appShell.style.display = "none";
    }
    if (loginView) {
      loginView.hidden = false;
      loginView.style.display = "";
    }
    if (loginError) {
      loginError.textContent =
        "Firebase failed to initialize. Please check your network connection and Firebase configuration, then reload this page.";
    }
    return;
  }
  console.log("[App] Firebase initialized", !!firebaseApi);

  if (firebaseApi && firebaseApi.projectId) {
    const pid = String(firebaseApi.projectId);
    const base = `https://console.firebase.google.com/project/${encodeURIComponent(pid)}`;
    const pidEl = document.getElementById("loginMfaProjectId");
    if (pidEl) pidEl.textContent = pid;
    const usersLink = document.getElementById("loginMfaConsoleUsers");
    const settingsLink = document.getElementById("loginMfaConsoleSettings");
    if (usersLink) usersLink.href = `${base}/authentication/users`;
    if (settingsLink) settingsLink.href = `${base}/authentication/settings`;
  }

  const monitorToken = new URLSearchParams(window.location.search).get("monitor");
  if (monitorToken) {
    // Standalone ballot-box page uses token-based access; no auth shell.
    const votersContext = await initVotersModule(() => null);
    const appShell = document.querySelector(".app-shell");
    const monitorView = document.getElementById("monitor-view");
    const loginView = document.getElementById("login-view");
    if (appShell) appShell.hidden = true;
    if (loginView) loginView.hidden = true;
    if (monitorView) monitorView.hidden = false;
    initMonitorView(monitorToken, votersContext, {
      ballotSession: getMonitorBallotSessionOpts(firebaseApi, monitorToken),
    });
    return;
  }

  const appShell = document.querySelector(".app-shell");
  const loginView = document.getElementById("login-view");
  const loginForm = document.getElementById("loginForm");
  const loginEmail = document.getElementById("loginEmail");
  const loginPassword = document.getElementById("loginPassword");
  const loginError = document.getElementById("loginError");
  const loginSubmit = document.getElementById("loginSubmit");
  const appLoaderBoot = document.getElementById("appLoaderOverlay");
  const cachedUser = getCurrentUser();

  if (cachedUser && cachedUser.email) {
    if (appShell) {
      appShell.hidden = false;
      appShell.style.display = "";
    }
    if (loginView) {
      loginView.hidden = true;
      loginView.style.display = "none";
    }
    applyUserToShell(cachedUser);
    if (appLoaderBoot) appLoaderBoot.hidden = false;
  } else {
    if (appShell) {
      appShell.hidden = true;
      appShell.style.display = "none";
    }
    if (loginView) {
      loginView.hidden = false;
      loginView.style.display = "";
    }
  }

  // React to auth state
  if (firebaseApi.onAuthStateChanged) {
    firebaseApi.onAuthStateChanged(async (fbUser) => {
      console.log("[Auth] onAuthStateChanged fired", fbUser && fbUser.email);
      if (fbUser) {
        await handleAuthenticatedUser(firebaseApi, fbUser);
      } else {
        setCurrentUser(null);
        resetLoginStepsUi();
        if (appShell) appShell.hidden = true;
        if (loginView) {
          loginView.hidden = false;
          loginView.style.display = "";
        }
        const appLoader = document.getElementById("appLoaderOverlay");
        if (appLoader) appLoader.hidden = true;
      }
    });
  }

  // Login form handler (email/password via Firebase)
  if (loginForm && firebaseApi.signInWithEmailAndPassword) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      console.log("[Auth] Login form submitted");
      if (loginError) {
        loginError.textContent = "";
      }
      const email = loginEmail?.value.trim();
      const password = loginPassword?.value || "";
      if (!email || !password) {
        if (loginError) loginError.textContent = "Enter email and password.";
        console.warn("[Auth] Login blocked: email or password missing");
        return;
      }
      const btnText = loginSubmit.querySelector(".btn__text");
      const defaultText = btnText ? btnText.textContent : loginSubmit.textContent;
      if (loginSubmit) {
        loginSubmit.disabled = true;
        loginSubmit.classList.add("btn--loading");
        if (btnText) btnText.textContent = "Signing in…";
        const spinner = document.createElement("span");
        spinner.className = "spinner--btn";
        spinner.setAttribute("aria-hidden", "true");
        loginSubmit.appendChild(spinner);
      }
      try {
        console.log("[Auth] Calling signInWithEmailAndPassword", email);
        await firebaseApi.signInWithEmailAndPassword(email, password);
        console.log("[Auth] signInWithEmailAndPassword resolved successfully");
      } catch (err) {
        logFirebaseAuthError("[Auth] Login failed", err);
        if (
          err &&
          err.code === "auth/multi-factor-auth-required" &&
          typeof firebaseApi.getMultiFactorResolver === "function"
        ) {
          try {
            const resolver = firebaseApi.getMultiFactorResolver(err);
            const phoneHint = pickPhoneMultiFactorHint(resolver, firebaseApi.PhoneAuthProvider);
            if (
              !phoneHint ||
              resolver.session == null ||
              typeof resolver.session !== "object"
            ) {
              if (loginError) {
                loginError.textContent =
                  "This account needs SMS as a second factor, but the sign-in challenge did not include a valid phone factor. Sign in again or contact your administrator.";
              }
            } else {
              showLoginMfaStep(resolver, firebaseApi);
              const statusEl = document.getElementById("loginMfaStatus");
              const errorEl = document.getElementById("loginMfaError");
              await sendMfaSmsToEnrolledPhone(firebaseApi, { statusEl, errorEl });
              document.getElementById("loginMfaCode")?.focus();
            }
          } catch (mfaErr) {
            logFirebaseAuthError("[Auth] MFA flow failed", mfaErr);
            if (loginError) {
              loginError.textContent =
                authErrorMessageForUi(mfaErr) || "Could not start SMS verification.";
            }
          }
        } else if (loginError) {
          loginError.textContent =
            authErrorMessageForUi(err) || "Sign-in failed. Check your credentials.";
        }
      } finally {
        if (loginSubmit) {
          loginSubmit.classList.remove("btn--loading");
          const sp = loginSubmit.querySelector(".spinner--btn");
          if (sp) sp.remove();
          if (btnText) btnText.textContent = defaultText;
          loginSubmit.disabled = false;
        }
      }
    });
  }

  const loginMfaVerify = document.getElementById("loginMfaVerify");
  const loginMfaResend = document.getElementById("loginMfaResend");
  const loginMfaCancel = document.getElementById("loginMfaCancel");
  const loginMfaCode = document.getElementById("loginMfaCode");
  const loginMfaError = document.getElementById("loginMfaError");
  const loginMfaStatus = document.getElementById("loginMfaStatus");

  if (loginMfaVerify && firebaseApi.PhoneAuthProvider && firebaseApi.PhoneMultiFactorGenerator) {
    loginMfaVerify.addEventListener("click", async () => {
      await completeMfaSignIn(firebaseApi, loginMfaVerify, loginMfaCode, loginMfaError);
    });
  }
  if (loginMfaResend) {
    loginMfaResend.addEventListener("click", async () => {
      await sendMfaSmsToEnrolledPhone(firebaseApi, { statusEl: loginMfaStatus, errorEl: loginMfaError });
    });
  }
  if (loginMfaCancel) {
    loginMfaCancel.addEventListener("click", async () => {
      resetLoginStepsUi();
      try {
        if (firebaseApi.signOut) await firebaseApi.signOut();
      } catch (_) {}
    });
  }
  if (loginMfaCode && loginMfaVerify) {
    loginMfaCode.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loginMfaVerify.click();
      }
    });
  }

  // Sign out from user menu
  const signOutButton = document.getElementById("signOutButton");
  if (signOutButton) {
    signOutButton.addEventListener("click", async () => {
      try {
        console.log("[Auth] Sign out clicked");
        if (firebaseApi.signOut) {
          await firebaseApi.signOut();
        }
      } catch (err) {
        console.error("[Auth] Sign out failed (falling back to local clear)", err);
      } finally {
        // Defensive: even if Firebase signOut fails, clear local session and show login.
        setCurrentUser(null);
        const appShellEl = document.querySelector(".app-shell");
        const loginViewEl = document.getElementById("login-view");
        if (appShellEl) {
          appShellEl.hidden = true;
          appShellEl.style.display = "none";
        }
        if (loginViewEl) {
          loginViewEl.hidden = false;
          loginViewEl.style.display = "";
        }
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", boot);


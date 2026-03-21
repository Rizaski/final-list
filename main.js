import "./ui.js";
import { firebaseInitPromise } from "./firebase.js";
import { initVotersModule, getVoterStats, getPledgeByBallotBox, refreshVotersFromStorage } from "./voters.js";
import { initPledgesModule, getPledgeStatsFromPledges } from "./pledges.js";
import { initEventsModule, getUpcomingEventsSummary } from "./events.js";
import { initReportsModule } from "./reports.js";
import { initSettingsModule, getCampaignConfig, syncCampaignConfigFromFirestore } from "./settings.js";
import { initCallsModule } from "./calls.js";
import { initZeroDayModule, initMonitorView, syncVotedFromFirestore } from "./zeroDay.js";
import { initDoorToDoorModule } from "./doorToDoor.js";

const modulesMap = {
  dashboard: document.getElementById("module-dashboard"),
  voters: document.getElementById("module-voters"),
  pledges: document.getElementById("module-pledges"),
  "door-to-door": document.getElementById("module-door-to-door"),
  events: document.getElementById("module-events"),
  reports: document.getElementById("module-reports"),
  calls: document.getElementById("module-calls"),
  "zero-day": document.getElementById("module-zero-day"),
  settings: document.getElementById("module-settings"),
};

const navButtons = Array.from(document.querySelectorAll(".nav-item"));
const SETTINGS_MODULE_KEY = "settings";
const ADMIN_EMAIL = "alirixamv@gmail.com";
const AUTH_STORAGE_KEY = "campaign-auth-user";

function getCurrentUser() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      email: String(parsed.email || ""),
      name: String(parsed.name || "Campaign User"),
      isAdmin: Boolean(parsed.isAdmin),
      role: parsed.role === "candidate" ? "candidate" : parsed.role === "admin" ? "admin" : "staff",
      candidateId: parsed.candidateId != null ? String(parsed.candidateId) : null,
    };
  } catch (_) {
    return null;
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
    settingsNavItem.style.display = user?.isAdmin ? "flex" : "none";
  }

  // Candidate users: Voters (full list + their pledge) and Reports; no other modules
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

  // Show main app shell; hide login view (defensively set both hidden and display).
  if (appShell) {
    appShell.hidden = false;
    appShell.style.display = "";
  }
  if (loginView) {
    loginView.hidden = true;
    loginView.style.display = "none";
  }
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
  if (key === SETTINGS_MODULE_KEY && !currentUser?.isAdmin) {
    // Guard against programmatic attempts to open settings
    return;
  }
  // Candidate users can only open Voters or Reports
  if (
    currentUser?.role === "candidate" &&
    currentUser?.candidateId &&
    key !== "reports" &&
    key !== "voters"
  ) {
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

const globalSearchInput = document.getElementById("globalSearch");

globalSearchInput.addEventListener("input", () => {
  const query = globalSearchInput.value.trim();
  document.dispatchEvent(
    new CustomEvent("global-search", {
      detail: { query },
    })
  );
});

function renderDashboardStats(stats) {
  const totalVotersEl = document.getElementById("statTotalVoters");
  const pledgedVotersEl = document.getElementById("statPledgedVoters");
  const pledgePercentEl = document.getElementById("statPledgePercentage");
  const ballotBoxesEl = document.getElementById("statBallotBoxes");
  const upcomingEventsEl = document.getElementById("statUpcomingEvents");

  totalVotersEl.textContent = stats.totalVoters.toLocaleString("en-MV");
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

  const votersContext = await initVotersModule(getCurrentUser);
  const monitorToken = new URLSearchParams(window.location.search).get("monitor");

  if (monitorToken) {
    const appShell = document.querySelector(".app-shell");
    const monitorView = document.getElementById("monitor-view");
    if (appShell) appShell.hidden = true;
    if (monitorView) monitorView.hidden = false;
    initMonitorView(monitorToken, votersContext);
    return;
  }

  const pledgesContext = initPledgesModule(votersContext);
  initDoorToDoorModule(votersContext);
  const eventsContext = initEventsModule();
  const callsContext = initCallsModule(votersContext);
  initReportsModule({ votersContext, pledgesContext, eventsContext, getCurrentUser });
  initZeroDayModule(votersContext, { pledgesContext });
  initSettingsModule();
  syncCampaignConfigFromFirestore();
  applyElectionTypeFromCampaign();
  handleScopeChange();

  const refreshBtn = document.getElementById("refreshButton");
  const refreshStatusEl = document.getElementById("refreshStatus");
  if (refreshBtn && refreshStatusEl) {
    refreshBtn.addEventListener("click", async () => {
      refreshStatusEl.textContent = "Syncing…";
      refreshStatusEl.classList.add("topbar__refresh-status--active");
      refreshBtn.disabled = true;
      refreshBtn.classList.add("topbar__refresh-btn--spinning");
      try {
        await syncCampaignConfigFromFirestore();
        refreshVotersFromStorage();
        const scope = {
          electionType: electionTypeSelect.value,
          constituency: constituencySelect.value,
        };
        refreshDashboard(scope);
        document.dispatchEvent(new CustomEvent("zero-day-refresh"));
        refreshStatusEl.textContent = "Syncing completed";
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("topbar__refresh-btn--spinning");
        setTimeout(() => {
          refreshStatusEl.textContent = "";
          refreshStatusEl.classList.remove("topbar__refresh-status--active");
        }, 2000);
      }
    });
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
    initMonitorView(monitorToken, votersContext);
    return;
  }

  const appShell = document.querySelector(".app-shell");
  const loginView = document.getElementById("login-view");
  const loginForm = document.getElementById("loginForm");
  const loginEmail = document.getElementById("loginEmail");
  const loginPassword = document.getElementById("loginPassword");
  const loginError = document.getElementById("loginError");
  const loginSubmit = document.getElementById("loginSubmit");

  if (appShell) {
    appShell.hidden = true;
    appShell.style.display = "none";
  }
  if (loginView) {
    loginView.hidden = false;
    loginView.style.display = "";
  }

  // React to auth state
  if (firebaseApi.onAuthStateChanged) {
    firebaseApi.onAuthStateChanged(async (fbUser) => {
      console.log("[Auth] onAuthStateChanged fired", fbUser && fbUser.email);
      if (fbUser) {
        await handleAuthenticatedUser(firebaseApi, fbUser);
      } else {
        setCurrentUser(null);
        if (appShell) appShell.hidden = true;
        if (loginView) loginView.hidden = false;
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
        console.error("[Auth] Login failed", err);
        if (loginError) {
          loginError.textContent =
            err && err.message
              ? err.message
              : "Sign-in failed. Check your credentials.";
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


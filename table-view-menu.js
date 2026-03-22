/**
 * Per-table "view" density (compact / default / comfortable) via ⋮ menus.
 * Persists in localStorage under campaignTableView:<tableId>.
 */

const STORAGE_PREFIX = "campaignTableView:";
const VIEW_CLASSES = ["table-view--compact", "table-view--default", "table-view--comfortable"];

export function getTableViewDensity(tableId) {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + tableId);
    if (v === "compact" || v === "default" || v === "comfortable") return v;
  } catch (_) {}
  return "default";
}

export function setTableViewDensity(tableId, density) {
  if (density !== "compact" && density !== "default" && density !== "comfortable") return;
  try {
    localStorage.setItem(STORAGE_PREFIX + tableId, density);
  } catch (_) {}
}

export function applyTableViewToElement(tableEl, density) {
  if (!tableEl) return;
  VIEW_CLASSES.forEach((c) => tableEl.classList.remove(c));
  tableEl.classList.add(`table-view--${density}`);
}

export function applyTableViewForId(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  applyTableViewToElement(table, getTableViewDensity(tableId));
}

/** HTML prepended inside Pledges column dropdown (before candidate checkboxes). */
export const TABLE_VIEW_MENU_SECTION_HTML = `
  <div class="dropdown-menu__item dropdown-menu__item--static">Table view</div>
  <button type="button" class="dropdown-menu__item table-view-dropdown__option" role="menuitem" data-table-view-density="compact">Compact</button>
  <button type="button" class="dropdown-menu__item table-view-dropdown__option" role="menuitem" data-table-view-density="default">Default</button>
  <button type="button" class="dropdown-menu__item table-view-dropdown__option" role="menuitem" data-table-view-density="comfortable">Comfortable</button>
  <div class="dropdown-menu__divider" role="separator"></div>
`;

function updateViewOptionActiveStates(menuEl, density) {
  menuEl.querySelectorAll("[data-table-view-density]").forEach((btn) => {
    const d = btn.getAttribute("data-table-view-density");
    const active = d === density;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function closeAllTableViewMenus(exceptMenu) {
  document.querySelectorAll("[data-table-view-dropdown]").forEach((m) => {
    if (m !== exceptMenu) {
      m.hidden = true;
      const wrap = m.closest("[data-table-view-for]");
      const b = wrap?.querySelector(".table-view-menu-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    }
  });
}

/**
 * Bind ⋮ dropdowns created with data-table-view-for="<table id>".
 * Idempotent per wrap via data-table-view-bound.
 */
export function initTableViewMenus(root = document) {
  root.querySelectorAll("[data-table-view-for]:not([data-table-view-bound])").forEach((wrap) => {
    const tableId = wrap.getAttribute("data-table-view-for");
    if (!tableId) return;
    const table = document.getElementById(tableId);
    const btn = wrap.querySelector(".table-view-menu-btn");
    const menu = wrap.querySelector("[data-table-view-dropdown]");
    if (!table || !btn || !menu) return;
    wrap.dataset.tableViewBound = "1";

    const apply = () => {
      const d = getTableViewDensity(tableId);
      applyTableViewToElement(table, d);
      updateViewOptionActiveStates(menu, d);
    };
    apply();

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      closeAllTableViewMenus(menu);
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) {
        apply();
        requestAnimationFrame(() => {
          document.addEventListener("click", onDoc);
        });
      }
    });

    function onDoc(ev) {
      if (wrap.contains(ev.target)) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDoc);
    }

    menu.querySelectorAll("[data-table-view-density]").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const d = opt.getAttribute("data-table-view-density");
        if (!d) return;
        setTableViewDensity(tableId, d);
        applyTableViewToElement(table, d);
        updateViewOptionActiveStates(menu, d);
        menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", onDoc);
      });
    });
  });
}

function bindPledgeMenuViewDelegationOnce() {
  const menu = document.getElementById("pledgeColumnsMenu");
  if (!menu || menu.dataset.tableViewDelegationBound) return;
  menu.dataset.tableViewDelegationBound = "1";
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-table-view-density]");
    if (!btn) return;
    e.stopPropagation();
    const d = btn.getAttribute("data-table-view-density");
    if (!d) return;
    const table = document.getElementById("pledgesTable");
    if (!table) return;
    setTableViewDensity("pledgesTable", d);
    applyTableViewToElement(table, d);
    menu.querySelectorAll("[data-table-view-density]").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-table-view-density") === d);
      b.setAttribute("aria-checked", b.getAttribute("data-table-view-density") === d ? "true" : "false");
    });
    menu.hidden = true;
    const colBtn = document.getElementById("pledgeColumnsButton");
    if (colBtn) colBtn.setAttribute("aria-expanded", "false");
  });
}

/** Call from initPledgesModule after DOM ready (pledges column menu exists). */
export function initPledgesTableViewInColumnMenu() {
  bindPledgeMenuViewDelegationOnce();
  applyTableViewForId("pledgesTable");
  const menu = document.getElementById("pledgeColumnsMenu");
  if (!menu) return;
  const d = getTableViewDensity("pledgesTable");
  menu.querySelectorAll("[data-table-view-density]").forEach((b) => {
    b.classList.toggle("is-active", b.getAttribute("data-table-view-density") === d);
    b.setAttribute("aria-checked", b.getAttribute("data-table-view-density") === d ? "true" : "false");
  });
}

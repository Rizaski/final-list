const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalFooter = document.getElementById("modalFooter");
const modalCloseButton = document.getElementById("modalCloseButton");

/** Cleared on each open so the previous dialog’s width variant does not stick. */
const MODAL_VARIANT_CLASSES = ["modal--wide"];

export function openModal({
  title,
  body,
  footer,
  startMaximized,
  dialogClass,
  hideMaximize,
  /** When false, clicking the dimmed backdrop does not close (use explicit Close / X). */
  closeOnBackdropClick = true,
  /** When false, Escape does not close (use explicit Close / X). */
  closeOnEscape = true,
} = {}) {
  if (!modalBackdrop || !modalTitle || !modalBody || !modalFooter) {
    console.error("[Modal] Missing modal DOM nodes (modalBackdrop / modalTitle / modalBody / modalFooter).");
    if (window.appNotifications) {
      window.appNotifications.push({
        title: "Dialog unavailable",
        meta: "Reload the page. If this persists, the layout may be incomplete.",
      });
    }
    return;
  }
  modalTitle.textContent = title || "";
  modalBody.innerHTML = "";
  modalFooter.innerHTML = "";
  const modalDialog = modalBackdrop.querySelector(".modal");
  if (modalDialog) {
    modalDialog.classList.remove("modal--maximized", ...MODAL_VARIANT_CLASSES);
    if (startMaximized) modalDialog.classList.add("modal--maximized");
    if (dialogClass && typeof dialogClass === "string") {
      dialogClass
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => modalDialog.classList.add(c));
    }
  }
  const maxBtn = document.getElementById("modalMaximizeButton");
  if (maxBtn) {
    if (hideMaximize) {
      maxBtn.hidden = true;
      maxBtn.style.display = "none";
    } else {
      maxBtn.hidden = false;
      maxBtn.style.removeProperty("display");
      const isMax = modalDialog && modalDialog.classList.contains("modal--maximized");
      maxBtn.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
      const iconMax = maxBtn.querySelector(".modal-icon-maximize");
      const iconRestore = maxBtn.querySelector(".modal-icon-restore");
      if (iconMax) iconMax.hidden = isMax;
      if (iconRestore) iconRestore.hidden = !isMax;
    }
  }
  if (body) modalBody.appendChild(body);
  if (footer) modalFooter.appendChild(footer);
  modalBackdrop.setAttribute("data-close-on-backdrop", closeOnBackdropClick ? "true" : "false");
  modalBackdrop.setAttribute("data-close-on-escape", closeOnEscape ? "true" : "false");
  modalBackdrop.hidden = false;
}

function toggleModalMaximized() {
  const modalDialog = modalBackdrop ? modalBackdrop.querySelector(".modal") : null;
  if (!modalDialog) return;
  const maxBtn = document.getElementById("modalMaximizeButton");
  const isMax = modalDialog.classList.toggle("modal--maximized");
  if (maxBtn) {
    maxBtn.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
    const iconMax = maxBtn.querySelector(".modal-icon-maximize");
    const iconRestore = maxBtn.querySelector(".modal-icon-restore");
    if (iconMax) iconMax.hidden = isMax;
    if (iconRestore) iconRestore.hidden = !isMax;
  }
}

export function closeModal() {
  if (modalBackdrop) {
    modalBackdrop.hidden = true;
    modalBackdrop.removeAttribute("data-close-on-backdrop");
    modalBackdrop.removeAttribute("data-close-on-escape");
  }
}

/**
 * Branded confirmation dialog (replaces window.confirm).
 * Returns a Promise<boolean>.
 */
export function confirmDialog(options = {}) {
  const title = options.title || "Confirm";
  const message = options.message || "Are you sure?";
  const confirmText = options.confirmText || "Confirm";
  const cancelText = options.cancelText || "Cancel";
  const danger = options.danger === true;

  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.className = "confirm-dialog";
    body.innerHTML = `
      <p class="confirm-dialog__message">${message}</p>
    `;

    const footer = document.createElement("div");
    footer.className = "form-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost-button";
    cancelBtn.textContent = cancelText;

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = danger ? "primary-button primary-button--danger" : "primary-button";
    okBtn.textContent = confirmText;

    const cleanupAndResolve = (val) => {
      try {
        closeModal();
      } finally {
        resolve(val);
      }
    };

    cancelBtn.addEventListener("click", () => cleanupAndResolve(false));
    okBtn.addEventListener("click", () => cleanupAndResolve(true));

    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    openModal({ title, body, footer });

    // Default focus to safe action
    setTimeout(() => cancelBtn.focus(), 0);
  });
}

if (modalCloseButton) {
  modalCloseButton.addEventListener("click", (e) => {
    e.preventDefault();
    closeModal();
  });
}

const modalMaximizeButton = document.getElementById("modalMaximizeButton");
if (modalMaximizeButton) {
  modalMaximizeButton.addEventListener("click", (e) => {
    e.preventDefault();
    toggleModalMaximized();
  });
}

if (modalBackdrop) {
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target !== modalBackdrop) return;
    if (modalBackdrop.getAttribute("data-close-on-backdrop") === "false") return;
    closeModal();
  });
}

// Close modal with Escape key as an additional safety
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !modalBackdrop || modalBackdrop.hidden) return;
  if (modalBackdrop.getAttribute("data-close-on-escape") === "false") return;
  closeModal();
});

/** Right-click menu root (single instance). */
let contextMenuEl = null;
let contextMenuTeardown = null;

export function closeContextMenu() {
  if (typeof contextMenuTeardown === "function") {
    try {
      contextMenuTeardown();
    } catch (_) {}
    contextMenuTeardown = null;
  }
  if (contextMenuEl && contextMenuEl.parentNode) {
    contextMenuEl.parentNode.removeChild(contextMenuEl);
  }
  contextMenuEl = null;
}

/**
 * @typedef {{ label: string, onSelect?: () => void, disabled?: boolean, danger?: boolean, separator?: boolean }} ContextMenuItem
 * @param {MouseEvent} event
 * @param {ContextMenuItem[]} items
 */
export function showContextMenu(event, items) {
  if (!event || !Array.isArray(items) || items.length === 0) return;
  const usable = items.filter(
    (x) => x && (x.separator === true || (typeof x.label === "string" && x.label.trim()))
  );
  if (!usable.length) return;
  event.preventDefault();
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  for (const item of usable) {
    if (item.separator) {
      const d = document.createElement("div");
      d.className = "context-menu__divider";
      menu.appendChild(d);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "context-menu__item" + (item.danger ? " context-menu__item--danger" : "");
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
      btn.classList.add("context-menu__item--disabled");
    } else {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeContextMenu();
        try {
          item.onSelect && item.onSelect();
        } catch (err) {
          console.error("[ContextMenu] action failed", err);
        }
      });
    }
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  contextMenuEl = menu;

  const place = () => {
    const rect = menu.getBoundingClientRect();
    let left = event.clientX;
    let top = event.clientY;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  requestAnimationFrame(place);

  const onDown = (ev) => {
    if (menu.contains(ev.target)) return;
    closeContextMenu();
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") closeContextMenu();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onDown, true);
  }, 0);
  contextMenuTeardown = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onDown, true);
  };
}

/**
 * Copy text; shows a short in-app notice when `window.appNotifications` exists.
 */
export async function copyTextToClipboard(text) {
  const t = String(text ?? "");
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    if (window.appNotifications) {
      const meta = t.length > 72 ? t.slice(0, 69) + "…" : t;
      window.appNotifications.push({ title: "Copied", meta });
    }
  } catch (err) {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      if (window.appNotifications) {
        window.appNotifications.push({ title: "Copied", meta: "To clipboard" });
      }
    } catch (e) {
      console.warn("[copyTextToClipboard] fallback failed", e);
    }
  }
}


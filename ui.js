const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalFooter = document.getElementById("modalFooter");
const modalCloseButton = document.getElementById("modalCloseButton");

/** Cleared on each open so the previous dialog’s width variant does not stick. */
const MODAL_VARIANT_CLASSES = ["modal--wide"];

export function openModal({ title, body, footer, startMaximized, dialogClass, hideMaximize }) {
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
  if (modalBackdrop) modalBackdrop.hidden = true;
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
    if (e.target === modalBackdrop) {
      closeModal();
    }
  });
}

// Close modal with Escape key as an additional safety
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalBackdrop && !modalBackdrop.hidden) {
    closeModal();
  }
});


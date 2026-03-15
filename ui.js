const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalFooter = document.getElementById("modalFooter");
const modalCloseButton = document.getElementById("modalCloseButton");

export function openModal({ title, body, footer }) {
  modalTitle.textContent = title || "";
  modalBody.innerHTML = "";
  modalFooter.innerHTML = "";
  const modalDialog = modalBackdrop ? modalBackdrop.querySelector(".modal") : null;
  if (modalDialog) modalDialog.classList.remove("modal--maximized");
  if (body) modalBody.appendChild(body);
  if (footer) modalFooter.appendChild(footer);
  modalBackdrop.hidden = false;
}

export function closeModal() {
  modalBackdrop.hidden = true;
}

if (modalCloseButton) {
  modalCloseButton.addEventListener("click", (e) => {
    e.preventDefault();
    closeModal();
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
  if (e.key === "Escape" && !modalBackdrop.hidden) {
    closeModal();
  }
});

// --- Confirmation dialog (app-styled) ---
const confirmBackdrop = document.getElementById("confirmDialogBackdrop");
const confirmTitleEl = document.getElementById("confirmDialogTitle");
const confirmMessageEl = document.getElementById("confirmDialogMessage");
const confirmCancelBtn = document.getElementById("confirmDialogCancel");
const confirmConfirmBtn = document.getElementById("confirmDialogConfirm");

/**
 * Show a confirmation dialog matching application style.
 * @param {Object} opts
 * @param {string} opts.title - Dialog title
 * @param {string} opts.message - Body message (HTML is escaped; use plain text)
 * @param {string} [opts.confirmLabel="Confirm"]
 * @param {string} [opts.cancelLabel="Cancel"]
 * @param {boolean} [opts.danger=false] - Use danger style for confirm button (e.g. delete)
 * @returns {Promise<boolean>} - true if user clicked Confirm, false if Cancel/backdrop/Escape
 */
export function confirmDialog({ title = "Confirm", message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  if (!confirmBackdrop || !confirmTitleEl || !confirmMessageEl || !confirmCancelBtn || !confirmConfirmBtn) {
    return Promise.resolve(false);
  }
  confirmTitleEl.textContent = title;
  confirmMessageEl.textContent = message;
  confirmCancelBtn.textContent = cancelLabel;
  confirmConfirmBtn.textContent = confirmLabel;
  confirmConfirmBtn.classList.toggle("confirm-dialog__btn--danger", danger);

  confirmBackdrop.hidden = false;
  confirmBackdrop.setAttribute("aria-hidden", "false");

  return new Promise((resolve) => {
    const onEscape = (e) => {
      if (e.key === "Escape") finish(false);
    };
    const onBackdrop = (e) => {
      if (e.target === confirmBackdrop) finish(false);
    };

    const finish = (result) => {
      confirmBackdrop.hidden = true;
      confirmBackdrop.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", onEscape);
      confirmBackdrop.removeEventListener("click", onBackdrop);
      resolve(result);
    };

    document.addEventListener("keydown", onEscape);
    confirmBackdrop.addEventListener("click", onBackdrop);
    confirmConfirmBtn.addEventListener("click", () => finish(true), { once: true });
    confirmCancelBtn.addEventListener("click", () => finish(false), { once: true });
  });
}


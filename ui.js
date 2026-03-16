const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalFooter = document.getElementById("modalFooter");
const modalCloseButton = document.getElementById("modalCloseButton");

export function openModal({ title, body, footer, startMaximized }) {
  modalTitle.textContent = title || "";
  modalBody.innerHTML = "";
  modalFooter.innerHTML = "";
  const modalDialog = modalBackdrop ? modalBackdrop.querySelector(".modal") : null;
  if (modalDialog) {
    modalDialog.classList.remove("modal--maximized");
    if (startMaximized) modalDialog.classList.add("modal--maximized");
  }
  const maxBtn = document.getElementById("modalMaximizeButton");
  if (maxBtn) {
    const isMax = modalDialog && modalDialog.classList.contains("modal--maximized");
    maxBtn.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
    const iconMax = maxBtn.querySelector(".modal-icon-maximize");
    const iconRestore = maxBtn.querySelector(".modal-icon-restore");
    if (iconMax) iconMax.hidden = isMax;
    if (iconRestore) iconRestore.hidden = !isMax;
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
  modalBackdrop.hidden = true;
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
  if (e.key === "Escape" && !modalBackdrop.hidden) {
    closeModal();
  }
});


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


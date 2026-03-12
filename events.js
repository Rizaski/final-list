import { openModal, closeModal } from "./ui.js";

const PAGE_SIZE = 15;

const eventsTableBody = document.querySelector("#eventsTable tbody");
const eventsTimeline = document.getElementById("eventsTimeline");
const addEventButton = document.getElementById("addEventButton");
const eventsPaginationEl = document.getElementById("eventsPagination");

// Dynamic events collection – initially empty.
let events = [];
let eventsCurrentPage = 1;

function formatDateTime(dtString) {
  const dt = new Date(dtString);
  return dt.toLocaleString("en-MV", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderEventsTable() {
  eventsTableBody.innerHTML = "";
  const sorted = [...events].sort(
    (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
  );
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (eventsCurrentPage > totalPages) eventsCurrentPage = totalPages;
  const start = (eventsCurrentPage - 1) * PAGE_SIZE;
  const pageEvents = sorted.slice(start, start + PAGE_SIZE);

  pageEvents.forEach((ev) => {
    const tr = document.createElement("tr");
    tr.dataset.eventId = String(ev.id);
    tr.innerHTML = `
      <td>${ev.name}</td>
      <td>${ev.location}</td>
      <td>${ev.scope}</td>
      <td>${formatDateTime(ev.dateTime)}</td>
      <td>${ev.team}</td>
      <td>${ev.expectedAttendees}</td>
      <td style="text-align:right;">
        <button class="ghost-button ghost-button--small" data-edit-event="${ev.id}">Edit</button>
      </td>
    `;
    eventsTableBody.appendChild(tr);
  });

  if (eventsPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    eventsPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${eventsCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${eventsCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${eventsCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    eventsPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && eventsCurrentPage > 1) eventsCurrentPage--;
        if (btn.dataset.page === "next" && eventsCurrentPage < totalPages) eventsCurrentPage++;
        renderEventsTable();
      });
    });
  }
}

function renderEventsTimeline() {
  eventsTimeline.innerHTML = "";
  const sorted = [...events].sort(
    (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
  );

  sorted.forEach((ev) => {
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.innerHTML = `
      <div class="timeline-item__time">${formatDateTime(ev.dateTime)}</div>
      <div class="timeline-item__content">
        <div><strong>${ev.name}</strong></div>
        <div class="helper-text">${ev.location} • ${ev.scope} • ${
      ev.team
    }</div>
      </div>
    `;
    eventsTimeline.appendChild(item);
  });
}

function openEventForm(existing) {
  const body = document.createElement("div");
  const isEdit = !!existing;
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="eventName">Event name</label>
        <input id="eventName" type="text" value="${existing?.name || ""}">
      </div>
      <div class="form-group">
        <label for="eventLocation">Event location</label>
        <input id="eventLocation" type="text" value="${
          existing?.location || ""
        }">
      </div>
      <div class="form-group">
        <label for="eventScope">Island / Constituency</label>
        <input id="eventScope" type="text" value="${existing?.scope || ""}">
      </div>
      <div class="form-group">
        <label for="eventDateTime">Date &amp; time</label>
        <input id="eventDateTime" type="datetime-local" value="${
          existing
            ? existing.dateTime.slice(0, 16)
            : new Date().toISOString().slice(0, 16)
        }">
      </div>
      <div class="form-group">
        <label for="eventTeam">Assigned campaign team</label>
        <input id="eventTeam" type="text" value="${existing?.team || ""}">
      </div>
      <div class="form-group">
        <label for="eventAttendees">Expected attendees</label>
        <input id="eventAttendees" type="number" min="0" value="${
          existing?.expectedAttendees || 0
        }">
      </div>
    </div>
  `;

  const footer = document.createElement("div");
  const saveBtn = document.createElement("button");
  saveBtn.className = "primary-button";
  saveBtn.textContent = isEdit ? "Save changes" : "Add event";
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", () => {
    const name = body.querySelector("#eventName").value.trim();
    const location = body.querySelector("#eventLocation").value.trim();
    const scope = body.querySelector("#eventScope").value.trim();
    const dateTime = body
      .querySelector("#eventDateTime")
      .value.trim();
    const team = body.querySelector("#eventTeam").value.trim();
    const attendees = Number(
      body.querySelector("#eventAttendees").value || 0
    );

    if (!name || !location || !scope || !dateTime) {
      return;
    }

    if (isEdit) {
      existing.name = name;
      existing.location = location;
      existing.scope = scope;
      existing.dateTime = dateTime;
      existing.team = team;
      existing.expectedAttendees = attendees;
    } else {
      const nextId =
        events.reduce((max, ev) => Math.max(max, ev.id), 0) + 1;
      events.push({
        id: nextId,
        name,
        location,
        scope,
        dateTime,
        team,
        expectedAttendees: attendees,
      });
    }

    renderEventsTable();
    renderEventsTimeline();
    document.dispatchEvent(
      new CustomEvent("events-updated", { detail: { events: [...events] } })
    );
    if (window.appNotifications) {
      window.appNotifications.push({
        title: isEdit ? "Event updated" : "Event added",
        meta: `${name} • ${scope}`,
      });
    }
    closeModal();
  });

  openModal({
    title: isEdit ? "Edit event" : "Add event",
    body,
    footer,
  });
}

export function initEventsModule() {
  renderEventsTable();
  renderEventsTimeline();

  eventsTableBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit-event]");
    if (!btn) return;
    const id = Number(btn.getAttribute("data-edit-event"));
    const existing = events.find((ev) => ev.id === id);
    if (existing) {
      openEventForm(existing);
    }
  });

  addEventButton.addEventListener("click", () => {
    openEventForm(null);
  });

  return {
    getEvents: () => [...events],
  };
}

export function getUpcomingEventsSummary(scope) {
  const now = new Date();
  const soon = events
    .filter((ev) => new Date(ev.dateTime) >= now)
    .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime))
    .slice(0, 4);

  return soon.map((ev) => ({
    dateLabel: formatDateTime(ev.dateTime),
    name: ev.name,
    location: ev.location,
    scope: ev.scope,
    team: ev.team,
  }));
}


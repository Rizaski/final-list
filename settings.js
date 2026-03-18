import { openModal, closeModal, confirmDialog } from "./ui.js";
import { importVotersFromTemplateRows } from "./voters.js";
import { firebaseInitPromise } from "./firebase.js";

const PAGE_SIZE = 15;
const MAX_VOTER_ROWS = 20000;
const MAX_VOTERS_FILE_BYTES = 15 * 1024 * 1024; // ~15MB safety cap
const AGENTS_STORAGE_KEY = "agents-data";
const CAMPAIGN_STORAGE_KEY = "campaign-config";
const CANDIDATES_STORAGE_KEY = "candidates-data";
const MAX_CANDIDATES = 10;

const sidebarBrandTitle = document.getElementById("sidebarBrandTitle");
const sidebarBrandSubtitle = document.getElementById("sidebarBrandSubtitle");

let campaignConfig = {
  campaignName: "",
  campaignType: "Local Council Election",
  constituency: "",
  island: "",
};

function loadCampaignConfig() {
  try {
    const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      campaignConfig = { ...campaignConfig, ...parsed };
    }
  } catch (_) {}
}

function saveCampaignConfig() {
  try {
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(campaignConfig));
  } catch (_) {}
}

async function syncCampaignConfigFromFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.getFirestoreCampaignConfig) return;
    const remote = await api.getFirestoreCampaignConfig();
    if (remote && typeof remote === "object") {
      if (remote.campaignName != null) campaignConfig.campaignName = String(remote.campaignName);
      if (remote.campaignType != null) campaignConfig.campaignType = String(remote.campaignType);
      if (remote.constituency != null) campaignConfig.constituency = String(remote.constituency);
      if (remote.island != null) campaignConfig.island = String(remote.island);
      saveCampaignConfig();
      applyCampaignToSidebar();
    }
  } catch (_) {}
}

async function syncCampaignConfigToFirestore() {
  try {
    const api = await firebaseInitPromise;
    if (!api.ready || !api.setFirestoreCampaignConfig) return;
    await api.setFirestoreCampaignConfig({
      campaignName: campaignConfig.campaignName,
      campaignType: campaignConfig.campaignType,
      constituency: campaignConfig.constituency,
      island: campaignConfig.island,
    });
  } catch (_) {}
}

function applyCampaignToSidebar() {
  if (sidebarBrandTitle) {
    sidebarBrandTitle.textContent = campaignConfig.campaignName.trim()
      ? campaignConfig.campaignName.trim()
      : "Campaign Console";
  }
  if (sidebarBrandSubtitle) {
    sidebarBrandSubtitle.textContent = campaignConfig.island.trim()
      ? campaignConfig.island.trim()
      : "Republic of Maldives";
  }
}

export function getCampaignConfig() {
  return { ...campaignConfig };
}

export { syncCampaignConfigFromFirestore };

const candidatesTableBody = document.querySelector("#candidatesTable tbody");
const addCandidateButton = document.getElementById("addCandidateButton");
const candidatesPaginationEl = document.getElementById("candidatesPagination");

const votersUploadFileInput = document.getElementById("votersUploadFile");
const importVotersButton = document.getElementById("importVotersButton");
const votersUploadFileNameEl = document.getElementById("votersUploadFileName");
const exportVotersCsvButton = document.getElementById("exportVotersCsvButton");
const syncVotersToFirebaseButton = document.getElementById("syncVotersToFirebaseButton");
const deleteAllVotersButton = document.getElementById("deleteAllVotersButton");

const electionTypes = [
  "Local Council Election",
  "Parliamentary Election",
  "Presidential Election",
];

const positionsByElectionType = {
  "Local Council Election": [
    "Council President",
    "Council Member",
    "WDC President",
    "WDC Member",
  ],
  "Parliamentary Election": ["Parliament Member"],
  "Presidential Election": ["President"],
};

// Dynamic candidates list – initially empty until user adds entries.
let candidates = [];
let candidatesCurrentPage = 1;

function loadCandidatesFromStorage() {
  try {
    const raw = localStorage.getItem(CANDIDATES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) candidates = parsed;
    }
  } catch (_) {}
}

function saveCandidatesToStorage() {
  try {
    localStorage.setItem(CANDIDATES_STORAGE_KEY, JSON.stringify(candidates));
  } catch (_) {}
}

/** Returns up to MAX_CANDIDATES candidates for pledge columns and CSV export. */
export function getCandidates() {
  return candidates.slice(0, MAX_CANDIDATES);
}

let agents = [];
let unsubscribeAgentsFs = null;

function renderCandidatesTable() {
  candidatesTableBody.innerHTML = "";
  const total = candidates.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (candidatesCurrentPage > totalPages) candidatesCurrentPage = totalPages;
  const start = (candidatesCurrentPage - 1) * PAGE_SIZE;
  const pageCandidates = candidates.slice(start, start + PAGE_SIZE);

  pageCandidates.forEach((c) => {
    const tr = document.createElement("tr");
    tr.dataset.candidateId = String(c.id);
    tr.innerHTML = `
      <td>${c.name}</td>
      <td>${c.candidateNumber ?? ""}</td>
      <td>${c.position ?? ""}</td>
      <td>${c.electionType}</td>
      <td>${c.constituency}</td>
      <td style="text-align:right;">
        <button class="ghost-button ghost-button--small" data-edit-candidate="${c.id}">Edit</button>
      </td>
    `;
    candidatesTableBody.appendChild(tr);
  });

  if (candidatesPaginationEl) {
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + PAGE_SIZE, total);
    candidatesPaginationEl.innerHTML = `
      <span class="pagination-bar__summary">Showing ${from}&ndash;${to} of ${total}</span>
      <div class="pagination-bar__nav">
        <button type="button" class="pagination-bar__btn" data-page="prev" ${candidatesCurrentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="pagination-bar__summary">Page ${candidatesCurrentPage} of ${totalPages}</span>
        <button type="button" class="pagination-bar__btn" data-page="next" ${candidatesCurrentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;
    candidatesPaginationEl.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "prev" && candidatesCurrentPage > 1) candidatesCurrentPage--;
        if (btn.dataset.page === "next" && candidatesCurrentPage < totalPages) candidatesCurrentPage++;
        renderCandidatesTable();
      });
    });
  }
}

function loadAgentsFromStorage() {
  try {
    const raw = localStorage.getItem(AGENTS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      agents = parsed;
      // Expose agents globally so modules like zero-day monitor view can show agent phone numbers.
      try {
        window.agentsCached = [...agents];
      } catch (_) {}
      document.dispatchEvent(
        new CustomEvent("agents-updated", {
          detail: { agents: [...agents] },
        })
      );
    }
  } catch (_) {}
}

export function getAgents() {
  return [...agents];
}

function saveAgentsToStorage() {
  try {
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(agents));
    try {
      window.agentsCached = [...agents];
    } catch (_) {}
  } catch (_) {}
}

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getIslandsFromVotersStorage() {
  try {
    const raw = localStorage.getItem("voters-data");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const islands = new Set();
    parsed.forEach((v) => {
      const name = (v.island || "").trim();
      if (name) islands.add(name);
    });
    return Array.from(islands).sort((a, b) => a.localeCompare(b, "en"));
  } catch (_) {
    return [];
  }
}

function renderAgentsTable() {
  const tbody = document.querySelector("#settingsAgentsTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!agents.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="5" class="text-muted" style="text-align: center; padding: 24px;">No agents yet. Add an agent to get started.</td>';
    tbody.appendChild(tr);
    return;
  }

  agents.forEach((a) => {
    const tr = document.createElement("tr");
    const aid = a && a.id != null ? String(a.id) : "";
    tr.dataset.agentId = aid;
    tr.innerHTML = `
      <td>${escapeHtml(a.name || "")}</td>
      <td>${escapeHtml(a.nationalId || "")}</td>
      <td>${escapeHtml(a.phone || "")}</td>
      <td>${escapeHtml(a.island || "")}</td>
      <td style="text-align:right;">
        <button type="button" class="ghost-button ghost-button--small" data-remove-agent="${escapeHtml(aid)}">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-remove-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-remove-agent");
      if (id == null || id === "") return;
      const agent = agents.find((a) => String(a.id) === String(id));
      if (!agent) return;
      (async () => {
        try {
          const api = await firebaseInitPromise;
          if (api.ready && api.deleteAgentFs) {
            await api.deleteAgentFs(String(agent.id));
            agents = agents.filter((a) => String(a.id) !== String(id));
            saveAgentsToStorage();
            renderAgentsTable();
            try {
              window.agentsCached = [...agents];
            } catch (_) {}
            document.dispatchEvent(new CustomEvent("agents-updated", { detail: { agents: [...agents] } }));
          } else {
            agents = agents.filter((a) => String(a.id) !== String(id));
            saveAgentsToStorage();
            renderAgentsTable();
          }
        } catch (_) {}
      })();
    });
  });
}

function openCandidateForm(existing) {
  const isEdit = !!existing;
  const config = getCampaignConfig();
  const defaultConstituency = (config.constituency || "").trim();
  const constituencyValue = existing?.constituency || defaultConstituency;

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label for="candidateName">Candidate name</label>
        <input id="candidateName" type="text" value="${existing?.name || ""}">
      </div>
      <div class="form-group">
        <label for="candidateNumber">Candidate number</label>
        <input id="candidateNumber" type="text" value="${existing?.candidateNumber ?? ""}" placeholder="e.g. 1">
      </div>
      <div class="form-group">
        <label for="candidatePosition">Position</label>
        <select id="candidatePosition"></select>
      </div>
      <div class="form-group">
        <label for="candidateElectionType">Election type</label>
        <select id="candidateElectionType">
          ${electionTypes
            .map(
              (type) => `
            <option value="${type}"${
              (existing?.electionType || config.campaignType) === type ? " selected" : ""
            }>${type}</option>
          `
            )
            .join("")}
        </select>
      </div>
      <div class="form-group">
        <label for="candidateConstituency">Constituency</label>
        <input id="candidateConstituency" type="text" value="${constituencyValue}" readonly placeholder="Set in Settings → Campaign">
      </div>
      <div class="form-group">
        <label for="candidatePhoto">Candidate photo (URL)</label>
        <input id="candidatePhoto" type="text" value="${
          existing?.photoUrl || ""
        }" placeholder="https://example.com/photo.jpg">
      </div>
      <div class="form-group">
        <label for="candidateDescription">Campaign description</label>
        <textarea id="candidateDescription" rows="3">${
          existing?.description || ""
        }</textarea>
      </div>
    </div>
  `;

  const positionSelect = body.querySelector("#candidatePosition");
  const electionTypeSelect = body.querySelector("#candidateElectionType");

  function fillPositionOptions() {
    const electionType = electionTypeSelect.value;
    const positions = positionsByElectionType[electionType] || [];
    const currentValue = positionSelect.value;
    positionSelect.innerHTML = positions
      .map((p) => `<option value="${p}">${p}</option>`)
      .join("");
    const hasCurrent = positions.includes(currentValue);
    positionSelect.value = hasCurrent ? currentValue : (positions[0] || "");
  }

  fillPositionOptions();
  if (existing?.position) {
    const positions = positionsByElectionType[electionTypeSelect.value] || [];
    if (positions.includes(existing.position)) positionSelect.value = existing.position;
  }
  electionTypeSelect.addEventListener("change", fillPositionOptions);

  const footer = document.createElement("div");
  const saveBtn = document.createElement("button");
  saveBtn.className = "primary-button";
  saveBtn.textContent = isEdit ? "Save changes" : "Add candidate";
  footer.appendChild(saveBtn);

  saveBtn.addEventListener("click", () => {
    const name = body.querySelector("#candidateName").value.trim();
    const candidateNumber = body.querySelector("#candidateNumber").value.trim();
    const position = body.querySelector("#candidatePosition").value.trim();
    const electionType = body
      .querySelector("#candidateElectionType")
      .value.trim();
    const constituency = body
      .querySelector("#candidateConstituency")
      .value.trim();

    if (!name || !electionType || !constituency) {
      return;
    }

    const photoUrl = body.querySelector("#candidatePhoto").value.trim();
    const description = body.querySelector("#candidateDescription").value.trim();

    let candidate;
    if (isEdit) {
      existing.name = name;
      existing.candidateNumber = candidateNumber;
      existing.position = position;
      existing.electionType = electionType;
      existing.constituency = constituency;
      existing.photoUrl = photoUrl;
      existing.description = description;
      candidate = { ...existing };
    } else {
      const nextId =
        candidates.reduce((max, c) => Math.max(max, c.id), 0) + 1;
      candidate = {
        id: nextId,
        name,
        candidateNumber,
        position,
        electionType,
        constituency,
        photoUrl,
        description,
      };
      candidates.push(candidate);
    }

    saveCandidatesToStorage();
    renderCandidatesTable();
    document.dispatchEvent(new CustomEvent("candidates-updated"));

    (async () => {
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.setCandidateFs) {
          await api.setCandidateFs(candidate);
          saveCandidatesToStorage();
        }
      } catch (err) {
        console.error("[Settings] Failed to save candidate to Firebase:", err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not save candidate to Firebase",
            meta: err?.message || String(err),
          });
        }
      }
    })();

    closeModal();
  });

  openModal({
    title: isEdit ? "Edit candidate" : "Add candidate",
    body,
    footer,
  });
}

function initSettingsTabs() {
  const tabButtons = document.querySelectorAll("[data-settings-tab]");
  const panels = document.querySelectorAll(".settings-tabs__panel");
  const getPanelId = (tab) => `settings-tab-${tab}`;

  function switchToTab(tabKey) {
    tabButtons.forEach((btn) => {
      const isActive = btn.getAttribute("data-settings-tab") === tabKey;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    panels.forEach((panel) => {
      const isTarget = panel.id === getPanelId(tabKey);
      panel.hidden = !isTarget;
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      switchToTab(btn.getAttribute("data-settings-tab"));
    });
  });

  switchToTab("campaign");
}

function initCampaignTab() {
  loadCampaignConfig();
  applyCampaignToSidebar();
  syncCampaignConfigFromFirestore();

  const nameEl = document.getElementById("settingsCampaignName");
  const typeEl = document.getElementById("settingsCampaignType");
  const constituencyEl = document.getElementById("settingsCampaignConstituency");
  const islandEl = document.getElementById("settingsCampaignIsland");
  const saveBtn = document.getElementById("settingsCampaignSave");

  if (nameEl) nameEl.value = campaignConfig.campaignName;
  if (typeEl) typeEl.value = campaignConfig.campaignType;
  if (constituencyEl) constituencyEl.value = campaignConfig.constituency;
  if (islandEl) islandEl.value = campaignConfig.island;

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      campaignConfig.campaignName = (nameEl?.value ?? "").trim();
      campaignConfig.campaignType = typeEl?.value ?? campaignConfig.campaignType;
      campaignConfig.constituency = (constituencyEl?.value ?? "").trim();
      campaignConfig.island = (islandEl?.value ?? "").trim();
      syncCampaignConfigToFirestore();
      saveCampaignConfig();
      applyCampaignToSidebar();
      document.dispatchEvent(new CustomEvent("campaign-config-changed", { detail: campaignConfig }));
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Campaign settings updated",
          meta: `${campaignConfig.campaignName || "Campaign"} • ${campaignConfig.campaignType}`,
        });
      }
    });
  }

  const clearRemoteBtn = document.getElementById("settingsCampaignClearRemote");
  if (clearRemoteBtn) {
    clearRemoteBtn.addEventListener("click", async () => {
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.deleteFirestoreCampaignConfig) {
          await api.deleteFirestoreCampaignConfig();
          if (window.appNotifications) {
            window.appNotifications.push({ title: "Remote campaign config cleared", meta: "Local settings kept." });
          }
        }
      } catch (_) {}
    });
  }
}

function initAgentsTab() {
  loadAgentsFromStorage();

  const nameEl = document.getElementById("settingsAgentName");
  const nationalIdEl = document.getElementById("settingsAgentNationalId");
  const phoneEl = document.getElementById("settingsAgentPhone");
  const islandSelect = document.getElementById("settingsAgentIsland");
  const addBtn = document.getElementById("settingsAgentAddButton");

  if (islandSelect) {
    const islands = getIslandsFromVotersStorage();
    const current = islandSelect.value;
    islandSelect.innerHTML =
      '<option value="">Select island…</option>' +
      islands
        .map(
          (name) =>
            `<option value="${name}"${
              current === name ? " selected" : ""
            }>${name}</option>`
        )
        .join("");
  }

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const name = (nameEl?.value || "").trim();
      const nationalId = (nationalIdEl?.value || "").trim();
      const phone = (phoneEl?.value || "").trim();
      const island = islandSelect?.value || "";
      if (!name || !nationalId || !phone || !island) {
        return;
      }
      (async () => {
        try {
          const api = await firebaseInitPromise;
          const nextId =
            agents.length && agents.every((a) => a.id != null)
              ? agents.reduce((max, a) => Math.max(max, Number(a.id) || 0), 0) + 1
              : 1;
          const agent = {
            id: String(nextId),
            name,
            nationalId,
            phone,
            island,
          };
          if (api.ready && api.setAgentFs) {
            await api.setAgentFs(agent);
            // Rely on onAgentsSnapshotFs to update agents; do not push locally to avoid duplicates
          } else {
            agents.push(agent);
            saveAgentsToStorage();
            renderAgentsTable();
            try {
              window.agentsCached = [...agents];
            } catch (_) {}
            document.dispatchEvent(
              new CustomEvent("agents-updated", { detail: { agents: [...agents] } })
            );
          }
        } catch (_) {}
      })();
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Agent added",
          meta: `${name} • ${island}`,
        });
      }
      if (nameEl) nameEl.value = "";
      if (nationalIdEl) nationalIdEl.value = "";
      if (phoneEl) phoneEl.value = "";
      if (islandSelect) islandSelect.value = "";
    });
  }

  renderAgentsTable();
}

export function initSettingsModule() {
  initSettingsTabs();
  initCampaignTab();

  // Load candidates from Firebase first (source of truth), fall back to cache on error or when Firebase not ready
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllCandidatesFs) {
        const items = await api.getAllCandidatesFs();
        if (Array.isArray(items)) {
          candidates = items;
          saveCandidatesToStorage();
          renderCandidatesTable();
          return;
        }
      }
      loadCandidatesFromStorage();
      renderCandidatesTable();
    } catch (err) {
      console.error("Candidate load failed:", err);
      loadCandidatesFromStorage();
      renderCandidatesTable();
    }
  })();

  initAgentsTab();

  // Firestore-backed agents: load and subscribe in real time
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllAgentsFs && api.onAgentsSnapshotFs) {
        const initial = await api.getAllAgentsFs();
        if (Array.isArray(initial)) {
          agents = initial;
          saveAgentsToStorage();
          renderAgentsTable();
          try {
            window.agentsCached = [...agents];
          } catch (_) {}
          document.dispatchEvent(
            new CustomEvent("agents-updated", {
              detail: { agents: [...agents] },
            })
          );
        } else {
          loadAgentsFromStorage();
          renderAgentsTable();
        }

        unsubscribeAgentsFs = api.onAgentsSnapshotFs((items) => {
          if (!Array.isArray(items)) return;
          agents = items;
          saveAgentsToStorage();
          renderAgentsTable();
          try {
            window.agentsCached = [...agents];
          } catch (_) {}
          document.dispatchEvent(
            new CustomEvent("agents-updated", {
              detail: { agents: [...agents] },
            })
          );
        });
      } else {
        // Firestore not ready; rely on local cache only
        loadAgentsFromStorage();
        renderAgentsTable();
      }
    } catch (_) {
      loadAgentsFromStorage();
      renderAgentsTable();
    }
  })();

  addCandidateButton.addEventListener("click", () => {
    openCandidateForm(null);
  });

  candidatesTableBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit-candidate]");
    if (!btn) return;
    const id = Number(btn.getAttribute("data-edit-candidate"));
    const existing = candidates.find((c) => c.id === id);
    if (existing) {
      openCandidateForm(existing);
    }
  });

  if (votersUploadFileInput) {
    votersUploadFileInput.addEventListener("change", () => {
      const file = votersUploadFileInput.files?.[0];
      if (votersUploadFileNameEl) {
        votersUploadFileNameEl.textContent = file ? file.name : "";
      }
    });
  }

  /**
   * Parse a single CSV line respecting double-quoted fields (commas inside quotes stay in one column).
   */
  function parseCSVLine(line) {
    const out = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && c === ",") {
        out.push(field.trim());
        field = "";
        continue;
      }
      field += c;
    }
    out.push(field.trim());
    return out;
  }

  function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  importVotersButton.addEventListener("click", () => {
    const file = votersUploadFileInput.files?.[0];
    if (!file) return;

    // Basic safety caps to avoid browser "Out of memory" when importing very large files.
    if (file.size > MAX_VOTERS_FILE_BYTES) {
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "File too large",
          meta: "Voters CSV is larger than 15MB. Please split it into smaller files and try again.",
        });
      } else {
        alert("Voters CSV is too large. Please split it into smaller files (under 15MB) and try again.");
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target?.result || "");
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) return;

      const rawHeader = parseCSVLine(lines[0]);
      const header = rawHeader.map((h) => String(h).trim());

      let dataLines = lines.slice(1);
      if (dataLines.length > MAX_VOTER_ROWS) {
        dataLines = dataLines.slice(0, MAX_VOTER_ROWS);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Voters list truncated",
            meta: `Only the first ${MAX_VOTER_ROWS.toLocaleString("en-MV")} rows were imported to protect browser performance.`,
          });
        }
      }

      const rows = dataLines.map((line) => {
        const cols = parseCSVLine(line);
        const obj = {};
        header.forEach((h, idx) => {
          const key = h || `Column${idx + 1}`;
          obj[key] = cols[idx] != null ? String(cols[idx]).trim() : "";
        });
        return obj;
      });

      importVotersFromTemplateRows(rows);
      if (votersUploadFileNameEl) votersUploadFileNameEl.textContent = "";
      votersUploadFileInput.value = "";
    };
    reader.readAsText(file);
  });

  if (exportVotersCsvButton) {
    exportVotersCsvButton.addEventListener("click", async () => {
      try {
        // Prefer live voters from Firebase so we capture latest updates (votedAt, pledge, notes, etc.)
        let voters = [];
        try {
          const api = await firebaseInitPromise;
          if (api.ready && api.getAllVotersFs) {
            voters = await api.getAllVotersFs();
          }
        } catch (_) {}
        if (!Array.isArray(voters) || voters.length === 0) {
          // Fallback to local cache if Firebase is not ready.
          try {
            const raw = localStorage.getItem("voters-data");
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) voters = parsed;
            }
          } catch (_) {}
        }
        if (!Array.isArray(voters) || voters.length === 0) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "No voters to export",
              meta: "There are no voters in this campaign to download.",
            });
          }
          return;
        }

        const headers = [
          "Sequence",
          "Ballot Box",
          "ID Number",
          "Name",
          "Permanent Address",
          "Date of Birth",
          "Age",
          "Pledge",
          "Gender",
          "Island",
          "Current Location",
          "Phone",
          "Notes",
          "Support status",
          "Met?",
          "Persuadable?",
          "Date pledged",
          "Voted at",
        ];
        const lines = [headers.map(csvEscape).join(",")];
        voters.forEach((v) => {
          const row = [
            v.sequence ?? "",
            v.ballotBox || "",
            v.nationalId || "",
            v.fullName || v.name || "",
            v.permanentAddress || "",
            v.dateOfBirth || "",
            v.age ?? "",
            v.pledgeStatus || "",
            v.gender || "",
            v.island || "",
            v.currentLocation || "",
            v.phone || "",
            v.notes || v.callComments || "",
            v.supportStatus || "",
            v.metStatus || "",
            v.persuadable || "",
            v.pledgedAt || "",
            v.votedAt || "",
          ];
          lines.push(row.map(csvEscape).join(","));
        });
        const csv = lines.join("\r\n");
        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `voters-export-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Voters exported",
            meta: `${voters.length.toLocaleString("en-MV")} voters as CSV`,
          });
        }
      } catch (err) {
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Could not export voters",
            meta: err?.message || String(err),
          });
        }
      }
    });
  }

  if (syncVotersToFirebaseButton) {
    syncVotersToFirebaseButton.addEventListener("click", async () => {
      try {
        const raw = localStorage.getItem("voters-data");
        if (!raw) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "No local voters to sync",
              meta: "There are no voters stored in this browser.",
            });
          }
          return;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.length) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "No local voters to sync",
              meta: "There are no voters stored in this browser.",
            });
          }
          return;
        }
        const api = await firebaseInitPromise;
        if (!api.ready || !api.setVoterFs) {
          if (window.appNotifications) {
            window.appNotifications.push({
              title: "Sync unavailable",
              meta: "Firebase is not ready. Check your network or configuration.",
            });
          }
          return;
        }
        const voters = parsed;
        const limited = voters.slice(0, 2000); // safety cap
        await Promise.all(
          limited.map((v) => {
            if (!v || !v.id) return Promise.resolve();
            return api.setVoterFs(v);
          })
        );
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Voters synced to Firebase",
            meta: `${limited.length.toLocaleString("en-MV")} local voters pushed to Firestore.`,
          });
        }
      } catch (err) {
        console.error("[Settings] Failed to sync local voters to Firebase", err);
        if (window.appNotifications) {
          window.appNotifications.push({
            title: "Sync failed",
            meta: "Check the console for details.",
          });
        }
      }
    });
  }

  if (deleteAllVotersButton) {
    deleteAllVotersButton.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Delete all voters",
        message:
          "Delete all voters in this campaign? This will remove the voters list from this browser and from Firebase (if connected). This cannot be undone.",
        confirmText: "Delete all",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;

      // Clear local cache first.
      try {
        localStorage.removeItem("voters-data");
      } catch (_) {}

      // Best-effort Firestore delete of all voters.
      try {
        const api = await firebaseInitPromise;
        if (api.ready && api.getAllVotersFs && api.deleteVoterFs) {
          const existing = await api.getAllVotersFs();
          if (Array.isArray(existing) && existing.length) {
            const limited = existing.slice(0, 20000);
            await Promise.all(
              limited.map((v) => api.deleteVoterFs(v.id))
            );
          }
        }
      } catch (_) {}

      // Let modules refresh themselves.
      document.dispatchEvent(new CustomEvent("voters-updated"));
      if (window.appNotifications) {
        window.appNotifications.push({
          title: "Voters list deleted",
          meta: "All voters for this campaign have been removed.",
        });
      }
    });
  }
  // Firestore-backed candidates: load and subscribe in real time
  (async () => {
    try {
      const api = await firebaseInitPromise;
      if (api.ready && api.getAllCandidatesFs && api.onCandidatesSnapshotFs) {
        const initial = await api.getAllCandidatesFs();
        if (Array.isArray(initial)) {
          candidates = initial;
          saveCandidatesToStorage();
          renderCandidatesTable();
          document.dispatchEvent(
            new CustomEvent("candidates-updated", {
              detail: { candidates: [...candidates] },
            })
          );
        } else {
          loadCandidatesFromStorage();
          renderCandidatesTable();
        }

        api.onCandidatesSnapshotFs((items) => {
          if (!Array.isArray(items)) return;
          candidates = items;
          saveCandidatesToStorage();
          renderCandidatesTable();
          document.dispatchEvent(
            new CustomEvent("candidates-updated", {
              detail: { candidates: [...candidates] },
            })
          );
        });
      } else {
        loadCandidatesFromStorage();
        renderCandidatesTable();
      }
    } catch (err) {
      console.error("[Settings] Failed to load candidates from Firebase:", err);
      loadCandidatesFromStorage();
      renderCandidatesTable();
    }
  })();
}


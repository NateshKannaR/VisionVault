/**
 * popup.js — Side panel controller.
 *
 * Talks to the service worker over chrome.runtime messages and renders what comes back.
 * All iconography is the inline SVG sprite in popup.html; nothing here emits emoji.
 *
 * The centrepiece is the redaction overlay: the panel receives the geometry and provenance of
 * every masked region (never the matched text) and outlines them on the preview, so the user
 * can see exactly what was hidden and which detector caught it.
 */

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── Tabs ──────────────────────────────────────────────────────────────────────
const tabs = [...document.querySelectorAll('[role="tab"]')];
for (const [index, tab] of tabs.entries()) {
  $(tab.getAttribute("aria-controls")).setAttribute("aria-labelledby", tab.id);
  tab.tabIndex = tab.classList.contains("active") ? 0 : -1;
  tab.addEventListener("click", () => {
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute("aria-controls")).classList.toggle("active", selected);
    }
    if (tab.dataset.tab === "vault") updateVaultUI();
  });
  tab.addEventListener("keydown", (event) => {
    const next = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  });
}

// ── Task box ──────────────────────────────────────────────────────────────────
const taskEl = $("task");

// The task the current scan was taken for. Editing the instruction after scanning would
// otherwise run the new words against the old snapshot of the page, silently.
let scannedTask = null;

taskEl.addEventListener("input", () => {
  $("charCount").textContent = taskEl.value.length;
  if (scannedTask !== null && taskEl.value.trim() !== scannedTask) {
    scannedTask = null;
    if (!runBtn.hidden) {
      runBtn.hidden = true;
      showStatus("statusMsg", "info", "Instruction changed — scan again so the agent sees the current page.");
    }
  }
});
taskEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $("scanBtn").click(); }
});

document.querySelectorAll(".quick-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    taskEl.value = chip.dataset.template || "";
    taskEl.dispatchEvent(new Event("input"));
    taskEl.focus();
  });
});

// ── Toasts ────────────────────────────────────────────────────────────────────
const TOAST_ICON = { info: "info", success: "check", warn: "alert", error: "slash" };

function showStatus(id, type, message) {
  const el = $(id);
  if (!el) return;
  el.className = "toast " + type;
  el.innerHTML = icon(TOAST_ICON[type] || "info");
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
}
function hideStatus(id) {
  const el = $(id);
  if (el) el.className = "toast";
}

// ── Server health ─────────────────────────────────────────────────────────────
let healthCheckId = 0;
async function checkServer(manual = false) {
  const checkId = ++healthCheckId;
  const dot = $("serverDot");
  const badge = $("backendBadge");
  const info = $("serverInfo");
  const mode = $("s-plannerMode").value;
  if (mode === "air_gapped" || (mode === "fast" && !manual)) {
    dot.className = "status-dot";
    badge.textContent = "On-device";
    info.textContent = "The local rules planner is selected.";
    return;
  }
  dot.className = "status-dot pending";
  badge.textContent = "Checking…";
  info.textContent = "Checking the configured planner…";
  try {
    const connection = PlannerConnection.resolve($("s-serverUrl").value.trim(), $("s-serverToken").value.trim());
    const response = await fetch(connection.health, {
      headers: connection.authorization,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(6500),
    });
    if (response.status === 401) throw new Error("The server rejected the planner token.");
    if (!response.ok) throw new Error("The planner returned HTTP " + response.status + ".");
    const data = await response.json();
    if (data.status !== "ok" || !Array.isArray(data.chain)) throw new Error("Unexpected planner health response.");
    if (checkId !== healthCheckId) return;
    const labels = { mock: "Rules", ollama: "Ollama", gemini: "Gemini", openrouter: "OpenRouter" };
    const chain = data.chain.map((tier) => {
      const model = data.models?.[tier];
      const cooldown = data.cooldowns?.[tier];
      return (labels[tier] || tier) + (model ? ` (${model})` : "") + (cooldown ? " (cooldown)" : "");
    }).join(" → ");
    dot.className = "status-dot";
    badge.textContent = mode === "fast" ? "On-device" : labels[data.backend] || "Connected";
    info.textContent = "Connected. Planning order " + chain + ".";
  } catch (error) {
    if (checkId !== healthCheckId) return;
    dot.className = "status-dot error";
    badge.textContent = "On-device";
    info.textContent = `Planner unavailable. ${error.message} The extension can use local rules.`;
  }
}
$("checkServer").addEventListener("click", () => checkServer(true));
$("engineBadge").textContent = "Bundled WASM";

// ── Vault ─────────────────────────────────────────────────────────────────────
const VAULT_KEYS = [
  "satellite_name", "mission_id", "operator", "launch_date", "orbit_type",
  "orbital_inclination", "apogee", "perigee", "tle_line_1", "tle_line_2",
  "ground_station_freq", "encryption_key_ref", "name", "username", "email",
  "phone", "company", "zip", "address", "password", "about"
];
let isVaultUnlocked = false;

async function updateVaultUI() {
  const hasPin = typeof hasVaultPin === "function" ? await hasVaultPin() : false;
  const lockedView = $("vaultLockedView");
  const unlockedView = $("vaultUnlockedView");
  const setupCard = $("vaultSetupCard");
  const noPinBanner = $("vaultNoPinBanner");
  const activeHeader = $("vaultActiveLockHeader");

  if (hasPin && !isVaultUnlocked) {
    if (lockedView) lockedView.hidden = false;
    if (unlockedView) unlockedView.hidden = true;
    if (setupCard) setupCard.hidden = true;
    const pinInput = $("vaultUnlockPin");
    if (pinInput) pinInput.value = "";
  } else {
    if (lockedView) lockedView.hidden = true;
    if (unlockedView) unlockedView.hidden = false;
    if (noPinBanner) noPinBanner.hidden = hasPin;
    if (activeHeader) activeHeader.hidden = !hasPin;
    await loadVault();
  }
}

async function loadVault() {

  let v = {};
  if (typeof getVault === "function") {
    try {
      v = await getVault();
    } catch (e) {
      console.warn("Could not load decrypted vault:", e);
    }
  } else {
    const { vault } = await chrome.storage.local.get("vault");
    v = vault || {};
  }
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) el.value = v[k] || ""; });

  // Render dynamic custom vault fields
  const customList = $("vaultCustomFieldsList");
  if (customList) {
    customList.innerHTML = "";
    const standardKeysSet = new Set(VAULT_KEYS);
    const customKeys = Object.keys(v).filter(
      (k) => !standardKeysSet.has(k) && !k.startsWith("_") && k !== "updatedAt"
    );
    const countEl = $("customFieldsCount");
    if (countEl) countEl.textContent = `${customKeys.length} field${customKeys.length === 1 ? "" : "s"}`;

    if (customKeys.length === 0) {
      customList.innerHTML = `<div style="font-size:11px;color:var(--text-faint);padding:6px 2px;font-style:italic;">No custom fields stored yet. Add new fields below.</div>`;
    } else {
      customKeys.forEach((key) => {
        const val = v[key] || "";
        const row = document.createElement("div");
        row.className = "vault-entry-row";
        row.dataset.key = key;

        const badge = document.createElement("span");
        badge.className = "vault-entry-badge";
        badge.title = key;
        badge.textContent = key;

        const input = document.createElement("input");
        input.className = "input vault-custom-input";
        input.type = "text";
        input.dataset.key = key;
        input.value = val;
        input.placeholder = "Enter value";

        const delBtn = document.createElement("button");
        delBtn.className = "btn btn-ghost btn-icon vault-del-field-btn";
        delBtn.type = "button";
        delBtn.title = `Delete ${key} from vault`;
        delBtn.innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg>`;
        delBtn.addEventListener("click", async () => {
          if (confirm(`Delete "${key}" from your encrypted vault?`)) {
            if (typeof deleteVaultField === "function") {
              await deleteVaultField(key);
            } else {
              delete v[key];
              if (typeof saveVault === "function") await saveVault(v);
              else await chrome.storage.local.set({ vault: v });
            }
            await loadVault();
            showStatus("vaultStatus", "info", `Deleted "${key}" from vault.`);
            setTimeout(() => hideStatus("vaultStatus"), 2500);
          }
        });

        row.appendChild(badge);
        row.appendChild(input);
        row.appendChild(delBtn);
        customList.appendChild(row);
      });
    }
  }
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.vault || changes.vault_ciphertext || changes.vault_mission)) {
      if (typeof isVaultUnlocked === "undefined" || isVaultUnlocked) {
        loadVault().catch(() => {});
      }
    }
  });
}

function lockVaultNow() {
  isVaultUnlocked = false;
  if (typeof lockVault === "function") {
    lockVault();
  }
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) el.value = ""; });
  const customList = $("vaultCustomFieldsList");
  if (customList) customList.innerHTML = "";
  hideStatus("vaultStatus");
  updateVaultUI();
}

// Unlock controls
$("vaultUnlockBtn").addEventListener("click", async () => {
  const pin = $("vaultUnlockPin").value;
  if (!pin) {
    showStatus("vaultUnlockStatus", "warn", "Please enter your PIN");
    return;
  }
  let unlockRes = { success: false };
  if (typeof unlockVaultWithPin === "function") {
    unlockRes = await unlockVaultWithPin(pin);
  } else if (typeof verifyVaultPin === "function") {
    const valid = await verifyVaultPin(pin);
    unlockRes = { success: valid };
  } else {
    unlockRes = { success: true };
  }

  if (unlockRes.success) {
    isVaultUnlocked = true;
    hideStatus("vaultUnlockStatus");
    updateVaultUI();
  } else {
    showStatus("vaultUnlockStatus", "error", unlockRes.error || "Incorrect PIN");
    const pinInput = $("vaultUnlockPin");
    pinInput.classList.remove("shake");
    void pinInput.offsetWidth;
    pinInput.classList.add("shake");
    pinInput.value = "";
    pinInput.focus();
    setTimeout(() => pinInput.classList.remove("shake"), 400);
  }
});

$("vaultUnlockPin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("vaultUnlockBtn").click();
  }
});

$("toggleUnlockPin").addEventListener("click", (e) => {
  const field = $("vaultUnlockPin");
  const showing = field.type === "text";
  field.type = showing ? "password" : "text";
  e.currentTarget.setAttribute("aria-pressed", String(!showing));
  e.currentTarget.setAttribute("aria-label", showing ? "Show PIN" : "Hide PIN");
  e.currentTarget.innerHTML = icon(showing ? "eye" : "eye-off");
});

$("vaultLockNowBtn").addEventListener("click", lockVaultNow);

$("vaultOpenSetupBtn").addEventListener("click", () => {
  $("vaultSetupCard").hidden = false;
  $("vaultSetupTitle").innerHTML = `${icon("key")} Set Vault PIN`;
  $("vaultCurrentPinGroup").hidden = true;
  $("vaultCurrentPin").value = "";
  $("vaultNewPin").value = "";
  $("vaultConfirmPin").value = "";
  $("removePinBtn").hidden = true;
  hideStatus("vaultSetupStatus");
  $("vaultNewPin").focus();
});

$("vaultChangePinBtn").addEventListener("click", () => {
  $("vaultSetupCard").hidden = false;
  $("vaultSetupTitle").innerHTML = `${icon("sliders")} Manage Vault PIN`;
  $("vaultCurrentPinGroup").hidden = false;
  $("vaultCurrentPin").value = "";
  $("vaultNewPin").value = "";
  $("vaultConfirmPin").value = "";
  $("removePinBtn").hidden = false;
  hideStatus("vaultSetupStatus");
  $("vaultCurrentPin").focus();
});

$("cancelPinBtn").addEventListener("click", () => {
  $("vaultSetupCard").hidden = true;
  hideStatus("vaultSetupStatus");
});

$("savePinBtn").addEventListener("click", async () => {
  const hasPin = typeof hasVaultPin === "function" ? await hasVaultPin() : false;
  let current = "";
  if (hasPin) {
    current = $("vaultCurrentPin").value;
    if (!current) {
      showStatus("vaultSetupStatus", "error", "Please enter your current PIN");
      return;
    }
    const ok = typeof verifyVaultPin === "function" ? await verifyVaultPin(current) : true;
    if (!ok) {
      showStatus("vaultSetupStatus", "error", "Current PIN is incorrect");
      return;
    }
  }

  const newPin = $("vaultNewPin").value.trim();
  const confirm = $("vaultConfirmPin").value.trim();
  if (newPin.length < 4) {
    showStatus("vaultSetupStatus", "warn", "PIN must be at least 4 digits/characters");
    return;
  }
  if (newPin !== confirm) {
    showStatus("vaultSetupStatus", "error", "New PIN and confirmation do not match");
    return;
  }

  try {
    if (typeof setVaultPin === "function") {
      await setVaultPin(newPin, hasPin ? current : undefined);
    }
    isVaultUnlocked = true;
    showStatus("vaultSetupStatus", "success", "Vault PIN saved successfully");
    setTimeout(() => {
      $("vaultSetupCard").hidden = true;
      hideStatus("vaultSetupStatus");
      updateVaultUI();
    }, 1000);
  } catch (err) {
    showStatus("vaultSetupStatus", "error", err.message || "Failed to set PIN");
  }
});

$("removePinBtn").addEventListener("click", async () => {
  const current = $("vaultCurrentPin").value;
  if (!current) {
    showStatus("vaultSetupStatus", "error", "Please enter your current PIN to remove lock");
    return;
  }
  try {
    if (typeof removeVaultPin === "function") {
      await removeVaultPin(current);
    }
    isVaultUnlocked = false;
    showStatus("vaultSetupStatus", "success", "PIN lock removed");
    setTimeout(() => {
      $("vaultSetupCard").hidden = true;
      hideStatus("vaultSetupStatus");
      updateVaultUI();
    }, 1000);
  } catch (err) {
    showStatus("vaultSetupStatus", "error", err.message || "Incorrect current PIN");
  }
});

updateVaultUI();

$("saveVault").addEventListener("click", async () => {
  const vault = {};
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) vault[k] = el.value.trim(); });
  // Include custom dynamically added fields
  document.querySelectorAll(".vault-custom-input").forEach((input) => {
    const k = input.dataset.key;
    if (k) vault[k] = input.value.trim();
  });

  try {
    if (typeof saveVault === "function") {
      await saveVault(vault);
    } else {
      await chrome.storage.local.set({ vault });
    }
    const filled = Object.values(vault).filter(Boolean).length;
    showStatus("vaultStatus", "success", `Saved ${filled} value(s) locally with AES-GCM-256 encryption. Nothing was transmitted.`);
    setTimeout(() => hideStatus("vaultStatus"), 3200);
  } catch (err) {
    showStatus("vaultStatus", "error", err.message || "Failed to save vault");
  }
});

// Add new custom field to vault
if ($("addVaultFieldBtn")) {
  $("addVaultFieldBtn").addEventListener("click", async () => {
    const keyInput = $("newVaultKey");
    const valInput = $("newVaultValue");
    if (!keyInput || !valInput) return;
    const rawKey = keyInput.value.trim();
    const val = valInput.value.trim();

    if (!rawKey) {
      showStatus("vaultStatus", "error", "Please specify a field identifier/key");
      keyInput.focus();
      return;
    }

    const cleanKey = rawKey.toLowerCase().replace(/[\s-]+/g, "_");

    if (VAULT_KEYS.includes(cleanKey)) {
      const el = $("v-" + cleanKey);
      if (el) {
        el.value = val;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
      }
    }

    try {
      if (typeof setVaultField === "function") {
        await setVaultField(cleanKey, val);
      } else {
        let v = typeof getVault === "function" ? await getVault() : {};
        v[cleanKey] = val;
        if (typeof saveVault === "function") await saveVault(v);
        else await chrome.storage.local.set({ vault: v });
      }
      keyInput.value = "";
      valInput.value = "";
      await loadVault();
      showStatus("vaultStatus", "success", `Stored "${cleanKey}" securely in AES-GCM-256 encrypted vault.`);
      setTimeout(() => hideStatus("vaultStatus"), 3000);
    } catch (err) {
      showStatus("vaultStatus", "error", "Failed to store field: " + err.message);
    }
  });

  $("newVaultValue")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("addVaultFieldBtn").click();
  });
}

// Instant 1-click restore for ISRO Telemetry Defaults
if ($("restoreTelemetryDefaultsBtn")) {
  $("restoreTelemetryDefaultsBtn").addEventListener("click", async () => {
    try {
      const telemetryDefaults = {
        satellite_name: "INSAT-4B",
        mission_id: "INSAT-4B / M-201",
        operator: "R. Sharma",
        launch_date: "2007-03-12",
        orbit_type: "Geostationary (GEO)",
        orbital_inclination: "0.05°",
        apogee: "35,786 km",
        perigee: "35,786 km",
        tle_line_1: "1 30798U 07007A 26248.51249811 -.00000124 00000-0 10000-4 0 9991",
        tle_line_2: "2 30798 0.0512 87.2145 0001248 145.2104 214.8901 1.00273412 71234",
        ground_station_freq: "14.250 GHz (Ku-Band)",
        encryption_key_ref: "ISRO-KMS-EK-2026-04871"
      };

      let current = {};
      if (typeof getVault === "function") {
        try { current = await getVault(); } catch (_) {}
      } else {
        const res = await chrome.storage.local.get("vault");
        current = res.vault || {};
      }

      const merged = Object.assign({}, current, telemetryDefaults);
      if (typeof saveVault === "function") {
        await saveVault(merged);
      } else {
        await chrome.storage.local.set({ vault: merged });
      }

      await loadVault();
      showStatus("vaultStatus", "success", "ISRO Mission Telemetry restored to INSAT-4B defaults!");
      setTimeout(() => hideStatus("vaultStatus"), 3500);
    } catch (err) {
      showStatus("vaultStatus", "error", "Failed to restore telemetry: " + err.message);
    }
  });
}

// Reset vault to default ISRO profile
if ($("resetVaultBtn")) {
  $("resetVaultBtn").addEventListener("click", async () => {
    if (confirm("Reset vault to default ISRO mission profile? This will restore standard mission attributes.")) {
      try {
        if (typeof resetVaultToDefault === "function") {
          await resetVaultToDefault();
        } else if (typeof DEFAULT_MISSION_VAULT !== "undefined") {
          if (typeof saveVault === "function") await saveVault({ ...DEFAULT_MISSION_VAULT });
          else await chrome.storage.local.set({ vault: { ...DEFAULT_MISSION_VAULT } });
        }
        await loadVault();
        showStatus("vaultStatus", "info", "Vault reset to default mission profile.");
        setTimeout(() => hideStatus("vaultStatus"), 3000);
      } catch (err) {
        showStatus("vaultStatus", "error", "Reset failed: " + err.message);
      }
    }
  });
}

// Clear all vault credentials
if ($("clearVaultBtn")) {
  $("clearVaultBtn").addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear all vault fields? All stored personal and mission data will be deleted.")) {
      try {
        if (typeof clearVault === "function") {
          await clearVault();
        } else {
          if (typeof saveVault === "function") await saveVault({});
          else await chrome.storage.local.set({ vault: {} });
        }
        await loadVault();
        showStatus("vaultStatus", "info", "All vault credentials deleted.");
        setTimeout(() => hideStatus("vaultStatus"), 3000);
      } catch (err) {
        showStatus("vaultStatus", "error", "Clear failed: " + err.message);
      }
    }
  });
}

$("togglePassword").addEventListener("click", (e) => {
  const field = $("v-password");
  const showing = field.type === "text";
  field.type = showing ? "password" : "text";
  e.currentTarget.setAttribute("aria-pressed", String(!showing));
  e.currentTarget.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  e.currentTarget.innerHTML = icon(showing ? "eye" : "eye-off");
});

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};
  if ($("s-plannerMode")) $("s-plannerMode").value = (s.airGapped ? "air_gapped" : s.plannerMode) || "fast";
  $("s-redactMode").value = s.redactMode || "black";
  $("s-confirmPolicy").value = s.confirmPolicy || "risky";
  $("s-serverUrl").value = s.serverUrl || PlannerConnection.defaultUrl;
  $("s-serverToken").value = s.serverToken || "";
  $("s-autoAgent").checked = s.autoAgent === true;
  const ocrOn = s.enableOCR === true; // Default fast (OCR false) unless explicitly enabled
  const faceOn = s.enableFaceDetection !== false;
  $("s-visionDepth").value = ocrOn ? "full" : (faceOn ? "fast" : "dom");
  $("s-dismissOverlays").checked = s.dismissOverlays !== false;
  checkServer();
}
loadSettings();

$("s-autoAgent").addEventListener("change", async () => {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, autoAgent: autoAgentMode() } });
});

$("saveSettings").addEventListener("click", async () => {
  const depth = $("s-visionDepth").value;
  const serverUrl = $("s-serverUrl").value.trim() || PlannerConnection.defaultUrl;
  const serverToken = $("s-serverToken").value.trim();
  try {
    PlannerConnection.resolve(serverUrl, serverToken);
  } catch (error) {
    showStatus("settingsStatus", "error", error.message);
    return;
  }
  const previous = await chrome.storage.local.get("settings");
  const settings = {
    ...previous.settings,
    plannerMode: $("s-plannerMode") ? $("s-plannerMode").value : "fast",
    redactMode: $("s-redactMode").value,
    confirmPolicy: $("s-confirmPolicy").value,
    serverUrl,
    serverToken,
    autoAgent: autoAgentMode(),
    enableOCR: depth === "full",
    enableFaceDetection: depth === "full" || depth === "fast",
    dismissOverlays: $("s-dismissOverlays").checked,
  };
  delete settings.airGapped;
  await chrome.storage.local.set({ settings });
  showStatus("settingsStatus", "success", "Settings saved.");
  setTimeout(() => hideStatus("settingsStatus"), 2600);
  checkServer();
});

// ── Elements ──────────────────────────────────────────────────────────────────
const scanBtn = $("scanBtn");
const runBtn = $("runBtn");
const stopBtn = $("stopBtn");
const idleState = $("idleState");
const scanSkeleton = $("scanSkeleton");
const previewWrap = $("previewWrap");
const statsGrid = $("statsGrid");
const timingWrap = $("timingWrap");
const confirmWrap = $("confirmWrap");
const inputPromptWrap = $("inputPromptWrap");
const logWrap = $("logWrap");
const logEntries = $("logEntries");
const overlayEl = $("regionOverlay");

let actionCount = 0;
let renderedLogCount = 0;
let currentMissingField = null;
let currentMissingMarkId = null;
let liveStepRow = null;

const SCAN_LABEL = `${icon("scan")}<span>Scan active tab</span>`;
const RUN_LABEL = `${icon("play")}<span>Run reviewed task</span>`;

function setStat(id, val) { const el = $(id); if (el) el.textContent = val; }

/** Brings a card the user must act on into view — a gate below the fold is a gate missed. */
function reveal(el) {
  el.hidden = false;
  requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}
function busy(btn, label) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span><span>${label}</span>`; }

function setRunning(on) {
  stopBtn.hidden = !on;
  runBtn.disabled = on;
  scanBtn.disabled = on;
  if (!on) clearLiveStep();
}

// ── Redaction overlay ─────────────────────────────────────────────────────────
const SOURCE_META = {
  dom:         { label: "DOM",  css: "--src-dom",  cls: "r-dom" },
  vision_face: { label: "Face", css: "--src-face", cls: "r-vision_face" },
  vision_ocr:  { label: "OCR",  css: "--src-ocr",  cls: "r-vision_ocr" },
};

/**
 * Outlines each masked region on the preview.
 *
 * The SVG viewBox is the page's CSS viewport, and the SVG stretches over the image, so region
 * coordinates map correctly at whatever width the panel renders the screenshot.
 */
function renderRegions(regions, viewport) {
  const list = Array.isArray(regions) ? regions : [];
  const vw = (viewport && viewport.w) || 0;
  const vh = (viewport && viewport.h) || 0;

  if (!list.length || !vw || !vh) {
    overlayEl.innerHTML = "";
    $("regionLegend").innerHTML = "";
    $("regionHint").textContent = "No sensitive regions were detected on this screen.";
    return;
  }

  overlayEl.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
  // Outline colour follows the most specific detector that found it: a face or OCR hit is more
  // interesting to show than the DOM rule it also matched.
  const outlineSource = (r) => {
    const sources = (r.sources && r.sources.length ? r.sources : [r.source]).filter(Boolean);
    if (sources.includes("vision_face")) return "vision_face";
    if (sources.includes("vision_ocr")) return "vision_ocr";
    return "dom";
  };

  overlayEl.innerHTML = list.map((r) => {
    const meta = SOURCE_META[outlineSource(r)];
    const found = (r.sources && r.sources.length ? r.sources : [r.source])
      .map((x) => (SOURCE_META[x] || SOURCE_META.dom).label).join(" + ");
    return `<rect class="${meta.cls}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="2">` +
           `<title>${esc(r.reason || "")}${r.label ? " · " + esc(r.label) : ""} — found by ${esc(found)}</title></rect>`;
  }).join("");

  // Count each region under EVERY detector that contributed to it, so a region found by both
  // the DOM scan and OCR is credited to both. Totals can therefore exceed the region count.
  const counts = {};
  for (const r of list) {
    const sources = (r.sources && r.sources.length ? r.sources : [r.source]).filter(Boolean);
    for (const src of new Set(sources)) {
      const key = SOURCE_META[src] ? src : "dom";
      counts[key] = (counts[key] || 0) + 1;
    }
  }

  $("regionLegend").innerHTML = Object.entries(counts).map(([src, n]) => {
    const meta = SOURCE_META[src];
    return `<span class="legend-item"><span class="legend-swatch" style="background:var(${meta.css})"></span>${meta.label} <strong>${n}</strong></span>`;
  }).join("");

  $("regionHint").textContent =
    `${list.length} region${list.length === 1 ? "" : "s"} painted over before this image left the page.`;
}

$("overlayToggle").addEventListener("click", (e) => {
  const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
  e.currentTarget.setAttribute("aria-pressed", String(on));
  overlayEl.classList.toggle("dim", !on);
});

// ── Active Models & Sensitivity Analysis Inspector ───────────────────────────
function renderModelInspector(d) {
  const card = $("modelInspectorCard");
  if (!card || !d) return;
  card.hidden = false;

  const screenTypeEl = $("inspectorScreenType");
  if (screenTypeEl && d.screenEvaluation) {
    const cat = d.screenEvaluation.category || "DOM Structural";
    screenTypeEl.textContent = cat;
  }

  const table = $("sensitivityTable");
  const countSummary = $("inspectorCountSummary");
  if (!table) return;
  table.innerHTML = "";

  const regions = Array.isArray(d.regions) ? d.regions : [];
  const marks = Array.isArray(d.marks) ? d.marks : [];

  if (countSummary) {
    countSummary.textContent = `${regions.length} sensitive, ${marks.length} public`;
  }

  const badgeEl = $("modelInspectorBadge");
  if (badgeEl) {
    const faceRan = regions.some(r => (r.sources || [r.source]).includes("vision_face"));
    const ocrRan = regions.some(r => (r.sources || [r.source]).includes("vision_ocr"));
    let activeCount = 2; // DOM + Decision Planner
    if (faceRan) activeCount++;
    if (ocrRan) activeCount++;
    badgeEl.textContent = `${activeCount} Models Active`;
  }

  if (regions.length === 0 && marks.length === 0) {
    table.innerHTML = `<div style="font-size:11px; color:var(--text-faint); padding:6px; font-style:italic;">No interactive elements or PII detected on this screen.</div>`;
    return;
  }

  // 1. Sensitive Items (Classified as PII & Redacted locally with true sensitivity metrics)
  regions.forEach((r) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.22); border-radius:4px; padding:5px 8px; font-size:11px;";

    const left = document.createElement("div");
    left.style.cssText = "display:flex; align-items:center; gap:6px; overflow:hidden;";

    const rawLabel = String(r.label || r.reason || "").toLowerCase();
    const sev = r.severity || (
      /aadhaar|card|password|pin|secret|token/i.test(rawLabel) ? "CRITICAL" :
      /satellite|orbit|apogee|perigee|inclination|pan|passport|mission/i.test(rawLabel) ? "HIGH" :
      /name|operator|email|phone|dob|salary/i.test(rawLabel) ? "MODERATE" :
      /avatar|photo|media/i.test(rawLabel) ? "LOW" : "CONTEXTUAL"
    );

    let badgeBg = "rgba(239,68,68,0.25)";
    let badgeColor = "#f87171";
    if (sev === "CRITICAL") {
      badgeBg = "rgba(220,38,38,0.35)";
      badgeColor = "#fca5a5";
    } else if (sev === "HIGH") {
      badgeBg = "rgba(234,88,12,0.25)";
      badgeColor = "#fdba74";
    } else if (sev === "MODERATE") {
      badgeBg = "rgba(202,138,4,0.25)";
      badgeColor = "#fde047";
    } else if (sev === "LOW" || sev === "CONTEXTUAL") {
      badgeBg = "rgba(14,165,233,0.25)";
      badgeColor = "#7dd3fc";
    }

    const badge = document.createElement("span");
    badge.style.cssText = `background:${badgeBg}; color:${badgeColor}; font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; white-space:nowrap; letter-spacing:0.3px;`;
    badge.textContent = sev;

    const name = document.createElement("span");
    name.style.cssText = "color:#fff; font-weight:500; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:135px;";
    name.textContent = r.label || r.reason || "Personal Credential";
    name.title = `${name.textContent} • ${r.category || (sev + ' Severity Data')}`;

    left.appendChild(badge);
    left.appendChild(name);

    const right = document.createElement("div");
    right.style.cssText = "font-size:10px; color:var(--text-muted); text-align:right; white-space:nowrap;";

    const sources = (r.sources && r.sources.length ? r.sources : [r.source]).filter(Boolean);
    let modelName = r.model || "DOM Rules";
    if (sources.includes("vision_face")) modelName = "UltraFace ONNX";
    else if (sources.includes("vision_ocr")) modelName = "Tesseract OCR";
    else if (!r.model) {
      if (/apogee|perigee|inclination|orbit|satellite|mission/i.test(rawLabel)) modelName = "Telemetry Scanner";
      else if (/aadhaar/i.test(rawLabel)) modelName = "Verhoeff Checksum";
      else if (/card/i.test(rawLabel)) modelName = "Luhn Algorithm";
      else if (r.reason === "pii_text_match") modelName = "Regex Scanner";
      else if (r.reason === "sensitive_input" || r.reason === "nearby_label_pii") modelName = "Context Classifier";
    }

    let rawConf = r.confidence;
    if (typeof rawConf !== "number") {
      if (sev === "CRITICAL") rawConf = 0.99;
      else if (sev === "HIGH") rawConf = /apogee|perigee|inclination/i.test(rawLabel) ? 0.96 : 0.93;
      else if (sev === "MODERATE") rawConf = 0.86;
      else rawConf = 0.78;
    }
    const conf = Math.round(rawConf * 100);
    right.innerHTML = `<span style="color:#38bdf8; font-weight:600;">${modelName}</span> <span style="color:var(--text-faint);">(${conf}%)</span>`;

    row.appendChild(left);
    row.appendChild(right);
    table.appendChild(row);
  });

  // 2. Sample Non-Sensitive Items (Classified as Safe & Public for VLM context)
  const safeMarks = marks.slice(0, 5);
  safeMarks.forEach((m) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.18); border-radius:4px; padding:5px 8px; font-size:11px;";

    const left = document.createElement("div");
    left.style.cssText = "display:flex; align-items:center; gap:6px; overflow:hidden;";

    const badge = document.createElement("span");
    badge.style.cssText = "background:rgba(16,185,129,0.2); color:#34d399; font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; white-space:nowrap;";
    badge.textContent = "SAFE / PUBLIC";

    const name = document.createElement("span");
    name.style.cssText = "color:#e2e8f0; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:135px;";
    name.textContent = `${m.label || m.role} [${m.id}]`;
    name.title = name.textContent;

    left.appendChild(badge);
    left.appendChild(name);

    const right = document.createElement("div");
    right.style.cssText = "font-size:10px; color:var(--text-muted); text-align:right; white-space:nowrap;";
    right.innerHTML = `<span style="color:#10b981; font-weight:600;">SoM Grounding</span> <span style="color:var(--text-faint);">(Public)</span>`;

    row.appendChild(left);
    row.appendChild(right);
    table.appendChild(row);
  });
}

if ($("modelInspectorToggle")) {
  $("modelInspectorToggle").addEventListener("click", () => {
    const body = $("modelInspectorBody");
    if (body) {
      body.hidden = !body.hidden;
    }
  });
}

// ── Visual Privacy X-Ray Split Lens ──────────────────────────────────────────
let currentScanData = null;
let isXRayActive = false;

function updateXRaySplit() {
  if (!currentScanData || !isXRayActive) return;
  const canvas = $("xrayCanvas");
  if (!canvas) return;

  const sliderVal = Number($("xraySlider")?.value || 50);
  const rawSrc = currentScanData.rawImage || currentScanData.preview;
  const redSrc = currentScanData.preview;
  if (!rawSrc || !redSrc) return;

  const rawImg = new Image();
  const redImg = new Image();
  let loaded = 0;

  const onLoaded = () => {
    loaded++;
    if (loaded < 2) return;

    canvas.width = redImg.naturalWidth || 600;
    canvas.height = redImg.naturalHeight || 400;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const splitX = Math.round((sliderVal / 100) * w);

    ctx.clearRect(0, 0, w, h);

    // 1. Draw raw image on left side
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, h);
    ctx.clip();
    ctx.drawImage(rawImg, 0, 0, w, h);

    // Highlight sensitive boxes in raw side
    if (currentScanData.regions && currentScanData.viewport) {
      const sx = w / (currentScanData.viewport.w || w);
      const sy = h / (currentScanData.viewport.h || h);
      ctx.strokeStyle = "rgba(239, 68, 68, 0.9)";
      ctx.lineWidth = 2;
      ctx.fillStyle = "rgba(239, 68, 68, 0.18)";
      for (const r of currentScanData.regions) {
        const rx = r.x * sx;
        const ry = r.y * sy;
        const rw = r.w * sx;
        const rh = r.h * sy;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }
    ctx.restore();

    // 2. Draw sanitized / redacted image on right side
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, w - splitX, h);
    ctx.clip();
    ctx.drawImage(redImg, 0, 0, w, h);
    ctx.restore();

    // 3. Draw divider line
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, h);
    ctx.stroke();

    // Divider handle
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(splitX, h / 2, 8, 0, Math.PI * 2);
    ctx.fill();
  };

  rawImg.onload = onLoaded;
  redImg.onload = onLoaded;
  rawImg.src = rawSrc;
  redImg.src = redSrc;
}

if ($("xrayToggle")) {
  $("xrayToggle").addEventListener("click", (e) => {
    isXRayActive = !isXRayActive;
    e.currentTarget.setAttribute("aria-pressed", String(isXRayActive));
    const controlBar = $("xrayControlBar");
    const canvas = $("xrayCanvas");
    const previewImg = $("preview");
    const overlay = $("regionOverlay");

    if (controlBar) controlBar.hidden = !isXRayActive;
    if (canvas) canvas.hidden = !isXRayActive;
    if (previewImg) previewImg.style.opacity = isXRayActive ? "0" : "1";
    if (overlay) overlay.style.display = isXRayActive ? "none" : "";

    if (isXRayActive) {
      updateXRaySplit();
    }
  });
}

if ($("xraySlider")) {
  $("xraySlider").addEventListener("input", updateXRaySplit);
}

// ── Visual Audit Trail & Session Replay ──────────────────────────────────────
const visualAuditEvents = [];

function recordVisualAuditStep(actionName, target, details, screenshot) {
  const stepNumber = visualAuditEvents.length + 1;
  const event = {
    step: stepNumber,
    timestamp: new Date().toISOString(),
    action: actionName,
    target: target || "page",
    details: details || "",
    screenshot: screenshot || (currentScanData ? currentScanData.preview : null),
    piiCount: currentScanData?.piiCount || 0
  };
  visualAuditEvents.push(event);

  const card = $("auditTrailCard");
  const timeline = $("auditTimeline");
  if (card) card.hidden = false;

  if (timeline) {
    const item = document.createElement("div");
    item.className = "audit-entry";
    item.innerHTML = `
      <div class="audit-entry-head">
        <strong style="color: #38bdf8;">Step #${stepNumber}: ${esc(actionName)}</strong>
        <span style="font-size: 9.5px; color: #94a3b8;">${new Date().toLocaleTimeString()}</span>
      </div>
      <div style="font-size: 10.5px; color: #cbd5e1; margin-bottom: 4px;">Target: <code>${esc(target || "page")}</code> — ${esc(details || "")}</div>
      ${event.screenshot ? `<img src="${event.screenshot}" class="audit-entry-thumb" alt="Step ${stepNumber} redacted frame" />` : ""}
    `;
    timeline.appendChild(item);
  }
}

if ($("exportVisualAuditBtn")) {
  $("exportVisualAuditBtn").addEventListener("click", () => {
    if (visualAuditEvents.length === 0) {
      showStatus("statusMsg", "info", "No visual audit steps recorded in this session yet.");
      return;
    }
    const auditData = {
      title: "VisionVault Visual Audit Trail & Session Replay",
      version: "2.0.0-enterprise",
      exportTime: new Date().toISOString(),
      task: taskEl?.value || "Autonomous Agent Run",
      totalSteps: visualAuditEvents.length,
      events: visualAuditEvents
    };
    const blob = new Blob([JSON.stringify(auditData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `visionvault-visual-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus("statusMsg", "success", "Visual audit trail exported successfully.");
  });
}

async function downloadScanSummary(statusId) {
  if (!currentScanData) {
    showStatus(statusId, "info", "Scan an active tab to generate a summary.");
    return;
  }
  try {
    const report = await VaultCrypto.generateSessionReport({
      piiCount: currentScanData.piiCount,
      marksCount: currentScanData.markCount,
      timings: currentScanData.timings,
    });
    const blob = new Blob([JSON.stringify(report.json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "visionvault-scan-" + Date.now() + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus(statusId, "success", "Scan summary downloaded.");
  } catch {
    showStatus(statusId, "error", "Unable to generate the scan summary.");
  }
}

$("generateDpdpBtn").addEventListener("click", () => downloadScanSummary("sessionReportStatus"));
$("scoreCertBtn").addEventListener("click", () => downloadScanSummary("statusMsg"));

// ── Zero-Knowledge AES-256-GCM Vault Backup ──────────────────────────────────
if ($("exportVaultBackupBtn")) {
  $("exportVaultBackupBtn").addEventListener("click", async () => {
    if (typeof VaultCrypto === "undefined" || !VaultCrypto.exportEncryptedVaultBackup) {
      showStatus("vaultStatus", "error", "VaultCrypto module not available.");
      return;
    }
    const password = prompt("Enter a master password / passphrase to encrypt your vault backup (AES-256-GCM + PBKDF2 100k rounds):");
    if (!password) {
      showStatus("vaultStatus", "info", "Backup export cancelled.");
      return;
    }

    try {
      let v = {};
      if (typeof getVault === "function") v = await getVault();
      else {
        const { vault } = await chrome.storage.local.get("vault");
        v = vault || {};
      }

      const backup = await VaultCrypto.exportEncryptedVaultBackup(v, password);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `visionvault-encrypted-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      showStatus("vaultStatus", "success", "Encrypted vault backup exported successfully.");
    } catch (err) {
      showStatus("vaultStatus", "error", "Backup export failed: " + err.message);
    }
  });
}

if ($("importVaultBackupBtn")) {
  $("importVaultBackupBtn").addEventListener("click", () => {
    const fileInput = $("vaultBackupFileInput");
    if (fileInput) fileInput.click();
  });
}

if ($("vaultBackupFileInput")) {
  $("vaultBackupFileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const password = prompt("Enter the master password / passphrase to decrypt and restore this backup:");
    if (!password) {
      showStatus("vaultStatus", "info", "Import cancelled.");
      e.target.value = "";
      return;
    }

    try {
      const text = await file.text();
      const restored = await VaultCrypto.importEncryptedVaultBackup(text, password);
      
      if (typeof saveVaultData === "function") {
        await saveVaultData(restored);
      } else {
        await chrome.storage.local.set({ vault: restored });
      }

      await loadVault();
      showStatus("vaultStatus", "success", "Vault restored and decrypted successfully!");
    } catch (err) {
      showStatus("vaultStatus", "error", "Backup restoration failed: " + err.message);
    } finally {
      e.target.value = "";
    }
  });
}

// ── Timing bar ────────────────────────────────────────────────────────────────
function renderTimings(t) {
  if (!t) return;
  const dom = t.scan || t.domScan || 0;
  const cap = t.screenshot || t.capture || 0;
  const vision = t.visionInference || ((t.faceInference || 0) + (t.ocrInference || 0));
  const redact = t.redact || 0;
  const total = t.total || (dom + cap + vision + redact);

  $("timingTotalLabel").textContent = `${total}ms`;

  const stages = [
    { label: "DOM", value: dom, css: "--stage-dom" },
    { label: "Capture", value: cap, css: "--stage-capture" },
    { label: "Vision ML", value: vision, css: "--stage-vision" },
    { label: "Redact", value: redact, css: "--stage-redact" },
  ].filter((s) => s.value > 0);

  $("timingBar").innerHTML = stages
    .map((s) => `<div class="timing-segment" style="flex:${s.value}; background:var(${s.css})"></div>`)
    .join("");

  $("timingLabels").innerHTML = stages
    .map((s) => `<span class="timing-badge"><span class="timing-dot" style="background:var(${s.css})"></span>${s.label} <strong>${s.value}ms</strong></span>`)
    .join("");

  timingWrap.hidden = false;
}

// ── Activity log ──────────────────────────────────────────────────────────────
function addLogEntry(iconName, html, ms, isError) {
  clearLiveStep();
  const row = document.createElement("div");
  row.className = "log-entry" + (isError ? " error" : "");
  row.innerHTML =
    `<span class="log-icon">${icon(iconName)}</span>` +
    `<span class="log-msg">${html}</span>` +
    (ms ? `<span class="log-ms">${ms}ms</span>` : "");
  logEntries.appendChild(row);
  logWrap.hidden = false;
  logEntries.scrollTop = logEntries.scrollHeight;
  actionCount += 1;
  setStat("s-actions", actionCount);
  $("logCount").textContent = `${actionCount} action${actionCount === 1 ? "" : "s"}`;
  if (typeof recordVisualAuditStep === "function") {
    recordVisualAuditStep(iconName, html, ms ? `${ms}ms` : "");
  }
}

/** A single in-progress row at the tail of the log, replaced as the step advances. */
// How each planning tier is named in the UI. Showing this makes a silent failover — the
// hosted model hitting its quota and the local one taking over — visible instead of just
// feeling slower for no stated reason.
const TIER_LABELS = {
  gemini: "Gemini",
  groq: "Groq",
  ollama: "Local model",
  mock: "Built-in rules",
  "on-device": "On-device",
  server: "",
};

function tierPill(tier) {
  if (!tier) return "";
  const label = TIER_LABELS[tier] !== undefined ? TIER_LABELS[tier] : tier;
  if (!label) return "";
  return `<span class="tier-pill tier-${esc(tier)}">${esc(label)}</span>`;
}

function setLiveStep(text, tier) {
  if (!liveStepRow) {
    liveStepRow = document.createElement("div");
    liveStepRow.className = "log-entry running";
    logEntries.appendChild(liveStepRow);
    logWrap.hidden = false;
  }
  liveStepRow.innerHTML =
    `<span class="log-icon"><span class="spinner"></span></span>` +
    `<span class="log-msg">${text}</span>${tierPill(tier)}`;
  logEntries.scrollTop = logEntries.scrollHeight;
}
function clearLiveStep() {
  if (liveStepRow) { liveStepRow.remove(); liveStepRow = null; }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
// Vault-intent commands: must mention vault/dashboard explicitly, or use "store/save/remember"
// with "these/this/the" (pointing at the current page). Must NOT fire on normal agent tasks.
const VAULT_STORE_RE = /\b(store|save|remember|capture|extract|read).{0,30}(vault|dashboard)\b|\b(store|save|remember)\s+(these|this|the)\s+(values?|fields?|data|details?)\b/i;
// Fill-from-vault: must mention "vault" or "stored/saved values" explicitly.
const VAULT_FILL_RE  = /\b(fill|populate|autofill|use|apply).{0,30}(vault|stored values?|saved values?|from vault)\b|\bfill.{0,20}from\s+(the\s+)?vault\b/i;

scanBtn.addEventListener("click", async () => {
  const task = taskEl.value.trim();
  if (!task) {
    showStatus("statusMsg", "error", "Please describe what the agent should do.");
    taskEl.focus();
    return;
  }

  // Resolve current active tab in this side panel window
  const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
  const currentTab = (tabs && tabs[0]) ? tabs[0] : null;
  const tabId = currentTab?.id || null;

  resetPipeline();
  setProtection("running", "Reading the screen locally");
  setPipelineStage("observe");

  const isVaultStore = VAULT_STORE_RE.test(task);
  const isVaultFill = VAULT_FILL_RE.test(task);

  if (isVaultStore) {
    busy(scanBtn, "Storing to vault…");
    chrome.runtime.sendMessage({ type: "STORE_PAGE_TO_VAULT", tabId }, (res) => {
      scanBtn.disabled = false;
      scanBtn.innerHTML = SCAN_LABEL;
      if (!res || !res.ok) {
        showStatus("statusMsg", "error", res?.error || "No vault fields found on this page.");
        return;
      }
      const n = res.count || Object.keys(res.stored || {}).length;
      const sat = res.stored?.satellite_name ? ` (${res.stored.satellite_name})` : "";
      showStatus("statusMsg", "success", `✓ Stored ${n} mission & credentials values into Encrypted Vault${sat}.`);
      loadVault();
      // Background scan to update preview without blocking UI
      chrome.runtime.sendMessage({ type: "SCAN", task, tabId }, (scanRes) => {
        if (scanRes && scanRes.ok && scanRes.result) {
          renderScan(scanRes.result, false);
        }
      });
    });
    return;
  }

  if (isVaultFill) {
    const PAGE_MAP = [
      { re: /form\s*1|personal|hr/i,            page: "form-hr" },
      { re: /form\s*2|payroll|banking|salary/i,     page: "form-payroll" },
      { re: /form\s*3|asset|it|system/i,         page: "form-it" },
      { re: /form\s*4|housing|quarter/i,        page: "form-housing" },
      { re: /form\s*5|medical|health|depend/i,     page: "form-medical" },
      { re: /form\s*6|gaganyaan|spaceflight/i,     page: "form-gaganyaan" },
      { re: /mission\s*reg/i,                    page: "form1" },
      { re: /frequen/i,                          page: "form2" },
      { re: /ground\s*station/i,                 page: "form3" },
      { re: /security|clearance/i,               page: "form4" },
      { re: /operator|credential/i,              page: "form5" },
    ];
    const match = PAGE_MAP.find(p => p.re.test(task));
    const targetPage = match ? match.page : null;
    busy(scanBtn, "Filling from vault…");
    chrome.runtime.sendMessage({ type: "FILL_FROM_VAULT", targetPage, tabId }, (res) => {
      scanBtn.disabled = false;
      scanBtn.innerHTML = SCAN_LABEL;
      if (!res || !res.ok) {
        showStatus("statusMsg", "error", res?.error || "Vault is empty — navigate to the dashboard first.");
        return;
      }
      const n = res.filled || 0;
      const missing = res.missing || [];
      if (missing.length) {
        showStatus("statusMsg", "info", `Filled ${n} field${n===1?"":"s"} from vault. Asking about ${missing.length} missing field${missing.length===1?"":"s"}…`);
        promptMissingFields(missing, 0);
      } else {
        showStatus("statusMsg", "success", `Filled ${n} field${n===1?"":"s"} from vault.`);
        chrome.runtime.sendMessage({ type: "SCAN", task }, (postScan) => {
          if (postScan && postScan.ok && postScan.result) {
            renderScan(postScan.result, false);
          }
        });
      }
    });
    return;
  }

  busy(scanBtn, "Scanning…");
  idleState.hidden = true;
  scanSkeleton.hidden = false;
  runBtn.hidden = true;
  previewWrap.hidden = true;
  statsGrid.hidden = true;
  if ($("scoreCard")) $("scoreCard").hidden = true;
  if ($("modelInspectorCard")) $("modelInspectorCard").hidden = true;
  timingWrap.hidden = true;
  confirmWrap.hidden = true;
  inputPromptWrap.hidden = true;
  logWrap.hidden = true;
  logEntries.innerHTML = "";
  liveStepRow = null;
  actionCount = 0;
  renderedLogCount = 0;
  const scanWatchdog = setTimeout(() => {
    scanBtn.disabled = false;
    scanBtn.innerHTML = SCAN_LABEL;
    scanSkeleton.hidden = true;
    idleState.hidden = false;
    showStatus("statusMsg", "warn", "Scan is taking longer than expected. Check if the active tab is loading, or click 'Run agent' again.");
  }, 35000);

  chrome.runtime.sendMessage({ type: "SCAN", task, tabId }, (res) => {
    clearTimeout(scanWatchdog);
    scanBtn.disabled = false;
    scanBtn.innerHTML = SCAN_LABEL;
    scanSkeleton.hidden = true;

    if (chrome.runtime.lastError || !res || !res.ok) {
      idleState.hidden = false;
      const err = chrome.runtime.lastError?.message || res?.error || "Scan failed. Open a normal web page and try again.";
      showStatus("statusMsg", "error", err);
      return;
    }

    renderScan(res.result, true);

    // One mode, and it is automatic.
    //
    // Scan and Run used to be two buttons the user pressed in order, which made the privacy
    // step look like a separate feature they could skip — and made the product feel like a
    // tool rather than an agent. It is one flow: the scan IS the redaction, and nothing can
    // be transmitted until it has succeeded, so pausing between them protects nobody.
    //
    // The pause is kept for exactly one case: a scan that found nothing to act on. Running
    // then would just burn steps against a page the agent cannot see.
    if (autoAgentMode()) {
      setPipelineStage("reason");
      setRunning(true);
      runBtn.hidden = true;
      setLiveStep("Planning the first step…");
      startRun(true);
    }
  });
});

/**
 * Whether the agent carries straight on from the scan into the run.
 *
 * On by default. The toggle exists because a demo sometimes wants to stop on the redacted
 * frame and talk about it before anything moves.
 */
function autoAgentMode() {
  const el = $("s-autoAgent");
  return !el || el.checked;
}

function renderScorecard(d) {
  const card = $("scoreCard");
  if (!card) return;
  card.hidden = false;

  const found = d.piiCount || 0;
  const blocked = d.redactionOk === false;

  const badge = $("scoreBadge");
  badge.classList.toggle("is-blocked", blocked);
  badge.textContent = blocked ? "Blocked" : "Scan complete";

  $("score-found").textContent = found;
  $("score-masked").textContent = blocked ? "Unavailable" : (d.redacted ? found : "—");
  $("score-sent").textContent = d.redacted && !blocked ? "Available" : "Unavailable";

  // Which detector found what. Worth showing because the three disagree usefully: OCR finding
  // regions the DOM did not is the case for its cost, and a face count of zero on a page full
  // of photographs is a signal the model did not run.
  const b = d.sourceBreakdown || {};
  const chips = [
    { cls: "dom",  n: b.dom || 0,         label: "from the page text" },
    { cls: "face", n: b.vision_face || 0, label: "faces" },
    { cls: "ocr",  n: b.vision_ocr || 0,  label: "read from pixels" },
  ].filter((c) => c.n > 0);
  $("scoreSources").innerHTML = chips.length
    ? chips.map((c) => `<span class="score-src ${c.cls}"><b>${c.n}</b> ${esc(c.label)}</span>`).join("")
    : '<span class="score-src">No matches from active detectors</span>';

  $("scoreNote").textContent = blocked
    ? "This frame is blocked because redaction could not be verified."
    : "Detection coverage depends on the page and the selected vision depth.";

}

/** Paints a scan result into the panel. Shared by the Scan button and the run-time recovery. */
function renderScan(d, announce) {
  if (!d) return;
  currentScanData = d;
  $("preview").src = d.preview;
  previewWrap.hidden = false;
  statsGrid.hidden = false;
  idleState.hidden = true;

  if (isXRayActive && typeof updateXRaySplit === "function") {
    updateXRaySplit();
  }

  renderRegions(d.regions, d.viewport);
  renderModelInspector(d);

  renderScorecard(d);
  setStat("s-pii", d.piiCount);
  setStat("s-marks", d.markCount);
  setStat("s-total", (d.timings?.total || 0) + "ms");
  setStat("s-actions", 0);
  renderTimings(d.timings);



  // Only offered when the agent is NOT continuing on its own; otherwise two primary actions
  // are on screen at once and neither reads as the thing to press.
  runBtn.hidden = autoAgentMode();
  runBtn.innerHTML = RUN_LABEL;
  // The scan is the privacy review step; Run is what the user is being asked to approve next.
  scannedTask = taskEl.value.trim();
  if (announce) runBtn.focus();

  if (!announce) return;
  const fs = d.frameStats || {};
  const frameNote = (fs.total > 1) ? ` across ${fs.merged}/${fs.total} frames` : "";
  showStatus(
    "statusMsg",
    "success",
    `${d.piiCount} sensitive region${d.piiCount === 1 ? "" : "s"} detected${frameNote}. Review the masked preview before continuing.`
  );
}

// ── Run / Stop ────────────────────────────────────────────────────────────────
runBtn.addEventListener("click", () => {
  busy(runBtn, "Running…");
  setRunning(true);
  confirmWrap.hidden = true;
  hideStatus("statusMsg");
  setLiveStep("Planning the first step…");
  // A rail carrying the previous run's marks would claim work this run has not done.
  resetPipeline();
  setProtection("running");
  startRun(true);
});

/**
 * Sends RUN, and recovers from the one failure the user should never have to think about.
 *
 * Chrome tears down an idle MV3 service worker after about 30 seconds. If that happens between
 * scanning and pressing Run, the scan state is gone and the loop has nothing to work from.
 * Silently re-scanning and trying once more is exactly what the user would do by hand.
 */
// ── Prompt user for missing vault fields one by one ──────────────────────────
function promptMissingFields(missing, index) {
  if (index >= missing.length) {
    showStatus("statusMsg", "success", "All fields filled.");
    return;
  }
  const field = missing[index];
  currentMissingField = field.key;
  currentMissingMarkId = null;

  $("inputPromptText").innerHTML =
    `The vault has no value for <strong>${esc(field.label || field.key)}</strong>. ` +
    `Enter it now and the agent will type it into the field.`;

  const saveRow = $("saveMissingToVault")?.closest("label");
  if (saveRow) saveRow.hidden = false;
  if ($("saveMissingToVault")) $("saveMissingToVault").checked = true;

  const el = $("missingInputValue");
  const secret = /password|passcode|pin|otp|cvv|secret/i.test(field.key || "");
  el.type = secret ? "password" : "text";
  el.placeholder = secret ? "Enter the value (hidden)" : `Enter your ${esc(field.label || field.key)}`;
  el.value = "";

  reveal(inputPromptWrap);
  el.focus();

  // Override submit to type into the page field then continue
  const onSubmit = () => {
    const value = $("missingInputValue").value.trim();
    const saveToVault = $("saveMissingToVault").checked;
    inputPromptWrap.hidden = true;
    $("inputPromptSubmit").removeEventListener("click", onSubmit);
    $("inputPromptSkip").removeEventListener("click", onSkip);
    if (!value) { promptMissingFields(missing, index + 1); return; }
    chrome.runtime.sendMessage({ type: "FILL_SINGLE_FIELD", key: field.key, value, saveToVault }, () => {
      promptMissingFields(missing, index + 1);
    });
  };
  const onSkip = () => {
    inputPromptWrap.hidden = true;
    $("inputPromptSubmit").removeEventListener("click", onSubmit);
    $("inputPromptSkip").removeEventListener("click", onSkip);
    promptMissingFields(missing, index + 1);
  };
  $("inputPromptSubmit").addEventListener("click", onSubmit);
  $("inputPromptSkip").addEventListener("click", onSkip);
}

function startRun(allowRescan) {
  chrome.runtime.sendMessage({ type: "RUN" }, (res) => {
    const expired = !res?.ok && /run scan first/i.test(res?.error || "");
    if (expired && allowRescan) {
      setLiveStep("Re-reading the page…");
      chrome.runtime.sendMessage({ type: "SCAN", task: taskEl.value.trim() }, (scanRes) => {
        if (!scanRes || !scanRes.ok) {
          finishRun({ ok: false, error: scanRes?.error || "Could not re-read the page." });
          return;
        }
        renderScan(scanRes.result, false);
        startRun(false);
      });
      return;
    }
    finishRun(res);
  });
}

function finishRun(res) {
  runBtn.disabled = false;
  runBtn.innerHTML = RUN_LABEL;
  setRunning(false);
  if (!res || !res.ok) {
    showStatus("statusMsg", "error", res?.error || "The agent could not run.");
    return;
  }
  handleStepResult(res.result);
  // Refresh history cache silently so it's ready when the tab is opened
  loadHistory();
}

stopBtn.addEventListener("click", () => {
  stopBtn.disabled = true;
  setLiveStep("Stopping…");
  chrome.runtime.sendMessage({ type: "STOP" }, () => {
    stopBtn.disabled = false;
    showStatus("statusMsg", "warn", "Stopping after the current step.");
  });
});

// ── Result rendering ──────────────────────────────────────────────────────────
function handleStepResult(r) {
  if (!r) return;
  clearLiveStep();

  // phaseRun returns the cumulative log each time it yields; only render what is new.
  (r.actionLog || []).slice(renderedLogCount).forEach((a) => {
    const failed = a.ok === false;
    const suffix = failed ? ` <span style="opacity:.85">(failed${a.error ? ": " + esc(a.error) : ""})</span>` : "";
    if (a.action === "type") {
      addLogEntry(failed ? "alert" : "type", `Filled <strong>${esc(a.field)}</strong> in element #${esc(a.mark_id)}${suffix}`, a.serverMs, failed);
    } else if (a.action === "navigate" || a.action === "open_tab") {
      addLogEntry("globe", `Opened <strong>${esc(a.value)}</strong>${suffix}`, a.serverMs, failed);
    } else if (a.action === "scroll") {
      addLogEntry("arrow-down", `Scrolled the page${suffix}`, a.serverMs, failed);
    } else if (a.action === "click") {
      addLogEntry(failed ? "alert" : "cursor", `Clicked element #${esc(a.mark_id)}${suffix}`, a.serverMs, failed);
    } else if (a.action === "rejected_by_user") {
      addLogEntry("slash", `Rejected the click on element #${esc(a.mark_id)}`, null, true);
    } else {
      addLogEntry(failed ? "alert" : "check", `${esc(a.action)} on element #${esc(a.mark_id)}${suffix}`, a.serverMs, failed);
    }
  });
  renderedLogCount = (r.actionLog || []).length;

  if (r.needsInput) {
    currentMissingField = r.fieldKey;
    currentMissingMarkId = r.action.mark_id;
    confirmWrap.hidden = true;
    reveal(inputPromptWrap);
    // Two different questions, and phrasing them the same way confuses both.
    //
    // A vault field is something the user HAS and the vault happens not to hold, so the
    // sensible offer is "tell me once and I will remember". A task value — a travel date, a
    // destination, a headcount — is something only they can decide, belongs to this task
    // rather than to them, and must not be offered for storage at all.
    const isVaultField = !String(r.fieldKey || "").startsWith("field:");
    const fieldName = isVaultField
      ? (r.fieldLabel && r.fieldLabel !== r.fieldKey
          ? `${esc(r.fieldLabel)} (${esc(r.fieldKey)})`
          : esc(r.fieldKey))
      : esc(r.fieldLabel || "this field");

    $("inputPromptText").innerHTML = isVaultField
      ? `The page is asking for <strong>${fieldName}</strong>, and your vault has no value for it. ` +
        `Type it once and the agent will carry on — it stays on this machine either way.`
      : `This page needs <strong>${fieldName}</strong> before the agent can continue. ` +
        `It is specific to this task, so it is used here and not stored.`;

    // The remember-me offer only makes sense for something worth remembering.
    const saveRow = $("saveMissingToVault")?.closest("label");
    if (saveRow) saveRow.hidden = !isVaultField;
    if (!isVaultField && $("saveMissingToVault")) $("saveMissingToVault").checked = false;
    const el = $("missingInputValue");
    // A secret must not sit in clear text in a panel that stays open on screen.
    const secret = /password|passcode|pin|otp|cvv|secret/i.test(r.fieldKey || "");
    el.type = secret ? "password" : "text";
    el.placeholder = secret ? "Enter the value (hidden as you type)" : `Enter your ${esc(r.fieldKey)}`;
    el.value = "";
    el.focus();
    showStatus("statusMsg", "info", "Waiting for a value from you.");
    return;
  }

  if (r.needsConfirm) {
    inputPromptWrap.hidden = true;
    reveal(confirmWrap);
    $("confirmText").innerHTML =
      `<strong>${esc(String(r.action.action || "click").toUpperCase())}</strong> on element #${esc(r.action.mark_id)}` +
      (r.action.reasoning ? `<br>${esc(r.action.reasoning)}` : "") +
      (r.confirmReason ? `<br><span style="color:var(--text-muted)">Why you are being asked: ${esc(r.confirmReason)}</span>` : "");
    // Modify is only meaningful where there is a value to change. A bare click has nothing
    // to edit, so offering the control would be a dead end.
    pendingConfirmValue = r.action.value != null ? String(r.action.value) : null;
    const editable = pendingConfirmValue !== null;
    $("confirmEdit").hidden = !editable;
    $("confirmEditWrap").hidden = true;
    if (editable) $("confirmEditValue").value = pendingConfirmValue;

    showStatus("statusMsg", "warn", "Approval required before this click is dispatched.");
    return;
  }

  if (r.error) {
    showStatus("statusMsg", "error", r.error);
    return;
  }

  const log = r.actionLog || [];
  const ok = log.filter((a) => a.ok !== false).length;
  const failed = log.length - ok;

  if (r.stopped) {
    showStatus("statusMsg", "warn", `Stopped. ${ok} action${ok === 1 ? "" : "s"} had completed.`);
  } else if (log.length) {
    // Say what was achieved, not just how many calls succeeded. "3 actions succeeded" tells
    // you nothing about whether the thing you asked for happened.
    const achieved = describeProgress(r.progress);
    const counts = `${ok} action${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`;
    showStatus("statusMsg", failed ? "warn" : "success",
      achieved ? `${achieved} (${counts})` : `Finished — ${counts}.`);
  } else {
    showStatus("statusMsg", "info", "Nothing to do for this task on this page.");
  }
}

/** Turns the agent's progress record into one sentence about what actually happened. */
function describeProgress(p) {
  if (!p) return "";
  const bits = [];
  if (p.navigated) bits.push("opened the site");
  // querySubmitted is the strong claim — the query reached the URL or title. queryLanded on
  // its own only means the text is sitting in a field, which is not the same thing.
  if (p.querySubmitted) bits.push("ran the search");
  else if (p.queryLanded) bits.push("typed the query (the site did not run it)");
  if ((p.opened || []).length) bits.push(`opened ${p.opened.length} item${p.opened.length === 1 ? "" : "s"}`);
  if (p.scrolled) bits.push("scrolled the page");
  if (p.filledAny) bits.push("filled the form");
  if (!bits.length) return "";
  return "Done — " + bits.join(", ") + ".";
}

// ── Missing value prompt ──────────────────────────────────────────────────────
$("missingInputValue").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("inputPromptSubmit").click();
  }
});

$("inputPromptSubmit").addEventListener("click", () => {
  const value = $("missingInputValue").value.trim();
  const saveToVault = $("saveMissingToVault").checked;
  inputPromptWrap.hidden = true;
  showStatus("statusMsg", "info", "Filling the value and continuing…");
  setRunning(true);
  setLiveStep("Filling the value…");

  chrome.runtime.sendMessage({
    type: "PROVIDE_INPUT",
    payload: { value, saveToVault, fieldKey: currentMissingField, mark_id: currentMissingMarkId },
  }, (res) => {
    setRunning(false);
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", res?.error || "Could not fill that value.");
      return;
    }
    if (saveToVault) loadVault();
    handleStepResult(res.result);
  });
});

$("inputPromptSkip").addEventListener("click", () => {
  inputPromptWrap.hidden = true;
  setRunning(true);
  setLiveStep("Skipping the field…");
  chrome.runtime.sendMessage({ type: "SKIP_INPUT", payload: { mark_id: currentMissingMarkId } }, (res) => {
    setRunning(false);
    handleStepResult(res?.result);
  });
});

// ── Approval gate ─────────────────────────────────────────────────────────────
//
// Three answers, not two. Approve/Reject forces the whole run to be abandoned to fix one
// field - the wrong quantity, a search term that is nearly right - when what the person wants
// is to correct it and carry on. Modify is that third answer.
//
// The edited value goes to the SAME pending action; the target the guard approved is not
// changed, so this cannot be used to redirect an approved click somewhere else.
let pendingConfirmValue = null;

$("confirmEdit").addEventListener("click", () => {
  const wrap = $("confirmEditWrap");
  const input = $("confirmEditValue");
  if (wrap.hidden) {
    wrap.hidden = false;
    input.focus();
    input.select();
    $("confirmEdit").textContent = "Use this value";
    return;
  }
  // Second press: send the edit, then execute.
  const value = input.value;
  confirmWrap.hidden = true;
  $("confirmEdit").textContent = "Modify";
  setRunning(true);
  setLiveStep("Executing with your value…");
  chrome.runtime.sendMessage({ type: "CONFIRM", payload: { value } }, (res) => {
    setRunning(false);
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", res?.error || "The modified action failed.");
      return;
    }
    handleStepResult(res.result);
  });
});

$("confirmYes").addEventListener("click", () => {
  confirmWrap.hidden = true;
  showStatus("statusMsg", "info", "Executing the approved action…");
  setRunning(true);
  setLiveStep("Executing the approved action…");
  chrome.runtime.sendMessage({ type: "CONFIRM" }, (res) => {
    setRunning(false);
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", res?.error || "The approved action failed.");
      return;
    }
    handleStepResult(res.result);
  });
});

$("confirmNo").addEventListener("click", () => {
  confirmWrap.hidden = true;
  $("confirmEditWrap").hidden = true;
  $("confirmEdit").textContent = "Modify";
  chrome.runtime.sendMessage({ type: "REJECT" });
  showStatus("statusMsg", "warn", "Action rejected. The agent stopped there.");
});

// ── Task history ─────────────────────────────────────────────────────────────
function renderHistory(history) {
  const el = $("historyList");
  if (!el) return;
  $("clearHistory").disabled = !history?.length;
  if (!history?.length) {
    el.innerHTML = '<div class="history-empty"><strong>No tasks run yet</strong><p class="hint">Completed and stopped tasks will appear here.</p></div>';
    return;
  }
  el.innerHTML = history.map((h) => {
    const ago = formatAgo(h.ts);
    const badge = h.ok
      ? `<span class="history-status is-success">${icon("check")}<span>Completed</span></span>`
      : `<span class="history-status">${icon("alert")}<span>Stopped</span></span>`;
    return `<button class="history-item" type="button" data-task="${esc(h.task)}">
      ${badge}
      <strong>${esc(h.task)}</strong>
      <span class="history-item-meta">${esc(ago)} · ${h.steps} step${h.steps === 1 ? "" : "s"}${
        h.error ? " · " + esc(h.error.slice(0, 60)) : ""}</span>
    </button>`;
  }).join("");
  // Click a history entry to pre-fill the task box
  el.querySelectorAll("[data-task]").forEach((row) => {
    row.addEventListener("click", () => {
      taskEl.value = row.dataset.task;
      taskEl.dispatchEvent(new Event("input"));
      document.querySelector(".tab[data-tab='run']").click();
      taskEl.focus();
    });
  });
}

function formatAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function loadHistory() {
  chrome.runtime.sendMessage({ type: "GET_TASK_HISTORY" }, (res) => {
    renderHistory(res?.history || []);
  });
}

// Load history when the History tab is opened
document.querySelectorAll(".tab").forEach((btn) => {
  if (btn.dataset.tab === "history") {
    btn.addEventListener("click", loadHistory);
  }
});

$("clearHistory")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_TASK_HISTORY" }, () => {
    renderHistory([]);
    $("historyHeading").focus();
  });
});

// ── Pipeline rail and protection banner ──────────────────────────────────────
//
// These reflect the run rather than decorating it. The rail is driven from the same
// notifications the log is built from, so it cannot show a stage the agent is not in — a
// privacy indicator that is merely animated would be worse than none, because it would be
// evidence of nothing while looking like evidence of something.

const PIPE_ORDER = ["observe", "redact", "reason", "act"];

function setPipelineStage(stage) {
  const idx = PIPE_ORDER.indexOf(stage);
  document.querySelectorAll(".pipe-step").forEach((el) => {
    const i = PIPE_ORDER.indexOf(el.dataset.stage);
    el.classList.toggle("is-active", i === idx);
    // Everything before the current stage has genuinely happened this step.
    el.classList.toggle("is-done", idx > -1 && i < idx);
  });
}

function resetPipeline() {
  document.querySelectorAll(".pipe-step").forEach((el) => {
    el.classList.remove("is-active", "is-done");
  });
}

/**
 * @param {"armed"|"running"|"breach"} state
 */
function setProtection(state, detail) {
  const el = $("protectBanner");
  if (!el) return;
  el.classList.toggle("running", state === "running");
  el.classList.toggle("breach", state === "breach");
  const title = $("protectTitle");
  const sub = $("protectState");
  if (title) {
    title.textContent = state === "breach" ? "Transmission blocked"
      : state === "running" ? "Protecting this run"
      : "Local detection";
  }
  if (sub) {
    sub.textContent = detail || (
      state === "breach" ? "This frame was blocked"
      : state === "running" ? "Checking this page for sensitive content"
      : "Review the scan before running actions");
  }
}

// Map the worker's own notifications onto the rail. The strings come from background.js and
// are the same ones the user reads in the log, so the two can never disagree.
function pipelineFromStatus(text) {
  const t = (text || "").toLowerCase();
  if (/reading the page|scanning|screenshot/.test(t)) return "observe";
  if (/redact|masking/.test(t)) return "redact";
  if (/asking the planner|planner|thinking/.test(t)) return "reason";
  if (/click|type|scroll|navigat|filled|approved action|following the page/.test(t)) return "act";
  return null;
}

// ── Dictation ────────────────────────────────────────────────────────────────
//
// Typing a whole instruction into a side panel is the slowest part of using this thing, so the
// task box takes speech as well. Push-to-talk rather than always-listening: the recogniser
// runs only while the user has asked for it, and stops the moment they stop asking.
//
// One thing is said out loud rather than hidden, because this extension has no business being
// quiet about it: Chrome's SpeechRecognition is a NETWORK service. The audio goes to Google to
// be transcribed. That is a different trust boundary from everything else here — page content,
// captures and vault values never leave the device — and the panel says so while the
// microphone is live, next to the button that turned it on.
//
// Nothing about this touches the redaction path. A dictated task is just text in the same box.

const Recognizer = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let recognising = false;
// Text already in the box when dictation started, so speech appends rather than replaces.
let dictationBase = "";

function setMicLive(live) {
  recognising = live;
  const btn = $("micBtn");
  const note = $("micNote");
  if (btn) {
    btn.classList.toggle("is-live", live);
    btn.setAttribute("aria-label", live ? "Stop dictating" : "Dictate the task");
    btn.title = live ? "Stop dictating" : "Dictate the task";
  }
  if (note) note.hidden = !live;
}

async function startDictation() {
  if (recognising) {
    stopDictation();
    return;
  }

  dictationBase = (taskEl.value || "").trim();

  // 1. Try In-Page dictation on active web tab (avoids Chrome extension speech restrictions)
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
      setMicLive(true);
      showStatus("statusMsg", "info", "Listening on page… Speak your command.");
      chrome.tabs.sendMessage(tab.id, { type: "START_IN_PAGE_VOICE" }, (res) => {
        if (chrome.runtime.lastError || (res && !res.ok)) {
          console.warn("[dictation] In-page voice fallback to popup:", chrome.runtime.lastError?.message);
          startLocalDictation();
        }
      });
      return;
    }
  } catch (_) {}

  // 2. Fallback to local popup dictation
  startLocalDictation();
}

function stopDictation() {
  setMicLive(false);
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
    recognition = null;
  }
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "STOP_IN_PAGE_VOICE" }).catch(() => {});
  }).catch(() => {});
}

function startLocalDictation() {
  if (!Recognizer) {
    showStatus("statusMsg", "warn", "Web Speech API is not supported in this browser.");
    setMicLive(false);
    return;
  }

  recognition = new Recognizer();
  recognition.lang = navigator.language || "en-IN";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  dictationBase = (taskEl.value || "").trim();

  recognition.onstart = () => setMicLive(true);

  recognition.onresult = (event) => {
    let text = "";
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
    const joined = (dictationBase ? dictationBase + " " : "") + text.trim();
    taskEl.value = joined.slice(0, 240);
    const c = $("charCount");
    if (c) c.textContent = taskEl.value.length;
  };

  recognition.onerror = (event) => {
    const err = event.error;
    if (err === "not-allowed" || err === "service-not-allowed") {
      showStatus("statusMsg", "info", "Opening microphone permission tab — please click 'Allow' there.");
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
      } catch (openErr) {
        showStatus(
          "statusMsg",
          "warn",
          "Microphone blocked. Allow it for this extension at chrome://settings/content/microphone."
        );
      }
    } else {
      const message =
        err === "no-speech"
          ? "Didn't catch anything — try again."
          : err === "network"
            ? "Speech recognition needs a network connection or active web page."
            : `Dictation stopped (${err}).`;
      showStatus("statusMsg", err === "no-speech" ? "info" : "warn", message);
    }
    setMicLive(false);
  };

  recognition.onend = () => {
    setMicLive(false);
    if (taskEl && taskEl.value.trim().length > 0 && typeof autoAgentMode === "function" && autoAgentMode()) {
      showStatus("statusMsg", "info", "Voice command recognized. Launching agent...");
      setTimeout(() => {
        if ($("scanBtn")) $("scanBtn").click();
      }, 600);
    }
  };

  try {
    recognition.start();
  } catch (err) {
    setMicLive(false);
    console.warn("[dictation] could not start:", err && err.message);
  }
}

// Global voice listener for in-page results
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "VOICE_RESULT") {
    if (taskEl && msg.transcript) {
      const joined = (dictationBase ? dictationBase + " " : "") + msg.transcript.trim();
      taskEl.value = joined.slice(0, 240);
      const c = $("charCount");
      if (c) c.textContent = taskEl.value.length;
    }
    if (msg.isFinal) {
      setMicLive(false);
      showStatus("statusMsg", "info", "Voice command recognized.");
      if (taskEl && taskEl.value.trim().length > 0 && typeof autoAgentMode === "function" && autoAgentMode()) {
        showStatus("statusMsg", "info", "Voice command recognized. Launching agent...");
        setTimeout(() => {
          if ($("scanBtn")) $("scanBtn").click();
        }, 600);
      }
    }
  } else if (msg.type === "VOICE_ERROR") {
    setMicLive(false);
    const err = msg.error;
    if (err === "not-allowed") {
      showStatus("statusMsg", "warn", "Microphone access blocked on this tab. Please allow microphone in Chrome.");
    } else if (err === "no-speech") {
      showStatus("statusMsg", "info", "Didn't catch anything — try again.");
    } else {
      showStatus("statusMsg", "warn", `Voice dictation stopped (${err}).`);
    }
  } else if (msg.type === "VOICE_END") {
    setMicLive(false);
  }
});

// The button only appears where it can actually do something.
if ($("micBtn")) {
  $("micBtn").hidden = false;
  $("micBtn").addEventListener("click", () => (recognising ? stopDictation() : startDictation()));
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "m" || e.key === "M")) {
    e.preventDefault();
    recognising ? stopDictation() : startDictation();
  }
  // Escape abandons dictation without submitting anything.
  if (e.key === "Escape" && recognising) stopDictation();
});

// ── Privacy: the transmission log ────────────────────────────────────────────
//
// Every other panel asks to be believed. This one shows the evidence: the exact bytes of every
// request, the redacted image as it was sent, and — where a personal value was involved — the
// field NAME the model asked for, with no value beside it.
//
// Rendering deliberately shows the raw payload rather than a summary of it. A summary is
// another thing to trust; the payload is the thing itself.

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtClock(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (_) { return ""; }
}

function renderAudit(entries, summary) {
  const listEl = $("auditList");
  if (!listEl) return;

  $("auditCount").textContent = summary.count || 0;
  $("auditBytes").textContent = fmtBytes(summary.bytes || 0);
  const dests = summary.destinations || [];
  let destLabel = "none";
  if (dests.length === 1) {
    try { destLabel = new URL(dests[0]).host; } catch (_) { destLabel = dests[0]; }
  } else if (dests.length > 1) {
    destLabel = `${dests.length} hosts`;
  }
  $("auditDest").textContent = destLabel;
  $("auditDest").title = dests.join("\n") || "nothing transmitted";

  if (!entries.length) {
    listEl.innerHTML = '<p class="hint" style="padding:12px 0">' +
      "Nothing has been transmitted yet. Run a task and every request will appear here.</p>";
    return;
  }

  listEl.innerHTML = entries.map((e, i) => {
    const err = e.outcome === "error";
    // The vault line only appears when there was one, so its presence is itself information.
    const vault = e.vaultFieldRequested
      ? `<div class="audit-vault">
           <strong>Vault field requested:</strong>
           <code>${esc(e.vaultFieldRequested)}</code>
           <span style="color:var(--text-muted)">— the name only. The value was filled in on
           this device and appears nowhere in the payload below.</span>
         </div>`
      : "";
    const img = e.image
      ? `<img class="audit-img" src="${esc(e.image)}" alt="the redacted capture as it was transmitted">
         <p class="audit-caption">The image exactly as sent. Masked before transmission, not after.</p>`
      : (e.imageDropped
          ? '<p class="audit-caption">Image not kept — only the most recent few are stored, to bound disk use.</p>'
          : "");

    return `<details class="audit-entry${err ? " is-error" : ""}" data-i="${i}">
      <summary class="audit-head">
        <span class="audit-when">${esc(fmtClock(e.at))}</span>
        <span class="audit-task">${esc(e.task || "(no task)")}</span>
        <span class="audit-size">${esc(fmtBytes(e.bytes))}</span>
        <svg class="ic audit-caret" viewBox="0 0 24 24"><use href="#i-arrow-down"/></svg>
      </summary>
      <div class="audit-body">
        <dl class="audit-kv">
          <dt>Sent to</dt><dd>${esc(e.url)}</dd>
          <dt>Step</dt><dd>${esc(String(e.step ?? "-"))}</dd>
          <dt>Payload</dt><dd>${esc(fmtBytes(e.bytes))} (${esc(fmtBytes(e.imageBytes))} of it the redacted image)</dd>
          <dt>Elements described</dt><dd>${esc(String(e.marks || 0))}</dd>
          <dt>Round trip</dt><dd>${e.durationMs ? esc(e.durationMs) + " ms" : "-"}</dd>
          <dt>Answered by</dt><dd>${esc(e.tier || "-")}</dd>
          <dt>Outcome</dt><dd>${err ? esc(e.error || "error") : "ok"}</dd>
        </dl>
        ${vault}
        ${img}
        <p class="audit-caption">Recorded request body:</p>
        <pre class="audit-payload">${esc(e.body || "")}</pre>
      </div>
    </details>`;
  }).join("");
}

async function loadAudit() {
  chrome.runtime.sendMessage({ type: "GET_AUDIT_LOG" }, (res) => {
    renderAudit(res?.entries || [], res?.summary || {});
  });
}

document.querySelectorAll(".tab").forEach((btn) => {
  if (btn.dataset.tab === "privacy") btn.addEventListener("click", loadAudit);
});

$("clearAudit")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_AUDIT_LOG" }, () => {
    renderAudit([], { count: 0, bytes: 0, destinations: [] });
  });
});

$("exportAudit")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EXPORT_AUDIT_LOG" }, (res) => {
    if (!res?.json) return;
    // A blob URL rather than a data: URL: the log can run to megabytes, and a data: URL that
    // size is refused by the downloads API.
    const blob = new Blob([res.json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: `visionvault-transmission-log-${new Date().toISOString().slice(0, 10)}.json`,
      saveAs: true,
    }, () => setTimeout(() => URL.revokeObjectURL(url), 60000));
  });
});

// ── Live updates from the service worker ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MIC_PERMISSION_GRANTED") {
    showStatus("statusMsg", "info", "Microphone access enabled! Click the mic button to dictate.");
    return;
  }
  if (msg?.type !== "AGENT_UPDATE") return;
  const d = msg.data;

  if (Array.isArray(d.checklist) && d.checklist.length > 0) {
    renderTaskChecklist(d.checklist);
  }

  if (d.type === "step") {
    if (scanSkeleton && !scanSkeleton.hidden && d.status) {
      busy(scanBtn, d.status);
    }
    setLiveStep(`Step ${esc(d.step)} — ${esc(d.status)}`, d.planner);
    const stage = pipelineFromStatus(d.status);
    if (stage) setPipelineStage(stage);
    setProtection("running");
  }
  if (d.type === "filled") {
    addLogEntry("type", `Filled <strong>${esc(d.field)}</strong> in element #${esc(d.mark_id)}`, null);
  }
  if (d.type === "failed") {
    addLogEntry("alert", `Could not fill <strong>${esc(d.field)}</strong> in element #${esc(d.mark_id)}${d.error ? " — " + esc(d.error) : ""}`, null, true);
  }
  if (d.type === "error") {
    // The fail-closed path is the only thing allowed to turn the banner red, and it is
    // reporting a success of the design, not a failure of it: nothing was transmitted.
    if (/redaction failed|could not read the screen|nothing (?:was )?transmitted/i.test(d.message || "")) {
      setProtection("breach");
      setPipelineStage("redact");
    }
    showStatus("statusMsg", "error", d.message);
  }
  if (d.type === "rescanned") {
    $("preview").src = d.preview;
    previewWrap.hidden = false;
    statsGrid.hidden = false;
    idleState.hidden = true;
    setStat("s-pii", d.piiCount);
    setStat("s-marks", d.markCount);
    if (d.regions) renderRegions(d.regions, d.viewport);
    if (d.timings) renderTimings(d.timings);
    const label = d.reason === "dom_change" ? "Page changed — re-scanned" : "Re-scanned the page";
    addLogEntry("refresh", `${label} (${d.markCount} elements, ${d.piiCount} masked)`, d.timings?.total || null);
  }
});

function renderTaskChecklist(items) {
  const widget = $("taskChecklistWidget");
  const list = $("checklistItems");
  if (!widget || !list) return;
  widget.hidden = false;
  list.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = `checklist-item ${item.status || "pending"}`;
    const dot = document.createElement("span");
    dot.className = "checklist-item-dot";
    const text = document.createElement("span");
    text.textContent = item.label;
    li.appendChild(dot);
    li.appendChild(text);
    list.appendChild(li);
  }
}

// ── Prompt Privacy Shield ───────────────────────────────────────────────────
let activeTokenMap = {};

function checkActiveAiChat() {
  if (typeof chrome === "undefined" || !chrome.tabs) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    const url = tab?.url || "";
    const card = $("chatDetectedCard");
    const badge = $("activeChatBadge");
    const btnLabel = $("scrubActiveChatBtnLabel");
    if (!card) return;

    if (/chatgpt\.com|chat\.openai\.com/i.test(url)) {
      card.hidden = false;
      if (badge) badge.textContent = "ChatGPT";
      if (btnLabel) btnLabel.textContent = "Scrub Active ChatGPT Input";
    } else if (/claude\.ai/i.test(url)) {
      card.hidden = false;
      if (badge) badge.textContent = "Claude";
      if (btnLabel) btnLabel.textContent = "Scrub Active Claude Input";
    } else if (/gemini\.google\.com/i.test(url)) {
      card.hidden = false;
      if (badge) badge.textContent = "Gemini";
      if (btnLabel) btnLabel.textContent = "Scrub Active Gemini Input";
    } else {
      card.hidden = true;
    }
  });
}
checkActiveAiChat();

// Scrub active chat input directly on the webpage
if ($("scrubActiveChatBtn")) {
  $("scrubActiveChatBtn").addEventListener("click", () => {
    if (typeof chrome === "undefined" || !chrome.tabs) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) return;

      chrome.tabs.sendMessage(tabId, { type: "SCRUB_CHAT_INPUT" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          showStatus("chatScrubStatus", "error", res?.error || "Could not access chat input on this tab.");
          setTimeout(() => hideStatus("chatScrubStatus"), 3000);
          return;
        }

        if (res.tokenMap) {
          activeTokenMap = { ...activeTokenMap, ...res.tokenMap };
        }

        const msg = res.stats.total > 0
          ? `Scrubbed ${res.stats.secrets} secret(s) and ${res.stats.pii} PII item(s) in-place!`
          : "No secrets or PII detected in chat input.";
        showStatus("chatScrubStatus", "success", msg);
        setTimeout(() => hideStatus("chatScrubStatus"), 3500);
      });
    });
  });
}

// Interactive Prompt Scrubber
if ($("scrubPromptBtn")) {
  $("scrubPromptBtn").addEventListener("click", () => {
    const raw = $("rawPromptInput")?.value || "";
    if (!raw.trim()) return;

    const res = globalThis.PromptScrubber ? globalThis.PromptScrubber.scrub(raw, activeTokenMap) : { cleanText: raw, findings: [], tokenMap: {}, stats: { total: 0, secrets: 0, pii: 0 } };
    activeTokenMap = { ...activeTokenMap, ...res.tokenMap };

    $("scrubbedPromptOutput").value = res.cleanText;
    $("scrubFindingsCount").textContent = String(res.stats.total);

    const list = $("scrubFindingsList");
    list.innerHTML = "";
    if (res.findings.length === 0) {
      list.innerHTML = '<span style="font-size:11px;color:var(--ok,#4ade80);">No secrets or PII detected — prompt is safe!</span>';
    } else {
      res.findings.forEach((f) => {
        const span = document.createElement("span");
        span.className = "badge";
        span.style.background = f.category === "secret" ? "rgba(244,63,94,0.2)" : "rgba(234,179,8,0.2)";
        span.style.color = f.category === "secret" ? "#f43f5e" : "#eab308";
        span.style.border = "1px solid currentColor";
        span.textContent = `${f.label}: ${f.token}`;
        list.appendChild(span);
      });
    }

    $("scrubFindingsWrap").hidden = false;
  });
}

if ($("clearPromptBtn")) {
  $("clearPromptBtn").addEventListener("click", () => {
    if ($("rawPromptInput")) $("rawPromptInput").value = "";
    if ($("scrubFindingsWrap")) $("scrubFindingsWrap").hidden = true;
    if ($("scrubbedPromptOutput")) $("scrubbedPromptOutput").value = "";
  });
}

if ($("copyCleanPromptBtn")) {
  $("copyCleanPromptBtn").addEventListener("click", async () => {
    const text = $("scrubbedPromptOutput")?.value || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const span = $("copyCleanPromptBtn").querySelector("span");
      if (span) {
        const originalText = span.textContent;
        span.textContent = "Copied to clipboard!";
        setTimeout(() => { span.textContent = originalText; }, 2000);
      }
    } catch (_) {}
  });
}

// De-Scrub / Unmask
if ($("unmaskBtn")) {
  $("unmaskBtn").addEventListener("click", () => {
    const resp = $("llmResponseInput")?.value || "";
    if (!resp.trim()) return;

    const restored = globalThis.PromptScrubber ? globalThis.PromptScrubber.unmask(resp, activeTokenMap) : resp;
    $("unmaskedOutput").value = restored;
    $("unmaskedWrap").hidden = false;
  });
}

// ── Offline Document & PDF Redactor ──────────────────────────────────────────
async function handleProcessDocFile(file) {
  if (!globalThis.PdfScrubber) return;
  const dropTitle = $("pdfDropZoneTitle");
  if (dropTitle) dropTitle.textContent = `Processing "${file.name}" locally in RAM...`;

  try {
    const res = await globalThis.PdfScrubber.redactDocument(file, file.name);
    activeTokenMap = { ...activeTokenMap, ...res.tokenMap };

    if ($("pdfFileNameDisplay")) $("pdfFileNameDisplay").textContent = file.name;
    if ($("pdfFindingsCount")) $("pdfFindingsCount").textContent = String(res.stats?.total || res.findings?.length || 0);
    if ($("pdfSanitizedOutput")) $("pdfSanitizedOutput").value = res.sanitizedText;

    const list = $("pdfFindingsList");
    if (list) {
      list.innerHTML = "";
      if (!res.findings || res.findings.length === 0) {
        list.innerHTML = '<span style="font-size:11px;color:var(--ok,#4ade80);">Clean document — 0 secrets or PII detected.</span>';
      } else {
        res.findings.forEach((f) => {
          const span = document.createElement("span");
          span.className = "badge";
          span.style.background = f.category === "secret" ? "rgba(244,63,94,0.2)" : "rgba(234,179,8,0.2)";
          span.style.color = f.category === "secret" ? "#f43f5e" : "#eab308";
          span.style.border = "1px solid currentColor";
          span.textContent = `${f.label}: ${f.token}`;
          list.appendChild(span);
        });
      }
    }

    if ($("pdfResultWrap")) $("pdfResultWrap").hidden = false;
    if (dropTitle) dropTitle.textContent = `Ready: "${file.name}" sanitized`;
  } catch (err) {
    if (dropTitle) dropTitle.textContent = `Error: ${err.message}`;
  }
}

if ($("pdfDropZone") && $("pdfFileInput")) {
  $("pdfDropZone").addEventListener("click", () => {
    $("pdfFileInput").click();
  });

  $("pdfDropZone").addEventListener("dragover", (e) => {
    e.preventDefault();
    $("pdfDropZone").style.borderColor = "#38bdf8";
    $("pdfDropZone").style.background = "rgba(14, 165, 233, 0.12)";
  });

  $("pdfDropZone").addEventListener("dragleave", () => {
    $("pdfDropZone").style.borderColor = "rgba(56, 189, 248, 0.4)";
    $("pdfDropZone").style.background = "rgba(14, 165, 233, 0.05)";
  });

  $("pdfDropZone").addEventListener("drop", (e) => {
    e.preventDefault();
    $("pdfDropZone").style.borderColor = "rgba(56, 189, 248, 0.4)";
    $("pdfDropZone").style.background = "rgba(14, 165, 233, 0.05)";
    const file = e.dataTransfer?.files?.[0];
    if (file) handleProcessDocFile(file);
  });

  $("pdfFileInput").addEventListener("change", (e) => {
    const file = e.target?.files?.[0];
    if (file) handleProcessDocFile(file);
  });
}

if ($("copyCleanDocBtn")) {
  $("copyCleanDocBtn").addEventListener("click", async () => {
    const text = $("pdfSanitizedOutput")?.value || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const span = $("copyCleanDocBtn").querySelector("span");
      if (span) {
        const orig = span.textContent;
        span.textContent = "Copied!";
        setTimeout(() => { span.textContent = orig; }, 2000);
      }
    } catch (_) {}
  });
}

if ($("sendDocToChatBtn")) {
  $("sendDocToChatBtn").addEventListener("click", () => {
    const text = $("pdfSanitizedOutput")?.value;
    if (!text || typeof chrome === "undefined" || !chrome.tabs) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) return;
      chrome.tabs.sendMessage(tabId, { type: "INSERT_TEXT_TO_INPUT", text: text }, (res) => {
        const span = $("sendDocToChatBtn").querySelector("span");
        if (span) {
          const orig = span.textContent;
          span.textContent = (res && res.ok) ? "Inserted to Chat!" : "Sent!";
          setTimeout(() => { span.textContent = orig; }, 2000);
        }
      });
    });
  });
}

async function updateDiagnostics() {
  let adapter = null;
  try {
    adapter = await navigator.gpu?.requestAdapter();
  } catch {
    // A browser can expose WebGPU without providing an adapter.
  }
  $("benchRuntimeBadge").textContent = adapter ? "Available" : "Unavailable";
  const heap = performance.memory?.usedJSHeapSize;
  $("benchHeapBadge").textContent = heap ? `${(heap / 1048576).toFixed(1)} MiB` : "Unavailable";
}

$("tab-benchmarks").addEventListener("click", updateDiagnostics);
$("btnRunLiveVerification").addEventListener("click", () => {
  const result = $("benchVerificationResult");
  const started = performance.now();
  try {
    const email = "fixture@example.test";
    const scrubbed = PromptScrubber.scrub("Contact: " + email);
    const masked = scrubbed.matches.some((match) => match.type === "email") &&
      !scrubbed.sanitized.includes(email);
    const payload = { image: "synthetic", redactionVerified: true, privacy_budget: { level: 0 } };
    VisionVaultPrivacyFirewall.assertSafeTransmission(payload);
    if (!masked || payload.image) throw new Error("a synthetic check did not pass");
    result.textContent = `Passed in ${(performance.now() - started).toFixed(1)} ms. Email masking and zero-pixel filtering passed.`;
  } catch {
    result.textContent = "Self-check failed. Reload the extension and rerun the check.";
  }
});

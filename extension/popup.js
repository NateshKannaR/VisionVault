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
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("active", p.id === "panel-" + btn.dataset.tab);
    });
    if (btn.dataset.tab === "vault" && typeof updateVaultUI === "function") {
      updateVaultUI();
    }
  });
});

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
    $("charCount").textContent = taskEl.value.length;
    taskEl.focus();
  });
});

// ── Toasts ────────────────────────────────────────────────────────────────────
const TOAST_ICON = { info: "info", success: "check", warn: "alert", error: "slash" };

function showStatus(id, type, html) {
  const el = $(id);
  if (!el) return;
  el.className = "toast " + type;
  el.innerHTML = `${icon(TOAST_ICON[type] || "info")}<span>${html}</span>`;
}
function hideStatus(id) {
  const el = $(id);
  if (el) el.className = "toast";
}

// ── Server health ─────────────────────────────────────────────────────────────
async function checkServer() {
  const raw = $("s-serverUrl").value.trim();
  const base = raw.replace(/\/(api\/agent\/step|plan-action)\/?$/, "").replace(/\/+$/, "");
  const dot = $("serverDot");
  const badge = $("backendBadge");
  const info = $("serverInfo");

  try {
    const res = await fetch(base + "/health", { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    dot.className = "status-dot";
    badge.textContent = data.backend || "mock";

    // Show the chain with each tier's model, and say plainly which tiers are currently
    // resting. A hosted provider running out of quota is the normal case, not an emergency —
    // but it explains why planning feels different, so it should be visible rather than felt.
    const cooldowns = data.cooldowns || {};
    const models = data.models || {};
    const chain = (data.chain || []).map((t) => {
      const model = models[t];
      const rest = cooldowns[t];
      const label = model ? `${t} (${model})` : t;
      return rest ? `<s title="${esc(rest.reason)}">${esc(label)}</s>` : `<strong>${esc(label)}</strong>`;
    }).join(" → ") || esc(data.backend || "mock");

    const rested = Object.entries(cooldowns);
    const note = rested.length
      ? `<br><span style="color:var(--text-muted)">Resting: ` +
        rested.map(([t, c]) => `${esc(t)} — ${esc(c.reason)}, retrying in ${Math.ceil(c.retry_in_s / 60)} min`).join("; ") +
        `. The next tier answers meanwhile.</span>`
      : "";
    info.innerHTML = `Connected. Planning chain: ${chain}.${note}`;
  } catch (err) {
    dot.className = "status-dot error";
    badge.textContent = "on-device";
    info.textContent =
      "No planning server reachable. The extension plans on-device instead — detection and " +
      "redaction are unaffected, since both already run locally.";
  }
}
checkServer();
$("checkServer").addEventListener("click", checkServer);

// ── Vault ─────────────────────────────────────────────────────────────────────
const VAULT_KEYS = ["name", "email", "phone", "address", "username", "company", "zip", "password", "about"];
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
  const { vault } = await chrome.storage.local.get("vault");
  const v = vault || {};
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) el.value = v[k] || ""; });
}

function lockVaultNow() {
  isVaultUnlocked = false;
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) el.value = ""; });
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
  const valid = typeof verifyVaultPin === "function" ? await verifyVaultPin(pin) : true;
  if (valid) {
    isVaultUnlocked = true;
    hideStatus("vaultUnlockStatus");
    updateVaultUI();
  } else {
    showStatus("vaultUnlockStatus", "error", "Incorrect PIN");
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
  if (hasPin) {
    const current = $("vaultCurrentPin").value;
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
      await setVaultPin(newPin);
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
  await chrome.storage.local.set({ vault });
  const filled = Object.values(vault).filter(Boolean).length;
  showStatus("vaultStatus", "success", `Saved ${filled} value(s) locally. Nothing was transmitted.`);
  setTimeout(() => hideStatus("vaultStatus"), 3200);
});

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
  if ($("s-plannerMode")) $("s-plannerMode").value = s.plannerMode || "fast";
  $("s-redactMode").value = s.redactMode || "black";
  $("s-confirmPolicy").value = s.confirmPolicy || "risky";
  $("s-serverUrl").value = s.serverUrl || "http://127.0.0.1:8000/api/agent/step";
  const ocrOn = s.enableOCR === true; // Default fast (OCR false) unless explicitly enabled
  const faceOn = s.enableFaceDetection !== false;
  $("s-visionDepth").value = ocrOn ? "full" : (faceOn ? "fast" : "dom");
  $("s-dismissOverlays").checked = s.dismissOverlays !== false;
}
loadSettings();

$("saveSettings").addEventListener("click", async () => {
  const depth = $("s-visionDepth").value;
  const settings = {
    plannerMode: $("s-plannerMode") ? $("s-plannerMode").value : "fast",
    redactMode: $("s-redactMode").value,
    confirmPolicy: $("s-confirmPolicy").value,
    serverUrl: $("s-serverUrl").value.trim(),
    enableOCR: depth === "full",
    enableFaceDetection: depth === "full" || depth === "fast",
    dismissOverlays: $("s-dismissOverlays").checked,
  };
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

const SCAN_LABEL = `${icon("scan")}<span>Run agent</span>`;
const RUN_LABEL = `${icon("play")}<span>Continue — run the agent</span>`;

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
scanBtn.addEventListener("click", () => {
  resetPipeline();
  setProtection("running", "Reading the screen locally");
  setPipelineStage("observe");
  const task = taskEl.value.trim();
  if (!task) {
    showStatus("statusMsg", "warn", "Describe what the agent should do first.");
    taskEl.focus();
    return;
  }

  busy(scanBtn, "Scanning…");
  idleState.hidden = true;
  scanSkeleton.hidden = false;
  runBtn.hidden = true;
  previewWrap.hidden = true;
  statsGrid.hidden = true;
  if ($("scoreCard")) $("scoreCard").hidden = true;
  timingWrap.hidden = true;
  confirmWrap.hidden = true;
  inputPromptWrap.hidden = true;
  logWrap.hidden = true;
  logEntries.innerHTML = "";
  liveStepRow = null;
  actionCount = 0;
  renderedLogCount = 0;
  hideStatus("statusMsg");

  chrome.runtime.sendMessage({ type: "SCAN", task }, (res) => {
    scanBtn.disabled = false;
    scanBtn.innerHTML = SCAN_LABEL;
    scanSkeleton.hidden = true;

    if (!res || !res.ok) {
      idleState.hidden = false;
      showStatus("statusMsg", "error", esc(res?.error || "Scan failed. Open a normal web page and try again."));
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
    const marks = res.result?.markCount || 0;
    if (autoAgentMode() && marks > 0) {
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

/**
 * The privacy scorecard for the scan that just ran.
 *
 * Every figure is a count from this scan. The headline is 100% for a structural reason rather
 * than a measured one, and the note says so: redaction is fail-closed, so a frame carrying an
 * unmasked detection is never transmitted. The alternative to 100% is not a lower percentage,
 * it is a request that did not happen - which is what the blocked state shows instead.
 *
 * Deliberately not a rating out of a hundred invented for a demo. A figure nobody can
 * reproduce is worse than no figure, because it invites trust it has not earned.
 */
function renderScorecard(d) {
  const card = $("scoreCard");
  if (!card) return;
  card.hidden = false;

  const found = d.piiCount || 0;
  const blocked = d.redactionOk === false;

  const badge = $("scoreBadge");
  badge.classList.toggle("is-blocked", blocked);
  badge.textContent = blocked ? "blocked" : "100%";

  $("score-found").textContent = found;
  $("score-masked").textContent = blocked ? "0" : found;
  $("score-sent").textContent = "0";

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
    : '<span class="score-src">nothing sensitive on this screen</span>';

  $("scoreNote").textContent = blocked
    ? "Redaction could not be verified, so nothing was transmitted at all."
    : found > 0
      ? "Masked on this device before anything left it. Redaction is fail-closed: a frame with "
        + "an unmasked detection is not sent, so the alternative to 100% is no request at all."
      : "Nothing sensitive was detected on this screen. The same pipeline still ran.";
}

/** Paints a scan result into the panel. Shared by the Scan button and the run-time recovery. */
function renderScan(d, announce) {
  if (!d) return;
  $("preview").src = d.preview;
  previewWrap.hidden = false;
  statsGrid.hidden = false;
  idleState.hidden = true;

  renderRegions(d.regions, d.viewport);

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
    `<strong>${d.piiCount}</strong> sensitive region${d.piiCount === 1 ? "" : "s"} masked on this device${frameNote}. ` +
    `The image above is exactly what would be sent.`
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
    showStatus("statusMsg", "error", esc(res?.error || "The agent could not run."));
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
    showStatus("statusMsg", "error", esc(r.error));
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
      achieved ? `${achieved} <span style="opacity:.7">(${counts})</span>` : `Finished — ${counts}.`);
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
      showStatus("statusMsg", "error", esc(res?.error || "Could not fill that value."));
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
      showStatus("statusMsg", "error", esc(res?.error || "The modified action failed."));
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
      showStatus("statusMsg", "error", esc(res?.error || "The approved action failed."));
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
  if (!history || !history.length) {
    el.innerHTML = '<p class="hint" style="padding:12px 0">No tasks run yet.</p>';
    return;
  }
  el.innerHTML = history.map((h) => {
    const ago = formatAgo(h.ts);
    const badge = h.ok
      ? `<span style="color:var(--success)">${icon("check")}</span>`
      : `<span style="color:var(--danger)">${icon("alert")}</span>`;
    return `<div class="log-entry" style="cursor:pointer" data-task="${esc(h.task)}">
      <span class="log-icon">${badge}</span>
      <span class="log-msg"><strong>${esc(h.task)}</strong><br>
        <span style="opacity:.65;font-size:.8em">${esc(ago)} · ${h.steps} step${h.steps === 1 ? "" : "s"}${
          h.error ? " · " + esc(h.error.slice(0, 60)) : ""}</span>
      </span>
    </div>`;
  }).join("");
  // Click a history entry to pre-fill the task box
  el.querySelectorAll("[data-task]").forEach((row) => {
    row.addEventListener("click", () => {
      taskEl.value = row.dataset.task;
      $("charCount").textContent = taskEl.value.length;
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
  el.classList.toggle("is-running", state === "running");
  el.classList.toggle("is-breach", state === "breach");
  const title = $("protectTitle");
  const sub = $("protectState");
  if (title) {
    title.textContent = state === "breach" ? "Transmission blocked"
      : state === "running" ? "Protecting this run"
      : "Protection Active";
  }
  if (sub) {
    sub.textContent = detail || (
      state === "breach" ? "Redaction could not be verified — nothing was sent"
      : state === "running" ? "Masking every frame before it leaves"
      : "Your data stays on this device");
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

function stopDictation() {
  if (recognition && recognising) {
    try { recognition.stop(); } catch (_) {}
  }
  setMicLive(false);
}

function startDictation() {
  if (!Recognizer || recognising) return;

  recognition = new Recognizer();
  recognition.lang = navigator.language || "en-IN";
  // Interim results make the box fill as the user speaks, which is what tells them it is
  // working; without it the panel looks frozen for the length of the sentence.
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  dictationBase = (taskEl.value || "").trim();

  recognition.onstart = () => setMicLive(true);

  recognition.onresult = (event) => {
    let text = "";
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
    const joined = (dictationBase ? dictationBase + " " : "") + text.trim();
    // maxlength on the textarea does not apply to programmatic writes, so the cap is applied
    // here or a long dictation would silently exceed what the task field accepts.
    taskEl.value = joined.slice(0, 240);
    const c = $("charCount");
    if (c) c.textContent = taskEl.value.length;
  };

  recognition.onerror = (event) => {
    const err = event.error;
    const message =
      err === "not-allowed" || err === "service-not-allowed"
        ? "Microphone blocked. Allow it for this extension in Chrome's site settings."
        : err === "no-speech"
          ? "Didn't catch anything — try again."
          : err === "network"
            ? "Speech recognition needs a network connection."
            : `Dictation stopped (${err}).`;
    showStatus("statusMsg", err === "no-speech" ? "info" : "warn", esc(message));
    setMicLive(false);
  };

  recognition.onend = () => setMicLive(false);

  try {
    recognition.start();
  } catch (err) {
    setMicLive(false);
    console.warn("[dictation] could not start:", err && err.message);
  }
}

// The button only appears where it can actually do something. A browser with no recogniser
// gets the typed field it already had, rather than a control that fails when pressed.
if (Recognizer && $("micBtn")) {
  $("micBtn").hidden = false;
  $("micBtn").addEventListener("click", () => (recognising ? stopDictation() : startDictation()));
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "m" || e.key === "M")) {
    if (!Recognizer) return;
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
        <p class="audit-caption">The complete request body, as transmitted:</p>
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
  if (msg.type !== "AGENT_UPDATE") return;
  const d = msg.data;

  if (d.type === "step") {
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
    showStatus("statusMsg", "error", esc(d.message));
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

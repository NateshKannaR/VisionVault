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
  $("s-redactMode").value = s.redactMode || "black";
  $("s-confirmPolicy").value = s.confirmPolicy || "risky";
  $("s-serverUrl").value = s.serverUrl || "http://127.0.0.1:8000/api/agent/step";
  const ocrOn = s.enableOCR !== false;
  const faceOn = s.enableFaceDetection !== false;
  $("s-visionDepth").value = ocrOn ? "full" : (faceOn ? "fast" : "dom");
  $("s-dismissOverlays").checked = s.dismissOverlays !== false;
}
loadSettings();

$("saveSettings").addEventListener("click", async () => {
  const depth = $("s-visionDepth").value;
  const settings = {
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

const SCAN_LABEL = `${icon("scan")}<span>Scan &amp; redact screen</span>`;
const RUN_LABEL = `${icon("play")}<span>Run automation</span>`;

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
  });
});

/** Paints a scan result into the panel. Shared by the Scan button and the run-time recovery. */
function renderScan(d, announce) {
  if (!d) return;
  $("preview").src = d.preview;
  previewWrap.hidden = false;
  statsGrid.hidden = false;
  idleState.hidden = true;

  renderRegions(d.regions, d.viewport);

  setStat("s-pii", d.piiCount);
  setStat("s-marks", d.markCount);
  setStat("s-total", (d.timings?.total || 0) + "ms");
  setStat("s-actions", 0);
  renderTimings(d.timings);

  runBtn.hidden = false;
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
    const fieldName = r.fieldLabel && r.fieldLabel !== r.fieldKey
      ? `${esc(r.fieldLabel)} (${esc(r.fieldKey)})`
      : esc(r.fieldKey);
    $("inputPromptText").innerHTML =
      `The page is asking for <strong>${fieldName}</strong>, and your vault has no value for it. ` +
      `Type it once and the agent will carry on — it stays on this machine either way.`;
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

// ── Live updates from the service worker ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "AGENT_UPDATE") return;
  const d = msg.data;

  if (d.type === "step") {
    setLiveStep(`Step ${esc(d.step)} — ${esc(d.status)}`, d.planner);
  }
  if (d.type === "filled") {
    addLogEntry("type", `Filled <strong>${esc(d.field)}</strong> in element #${esc(d.mark_id)}`, null);
  }
  if (d.type === "failed") {
    addLogEntry("alert", `Could not fill <strong>${esc(d.field)}</strong> in element #${esc(d.mark_id)}${d.error ? " — " + esc(d.error) : ""}`, null, true);
  }
  if (d.type === "error") {
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

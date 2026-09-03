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
  });
});

// ── Task box ──────────────────────────────────────────────────────────────────
const taskEl = $("task");
taskEl.addEventListener("input", () => { $("charCount").textContent = taskEl.value.length; });
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
    const chain = (data.chain || []).join(" → ") || data.backend;
    info.innerHTML = `Connected. Planning chain: <strong>${esc(chain)}</strong>.`;
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

async function loadVault() {
  const { vault } = await chrome.storage.local.get("vault");
  const v = vault || {};
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) el.value = v[k] || ""; });
}
loadVault();

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
function setLiveStep(text) {
  if (!liveStepRow) {
    liveStepRow = document.createElement("div");
    liveStepRow.className = "log-entry running";
    logEntries.appendChild(liveStepRow);
    logWrap.hidden = false;
  }
  liveStepRow.innerHTML =
    `<span class="log-icon"><span class="spinner"></span></span><span class="log-msg">${text}</span>`;
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

    const d = res.result;
    $("preview").src = d.preview;
    previewWrap.hidden = false;
    statsGrid.hidden = false;

    renderRegions(d.regions, d.viewport);

    setStat("s-pii", d.piiCount);
    setStat("s-marks", d.markCount);
    setStat("s-total", (d.timings?.total || 0) + "ms");
    setStat("s-actions", 0);
    renderTimings(d.timings);

    runBtn.hidden = false;
    runBtn.innerHTML = RUN_LABEL;

    const fs = d.frameStats || {};
    const frameNote = (fs.total > 1) ? ` across ${fs.merged}/${fs.total} frames` : "";
    showStatus(
      "statusMsg",
      "success",
      `<strong>${d.piiCount}</strong> sensitive region${d.piiCount === 1 ? "" : "s"} masked on this device${frameNote}. ` +
      `The image above is exactly what would be sent.`
    );
  });
});

// ── Run / Stop ────────────────────────────────────────────────────────────────
runBtn.addEventListener("click", () => {
  busy(runBtn, "Running…");
  setRunning(true);
  confirmWrap.hidden = true;
  hideStatus("statusMsg");
  setLiveStep("Planning the first step…");

  chrome.runtime.sendMessage({ type: "RUN" }, (res) => {
    runBtn.disabled = false;
    runBtn.innerHTML = RUN_LABEL;
    setRunning(false);
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", esc(res?.error || "The agent could not run."));
      return;
    }
    handleStepResult(res.result);
  });
});

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
    $("inputPromptText").innerHTML =
      `The agent needs <strong>${esc(r.fieldKey)}</strong> for element #${esc(r.action.mark_id)}, ` +
      `and your vault has no value for it.`;
    const el = $("missingInputValue");
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
    showStatus("statusMsg", failed ? "warn" : "success",
      `Finished — ${ok} action${ok === 1 ? "" : "s"} succeeded${failed ? `, ${failed} failed` : ""}.`);
  } else {
    showStatus("statusMsg", "info", "Nothing to do for this task on this page.");
  }
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

// ── Live updates from the service worker ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "AGENT_UPDATE") return;
  const d = msg.data;

  if (d.type === "step") {
    setLiveStep(`Step ${esc(d.step)} — ${esc(d.status)}`);
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

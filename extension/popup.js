/**
 * popup.js — Side panel controller.
 *
 * Talks to the service worker over chrome.runtime messages and renders what comes back.
 * All iconography is the inline SVG sprite in popup.html; nothing here emits emoji.
 *
 * Three things this panel exists to show, in order of importance:
 *   1. The workflow — what the agent set out to do, and which step it is on right now.
 *   2. The redaction — the exact image that would be sent, with every masked region outlined.
 *   3. The outcome — what was actually achieved, in words, with the results it found.
 *
 * The panel is stateless across openings, so it asks the worker for the current state on load
 * and redraws itself: a run started before the panel was opened is picked up mid-flight.
 */

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === "panel-" + name);
  });
  if (name === "history") loadHistory();
}
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
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
      offerSend(false);
      showStatus("statusMsg", "info", "Instruction changed — press Run task so the agent sees the current page.");
    }
  }
});
taskEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $("runTaskBtn").click(); }
});

function wireChips() {
  document.querySelectorAll(".quick-chip").forEach((chip) => {
    chip.onclick = () => {
      taskEl.value = chip.dataset.template || chip.textContent || "";
      $("charCount").textContent = taskEl.value.length;
      taskEl.focus();
    };
  });
}
wireChips();

// The last few tasks become chips, because the same job tends to come round again.
chrome.runtime.sendMessage({ type: "RECENT_TASKS", limit: 3 }, (res) => {
  if (chrome.runtime.lastError || !res?.tasks?.length) return;
  const row = $("quickChips");
  for (const t of res.tasks) {
    const b = document.createElement("button");
    b.className = "quick-chip chip-recent";
    b.dataset.template = t;
    b.title = t;
    b.innerHTML = `${icon("history")}<span>${esc(t.length > 34 ? t.slice(0, 34) + "…" : t)}</span>`;
    row.appendChild(b);
  }
  wireChips();
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
  const base = raw.replace(/\/(api\/agent\/(step|plan|summary)|plan-action)\/?$/, "").replace(/\/+$/, "");
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

async function loadVault() {
  const { vault } = await chrome.storage.local.get("vault");
  const v = vault || {};
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) el.value = v[k] || ""; });

  // Anything the agent asked for and was told to remember. Shown so it can be seen and edited
  // rather than living invisibly in storage.
  const extras = Object.keys(v).filter((k) => !VAULT_KEYS.includes(k) && v[k]);
  const wrap = $("extraVaultWrap");
  if (!extras.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $("extraVault").innerHTML = extras.map((k) => {
    const secret = /password|passcode|pin|otp|cvv|secret/i.test(k);
    return `<div class="extra-row">
      <label class="extra-key" for="x-${esc(k)}">${esc(k.replace(/_/g, " "))}</label>
      <input class="input" id="x-${esc(k)}" data-extra="${esc(k)}" type="${secret ? "password" : "text"}" value="${esc(v[k])}" />
      <button class="affix-btn extra-del" data-del="${esc(k)}" title="Forget this value" aria-label="Forget ${esc(k)}">${icon("trash")}</button>
    </div>`;
  }).join("");
  document.querySelectorAll(".extra-del").forEach((b) => {
    b.onclick = async () => {
      const { vault: cur } = await chrome.storage.local.get("vault");
      delete (cur || {})[b.dataset.del];
      await chrome.storage.local.set({ vault: cur || {} });
      loadVault();
    };
  });
}
loadVault();

$("saveVault").addEventListener("click", async () => {
  const { vault: existing } = await chrome.storage.local.get("vault");
  const vault = Object.assign({}, existing || {});
  VAULT_KEYS.forEach((k) => { const el = $("v-" + k); if (el) vault[k] = el.value.trim(); });
  document.querySelectorAll("[data-extra]").forEach((el) => { vault[el.dataset.extra] = el.value.trim(); });
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
  $("s-reviewBeforeSend").checked = s.reviewBeforeSend === true;
  $("s-preferences").value = s.preferences || "";
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
    reviewBeforeSend: $("s-reviewBeforeSend").checked,
    preferences: $("s-preferences").value.trim(),
  };
  await chrome.storage.local.set({ settings });
  showStatus("settingsStatus", "success", "Settings saved.");
  setTimeout(() => hideStatus("settingsStatus"), 2600);
  checkServer();
});

$("clearMemoryBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_MEMORY" }, () => {
    showStatus("settingsStatus", "success", "Site memory and history cleared.");
    setTimeout(() => hideStatus("settingsStatus"), 2600);
  });
});

// ── Elements ──────────────────────────────────────────────────────────────────
const runTaskBtn = $("runTaskBtn");
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
const userTurnWrap = $("userTurnWrap");
const planWrap = $("planWrap");
const resultWrap = $("resultWrap");
const nowBar = $("nowBar");
const logWrap = $("logWrap");
const logEntries = $("logEntries");
const overlayEl = $("regionOverlay");

let actionCount = 0;
let renderedLogCount = 0;
let currentMissingField = null;
let currentMissingMarkId = null;
let runStartedAt = null;
let elapsedTimer = null;

const SCAN_LABEL = `${icon("scan")}<span>Preview what is sent</span>`;
const RUN_LABEL = `${icon("play")}<span>Send &amp; run</span>`;
const TASK_LABEL = `${icon("bolt")}<span>Run task</span>`;

/**
 * Exactly one primary button at a time.
 *
 * Once a scan has been reviewed, "Send & run" IS the primary action and "Run task" would only
 * repeat the scan that was just reviewed. Showing both put two full-width filled buttons on top
 * of one another with no way to tell which one the panel wanted.
 */
function offerSend(on) {
  runBtn.hidden = !on;
  runTaskBtn.hidden = on;
  if (on) runBtn.innerHTML = RUN_LABEL;
}

function setStat(id, val) { const el = $(id); if (el) el.textContent = val; }

/** Brings a card the user must act on into view — a gate below the fold is a gate missed. */
function reveal(el) {
  el.hidden = false;
  requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}
function busy(btn, label) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span><span>${label}</span>`; }

function setRunning(on) {
  // Stop takes the primary button's place while a run is in flight, so the panel always shows
  // exactly one thing to press.
  stopBtn.hidden = !on;
  if (on) { runTaskBtn.hidden = true; runBtn.hidden = true; }
  else if (runBtn.hidden) runTaskBtn.hidden = false;
  runBtn.disabled = on;
  scanBtn.disabled = on;
  runTaskBtn.disabled = on;
  if (on) {
    runStartedAt = runStartedAt || Date.now();
    if (!elapsedTimer) elapsedTimer = setInterval(tickElapsed, 1000);
  } else {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    nowBar.hidden = true;
    runTaskBtn.disabled = false;
    runTaskBtn.innerHTML = TASK_LABEL;
  }
}
function tickElapsed() {
  if (!runStartedAt) return;
  const s = Math.round((Date.now() - runStartedAt) / 1000);
  $("nowElapsed").textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Everything a previous run left on screen. Called when a new one starts. */
function resetRunUI({ keepPreview = false } = {}) {
  idleState.hidden = true;
  offerSend(false);
  confirmWrap.hidden = true;
  inputPromptWrap.hidden = true;
  userTurnWrap.hidden = true;
  resultWrap.hidden = true;
  planWrap.hidden = true;
  logWrap.hidden = true;
  logEntries.innerHTML = "";
  if (!keepPreview) {
    previewWrap.hidden = true;
    statsGrid.hidden = true;
    timingWrap.hidden = true;
  }
  actionCount = 0;
  renderedLogCount = 0;
  runStartedAt = null;
  hideStatus("statusMsg");
}

// ── Workflow plan ─────────────────────────────────────────────────────────────
const KIND_ICON = {
  navigate: "globe", search: "target", read: "book", open: "cursor", fill: "type",
  scroll: "arrow-down", act: "bolt", answer: "sparkle", confirm: "shield",
};

function renderPlan(plan) {
  if (!plan || !plan.milestones || !plan.milestones.length) { planWrap.hidden = true; return; }
  const done = plan.milestones.filter((m) => m.status === "done").length;
  $("planMeta").textContent = `${done}/${plan.milestones.length}`;
  $("planSteps").innerHTML = plan.milestones.map((m) => {
    const state = m.status === "done" ? "done" : (m.status === "active" ? "active" : (m.status === "skipped" ? "skipped" : "pending"));
    const mark = state === "done" ? icon("check") : (state === "active" ? '<span class="spinner"></span>' : icon(KIND_ICON[m.kind] || "bolt"));
    return `<li class="step ${state}">
        <span class="step-mark">${mark}</span>
        <span class="step-text">${esc(m.title)}</span>
        <span class="step-kind">${esc(m.kind)}</span>
      </li>`;
  }).join("");
  if (plan.needs && plan.needs.length) {
    $("planNeeds").hidden = false;
    $("planNeeds").innerHTML = `${icon("info")} <span>This may need from you: ${plan.needs.map(esc).join(", ")}.</span>`;
  } else {
    $("planNeeds").hidden = true;
  }
  planWrap.hidden = false;
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

/** The live status line: what the agent is doing this second, who decided it, how sure. */
function setLiveStep(text, tier, confidence) {
  nowBar.hidden = false;
  $("nowText").textContent = text;
  const pill = $("nowPlanner");
  const label = tier ? (TIER_LABELS[tier] !== undefined ? TIER_LABELS[tier] : tier) : "";
  if (label) {
    pill.hidden = false;
    pill.className = `tier-pill tier-${tier}`;
    pill.textContent = label;
  } else {
    pill.hidden = true;
  }
  const conf = $("nowConf");
  if (typeof confidence === "number") {
    conf.hidden = false;
    const pctVal = Math.round(confidence * 100);
    conf.textContent = `${pctVal}%`;
    conf.className = "conf " + (pctVal >= 75 ? "high" : pctVal >= 50 ? "mid" : "low");
  } else {
    conf.hidden = true;
  }
  tickElapsed();
}

// ── Run a task: plan, scan, and go ────────────────────────────────────────────
runTaskBtn.addEventListener("click", async () => {
  const task = taskEl.value.trim();
  if (!task) {
    showStatus("statusMsg", "warn", "Describe what the agent should do first.");
    taskEl.focus();
    return;
  }
  const { settings } = await chrome.storage.local.get("settings");
  // With review enabled the run stops after the scan so the redacted image can be checked
  // before anything is transmitted. Otherwise the two are one press.
  if (settings?.reviewBeforeSend) { scanBtn.click(); return; }

  resetRunUI();
  busy(runTaskBtn, "Planning…");
  setRunning(true);
  scanSkeleton.hidden = false;
  setLiveStep("Reading the page and planning the workflow…");

  chrome.runtime.sendMessage({ type: "SCAN", task }, (res) => {
    scanSkeleton.hidden = true;
    if (!res || !res.ok) {
      setRunning(false);
      idleState.hidden = false;
      showStatus("statusMsg", "error", esc(res?.error || "Could not read this page. Open a normal website and try again."));
      return;
    }
    renderScan(res.result, false);
    setLiveStep("Starting the workflow…");
    startRun(true);
  });
});

// ── Scan only ─────────────────────────────────────────────────────────────────
scanBtn.addEventListener("click", () => {
  const task = taskEl.value.trim();
  if (!task) {
    showStatus("statusMsg", "warn", "Describe what the agent should do first.");
    taskEl.focus();
    return;
  }

  busy(scanBtn, "Scanning…");
  resetRunUI();
  scanSkeleton.hidden = false;

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

/** Paints a scan result into the panel. Shared by both buttons and the run-time recovery. */
function renderScan(d, announce) {
  if (!d) return;
  $("preview").src = d.preview;
  previewWrap.hidden = false;
  statsGrid.hidden = false;
  idleState.hidden = true;

  renderRegions(d.regions, d.viewport);
  renderPlan(d.plan);

  if (d.pageUrl) {
    $("previewPage").hidden = false;
    $("previewPage").textContent = (d.pageTitle ? d.pageTitle + " · " : "") + d.pageUrl;
  }

  setStat("s-pii", d.piiCount);
  setStat("s-marks", d.markCount);
  setStat("s-total", (d.timings?.total || 0) + "ms");
  setStat("s-actions", 0);
  renderTimings(d.timings);

  scannedTask = taskEl.value.trim();

  if (!announce) return;
  // The scan is the privacy review step; Run is what the user is being asked to approve next.
  offerSend(true);
  runBtn.focus();
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
  resultWrap.hidden = true;
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
    const expired = !res?.ok && /run scan first|session expired/i.test(res?.error || "");
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

  if (r.plan) renderPlan(r.plan);

  // phaseRun returns the cumulative log each time it yields; only render what is new.
  (r.actionLog || []).slice(renderedLogCount).forEach(renderLogRow);
  renderedLogCount = (r.actionLog || []).length;

  if (r.needsInput) {
    currentMissingField = r.fieldKey;
    currentMissingMarkId = r.action.mark_id;
    confirmWrap.hidden = true;
    userTurnWrap.hidden = true;
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

  if (r.needsUser) {
    confirmWrap.hidden = true;
    inputPromptWrap.hidden = true;
    reveal(userTurnWrap);
    $("userTurnText").innerHTML = esc(r.needsUser.message);
    showStatus("statusMsg", "warn", r.needsUser.kind === "captcha"
      ? "The site asked for human verification."
      : "This step needs you.");
    return;
  }

  if (r.needsConfirm) {
    inputPromptWrap.hidden = true;
    userTurnWrap.hidden = true;
    $("modifyForm").hidden = true;
    reveal(confirmWrap);
    const label = r.action.label || "";
    $("confirmText").innerHTML =
      `<strong>${esc(String(r.action.action || "click").toUpperCase())}</strong>` +
      (label ? ` on <strong>“${esc(label)}”</strong>` : ` on element #${esc(r.action.mark_id)}`) +
      (r.action.reasoning ? `<br>${esc(r.action.reasoning)}` : "") +
      (r.confirmReason ? `<br><span style="color:var(--text-muted)">Why you are being asked: ${esc(r.confirmReason)}</span>` : "");
    showStatus("statusMsg", "warn", "Approval required before this click is dispatched.");
    return;
  }

  if (r.result) {
    renderResult(r.result);
    return;
  }

  if (r.error) {
    showStatus("statusMsg", "error", esc(r.error));
  }
}

function renderLogRow(a) {
  const failed = a.ok === false;
  const suffix = failed ? ` <span style="opacity:.85">(failed${a.error ? ": " + esc(a.error) : ""})</span>` : "";
  const who = a.label ? `“${esc(a.label)}”` : `element #${esc(a.mark_id)}`;
  if (a.action === "type") {
    addLogEntry(failed ? "alert" : "type", `Filled <strong>${esc(a.field)}</strong> in ${who}${suffix}`, a.serverMs, failed);
  } else if (a.action === "navigate" || a.action === "open_tab") {
    addLogEntry("globe", `Opened <strong>${esc(a.value)}</strong>${suffix}`, a.serverMs, failed);
  } else if (a.action === "scroll") {
    addLogEntry("arrow-down", a.moved === false ? "Reached the bottom of the page" : `Scrolled the page${suffix}`, a.serverMs, failed);
  } else if (a.action === "scroll_to") {
    addLogEntry("target", `Looked for <strong>${esc(a.value)}</strong>${suffix}`, a.serverMs, failed);
  } else if (a.action === "click") {
    addLogEntry(failed ? "alert" : "cursor", `${a.approved ? "Approved and clicked" : "Clicked"} ${who}${suffix}`, a.serverMs, failed);
  } else if (a.action === "read_page") {
    addLogEntry("book", `Read the page — <strong>${esc(a.items || 0)}</strong> item(s) found${suffix}`, a.serverMs, failed);
  } else if (a.action === "answer") {
    addLogEntry("sparkle", `Concluded: <strong>${esc(a.value)}</strong>`, a.serverMs, false);
  } else if (a.action === "milestone") {
    addLogEntry("flag", `Completed <strong>${esc(a.value)}</strong>`, a.serverMs, false);
  } else if (a.action === "select") {
    addLogEntry(failed ? "alert" : "sliders", `Selected <strong>${esc(a.value)}</strong> in ${who}${suffix}`, a.serverMs, failed);
  } else if (a.action === "rejected_by_user") {
    addLogEntry("slash", `You cancelled the click on ${who}`, null, true);
  } else if (a.action === "modified_by_user") {
    addLogEntry("edit", `You redirected the agent: <strong>${esc(a.value)}</strong>`, null, false);
  } else if (a.action === "open_search") {
    addLogEntry(failed ? "alert" : "target", `Opened the site's search box${suffix}`, a.serverMs, failed);
  } else {
    addLogEntry(failed ? "alert" : "check", `${esc(a.action)} on ${who}${suffix}`, a.serverMs, failed);
  }
}

const OUTCOME = {
  success: { icon: "check", cls: "ok", title: "Task complete" },
  partial: { icon: "alert", cls: "warn", title: "Partly done" },
  stopped: { icon: "stop", cls: "warn", title: "Stopped" },
  failed:  { icon: "slash", cls: "bad", title: "Could not complete" },
};

/** The completion screen: what was achieved, what was found, what needs attention. */
function renderResult(res) {
  const meta = OUTCOME[res.outcome] || OUTCOME.partial;
  $("resultHead").className = "result-head " + meta.cls;
  $("resultIcon").innerHTML = icon(meta.icon);
  $("resultTitle").textContent = meta.title;

  const secs = Math.round((res.elapsedMs || 0) / 1000);
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  $("resultStats").textContent =
    `${time} · ${res.actions} action${res.actions === 1 ? "" : "s"}` +
    (res.failedActions ? ` · ${res.failedActions} failed` : "");

  $("resultSummary").textContent = res.summary || "";

  const hi = (res.highlights || []).filter(Boolean);
  $("resultHighlights").innerHTML = hi.map((h) => `<li>${icon("check")}<span>${esc(h)}</span></li>`).join("");
  $("resultHighlights").hidden = !hi.length;

  // The structured results, if the agent read any: a compact table beats a paragraph.
  const items = [];
  for (const f of res.findings || []) for (const it of f.items || []) items.push(it);
  const wrap = $("resultFindings");
  if (items.length) {
    wrap.hidden = false;
    wrap.innerHTML =
      `<div class="findings-head">${icon("list")} <span>What it found (${items.length})</span></div>` +
      `<div class="findings-list">` +
      items.slice(0, 8).map((i) => `
        <div class="finding">
          <span class="f-title">${esc(i.title || "")}</span>
          <span class="f-meta">${i.price ? `<strong>${esc(i.price)}</strong>` : ""}${i.rating ? ` · ${esc(i.rating)}` : ""}</span>
        </div>`).join("") +
      (items.length > 8 ? `<div class="finding more">…and ${items.length - 8} more</div>` : "") +
      `</div>`;
  } else {
    wrap.hidden = true;
  }

  const warnings = (res.warnings || []).filter(Boolean);
  $("resultWarnings").innerHTML = warnings.map((w) => `<li>${icon("alert")}<span>${esc(w)}</span></li>`).join("");
  $("resultWarnings").hidden = !warnings.length;

  hideStatus("statusMsg");
  reveal(resultWrap);
}

$("runAgainBtn").addEventListener("click", () => runTaskBtn.click());
$("newTaskBtn").addEventListener("click", () => {
  resetRunUI();
  idleState.hidden = false;
  taskEl.value = "";
  $("charCount").textContent = "0";
  taskEl.focus();
});
$("copySummaryBtn").addEventListener("click", async (e) => {
  const text = [$("resultSummary").textContent,
    ...Array.from($("resultHighlights").querySelectorAll("li")).map((li) => "• " + li.textContent)].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    const btn = e.currentTarget;
    btn.innerHTML = `${icon("check")}<span>Copied</span>`;
    setTimeout(() => { btn.innerHTML = `${icon("copy")}<span>Copy summary</span>`; }, 1600);
  } catch (_) {
    showStatus("statusMsg", "warn", "Could not reach the clipboard.");
  }
});

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
$("missingInputValue").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("inputPromptSubmit").click(); }
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

// "Modify" is the third option a person actually wants: not this, do that instead.
$("confirmModify").addEventListener("click", () => {
  const form = $("modifyForm");
  if (form.hidden) {
    form.hidden = false;
    $("modifyNote").focus();
    $("confirmModify").textContent = "Send instruction";
    return;
  }
  const note = $("modifyNote").value.trim();
  if (!note) { $("modifyNote").focus(); return; }
  confirmWrap.hidden = true;
  form.hidden = true;
  $("modifyNote").value = "";
  $("confirmModify").textContent = "Modify";
  setRunning(true);
  setLiveStep("Applying your instruction…");
  chrome.runtime.sendMessage({ type: "MODIFY", payload: { note } }, (res) => {
    setRunning(false);
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", esc(res?.error || "Could not apply that."));
      return;
    }
    handleStepResult(res.result);
  });
});

$("confirmNo").addEventListener("click", () => {
  confirmWrap.hidden = true;
  $("modifyForm").hidden = true;
  chrome.runtime.sendMessage({ type: "REJECT" });
  showStatus("statusMsg", "warn", "Action cancelled. The agent stopped there.");
  setRunning(false);
});

// ── Your turn (CAPTCHA, file chooser) ─────────────────────────────────────────
$("continueBtn").addEventListener("click", () => {
  userTurnWrap.hidden = true;
  setRunning(true);
  setLiveStep("Continuing…");
  chrome.runtime.sendMessage({ type: "CONTINUE" }, (res) => {
    setRunning(false);
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", esc(res?.error || "Could not continue."));
      return;
    }
    handleStepResult(res.result);
  });
});
$("userTurnStop").addEventListener("click", () => {
  userTurnWrap.hidden = true;
  chrome.runtime.sendMessage({ type: "STOP" });
  showStatus("statusMsg", "warn", "Stopped. The page is yours.");
  setRunning(false);
});

// ── History ───────────────────────────────────────────────────────────────────
function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function loadHistory() {
  chrome.runtime.sendMessage({ type: "HISTORY", limit: 50 }, (res) => {
    const rows = (res && res.rows) || [];
    $("historyEmpty").hidden = rows.length > 0;
    $("historyList").innerHTML = rows.map((r) => {
      const meta = OUTCOME[r.outcome] || OUTCOME.partial;
      const secs = Math.round((r.elapsedMs || 0) / 1000);
      return `<article class="hist ${meta.cls}">
        <div class="hist-head">
          <span class="hist-icon">${icon(meta.icon)}</span>
          <span class="hist-task">${esc(r.task)}</span>
        </div>
        <div class="hist-meta mono">${esc(r.site || "")} · ${timeAgo(r.finishedAt)} · ${secs}s · ${r.steps} step${r.steps === 1 ? "" : "s"}</div>
        ${r.summary ? `<p class="hist-summary">${esc(r.summary)}</p>` : ""}
        <button class="btn btn-ghost btn-sm hist-run" data-task="${esc(r.task)}">${icon("refresh")}<span>Run again</span></button>
      </article>`;
    }).join("");
    document.querySelectorAll(".hist-run").forEach((b) => {
      b.onclick = () => {
        taskEl.value = b.dataset.task;
        $("charCount").textContent = taskEl.value.length;
        showTab("run");
        taskEl.focus();
      };
    });
  });
}

$("clearHistoryBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" }, () => loadHistory());
});

// ── Live updates from the service worker ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "AGENT_UPDATE") return;
  const d = msg.data;

  if (d.type === "step") {
    setLiveStep(`Step ${d.step} — ${d.status}`, d.planner, d.confidence);
  }
  if (d.type === "milestone") {
    renderPlan(d.plan);
    addLogEntry("flag", `Completed <strong>${esc(d.done)}</strong>${d.reason ? ` — ${esc(d.reason)}` : ""}`, null);
  }
  if (d.type === "recovery") {
    addLogEntry("refresh", esc(d.message), null);
  }
  if (d.type === "read") {
    addLogEntry("book", `Read the page — <strong>${esc(d.items)}</strong> item(s), ${esc(d.tables)} table(s)`, null);
  }
  if (d.type === "answer") {
    if (d.text) addLogEntry("sparkle", `Concluded: <strong>${esc(d.text)}</strong>`, null);
  }
  if (d.type === "newtab") {
    addLogEntry("globe", `The page opened a new tab — following it${d.url ? `: ${esc(d.url)}` : ""}`, null);
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
  if (d.type === "result") {
    renderPlan(d.plan);
    renderResult(d.result);
    setRunning(false);
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
    if (d.pageUrl) {
      $("previewPage").hidden = false;
      $("previewPage").textContent = (d.pageTitle ? d.pageTitle + " · " : "") + d.pageUrl;
    }
    // A re-scan the loop performs itself is routine and would drown the log; only a change the
    // page made on its own is worth a line.
    if (d.reason === "dom_change") {
      addLogEntry("refresh", `Page changed — re-scanned (${d.markCount} elements, ${d.piiCount} masked)`, d.timings?.total || null);
    }
  }
});

// ── Pick up a run that is already in flight ───────────────────────────────────
//
// The panel can be closed and reopened mid-run, and Chrome may tear it down on its own. The
// worker holds the state; this asks for it and redraws, so reopening never looks like the
// agent has stopped.
chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
  if (chrome.runtime.lastError || !res?.ok || !res.state?.active) return;
  const s = res.state;
  taskEl.value = s.task || "";
  $("charCount").textContent = taskEl.value.length;
  idleState.hidden = true;
  if (s.plan) renderPlan(s.plan);
  if (s.preview) {
    $("preview").src = s.preview;
    previewWrap.hidden = false;
  }
  (s.actionLog || []).forEach(renderLogRow);
  renderedLogCount = (s.actionLog || []).length;
  if (s.result) {
    renderResult(s.result);
  } else if (s.running) {
    // The run is still going. Do NOT send RUN again — the worker refuses a second loop, and
    // it already broadcasts every step and the final result, which the listener above renders.
    runStartedAt = s.startedAt || Date.now();
    setRunning(true);
    setLiveStep(`Step ${s.stepCount} — running…`);
  } else {
    // Scanned but not yet run: offer the send button rather than a dead panel.
    offerSend(true);
    scannedTask = s.task || null;
  }
});

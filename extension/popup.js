// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
  });
});

// ── Char counter ──────────────────────────────────────────────────────────────
const taskEl = document.getElementById("task");
taskEl.addEventListener("input", () => {
  document.getElementById("charCount").textContent = taskEl.value.length;
});

// ── Status message helper ─────────────────────────────────────────────────────
function showStatus(id, type, html) {
  const el = document.getElementById(id);
  el.className = "status-msg " + type;
  el.innerHTML = html;
  el.style.display = "block";
}
function hideStatus(id) {
  document.getElementById(id).style.display = "none";
}

// ── Server health check ───────────────────────────────────────────────────────
async function checkServer() {
  const url = document.getElementById("s-serverUrl").value.trim().replace("/plan-action", "");
  const dot = document.getElementById("serverDot");
  const badge = document.getElementById("backendBadge");
  const info = document.getElementById("serverInfo");
  try {
    const res = await fetch(url + "/health", { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    dot.className = "status-dot online";
    const b = data.backend || "mock";
    badge.className = "backend-badge " + b;
    badge.textContent = b;
    info.innerHTML = `✓ Connected &nbsp;·&nbsp; Backend: <b>${b}</b>`;
  } catch {
    dot.className = "status-dot error";
    badge.className = "backend-badge mock";
    badge.textContent = "offline";
    info.textContent = "✗ Server not reachable. Start it with: python main.py";
  }
}
checkServer();
document.getElementById("checkServer").addEventListener("click", checkServer);

// ── Vault ─────────────────────────────────────────────────────────────────────
async function loadVault() {
  const { vault } = await chrome.storage.local.get("vault");
  const v = vault || {};
  ["name","email","phone","address","username","company","zip"].forEach(k => {
    const el = document.getElementById("v-" + k);
    if (el) el.value = v[k] || "";
  });
}

document.getElementById("saveVault").addEventListener("click", async () => {
  const vault = {};
  ["name","email","phone","address","username","company","zip"].forEach(k => {
    const el = document.getElementById("v-" + k);
    if (el) vault[k] = el.value.trim();
  });
  await chrome.storage.local.set({ vault });
  showStatus("vaultStatus", "success", "✓ Vault saved. Data never leaves your browser directly.");
  setTimeout(() => hideStatus("vaultStatus"), 3000);
});
loadVault();

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};
  document.getElementById("s-redactMode").value = s.redactMode || "black";
  document.getElementById("s-serverUrl").value  = s.serverUrl  || "http://localhost:8000/plan-action";
}

document.getElementById("saveSettings").addEventListener("click", async () => {
  const settings = {
    redactMode: document.getElementById("s-redactMode").value,
    serverUrl:  document.getElementById("s-serverUrl").value.trim(),
  };
  await chrome.storage.local.set({ settings });
  showStatus("settingsStatus", "success", "✓ Settings saved.");
  setTimeout(() => hideStatus("settingsStatus"), 2000);
  checkServer();
});
loadSettings();

// ── UI state ──────────────────────────────────────────────────────────────────
const scanBtn    = document.getElementById("scanBtn");
const runBtn     = document.getElementById("runBtn");
const previewWrap = document.getElementById("previewWrap");
const statsGrid  = document.getElementById("statsGrid");
const timingWrap = document.getElementById("timingWrap");
const confirmWrap = document.getElementById("confirmWrap");
const logWrap    = document.getElementById("logWrap");
const logEntries = document.getElementById("logEntries");

let scanData = null;
let actionCount = 0;

function setStat(id, val) { document.getElementById(id).textContent = val; }

function renderTimings(t) {
  if (!t) return;
  const total = t.total || 1;
  const bar = document.getElementById("timingBar");
  bar.innerHTML = [
    { cls: "t-scan",   w: t.scan,       label: "scan",       val: t.scan },
    { cls: "t-shot",   w: t.screenshot, label: "screenshot", val: t.screenshot },
    { cls: "t-redact", w: t.redact,     label: "redact",     val: t.redact },
  ].map(s => `<div class="timing-seg ${s.cls}" style="flex:${s.w || 1}"></div>`).join("");

  document.getElementById("timingLabels").innerHTML = [
    { cls: "t-scan",   label: "scan",       val: t.scan },
    { cls: "t-shot",   label: "screenshot", val: t.screenshot },
    { cls: "t-redact", label: "redact",     val: t.redact },
  ].map(s => `<span class="timing-lbl">${s.label} <span>${s.val}ms</span></span>`).join("");

  timingWrap.style.display = "block";
}

function addLogEntry(icon, text, ms, isError) {
  const div = document.createElement("div");
  div.className = "log-entry" + (isError ? " error" : "");
  div.innerHTML = `<span class="log-icon">${icon}</span><span class="log-text">${text}</span>${ms ? `<span class="log-ms">${ms}ms</span>` : ""}`;
  logEntries.appendChild(div);
  logWrap.style.display = "block";
  actionCount++;
  setStat("s-actions", actionCount);
}

// ── Phase 1: Scan ─────────────────────────────────────────────────────────────
scanBtn.addEventListener("click", () => {
  const task = taskEl.value.trim();
  if (!task) { showStatus("statusMsg", "warn", "⚠ Please enter a task first."); return; }

  scanBtn.disabled = true;
  scanBtn.innerHTML = `<span class="spinner"></span> Scanning…`;
  runBtn.style.display = "none";
  previewWrap.style.display = "none";
  statsGrid.style.display = "none";
  timingWrap.style.display = "none";
  confirmWrap.style.display = "none";
  logEntries.innerHTML = "";
  logWrap.style.display = "none";
  actionCount = 0;
  hideStatus("statusMsg");

  chrome.runtime.sendMessage({ type: "SCAN", task }, (res) => {
    scanBtn.disabled = false;
    scanBtn.innerHTML = `<span>🔍</span> Scan &amp; Redact Page`;

    if (!res || !res.ok) {
      showStatus("statusMsg", "error", "✗ " + (res?.error || "Scan failed. Make sure you're on a regular webpage."));
      return;
    }

    scanData = res.result;
    document.getElementById("preview").src = scanData.preview;
    previewWrap.style.display = "block";

    statsGrid.style.display = "grid";
    setStat("s-pii",     scanData.piiCount);
    setStat("s-marks",   scanData.markCount);
    setStat("s-total",   scanData.timings.total + "ms");
    setStat("s-actions", 0);

    renderTimings(scanData.timings);
    runBtn.style.display = "flex";
    showStatus("statusMsg", "info", "🔒 Preview above is what leaves your device. Nothing sent yet.");
  });
});

// ── Phase 2: Run ──────────────────────────────────────────────────────────────
runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  runBtn.innerHTML = `<span class="spinner"></span> AI is working…`;
  confirmWrap.style.display = "none";
  hideStatus("statusMsg");

  chrome.runtime.sendMessage({ type: "RUN" }, (res) => {
    runBtn.disabled = false;
    runBtn.innerHTML = `<span>⚡</span> Send to AI &amp; Execute`;

    if (!res || !res.ok) {
      showStatus("statusMsg", "error", "✗ " + (res?.error || "Server error. Is the server running?"));
      return;
    }

    const r = res.result;

    // Render action log
    (r.actionLog || []).forEach(a => {
      if (a.action === "type") addLogEntry("✓", `Filled <b>${a.field}</b> → mark #${a.mark_id}`, a.serverMs);
      else if (a.action === "navigate" || a.action === "open_tab") addLogEntry("🌐", `Navigated to ${a.value}`, a.serverMs);
      else if (a.action === "scroll") addLogEntry("⇓", `Scrolled page`, a.serverMs);
      else addLogEntry("⚡", `${a.action} on mark #${a.mark_id}`, a.serverMs);
    });

    if (r.needsConfirm) {
      const act = r.action;
      confirmWrap.style.display = "block";
      document.getElementById("confirmText").innerHTML =
        `Action: <b>${act.action.toUpperCase()}</b> on element #${act.mark_id}<br>
         <span style="color:var(--text3);font-size:11px">${act.reasoning || ""}</span>`;
      showStatus("statusMsg", "warn", "⚠ Review the action above before allowing.");
      return;
    }

    if (r.actionLog?.length) {
      showStatus("statusMsg", "success", `✓ Done! ${r.actionLog.length} field(s) filled.`);
    } else {
      showStatus("statusMsg", "info", "ℹ No fillable fields found. Try a different task or check your vault.");
    }
  });
});

// ── Live agent updates from background ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "AGENT_UPDATE") return;
  const d = msg.data;
  if (d.type === "step") {
    showStatus("statusMsg", "info", `<span class="spinner"></span> Step ${d.step}: ${d.status}`);
  }
  if (d.type === "filled") {
    addLogEntry("✓", `Filled <b>${d.field}</b> → mark #${d.mark_id}`, null);
  }
  if (d.type === "rescanned") {
    document.getElementById("preview").src = d.preview;
    previewWrap.style.display = "block";
    setStat("s-pii", d.piiCount);
    setStat("s-marks", d.markCount);
    addLogEntry("🔄", `Page changed — rescanned (${d.markCount} marks, ${d.piiCount} PII)`, null);
  }
});

// ── Confirm / Reject ──────────────────────────────────────────────────────────
document.getElementById("confirmYes").addEventListener("click", () => {
  confirmWrap.style.display = "none";
  showStatus("statusMsg", "info", `<span class="spinner"></span> Executing and continuing…`);
  runBtn.disabled = true;

  chrome.runtime.sendMessage({ type: "CONFIRM" }, (res) => {
    runBtn.disabled = false;
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", "✗ " + (res?.error || "Execution failed."));
      return;
    }
    const r = res.result;
    (r.actionLog || []).forEach(a => {
      if (a.action === "type") addLogEntry("✓", `Filled <b>${a.field}</b> → mark #${a.mark_id}`, a.serverMs);
      else if (a.action === "navigate" || a.action === "open_tab") addLogEntry("🌐", `Navigated to ${a.value}`, a.serverMs);
      else addLogEntry("⚡", `${a.action} on mark #${a.mark_id}`, a.serverMs);
    });
    if (r.needsConfirm) {
      confirmWrap.style.display = "block";
      document.getElementById("confirmText").innerHTML =
        `Action: <b>${r.action.action.toUpperCase()}</b> on element #${r.action.mark_id}<br>
         <span style="color:var(--text3);font-size:11px">${r.action.reasoning || ""}</span>`;
      showStatus("statusMsg", "warn", "⚠ Review the next action.");
    } else {
      showStatus("statusMsg", "success", `✓ Task complete! ${session_actionCount(r)} actions performed.`);
    }
  });
});

document.getElementById("confirmNo").addEventListener("click", () => {
  confirmWrap.style.display = "none";
  chrome.runtime.sendMessage({ type: "REJECT" });
  showStatus("statusMsg", "warn", "✗ Action rejected. Agent stopped.");
});

function session_actionCount(r) {
  return (r.actionLog || []).length;
}

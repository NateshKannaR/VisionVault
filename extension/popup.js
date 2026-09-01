document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const panel = document.getElementById("panel-" + btn.dataset.tab);
    if (panel) panel.classList.add("active");
  });
});

const taskEl = document.getElementById("task");
taskEl.addEventListener("input", () => {
  document.getElementById("charCount").textContent = taskEl.value.length;
});

document.querySelectorAll(".quick-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const value = chip.dataset.template || "";
    taskEl.value = value;
    document.getElementById("charCount").textContent = value.length;
    taskEl.focus();
  });
});

function showStatus(id, type, html) {
  const el = document.getElementById(id);
  el.className = "status-msg " + type;
  el.innerHTML = html;
  el.style.display = "block";
}

function hideStatus(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}

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
    info.innerHTML = `✓ Connected · Backend: <strong>${b}</strong>`;
  } catch (err) {
    dot.className = "status-dot error";
    badge.className = "backend-badge mock";
    badge.textContent = "offline";
    info.textContent = "✗ Server not reachable. Start it with: python main.py";
  }
}

checkServer();
document.getElementById("checkServer").addEventListener("click", checkServer);

async function loadVault() {
  const { vault } = await chrome.storage.local.get("vault");
  const v = vault || {};
  ["name", "email", "phone", "address", "username", "company", "zip", "password", "about"].forEach((k) => {
    const el = document.getElementById("v-" + k);
    if (el) el.value = v[k] || "";
  });
}

document.getElementById("saveVault").addEventListener("click", async () => {
  const vault = {};
  ["name", "email", "phone", "address", "username", "company", "zip", "password", "about"].forEach((k) => {
    const el = document.getElementById("v-" + k);
    if (el) vault[k] = el.value.trim();
  });

  await chrome.storage.local.set({ vault });
  showStatus("vaultStatus", "success", "✓ Vault saved locally. Real values never leave the browser.");
  setTimeout(() => hideStatus("vaultStatus"), 2600);
});
loadVault();

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};
  document.getElementById("s-redactMode").value = s.redactMode || "black";
  document.getElementById("s-serverUrl").value = s.serverUrl || "http://localhost:8000/plan-action";
}

document.getElementById("saveSettings").addEventListener("click", async () => {
  const settings = {
    redactMode: document.getElementById("s-redactMode").value,
    serverUrl: document.getElementById("s-serverUrl").value.trim(),
  };

  await chrome.storage.local.set({ settings });
  showStatus("settingsStatus", "success", "✓ Settings saved.");
  setTimeout(() => hideStatus("settingsStatus"), 2000);
  checkServer();
});
loadSettings();

const scanBtn = document.getElementById("scanBtn");
const runBtn = document.getElementById("runBtn");
const previewWrap = document.getElementById("previewWrap");
const statsGrid = document.getElementById("statsGrid");
const timingWrap = document.getElementById("timingWrap");
const confirmWrap = document.getElementById("confirmWrap");
const logWrap = document.getElementById("logWrap");
const logEntries = document.getElementById("logEntries");

let scanData = null;
let actionCount = 0;

function setStat(id, val) {
  document.getElementById(id).textContent = val;
}

function renderTimings(t) {
  if (!t) return;
  const bar = document.getElementById("timingBar");
  bar.innerHTML = [
    { cls: "t-scan", value: t.scan || 1 },
    { cls: "t-shot", value: t.screenshot || 1 },
    { cls: "t-redact", value: t.redact || 1 },
  ].map((s) => `<div class="timing-seg ${s.cls}" style="flex:${s.value || 1}"></div>`).join("");

  document.getElementById("timingLabels").innerHTML = [
    { label: "scan", value: t.scan || 0 },
    { label: "screenshot", value: t.screenshot || 0 },
    { label: "redact", value: t.redact || 0 },
  ].map((s) => `<span>${s.label}: <strong>${s.value}ms</strong></span>`).join("");

  timingWrap.style.display = "block";
}

function addLogEntry(icon, text, ms, isError) {
  const div = document.createElement("div");
  div.className = "log-entry" + (isError ? " error" : "");
  div.innerHTML = `<span class="log-icon">${icon}</span><span class="log-text">${text}</span>${ms ? `<span class="log-ms">${ms}ms</span>` : ""}`;
  logEntries.appendChild(div);
  logWrap.style.display = "block";
  actionCount += 1;
  setStat("s-actions", actionCount);
}

scanBtn.addEventListener("click", () => {
  const task = taskEl.value.trim();
  if (!task) {
    showStatus("statusMsg", "warn", "⚠ Please enter a task first.");
    return;
  }

  scanBtn.disabled = true;
  scanBtn.innerHTML = '<span class="spinner"></span> Scanning…';
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
    scanBtn.innerHTML = `<span style="display:inline-flex; align-items:center; justify-content:center; margin-right:8px; vertical-align:middle;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7V5a2 2 0 0 1 2-2h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 3h2a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 17v2a2 2 0 0 1-2 2h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 21H5a2 2 0 0 1-2-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg></span>Scan &amp; redact page`;

    if (!res || !res.ok) {
      showStatus("statusMsg", "error", "✗ " + (res?.error || "Scan failed. Make sure you're on a normal webpage."));
      return;
    }

    scanData = res.result;
    document.getElementById("preview").src = scanData.preview;
    previewWrap.style.display = "block";

    statsGrid.style.display = "grid";
    setStat("s-pii", scanData.piiCount);
    setStat("s-marks", scanData.markCount);
    setStat("s-total", scanData.timings.total + "ms");
    setStat("s-actions", 0);

    renderTimings(scanData.timings);
    runBtn.style.display = "block";
    showStatus("statusMsg", "info", "🔒 The preview above is what leaves the browser. Nothing sensitive is sent yet.");
  });
});

runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  runBtn.innerHTML = '<span class="spinner"></span> Running automation…';
  confirmWrap.style.display = "none";
  hideStatus("statusMsg");

  chrome.runtime.sendMessage({ type: "RUN" }, (res) => {
    runBtn.disabled = false;
    runBtn.innerHTML = `<span style="display:inline-flex; align-items:center; justify-content:center; margin-right:8px; vertical-align:middle;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M10 8.5l5 3.5-5 3.5V8.5Z" fill="currentColor"/></svg></span>Run automation`;

    if (!res || !res.ok) {
      showStatus("statusMsg", "error", "✗ " + (res?.error || "Server error. Is the backend running?"));
      return;
    }

    const r = res.result;
    (r.actionLog || []).forEach((a) => {
      if (a.action === "type") addLogEntry("✓", `Filled <strong>${a.field}</strong> → mark #${a.mark_id}`, a.serverMs);
      else if (a.action === "navigate" || a.action === "open_tab") addLogEntry("🌐", `Opened ${a.value}`, a.serverMs);
      else if (a.action === "scroll") addLogEntry("⇣", "Scrolled the page", a.serverMs);
      else addLogEntry("⚡", `${a.action} on mark #${a.mark_id}`, a.serverMs);
    });

    if (r.needsConfirm) {
      const act = r.action;
      confirmWrap.style.display = "block";
      document.getElementById("confirmText").innerHTML = `Action: <strong>${act.action.toUpperCase()}</strong> on element #${act.mark_id}<br><span style="color: var(--text-muted);">${act.reasoning || ""}</span>`;
      showStatus("statusMsg", "warn", "⚠ Review the planned action before allowing it.");
      return;
    }

    if (r.actionLog && r.actionLog.length) showStatus("statusMsg", "success", `✓ Automation finished with ${r.actionLog.length} actions.`);
    else showStatus("statusMsg", "info", "ℹ No matching action found. Try a clearer task or adjust the page UI.");
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "AGENT_UPDATE") return;
  const d = msg.data;
  if (d.type === "step") {
    showStatus("statusMsg", "info", `<span class="spinner"></span> Step ${d.step}: ${d.status}`);
  }
  if (d.type === "filled") {
    addLogEntry("✓", `Filled <strong>${d.field}</strong> → mark #${d.mark_id}`, null);
  }
  if (d.type === "rescanned") {
    document.getElementById("preview").src = d.preview;
    previewWrap.style.display = "block";
    setStat("s-pii", d.piiCount);
    setStat("s-marks", d.markCount);
    addLogEntry("🔄", `Page changed and was rescanned (${d.markCount} marks, ${d.piiCount} PII)`, null);
  }
});

document.getElementById("confirmYes").addEventListener("click", () => {
  confirmWrap.style.display = "none";
  showStatus("statusMsg", "info", '<span class="spinner"></span> Executing action…');
  runBtn.disabled = true;

  chrome.runtime.sendMessage({ type: "CONFIRM" }, (res) => {
    runBtn.disabled = false;
    if (!res || !res.ok) {
      showStatus("statusMsg", "error", "✗ " + (res?.error || "Execution failed."));
      return;
    }

    const r = res.result;
    (r.actionLog || []).forEach((a) => {
      if (a.action === "type") addLogEntry("✓", `Filled <strong>${a.field}</strong> → mark #${a.mark_id}`, a.serverMs);
      else if (a.action === "navigate" || a.action === "open_tab") addLogEntry("🌐", `Opened ${a.value}`, a.serverMs);
      else addLogEntry("⚡", `${a.action} on mark #${a.mark_id}`, a.serverMs);
    });

    if (r.actionLog && r.actionLog.length) showStatus("statusMsg", "success", "✓ Approved action executed.");
    else showStatus("statusMsg", "info", "ℹ The execution completed without more steps.");
  });
});

document.getElementById("confirmNo").addEventListener("click", () => {
  confirmWrap.style.display = "none";
  chrome.runtime.sendMessage({ type: "REJECT" });
  showStatus("statusMsg", "warn", "⚠ Action rejected. You can ask the agent for a different path.");
});

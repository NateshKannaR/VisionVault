// background.js — Autonomous multi-page agent

const DEFAULT_SERVER_URL = "http://localhost:8000/plan-action";

// ── Open side panel on icon click ─────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

const VAULT_KEY_MAP = {
  email: "email", phone: "phone", name: "name", address: "address",
  username: "username", fullname: "name", mobile: "phone",
  company: "company", zip: "address", postal: "address",
};

// Actions that cause navigation — agent must wait and re-scan after these
const NAV_ACTIONS = new Set(["navigate", "click"]);

let session = null;

// ── Notify popup of live status updates ──────────────────────────────────────
function notifyPopup(data) {
  chrome.runtime.sendMessage({ type: "AGENT_UPDATE", data }).catch(() => {});
}

// ── Safe base64 ───────────────────────────────────────────────────────────────
function uint8ToBase64(bytes) {
  let b64 = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk)
    b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(b64);
}

// ── Screenshot ────────────────────────────────────────────────────────────────
function captureScreenshot(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

// ── Redact ────────────────────────────────────────────────────────────────────
async function redactImage(dataUrl, regions, vpW, vpH, mode) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const sx = bitmap.width / (vpW || bitmap.width);
  const sy = bitmap.height / (vpH || bitmap.height);
  for (const r of regions) {
    const rx = r.x * sx, ry = r.y * sy, rw = r.w * sx, rh = r.h * sy;
    if (mode === "blur") {
      const step = 12;
      for (let bx = rx; bx < rx + rw; bx += step)
        for (let by = ry; by < ry + rh; by += step) {
          const px = ctx.getImageData(Math.min(bx + 6, bitmap.width - 1), Math.min(by + 6, bitmap.height - 1), 1, 1).data;
          ctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
          ctx.fillRect(bx, by, step, step);
        }
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(rx, ry, rw, rh);
    }
  }
  const buf = await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
  return "data:image/png;base64," + uint8ToBase64(new Uint8Array(buf));
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function getVault() {
  const { vault } = await chrome.storage.local.get("vault");
  return vault || {};
}
async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({ redactMode: "black", serverUrl: DEFAULT_SERVER_URL }, settings || {});
}

// ── Tab helpers ───────────────────────────────────────────────────────────────
async function ensureContent(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); } catch (_) {}
  await new Promise(r => setTimeout(r, 300));
}

function msgTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(r || null);
    });
  });
}

// Wait for a tab to finish loading after navigation
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 2500); // extra wait for JS to render
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Open a new tab and wait for it to load
async function openTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: true }, async (tab) => {
      await waitForTabLoad(tab.id);
      resolve(tab.id);
    });
  });
}

// ── Scan a tab and return redacted image + safe marks ─────────────────────────
async function scanTab(tabId, windowId, settings) {
  await ensureContent(tabId);
  await new Promise(r => setTimeout(r, 800)); // let content.js settle

  const tab = await new Promise(r => chrome.tabs.get(tabId, r));
  const scan = await msgTab(tabId, { type: "SCAN_PAGE" }) || { piiRegions: [], marks: [] };
  const raw = await captureScreenshot(windowId || tab.windowId);
  const redacted = await redactImage(raw, scan.piiRegions, tab.width, tab.height, settings.redactMode);
  const safeMarks = (scan.marks || []).map(m => ({ id: m.id, role: m.role, box: m.box, label: m.label }));
  const pageInfo = await msgTab(tabId, { type: "GET_PAGE_INFO" }) || {};

  return { redacted, safeMarks, piiCount: scan.piiRegions.length, pageInfo, tab };
}

// ── Server call ───────────────────────────────────────────────────────────────
async function callServer(payload, serverUrl) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("Server " + res.status);
    return res.json();
  } finally {
    clearTimeout(tid);
  }
}

// ── PHASE 1: Initial scan (just preview, nothing sent) ────────────────────────
async function phaseScan(task) {
  const t0 = performance.now();
  const settings = await getSettings();
  // Find the active tab that is NOT the extension side panel / popup
  const allTabs = await chrome.tabs.query({ active: true });
  const tab = allTabs.find(t => !t.url?.startsWith("chrome-extension://")) ||
               (await chrome.tabs.query({}))
                 .filter(t => !t.url?.startsWith("chrome-extension://") && !t.url?.startsWith("chrome://"))
                 .sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
  if (!tab) throw new Error("No active tab.");

  const { redacted, safeMarks, piiCount, pageInfo } = await scanTab(tab.id, tab.windowId, settings);

  session = {
    task,
    tabId: tab.id,
    windowId: tab.windowId,
    redacted,
    marks: safeMarks,
    pageInfo,
    filledIds: [],
    actionLog: [],
    lastAction: null,
    lastNavUrl: null,
    serverUrl: settings.serverUrl,
    settings,
    stepCount: 0,
  };

  return {
    preview: redacted,
    piiCount,
    markCount: safeMarks.length,
    timings: { total: Math.round(performance.now() - t0) },
  };
}

// ── PHASE 2: Autonomous agent loop ────────────────────────────────────────────
async function phaseRun() {
  if (!session) throw new Error("Run Scan first.");
  const MAX_STEPS = 30;

  while (session.stepCount < MAX_STEPS) {
    session.stepCount++;
    notifyPopup({ type: "step", step: session.stepCount, status: "Asking AI..." });

    const t0 = performance.now();
    const resp = await callServer({
      task: session.task,
      image: session.redacted,
      marks: session.marks,
      filled_mark_ids: session.filledIds,
      page_info: session.pageInfo || {},
      step: session.stepCount,
    }, session.serverUrl);
    const serverMs = Math.round(performance.now() - t0);

    session.lastAction = resp;
    notifyPopup({ type: "step", step: session.stepCount, status: resp.action + ": " + (resp.reasoning || "") });

    // ── Done ──
    if (!resp.action || resp.action === "none") {
      return { done: true, needsConfirm: false, actionLog: session.actionLog };
    }

    // ── Navigate to URL ──
    if (resp.action === "navigate" && resp.value) {
      // Prevent navigating to the same URL twice in a row
      if (resp.value === session.lastNavUrl) {
        return { done: true, needsConfirm: false, actionLog: session.actionLog };
      }
      session.lastNavUrl = resp.value;
      notifyPopup({ type: "step", step: session.stepCount, status: "Navigating to " + resp.value });
      session.actionLog.push({ action: "navigate", value: resp.value, serverMs });
      chrome.tabs.update(session.tabId, { url: resp.value });
      await waitForTabLoad(session.tabId);
      await rescanCurrentTab(true);
      continue;
    }

    // ── Open new tab ──
    if (resp.action === "open_tab" && resp.value) {
      notifyPopup({ type: "step", step: session.stepCount, status: "Opening " + resp.value });
      session.actionLog.push({ action: "open_tab", value: resp.value, serverMs });
      const newTabId = await openTab(resp.value);
      session.tabId = newTabId;
      const newTab = await new Promise(r => chrome.tabs.get(newTabId, r));
      session.windowId = newTab.windowId;
      await rescanCurrentTab(true); // new tab — reset filled IDs
      continue;
    }

    // ── Type ──
    if (resp.action === "type") {
      let value = resp.value || null;
      if (!value && resp.use_vault_field) {
        const vault = await getVault();
        const key = VAULT_KEY_MAP[resp.use_vault_field];
        value = (key && vault[key]) ? vault[key] : "";
      }
      await ensureContent(session.tabId);
      const exec = await msgTab(session.tabId, {
        type: "EXECUTE_ACTION",
        payload: { action: "type", mark_id: resp.mark_id, value },
      });
      session.filledIds.push(resp.mark_id);
      session.actionLog.push({
        action: "type", field: resp.use_vault_field || resp.value || "?",
        mark_id: resp.mark_id, serverMs, ok: exec?.ok,
      });
      notifyPopup({ type: "filled", field: resp.use_vault_field || resp.value, mark_id: resp.mark_id });
      continue;
    }

    // ── press_key ──
    if (resp.action === "press_key") {
      await ensureContent(session.tabId);
      await msgTab(session.tabId, {
        type: "EXECUTE_ACTION",
        payload: { action: "press_key", mark_id: resp.mark_id, value: resp.value || "Enter" },
      });
      session.actionLog.push({ action: "press_key", value: resp.value, mark_id: resp.mark_id, serverMs });
      // Search submitted — wait for results page, then stop the loop
      await waitForTabLoad(session.tabId, 8000);
      await rescanCurrentTab(false); // don't reset filledIds
      return { done: true, needsConfirm: false, actionLog: session.actionLog };
    }

    // ── Select dropdown ──
    if (resp.action === "select") {
      await ensureContent(session.tabId);
      await msgTab(session.tabId, {
        type: "EXECUTE_ACTION",
        payload: { action: "select", mark_id: resp.mark_id, value: resp.value },
      });
      session.filledIds.push(resp.mark_id);
      session.actionLog.push({ action: "select", value: resp.value, mark_id: resp.mark_id, serverMs });
      continue;
    }

    // ── Scroll ──
    if (resp.action === "scroll_page") {
      await ensureContent(session.tabId);
      await msgTab(session.tabId, {
        type: "EXECUTE_ACTION",
        payload: { action: "scroll_page", mark_id: resp.mark_id, value: resp.value || 400 },
      });
      session.actionLog.push({ action: "scroll", serverMs });
      // Re-scan after scroll — new elements may be visible
      await new Promise(r => setTimeout(r, 600));
      await rescanCurrentTab(false); // same page scroll — keep filled IDs
      continue;
    }

    // ── Click — needs confirmation ──
    if (resp.action === "click") {
      return {
        done: false,
        needsConfirm: true,
        action: resp,
        actionLog: session.actionLog,
      };
    }

    // ── Any other action — execute directly ──
    await ensureContent(session.tabId);
    await msgTab(session.tabId, {
      type: "EXECUTE_ACTION",
      payload: { action: resp.action, mark_id: resp.mark_id, value: resp.value },
    });
    session.actionLog.push({ action: resp.action, mark_id: resp.mark_id, serverMs });
  }

  return { done: true, needsConfirm: false, actionLog: session.actionLog };
}

// ── Re-scan current tab and update session ────────────────────────────────────
async function rescanCurrentTab(resetFilled = false) {
  try {
    const { redacted, safeMarks, piiCount, pageInfo } = await scanTab(
      session.tabId, session.windowId, session.settings
    );
    session.redacted = redacted;
    session.marks = safeMarks;
    if (resetFilled) session.filledIds = []; // only reset on real page navigation
    session.pageInfo = pageInfo;
    notifyPopup({ type: "rescanned", piiCount, markCount: safeMarks.length, preview: redacted });
  } catch (e) {
    console.warn("[agent] rescan failed:", e);
  }
}

// ── Confirmed click — execute then continue loop ──────────────────────────────
async function phaseConfirm() {
  if (!session?.lastAction) throw new Error("No pending action.");
  const { action, mark_id, value } = session.lastAction;

  await ensureContent(session.tabId);
  const exec = await msgTab(session.tabId, {
    type: "EXECUTE_ACTION",
    payload: { action, mark_id, value },
  });
  session.actionLog.push({ action, mark_id, ok: exec?.ok });

  // After a click, wait for possible navigation then re-scan and continue
  notifyPopup({ type: "step", step: session.stepCount, status: "Click executed, waiting for page..." });
  await waitForTabLoad(session.tabId, 5000);
  await rescanCurrentTab(true); // click may have navigated

  // Continue the agent loop automatically after confirmed click
  return phaseRun();
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SCAN") {
    phaseScan(msg.task)
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "RUN") {
    phaseRun()
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CONFIRM") {
    phaseConfirm()
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "REJECT") {
    if (session) session.lastAction = null;
    sendResponse({ ok: true });
    return true;
  }
});

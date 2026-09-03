// background.js — Autonomous multi-page agent (MV3 service worker)
//
// Owns the agent loop: scan -> plan (server) -> execute (content frames) -> re-scan.
//
// Privacy invariants enforced here:
//   • The service worker never handles a raw screenshot. Capture + redaction happen together
//     inside detection-orchestrator.js, which fails closed; only a redacted image is returned.
//   • callServer() refuses to transmit unless the payload carries a verified redacted image.
//   • Vault values are resolved locally and substituted into the page; the server only ever
//     receives the symbolic field name (e.g. "use_vault_field": "email").

const DEFAULT_SERVER_URL = "http://127.0.0.1:8000/api/agent/step";

// vault.js       -> local credential resolution (no DOM needed)
// detection-orchestrator.js -> capture + local ML + fail-closed redaction
// NOTE: action-executor.js is deliberately NOT imported here. It is a content script
// (see manifest.json) because it needs a DOM; the service worker has none.
importScripts("./vault.js", "./task-planner.js", "./detection-orchestrator.js");

// Pre-initialize offscreen document for local ML vision models
(async () => {
  try {
    if (typeof ensureOffscreenDocument === "function") {
      await ensureOffscreenDocument();
      console.log("[vision] Offscreen ML host prepared.");
    }
  } catch (error) {
    console.warn("[vision] Offscreen ML host startup notice:", error);
  }
})();

// ── Configure side panel behavior ─────────────────────────────────────────────
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.action.onClicked?.addListener(async (tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      const windowId = tab?.windowId || (await chrome.windows.getCurrent()).id;
      await chrome.sidePanel.open({ windowId });
    } catch (e) {
      console.warn("[action] SidePanel open:", e);
    }
  }
});

const VAULT_KEY_MAP = {
  email: "email", phone: "phone", name: "name", address: "address",
  username: "username", fullname: "name", mobile: "phone",
  company: "company", zip: "address", postal: "address",
  about: "about", bio: "about", description: "about",
  password: "password", passwd: "password", pass: "password",
};

// Actions that can navigate the page or replace the DOM wholesale. After one of these the
// agent must wait for the load to settle and re-scan before planning the next step, otherwise
// it would plan against stale marks.
const NAV_ACTIONS = new Set(["navigate", "open_tab", "click", "press_key"]);

// ── Human-in-the-loop click policy ────────────────────────────────────────────
//
// POLICY (default, settings.confirmPolicy === "risky"): risk-based gating.
//   A click is executed autonomously UNLESS its target looks consequential — i.e. it is
//   irreversible, financial, destructive, or submits/authenticates data. Those clicks stop the
//   loop and require explicit user approval in the side panel before anything is dispatched.
//   Risk is assessed against the target mark's own label and role, plus the server's stated
//   reasoning, using RISKY_CLICK_RE below.
//
// POLICY (settings.confirmPolicy === "all"): every single click requires approval. Slower and
//   fully manual; useful for demos and for untrusted pages.
//
// Non-click actions (type/select/scroll/press_key) are never gated: typing is reversible, and
// vault values are substituted locally so nothing sensitive is exposed by them.
const RISKY_CLICK_RE = new RegExp([
  // submit / commit
  "submit", "send", "post\\b", "publish", "save", "apply\\b", "confirm", "continue to pay",
  "proceed", "finish", "complete order", "place\\s*order", "book\\s*now", "reserve",
  // money
  "pay\\b", "payment", "checkout", "check\\s*out", "buy\\b", "purchase", "order\\s*now",
  "add to cart", "subscribe", "donate", "transfer", "withdraw", "deposit", "top\\s*up",
  "upgrade", "renew", "billing", "invoice", "wallet", "upi", "netbanking", "credit card",
  // destructive
  "delete", "remove", "erase", "wipe", "destroy", "discard", "clear all", "reset",
  "deactivate", "disable", "cancel subscription", "close account", "unsubscribe",
  "revoke", "block\\b", "report\\b", "ban\\b", "archive",
  // identity / auth / consent
  "sign\\s*up", "signup", "register", "create account", "log\\s*in", "login", "sign\\s*in",
  "signin", "authorize", "authorise", "allow\\b", "grant", "accept", "agree", "consent",
  "verify", "otp", "two-factor", "change password", "reset password",
  // sharing / exfiltration
  "share", "invite", "export", "download all", "make public", "grant access"
].join("|"), "i");

let session = null;

// Set by the side panel's Stop control. The loop checks it before every step, so a run can be
// halted immediately rather than only after MAX_STEPS.
let stopRequested = false;

// The AbortController of the planning request currently in flight, so Stop can cut a slow
// cloud call short. Without this, pressing Stop only takes effect once the request returns,
// which on a loaded hosted model can be tens of seconds later.
let inFlightPlanRequest = null;

// True while phaseRun()/phaseConfirm() is driving the page. Used to suppress DOM_CHANGED
// re-scans, which would otherwise race the loop's own re-scans.
let agentBusy = false;

// ── Notify popup of live status updates ──────────────────────────────────────
function notifyPopup(data) {
  chrome.runtime.sendMessage({ type: "AGENT_UPDATE", data }).catch(() => {});
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function getVault() {
  const { vault } = await chrome.storage.local.get("vault");
  return vault || {};
}
async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign(
    {
      redactMode: "black",
      serverUrl: DEFAULT_SERVER_URL,
      confirmPolicy: "risky",
      // Latency / coverage trade-off, surfaced in the side panel.
      //   enableOCR       ~1.4s per scan; the only thing that reads text baked into images,
      //                   canvases and other non-DOM pixels. On by default.
      //   enableFaceDetection ~35ms per scan. Cheap; on by default.
      // With OCR off, a scan costs roughly 130ms and falls back to DOM + face coverage.
      enableOCR: true,
      enableFaceDetection: true,
    },
    settings || {}
  );
}

// ── Tab helpers ───────────────────────────────────────────────────────────────
async function ensureContent(tabId) {
  try {
    // allFrames: content.js + action-executor.js must exist in every frame we may scan or act on.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["action-executor.js", "content.js"],
    });
  } catch (_) {}
  await new Promise(r => setTimeout(r, 250));
}

function msgTab(tabId, msg, options) {
  return new Promise((resolve) => {
    const cb = (r) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(r || null);
    };
    if (options) chrome.tabs.sendMessage(tabId, msg, options, cb);
    else chrome.tabs.sendMessage(tabId, msg, cb);
  });
}

/**
 * Executes one action against a mark, in the frame that mark actually lives in.
 *
 * Marks are aggregated across frames, so a bare tabs.sendMessage would broadcast to every
 * frame and return whichever reply arrived first. We route by frameId instead, and fall back
 * to a broadcast only when the frame is unknown.
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function executeMarkAction(action, mark_id, value) {
  if (!session) return { ok: false, error: "No active session." };
  await ensureContent(session.tabId);

  const payload = { action, mark_id, value };
  const frameId = mark_id != null ? session.markFrames?.[mark_id] : undefined;

  if (frameId !== undefined) {
    const res = await msgTab(session.tabId, { type: "EXECUTE_ACTION", payload }, { frameId });
    if (res) return res;
  }

  const res = await msgTab(session.tabId, { type: "EXECUTE_ACTION", payload });
  return res || { ok: false, error: "No frame responded to the action." };
}

// Wait for a tab to finish loading after navigation
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise(async (resolve) => {
    let tab = null;
    try {
      tab = await new Promise(r => chrome.tabs.get(tabId, r));
    } catch (e) {}

    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000); // extra wait for JS to render
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // If tab is already in complete status, wait briefly for JS hydration and resolve
    if (tab && tab.status === "complete") {
      setTimeout(() => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 1200);
    }
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
//
// Returns redactionOk:false when redaction could not be completed. Callers MUST NOT transmit
// anything in that case — there is no image to transmit, by construction.
async function scanTab(tabId, windowId, settings, retries = 2) {
  let last = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await ensureContent(tabId);
    await new Promise(r => setTimeout(r, attempt === 1 ? 400 : 1200));

    const tab = await new Promise(r => chrome.tabs.get(tabId, r));
    const pageInfo = await msgTab(tabId, { type: "GET_PAGE_INFO" }, { frameId: 0 }) || {};

    const result = await scanAndRedact(tabId, windowId || tab.windowId, {
      redactMode: settings.redactMode || "black",
      viewportWidth: pageInfo.viewport_width || tab.width,
      viewportHeight: pageInfo.viewport_height || tab.height,
      devicePixelRatio: pageInfo.device_pixel_ratio || 1,
      enableOCR: settings.enableOCR !== false,
      enableFaceDetection: settings.enableFaceDetection !== false,
    });

    // Marks sent to the server carry NO frame routing and NO raw page text beyond a safe label.
    const safeMarks = (result.marks || []).map(m => ({ id: m.id, role: m.role, box: m.box, label: m.label }));

    // Geometry + provenance for the panel's redaction overlay. Deliberately drops `text`,
    // which holds the matched PII string.
    const previewRegions = (result.regions || []).map(r => {
      // A merged region can have several contributing detectors; carry all of them so the
      // panel's legend credits each one rather than only whichever happened to be first.
      const sources = Array.isArray(r.sources) && r.sources.length
        ? r.sources
        : String(r.source || "dom").split(",").map(x => x.trim()).filter(Boolean);
      return {
        x: r.x, y: r.y, w: r.w, h: r.h,
        source: sources[0] || "dom",
        sources,
        reason: r.reason || "pii_detection",
        label: r.label || null,
      };
    });
    const markFrames = {};
    for (const m of result.marks || []) markFrames[m.id] = m.frameId ?? 0;

    last = {
      redacted: result.redactedImage,
      previewRegions,
      redactionOk: result.redactionOk !== false,
      redactionError: result.redactionError || null,
      safeMarks,
      markFrames,
      piiCount: result.sourceBreakdown?.merged ?? result.regions?.length ?? 0,
      sourceBreakdown: result.sourceBreakdown || {},
      frameStats: result.frameStats || { total: 0, merged: 0, skipped: 0 },
      pageInfo,
      tab,
      regions: result.regions || [],
      timings: result.timings || {},
    };

    // A page that is still hydrating yields no marks; retry once before giving up.
    if (safeMarks.length > 0 || !last.redactionOk || attempt >= retries) return last;
  }

  return last || {
    redacted: "", redactionOk: false, redactionError: "Scan produced no result.",
    safeMarks: [], markFrames: {}, piiCount: 0, sourceBreakdown: {},
    frameStats: { total: 0, merged: 0, skipped: 0 }, pageInfo: {}, tab: null, regions: [], timings: {}
  };
}

// ── Server call ───────────────────────────────────────────────────────────────
async function callServer(payload, serverUrl) {
  // HARD PRIVACY GATE. The only image this function will ever send is one the redaction
  // pipeline confirmed it produced. If redaction failed there is no image and no request.
  if (!payload.redactionVerified) {
    throw new Error("Refusing to contact server: redaction was not verified for this frame.");
  }

  const ctrl = new AbortController();
  inFlightPlanRequest = ctrl;
  const tid = setTimeout(() => ctrl.abort(), 30000);
  try {
    const targetUrl = serverUrl.includes("/plan-action") || serverUrl.includes("/api/agent/step")
      ? serverUrl
      : serverUrl.replace(/\/+$/, "") + "/api/agent/step";

    const bodyData = {
      task: payload.task,
      // Locally-parsed instruction. Derived from the user's own words, which the server
      // already receives as `task`, so this reveals nothing new — it just saves the model
      // from having to re-derive the search string, which it frequently gets wrong.
      task_hints: payload.task_hints || null,
      redactedImage: payload.image || "",
      image: payload.image || "",
      marks: payload.marks || [],
      filled_mark_ids: payload.filled_mark_ids || [],
      step: payload.step || 1,
      page_info: payload.page_info || {}
    };

    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyData),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("Server " + res.status);
    const raw = await res.json();

    // Normalize StepResponse { reasoning, action: { type, target, value, use_vault_field } }
    if (raw.action && typeof raw.action === "object") {
      return {
        action: raw.action.type || "done",
        mark_id: raw.action.target,
        value: raw.action.value,
        use_vault_field: raw.action.use_vault_field,
        reasoning: raw.reasoning || raw.action.reasoning || ""
      };
    }
    return raw;
  } finally {
    clearTimeout(tid);
    if (inFlightPlanRequest === ctrl) inFlightPlanRequest = null;
  }
}

/**
 * On-device planning fallback, used whenever the server is unreachable or errors.
 *
 * Delegates to TaskPlanner, which parses the instruction properly and stops once the
 * instruction has been carried out. The previous inline version typed the whole sentence into
 * search boxes ("iqoo neo 6 and show me") and then clicked any link containing a task word,
 * which made it wander a results page until it hit the step limit.
 */
function localMockPlan(sess) {
  return TaskPlanner.planNextAction({
    task: sess.task,
    parsed: sess.parsedTask,
    marks: sess.marks,
    filledIds: sess.filledIds,
    pageInfo: sess.pageInfo,
    progress: sess.progress,
  });
}

/**
 * Decides whether a click needs explicit human approval, per the policy documented above.
 * @returns {{ needsConfirm: boolean, reason: string }}
 */
function assessClickRisk(resp, sess) {
  const policy = sess?.settings?.confirmPolicy || "risky";
  if (policy === "all") {
    return { needsConfirm: true, reason: "Confirmation policy is set to 'all clicks'." };
  }

  const mark = (sess?.marks || []).find(m => String(m.id) === String(resp.mark_id));
  const label = (mark?.label || resp.label || "").toString();
  const role = (mark?.role || "").toString();
  const reasoning = (resp.reasoning || "").toString();

  if (label && RISKY_CLICK_RE.test(label)) {
    return { needsConfirm: true, reason: `Target labelled "${label}" matches the high-risk action list.` };
  }
  if (RISKY_CLICK_RE.test(reasoning)) {
    return { needsConfirm: true, reason: "The planner described this step as a high-risk action." };
  }
  // Unknown risk is treated as risk. A control with no readable label at all — an icon-only
  // button, a bare <input type="submit"> — cannot be assessed, and unlabelled controls are
  // exactly where destructive actions hide. Links are exempt: navigation is reversible, and
  // gating every unlabelled link would stop the agent browsing anything.
  if (!label && role !== "link") {
    return { needsConfirm: true, reason: "Target has no readable label, so its effect cannot be assessed." };
  }
  return { needsConfirm: false, reason: "" };
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

  const scan = await scanTab(tab.id, tab.windowId, settings);

  // FAIL CLOSED: abort the whole request rather than showing/sending anything unredacted.
  if (!scan.redactionOk) {
    session = null;
    throw new Error(
      "Redaction failed — request aborted, nothing was captured or transmitted. " +
      (scan.redactionError || "")
    );
  }

  session = {
    task,
    parsedTask: TaskPlanner.parseTask(task),
    // What the instruction has actually achieved so far. The planner reads this to decide
    // whether anything remains to be done, which is what makes the loop terminate.
    progress: { navigated: false, searched: false, opened: [], scrolled: false },
    consecutiveFailures: 0,
    tabId: tab.id,
    windowId: tab.windowId,
    redacted: scan.redacted,
    redactionOk: true,
    marks: scan.safeMarks,
    markFrames: scan.markFrames,
    pageInfo: scan.pageInfo,
    filledIds: [],
    actionLog: [],
    lastAction: null,
    lastNavUrl: null,
    serverUrl: settings.serverUrl,
    settings,
    stepCount: 0,
  };

  const timings = scan.timings || {};
  const totalTime = Math.round(performance.now() - t0);
  const timingBreakdown = {
    total: timings.total || totalTime,
    wallClock: totalTime,
    scan: timings.domScan || 0,
    screenshot: timings.capture || 0,
    visionInference: timings.visionInference || 0,
    faceInference: timings.faceInference || 0,
    ocrInference: timings.ocrInference || 0,
    merge: timings.merge || 0,
    redact: timings.redact || 0,
  };

  return {
    preview: scan.redacted,
    redactedImagePreview: scan.redacted,
    regions: scan.previewRegions || [],
    viewport: {
      w: scan.pageInfo?.viewport_width || scan.tab?.width || 0,
      h: scan.pageInfo?.viewport_height || scan.tab?.height || 0,
    },
    pageTitle: scan.pageInfo?.title || "",
    pageUrl: scan.pageInfo?.url || "",
    piiCount: scan.piiCount,
    piiRegionsDetected: scan.piiCount,
    sourceBreakdown: scan.sourceBreakdown,
    frameStats: scan.frameStats,
    markCount: scan.safeMarks.length,
    marksDetected: scan.safeMarks.length,
    timings: timingBreakdown,
    timings_ms: timingBreakdown,
  };
}

// ── PHASE 2: Autonomous agent loop ────────────────────────────────────────────
async function phaseRun() {
  if (!session) throw new Error("Run Scan first.");
  const MAX_STEPS = 30;
  const MAX_CONSECUTIVE_FAILURES = 3;

  agentBusy = true;
  try {
    while (session.stepCount < MAX_STEPS) {
      // Circuit breaker. Repeated failures mean the planner is targeting elements that no
      // longer exist — typically stale mark IDs after a navigation. Continuing just burns
      // steps and, on a live site, clicks things at random.
      if ((session.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) {
        notifyPopup({ type: "step", step: session.stepCount, status: "Stopped: too many failed actions in a row." });
        return {
          done: true,
          needsConfirm: false,
          error: `Stopped after ${MAX_CONSECUTIVE_FAILURES} failed actions in a row — the page likely changed under the plan.`,
          actionLog: session.actionLog,
        };
      }

      if (stopRequested) {
        stopRequested = false;
        notifyPopup({ type: "step", step: session.stepCount, status: "Stopped by user." });
        return { done: true, stopped: true, needsConfirm: false, actionLog: session.actionLog };
      }
      session.stepCount++;
      notifyPopup({ type: "step", step: session.stepCount, status: "Asking AI..." });

      if (!session.marks || session.marks.length === 0) {
        await rescanCurrentTab(false);
        if (!session.marks || session.marks.length === 0) {
          return { done: true, needsConfirm: false, actionLog: [{ action: "none", reasoning: "No interactive elements detected on this page." }] };
        }
      }

      // FAIL CLOSED: never plan a step without a verified redacted frame.
      if (!session.redactionOk || !session.redacted) {
        return {
          done: true,
          needsConfirm: false,
          error: "Redaction unavailable — loop stopped without transmitting anything.",
          actionLog: session.actionLog,
        };
      }

      let resp;
      const t0 = performance.now();
      try {
        resp = await callServer({
          task: session.task,
          task_hints: session.parsedTask ? {
            search_query: session.parsedTask.query,
            site: session.parsedTask.siteUrl,
            open_targets: session.parsedTask.openTargets,
          } : null,
          image: session.redacted,
          redactionVerified: session.redactionOk === true,
          marks: session.marks,
          filled_mark_ids: session.filledIds,
          page_info: session.pageInfo || {},
          step: session.stepCount,
        }, session.serverUrl);
      } catch (e) {
        if (stopRequested) {
          stopRequested = false;
          notifyPopup({ type: "step", step: session.stepCount, status: "Stopped by user." });
          return { done: true, stopped: true, needsConfirm: false, actionLog: session.actionLog };
        }
        console.warn("[agent] server call failed, planning on-device instead:", e);
        resp = localMockPlan(session);
      }
      const serverMs = Math.round(performance.now() - t0);

      // Accept both the normalized shape and a raw StepAction, so "done" is recognised either way.
      const actionType = (resp?.action?.type || resp?.action || resp?.type || "").toString().toLowerCase();

      session.lastAction = resp;
      notifyPopup({ type: "step", step: session.stepCount, status: actionType + ": " + (resp.reasoning || "") });

      // ── TERMINAL: "done" stops the loop immediately. It is never forwarded to the executor. ──
      if (!actionType || actionType === "done" || actionType === "none" || actionType === "finish" || actionType === "stop") {
        notifyPopup({ type: "step", step: session.stepCount, status: "done: " + (resp.reasoning || "task complete") });
        return { done: true, needsConfirm: false, actionLog: session.actionLog };
      }

      // ── Navigate to URL ──
      if (actionType === "navigate" && resp.value) {
        // Prevent navigating to the same URL twice in a row
        if (resp.value === session.lastNavUrl) {
          return { done: true, needsConfirm: false, actionLog: session.actionLog };
        }
        session.lastNavUrl = resp.value;
        notifyPopup({ type: "step", step: session.stepCount, status: "Navigating to " + resp.value });
        session.actionLog.push({ action: "navigate", value: resp.value, serverMs, ok: true });
        session.progress.navigated = true;
        chrome.tabs.update(session.tabId, { url: resp.value });
        await waitForTabLoad(session.tabId);
        await rescanCurrentTab(true);
        continue;
      }

      // ── Open new tab ──
      if (actionType === "open_tab" && resp.value) {
        notifyPopup({ type: "step", step: session.stepCount, status: "Opening " + resp.value });
        session.actionLog.push({ action: "open_tab", value: resp.value, serverMs, ok: true });
        const newTabId = await openTab(resp.value);
        session.tabId = newTabId;
        const newTab = await new Promise(r => chrome.tabs.get(newTabId, r));
        session.windowId = newTab.windowId;
        await rescanCurrentTab(true); // new tab — reset filled IDs
        continue;
      }

      // ── Type ──
      if (actionType === "type") {
        let value = resp.value || null;
        const fieldKey = resp.use_vault_field || resp.field_type;
        if (!value || value === "use_vault_field" || fieldKey) {
          if (fieldKey && typeof resolveVaultField === "function") {
            value = await resolveVaultField(fieldKey);
          } else if (fieldKey) {
            const vault = await getVault();
            const key = VAULT_KEY_MAP[fieldKey] || fieldKey;
            value = (key && vault[key]) ? vault[key] : "";
          }
        }

        // If value is still missing from vault, ask the user interactively
        if (!value && fieldKey) {
          return {
            done: false,
            needsInput: true,
            fieldKey,
            action: resp,
            actionLog: session.actionLog
          };
        }

        // Guard: a planner (cloud or local) sometimes returns the user's entire sentence as
        // the value. Typing "iqoo neo 6 and show me" into a search box searches for the
        // conversational tail too. When the target is a search box and we parsed a cleaner
        // query from the same instruction, prefer the parsed query.
        const parsedQuery = session.parsedTask?.query;
        if (parsedQuery && value && !fieldKey) {
          const targetMark = (session.marks || []).find((m) => String(m.id) === String(resp.mark_id));
          const isSearchTarget = targetMark && (targetMark.role === "input:search" ||
            /search|find|query|keyword/i.test(targetMark.label || ""));
          const looksLikeWholeTask =
            value.trim().toLowerCase() === (session.task || "").trim().toLowerCase() ||
            (value.length > parsedQuery.length && value.toLowerCase().includes(parsedQuery.toLowerCase()));
          if (isSearchTarget && looksLikeWholeTask) {
            console.log(`[agent] Replacing planner value ${JSON.stringify(value)} with the parsed query ${JSON.stringify(parsedQuery)}`);
            value = parsedQuery;
          }
        }

        const exec = await executeMarkAction("type", resp.mark_id, value || "");
        noteResult(session, !!exec?.ok);
        // Typing into a search box submits it, so record the search as done; without this the
        // planner would search again on the results page, forever.
        if (exec?.ok && !fieldKey && value) {
          const target = (session.marks || []).find((m) => String(m.id) === String(resp.mark_id));
          const looksLikeSearch = target && (target.role === "input:search" ||
            /search|find|query|keyword/i.test(target.label || ""));
          if (looksLikeSearch || session.parsedTask?.query) session.progress.searched = true;
        }
        // Only a confirmed success marks the field as filled; a failed action must stay on the
        // to-do list so the planner can retry or choose a different element.
        if (exec?.ok) session.filledIds.push(resp.mark_id);

        session.actionLog.push({
          action: "type",
          field: resp.use_vault_field || (resp.value !== undefined ? resp.value : "?") || "?",
          mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error,
        });
        notifyPopup({
          type: exec?.ok ? "filled" : "failed",
          field: resp.use_vault_field || resp.value, mark_id: resp.mark_id, error: exec?.error
        });

        // If this was a search task, wait for navigation/results, rescan and continue.
        const isSearchTask = /search|find|look for|buy|watch/.test(session.task || "");
        if (exec?.ok && isSearchTask) {
          await new Promise(r => setTimeout(r, 1200));
          await waitForTabLoad(session.tabId, 5000);
          await rescanCurrentTab(await didUrlChange());
        }
        continue;
      }

      // ── press_key ──
      if (actionType === "press_key") {
        const exec = await executeMarkAction("press_key", resp.mark_id, resp.value || "Enter");
        noteResult(session, !!exec?.ok);
        session.actionLog.push({ action: "press_key", value: resp.value, mark_id: resp.mark_id, serverMs, ok: !!exec?.ok });
        // press_key is a NAV_ACTION: it commonly submits a form. Settle, re-scan, keep going.
        await waitForTabLoad(session.tabId, 8000);
        await rescanCurrentTab(await didUrlChange());
        continue;
      }

      // ── Select dropdown ──
      if (actionType === "select") {
        const exec = await executeMarkAction("select", resp.mark_id, resp.value);
        noteResult(session, !!exec?.ok);
        if (exec?.ok) session.filledIds.push(resp.mark_id);
        session.actionLog.push({ action: "select", value: resp.value, mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });
        continue;
      }

      // ── Scroll ──
      if (actionType === "scroll_page" || actionType === "scroll") {
        const exec = await executeMarkAction(actionType, resp.mark_id, resp.value || 400);
        noteResult(session, !!exec?.ok);
        if (exec?.ok) session.progress.scrolled = true;
        session.actionLog.push({ action: "scroll", serverMs, ok: !!exec?.ok });
        // Re-scan after scroll — new elements may be visible
        await new Promise(r => setTimeout(r, 600));
        await rescanCurrentTab(false); // same page scroll — keep filled IDs
        continue;
      }

      // ── Click ──
      if (actionType === "click") {
        const risk = assessClickRisk(resp, session);
        if (risk.needsConfirm) {
          notifyPopup({ type: "step", step: session.stepCount, status: "Awaiting approval: " + risk.reason });
          return {
            done: false,
            needsConfirm: true,
            confirmReason: risk.reason,
            action: resp,
            actionLog: session.actionLog,
          };
        }

        const exec = await executeMarkAction("click", resp.mark_id, resp.value);
        noteResult(session, !!exec?.ok);
        if (exec?.ok) {
          session.filledIds.push(resp.mark_id);
          if (resp.openTarget) session.progress.opened.push(resp.openTarget);
        }
        session.actionLog.push({ action: "click", mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });
        notifyPopup({
          type: "step", step: session.stepCount,
          status: exec?.ok ? `Clicked mark #${resp.mark_id}` : `Click on #${resp.mark_id} failed: ${exec?.error || "unknown"}`
        });

        if (exec?.ok) {
          await settleAfterNavAction("click");
        }
        continue;
      }

      // ── Any other action (clear / hover / focus / wait / …) — execute directly ──
      const exec = await executeMarkAction(actionType, resp.mark_id, resp.value);
      noteResult(session, !!exec?.ok);
      session.actionLog.push({ action: actionType, mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });
      if (exec?.ok && NAV_ACTIONS.has(actionType)) await settleAfterNavAction(actionType);
    }

    return { done: true, needsConfirm: false, actionLog: session.actionLog };
  } finally {
    agentBusy = false;
  }
}

/** Records whether an action succeeded, for the consecutive-failure circuit breaker. */
function noteResult(sess, ok) {
  if (!sess) return;
  sess.consecutiveFailures = ok ? 0 : (sess.consecutiveFailures || 0) + 1;
}

/** True if the tab navigated away from the page we last scanned. */
async function didUrlChange() {
  try {
    const tabAfter = await new Promise(r => chrome.tabs.get(session.tabId, r));
    return !!(tabAfter?.url && session.pageInfo?.url && !tabAfter.url.startsWith(session.pageInfo.url));
  } catch (_) {
    return false;
  }
}

/** Waits for a navigation-capable action to settle, then re-scans. */
async function settleAfterNavAction(actionType) {
  await new Promise(r => setTimeout(r, 900));
  await waitForTabLoad(session.tabId, 5000);
  await rescanCurrentTab(await didUrlChange());
}

// ── Re-scan current tab and update session ────────────────────────────────────
async function rescanCurrentTab(resetFilled = false, reason = "agent") {
  try {
    const scan = await scanTab(session.tabId, session.windowId, session.settings);

    if (!scan.redactionOk) {
      // FAIL CLOSED: drop the stale image so the loop cannot transmit anything.
      session.redacted = "";
      session.redactionOk = false;
      notifyPopup({ type: "error", message: "Redaction failed on re-scan — agent halted, nothing transmitted." });
      return false;
    }

    session.redacted = scan.redacted;
    session.redactionOk = true;
    session.marks = scan.safeMarks;
    session.markFrames = scan.markFrames;
    if (resetFilled) session.filledIds = []; // only reset on real page navigation
    session.pageInfo = scan.pageInfo;

    notifyPopup({
      type: "rescanned",
      reason,
      piiCount: scan.piiCount,
      markCount: scan.safeMarks.length,
      preview: scan.redacted,
      regions: scan.previewRegions || [],
      viewport: {
        w: scan.pageInfo?.viewport_width || 0,
        h: scan.pageInfo?.viewport_height || 0,
      },
      timings: scan.timings,
      sourceBreakdown: scan.sourceBreakdown,
      frameStats: scan.frameStats,
    });
    return true;
  } catch (e) {
    console.warn("[agent] rescan failed:", e);
    return false;
  }
}

// ── Confirmed click — execute then continue loop ──────────────────────────────
async function phaseConfirm() {
  if (!session?.lastAction) throw new Error("No pending action.");
  const pending = session.lastAction;
  const actionType = (pending.action?.type || pending.action || pending.type || "click").toString().toLowerCase();

  agentBusy = true;
  let exec;
  try {
    exec = await executeMarkAction(actionType, pending.mark_id, pending.value);
    if (exec?.ok) session.filledIds.push(pending.mark_id);
    session.lastAction = null;
    session.actionLog.push({ action: actionType, mark_id: pending.mark_id, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });

    notifyPopup({
      type: "step", step: session.stepCount,
      status: exec?.ok ? "Approved action executed, updating page..." : `Approved action failed: ${exec?.error || "unknown"}`
    });
    if (exec?.ok) await settleAfterNavAction(actionType);
  } finally {
    agentBusy = false;
  }

  // Continue the agent loop automatically after the confirmed action.
  return phaseRun();
}

// ── DOM_CHANGED → live re-scan ────────────────────────────────────────────────
//
// A MutationObserver in the top frame reports settled DOM changes. When they belong to the tab
// we are driving, re-scan and push the fresh preview/stats into the session AND the popup, so
// the UI and the next planning step both see the current page — exactly like a manual scan.
let domChangeTimer = null;
function scheduleDomChangeRescan(tabId) {
  if (!session || session.tabId !== tabId) return;
  if (agentBusy) return; // the loop performs its own re-scans; don't race it
  if (domChangeTimer) clearTimeout(domChangeTimer);
  domChangeTimer = setTimeout(async () => {
    domChangeTimer = null;
    if (!session || agentBusy) return;
    const ok = await rescanCurrentTab(false, "dom_change");
    if (ok) console.log("[agent] Session refreshed from DOM change:", session.marks.length, "marks");
  }, 900);
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "DOM_CHANGED") {
    if (sender?.tab?.id != null) scheduleDomChangeRescan(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }
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
  if (msg.type === "PROVIDE_INPUT") {
    (async () => {
      const { value, saveToVault, fieldKey, mark_id } = msg.payload || {};
      if (saveToVault && fieldKey && value) {
        const vault = await getVault();
        const key = VAULT_KEY_MAP[fieldKey] || fieldKey;
        vault[key] = value;
        await chrome.storage.local.set({ vault });
      }

      const exec = await executeMarkAction("type", mark_id, value || "");
      if (exec?.ok) session.filledIds.push(mark_id);
      session.actionLog.push({
        action: "type",
        field: fieldKey || "custom_input",
        mark_id,
        serverMs: 0,
        ok: !!exec?.ok,
        error: exec?.ok ? undefined : exec?.error
      });
      notifyPopup({ type: exec?.ok ? "filled" : "failed", field: fieldKey || value, mark_id, error: exec?.error });

      const result = await phaseRun();
      sendResponse({ ok: true, result });
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "SKIP_INPUT") {
    (async () => {
      if (msg.payload?.mark_id) {
        session.filledIds.push(msg.payload.mark_id);
      }
      const result = await phaseRun();
      sendResponse({ ok: true, result });
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CONFIRM") {
    phaseConfirm()
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "STOP") {
    stopRequested = true;
    // Cut short a planning call that is already in flight, so Stop is immediate.
    try { inFlightPlanRequest?.abort(); } catch (_) {}
    if (session) session.lastAction = null;
    notifyPopup({ type: "step", step: session?.stepCount || 0, status: "Stopping after the current step..." });
    sendResponse({ ok: true, running: agentBusy });
    return true;
  }
  if (msg.type === "REJECT") {
    if (session) {
      session.actionLog.push({ action: "rejected_by_user", mark_id: session.lastAction?.mark_id, ok: false });
      session.lastAction = null;
    }
    sendResponse({ ok: true });
    return true;
  }
});

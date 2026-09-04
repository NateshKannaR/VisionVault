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
importScripts("./vault.js", "./task-planner.js", "./agent-guard.js", "./detection-orchestrator.js");

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
  // submit / commit — only when clearly finalising something
  "submit", "send\\s+message", "post\\s+comment", "publish", "confirm\\s+order",
  "continue\\s+to\\s+pay", "proceed\\s+to\\s+(pay|checkout|payment)",
  "finish\\s+order", "complete\\s+order", "place\\s*order", "book\\s*now",
  // money
  "pay\\s+now", "pay\\s+\\$", "make\\s+payment", "checkout", "check\\s*out",
  "buy\\s+now", "purchase\\s+now", "order\\s+now", "add\\s+to\\s+cart",
  "subscribe\\s+now", "donate", "transfer\\s+funds", "withdraw", "deposit\\s+funds",
  "billing", "upi\\s+pay", "netbanking", "pay\\s+with\\s+card",
  // destructive
  "delete", "remove\\s+account", "erase", "wipe", "destroy", "discard\\s+all",
  "clear\\s+all\\s+data", "deactivate\\s+account", "disable\\s+account",
  "cancel\\s+subscription", "close\\s+account", "unsubscribe",
  "revoke\\s+access", "ban\\b", "permanently\\s+delete",
  // identity / auth / consent — only explicit auth actions, not generic labels
  "create\\s+account", "sign\\s*up\\s+now", "register\\s+now",
  "log\\s*in\\s+now", "sign\\s*in\\s+now",
  "authorize\\s+payment", "grant\\s+access", "two-factor",
  "change\\s+password", "reset\\s+password",
  // sharing / exfiltration
  "make\\s+public", "share\\s+with\\s+everyone", "export\\s+all", "download\\s+all"
].join("|"), "i");

let session = null;

// ── Multi-tab context stack ───────────────────────────────────────────────────
// Each entry: { tabId, windowId, task, marks, filledIds, pageInfo, redacted, redactionOk }
const tabContextStack = [];

function pushTabContext() {
  if (!session) return;
  tabContextStack.push({
    tabId: session.tabId, windowId: session.windowId,
    task: session.task, marks: session.marks, filledIds: [...session.filledIds],
    pageInfo: session.pageInfo, redacted: session.redacted, redactionOk: session.redactionOk,
    markFrames: session.markFrames,
  });
}

function popTabContext() {
  return tabContextStack.pop() || null;
}

// ── Task history ──────────────────────────────────────────────────────────────
async function appendTaskHistory(task, result) {
  const { taskHistory } = await chrome.storage.local.get("taskHistory");
  const history = taskHistory || [];
  history.unshift({
    task,
    ts: Date.now(),
    ok: !result?.error,
    steps: result?.actionLog?.length || 0,
    error: result?.error || null,
  });
  // Keep last 50 entries
  await chrome.storage.local.set({ taskHistory: history.slice(0, 50) });
}

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

/**
 * Requests that the run stop at the next safe point, and cuts short a planning call already in
 * flight so Stop is immediate rather than "after the current cloud round trip".
 *
 * Exposed on globalThis because `stopRequested` is a module-scoped binding: assigning to it
 * from outside (an automated test, a devtools console) creates an unrelated global instead of
 * setting the flag the loop reads.
 */
function requestStop() {
  stopRequested = true;
  try { inFlightPlanRequest?.abort(); } catch (_) {}
}
globalThis.requestStop = requestStop;
globalThis.isAgentBusy = () => agentBusy;

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
      // Clear consent walls and modal dialogs before acting. They intercept every click
      // underneath them, so leaving one up makes the agent look broken on much of the web.
      dismissOverlays: true,
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
  // Page-level actions belong to the top frame. Broadcasting them means whichever frame
  // answers first wins, and an ad iframe reporting "I did not move" for a page scroll is
  // indistinguishable from the page genuinely being at the bottom.
  const PAGE_LEVEL = new Set(["scroll_page", "dismiss_overlays", "open_search", "probe_query",
                              "search_url", "detect_bot_wall"]);
  const frameId = mark_id != null ? session.markFrames?.[mark_id]
                : PAGE_LEVEL.has(action) ? 0
                : undefined;

  if (frameId !== undefined) {
    const res = await msgTab(session.tabId, { type: "EXECUTE_ACTION", payload }, { frameId });
    if (res) return res;
  }

  const res = await msgTab(session.tabId, { type: "EXECUTE_ACTION", payload });
  // `noReply` means the frame went away before answering — almost always because the action
  // itself navigated the page. The caller checks the page before calling that a failure.
  return res || { ok: false, noReply: true, error: "The page navigated before the action could report back." };
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
// How long to wait before each scan attempt. A single-page app can take several seconds to
// mount its controls after the URL changes, and reading it too early yields a page that looks
// empty — the agent then reports "no interactive elements" for a page full of them.
const SCAN_ATTEMPT_DELAYS_MS = [400, 1200, 2500];

async function scanTab(tabId, windowId, settings, retries = SCAN_ATTEMPT_DELAYS_MS.length) {
  let last = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await ensureContent(tabId);
    await new Promise(r => setTimeout(r, SCAN_ATTEMPT_DELAYS_MS[attempt - 1] ?? 2500));

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

    // A page that is still hydrating yields few or no marks. Zero is the obvious case; the
    // subtler one is a handful, which is what a large site looks like when its scripts have
    // not finished mounting — Amazon's home page has been observed returning 3 marks on a
    // premature scan and 68 a second later, and the agent then reported that it could find
    // nothing to search with. A long page with almost no controls is the signature, so retry
    // on that too. Short pages (the evaluation fixtures) legitimately have few marks.
    const looksUnhydrated =
      safeMarks.length === 0 ||
      (safeMarks.length < 5 && (pageInfo.page_height || 0) > 2000);
    if (!looksUnhydrated || !last.redactionOk || attempt >= retries) return last;
  }

  return last || {
    redacted: "", redactionOk: false, redactionError: "Scan produced no result.",
    safeMarks: [], markFrames: {}, piiCount: 0, sourceBreakdown: {},
    frameStats: { total: 0, merged: 0, skipped: 0 }, pageInfo: {}, tab: null, regions: [], timings: {}
  };
}

// ── Server call (SSE streaming) ──────────────────────────────────────────────
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
      // What the instruction has achieved so far. Without this the server re-decides from
      // scratch every step and cannot tell "the search ran" from "we typed something", which
      // is how a finished task turned into a tour of the results page.
      progress: payload.progress || null,
      redactedImage: payload.image || "",
      image: payload.image || "",
      marks: payload.marks || [],
      filled_mark_ids: payload.filled_mark_ids || [],
      step: payload.step || 1,
      page_info: payload.page_info || {}
    };

    const streamUrl = targetUrl.replace(/\/api\/agent\/step\/?$/, "/api/agent/step/stream");
    const res = await fetch(streamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify(bodyData),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("Server " + res.status);

    // If server returned SSE, consume the stream and pick the last `data:` event
    let raw;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = ""; let lastData = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const chunk = line.slice(5).trim();
            if (chunk && chunk !== "[DONE]") {
              try { lastData = JSON.parse(chunk); } catch (_) {}
            }
          }
        }
      }
      raw = lastData;
    } else {
      raw = await res.json();
    }

    // Normalize StepResponse { reasoning, action: { type, target, value, use_vault_field } }
    if (raw.action && typeof raw.action === "object") {
      return {
        action: raw.action.type || "done",
        mark_id: raw.action.target,
        value: raw.action.value,
        use_vault_field: raw.action.use_vault_field,
        reasoning: raw.reasoning || raw.action.reasoning || "",
        // Which tier of the server's chain answered, so the panel can show a failover.
        tier: raw.tier || null,
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

  // Only gate on the element's own label — that is what the user sees and what the action
  // actually targets. The model's reasoning is prose and fires too many false positives
  // ("proceed with filling", "save the date", "verify the city") to be a reliable signal.
  if (label && RISKY_CLICK_RE.test(label)) {
    return { needsConfirm: true, reason: `Target labelled "${label}" matches the high-risk action list.` };
  }
  // Unknown risk: a control with no readable label and not a link.
  if (!label && role !== "link") {
    return { needsConfirm: true, reason: "Target has no readable label, so its effect cannot be assessed." };
  }
  return { needsConfirm: false, reason: "" };
}

/**
 * Why this page cannot be automated, or "" if it can.
 *
 * Chrome blocks extension content scripts on its own UI, on the Web Store, and on other
 * extensions' pages. That is a browser rule, not something this extension can work around.
 */
function restrictedPageReason(url) {
  if (/^(chrome|edge|brave|opera|about|view-source|devtools):/i.test(url)) {
    return "Chrome does not allow extensions to read its own pages. Open an ordinary website and try again.";
  }
  if (/^chrome-extension:/i.test(url)) {
    return "This is an extension page, which Chrome does not allow other extensions to read.";
  }
  if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    return "Chrome blocks extensions on the Web Store. Open an ordinary website and try again.";
  }
  if (/^file:/i.test(url)) {
    // Allowed, but only if the user ticked the box.
    return "";
  }
  return "";
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

  // Chrome refuses to inject content scripts into its own pages and the Web Store. Without
  // this the scan quietly finds nothing and reports "no interactive elements", which reads
  // like a bug in the extension rather than a rule of the browser.
  const blocked = restrictedPageReason(tab.url || "");
  if (blocked) throw new Error(blocked);

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
    progress: {
      navigated: false, searched: false, opened: [], scrolled: false,
      queryLanded: false, querySubmitted: false, filledAny: false,
      searchOpenAttempts: 0, siteSearchUrlTried: false, fillScrolls: 0,
      bookingStep: 0, fromTyped: false, toTyped: false,
    },
    // Supervises the planner for this task; recreated per scan so a new task starts clean.
    guard: null,
    // Fields the vault has no equivalent for, set aside to ask about once everything else is
    // done, and the ones already dealt with so the same question is not repeated.
    pendingAsks: [],
    answeredAsks: [],
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

// ── Run budgets ───────────────────────────────────────────────────────────────
//
// Two independent ceilings. The step budget stops one wedged await (a page that never fires
// `load`, a hosted model that stalls) from hanging the whole agent; the run budget stops a
// task that is technically progressing but will never finish from running forever.
// 5 minutes. Generous, because the guard's stall and repeat rules already stop a run that is
// going nowhere long before this — the budget exists for the case they cannot see, such as a
// page that keeps genuinely changing while making no progress on the task.
const RUN_BUDGET_MS = 600000;  // 10 minutes for complex booking flows
const STEP_BUDGET_MS = 60000;  // 60s per step (booking pages can be slow)
const MAX_STEPS = 60;          // enough for a full booking flow
const MAX_CONSECUTIVE_FAILURES = 4;

/** Rejects if `promise` has not settled within `ms`. Used to bound every awaited stage. */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    }),
  ]);
}

/** Same, but a timeout resolves to `fallback` instead of throwing. */
async function withDeadlineSoft(promise, ms, label, fallback = null) {
  try {
    return await withDeadline(promise, ms, label);
  } catch (e) {
    console.warn("[agent]", e.message);
    return fallback;
  }
}

/**
 * Keeps the MV3 service worker alive for the duration of a run.
 *
 * Chrome terminates an idle worker after ~30s. Timers do not count as activity, but calls into
 * an extension API do — so a cheap periodic API call keeps the loop, and the session state it
 * holds, from being torn down mid-task.
 */
function startKeepAlive() {
  const id = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch (_) {}
  }, 20000);
  return () => clearInterval(id);
}

/** Closes cookie banners / modal dialogs in the top frame. Best-effort, never fatal. */
async function dismissOverlaysOnce() {
  if (session?.settings?.dismissOverlays === false) return false;
  await ensureContent(session.tabId);
  const res = await withDeadlineSoft(
    msgTab(session.tabId, { type: "EXECUTE_ACTION", payload: { action: "dismiss_overlays" } }, { frameId: 0 }),
    6000, "overlay dismissal");
  if (res && res.dismissed) {
    notifyPopup({ type: "step", step: session.stepCount, status: `Dismissed ${res.dismissed} overlay(s): ${(res.labels || []).join(", ")}` });
    await new Promise(r => setTimeout(r, 500));
    return true;
  }
  return false;
}

/**
 * Asks the page whether the search query actually arrived — in a field, the URL or the title.
 *
 * This is the difference between "we typed something" and "the search ran". Without it the
 * agent typed into MakeMyTrip's city picker seven times in a row and reported success.
 */
/**
 * Where the query ended up.
 *
 * `strong` means the search demonstrably ran: the query is in the URL or the page title.
 * `weak` means the text is sitting in a field and nothing has happened yet — which is what
 * GitHub looked like when the agent called the task complete with an untouched results page.
 * The two must not be conflated.
 *
 * @returns {Promise<{landed: boolean, strong: boolean}>}
 */
async function probeQueryLanded(query) {
  if (!query) return { landed: false, strong: false };

  // Booking tasks use separate city fields — the query will never appear in the URL.
  // Don't block progress waiting for it.
  const isBooking = session?.parsedTask?.wantsBook;
  if (isBooking) return { landed: true, strong: true };

  // Cheapest and most reliable check first: the tab's own URL and title, read straight from
  // the tabs API. It needs no content script, so it still works in the moments right after a
  // navigation when the page's scripts have not been injected yet — which is exactly when a
  // search has just run and this question is being asked.
  try {
    const tab = await new Promise(r => chrome.tabs.get(session.tabId, r));
    const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const target = norm(query);
    let href = tab?.url || "";
    try { href = decodeURIComponent(href); } catch (_) {}
    if (target && (norm(href).includes(target) || norm(tab?.title).includes(target))) {
      return { landed: true, strong: true };
    }
  } catch (_) {}

  // Otherwise ask the page, which can also see the value sitting in a field.
  await ensureContent(session.tabId);
  const payload = { action: "probe_query", value: query };
  let res = await withDeadlineSoft(
    msgTab(session.tabId, { type: "EXECUTE_ACTION", payload }, { frameId: 0 }), 5000, "query probe");
  if (!res?.landing?.landed) {
    res = await withDeadlineSoft(msgTab(session.tabId, { type: "EXECUTE_ACTION", payload }), 5000, "query probe (any frame)", res);
  }
  const l = res?.landing;
  return { landed: !!l?.landed, strong: !!(l?.inUrl || l?.inTitle) };
}

/**
 * Sets a field aside for the user to answer later, and lets the run carry on.
 *
 * The mark is recorded as handled so the planner stops proposing it; the question is asked once
 * everything that could be filled has been.
 */
function deferField(fieldKey, mark) {
  session.pendingAsks = session.pendingAsks || [];
  if (!session.pendingAsks.some((a) => a.fieldKey === fieldKey)) {
    session.pendingAsks.push({ fieldKey, fieldLabel: mark?.label || fieldKey, mark_id: mark?.id });
  }
  if (mark?.id != null) session.filledIds.push(mark.id);
  notifyPopup({
    type: "step", step: session.stepCount,
    status: `Skipping "${mark?.label || fieldKey}" for now — the vault has nothing for it.`,
  });
}

/** The next set-aside field still worth asking about, or null. */
function nextPendingAsk() {
  const pending = session.pendingAsks || [];
  while (pending.length) {
    const next = pending[0];
    if (!(session.answeredAsks || []).includes(next.fieldKey)) return next;
    pending.shift();
  }
  return null;
}

/**
 * On a form taller than the window, look below the fold before concluding.
 *
 * Elements are tagged viewport-only — that is what makes Set-of-Marks work against a
 * screenshot — so a six-field signup on a short window presents as two fields, and the agent
 * fills those and stops, having genuinely finished everything it could see. Measured on the
 * evaluation fixture: two of six fields, reported as done.
 *
 * @returns {Promise<boolean>} true when there is more page to look at and it was revealed
 */
async function scrollForMoreFields() {
  const MAX_FILL_SCROLLS = 6;
  if ((session.progress.fillScrolls || 0) >= MAX_FILL_SCROLLS) return false;

  const info = session.pageInfo || {};
  const remaining = (info.page_height || 0) - (info.scroll_y || 0) - (info.viewport_height || 0);
  if (!info.page_height || remaining <= 50) return false;

  session.progress.fillScrolls = (session.progress.fillScrolls || 0) + 1;
  notifyPopup({ type: "step", step: session.stepCount, status: "Looking further down the form..." });

  const exec = await withDeadlineSoft(
    executeMarkAction("scroll_page", null, Math.min(600, remaining)), 10000, "scroll for fields");
  if (!exec?.ok || exec.moved === false) return false;

  await new Promise(r => setTimeout(r, 400));
  await rescanCurrentTab(false, "more_fields");
  // Only worth continuing if something new actually came into view.
  // String comparison: ids arrive as numbers from the server and as strings from the panel.
  const done = new Set((session.filledIds || []).map(String));
  const FILLABLE = ["input:text", "input:email", "input:tel", "input:password", "textarea", "editable"];
  return (session.marks || []).some((m) => !done.has(String(m.id)) && FILLABLE.includes(m.role));
}

/**
 * Has the site put a human-verification wall in front of the agent?
 *
 * Observed live: Stack Overflow redirected to /nocaptcha after two typed queries. Continuing
 * past that achieves nothing and looks like the extension malfunctioning, so the run stops and
 * says what happened. Nothing here tries to solve or evade the check — that is the site's
 * decision to make, and the honest response is to hand the page back to the person.
 *
 * @returns {Promise<string>} how it was blocked, or "" when it was not
 */
async function detectBotWall() {
  const res = await withDeadlineSoft(
    msgTab(session.tabId, { type: "EXECUTE_ACTION", payload: { action: "detect_bot_wall" } }, { frameId: 0 }),
    4000, "bot-wall check");
  return res?.blocked ? (res.how || "the site is asking for verification") : "";
}

/** True when nothing currently on screen can accept a typed search query. */
function noSearchBoxVisible() {
  const FILLABLE = new Set(["input:text", "input:search", "input:email", "textarea", "editable"]);
  return !(session.marks || []).some((m) => FILLABLE.has(m.role));
}

/**
 * On sites where search is a button that mounts an input (GitHub, MDN), open it first.
 * Returns true when a search box was successfully revealed.
 */
async function tryOpenSearchAffordance() {
  await ensureContent(session.tabId);
  notifyPopup({ type: "step", step: session.stepCount, status: "Opening the site's search box..." });
  const res = await withDeadlineSoft(
    msgTab(session.tabId, { type: "EXECUTE_ACTION", payload: { action: "open_search" } }, { frameId: 0 }),
    8000, "open search");
  session.progress.searchOpenAttempts = (session.progress.searchOpenAttempts || 0) + 1;
  // Re-scan either way. Even a failed attempt may have changed the page, and the box we were
  // looking for is often already present and simply was not tagged by the previous scan.
  await new Promise(r => setTimeout(r, 400));
  await rescanCurrentTab(false, "search_opened");
  if (!res?.ok) {
    console.warn("[agent] could not reveal a search box:", res?.error);
    return false;
  }
  return true;
}

/**
 * Re-reads the page after an action failed to find its target.
 *
 * A failed action nearly always means the element list the planner was given no longer matches
 * the page — a dropdown opened, a panel expanded, the site re-rendered. Planning the next step
 * against the same stale list produces another failure, and three of those end the run. One
 * re-scan turns that into a recoverable step.
 */
async function recoverAfterFailedAction(error) {
  if (!/not found|no longer visible|navigated before/i.test(String(error || ""))) return;
  notifyPopup({ type: "step", step: session.stepCount, status: "The page moved under the plan — re-reading it." });
  await rescanCurrentTab(false, "recovery");
}

/**
 * Last-resort search: open the URL the site itself publishes for searching.
 *
 * Used only when the page has defeated every in-page route — no box to type into, or a box
 * that accepted the text and never ran anything. Reads the site's OpenSearch descriptor, which
 * is a published standard rather than knowledge about any particular site, and navigates to
 * the URL it describes.
 *
 * @returns {Promise<boolean>} whether the query is now demonstrably on the page.
 */
async function trySiteSearchUrl(query) {
  if (!query || session.progress.siteSearchUrlTried) return false;
  session.progress.siteSearchUrlTried = true;

  await ensureContent(session.tabId);
  const res = await withDeadlineSoft(
    msgTab(session.tabId, { type: "EXECUTE_ACTION", payload: { action: "search_url", value: query } }, { frameId: 0 }),
    8000, "site search url");
  if (!res?.ok || !res.url) {
    console.warn("[agent] no site search URL available:", res?.error);
    return false;
  }

  notifyPopup({ type: "step", step: session.stepCount, status: `Using the site's own search page for "${query}".` });
  session.lastNavUrl = res.url;
  chrome.tabs.update(session.tabId, { url: res.url });
  await withDeadlineSoft(waitForTabLoad(session.tabId), 20000, "site search navigation");
  session.guard?.resetStall();
  await dismissOverlaysOnce();
  await rescanCurrentTab(true);

  const landing = await probeQueryLanded(query);
  session.progress.queryLanded = landing.landed;
  session.progress.querySubmitted = landing.strong;
  session.actionLog.push({ action: "navigate", value: res.url, serverMs: 0, ok: landing.landed });
  return landing.landed;
}

// ── PHASE 2: the agent loop ───────────────────────────────────────────────────
async function phaseRun() {
  if (!session) throw new Error("Run Scan first.");

  const runDeadline = Date.now() + RUN_BUDGET_MS;
  session.guard = session.guard || AgentGuard.createGuard(session.parsedTask);
  const guard = session.guard;

  const finish = (extra = {}) => ({
    done: true, needsConfirm: false, actionLog: session.actionLog,
    progress: session.progress, ...extra,
  });

  agentBusy = true;
  const stopKeepAlive = startKeepAlive();
  try {
    // Anything covering the page swallows every subsequent click, so clear it once per run.
    await dismissOverlaysOnce();

    while (session.stepCount < MAX_STEPS) {
      if (stopRequested) {
        stopRequested = false;
        notifyPopup({ type: "step", step: session.stepCount, status: "Stopped by user." });
        return finish({ stopped: true });
      }

      if (Date.now() > runDeadline) {
        const left = AgentGuard.describeRemaining(session.parsedTask, session.progress);
        notifyPopup({ type: "step", step: session.stepCount, status: "Time budget reached." });
        return finish({
          timedOut: true,
          error: `Stopped after ${Math.round(RUN_BUDGET_MS / 1000)}s.` + (left ? ` Not completed: ${left}.` : ""),
        });
      }

      // Circuit breaker. Repeated failures mean the planner is targeting elements that no
      // longer exist — typically stale mark IDs after a navigation. Continuing just burns
      // steps and, on a live site, clicks things at random.
      if ((session.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) {
        // Before abandoning a search, try the one route that does not depend on finding an
        // element at all: the URL the site publishes for searching. A page whose controls keep
        // moving out from under the plan can still be searched by navigating to it.
        if (session.parsedTask?.query && !session.progress.queryLanded &&
            await trySiteSearchUrl(session.parsedTask.query)) {
          session.consecutiveFailures = 0;
          continue;
        }
        notifyPopup({ type: "step", step: session.stepCount, status: "Stopped: too many failed actions in a row." });
        return finish({
          error: `Stopped after ${MAX_CONSECUTIVE_FAILURES} failed actions in a row — the page changed under the plan.`,
        });
      }

      session.stepCount++;
      const stepDeadline = Date.now() + STEP_BUDGET_MS;
      notifyPopup({ type: "step", step: session.stepCount, status: "Reading the page..." });

      if (!session.marks || session.marks.length === 0) {
        await rescanCurrentTab(false);
        if (!session.marks || session.marks.length === 0) {
          return finish({ error: "No interactive elements detected on this page." });
        }
      }

      // FAIL CLOSED: never plan a step without a verified redacted frame.
      if (!session.redactionOk || !session.redacted) {
        return finish({ error: "Redaction unavailable — loop stopped without transmitting anything." });
      }

      // A verification wall means the site has decided it does not want to be automated.
      // Respect that, and say so, rather than spending steps against a page that cannot work.
      const wall = await detectBotWall();
      if (wall) {
        notifyPopup({ type: "step", step: session.stepCount, status: "Stopped: " + wall + "." });
        return finish({
          error: `Stopped — ${wall}. This site is asking for a human, so it is over to you.`,
          botWall: true,
        });
      }

      // Finished? Then stop here, without a planning round trip.
      //
      // The guard would reject whatever came back anyway (rule 0), so asking costs a hosted
      // model call — several seconds, and on a chain with rate-limited tiers considerably more
      // — to be told something already known. Measured on a one-step search this was most of
      // the wall clock: the search ran on step 1 and step 2 existed only to be overruled.
      if (AgentGuard.goalFullyVerified(session.parsedTask, session.progress)) {
        const summary = AgentGuard.describeCompletion(session.parsedTask, session.progress);
        notifyPopup({ type: "step", step: session.stepCount, status: summary });
        return finish();
      }

      // The on-device plan is computed every step. It is both the offline fallback and the
      // yardstick the guard uses when the cloud planner stops early or repeats itself.
      let deterministic = null;
      try { deterministic = localMockPlan(session); } catch (e) { console.warn("[agent] local plan failed:", e); }

      // A search task with nothing to type into: reveal the site's search box first.
      // Skip this for booking tasks — they use city pickers, not a single search box.
      if (!session.parsedTask?.wantsBook &&
          session.parsedTask?.query && !session.progress.queryLanded &&
          noSearchBoxVisible() && (session.progress.searchOpenAttempts || 0) < 2) {
        const opened = await tryOpenSearchAffordance();
        session.actionLog.push({ action: "open_search", ok: opened, serverMs: 0 });
        if (opened) continue;
        // No box could be revealed. Before giving up on the search, try the URL the site
        // publishes for searching — on MDN that is the only route that exists.
        if (noSearchBoxVisible() && await trySiteSearchUrl(session.parsedTask.query)) continue;
        // Still nothing — fall through and let the planner try something else.
      }

      // ── Force navigation to the target site before asking the planner ──
      // The server sees a screenshot of whatever tab is open. If the task names a site
      // and we are not on it yet, navigate first — no model call needed.
      if (session.parsedTask?.siteUrl && !session.progress.navigated) {
        const currentUrl = session.pageInfo?.url || "";
        if (!TaskPlanner.alreadyOnSite(currentUrl, session.parsedTask.siteUrl)) {
          notifyPopup({ type: "step", step: session.stepCount, status: `Navigating to ${session.parsedTask.site}...` });
          session.progress.navigated = true;
          session.lastNavUrl = session.parsedTask.siteUrl;
          session.actionLog.push({ action: "navigate", value: session.parsedTask.siteUrl, serverMs: 0, ok: true });
          guard.record("navigate", null, session.parsedTask.siteUrl, true);
          guard.resetStall();
          chrome.tabs.update(session.tabId, { url: session.parsedTask.siteUrl });
          await withDeadlineSoft(waitForTabLoad(session.tabId), 15000, "site navigation");
          await dismissOverlaysOnce();
          await rescanCurrentTab(true);
          continue;
        } else {
          session.progress.navigated = true;
        }
      }

      notifyPopup({ type: "step", step: session.stepCount, status: "Asking the planner..." });

      let resp;
      let plannerSource = "server";
      const t0 = performance.now();

      // For booking tasks, try the deterministic planner first.
      // The model loops on city pickers; the deterministic planner sequences them correctly.
      if (session.parsedTask?.wantsBook && deterministic && deterministic.action !== "done") {
        resp = deterministic;
        plannerSource = "on-device";
      } else {
        try {
          resp = await callServer({
            task: session.task,
            task_hints: session.parsedTask ? {
              search_query: session.parsedTask.query,
              site: session.parsedTask.siteUrl,
              open_targets: session.parsedTask.openTargets,
            } : null,
            progress: session.progress,
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
            return finish({ stopped: true });
          }
          console.warn("[agent] server call failed, planning on-device instead:", e);
          resp = deterministic || { action: "done", reasoning: "No planner available." };
          plannerSource = "on-device";
        }
      }
      const serverMs = Math.round(performance.now() - t0);

      // ── Supervision. The guard may substitute or veto the proposed action. ───────────────
      const verdict = guard.review(resp, {
        marks: session.marks,
        pageInfo: session.pageInfo,
        progress: session.progress,
        // Successful actions so far. Filling a form changes nothing else the guard can see, so
        // without this a working run reads as a stalled one.
        filledIds: session.filledIds,
        deterministic,
        task: session.task,
      });
      if (verdict.reason) {
        console.log("[agent][guard]", verdict.reason);
        notifyPopup({ type: "step", step: session.stepCount, status: verdict.reason });
      }
      if (verdict.stop) {
        return finish({ error: verdict.reason, guard: guard.stats });
      }

      resp = verdict.action;
      const actionType = (resp.action || resp.type || "").toString().toLowerCase();
      session.lastAction = resp;
      if (!verdict.reason) {
        notifyPopup({
          type: "step", step: session.stepCount,
          status: `${actionType}${resp.reasoning ? ": " + resp.reasoning : ""}`,
          planner: resp.tier || plannerSource,
        });
      }

      // A form with nothing left to fill but a question outstanding: ask before doing anything
      // else. Otherwise the planner moves on to whatever is next on the page — observed live,
      // a privacy-notice link — and the field it set aside is quietly forgotten.
      if (actionType !== "done" && session.parsedTask?.wantsFill &&
          !AgentGuard.unfilledFields(session.marks, session.filledIds).length) {
        const pending = nextPendingAsk();
        if (pending) {
          notifyPopup({ type: "step", step: session.stepCount, status: `Need your ${pending.fieldLabel} to finish.` });
          return {
            done: false, needsInput: true, fieldKey: pending.fieldKey, fieldLabel: pending.fieldLabel,
            action: { action: "type", mark_id: pending.mark_id },
            actionLog: session.actionLog, progress: session.progress,
          };
        }
      }

      // ── TERMINAL: "done" stops the loop. It is never forwarded to the executor. ──────────
      if (!actionType || actionType === "done") {
        // Before believing a form is finished, check whether the rest of it is simply below
        // the fold. Tagging is viewport-only, so "no fields left" can mean "no fields visible".
        if (session.parsedTask?.wantsFill && await scrollForMoreFields()) {
          notifyPopup({ type: "step", step: session.stepCount, status: "More fields below — continuing." });
          continue;
        }
        // Everything that could be filled has been. Now ask about the fields that were set
        // aside because the vault has no equivalent for them.
        const ask = nextPendingAsk();
        if (ask) {
          notifyPopup({ type: "step", step: session.stepCount, status: `Need your ${ask.fieldLabel} to finish.` });
          return {
            done: false, needsInput: true, fieldKey: ask.fieldKey, fieldLabel: ask.fieldLabel,
            action: { action: "type", mark_id: ask.mark_id },
            actionLog: session.actionLog, progress: session.progress,
          };
        }
        const left = AgentGuard.describeRemaining(session.parsedTask, session.progress);
        notifyPopup({ type: "step", step: session.stepCount, status: "Finished: " + (resp.reasoning || "task complete") });
        return finish({ error: verdict.reason || (left ? `Could not complete: ${left}.` : undefined) });
      }

      // ── Navigate to URL ──
      if (actionType === "navigate" && resp.value) {
        if (resp.value === session.lastNavUrl) {
          return finish({ error: "The planner asked to navigate to the same URL twice." });
        }
        session.lastNavUrl = resp.value;
        notifyPopup({ type: "step", step: session.stepCount, status: "Navigating to " + resp.value });
        session.actionLog.push({ action: "navigate", value: resp.value, serverMs, ok: true });
        session.progress.navigated = true;
        guard.record("navigate", null, resp.value, true);
        guard.resetStall();
        chrome.tabs.update(session.tabId, { url: resp.value });
        await withDeadlineSoft(waitForTabLoad(session.tabId),
                               Math.max(8000, stepDeadline - Date.now()), "navigation");
        await dismissOverlaysOnce();
        await rescanCurrentTab(true);
        continue;
      }

      // ── Open new tab ──
      if (actionType === "open_tab" && resp.value) {
        notifyPopup({ type: "step", step: session.stepCount, status: "Opening " + resp.value });
        session.actionLog.push({ action: "open_tab", value: resp.value, serverMs, ok: true });
        // Save current tab context before switching
        pushTabContext();
        const newTabId = await withDeadlineSoft(openTab(resp.value), 20000, "open tab");
        if (newTabId) {
          session.tabId = newTabId;
          const newTab = await new Promise(r => chrome.tabs.get(newTabId, r));
          session.windowId = newTab.windowId;
          guard.resetStall();
          await dismissOverlaysOnce();
          await rescanCurrentTab(true);
        }
        continue;
      }

      // ── Type ──
      if (actionType === "type") {
        let value = resp.value || null;
        let fieldKey = resp.use_vault_field || resp.field_type;

        // The field's own label has the final say on what belongs in it.
        //
        // A planner shown "Aadhaar number" and a menu of eight vault keys picks the nearest one
        // rather than declining — observed live, it chose `phone`. Typing a phone number into
        // an identity field is worse than leaving it empty: the value is wrong, it is personal,
        // and the field may well validate it. So a label that clearly names a different key
        // wins, and a label naming an identifier the vault has no equivalent for is put to the
        // user instead of guessed at.
        if (fieldKey) {
          const mark = (session.marks || []).find((m) => String(m.id) === String(resp.mark_id));
          const fromLabel = TaskPlanner.vaultKeyForLabel(mark?.label);
          if (fromLabel.unknownIdentifier) {
            const slug = String(mark?.label || "value").toLowerCase()
              .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "value";
            // If the user answered this one before and chose to remember it, use that.
            const stored = (await getVault())[slug];
            if (stored) {
              fieldKey = slug;
            } else {
              // Set it aside and carry on. Stopping at the first unknown field would leave the
              // rest of the form empty while the panel waits for an answer; a person filling
              // the same form would do everything they could first and come back to this one.
              deferField(slug, mark);
              continue;
            }
          }
          if (fromLabel.key && fromLabel.key !== fieldKey) {
            console.log(`[agent] "${mark?.label}" takes ${fromLabel.key}, not ${fieldKey}`);
            fieldKey = fromLabel.key;
          }
        }

        if (!value || value === "use_vault_field" || fieldKey) {
          if (fieldKey && typeof resolveVaultField === "function") {
            value = await resolveVaultField(fieldKey);
          } else if (fieldKey) {
            const vault = await getVault();
            const key = VAULT_KEY_MAP[fieldKey] || fieldKey;
            value = (key && vault[key]) ? vault[key] : "";
          }
        }

        // The vault has no value for this field. Rather than typing nothing or inventing data,
        // pause and ask the user; the panel offers to remember the answer.
        if (!value && fieldKey) {
          const mark = (session.marks || []).find((m) => String(m.id) === String(resp.mark_id));
          notifyPopup({ type: "step", step: session.stepCount, status: `Need your ${fieldKey} to continue.` });
          return {
            done: false, needsInput: true, fieldKey,
            fieldLabel: mark?.label || fieldKey,
            action: resp, actionLog: session.actionLog, progress: session.progress,
          };
        }

        const exec = await withDeadlineSoft(
          executeMarkAction("type", resp.mark_id, value || ""), 20000, "type action",
          { ok: false, error: "Typing timed out." });

        let typedOk = !!exec?.ok;
        const isSearch = !fieldKey && !!session.parsedTask?.query;

        // A search: let it commit, re-read the page, then check whether the query actually
        // landed. Only that check may set `queryLanded`, which is what `done` is judged
        // against — "we typed something" is not the same claim, and conflating the two is what
        // let the agent report success on a page where nothing had run.
        if (isSearch && (typedOk || exec?.noReply)) {
          session.progress.searched = true;
          await new Promise(r => setTimeout(r, 900));
          await withDeadlineSoft(waitForTabLoad(session.tabId, 6000), 8000, "search settle");
          await rescanCurrentTab(await didUrlChange());
          let landing = await probeQueryLanded(session.parsedTask.query);

          // The text is in a field but nothing ran. Press Enter directly on that field once
          // more — the typing sequence and the submit escalation can both be swallowed by a
          // suggestion dropdown that opens between them.
          if (landing.landed && !landing.strong) {
            notifyPopup({ type: "step", step: session.stepCount, status: "Submitting the search..." });
            await withDeadlineSoft(executeMarkAction("press_key", resp.mark_id, "Enter"), 8000, "submit search");
            await withDeadlineSoft(waitForTabLoad(session.tabId, 5000), 7000, "submit settle");
            await rescanCurrentTab(await didUrlChange());
            landing = await probeQueryLanded(session.parsedTask.query);
          }

          // The box swallowed the text and ran nothing. Fall back to the site's published
          // search URL rather than leaving a typed query sitting in a dead field.
          if (landing.landed && !landing.strong) {
            if (await trySiteSearchUrl(session.parsedTask.query)) {
              landing = { landed: true, strong: true };
            }
          }

          session.progress.queryLanded = landing.landed;
          session.progress.querySubmitted = landing.strong;

          // Submitting a search navigates, and a navigation destroys the content script before
          // it can answer. Silence plus a landed query is a success, not a failure.
          if (!typedOk && exec?.noReply && landing.landed) typedOk = true;

          notifyPopup({
            type: "step", step: session.stepCount,
            status: landing.strong ? `Search for "${session.parsedTask.query}" ran.`
                   : landing.landed ? `Typed "${session.parsedTask.query}" — the page has not run the search.`
                   : `Typed "${session.parsedTask.query}" but it did not reach a search box.`,
          });
          if (!landing.landed && (session.progress.searchOpenAttempts || 0) < 2) {
            // The value went somewhere that was not a search box. Reveal a real one and retry.
            session.filledIds = session.filledIds.filter((id) => String(id) !== String(resp.mark_id));
            await tryOpenSearchAffordance();
          }
        } else if (exec?.noReply) {
          // Same reasoning for a non-search field: confirm against the page before judging.
          await withDeadlineSoft(waitForTabLoad(session.tabId, 4000), 6000, "settle after type");
          if (await didUrlChange()) typedOk = true;
          await rescanCurrentTab(typedOk);
        }

        noteResult(session, typedOk);
        guard.record("type", resp.mark_id, value, typedOk);
        if (typedOk) {
          session.filledIds.push(resp.mark_id);
          if (fieldKey) session.progress.filledAny = true;
        }

        session.actionLog.push({
          action: "type",
          field: fieldKey || (value ? "(text)" : "?"),
          mark_id: resp.mark_id, serverMs, ok: typedOk, error: typedOk ? undefined : exec?.error,
        });
        notifyPopup({
          type: typedOk ? "filled" : "failed",
          field: fieldKey || value, mark_id: resp.mark_id, error: typedOk ? undefined : exec?.error,
        });
        if (!typedOk) await recoverAfterFailedAction(exec?.error);
        continue;
      }

      // ── press_key ──
      if (actionType === "press_key") {
        const exec = await withDeadlineSoft(
          executeMarkAction("press_key", resp.mark_id, resp.value || "Enter"), 15000, "press_key",
          { ok: false, error: "press_key timed out." });
        await withDeadlineSoft(waitForTabLoad(session.tabId, 8000), 10000, "post-key load");
        const navigated = await didUrlChange();
        // Enter on a form submits and navigates, which silences the frame mid-reply.
        const keyOk = !!exec?.ok || (exec?.noReply && navigated);
        noteResult(session, keyOk);
        guard.record("press_key", resp.mark_id, resp.value, keyOk);
        session.actionLog.push({ action: "press_key", value: resp.value, mark_id: resp.mark_id, serverMs, ok: keyOk });
        await rescanCurrentTab(navigated);
        if (session.parsedTask?.query && !session.progress.queryLanded) {
          const l = await probeQueryLanded(session.parsedTask.query);
          session.progress.queryLanded = l.landed;
          session.progress.querySubmitted = l.strong;
        }
        continue;
      }

      // ── Select dropdown ──
      if (actionType === "select") {
        const exec = await withDeadlineSoft(
          executeMarkAction("select", resp.mark_id, resp.value), 10000, "select",
          { ok: false, error: "select timed out." });
        noteResult(session, !!exec?.ok);
        guard.record("select", resp.mark_id, resp.value, !!exec?.ok);
        if (exec?.ok) { session.filledIds.push(resp.mark_id); session.progress.filledAny = true; }
        session.actionLog.push({ action: "select", value: resp.value, mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });
        notifyPopup({
          type: exec?.ok ? "filled" : "failed",
          field: resp.value || "dropdown",
          mark_id: resp.mark_id,
          error: exec?.ok ? undefined : exec?.error,
        });
        if (!exec?.ok) await recoverAfterFailedAction(exec?.error);
        continue;
      }

      // ── Scroll ──
      if (actionType === "scroll_page" || actionType === "scroll") {
        const exec = await withDeadlineSoft(
          executeMarkAction(actionType, resp.mark_id, resp.value || 600), 10000, "scroll",
          { ok: false, error: "scroll timed out." });
        noteResult(session, !!exec?.ok);
        guard.record(actionType, resp.mark_id, resp.value, !!exec?.ok);
        // `moved === false` means the page is already at the bottom. Treat the scroll request
        // as satisfied rather than asking again forever.
        if (exec?.ok) session.progress.scrolled = true;
        session.actionLog.push({ action: "scroll", serverMs, ok: !!exec?.ok, moved: exec?.moved });
        if (exec && exec.moved === false) {
          notifyPopup({ type: "step", step: session.stepCount, status: "Reached the bottom of the page." });
        }
        await new Promise(r => setTimeout(r, 400));
        await rescanCurrentTab(false);
        continue;
      }

      // ── Click ──
      if (actionType === "click") {
        const risk = assessClickRisk(resp, session);
        if (risk.needsConfirm) {
          notifyPopup({ type: "step", step: session.stepCount, status: "Awaiting approval: " + risk.reason });
          return {
            done: false, needsConfirm: true, confirmReason: risk.reason,
            action: resp, actionLog: session.actionLog, progress: session.progress,
          };
        }

        const exec = await withDeadlineSoft(
          executeMarkAction("click", resp.mark_id, resp.value), 15000, "click",
          { ok: false, error: "click timed out." });

        let clickOk = !!exec?.ok;
        if (clickOk || exec?.noReply) {
          const navigated = await settleAfterNavAction("click");
          if (!clickOk && exec?.noReply && navigated) clickOk = true;
          // A click that caused navigation counts as navigated for booking flows
          if (navigated) session.progress.navigated = true;
          if (session.parsedTask?.query && !session.progress.queryLanded) {
            const l = await probeQueryLanded(session.parsedTask.query);
            session.progress.queryLanded = l.landed;
            session.progress.querySubmitted = l.strong;
          }
        }

        noteResult(session, clickOk);
        guard.record("click", resp.mark_id, resp.value, clickOk);
        if (clickOk) {
          session.filledIds.push(resp.mark_id);
          if (resp.openTarget) session.progress.opened.push(resp.openTarget);
        }
        session.actionLog.push({ action: "click", mark_id: resp.mark_id, serverMs, ok: clickOk, error: clickOk ? undefined : exec?.error });
        notifyPopup({
          type: "step", step: session.stepCount,
          status: clickOk ? `Clicked #${resp.mark_id}` : `Click on #${resp.mark_id} failed: ${exec?.error || "unknown"}`,
        });
        if (!clickOk) await recoverAfterFailedAction(exec?.error);
        continue;
      }

      // ── Any other action (clear / hover / focus / wait / …) — execute directly ──
      const exec = await withDeadlineSoft(
        executeMarkAction(actionType, resp.mark_id, resp.value), 12000, actionType,
        { ok: false, error: `${actionType} timed out.` });
      noteResult(session, !!exec?.ok);
      guard.record(actionType, resp.mark_id, resp.value, !!exec?.ok);
      session.actionLog.push({ action: actionType, mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });
      if (exec?.ok && NAV_ACTIONS.has(actionType)) await settleAfterNavAction(actionType);
      else if (!exec?.ok) await recoverAfterFailedAction(exec?.error);
    }

    const left = AgentGuard.describeRemaining(session.parsedTask, session.progress);
    return finish({ error: left ? `Reached the ${MAX_STEPS}-step limit. Not completed: ${left}.` : undefined });
  } finally {
    agentBusy = false;
    stopKeepAlive();
    // Persist task history when the run ends
    if (session?.task) {
      appendTaskHistory(session.task, {
        actionLog: session.actionLog,
        error: null,
      }).catch(() => {});
    }
  }
}

/** Records whether an action succeeded, for the consecutive-failure circuit breaker. */
function noteResult(sess, ok) {
  if (!sess) return;
  sess.consecutiveFailures = ok ? 0 : (sess.consecutiveFailures || 0) + 1;
}

/**
 * True if the tab navigated away from the page we last scanned.
 *
 * Compares origin + pathname, which is exactly the shape `pageInfo.url` carries. The previous
 * `startsWith` test reported "unchanged" for every navigation within a site, because
 * "https://www.amazon.in/s?k=..." starts with "https://www.amazon.in/" — so a search that
 * worked looked like one that had not happened.
 */
async function didUrlChange() {
  try {
    const tabAfter = await new Promise(r => chrome.tabs.get(session.tabId, r));
    if (!tabAfter?.url || !session.pageInfo?.url) return false;
    const now = new URL(tabAfter.url);
    return `${now.origin}${now.pathname}` !== session.pageInfo.url;
  } catch (_) {
    return false;
  }
}

/**
 * Waits for a navigation-capable action to settle, then re-scans.
 * @returns {Promise<boolean>} whether the tab actually navigated.
 */
async function settleAfterNavAction(actionType) {
  await new Promise(r => setTimeout(r, 900));
  await withDeadlineSoft(waitForTabLoad(session.tabId, 5000), 7000, "settle");
  // Read this BEFORE the re-scan: re-scanning overwrites the URL it compares against.
  const navigated = await didUrlChange();
  await rescanCurrentTab(navigated);
  return navigated;
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
    if (resetFilled) {
      session.filledIds = [];
      session.consecutiveFailures = 0;
      session.guard?.resetStall();
      // Preserve booking flow state across in-site navigations (suggestion clicks, etc.)
      // Only reset if we actually left the booking site entirely.
      const newUrl = scan.pageInfo?.url || "";
      const onBookingSite = session.parsedTask?.siteUrl &&
        TaskPlanner.alreadyOnSite(newUrl, session.parsedTask.siteUrl);
      if (!onBookingSite) {
        session.progress.bookingStep = 0;
        session.progress.fromTyped = false;
        session.progress.toTyped = false;
      }
    }
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

/**
 * Supplies a value the vault did not have, then resumes the run.
 *
 * A named function rather than an inline handler because the service worker cannot send itself
 * a runtime message: verifying this path end to end means calling it directly.
 */
async function provideInput({ value, saveToVault, fieldKey, mark_id } = {}) {
  // Saving is worth doing even if the run has since been torn down, so it happens first.
  if (saveToVault && fieldKey && value) {
    const vault = await getVault();
    const key = VAULT_KEY_MAP[fieldKey] || fieldKey;
    vault[key] = value;
    await chrome.storage.local.set({ vault });
  }

  if (!session) {
    return { ok: false, error: "The session expired while waiting. Scan the page again." };
  }

  session.answeredAsks = session.answeredAsks || [];
  if (fieldKey) session.answeredAsks.push(fieldKey);

  const exec = await executeMarkAction("type", mark_id, value || "");
  if (exec?.ok) {
    session.filledIds.push(mark_id);
    session.progress.filledAny = true;
  }
  session.actionLog.push({
    action: "type", field: fieldKey || "custom_input", mark_id, serverMs: 0,
    ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error,
  });
  notifyPopup({ type: exec?.ok ? "filled" : "failed", field: fieldKey || value, mark_id, error: exec?.error });

  const result = await phaseRun();
  return { ok: true, result };
}

/** Leaves a field empty and carries on, without asking about it again. */
async function skipInput({ mark_id } = {}) {
  if (!session) {
    return { ok: false, error: "The session expired while waiting. Scan the page again." };
  }
  // Mark it done so the planner moves on instead of asking for the same field again.
  if (mark_id != null) session.filledIds.push(mark_id);
  // Retire the question so the loop does not come straight back to it.
  const asked = (session.pendingAsks || [])[0];
  if (asked) {
    session.answeredAsks = session.answeredAsks || [];
    session.answeredAsks.push(asked.fieldKey);
  }
  const result = await phaseRun();
  return { ok: true, result };
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
    // Re-entrancy guard. Two concurrent loops would drive the same tab against each other:
    // both re-scan, both act on marks the other has invalidated, and the action log
    // interleaves into nonsense. One run per session, always.
    if (agentBusy) {
      sendResponse({ ok: false, error: "The agent is already running. Stop it first." });
      return true;
    }
    phaseRun()
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "PROVIDE_INPUT") {
    provideInput(msg.payload || {})
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "SKIP_INPUT") {
    skipInput(msg.payload || {})
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CONFIRM") {
    if (!session?.lastAction) {
      sendResponse({ ok: false, error: "There is no action waiting for approval any more." });
      return true;
    }
    if (agentBusy) {
      sendResponse({ ok: false, error: "The agent is already running." });
      return true;
    }
    phaseConfirm()
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "STOP") {
    requestStop();
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
  if (msg.type === "POP_TAB_CONTEXT") {
    const ctx = popTabContext();
    if (ctx && session) {
      session.tabId = ctx.tabId;
      session.windowId = ctx.windowId;
      session.marks = ctx.marks;
      session.filledIds = ctx.filledIds;
      session.pageInfo = ctx.pageInfo;
      session.redacted = ctx.redacted;
      session.redactionOk = ctx.redactionOk;
      session.markFrames = ctx.markFrames;
    }
    sendResponse({ ok: !!ctx, hasMore: tabContextStack.length > 0 });
    return true;
  }
  if (msg.type === "GET_TASK_HISTORY") {
    chrome.storage.local.get("taskHistory").then(({ taskHistory }) => {
      sendResponse({ ok: true, history: taskHistory || [] });
    });
    return true;
  }
  if (msg.type === "CLEAR_TASK_HISTORY") {
    chrome.storage.local.set({ taskHistory: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

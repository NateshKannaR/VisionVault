// background.js — Autonomous multi-page agent (MV3 service worker)
//
// Owns the agent loop: plan -> scan -> decide (server) -> execute (content frames) -> re-scan,
// milestone by milestone, until the workflow is complete or a person is needed.
//
// Privacy invariants enforced here:
//   • The service worker never handles a raw screenshot. Capture + redaction happen together
//     inside detection-orchestrator.js, which fails closed; only a redacted image is returned.
//   • callServer() refuses to transmit unless the payload carries a verified redacted image.
//   • Vault values are resolved locally and substituted into the page; the server only ever
//     receives the symbolic field name (e.g. "use_vault_field": "email").
//   • Page content sent for comparison is read by page-reader.js, which scrubs PII patterns
//     and drops sensitive table columns before anything leaves the page.

const DEFAULT_SERVER_URL = "http://127.0.0.1:8000/api/agent/step";

// vault.js                  -> local credential resolution (no DOM needed)
// task-planner.js           -> instruction parsing, workflow decomposition, on-device planning
// agent-guard.js            -> supervises every proposed action
// site-memory.js            -> what worked before, per site; run history
// detection-orchestrator.js -> capture + local ML + fail-closed redaction
// NOTE: action-executor.js and page-reader.js are deliberately NOT imported here. They are
// content scripts (see manifest.json) because they need a DOM; the service worker has none.
importScripts("./vault.js", "./task-planner.js", "./agent-guard.js", "./site-memory.js", "./detection-orchestrator.js");

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

// The content scripts every frame needs before the agent can read or act on it.
const CONTENT_FILES = ["action-executor.js", "page-reader.js", "content.js"];

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
  "add to cart", "add to bag", "add to basket", "subscribe", "donate", "transfer", "withdraw",
  "deposit", "top\\s*up", "upgrade", "renew", "billing", "invoice", "wallet", "upi", "netbanking",
  "credit card",
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

// Reasoning that describes getting something out of the way rather than committing to it.
// Both halves are required: "close" alone could be "close the account".
const DISMISS_INTENT_RE =
  /\b(?:clos\w+|dismiss\w*|hid\w+|reject\w*|declin\w*|skip\w*)\b[^.]{0,40}\b(?:popup|pop-?up|modal|dialog|banner|overlay|notification|prompt|interstitial|window)\b/i;

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
      // Pause after the scan so the redacted image can be reviewed before anything is sent.
      reviewBeforeSend: false,
      // Standing preferences the user chose to share with the planner: a budget, brands,
      // dietary needs. Sent with every task. Not part of the vault; nothing personal belongs here.
      preferences: "",
    },
    settings || {}
  );
}

// ── Tab helpers ───────────────────────────────────────────────────────────────
async function ensureContent(tabId) {
  try {
    // allFrames: every content script must exist in every frame we may scan or act on.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES,
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
                              "search_url", "detect_bot_wall", "scroll_to"]);
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

// A page the agent is driving may open its result in a new tab (target="_blank" product
// links, "open in new window" flows). The agent follows: the new tab is remembered here and
// adopted as the session's tab once the triggering action settles.
chrome.tabs.onCreated.addListener((tab) => {
  if (!session || !agentBusy) return;
  if (tab.openerTabId != null && tab.openerTabId === session.tabId) {
    session.pendingNewTab = tab.id;
  }
});

/** Switches the session to a tab the page opened, if one appeared. @returns {boolean} */
async function adoptNewTabIfAny() {
  const newId = session?.pendingNewTab;
  if (newId == null) return false;
  session.pendingNewTab = null;
  try {
    await withDeadlineSoft(waitForTabLoad(newId, 12000), 14000, "new tab load");
    const tab = await new Promise(r => chrome.tabs.get(newId, r));
    if (!tab) return false;
    const blocked = restrictedPageReason(tab.url || "");
    if (blocked) return false;
    session.tabId = newId;
    session.windowId = tab.windowId;
    try { await chrome.tabs.update(newId, { active: true }); } catch (_) {}
    session.guard?.resetStall();
    notifyPopup({ type: "step", step: session.stepCount, status: "The page opened a new tab — following it." });
    notifyPopup({ type: "newtab", url: (tab.url || "").slice(0, 200) });
    return true;
  } catch (e) {
    console.warn("[agent] could not adopt the new tab:", e);
    return false;
  }
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

// ── Server calls ──────────────────────────────────────────────────────────────

/** The server's base URL from whatever the settings hold (a step URL, a base, a legacy path). */
function serverBase(serverUrl) {
  return String(serverUrl || DEFAULT_SERVER_URL)
    .replace(/\/(api\/agent\/(?:step|plan|summary)|plan-action)\/?$/, "")
    .replace(/\/+$/, "");
}

/** The last few actions, as the planner sees them: type, target label, outcome. Labels only. */
function recentActionsForServer() {
  return (session?.recentActions || []).slice(-6);
}

async function callServer(payload, serverUrl) {
  // HARD PRIVACY GATE. The only image this function will ever send is one the redaction
  // pipeline confirmed it produced. If redaction failed there is no image and no request.
  if (!payload.redactionVerified) {
    throw new Error("Refusing to contact server: redaction was not verified for this frame.");
  }

  const ctrl = new AbortController();
  inFlightPlanRequest = ctrl;
  // The server bounds its own planning at STEP_PLAN_BUDGET_S and falls to the local tier when
  // that is spent, so anything past this is a network problem rather than a slow model — and
  // the on-device planner below answers instantly.
  const tid = setTimeout(() => ctrl.abort(), 25000);
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
      page_info: payload.page_info || {},
      // Workflow state: the plan and where we are in it, what was read so far, what was just
      // read (PII-scrubbed on the page), what worked on this site before, what the user said.
      plan: payload.plan || null,
      findings: payload.findings || [],
      page_content: payload.page_content || null,
      site_hints: payload.site_hints || null,
      recent_actions: payload.recent_actions || [],
      user_note: payload.user_note || null,
      preferences: payload.preferences || null,
      elapsed_ms: payload.elapsed_ms || null,
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
        reasoning: raw.reasoning || raw.action.reasoning || "",
        // Which tier of the server's chain answered, so the panel can show a failover.
        tier: raw.tier || null,
        milestoneDone: !!raw.milestone_done,
        confidence: typeof raw.confidence === "number" ? raw.confidence : null,
        findings: raw.findings || null,
        summary: raw.summary || null,
      };
    }
    return raw;
  } finally {
    clearTimeout(tid);
    if (inFlightPlanRequest === ctrl) inFlightPlanRequest = null;
  }
}

/**
 * Asks the server to break the task into milestones. Falls back to the on-device
 * decomposition when the server is unreachable, slow, or answers nonsense.
 */
async function requestPlan(task, pageInfo, settings, siteHints) {
  const local = TaskPlanner.decomposeTask(task);
  local.tier = "on-device";

  /**
   * Removes a navigation the user never asked for.
   *
   * A model asked to plan "find the best laptop and add it to the cart" reasonably picks a
   * shopping site and opens it — reasonably, and wrongly: the user is standing on a page they
   * chose, and navigating away discards it. Observed from a hosted planner: a plan for a task
   * typed on one retailer began "Open Amazon". If the instruction names a site, that site is
   * honoured; if it does not, the task happens where the user already is.
   */
  const dropUnaskedNavigation = (plan) => {
    if (!plan || !plan.milestones) return plan;
    const parsed = TaskPlanner.parseTask(task);
    const onARealPage = /^https?:/i.test(pageInfo?.url || "");
    if (parsed.siteUrl || !onARealPage) return plan;
    const kept = plan.milestones.filter((m) => m.kind !== "navigate");
    if (!kept.length || kept.length === plan.milestones.length) return plan;
    console.log("[agent] dropped a navigation the instruction did not ask for");
    kept.forEach((m, i) => { m.id = i + 1; });
    plan.milestones = kept;
    return plan;
  };
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(serverBase(settings.serverUrl) + "/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        page_info: pageInfo || {},
        preferences: settings.preferences || null,
        site_hints: siteHints || null,
        task_hints: null,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("Server " + res.status);
    const raw = await res.json();
    const milestones = Array.isArray(raw.milestones) ? raw.milestones : [];
    if (!milestones.length) return local;
    // A model returns titles reliably and targets erratically. normalizePlan reads the title
    // for what it means, so a milestone that arrives with a null target still has something
    // the on-device planner can act on.
    return dropUnaskedNavigation(TaskPlanner.normalizePlan({
      goal: raw.goal || task,
      milestones: milestones.map((m, i) => ({
        id: i + 1, kind: m.kind || "act", title: m.title || `Step ${i + 1}`,
        status: "pending", target: m.target || null, note: m.note || null,
      })),
      current: 0,
      tier: raw.tier || "server",
      needs: Array.isArray(raw.needs) ? raw.needs.slice(0, 4) : [],
    }));
  } catch (e) {
    console.warn("[agent] plan request failed, decomposing on-device:", e.message || e);
    return local;
  } finally {
    clearTimeout(tid);
    if (inFlightPlanRequest === ctrl) inFlightPlanRequest = null;
  }
}

/** Asks the server for the completion summary; composes one locally if it cannot answer. */
async function requestSummary(outcome) {
  const local = localSummary(outcome);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 14000);
  try {
    const res = await fetch(serverBase(session.serverUrl) + "/api/agent/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: session.task,
        plan: planForServer(),
        findings: session.findings || [],
        actions: (session.actionLog || []).map(a => ({
          action: a.action, field: a.field, value: typeof a.value === "string" ? a.value.slice(0, 80) : undefined,
          ok: a.ok, mark_id: a.mark_id,
        })),
        progress: session.progress,
        elapsed_ms: Date.now() - (session.startedAt || Date.now()),
        outcome,
        warnings: session.warnings || [],
        page_info: session.pageInfo || {},
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("Server " + res.status);
    const raw = await res.json();
    if (!raw.summary) return local;
    return { summary: String(raw.summary), highlights: Array.isArray(raw.highlights) ? raw.highlights : local.highlights, tier: raw.tier || "server" };
  } catch (e) {
    console.warn("[agent] summary request failed, composing on-device:", e.message || e);
    return local;
  } finally {
    clearTimeout(tid);
  }
}

/** A plain account of the run, from what the client itself observed. */
function localSummary(outcome) {
  const ms = session.plan?.milestones || [];
  const done = ms.filter(m => m.status === "done");
  const bits = [];
  if (ms.length) {
    bits.push(`Completed ${done.length} of ${ms.length} milestone${ms.length === 1 ? "" : "s"}` +
              (done.length ? ": " + done.map(m => m.title.toLowerCase()).slice(0, 5).join("; ") : ""));
  } else {
    const p = session.progress || {};
    if (p.querySubmitted) bits.push("ran the search");
    else if (p.queryLanded) bits.push("typed the query (the site did not run it)");
    if ((p.opened || []).length) bits.push(`opened ${p.opened.length} item(s)`);
    if (p.scrolled) bits.push("scrolled the page");
    if (p.filledAny) bits.push("filled the form");
  }
  const highlights = [];
  for (const a of session.answers || []) if (a) highlights.push(String(a).slice(0, 160));
  const best = TaskPlanner.pickBestItem(session.findings || [], session.settings?.preferences, session.task);
  if (best?.title) highlights.unshift(`Best match: ${best.title}${best.price ? ` at ${best.price}` : ""}${best.rating ? ` (${best.rating})` : ""}`.slice(0, 160));
  const ok = (session.actionLog || []).filter(a => a.ok !== false).length;
  bits.push(`${ok} action${ok === 1 ? "" : "s"} performed`);
  const lead = { success: "Done.", partial: "Partly done.", stopped: "Stopped.", failed: "Could not complete the task." }[outcome] || "Finished.";
  return { summary: `${lead} ${bits.join(". ")}.`, highlights: highlights.slice(0, 5), tier: "on-device" };
}

/** The plan in the server's schema (status is what matters; the rest is pass-through). */
function planForServer() {
  if (!session?.plan) return null;
  return {
    goal: session.plan.goal || session.task,
    milestones: (session.plan.milestones || []).map(m => ({
      id: m.id, title: m.title, kind: m.kind, status: m.status, target: m.target || null, note: m.note || null,
    })),
    current: 0,
  };
}

/**
 * On-device planning, used on every step as the guard's yardstick and as the planner of
 * record whenever the server is unreachable or errors.
 */
function localMockPlan(sess) {
  return TaskPlanner.planNextAction({
    task: sess.task,
    parsed: sess.parsedTask,
    marks: sess.marks,
    filledIds: sess.filledIds,
    pageInfo: sess.pageInfo,
    progress: sess.progress,
    plan: sess.plan,
    findings: sess.findings,
    pageContent: sess.pageContent,
    recentActions: sess.recentActions,
    preferences: sess.settings?.preferences,
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
  // The target's own label is the authority; the planner's prose is a secondary signal, and a
  // noisy one. "Close the login popup blocking the page" is a dismissal, but it contains the
  // word "login" — observed live on Flipkart, that alone stopped the run for approval before a
  // single action had been taken. When the reasoning is plainly about getting an overlay out of
  // the way, and the control itself is not risky, it is not a risk.
  if (RISKY_CLICK_RE.test(reasoning) && !DISMISS_INTENT_RE.test(reasoning)) {
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

  // The workflow plan needs only the task and the page's identity, so it is requested while
  // the scan runs rather than after it — the two together take as long as the slower one.
  let tabPageInfo = {};
  try {
    const u = new URL(tab.url || "");
    tabPageInfo = { title: (tab.title || "").slice(0, 80), url: u.origin + u.pathname, url_path: u.pathname };
  } catch (_) {}
  const siteHintsPromise = SiteMemory.recall(tab.url).catch(() => null);
  const planPromise = siteHintsPromise.then(hints => requestPlan(task, tabPageInfo, settings, hints));

  const scan = await scanTab(tab.id, tab.windowId, settings);

  // FAIL CLOSED: abort the whole request rather than showing/sending anything unredacted.
  if (!scan.redactionOk) {
    session = null;
    throw new Error(
      "Redaction failed — request aborted, nothing was captured or transmitted. " +
      (scan.redactionError || "")
    );
  }

  const [siteHints, plan] = await Promise.all([siteHintsPromise, planPromise]);

  session = {
    task,
    parsedTask: TaskPlanner.parseTask(task),
    // The workflow: ordered milestones, each marked done as the page proves it happened.
    plan,
    // What the instruction has actually achieved so far. The planner reads this to decide
    // whether anything remains to be done, which is what makes the loop terminate.
    progress: {
      navigated: false, searched: false, opened: [], scrolled: false,
      // `searched` means "we typed something"; `queryLanded` means "the search actually ran",
      // verified against the page's fields, URL and title. Only the latter satisfies the goal.
      queryLanded: false, querySubmitted: false, filledAny: false,
      searchOpenAttempts: 0, siteSearchUrlTried: false, fillScrolls: 0,
    },
    // Supervises the planner for this task; recreated per scan so a new task starts clean.
    guard: null,
    // Fields the vault has no equivalent for, set aside to ask about once everything else is
    // done, and the ones already dealt with so the same question is not repeated.
    pendingAsks: [],
    answeredAsks: [],
    consecutiveFailures: 0,
    // Steps spent on the milestone at hand, so one the page cannot satisfy is skipped rather
    // than allowed to consume the run.
    attemptedMilestoneId: null,
    milestoneAttempts: 0,
    lastSkipReason: null,
    scrollToTried: new Set(),
    tabId: tab.id,
    windowId: tab.windowId,
    pendingNewTab: null,
    redacted: scan.redacted,
    redactionOk: true,
    marks: scan.safeMarks,
    markFrames: scan.markFrames,
    pageInfo: scan.pageInfo,
    filledIds: [],
    actionLog: [],
    // What was read and concluded along the way, and the last few actions in the shape the
    // planner is shown (labels only).
    findings: [],
    answers: [],
    pageContent: null,
    lastReadUrl: null,
    recentActions: [],
    warnings: [],
    userNote: null,
    siteHints,
    confidence: null,
    result: null,
    startedAt: null,
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
    plan: publicPlan(),
    siteHints,
  };
}

/** The plan as the panel renders it. */
function publicPlan() {
  if (!session?.plan) return null;
  return {
    goal: session.plan.goal, tier: session.plan.tier || null, needs: session.plan.needs || [],
    milestones: (session.plan.milestones || []).map(m => ({ id: m.id, title: m.title, kind: m.kind, status: m.status, note: m.note || null })),
  };
}

// ── Run budgets ───────────────────────────────────────────────────────────────
//
// Two independent ceilings. The step budget stops one wedged await (a page that never fires
// `load`, a hosted model that stalls) from hanging the whole agent; the run budget stops a
// task that is technically progressing but will never finish from running forever.
// 6 minutes. Generous, because the guard's stall and repeat rules already stop a run that is
// going nowhere long before this — the budget exists for the case they cannot see, such as a
// page that keeps genuinely changing while making no progress on the task.
const RUN_BUDGET_MS = 360000;
const STEP_BUDGET_MS = 45000;
const MAX_STEPS = 40;
const MAX_CONSECUTIVE_FAILURES = 3;

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
    SiteMemory.remember(session.pageInfo?.url || "", { dismissed: res.labels || [] }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    return true;
  }
  return false;
}

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
 * Finds the element that now plays the role a vanished target used to.
 *
 * "Element not found" is a stale id, not a dead end. The label the planner was aiming at is
 * still known; a fresh scan usually contains a control with the same purpose under a new id —
 * a re-rendered button, a renamed "Continue" that is now "Proceed". Match by purpose, prefer
 * the same role, and let the caller retry once.
 *
 * @returns {Object|null} a mark from the current scan
 */
function findEquivalentMark(label, role) {
  const want = String(label || "").trim();
  if (!want) return null;
  const done = new Set((session.filledIds || []).map(String));
  const pool = (session.marks || []).filter((m) => !done.has(String(m.id)) && m.label);
  const sameRole = pool.filter((m) => !role || m.role === role || (role.startsWith("input") && m.role.startsWith("input")));
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const exact = sameRole.find((m) => norm(m.label) === norm(want));
  if (exact) return exact;
  const byPurpose = sameRole.find((m) => TaskPlanner.labelMatches(want, m.label)) ||
                    pool.find((m) => TaskPlanner.labelMatches(want, m.label));
  return byPurpose || null;
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

// ── Workflow bookkeeping ──────────────────────────────────────────────────────

function currentMilestone() {
  return TaskPlanner.currentMilestone(session?.plan);
}
function currentKind() {
  return currentMilestone()?.kind || null;
}
/** The query this run is trying to search for, if a search is the business at hand. */
function activeQuery() {
  const m = currentMilestone();
  if (session.plan?.milestones?.length) return m && m.kind === "search" ? (m.target || session.parsedTask?.query) : null;
  return session.parsedTask?.query || null;
}
/** Is the run in the middle of filling a form? */
function fillMode() {
  if (session.plan?.milestones?.length) return currentKind() === "fill";
  return !!session.parsedTask?.wantsFill;
}

function markMilestoneDone(reason) {
  const m = currentMilestone();
  if (!m) return;
  m.status = "done";
  m.finishedAt = Date.now();
  const next = currentMilestone();
  if (next) next.status = "active";
  notifyPopup({ type: "milestone", plan: publicPlan(), done: m.title, reason: reason || "" });
}

/** How many steps in a row have been spent on the milestone at hand without finishing it. */
const MAX_MILESTONE_ATTEMPTS = 4;

/**
 * Gives up on the milestone at hand and moves to the next one.
 *
 * Some milestones are a means, not the goal. A plan may include "apply a price filter" on a
 * site that has no such filter, or "open the account menu" on a page that has none. Retrying
 * it burns the run's whole step budget and ends with nothing done — observed exactly that: a
 * plan with an "Apply price filter" milestone spent three steps looking for a control the page
 * did not have, tripped the failure breaker, and never reached the four milestones after it,
 * every one of which the page could have satisfied.
 *
 * So a milestone that cannot be advanced is skipped, said out loud, and recorded as a warning
 * so the completion screen is honest about it.
 */
function skipMilestone(why) {
  const m = currentMilestone();
  if (!m) return false;
  m.status = "skipped";
  m.note = why || m.note;
  const next = currentMilestone();
  if (next) next.status = "active";
  session.warnings.push(`Skipped "${m.title}" — ${why || "this page offers no way to do it"}.`);
  // Skipping the LAST milestone ends the run, and a run that ends with nothing said reads as a
  // silent failure. Carry the reason so the completion card can state it.
  session.lastSkipReason = `Could not ${m.title.toLowerCase()} — ${why || "this page offers no way to do it"}.`;
  stepStatus(`Could not do "${m.title}" here — moving on.`);
  notifyPopup({ type: "milestone", plan: publicPlan(), skipped: m.title, reason: why || "" });
  session.milestoneAttempts = 0;
  session.consecutiveFailures = 0;
  session.guard?.resetStall();
  return true;
}

/**
 * Counts steps spent on the current milestone, and skips it once it is clearly stuck.
 * @returns {boolean} true when the milestone was abandoned and the loop should carry on
 */
function noteMilestoneAttempt() {
  const m = currentMilestone();
  if (!m) return false;
  if (session.attemptedMilestoneId !== m.id) {
    session.attemptedMilestoneId = m.id;
    session.milestoneAttempts = 0;
  }
  session.milestoneAttempts = (session.milestoneAttempts || 0) + 1;
  if (session.milestoneAttempts <= MAX_MILESTONE_ATTEMPTS) return false;
  // The last milestone is the point of the task; abandoning it silently would be worse than
  // stopping. Everything before it is a step on the way, and the way can change.
  const isLast = currentMilestone() === (session.plan.milestones || []).slice(-1)[0];
  if (isLast && m.kind !== "act") return false;
  return skipMilestone(`${MAX_MILESTONE_ATTEMPTS} attempts made no progress on this page`);
}

/**
 * Marks milestones done that the page itself has proved: the site was reached, the query
 * landed, the page scrolled. Everything else is completed by the planner saying so, or by
 * the on-device planner's own verdict.
 */
function advanceMilestones() {
  if (!session.plan?.milestones?.length) return;
  let guard = 0;
  while (guard++ < 10) {
    const m = currentMilestone();
    if (!m) return;
    if (m.status === "pending") m.status = "active";
    const p = session.progress;
    const url = session.pageInfo?.url || "";
    if (m.kind === "navigate" && (p.navigated || (m.target && TaskPlanner.alreadyOnSite(url, m.target)))) {
      markMilestoneDone("on the site");
      continue;
    }
    if (m.kind === "search" && p.queryLanded && p.querySubmitted) {
      markMilestoneDone("the search ran");
      continue;
    }
    if (m.kind === "scroll" && p.scrolled) {
      markMilestoneDone("scrolled");
      continue;
    }
    return;
  }
}

/** Records an action in the shape the planner is shown next step: type, target label, outcome. */
function noteAction(type, markId, ok, note) {
  const mark = (session.marks || []).find(m => String(m.id) === String(markId));
  session.recentActions = session.recentActions || [];
  session.recentActions.push({ type, label: mark?.label || null, ok: ok !== false, note: note ? String(note).slice(0, 80) : undefined });
  session.recentActions = session.recentActions.slice(-8);
}

/** Notifies the panel of a step, with the planner's name and confidence attached. */
function stepStatus(status, planner, confidence) {
  notifyPopup({ type: "step", step: session.stepCount, status, planner: planner || undefined,
                confidence: typeof confidence === "number" ? confidence : undefined });
}

// ── PHASE 2: the agent loop ───────────────────────────────────────────────────
async function phaseRun() {
  if (!session) throw new Error("Run Scan first.");

  const runDeadline = Date.now() + RUN_BUDGET_MS;
  session.guard = session.guard || AgentGuard.createGuard(session.parsedTask);
  session.startedAt = session.startedAt || Date.now();
  if (!session.plan) {
    session.plan = TaskPlanner.decomposeTask(session.task);
    session.plan.tier = "on-device";
  }
  const guard = session.guard;

  // Every way the loop can end is routed through here so the completion screen is uniform:
  // outcome, summary, findings, timing, warnings, and the run is written to history.
  const finish = async (outcome, extra = {}) => {
    const elapsedMs = Date.now() - (session.startedAt || Date.now());
    stepStatus("Writing the summary...");
    const s = await requestSummary(outcome);
    const result = {
      outcome, elapsedMs,
      summary: s.summary, highlights: s.highlights || [], summaryTier: s.tier || null,
      findings: session.findings || [],
      answers: session.answers || [],
      actions: (session.actionLog || []).length,
      failedActions: (session.actionLog || []).filter(a => a.ok === false).length,
      warnings: session.warnings || [],
      pageUrl: session.pageInfo?.url || "",
    };
    session.result = result;
    try {
      await SiteMemory.recordTask({
        task: session.task, url: session.pageInfo?.url || "", outcome, summary: s.summary,
        highlights: s.highlights, elapsedMs, steps: session.stepCount, startedAt: session.startedAt,
        milestones: session.plan?.milestones || [],
      });
      if (outcome === "success") await SiteMemory.remember(session.pageInfo?.url || "", { success: true });
    } catch (e) {
      console.warn("[agent] could not record the run:", e);
    }
    notifyPopup({ type: "result", result, plan: publicPlan() });
    return {
      done: true, needsConfirm: false, actionLog: session.actionLog,
      progress: session.progress, plan: publicPlan(), result, ...extra,
    };
  };
  const outcomeFor = () => {
    const ms = session.plan?.milestones || [];
    if (!ms.length) return session.progress.querySubmitted || session.progress.scrolled || session.progress.filledAny || (session.progress.opened || []).length ? "success" : "partial";
    const done = ms.filter(m => m.status === "done").length;
    return done === ms.length ? "success" : done ? "partial" : "failed";
  };
  // A pause for the user is not an ending; the run resumes from here.
  const pause = (extra) => ({
    done: false, actionLog: session.actionLog, progress: session.progress, plan: publicPlan(), ...extra,
  });

  agentBusy = true;
  const stopKeepAlive = startKeepAlive();
  try {
    // Anything covering the page swallows every subsequent click, so clear it once per run.
    await dismissOverlaysOnce();

    while (session.stepCount < MAX_STEPS) {
      if (stopRequested) {
        stopRequested = false;
        stepStatus("Stopped by user.");
        return await finish("stopped", { stopped: true });
      }

      if (Date.now() > runDeadline) {
        const left = currentMilestone()?.title || AgentGuard.describeRemaining(session.parsedTask, session.progress);
        stepStatus("Time budget reached.");
        return await finish(outcomeFor() === "success" ? "success" : "partial", {
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
        const q = activeQuery();
        if (q && !session.progress.queryLanded && await trySiteSearchUrl(q)) {
          session.consecutiveFailures = 0;
          continue;
        }
        // Failing repeatedly at one milestone is not a reason to abandon the ones after it.
        if (currentMilestone() && skipMilestone("the page did not respond to any attempt")) continue;
        stepStatus("Stopped: too many failed actions in a row.");
        session.warnings.push("Three actions in a row failed — the page kept changing under the plan.");
        return await finish(outcomeFor() === "success" ? "success" : "partial", {
          error: `Stopped after ${MAX_CONSECUTIVE_FAILURES} failed actions in a row — the page changed under the plan.`,
        });
      }

      session.stepCount++;
      const stepDeadline = Date.now() + STEP_BUDGET_MS;
      stepStatus("Reading the page...");

      if (!session.marks || session.marks.length === 0) {
        await rescanCurrentTab(false);
        if (!session.marks || session.marks.length === 0) {
          return await finish("failed", { error: "No interactive elements detected on this page." });
        }
      }

      // FAIL CLOSED: never plan a step without a verified redacted frame.
      if (!session.redactionOk || !session.redacted) {
        return await finish("failed", { error: "Redaction unavailable — loop stopped without transmitting anything." });
      }

      // A verification wall means the site has decided it does not want to be automated.
      // Respect that, and say so, rather than spending steps against a page that cannot work.
      const wall = await detectBotWall();
      if (wall) {
        stepStatus("Stopped: " + wall + ".");
        session.warnings.push(`The site asked for human verification (${wall}).`);
        return pause({
          needsUser: { kind: "captcha", message: `${wall[0].toUpperCase()}${wall.slice(1)}. Complete it on the page, then press Continue.` },
          botWall: true,
        });
      }

      // Milestones the page has already proved are marked before planning, so no tier is
      // asked to do something that has demonstrably happened.
      advanceMilestones();

      // ...and a milestone that has had its chances is abandoned rather than allowed to
      // consume the run. The steps after it may well be achievable.
      if (noteMilestoneAttempt()) continue;

      // Finished? Then stop here, without a planning round trip.
      //
      // The guard would reject whatever came back anyway (rule 0), so asking costs a hosted
      // model call — several seconds, and on a chain with rate-limited tiers considerably more
      // — to be told something already known. Measured on a one-step search this was most of
      // the wall clock: the search ran on step 1 and step 2 existed only to be overruled.
      if (AgentGuard.goalFullyVerified(session.parsedTask, session.progress, session.plan)) {
        const summary = AgentGuard.describeCompletion(session.parsedTask, session.progress, session.plan);
        stepStatus(summary);
        // outcomeFor(), not "success": a plan whose milestones were skipped rather than done
        // has nothing outstanding either, and calling that a success would be a lie.
        const skipped = outcomeFor() !== "success" ? session.lastSkipReason : null;
        return await finish(outcomeFor(), skipped ? { error: skipped } : {});
      }

      // The on-device plan is computed every step. It is both the offline fallback and the
      // yardstick the guard uses when the cloud planner stops early or repeats itself.
      let deterministic = null;
      try { deterministic = localMockPlan(session); } catch (e) { console.warn("[agent] local plan failed:", e); }

      // A search task with nothing usable to type into: reveal the site's search box first.
      //
      // "Nothing usable" is not only "no text field on the page". A modal over the page leaves
      // its fields tagged and unreachable, and a site whose search is behind a button has the
      // field mounted only after the click. Both look like a page with inputs and no way in.
      const query = activeQuery();
      if (query && !session.progress.queryLanded &&
          (noSearchBoxVisible() || (session.milestoneAttempts || 0) >= 2) &&
          (session.progress.searchOpenAttempts || 0) < 2) {
        const opened = await tryOpenSearchAffordance();
        session.actionLog.push({ action: "open_search", ok: opened, serverMs: 0 });
        if (opened) continue;
        // No box could be revealed. Before giving up on the search, try the URL the site
        // publishes for searching — on MDN that is the only route that exists.
        if (noSearchBoxVisible() && await trySiteSearchUrl(query)) continue;
        // Still nothing — fall through and let the planner try something else.
      }

      stepStatus("Asking the planner...");

      let resp;
      let plannerSource = "server";
      const t0 = performance.now();
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
          plan: planForServer(),
          findings: session.findings,
          page_content: session.pageContent,
          site_hints: session.siteHints,
          recent_actions: recentActionsForServer(),
          user_note: session.userNote,
          preferences: session.settings?.preferences || null,
          elapsed_ms: Date.now() - session.startedAt,
        }, session.serverUrl);
      } catch (e) {
        if (stopRequested) {
          stopRequested = false;
          stepStatus("Stopped by user.");
          return await finish("stopped", { stopped: true });
        }
        console.warn("[agent] server call failed, planning on-device instead:", e);
        resp = deterministic || { action: "done", reasoning: "No planner available." };
        plannerSource = "on-device";
      }
      const serverMs = Math.round(performance.now() - t0);
      // A note from the user applies to the step that follows it, not to every step after.
      session.userNote = null;

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
        plan: session.plan,
      });
      if (verdict.reason) {
        console.log("[agent][guard]", verdict.reason);
        stepStatus(verdict.reason);
      }
      if (verdict.stop) {
        session.warnings.push(verdict.reason);
        return await finish(outcomeFor() === "success" ? "success" : "partial", { error: verdict.reason, guard: guard.stats });
      }

      resp = verdict.action;
      const actionType = (resp.action || resp.type || "").toString().toLowerCase();
      session.lastAction = resp;
      const planner = resp.tier || plannerSource;
      const confidence = verdict.substituted ? 0.45 : (typeof resp.confidence === "number" ? resp.confidence : (plannerSource === "on-device" ? 0.5 : null));
      session.confidence = confidence;
      if (!verdict.reason) {
        stepStatus(`${actionType}${resp.reasoning ? ": " + resp.reasoning : ""}`, planner, confidence);
      }

      // A form with nothing left to fill but a question outstanding: ask before doing anything
      // else. Otherwise the planner moves on to whatever is next on the page — observed live,
      // a privacy-notice link — and the field it set aside is quietly forgotten.
      if (actionType !== "done" && fillMode() &&
          !AgentGuard.unfilledFields(session.marks, session.filledIds).length) {
        const pending = nextPendingAsk();
        if (pending) {
          stepStatus(`Need your ${pending.fieldLabel} to finish.`);
          return pause({
            needsInput: true, fieldKey: pending.fieldKey, fieldLabel: pending.fieldLabel,
            action: { action: "type", mark_id: pending.mark_id },
          });
        }
      }

      // ── TERMINAL: "done" stops the loop. It is never forwarded to the executor. ──────────
      if (!actionType || actionType === "done") {
        // Before believing a form is finished, check whether the rest of it is simply below
        // the fold. Tagging is viewport-only, so "no fields left" can mean "no fields visible".
        if (fillMode() && await scrollForMoreFields()) {
          stepStatus("More fields below — continuing.");
          continue;
        }
        // Everything that could be filled has been. Now ask about the fields that were set
        // aside because the vault has no equivalent for them.
        const ask = nextPendingAsk();
        if (ask) {
          stepStatus(`Need your ${ask.fieldLabel} to finish.`);
          return pause({
            needsInput: true, fieldKey: ask.fieldKey, fieldLabel: ask.fieldLabel,
            action: { action: "type", mark_id: ask.mark_id },
          });
        }
        if (fillMode() && session.progress.filledAny && currentMilestone()?.kind === "fill") {
          markMilestoneDone("form filled");
          if (currentMilestone()) continue;
        }
        if (resp.summary) session.answers.push(resp.summary);
        // A planner saying "done" with milestones still outstanding is answering about the
        // milestone in front of it, not about the task. Skipping it and carrying on is what a
        // person would do; ending the run here is what stopped a five-stage journey at two.
        // Bounded: every skip advances the plan, so this cannot loop.
        if (currentMilestone() && (session.plan.milestones || []).some((m) => m.status === "pending")) {
          if (skipMilestone(resp.reasoning || "nothing on this page could advance it")) continue;
        }
        const left = currentMilestone()?.title || AgentGuard.describeRemaining(session.parsedTask, session.progress);
        stepStatus("Finished: " + (resp.reasoning || "task complete"));
        if (left) session.warnings.push(`Not completed: ${left}.`);
        return await finish(outcomeFor(), { error: verdict.reason || (left ? `Could not complete: ${left}.` : undefined) });
      }

      // ── Workflow-level actions: no DOM involved. ──
      if (actionType === "next_milestone") {
        const m = currentMilestone();
        // `milestoneStuck` distinguishes "this is achieved" from "nothing here can achieve
        // it". Both move the workflow on; only the second is a warning worth reporting.
        if (resp.milestoneStuck) {
          // ...but not on the first look. A page that has just loaded, or that is under a
          // login modal, routinely presents no usable control for one scan and every control a
          // moment later. Observed live: Flipkart's only milestone was abandoned on step one
          // and the run ended in 2.7 seconds having done nothing. A milestone has to be tried
          // properly before it is given up on; noteMilestoneAttempt() ends it for good after
          // four steps either way.
          if ((session.milestoneAttempts || 0) < 2) {
            stepStatus(`${resp.reasoning} — looking again.`);
            await new Promise(r => setTimeout(r, 600));
            await rescanCurrentTab(false, "retry");
            continue;
          }
          if (!skipMilestone(resp.reasoning)) {
            return await finish(outcomeFor(), { error: resp.reasoning });
          }
        } else {
          markMilestoneDone(resp.reasoning);
        }
        session.actionLog.push({ action: "milestone", value: m?.title, skipped: !!resp.milestoneStuck, serverMs, ok: true });
        noteAction("next_milestone", null, true, m?.title);
        guard.record("next_milestone", m?.id, null, true);
        continue;
      }

      if (actionType === "read_page") {
        const content = await readPageContent();
        const ok = !!content;
        noteAction("read_page", null, ok, ok ? `${(content.items || []).length} items` : "failed");
        guard.record("read_page", null, session.pageInfo?.url, ok);
        noteResult(session, ok);
        session.actionLog.push({ action: "read_page", serverMs, ok, items: ok ? (content.items || []).length : 0 });
        if (ok) {
          session.pageContent = content;
          session.lastReadUrl = session.pageInfo?.url || null;
          const n = (content.items || []).length;
          stepStatus(n ? `Read ${n} item${n === 1 ? "" : "s"} from the page.` : "Read the page.");
          notifyPopup({ type: "read", items: n, tables: (content.tables || []).length });
        } else {
          stepStatus("Could not read the page content.");
        }
        continue;
      }

      if (actionType === "answer") {
        const m = currentMilestone();
        const text = String(resp.value || "").trim();
        const f = resp.findings && (resp.findings.items?.length || resp.findings.text)
          ? { kind: resp.findings.kind || "items", title: resp.findings.title || m?.title || "Findings", milestone: m?.id || null,
              items: (resp.findings.items || []).slice(0, 25), text: resp.findings.text || null }
          : (session.pageContent && (session.pageContent.items || []).length
              ? { kind: "items", title: m?.title || "Findings", milestone: m?.id || null, items: session.pageContent.items.slice(0, 20), text: null }
              : null);
        if (f) session.findings.push(f);
        if (text) session.answers.push(text);
        session.pageContent = null;
        noteAction("answer", null, true, text.slice(0, 60));
        guard.record("answer", m?.id, text, true);
        noteResult(session, true);
        session.actionLog.push({ action: "answer", value: text.slice(0, 200), serverMs, ok: true });
        notifyPopup({ type: "answer", text, findings: f });
        stepStatus(text ? `Concluded: ${text.slice(0, 120)}` : "Recorded the findings.");
        if (m && (resp.milestoneDone || m.kind === "read" || m.kind === "answer")) markMilestoneDone("answered");
        continue;
      }

      // ── Navigate to URL ──
      if (actionType === "navigate" && resp.value) {
        if (resp.value === session.lastNavUrl) {
          session.warnings.push("The planner asked to open the same URL twice.");
          return await finish(outcomeFor(), { error: "The planner asked to navigate to the same URL twice." });
        }
        session.lastNavUrl = resp.value;
        stepStatus("Navigating to " + resp.value);
        session.actionLog.push({ action: "navigate", value: resp.value, serverMs, ok: true });
        session.progress.navigated = true;
        if (resp.openTarget) session.progress.opened.push(resp.openTarget);
        noteAction("navigate", null, true, resp.value.slice(0, 60));
        guard.record("navigate", null, resp.value, true);
        guard.resetStall();
        chrome.tabs.update(session.tabId, { url: resp.value });
        // Never pass a negative or tiny budget: a step that has already overrun would otherwise
        // abandon the navigation the instant it started.
        await withDeadlineSoft(waitForTabLoad(session.tabId),
                               Math.max(8000, stepDeadline - Date.now()), "navigation");
        await dismissOverlaysOnce();
        await rescanCurrentTab(true);
        if (resp.milestoneDone) markMilestoneDone("navigated");
        continue;
      }

      // ── Open new tab ──
      if (actionType === "open_tab" && resp.value) {
        stepStatus("Opening " + resp.value);
        session.actionLog.push({ action: "open_tab", value: resp.value, serverMs, ok: true });
        noteAction("open_tab", null, true, resp.value.slice(0, 60));
        const newTabId = await withDeadlineSoft(openTab(resp.value), 20000, "open tab");
        if (newTabId) {
          session.tabId = newTabId;
          const newTab = await new Promise(r => chrome.tabs.get(newTabId, r));
          session.windowId = newTab.windowId;
          guard.resetStall();
          await dismissOverlaysOnce();
          await rescanCurrentTab(true);
        }
        if (resp.milestoneDone) markMilestoneDone("opened");
        continue;
      }

      // ── Scroll to text ──
      if (actionType === "scroll_to") {
        // Looking for the same words twice means they are not on this page, whatever a planner
        // believes. The second attempt is what turned a missing price filter into a dead run.
        const wanted = String(resp.value || "").toLowerCase();
        session.scrollToTried = session.scrollToTried || new Set();
        if (session.scrollToTried.has(wanted)) {
          stepStatus(`"${String(resp.value).slice(0, 40)}" is not on this page.`);
          if (skipMilestone(`"${String(resp.value).slice(0, 60)}" is not on this page`)) continue;
          return await finish(outcomeFor(), { error: `Could not find "${resp.value}" on this page.` });
        }
        session.scrollToTried.add(wanted);

        const exec = await withDeadlineSoft(
          executeMarkAction("scroll_to", null, resp.value), 8000, "scroll_to", { ok: false, error: "scroll_to timed out." });
        const ok = !!exec?.ok;
        noteResult(session, ok);
        noteAction("scroll_to", null, ok, ok ? `found "${String(resp.value).slice(0, 40)}"` : (exec?.error || "not found"));
        guard.record("scroll_to", null, resp.value, ok);
        session.actionLog.push({ action: "scroll_to", value: String(resp.value || "").slice(0, 80), serverMs, ok, error: ok ? undefined : exec?.error });
        stepStatus(ok ? `Brought "${String(resp.value).slice(0, 50)}" into view.` : `Could not find "${String(resp.value).slice(0, 50)}" on the page.`);
        await new Promise(r => setTimeout(r, 350));
        await rescanCurrentTab(false, "scrolled");
        if (ok && resp.milestoneDone) markMilestoneDone("found");
        continue;
      }

      // ── Upload: a file chooser is the one control an extension cannot drive. ──
      if (actionType === "upload") {
        const mark = (session.marks || []).find(m => String(m.id) === String(resp.mark_id));
        stepStatus("This step needs a file from you.");
        return pause({
          needsUser: {
            kind: "file",
            message: `The page wants a file${mark?.label ? ` for "${mark.label}"` : ""}. Choose it on the page yourself, then press Continue.`,
          },
        });
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
          stepStatus(`Need your ${fieldKey} to continue.`);
          return pause({
            needsInput: true, fieldKey,
            fieldLabel: mark?.label || fieldKey,
            action: resp,
          });
        }

        let exec = await withDeadlineSoft(
          executeMarkAction("type", resp.mark_id, value || ""), 20000, "type action",
          { ok: false, error: "Typing timed out." });
        exec = await retryOnEquivalent("type", resp, exec, value || "");

        let typedOk = !!exec?.ok;
        const isSearch = !fieldKey && !!query && !!value;

        // A search: let it commit, re-read the page, then check whether the query actually
        // landed. Only that check may set `queryLanded`, which is what `done` is judged
        // against — "we typed something" is not the same claim, and conflating the two is what
        // let the agent report success on a page where nothing had run.
        if (isSearch && (typedOk || exec?.noReply)) {
          session.progress.searched = true;
          await new Promise(r => setTimeout(r, 900));
          await withDeadlineSoft(waitForTabLoad(session.tabId, 6000), 8000, "search settle");
          await adoptNewTabIfAny();
          await rescanCurrentTab(await didUrlChange());
          let landing = await probeQueryLanded(query);

          // The text is in a field but nothing ran. Press Enter directly on that field once
          // more — the typing sequence and the submit escalation can both be swallowed by a
          // suggestion dropdown that opens between them.
          if (landing.landed && !landing.strong) {
            stepStatus("Submitting the search...");
            await withDeadlineSoft(executeMarkAction("press_key", resp.mark_id, "Enter"), 8000, "submit search");
            await withDeadlineSoft(waitForTabLoad(session.tabId, 5000), 7000, "submit settle");
            await rescanCurrentTab(await didUrlChange());
            landing = await probeQueryLanded(query);
          }

          // The box swallowed the text and ran nothing. Fall back to the site's published
          // search URL rather than leaving a typed query sitting in a dead field.
          if (landing.landed && !landing.strong) {
            if (await trySiteSearchUrl(query)) {
              landing = { landed: true, strong: true };
            }
          }

          session.progress.queryLanded = landing.landed;
          session.progress.querySubmitted = landing.strong;

          // Submitting a search navigates, and a navigation destroys the content script before
          // it can answer. Silence plus a landed query is a success, not a failure.
          if (!typedOk && exec?.noReply && landing.landed) typedOk = true;

          stepStatus(landing.strong ? `Search for "${query}" ran.`
                   : landing.landed ? `Typed "${query}" — the page has not run the search.`
                   : `Typed "${query}" but it did not reach a search box.`);
          if (landing.strong) {
            const box = (session.marks || []).find(m => String(m.id) === String(resp.mark_id));
            SiteMemory.remember(session.pageInfo?.url || "", { searchLabel: box?.label || exec?.label || null, note: "search ran from the search box" }).catch(() => {});
          }
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
        noteAction("type", resp.mark_id, typedOk, fieldKey ? `vault:${fieldKey}` : (isSearch ? "search query" : "text"));
        guard.record("type", resp.mark_id, value, typedOk);
        if (typedOk) {
          session.filledIds.push(resp.mark_id);
          if (fieldKey) session.progress.filledAny = true;
          if (resp.milestoneDone && !isSearch) markMilestoneDone("typed");
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
        await adoptNewTabIfAny();
        const navigated = await didUrlChange();
        // Enter on a form submits and navigates, which silences the frame mid-reply.
        const keyOk = !!exec?.ok || (exec?.noReply && navigated);
        noteResult(session, keyOk);
        noteAction("press_key", resp.mark_id, keyOk, resp.value || "Enter");
        guard.record("press_key", resp.mark_id, resp.value, keyOk);
        session.actionLog.push({ action: "press_key", value: resp.value, mark_id: resp.mark_id, serverMs, ok: keyOk });
        await rescanCurrentTab(navigated);
        const q2 = activeQuery();
        if (q2 && !session.progress.queryLanded) {
          const l = await probeQueryLanded(q2);
          session.progress.queryLanded = l.landed;
          session.progress.querySubmitted = l.strong;
        }
        if (keyOk && resp.milestoneDone) markMilestoneDone("key pressed");
        continue;
      }

      // ── Select dropdown ──
      if (actionType === "select") {
        let exec = await withDeadlineSoft(
          executeMarkAction("select", resp.mark_id, resp.value), 12000, "select",
          { ok: false, error: "select timed out." });
        exec = await retryOnEquivalent("select", resp, exec, resp.value);
        noteResult(session, !!exec?.ok);
        noteAction("select", resp.mark_id, !!exec?.ok, resp.value);
        guard.record("select", resp.mark_id, resp.value, !!exec?.ok);
        if (exec?.ok) { session.filledIds.push(resp.mark_id); session.progress.filledAny = true; }
        session.actionLog.push({ action: "select", value: resp.value, mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });
        if (exec?.ok) {
          await new Promise(r => setTimeout(r, 400));
          await rescanCurrentTab(false, "selected");
          if (resp.milestoneDone) markMilestoneDone("selected");
        } else {
          await recoverAfterFailedAction(exec?.error);
        }
        continue;
      }

      // ── Scroll ──
      if (actionType === "scroll_page" || actionType === "scroll") {
        const exec = await withDeadlineSoft(
          executeMarkAction(actionType, resp.mark_id, resp.value || 600), 10000, "scroll",
          { ok: false, error: "scroll timed out." });
        noteResult(session, !!exec?.ok);
        noteAction("scroll_page", null, !!exec?.ok, exec?.moved === false ? "already at the bottom" : undefined);
        guard.record(actionType, resp.mark_id, resp.value, !!exec?.ok);
        // `moved === false` means the page is already at the bottom. Treat the scroll request
        // as satisfied rather than asking again forever.
        if (exec?.ok) session.progress.scrolled = true;
        session.actionLog.push({ action: "scroll", serverMs, ok: !!exec?.ok, moved: exec?.moved });
        if (exec && exec.moved === false) {
          stepStatus("Reached the bottom of the page.");
        }
        await new Promise(r => setTimeout(r, 400));
        await rescanCurrentTab(false);
        if (exec?.ok && resp.milestoneDone && currentKind() !== "scroll") markMilestoneDone("scrolled");
        continue;
      }

      // ── Click ──
      if (actionType === "click") {
        const risk = assessClickRisk(resp, session);
        if (risk.needsConfirm) {
          stepStatus("Awaiting approval: " + risk.reason);
          return pause({ needsConfirm: true, confirmReason: risk.reason, action: resp });
        }

        let exec = await withDeadlineSoft(
          executeMarkAction("click", resp.mark_id, resp.value), 15000, "click",
          { ok: false, error: "click timed out." });
        exec = await retryOnEquivalent("click", resp, exec, resp.value);

        // Clicking a link is the most likely action of all to navigate, so the same rule as
        // typing applies: silence from a frame that has just been replaced is not a failure.
        let clickOk = !!exec?.ok;
        if (clickOk || exec?.noReply) {
          const navigated = await settleAfterNavAction("click");
          if (!clickOk && exec?.noReply && navigated) clickOk = true;
          const q3 = activeQuery();
          if (q3 && !session.progress.queryLanded) {
            const l = await probeQueryLanded(q3);
            session.progress.queryLanded = l.landed;
            session.progress.querySubmitted = l.strong;
          }
        }

        noteResult(session, clickOk);
        noteAction("click", resp.mark_id, clickOk, clickOk ? undefined : exec?.error);
        guard.record("click", resp.mark_id, resp.value, clickOk);
        if (clickOk) {
          session.filledIds.push(resp.mark_id);
          if (resp.openTarget) session.progress.opened.push(resp.openTarget);
          if (resp.milestoneDone) markMilestoneDone("clicked");
        }
        session.actionLog.push({ action: "click", mark_id: resp.mark_id, label: exec?.label || labelOf(resp.mark_id), serverMs, ok: clickOk, error: clickOk ? undefined : exec?.error });
        stepStatus(clickOk ? `Clicked "${labelOf(resp.mark_id) || "#" + resp.mark_id}"` : `Click on #${resp.mark_id} failed: ${exec?.error || "unknown"}`);
        if (!clickOk) await recoverAfterFailedAction(exec?.error);
        continue;
      }

      // ── Any other action (clear / hover / focus / wait / …) — execute directly ──
      const exec = await withDeadlineSoft(
        executeMarkAction(actionType, resp.mark_id, resp.value), 12000, actionType,
        { ok: false, error: `${actionType} timed out.` });
      noteResult(session, !!exec?.ok);
      noteAction(actionType, resp.mark_id, !!exec?.ok);
      guard.record(actionType, resp.mark_id, resp.value, !!exec?.ok);
      session.actionLog.push({ action: actionType, mark_id: resp.mark_id, serverMs, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });
      if (exec?.ok && NAV_ACTIONS.has(actionType)) await settleAfterNavAction(actionType);
      else if (!exec?.ok) await recoverAfterFailedAction(exec?.error);
      if (exec?.ok && resp.milestoneDone) markMilestoneDone(actionType);
    }

    const left = currentMilestone()?.title || AgentGuard.describeRemaining(session.parsedTask, session.progress);
    if (left) session.warnings.push(`Reached the ${MAX_STEPS}-step limit with "${left}" outstanding.`);
    return await finish(outcomeFor(), { error: left ? `Reached the ${MAX_STEPS}-step limit. Not completed: ${left}.` : undefined });
  } finally {
    agentBusy = false;
    stopKeepAlive();
  }
}

/** The label of a mark in the current scan, for messages. */
function labelOf(markId) {
  const m = (session?.marks || []).find(x => String(x.id) === String(markId));
  return m?.label || "";
}

/**
 * When an action could not find its element, re-read the page and try the element that now
 * serves the same purpose — once. The panel is told what happened in plain words, because
 * "element not found" says nothing a person can act on.
 */
async function retryOnEquivalent(actionType, resp, exec, value) {
  if (exec?.ok || !/not found|no longer visible/i.test(String(exec?.error || ""))) return exec;
  const wanted = labelOf(resp.mark_id) || resp.label || "";
  const role = (session.marks || []).find(m => String(m.id) === String(resp.mark_id))?.role;
  stepStatus(`The expected ${wanted ? `"${wanted}"` : "element"} changed. Searching for an equivalent action...`);
  notifyPopup({ type: "recovery", message: `The expected ${wanted ? `"${wanted}"` : "element"} changed — looking for an equivalent.` });
  await rescanCurrentTab(false, "recovery");
  const alt = findEquivalentMark(wanted, role);
  if (!alt) {
    stepStatus("No equivalent element found on the page.");
    return exec;
  }
  stepStatus(`Found matching action: "${alt.label}". Continuing workflow.`);
  notifyPopup({ type: "recovery", message: `Found a matching control: "${alt.label}". Continuing.` });
  resp.mark_id = alt.id;
  const again = await withDeadlineSoft(
    executeMarkAction(actionType, alt.id, value), 15000, `${actionType} (retry)`, { ok: false, error: `${actionType} retry timed out.` });
  if (again) again.label = alt.label;
  return again;
}

/** Reads what the page says, from the top frame. @returns {Object|null} */
async function readPageContent() {
  await ensureContent(session.tabId);
  const res = await withDeadlineSoft(
    msgTab(session.tabId, { type: "READ_PAGE" }, { frameId: 0 }), 8000, "read page");
  if (!res || !res.ok) return null;
  const c = res.content || {};
  return {
    headings: (c.headings || []).slice(0, 10),
    text: c.text || null,
    items: (c.items || []).slice(0, 20),
    tables: (c.tables || []).slice(0, 2),
    truncated: !!c.truncated,
  };
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
  // A click that opened a new tab is a navigation into that tab.
  if (await adoptNewTabIfAny()) {
    await dismissOverlaysOnce();
    await rescanCurrentTab(true);
    return true;
  }
  // Read this BEFORE the re-scan: re-scanning overwrites the URL it compares against.
  const navigated = await didUrlChange();
  if (navigated) await dismissOverlaysOnce();
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
      session.filledIds = []; // only reset on real page navigation
      // Failures on the previous page say nothing about this one: the marks are all new. The
      // breaker exists to stop the agent flailing at a page it cannot act on, not to punish it
      // for a navigation it performed successfully.
      session.consecutiveFailures = 0;
      session.guard?.resetStall();
      // What was read on the previous page is history now; a fresh page is read afresh, and
      // text that was absent from the old page may well be on this one.
      session.pageContent = null;
      session.scrollToTried = new Set();
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
      pageTitle: scan.pageInfo?.title || "",
      pageUrl: scan.pageInfo?.url || "",
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
    noteAction(actionType, pending.mark_id, !!exec?.ok, "approved by user");
    session.actionLog.push({ action: actionType, mark_id: pending.mark_id, label: labelOf(pending.mark_id), approved: true, ok: !!exec?.ok, error: exec?.ok ? undefined : exec?.error });

    notifyPopup({
      type: "step", step: session.stepCount,
      status: exec?.ok ? "Approved action executed, updating page..." : `Approved action failed: ${exec?.error || "unknown"}`
    });
    if (exec?.ok) {
      if (pending.milestoneDone) markMilestoneDone("approved");
      await settleAfterNavAction(actionType);
    }
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
  noteAction("type", mark_id, !!exec?.ok, "value supplied by user");
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

/**
 * The user declined an action and said what to do instead. The note is shown to the planner
 * on the next step, in place of the action it proposed.
 */
async function modifyAction({ note } = {}) {
  if (!session) return { ok: false, error: "The session expired while waiting. Scan the page again." };
  const pending = session.lastAction;
  session.lastAction = null;
  session.userNote = String(note || "").slice(0, 300) || null;
  session.actionLog.push({ action: "modified_by_user", mark_id: pending?.mark_id, value: session.userNote, ok: true });
  noteAction(pending?.action || "click", pending?.mark_id, false, `declined; user said: ${session.userNote || "do something else"}`);
  if (session.userNote) notifyPopup({ type: "step", step: session.stepCount, status: `Noted: "${session.userNote}"` });
  const result = await phaseRun();
  return { ok: true, result };
}

/** The user has done their part on the page (a CAPTCHA, a file chooser); carry on. */
async function continueRun() {
  if (!session) return { ok: false, error: "The session expired while waiting. Scan the page again." };
  session.consecutiveFailures = 0;
  session.guard?.resetStall();
  // A file chooser the user just used belongs to a mark the planner should not ask for again.
  if (session.lastAction?.action === "upload" && session.lastAction.mark_id != null) {
    session.filledIds.push(session.lastAction.mark_id);
  }
  session.lastAction = null;
  await rescanCurrentTab(false, "continued");
  const result = await phaseRun();
  return { ok: true, result };
}

/** What the panel needs to redraw itself when it is (re)opened mid-run. */
function currentState() {
  if (!session) return { active: false, running: agentBusy };
  return {
    active: true,
    running: agentBusy,
    task: session.task,
    plan: publicPlan(),
    stepCount: session.stepCount,
    startedAt: session.startedAt,
    result: session.result,
    preview: session.redacted,
    piiCount: (session.marks && session.pageInfo) ? undefined : undefined,
    markCount: (session.marks || []).length,
    pageUrl: session.pageInfo?.url || "",
    pageTitle: session.pageInfo?.title || "",
    actionLog: session.actionLog || [],
    confidence: session.confidence,
  };
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
  if (msg.type === "MODIFY") {
    if (agentBusy) { sendResponse({ ok: false, error: "The agent is already running." }); return true; }
    modifyAction(msg.payload || {})
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CONTINUE") {
    if (agentBusy) { sendResponse({ ok: false, error: "The agent is already running." }); return true; }
    continueRun()
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
  if (msg.type === "GET_STATE") {
    sendResponse({ ok: true, state: currentState() });
    return true;
  }
  if (msg.type === "HISTORY") {
    SiteMemory.history(msg.limit || 50).then(rows => sendResponse({ ok: true, rows })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "RECENT_TASKS") {
    SiteMemory.recentTasks(msg.limit || 4).then(tasks => sendResponse({ ok: true, tasks })).catch(() => sendResponse({ ok: true, tasks: [] }));
    return true;
  }
  if (msg.type === "CLEAR_HISTORY") {
    SiteMemory.clearHistory().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CLEAR_MEMORY") {
    SiteMemory.clearAll().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

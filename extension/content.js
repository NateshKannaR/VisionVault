/**
 * content.js — Content Script for VisionVault
 *
 * Runs in EVERY frame of the page (manifest: all_frames: true).
 *
 * Responsibilities:
 * 1. scanForPII(): DOM scan for passwords, autocompletes, PII text regexes, nearby label keywords.
 * 2. tagInteractiveElements(): tags clickable/typeable elements with deterministic, scan-stable IDs
 *    and safe (PII-free) labels.
 * 3. Exposes window.__vagent.scanPage() / executeAction() so the service worker can call into
 *    each frame individually via chrome.scripting.executeScript({ allFrames: true }).
 * 4. MutationObserver: debounced DOM change notifications to the service worker.
 *
 * Action execution is NOT implemented here. There is exactly one action executor in the
 * codebase — ActionExecutor.executeAction() in action-executor.js, which is loaded into this
 * same isolated world by the manifest before content.js. See action-executor.js.
 */

if (window.__vagentLoaded) {
  /* already loaded */
} else {
window.__vagentLoaded = true;

const markMap = new Map();
const MAX_DOM_NODES = 2500;
let domScanInFlight = false;

// ── PII Input Selectors ──────────────────────────────────────────────────────
const PII_INPUT_SELECTORS = [
  'input[type="password"]',
  'textarea[name*="address" i]',
  'textarea[name*="about" i]',
  'textarea[autocomplete="street-address"]',
  'textarea[placeholder*="address" i]',
  'input[autocomplete*="cc-"]',
  'input[name*="cvv" i]',
  'input[name*="pan" i]',
  'input[name*="ifsc" i]',
  'input[name*="passport" i]',
  'input[name*="account" i]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[autocomplete="email"]',
  'input[autocomplete*="tel"]',
  'input[autocomplete="name"]',
  'input[autocomplete="street-address"]',
  'input[autocomplete="postal-code"]',
  'input[name*="ssn" i]',
  'input[name*="card" i]',
  'input[name*="password" i]',
  'input[name*="passwd" i]',
  'input[name*="email" i]',
  'input[name*="phone" i]',
  'input[name*="mobile" i]',
  'input[name*="aadhaar" i]',
  'input[name*="dob" i]',
  'input[name*="birth" i]',
  'input[name*="address" i]',
  'input[name*="zip" i]',
  'input[name*="postal" i]',
  'input[name*="name" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="password" i]',
  'input[placeholder*="name" i]',
  'input[placeholder*="aadhaar" i]'
];

// ── PII Text Regexes ─────────────────────────────────────────────────────────
const EMAIL_RE    = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE    = /(\+?\d[\d\s\-().]{7,}\d)/g;
const CARD_RE     = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;
const SSN_RE      = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
const AADHAAR_RE  = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;
const PAN_RE      = /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g;
const PASSPORT_RE = /\b[A-Z][0-9]{7}\b/g;
const IFSC_RE     = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const UPI_RE      = /\b[a-zA-Z0-9.\-_]{2,40}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|axl|upi)\b/gi;

// ── PII Label Keywords ───────────────────────────────────────────────────────
const PII_LABEL_KEYWORDS = [
  // identity
  "name", "surname", "first name", "last name", "full name", "username", "user id",
  "aadhaar", "ssn", "social security", "national id", "voter", "passport", "license",
  "licence", "pan", "tax id", "nino", "date of birth", "dob", "birth", "age", "gender",
  // credentials
  "password", "passwd", "passcode", "pin", "otp", "secret", "api key", "token", "key",
  // contact
  "email", "e-mail", "phone", "mobile", "telephone", "contact", "address", "street",
  "postcode", "post code", "zip", "postal", "city", "country",
  // financial
  "card", "credit card", "debit card", "cvv", "cvc", "expiry", "account number", "account no",
  "routing", "ifsc", "iban", "swift", "upi", "salary", "income", "bank",
  // health / misc sensitive
  "insurance", "policy number", "medical", "diagnosis", "blood group", "orbital"
];

function isElementInViewport(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;

  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return (
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < vh &&
    r.left < vw
  );
}

/**
 * A short, PII-free description of a control, used by the planner to choose targets.
 *
 * For inputs this must NOT fall back to el.value — that is the user's data, and it would be
 * transmitted. It uses the field's *identity* instead: its associated <label>, aria-label,
 * placeholder, title, or name attribute. An empty input previously produced a null label,
 * which left the planner guessing between identical-looking text fields.
 */
function safeLabel(el) {
  const tag = (el.tagName || "").toLowerCase();
  const isFormControl = tag === "input" || tag === "textarea" || tag === "select";

  const associatedLabel = () => {
    try {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const wrapping = el.closest ? el.closest("label") : null;
      const src = byFor || wrapping;
      return src ? (src.innerText || src.textContent || "") : "";
    } catch (_) {
      return "";
    }
  };

  const candidates = isFormControl
    ? [
        associatedLabel(),
        el.getAttribute("aria-label"),
        el.getAttribute("placeholder"),
        el.getAttribute("title"),
        el.getAttribute("name"),
      ]
    : [
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("placeholder"),
      ];

  for (const raw of candidates) {
    let text = (raw || "").trim();
    if (!text) continue;
    if (testPII(text)) continue; // never let a detected PII string become a label
    text = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 50) text = text.substring(0, 50);
    return text.toLowerCase();
  }
  return null;
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height)
  };
}

// ── Deterministic, scan-stable identity ──────────────────────────────────────

/**
 * Structural path of an element (tag + sibling index chain, capped at 6 levels).
 * Part of the identity seed so that two visually identical controls stay distinct.
 */
function structuralPath(el) {
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 6) {
    const parent = node.parentElement;
    let index = 0;
    if (parent) {
      const siblings = parent.children;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i] === node) { index = i; break; }
      }
    }
    parts.push(`${node.tagName.toLowerCase()}:${index}`);
    node = parent;
    depth++;
  }
  return parts.join(">");
}

/**
 * Identity seed: tag + identifying attributes + document-space geometry.
 *
 * Geometry uses DOCUMENT coordinates (viewport rect + scroll offset) bucketed to 4px, so the
 * seed does not change when the user simply scrolls the page — only when the element actually
 * moves in the document. This is what makes IDs stable across repeated scans.
 */
function identitySeed(el) {
  const tag = (el.tagName || "div").toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const name = el.getAttribute("name") || "";
  const domId = el.getAttribute("id") || "";
  const placeholder = el.getAttribute("placeholder") || "";
  const aria = el.getAttribute("aria-label") || "";
  const href = (el.getAttribute("href") || "").slice(0, 120);
  const r = el.getBoundingClientRect();
  const docX = Math.round((r.left + (window.scrollX || 0)) / 4);
  const docY = Math.round((r.top + (window.scrollY || 0)) / 4);
  const docW = Math.round(r.width / 4);
  const docH = Math.round(r.height / 4);
  return [
    framePathKey(),
    tag, type, name, domId, placeholder, aria, href,
    structuralPath(el),
    docX, docY, docW, docH
  ].join("|");
}

/** Frame-scoped namespace so identical elements in different frames never collide. */
function framePathKey() {
  try {
    return `${location.origin}${location.pathname}#${window === window.top ? "top" : "frame"}`;
  } catch (_) {
    return "frame";
  }
}

/** djb2-style 32-bit string hash (same approach used for PII region IDs). */
function hashString(raw) {
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Deterministic string ID for a PII region (e.g. "pii_1f3xk9"). */
function deterministicId(el, prefix = "pii") {
  return `${prefix}_${hashString(identitySeed(el)).toString(36)}`;
}

/**
 * Deterministic POSITIVE INTEGER mark ID for an interactive element.
 *
 * Derived from the same identity seed as PII regions, so the same element receives the same
 * mark ID on every scan of the page. Multi-step automation can therefore target an ID that
 * came from an earlier scan. Collisions inside one scan are resolved by linear probing.
 */
function deterministicMarkId(el, usedIds) {
  // Keep inside a safe positive int range that survives JSON + Pydantic `int`.
  let id = (hashString(identitySeed(el)) % 8999999) + 1000;
  let guard = 0;
  while (usedIds.has(id) && guard < 64) {
    id = ((id + 1) % 8999999) + 1000;
    guard++;
  }
  usedIds.add(id);
  return id;
}

function testPII(text) {
  const tests = [EMAIL_RE, PHONE_RE, CARD_RE, SSN_RE, AADHAAR_RE, PAN_RE, PASSPORT_RE, IFSC_RE, UPI_RE];
  const result = tests.some(re => { re.lastIndex = 0; return re.test(text); });
  tests.forEach(re => { re.lastIndex = 0; });
  return result;
}

// Keyword matching must respect word boundaries. Plain substring matching fires on innocent
// words that happen to contain a short keyword — "pin" inside "shipping", "age" inside
// "message", "pan" inside "company" — and each false hit blacks out a control the planner
// needs. Attribute names are normalised first so camelCase and snake_case still match:
// "fullName" -> "full name", "postal_code" -> "postal code".
const PII_LABEL_PATTERNS = PII_LABEL_KEYWORDS.map(
  kw => new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i")
);

function normalizeForKeywordMatch(text) {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function matchesPiiKeyword(text) {
  const t = normalizeForKeywordMatch(text);
  if (!t) return false;
  return PII_LABEL_PATTERNS.some(re => re.test(t));
}

/**
 * Search and filter boxes hold queries, not personal data, and blacking them out removes the
 * one control most tasks need. They are excluded even when their placeholder mentions a
 * sensitive word ("Search by name or email").
 */
function isSearchLike(el) {
  if (!el) return false;
  const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
  const role = (el.getAttribute && el.getAttribute("role") || "").toLowerCase();
  if (type === "search" || role === "searchbox") return true;
  const ident = normalizeForKeywordMatch(
    [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("aria-label")].filter(Boolean).join(" ")
  );
  return /\b(search|query|filter|keywords?|lookup|find)\b/.test(ident);
}

function checkNearbyLabelPII(inputEl) {
  const labelEl = inputEl.closest("label") ||
                  (inputEl.id ? document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`) : null) ||
                  inputEl.previousElementSibling;
  const candidates = [
    labelEl && (labelEl.innerText || labelEl.textContent),
    inputEl.getAttribute("aria-label"),
    inputEl.getAttribute("placeholder"),
    inputEl.getAttribute("name"),
    inputEl.getAttribute("id"),
    inputEl.getAttribute("autocomplete"),
  ];
  return candidates.some(matchesPiiKeyword);
}

/**
 * Values whose sensitivity comes from CONTEXT rather than shape.
 *
 * Personal names, street lines and account labels match no regex — a table of customers is
 * just capitalised words. What marks them sensitive is the column they sit in, or the term
 * they sit beside. This resolves that context two ways:
 *
 *   1. Table cells -> the <th> at the same column index (and any row header).
 *   2. Definition lists and label/value pairs -> the preceding <dt>/<label>/<strong>/<b>.
 *
 * Without this, dashboards leak every name and address they display; the live evaluation
 * measured exactly that before this rule existed.
 */
function findContextLabelledPII() {
  const hits = [];

  document.querySelectorAll("table").forEach((table) => {
    const headerCells = Array.from(table.querySelectorAll("thead th, tr:first-child th"));
    if (!headerCells.length) return;
    const sensitiveCols = new Set();
    headerCells.forEach((th, i) => {
      if (matchesPiiKeyword(th.innerText || th.textContent)) sensitiveCols.add(i);
    });
    if (!sensitiveCols.size) return;

    table.querySelectorAll("tr").forEach((row) => {
      // Header rows label the data; they are not the data. Masking "Email" as though it were
      // an address hides page structure the planner needs and scores as over-redaction.
      if (row.closest("thead")) return;
      const cells = Array.from(row.children).filter((c) => /^td$/i.test(c.tagName));
      cells.forEach((cell, i) => {
        if (!sensitiveCols.has(i)) return;
        const text = (cell.innerText || cell.textContent || "").trim();
        if (text.length >= 2) hits.push({ el: cell, label: (headerCells[i].innerText || "field").trim().toLowerCase() });
      });
    });
  });

  document.querySelectorAll("dd").forEach((dd) => {
    const dt = dd.previousElementSibling;
    if (dt && dt.tagName === "DT" && matchesPiiKeyword(dt.innerText || dt.textContent)) {
      const text = (dd.innerText || "").trim();
      if (text.length >= 2) hits.push({ el: dd, label: (dt.innerText || "field").trim().toLowerCase() });
    }
  });

  return hits;
}

/**
 * Offset of this frame's viewport inside the TOP-LEVEL viewport, in CSS pixels.
 *
 * Returns null for cross-origin frames (window.frameElement is inaccessible), which signals
 * to the orchestrator that this frame's coordinates cannot be mapped onto the top-level
 * screenshot and must be dropped rather than misplaced.
 */
function frameOffsetInTopViewport() {
  if (window === window.top) return { x: 0, y: 0, isTop: true };
  let offX = 0;
  let offY = 0;
  let win = window;
  try {
    while (win !== win.top) {
      const fe = win.frameElement; // throws SecurityError across origins
      if (!fe) return null;
      const r = fe.getBoundingClientRect();
      const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      offX += r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      offY += r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
      win = win.parent;
    }
  } catch (_) {
    return null; // cross-origin ancestor
  }
  return { x: Math.round(offX), y: Math.round(offY), isTop: false };
}

/**
 * Is this element rendered as a circle or near-circle?
 *
 * A profile picture is round on nearly every site that has one; a product thumbnail is not.
 * Used to decide which small images stay masked when the face model has already had its say.
 */
function isCircular(el, rect) {
  try {
    const radius = getComputedStyle(el).borderRadius || "";
    const first = radius.split(/\s|\//)[0] || "";
    const shorter = Math.min(rect.w || 0, rect.h || 0);
    if (!shorter) return false;
    if (first.endsWith("%")) return parseFloat(first) >= 40;
    if (first.endsWith("px")) return parseFloat(first) >= shorter * 0.4;
    return false;
  } catch (_) {
    return false;
  }
}

// ── Phase 1: scan for PII regions ────────────────────────────────────────────
function scanForPII() {
  const regions = [];
  const seen = new Set();
  let nodeCount = 0;

  function addRegion(el, type, reason, label = null, extra = null) {
    if (!el) return;
    const r = rectOf(el);
    if (r.w < 2 || r.h < 2) return;
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (seen.has(key)) return;
    seen.add(key);

    const stableId = deterministicId(el, "pii");
    regions.push({
      id: stableId,
      ...r,
      box: r,
      type,
      sensitive: true,
      reason,
      label,
      ...(extra || {})
    });
  }

  // 1. Sensitive input fields
  document.querySelectorAll(PII_INPUT_SELECTORS.join(",")).forEach(el => {
    if (isSearchLike(el)) return;
    addRegion(el, "form_field", "sensitive_input", el.getAttribute("type") || "form_field");
  });

  // 2. Form fields with nearby PII label text
  document.querySelectorAll("input, textarea, select").forEach(el => {
    if (isSearchLike(el)) return;
    if (checkNearbyLabelPII(el)) {
      addRegion(el, "form_field", "nearby_label_pii", "labeled_pii");
    }
  });

  // 2b. Values that are sensitive because of the column/term they sit under
  findContextLabelledPII().forEach(({ el, label }) => {
    addRegion(el, "text", "context_labelled_pii", label.slice(0, 30));
  });

  // 3. Text nodes matching regexes
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      nodeCount++;
      if (nodeCount > MAX_DOM_NODES) break;
      const text = node.nodeValue || "";
      if (text.trim().length < 4) continue;
      if (testPII(text)) {
        addRegion(node.parentElement, "text", "pii_text_match", "regex_pii");
      }
    }
  }

  // 4. Media that could hold a face or an identity document.
  //
  //    This is the fail-closed default for when no face model is available. When one HAS run,
  //    detection-orchestrator.js drops these in favour of the model's own boxes — otherwise
  //    every product photo on a shopping page gets blacked out, which wrecks both the visual
  //    context the planner needs and the precision of the redaction itself.
  //
  //    The markup hints travel with the region so that filter can keep anything the page
  //    itself describes as a person, whatever the model concluded.
  document.querySelectorAll("img, video, canvas").forEach(el => {
    if (el.offsetParent === null) return;
    const r = rectOf(el);
    if (r.w >= 48 && r.h >= 48) {
      addRegion(el, "media", "possible_face_or_media", "media", {
        alt: (el.getAttribute("alt") || "").slice(0, 80),
        className: (typeof el.className === "string" ? el.className : "").slice(0, 80),
        src: (el.getAttribute("src") || "").slice(0, 120),
        // Circular is the strongest available signal for "this is a person". Product
        // thumbnails, logos and category tiles are square or rectangular; profile pictures are
        // round almost everywhere. Computed here because only the page can see the style.
        circular: isCircular(el, r),
      });
    }
  });

  return regions;
}

// ── Phase 1: tag interactive elements ────────────────────────────────────────
function inferRole(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.type || "").toLowerCase();
  const role = (el.getAttribute("role") || "").toLowerCase();
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();

  if (tag === "input") {
    if (type === "submit" || type === "button") return "button";
    if (type === "search" || role === "searchbox") return "input:search";
    return `input:${type || "text"}`;
  }
  if (tag === "button" || role === "button") return "button";
  if (tag === "a" || role === "link") return "link";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  if (role === "textbox" || role === "searchbox" || role === "combobox") return "editable";
  if (el.getAttribute("contenteditable") === "true") return "editable";
  if (aria.includes("message") || placeholder.includes("message")) return "editable";
  return "clickable";
}

function tagInteractiveElements() {
  markMap.clear();
  const marks = [];
  const usedIds = new Set();
  const seen = new WeakSet();

  const candidates = document.querySelectorAll(
    'a, button, input:not([type="hidden"]):not([type="file"]), textarea, select, [role="button"], [role="link"], [role="searchbox"], [role="textbox"], [role="tab"], [role="menuitem"], [contenteditable="true"], .nav-link, .btn, [id*="search" i], [name*="search" i], [name*="keywords" i]'
  );

  candidates.forEach((el) => {
    if (!(el instanceof Element) || seen.has(el)) return;
    if (!isElementInViewport(el)) return; // Viewport-only filtering
    seen.add(el);

    const r = rectOf(el);
    if (r.w < 6 || r.h < 6) return;
    const role = inferRole(el);
    if (!role) return;

    // Deterministic ID — stable across repeated scans of the same page.
    const stableId = deterministicMarkId(el, usedIds);
    el.setAttribute("data-vagent-mark", String(stableId));
    markMap.set(stableId, el);
    markMap.set(String(stableId), el);

    marks.push({
      id: stableId,
      role,
      box: r,
      label: safeLabel(el)
    });
  });

  return marks;
}

/** Resolves a mark ID to a live element in THIS frame (or null). */
function resolveMarkElement(targetId) {
  return (
    markMap.get(targetId) ||
    markMap.get(Number(targetId)) ||
    markMap.get(String(targetId)) ||
    document.querySelector(`[data-vagent-mark="${CSS.escape(String(targetId))}"]`) ||
    null
  );
}

/**
 * Full scan of THIS frame. Returns regions/marks in this frame's own viewport
 * coordinates plus the offset needed to map them into the top-level viewport.
 */
function scanPage() {
  if (domScanInFlight) {
    return { piiRegions: [], marks: [], scanSkipped: true, frameOffset: frameOffsetInTopViewport() };
  }
  domScanInFlight = true;
  try {
    const piiRegions = scanForPII();
    const marks = tagInteractiveElements();
    return {
      piiRegions,
      marks,
      scanSkipped: false,
      frameOffset: frameOffsetInTopViewport(),
      frameUrl: location.href.slice(0, 200),
      isTopFrame: window === window.top
    };
  } finally {
    domScanInFlight = false;
  }
}

/**
 * Executes an action in THIS frame using the single shared ActionExecutor.
 * Returns { ok, error? } — or { ok:false, notInThisFrame:true } if the mark lives elsewhere.
 */
async function executeActionInFrame(payload = {}) {
  const actionType = (payload.action || payload.type || "").toLowerCase();
  const targetId = payload.mark_id ?? payload.target;
  // The executor owns the definition of which actions need a marked element; asking it keeps
  // the two from drifting apart. The fallback covers the (impossible in practice) case of
  // this frame having content.js without action-executor.js.
  const targetless = globalThis.ActionExecutor?.TARGETLESS_ACTIONS ||
    new Set(["scroll_page", "wait", "done", "dismiss_overlays", "open_search", "probe_query"]);

  // "scroll" with no id is a page scroll, so it needs no element either.
  const needsElement = !targetless.has(actionType) && !(actionType === "scroll" && targetId == null);
  if (needsElement && !resolveMarkElement(targetId)) {
    return { ok: false, notInThisFrame: true, error: `mark_id ${targetId} not found in this frame` };
  }

  const executor = globalThis.ActionExecutor && globalThis.ActionExecutor.executeAction;
  if (typeof executor !== "function") {
    return { ok: false, error: "ActionExecutor not loaded in this frame." };
  }

  return executor(
    { type: actionType, target: targetId, value: payload.value },
    resolveMarkElement
  );
}

function getPageInfo() {
  return {
    title: document.title.substring(0, 80),
    url: location.origin + location.pathname,
    url_path: location.pathname,
    scroll_y: window.scrollY,
    page_height: document.body ? document.body.scrollHeight : 0,
    viewport_height: window.innerHeight,
    viewport_width: window.innerWidth,
    device_pixel_ratio: window.devicePixelRatio || 1
  };
}

// Exposed to the service worker via chrome.scripting.executeScript({ allFrames: true }).
window.__vagent = {
  scanPage,
  executeAction: executeActionInFrame,
  getPageInfo,
  resolveMarkElement
};

// ── MutationObserver ─────────────────────────────────────────────────────────
// Only the top frame reports DOM changes; a full re-scan already covers every frame.
let domMutationDebounce = null;
if (document.body && window === window.top) {
  const observer = new MutationObserver(() => {
    if (domMutationDebounce) clearTimeout(domMutationDebounce);
    domMutationDebounce = setTimeout(() => {
      try {
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: "DOM_CHANGED", url: location.href }).catch(() => {});
        }
      } catch (_) {}
    }, 700);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}

// ── Message Listeners ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SCAN_PAGE") {
    sendResponse(scanPage());
    return true;
  }

  if (msg.type === "EXECUTE_ACTION") {
    const payload = msg.payload || msg.action || msg;
    executeActionInFrame(payload).then(res => sendResponse(res));
    return true;
  }

  if (msg.type === "GET_PAGE_INFO") {
    sendResponse(getPageInfo());
    return true;
  }
});

} // end guard

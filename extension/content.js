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
// Kept in step with the same identifiers in vision/ocrDetect.js. The two detectors read
// the same page by different routes - this one walks the DOM, that one reads the flattened
// pixels - so a shape recognised by only one of them is a hole that opens the moment a site
// renders the value as an image instead of text.
// A UIDAI Aadhaar never begins with 0 or 1, which keeps order numbers out of the mask.
const AADHAAR_RE  = /\b[2-9]\d{3}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}\b/g;
const PAN_RE      = /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g;
const PASSPORT_RE = /\b[A-Z][0-9]{7}\b/g;
const IFSC_RE     = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const UPI_RE      = /\b[a-zA-Z0-9.\-_]{2,40}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|axl|upi)\b/gi;
const VID_RE      = /\b\d{4}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}\b/g;
const DL_RE       = /\b[A-Z]{2}[-\s]?\d{2}[-\s]?\d{4}[-\s]?\d{7}\b|\b[A-Z]{2}[-\s]?\d{2}[-\s]?\d{11}\b/g;
const VEHICLE_RE  = /\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b/g;
const ACCOUNT_RE  = /\b(?:a\/c|acc(?:oun)?t(?:\s*(?:no|number|#))?|bank\s*a\/?c)\s*[:.#-]?\s*(\d{9,18})\b/gi;

// Devanagari, Tamil, Bengali and the other Indic digit blocks, mapped one code point to one
// so match offsets are unaffected. Without this an Aadhaar printed as 2345 6789 0123 in
// Devanagari matches none of the patterns above and the page looks clean.
// The zero of each Indic digit block. Digits run consecutively from there, so subtracting the
// block base is the whole conversion - and unlike masking the low nibble it is actually right:
// Devanagari zero is U+0966, which is not on a sixteen boundary.
const INDIC_ZEROS = [
  0x0966, // Devanagari
  0x09E6, // Bengali
  0x0A66, // Gurmukhi
  0x0AE6, // Gujarati
  0x0B66, // Odia
  0x0BE6, // Tamil
  0x0C66, // Telugu
  0x0CE6, // Kannada
  0x0D66, // Malayalam
  0x0660  // Arabic-Indic
];
const INDIC_DIGIT_RE = /[\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0660-\u0669]/g;

/** ASCII digits, one code point per code point, so match offsets are unchanged. */
function normalizeDigits(text) {
  INDIC_DIGIT_RE.lastIndex = 0;
  if (!INDIC_DIGIT_RE.test(text)) { INDIC_DIGIT_RE.lastIndex = 0; return text; }
  INDIC_DIGIT_RE.lastIndex = 0;
  return text.replace(INDIC_DIGIT_RE, (d) => {
    const c = d.codePointAt(0);
    for (const z of INDIC_ZEROS) {
      if (c >= z && c <= z + 9) return String(c - z);
    }
    return d;
  });
}

// ── PII Label Keywords ───────────────────────────────────────────────────────
const PII_LABEL_KEYWORDS = [
  // identity & personnel
  "name", "surname", "first name", "last name", "full name", "username", "user id",
  "aadhaar", "ssn", "social security", "national id", "voter", "passport", "license",
  "licence", "pan", "tax id", "nino", "date of birth", "dob", "birth", "age", "gender",
  "operator", "operator on duty", "duty", "mission", "mission id", "officer", "supervisor",
  "commander", "technician", "pilot", "personnel", "author", "creator", "admin", "agent",
  "employee", "staff", "applicant", "candidate", "member",
  // credentials & security
  "password", "passwd", "passcode", "pin", "otp", "secret", "api key", "token", "key",
  "encryption key", "encryption key ref", "encryption", "auth token", "private key",
  "clearance", "restricted", "confidential", "classified", "internal", "data classification",
  // orbital, aerospace & telemetry
  "satellite", "satellite name", "launch date", "apogee", "perigee", "inclination",
  "orbital inclination", "orbit type", "orbit", "tle", "tle line 1", "tle line 2",
  "frequency", "ground station", "ground station freq", "telemetry", "payload",
  // contact
  "email", "e-mail", "phone", "mobile", "telephone", "contact", "address", "street",
  "postcode", "post code", "zip", "postal", "city", "country",
  // financial
  "card", "credit card", "debit card", "cvv", "cvc", "expiry", "account number", "account no",
  "routing", "ifsc", "iban", "swift", "upi", "salary", "income", "bank",
  // health / misc sensitive
  "insurance", "policy number", "medical", "diagnosis", "blood group", "orbital"
];

/**
 * Recursively queries elements including those in open shadow roots.
 */
function querySelectorAllDeep(selector, root = document) {
  const results = [];
  try {
    results.push(...root.querySelectorAll(selector));
  } catch (_) {}

  // Recurse into open shadow roots
  try {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );
    let node = walker.nextNode();
    while (node) {
      if (node.shadowRoot) {
        results.push(...querySelectorAllDeep(selector, node.shadowRoot));
      }
      node = walker.nextNode();
    }
  } catch (_) {}
  return results;
}

function isElementInViewport(el) {
  if (!el) return false;
  if (typeof el.checkVisibility === "function") {
    try {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch (_) {}
  } else {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  }

  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;

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
      // 0. Explicit aria-labelledby (e.g. Google Forms, modern UI libraries)
      if (el.getAttribute && el.getAttribute("aria-labelledby")) {
        const ids = el.getAttribute("aria-labelledby").split(/\s+/).filter(Boolean);
        const parts = [];
        for (const id of ids) {
          const target = document.getElementById(id);
          if (target) {
            const t = (target.innerText || target.textContent || "").trim();
            if (t && !parts.includes(t)) parts.push(t);
          }
        }
        if (parts.length) {
          const joined = parts.join(" ");
          if (joined.length < 80) return joined;
        }
      }

      // 0b. Google Forms / Question item container
      const questionContainer = el.closest ? el.closest('[role="listitem"], .Qr7Oae, .geS5n, .m2, .freebirdFormviewerViewNumberedItemContainer') : null;
      if (questionContainer) {
        const header = questionContainer.querySelector('[role="heading"], .M7eMe, .HoPG3, .freebirdFormviewerComponentsQuestionBaseTitle, h1, h2, h3, h4, h5, h6, strong, b');
        if (header && !header.contains(el)) {
          const t = (header.innerText || header.textContent || "").trim();
          if (t && t.length < 80) return t;
        }
      }

      // 1. Explicit <label for="..."> or wrapping <label>
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const wrapping = el.closest ? el.closest("label") : null;
      if (byFor || wrapping) {
        const text = (byFor || wrapping).innerText || (byFor || wrapping).textContent || "";
        if (text.trim()) return text;
      }

      // 2. Direct previous sibling (e.g. <span class="label">Satellite Name *</span><input>)
      let prev = el.previousElementSibling;
      while (prev && /^(input|textarea|select|button)$/i.test(prev.tagName)) {
        prev = prev.previousElementSibling;
      }
      if (prev) {
        const t = (prev.innerText || prev.textContent || "").trim();
        if (t && t.length < 80) return t;
      }

      // 3. Parent's previous sibling
      if (el.parentElement) {
        let parentPrev = el.parentElement.previousElementSibling;
        if (parentPrev) {
          const t = (parentPrev.innerText || parentPrev.textContent || "").trim();
          if (t && t.length < 80) return t;
        }
      }

      // 4. Immediate row / form group with 1-2 inputs
      const immediateRow = el.closest("tr, .form-row, .row, .field, .form-group, .form-item, p, li");
      if (immediateRow) {
        const inputsInRow = immediateRow.querySelectorAll("input, textarea, select");
        if (inputsInRow.length <= 2) {
          const rowLabel = immediateRow.querySelector("label, .label, .form-label, .field-label, th, dt, .key, .name, strong, b, span");
          if (rowLabel && rowLabel !== el && !rowLabel.contains(el)) {
            const t = (rowLabel.innerText || rowLabel.textContent || "").trim();
            if (t && t.length < 80 && !/^(identification|orbital parameters|communications|security|metadata)$/i.test(t)) return t;
          }
        }
      }

      // 5. Spatial / Geometric horizontal scan: find text label aligned horizontally on the left
      const inputRect = el.getBoundingClientRect();
      if (inputRect.width > 0 && inputRect.height > 0) {
        const allLabels = document.querySelectorAll("label, span, th, td, dt, div, p, strong, b");
        let bestLabel = null;
        let bestDist = Infinity;
        for (const candidate of allLabels) {
          if (candidate === el || candidate.contains(el) || el.contains(candidate)) continue;
          if (candidate.children.length > 2) continue;
          const text = (candidate.innerText || candidate.textContent || "").trim();
          if (!text || text.length < 2 || text.length > 70) continue;
          if (/^(identification|orbital parameters|communications|security|metadata|save draft|submit|reset|auto-saved)$/i.test(text)) continue;

          const r = candidate.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;

          const vOverlap = Math.abs((r.top + r.height / 2) - (inputRect.top + inputRect.height / 2));
          if (vOverlap < 22 && r.right <= inputRect.left + 30 && r.left < inputRect.left) {
            const dist = inputRect.left - r.right;
            if (dist >= -30 && dist < bestDist) {
              bestDist = dist;
              bestLabel = text;
            }
          }
        }
        if (bestLabel) return bestLabel;
      }

      return "";
    } catch (_) {
      return "";
    }
  };

  const dataIcon = () => {
    try {
      return el.getAttribute("data-icon") ||
             (el.querySelector && el.querySelector("[data-icon]") ? el.querySelector("[data-icon]").getAttribute("data-icon") : "") ||
             "";
    } catch (_) {
      return "";
    }
  };

  const candidates = isFormControl
    ? [
        associatedLabel(),
        el.getAttribute("data-vault-key"),
        el.getAttribute("aria-label"),
        el.getAttribute("placeholder"),
        el.getAttribute("title"),
        el.getAttribute("name"),
        el.getAttribute("id"),
        dataIcon(),
      ]
    : [
        el.innerText,
        el.getAttribute("data-page"),
        el.getAttribute("data-vault-key"),
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("placeholder"),
        el.getAttribute("name"),
        el.getAttribute("id"),
        dataIcon(),
      ];

  const PROMPT_INJECTION_RE = /\b(?:system:|assistant:|human:|user:|ignore\s+(?:all\s+)?previous\s+instructions?|disregard\s+(?:all\s+)?prior\s+instructions?|developer\s+mode|jailbreak|<\|im_start\|>|<\|im_end\|>|<\|system\|>|\[\/?inst\]|admin\s+override)\b/i;

  for (const raw of candidates) {
    let text = (raw || "").trim();
    if (!text) continue;
    if (testPII(text)) continue; // never let a detected PII string become a label
    if (PROMPT_INJECTION_RE.test(text)) continue; // prevent indirect prompt injection via DOM labels
    text = text.replace(/[\r\n\t]+/g, " ").replace(/[*:]+/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 50) text = text.substring(0, 50);
    if (text) return text.toLowerCase();
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
  const tests = [EMAIL_RE, PHONE_RE, CARD_RE, SSN_RE, VID_RE, AADHAAR_RE, PAN_RE, DL_RE,
                 VEHICLE_RE, ACCOUNT_RE, PASSPORT_RE, IFSC_RE, UPI_RE];
  const probe = normalizeDigits(text);
  const result = tests.some(re => { re.lastIndex = 0; return re.test(probe); });
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
  const rowContainer = inputEl.closest(".form-row, .form-group, .field, .row, .group, tr, td, li, div");
  const rowLabelEl = rowContainer ? rowContainer.querySelector("label, .label, .form-label, .field-label, dt, th") : null;
  const labelEl = inputEl.closest("label") ||
                  (inputEl.id ? document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`) : null) ||
                  inputEl.previousElementSibling ||
                  (inputEl.parentElement && inputEl.parentElement.previousElementSibling) ||
                  rowLabelEl;
  
  const isRestrictedContainer = Boolean(inputEl.closest(
    "[class*='restricted' i], [class*='classified' i], [class*='confidential' i], [id*='restricted' i], [id*='classified' i], [data-classification]"
  ));

  const candidates = [
    labelEl && (labelEl.innerText || labelEl.textContent),
    rowLabelEl && (rowLabelEl.innerText || rowLabelEl.textContent),
    inputEl.getAttribute("aria-label"),
    inputEl.getAttribute("placeholder"),
    inputEl.getAttribute("name"),
    inputEl.getAttribute("id"),
    inputEl.getAttribute("autocomplete"),
  ];

  return isRestrictedContainer || candidates.some(matchesPiiKeyword);
}

/**
 * Values whose sensitivity comes from CONTEXT rather than shape.
 *
 * Catches personal names ("R. Sharma"), telemetry values ("35,786 km"), mission identifiers,
 * and data fields inside restricted cards/dashboards.
 */
function findContextLabelledPII() {
  const hits = [];
  const MAX_LABEL_LEN = 60;
  const MAX_VALUE_LEN = 120;

  // 1. Table columns and rows
  document.querySelectorAll("table").forEach((table) => {
    const headerCells = Array.from(table.querySelectorAll("thead th, tr:first-child th"));
    if (!headerCells.length) return;
    const sensitiveCols = new Set();
    headerCells.forEach((th, i) => {
      if (matchesPiiKeyword(th.innerText || th.textContent)) sensitiveCols.add(i);
    });
    if (!sensitiveCols.size) return;

    table.querySelectorAll("tr").forEach((row) => {
      if (row.closest("thead")) return;
      const cells = Array.from(row.children).filter((c) => /^td$/i.test(c.tagName));
      cells.forEach((cell, i) => {
        if (!sensitiveCols.has(i)) return;
        const text = (cell.innerText || cell.textContent || "").trim();
        if (text.length >= 2) hits.push({ el: cell, label: (headerCells[i].innerText || "field").trim().toLowerCase() });
      });
    });
  });

  // 2. Definition lists (<dt> -> <dd>)
  document.querySelectorAll("dd").forEach((dd) => {
    const dt = dd.previousElementSibling;
    if (dt && dt.tagName === "DT" && matchesPiiKeyword(dt.innerText || dt.textContent)) {
      const text = (dd.innerText || "").trim();
      if (text.length >= 2) hits.push({ el: dd, label: (dt.innerText || "field").trim().toLowerCase() });
    }
  });

  // 3. Label/Value pairs across flex, grid, and dashboard rows
  document.querySelectorAll("div, span, p, li, td, dd, input, textarea").forEach((el) => {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (checkNearbyLabelPII(el) && !isSearchLike(el)) {
        hits.push({ el, label: (el.getAttribute("name") || "sensitive_field").toLowerCase() });
      }
      return;
    }

    const prev = el.previousElementSibling || (el.parentElement && el.parentElement.previousElementSibling);
    if (!prev) return;
    const label = (prev.innerText || prev.textContent || "").trim();
    if (!label || label.length > MAX_LABEL_LEN) return;
    if (!matchesPiiKeyword(label)) return;

    const value = (el.innerText || el.textContent || (el.value !== undefined ? el.value : "") || "").trim();
    if (value.length < 2 || value.length > MAX_VALUE_LEN) return;
    if (matchesPiiKeyword(value) && value.length <= MAX_LABEL_LEN) return;

    hits.push({ el, label: label.toLowerCase().slice(0, 40) });
  });

  // 4. Restricted and Classified Containers: Mask all data values within them
  document.querySelectorAll(
    "[class*='restricted' i], [class*='classified' i], [class*='confidential' i], [id*='restricted' i], [data-classification]"
  ).forEach((container) => {
    container.querySelectorAll("input:not([type='button']):not([type='submit']), textarea, .value, .val, td, dd").forEach((dataEl) => {
      if (!isSearchLike(dataEl)) {
        hits.push({ el: dataEl, label: "restricted_data" });
      }
    });
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
    // Remember WHICH element was judged sensitive, not just the rectangle. The rectangle is
    // enough to paint over the pixels; it is not enough to stop the same text being sent as
    // an element label in the marks array, which is a second, unredacted channel to the same
    // server. See suppressLabelsInside.
    if (type === "text") sensitiveTextEls.add(el);
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
  querySelectorAllDeep(PII_INPUT_SELECTORS.join(",")).forEach(el => {
    if (isSearchLike(el)) return;
    addRegion(el, "form_field", "sensitive_input", el.getAttribute("type") || "form_field");
  });

  // 2. Form fields with nearby PII label text
  querySelectorAllDeep("input, textarea, select").forEach(el => {
    if (isSearchLike(el)) return;
    if (checkNearbyLabelPII(el)) {
      addRegion(el, "form_field", "nearby_label_pii", "labeled_pii");
    }
  });

  // 2b. Values that are sensitive because of the column/term they sit under
  findContextLabelledPII().forEach(({ el, label }) => {
    addRegion(el, "text", "context_labelled_pii", label.slice(0, 30));
  });

  // 3. Text nodes matching regexes (including open shadow roots)
  if (document.body) {
    function walkTextNodes(root) {
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          nodeCount++;
          if (nodeCount > MAX_DOM_NODES) return;
          const text = node.nodeValue || "";
          if (text.trim().length < 4) continue;
          if (testPII(text)) {
            addRegion(node.parentElement, "text", "pii_text_match", "regex_pii");
          }
        }
      } catch (_) {}

      try {
        const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let elNode = elWalker.nextNode();
        while (elNode && nodeCount <= MAX_DOM_NODES) {
          if (elNode.shadowRoot) {
            walkTextNodes(elNode.shadowRoot);
          }
          elNode = elWalker.nextNode();
        }
      } catch (_) {}
    }
    walkTextNodes(document.body);
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
    if (type === "checkbox" || role === "checkbox") return "checkbox";
    if (type === "radio" || role === "radio") return "radio";
    return `input:${type || "text"}`;
  }
  if (tag === "button" || role === "button") return "button";
  if (tag === "a" || role === "link") return "link";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  if (role === "combobox" || el.getAttribute("aria-haspopup") === "listbox") return "combobox";
  if (role === "checkbox" || role === "switch") return "checkbox";
  if (role === "radio") return "radio";
  if (role === "tab" || (el.classList && (el.classList.contains("tab") || el.classList.contains("nav-item")))) return "clickable";
  if (role === "textbox" || role === "searchbox") return "editable";
  if (el.getAttribute("contenteditable") === "true") return "editable";
  if (aria.includes("message") || placeholder.includes("message")) return "editable";
  return "clickable";
}

function tagInteractiveElements() {
  markMap.clear();
  const marks = [];
  const usedIds = new Set();
  const seen = new WeakSet();

  const candidates = querySelectorAllDeep(
    'a, button, input:not([type="hidden"]):not([type="file"]), textarea, select, label[for], [role="button"], [role="link"], [role="searchbox"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [contenteditable="true"], [tabindex="0"], [aria-haspopup="listbox"], [aria-haspopup="true"], .nav-link, .nav-item, [data-page], [onclick], .btn, [id*="search" i], [name*="search" i], [name*="keywords" i], [class*="searchCity" i], [class*="searchToCity" i]'
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

    // A label is only safe to transmit if the scan did not just decide this element's text
    // was personal data. Dropping it costs the planner a little context on that one control;
    // sending it would put the value on the wire in clear text next to the image that was
    // carefully masked to hide it.
    const label = isInsideSensitiveText(el) ? null : safeLabel(el);

    marks.push({
      id: stableId,
      role,
      box: r,
      label,
      vaultKey: el.getAttribute("data-vault-key") || null
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
// Elements whose TEXT this scan judged sensitive. Rebuilt every scan, because the page and
// the judgement both change.
//
// This exists because of a leak found by eval/workflows.js on the enterprise dashboard: two
// employee names reached the server verbatim while the image was masked correctly. A personal
// name matches no pattern - "Ananya Sridharan" is two capitalised words - so safeLabel's regex
// screen passes it, and it travelled as the label of the link wrapping the table cell. The
// pixels were covered and the text was sent anyway.
let sensitiveTextEls = new Set();

/**
 * Whether an element's visible text was judged sensitive by this scan.
 *
 * Checks the element, its ancestors and its descendants: a mark is often the <a> inside a
 * sensitive <td>, and sometimes the <td> containing a sensitive <span>.
 */
function isInsideSensitiveText(el) {
  if (!el || !sensitiveTextEls.size) return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (sensitiveTextEls.has(n)) return true;
  }
  for (const s of sensitiveTextEls) {
    if (el.contains && el.contains(s)) return true;
  }
  return false;
}

function scanPage() {
  if (domScanInFlight) {
    return { piiRegions: [], marks: [], scanSkipped: true, frameOffset: frameOffsetInTopViewport() };
  }
  domScanInFlight = true;
  try {
    // Order matters: scanForPII populates sensitiveTextEls, and tagInteractiveElements reads
    // it to decide which labels may leave the device.
    sensitiveTextEls = new Set();
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

/**
 * After a "type" action, verify the field actually received the value.
 * Returns { ok: true } if the field value matches, { ok: false, validationError } otherwise.
 */
function checkFieldValue(targetId, expectedValue) {
  const el = resolveMarkElement(targetId);
  if (!el) return { ok: false, validationError: "element not found" };
  const actual = el.value !== undefined ? el.value : (el.textContent || "");
  if (!actual || actual.trim() === "") {
    return { ok: false, validationError: "field is empty after type" };
  }
  if (expectedValue && actual.trim() !== String(expectedValue).trim()) {
    return { ok: false, validationError: `expected "${expectedValue}" but field contains "${actual.slice(0, 40)}"` };
  }
  return { ok: true };
}

// ── Message Listeners ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SCAN_PAGE") {
    sendResponse(scanPage());
    return true;
  }

  if (msg.type === "EXECUTE_ACTION") {
    const payload = msg.payload || msg.action || msg;
    executeActionInFrame(payload).then(res => {
      // After a type action, verify the field received the value
      if ((payload.action || payload.type || "").toLowerCase() === "type" && res?.ok) {
        const check = checkFieldValue(payload.mark_id ?? payload.target, payload.value);
        if (!check.ok) {
          res.validationError = check.validationError;
          // Don't flip ok — the type succeeded mechanically; caller decides how to handle
        }
      }
      sendResponse(res);
    });
    return true;
  }

  if (msg.type === "GET_PAGE_INFO") {
    sendResponse(getPageInfo());
    return true;
  }

  // ── Read all data-vault-key fields from the current page ─────────────────────────
  // Fill a single field by vault key with human-like typing
  if (msg.type === "FILL_SINGLE_VAULT_FIELD") {
    const el = document.querySelector(".page.active input[data-vault-key='" + msg.key + "'], .page.active textarea[data-vault-key='" + msg.key + "']");
    if (!el) { sendResponse({ ok: false, error: "Field not found" }); return true; }
    const value = String(msg.value || "");
    (async () => {
      el.focus();
      el.dispatchEvent(new Event("focus", { bubbles: true }));
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, ""); else el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      for (const char of value) {
        el.dispatchEvent(new KeyboardEvent("keydown",  { key: char, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
        const current = el.value;
        if (setter) setter.call(el, current + char); else el.value = current + char;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        await new Promise(r => setTimeout(r, 30 + Math.random() * 40));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur",   { bubbles: true }));
      sendResponse({ ok: true, filled: 1 });
    })();
    return true;
  }

  if (msg.type === "SCRUB_CHAT_INPUT") {
    try {
      // Target active chat inputs on ChatGPT, Claude, Gemini, or standard textareas
      const chatInput = document.querySelector(
        '#prompt-textarea, [data-testid="prompt-textarea"], ' +
        'div[contenteditable="true"].ProseMirror, div[contenteditable="true"][enterkeyhint="enter"], ' +
        '.textarea[contenteditable="true"], div.ql-editor[contenteditable="true"], ' +
        'textarea:focus, textarea[placeholder*="message" i], textarea[placeholder*="ask" i], textarea'
      );

      if (!chatInput) {
        sendResponse({ ok: false, error: "No active chat prompt textarea found on this page." });
        return true;
      }

      const isContentEditable = chatInput.isContentEditable;
      const rawText = isContentEditable ? (chatInput.innerText || chatInput.textContent || "") : (chatInput.value || "");

      if (!rawText.trim()) {
        sendResponse({ ok: false, error: "Chat input is currently empty." });
        return true;
      }

      const scrubber = window.PromptScrubber || globalThis.PromptScrubber;
      if (!scrubber) {
        sendResponse({ ok: false, error: "PromptScrubber engine is initializing." });
        return true;
      }

      const scrubRes = scrubber.scrub(rawText);

      // Update the input field with the sanitized text
      if (isContentEditable) {
        chatInput.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(chatInput);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("insertText", false, scrubRes.cleanText);
        chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const proto = chatInput.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(chatInput, scrubRes.cleanText); else chatInput.value = scrubRes.cleanText;
        chatInput.dispatchEvent(new Event("input", { bubbles: true }));
        chatInput.dispatchEvent(new Event("change", { bubbles: true }));
      }

      sendResponse({
        ok: true,
        stats: scrubRes.stats,
        tokenMap: scrubRes.tokenMap,
        cleanText: scrubRes.cleanText
      });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
    return true;
  }

  if (msg.type === "READ_VAULT_FIELDS") {
    const fields = {};

    // 1. Inputs/controls or elements with explicit data-vault-key
    document.querySelectorAll("[data-vault-key]").forEach(el => {
      const key = el.getAttribute("data-vault-key");
      const val = (el.value || el.innerText || el.textContent || "").trim();
      if (key && val && val !== "Loading…") fields[key] = val;
    });

    // 2. Scan localStorage for any stored vault object (e.g. isro_vault_*, vault, mission_vault)
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (/vault/i.test(lsKey)) {
          const raw = localStorage.getItem(lsKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              for (const [k, v] of Object.entries(parsed)) {
                if (v && typeof v === "string" && !fields[k]) {
                  fields[k] = v.trim();
                }
              }
            }
          }
        }
      }
    } catch (_) {}

    // 3. Scan window.vaultData or document variables if present
    try {
      if (typeof window.vaultData === "object" && window.vaultData !== null) {
        for (const [k, v] of Object.entries(window.vaultData)) {
          if (v && typeof v === "string" && !fields[k]) {
            fields[k] = v.trim();
          }
        }
      }
    } catch (_) {}

    // 4. Structured Key-Value block parser on the page (messages, datablocks, pre, code, chat bubbles)
    const KEY_ALIASES = {
      "satellite": "satellite_name",
      "satellite name": "satellite_name",
      "mission id": "mission_id",
      "mission": "mission_id",
      "operator": "operator",
      "operator on duty": "operator",
      "launch": "launch_date",
      "launch date": "launch_date",
      "orbit": "orbit_type",
      "orbit type": "orbit_type",
      "inclination": "orbital_inclination",
      "orbital inclination": "orbital_inclination",
      "apogee": "apogee",
      "perigee": "perigee",
      "freq": "ground_station_freq",
      "frequency": "ground_station_freq",
      "ground station freq": "ground_station_freq",
      "ground station frequency": "ground_station_freq",
      "enc key ref": "encryption_key_ref",
      "encryption key ref": "encryption_key_ref",
      "encryption key": "encryption_key_ref",
      "tle1": "tle_line_1",
      "tle 1": "tle_line_1",
      "tle line 1": "tle_line_1",
      "tle2": "tle_line_2",
      "tle 2": "tle_line_2",
      "tle line 2": "tle_line_2",
      "name": "name",
      "full name": "name",
      "username": "username",
      "user name": "username",
      "email": "email",
      "email address": "email",
      "phone": "phone",
      "phone number": "phone",
      "org": "company",
      "organisation": "company",
      "organization": "company",
      "company": "company",
      "zip": "zip",
      "pin": "zip",
      "pin code": "zip",
      "postal code": "zip",
      "address": "address",
      "password": "password",
      "designation": "about",
      "role": "about",
      "about": "about",
      "occupation": "occupation",
      "annual income": "annual_income",
      "income": "annual_income",
      "salary": "annual_income"
    };

    const textContainers = document.querySelectorAll(".datablock, .bubble, pre, code, .msg-row, .card, .chat-col, [role='main'], main, body");
    for (const container of textContainers) {
      const text = container.innerText || container.textContent || "";
      if (!text || text.length < 5) continue;

      // Match patterns like "Key: Value | Key2: Value" or "Key: Value\n"
      const lines = text.split(/[\r\n|]+/);
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z0-9\s_-]+)\s*[:=]\s*(.+?)\s*$/);
        if (match) {
          const rawKey = match[1].toLowerCase().trim();
          const rawVal = match[2].trim();
          const mappedKey = KEY_ALIASES[rawKey] || rawKey.replace(/[^a-z0-9]+/g, "_");
          if (mappedKey && rawVal && rawVal !== "Loading…" && !fields[mappedKey]) {
            fields[mappedKey] = rawVal;
          }
        }
      }
    }

    // 5. Specific regex extraction for TLE lines if present in text
    const fullBodyText = document.body ? (document.body.innerText || "") : "";
    if (!fields.tle_line_1) {
      const tle1Match = fullBodyText.match(/\b(1\s+\d{5}[A-Z]\s+[^\r\n]{30,60})/);
      if (tle1Match) fields.tle_line_1 = tle1Match[1].trim();
    }
    if (!fields.tle_line_2) {
      const tle2Match = fullBodyText.match(/\b(2\s+\d{5}\s+[^\r\n]{30,60})/);
      if (tle2Match) fields.tle_line_2 = tle2Match[1].trim();
    }

    sendResponse({ fields, count: Object.keys(fields).length });
    return true;
  }

  // ── Fill fields from vault data using data-vault-key ────────────────────────────
  if (msg.type === "FILL_VAULT_FIELDS") {
    const data = msg.data || {};
    const targetPage = msg.targetPage || null;

    // Navigate to the named page if specified
    if (targetPage) {
      const pageKey = String(targetPage).toLowerCase().trim();
      const pageAliases = {
        "form1": ["form-hr", "form1", "hr"],
        "form-hr": ["form-hr", "form1", "hr"],
        "hr": ["form-hr", "form1", "hr"],
        "form2": ["form-payroll", "form2", "payroll"],
        "form-payroll": ["form-payroll", "form2", "payroll"],
        "payroll": ["form-payroll", "form2", "payroll"],
        "form3": ["form-it", "form3", "it"],
        "form-it": ["form-it", "form3", "it"],
        "it": ["form-it", "form3", "it"],
        "form4": ["form-housing", "form4", "housing"],
        "form-housing": ["form-housing", "form4", "housing"],
        "housing": ["form-housing", "form4", "housing"],
        "form5": ["form-medical", "form5", "medical"],
        "form-medical": ["form-medical", "form5", "medical"],
        "medical": ["form-medical", "form5", "medical"],
      };
      const candidateIds = pageAliases[pageKey] || [pageKey];
      let navEl = null;
      let pageEl = null;
      for (const id of candidateIds) {
        navEl = document.querySelector(`.nav-item[data-page='${id}'], [data-page='${id}']`);
        pageEl = document.getElementById("page-" + id) || document.getElementById(id);
        if (navEl || pageEl) break;
      }
      if (navEl) {
        try { navEl.click(); } catch (_) {}
      }
      document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
      document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
      if (pageEl) pageEl.classList.add("active");
      if (navEl) navEl.classList.add("active");
    }

    const activePage = document.querySelector(".page.active");
    const container = activePage || document;
    const allFields = Array.from(container.querySelectorAll("input[data-vault-key], textarea[data-vault-key], select[data-vault-key]"));

    if (!allFields.length) {
      sendResponse({ ok: false, error: "No fillable fields on this page. Navigate to a form first." });
      return true;
    }

    // Split into fields we can fill and fields we need to ask about
    const fillable = allFields.filter(el => { const k = el.getAttribute("data-vault-key"); return k && data[k] !== undefined && data[k] !== ""; });
    const missing  = allFields.filter(el => { const k = el.getAttribute("data-vault-key"); return !k || data[k] === undefined || data[k] === ""; })
      .map(el => ({ key: el.getAttribute("data-vault-key"), label: el.closest(".fg")?.querySelector("label")?.textContent?.trim() || el.getAttribute("data-vault-key") }));

    (async () => {
      let filled = 0;
      for (const el of fillable) {
        const key = el.getAttribute("data-vault-key");
        const value = String(data[key]);
        el.focus();
        el.dispatchEvent(new Event("focus", { bubbles: true }));
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, ""); else el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        for (const char of value) {
          el.dispatchEvent(new KeyboardEvent("keydown",  { key: char, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
          const current = el.value;
          if (setter) setter.call(el, current + char); else el.value = current + char;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
          await new Promise(r => setTimeout(r, 30 + Math.random() * 40));
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur",   { bubbles: true }));
        filled++;
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      }
      sendResponse({ ok: true, filled, missing });
    })();
    return true;
  }
});

} // end guard

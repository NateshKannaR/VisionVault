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
const PHONE_RE    = /(?<![\d.₹$€£¥,])(?:\+?\d[\d\s\-().]{7,}\d)(?![\d%])/g;
const CARD_RE     = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;
const SSN_RE      = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
// Kept in step with the same identifiers in vision/ocrDetect.js. The two detectors read
// the same page by different routes - this one walks the DOM, that one reads the flattened
// pixels - so a shape recognised by only one of them is a hole that opens the moment a site
// renders the value as an image instead of text.
// UIDAI Aadhaar pattern with support for standard demo numbers starting with 1
const AADHAAR_RE  = /\b[1-9]\d{3}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}\b/g;
const PAN_RE      = /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g;
const PASSPORT_RE = /\b[A-Z][0-9]{7}\b/g;
const IFSC_RE     = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const UPI_RE      = /\b[a-zA-Z0-9.\-_]{2,40}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|axl|upi)\b/gi;
const VID_RE      = /\b\d{4}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}\b/g;
// GSTIN: 2-digit state code + PAN + 1 entity digit + Z + 1 check digit
const GSTIN_RE    = /\b\d{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b/g;
const DL_RE       = /\b[A-Z]{2}[-\s]?\d{2}[-\s]?\d{4}[-\s]?\d{7}\b|\b[A-Z]{2}[-\s]?\d{2}[-\s]?\d{11}\b/g;
const VEHICLE_RE  = /\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b/g;
const ACCOUNT_RE  = /\b(?:a\/c|acc(?:oun)?t(?:\s*(?:no|number|#))?|bank\s*a\/?c)\s*[:.#-]?\s*(\d{9,18})\b/gi;
const EMPLOYEE_ID_RE = /\b(?:ISRO|NASA|ESA|DRDO|BARC|EMP|STAFF|ID)[-\s]?\d{4,8}\b/gi;
const ROLE_NAME_RE   = /\b(?:HR|Admin|Lead|Director|Officer|Manager|Employee|Staff)\s*[—–-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
const NAME_WITH_ID_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*[—–-]\s*(?:ISRO|EMP|ID)?[-\s]?\d+/g;
const LABELED_VALUE_INLINE_RE = /(?:^|[|\n\r;])\s*([a-zA-Z0-9\s._\-#]+?)\s*[:=–—]\s*([^|\n\r<]{2,120})/g;

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
  "name", "surname", "first name", "last name", "full name", "username", "user id", "user",
  "aadhaar", "ssn", "social security", "national id", "voter", "passport", "license",
  "licence", "pan", "tax id", "nino", "date of birth", "dob", "birth", "age", "gender",
  "operator", "operator on duty", "duty", "mission", "mission id", "officer", "supervisor",
  "commander", "technician", "pilot", "personnel", "author", "creator", "admin", "agent",
  "employee", "staff", "applicant", "candidate", "member",
  // credentials & security
  "password", "passwd", "passcode", "pin", "otp", "secret", "api key", "token", "key",
  "encryption key", "encryption key ref", "enc key ref", "enc key", "encryption", "auth token", "private key",
  "clearance", "restricted", "confidential", "classified", "internal", "data classification",
  // orbital, aerospace & telemetry
  "satellite", "satellite name", "launch", "launch date", "apogee", "perigee", "inclination",
  "orbital inclination", "orbit type", "orbit", "tle", "tle1", "tle2", "tle line 1", "tle line 2",
  "frequency", "freq", "ground station", "ground station freq", "telemetry", "payload",
  // contact
  "email", "e-mail", "phone", "mobile", "telephone", "contact", "address", "street",
  "postcode", "post code", "zip", "postal", "postal code", "pincode", "city", "country", "state",
  "org", "organization", "organisation", "company",
  // financial
  "card", "credit card", "debit card", "cvv", "cvc", "expiry", "account number", "account no",
  "routing", "ifsc", "iban", "swift", "upi", "salary", "income", "annual income", "bank",
  // health / misc sensitive
  "insurance", "policy number", "medical", "diagnosis", "blood group", "marital status", "father name", "orbital",
  // tax identifiers
  "gstin", "gst", "tin", "vat", "tax number", "registration number", "cin", "llpin"
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
        el.getAttribute("data-testid"),
        el.getAttribute("placeholder"),
        el.getAttribute("title"),
        dataIcon(),
        el.getAttribute("name"),
        el.getAttribute("id"),
      ]
    : [
        el.innerText,
        el.getAttribute("data-page"),
        el.getAttribute("data-vault-key"),
        el.getAttribute("aria-label"),
        el.getAttribute("data-testid"),
        dataIcon(),
        el.getAttribute("title"),
        el.getAttribute("placeholder"),
        el.getAttribute("name"),
        el.getAttribute("id"),
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

const SAFE_APP_CHROME_WORDS = new Set([
  "whatsapp", "search", "search or start a new chat", "all", "unread", "favourites", "groups",
  "communities", "status", "channels", "chats", "calls", "settings", "profile", "ask meta ai",
  "send document", "add contact", "new chat", "menu", "attach", "type a message", "online",
  "voice and video calling is now available", "go to calls", "not a contact", "yesterday", "today"
]);

function isSafeAppChrome(text) {
  if (!text) return false;
  // Strip Unicode directional marks (LTR/RTL \u200E, \u200F), zero-width characters, and bullet separators
  const clean = String(text)
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0\u202A-\u202E]/g, " ")
    .replace(/[•·|—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (SAFE_APP_CHROME_WORDS.has(clean)) return true;
  if (/^\d+\s+unread(?:\s+messages?)?$/i.test(clean)) return true;
  if (/^not a contact/i.test(clean)) return true;
  return false;
}

function testPII(text) {
  if (!text || isSafeAppChrome(text)) return false;
  const tests = [EMAIL_RE, PHONE_RE, CARD_RE, SSN_RE, VID_RE, AADHAAR_RE, PAN_RE, DL_RE,
                 VEHICLE_RE, ACCOUNT_RE, PASSPORT_RE, IFSC_RE, UPI_RE, EMPLOYEE_ID_RE, GSTIN_RE];
  const probe = normalizeDigits(text);
  let result = tests.some(re => { re.lastIndex = 0; return re.test(probe); });
  tests.forEach(re => { re.lastIndex = 0; });
  if (result) return true;

  // Check labeled values (e.g. "Name: ...", "Operator: ...", "Address: ...", "Orbit: ...", "Satellite: ...")
  LABELED_VALUE_INLINE_RE.lastIndex = 0;
  let lm;
  while ((lm = LABELED_VALUE_INLINE_RE.exec(text)) !== null) {
    if (matchesPiiKeyword(lm[1].trim())) {
      LABELED_VALUE_INLINE_RE.lastIndex = 0;
      return true;
    }
  }
  LABELED_VALUE_INLINE_RE.lastIndex = 0;

  // Check employee names in role patterns ("HR — Priya Menon", "Rajesh Kumar — ISRO-10234")
  ROLE_NAME_RE.lastIndex = 0;
  if (ROLE_NAME_RE.test(text)) { ROLE_NAME_RE.lastIndex = 0; return true; }
  ROLE_NAME_RE.lastIndex = 0;

  NAME_WITH_ID_RE.lastIndex = 0;
  if (NAME_WITH_ID_RE.test(text)) { NAME_WITH_ID_RE.lastIndex = 0; return true; }
  NAME_WITH_ID_RE.lastIndex = 0;

  return false;
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
  const dataTab = el.getAttribute && el.getAttribute("data-tab");
  if (dataTab === "3" && (el.contentEditable === "true" || el.getAttribute("contenteditable") === "true")) return true;
  const testId = (el.getAttribute && el.getAttribute("data-testid") || "").toLowerCase();
  if (testId.includes("search") || testId.includes("chat-list-search")) return true;
  const ident = normalizeForKeywordMatch(
    [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("aria-label"), el.getAttribute("placeholder")].filter(Boolean).join(" ")
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

    // NEVER treat sidebar navigation items, header titles, tabs, buttons, or messaging chat items as PII label-value pairs!
    if (el.closest("nav, .sidebar, .topbar, .topbar-branding, .topbar-sub, .topbar-title, .topbar-actions, [role='navigation'], [role='tablist'], .nav-item, .nav-link, button, .btn, .switch-link, [role='listitem'], [data-testid*='chat'], [data-testid*='conversation'], [data-testid*='msg'], .message-in, .message-out, [role='feed']")) {
      return;
    }

    // Avoid treating complex containers or excessively large blocks as individual values
    if (el.children && el.children.length > 2) return;
    const r = el.getBoundingClientRect();
    if (r.height > 120 || r.width > 950) return;

    const prev = el.previousElementSibling || (el.parentElement && el.parentElement.previousElementSibling);
    if (!prev) return;
    const label = (prev.innerText || prev.textContent || "").trim();
    if (!label || label.length > MAX_LABEL_LEN) return;
    if (isSafeAppChrome(label)) return;
    // Genuine form labels are short descriptors (e.g. "Name:", "Account:"), not status phrases or full sentences
    if (label.split(/\s+/).length > 3 && !label.includes(":")) return;
    if (/\b(?:unread|messages?|not a contact|reserve bank|state bank|central bank|world bank)\b/i.test(label)) return;
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

function isCircular(el, rect) {
  try {
    const candidates = [el, el.parentElement, el.parentElement ? el.parentElement.parentElement : null].filter(Boolean);
    for (const node of candidates) {
      const style = getComputedStyle(node);
      const radius = style.borderRadius || "";
      const first = radius.split(/\s|\//)[0] || "";
      const shorter = Math.min(rect.w || 0, rect.h || 0);
      if (first.endsWith("%") && parseFloat(first) >= 40) return true;
      if (first.endsWith("px") && shorter > 0 && parseFloat(first) >= shorter * 0.4) return true;
      if (style.clipPath && (style.clipPath.includes("circle") || style.clipPath.includes("ellipse"))) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isAvatarElement(el, r) {
  if (!el) return false;
  const test = [
    el.getAttribute("alt"),
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    typeof el.className === "string" ? el.className : "",
    el.getAttribute("data-testid"),
    el.parentElement?.getAttribute("data-testid"),
    typeof el.parentElement?.className === "string" ? el.parentElement.className : "",
    el.parentElement?.getAttribute("aria-label"),
    el.closest(".avatar, .roster-avatar, .emp-sidebar-avatar, .badge-avatar-frame, [class*='avatar'], [class*='profile'], [class*='contact']")?.className,
    el.src
  ].filter(Boolean).join(" ").toLowerCase();

  // Strictly target avatars, profile pictures, employee badges, and biometric photos
  if (/\b(?:avatar|profile[-_ ]?(?:pic|photo|image|thumb)?|selfie|headshot|portrait|roster|badge[-_]?avatar|emp[-_]?sidebar|scientist|officer|face|contact)\b|emp[-_]|whatsapp\.net/i.test(test)) {
    return true;
  }
  if (r && r.w >= 18 && r.w <= 160 && isCircular(el, r)) {
    return true;
  }
  return false;
}

function findPiiRangesInTextNode(node, text) {
  const boxes = [];
  const tests = [
    { re: EMAIL_RE, label: "email" },
    { re: PHONE_RE, label: "phone" },
    { re: CARD_RE, label: "card" },
    { re: SSN_RE, label: "ssn" },
    { re: AADHAAR_RE, label: "aadhaar" },
    { re: PAN_RE, label: "pan" },
    { re: PASSPORT_RE, label: "passport" },
    { re: DL_RE, label: "driving_license" },
    { re: ACCOUNT_RE, label: "bank_account" },
    { re: IFSC_RE, label: "ifsc" },
    { re: UPI_RE, label: "upi" },
    { re: VID_RE, label: "vid" },
    { re: EMPLOYEE_ID_RE, label: "employee_id" },
    { re: GSTIN_RE, label: "gstin" },
  ];

  try {
    const range = document.createRange();

    // 1. Standard pattern regexes
    for (const { re, label } of tests) {
      const flags = (re.flags && re.flags.includes("i") ? "i" : "") + "g";
      const globalRe = new RegExp(re.source, flags);
      let m;
      while ((m = globalRe.exec(text)) !== null) {
        if (!m[0] || m[0].length < 3) continue;
        const val = m[0];
        // Guard against false positive matches on decimals, dates, or telemetry strings
        if (label === "phone" && (val.includes(".") || /[a-zA-Z]/.test(val) || val.replace(/\D/g, "").length < 9)) continue;
        if (label === "card" && (val.includes(".") || /[a-zA-Z]/.test(val) || val.replace(/\D/g, "").length < 13)) continue;
        const start = m.index;
        const end = m.index + m[0].length;
        try {
          range.setStart(node, start);
          range.setEnd(node, end);
          const rects = range.getClientRects();
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (r.width > 2 && r.height > 2) {
              boxes.push({
                x: Math.round(r.left),
                y: Math.round(r.top),
                w: Math.round(r.width),
                h: Math.round(r.height),
                label
              });
            }
          }
        } catch (_) {}
      }
    }

    // 2. Inline labeled key-value pairs (e.g. "Name: R. Sharma | Username: rsharma_mcc", "Orbit: ...", "Address: ...")
    LABELED_VALUE_INLINE_RE.lastIndex = 0;
    let lm;
    while ((lm = LABELED_VALUE_INLINE_RE.exec(text)) !== null) {
      const rawLabel = (lm[1] || "").trim();
      const rawVal = (lm[2] || "").trim();
      if (!rawLabel || !rawVal || rawVal.length < 2) continue;
      if (matchesPiiKeyword(rawLabel)) {
        const valOffset = lm[0].indexOf(lm[2]);
        if (valOffset !== -1) {
          const start = lm.index + valOffset;
          const end = start + rawVal.length;
          try {
            range.setStart(node, start);
            range.setEnd(node, end);
            const rects = range.getClientRects();
            for (let i = 0; i < rects.length; i++) {
              const r = rects[i];
              if (r.width > 2 && r.height > 2) {
                boxes.push({
                  x: Math.round(r.left),
                  y: Math.round(r.top),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                  label: rawLabel.toLowerCase().slice(0, 30)
                });
              }
            }
          } catch (_) {}
        }
      }
    }

    // 3. Person names following roles ("HR — Priya Menon")
    ROLE_NAME_RE.lastIndex = 0;
    let rm;
    while ((rm = ROLE_NAME_RE.exec(text)) !== null) {
      const name = (rm[1] || "").trim();
      if (name.length >= 3) {
        const valOffset = rm[0].lastIndexOf(rm[1]);
        if (valOffset !== -1) {
          const start = rm.index + valOffset;
          const end = start + name.length;
          try {
            range.setStart(node, start);
            range.setEnd(node, end);
            const rects = range.getClientRects();
            for (let i = 0; i < rects.length; i++) {
              const r = rects[i];
              if (r.width > 2 && r.height > 2) {
                boxes.push({
                  x: Math.round(r.left),
                  y: Math.round(r.top),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                  label: "name"
                });
              }
            }
          } catch (_) {}
        }
      }
    }

    // 4. Person names preceding employee IDs ("Rajesh Kumar — ISRO-10234")
    NAME_WITH_ID_RE.lastIndex = 0;
    let nm;
    while ((nm = NAME_WITH_ID_RE.exec(text)) !== null) {
      const name = (nm[1] || "").trim();
      if (name.length >= 3) {
        const valOffset = nm[0].indexOf(nm[1]);
        if (valOffset !== -1) {
          const start = nm.index + valOffset;
          const end = start + name.length;
          try {
            range.setStart(node, start);
            range.setEnd(node, end);
            const rects = range.getClientRects();
            for (let i = 0; i < rects.length; i++) {
              const r = rects[i];
              if (r.width > 2 && r.height > 2) {
                boxes.push({
                  x: Math.round(r.left),
                  y: Math.round(r.top),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                  label: "name"
                });
              }
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return boxes;
}

// ── Phase 1: scan for PII regions ────────────────────────────────────────────
function scanForPII() {
  const regions = [];
  const seen = new Set();
  let nodeCount = 0;

  function addBoxRegion(box, el, type, reason, label = null, extra = null) {
    if (!box || box.w < 2 || box.h < 2) return;
    if (el && type === "text") sensitiveTextEls.add(el);
    const key = `${box.x},${box.y},${box.w},${box.h}`;
    if (seen.has(key)) return;
    seen.add(key);

    const stableId = el ? (deterministicId(el, "pii") + "_" + box.x + "_" + box.y) : ("pii_" + box.x + "_" + box.y);
    regions.push({
      id: stableId,
      ...box,
      box,
      type,
      sensitive: true,
      reason,
      label,
      ...(extra || {})
    });
  }

  function addRegion(el, type, reason, label = null, extra = null) {
    if (!el) return;
    if (type === "text") sensitiveTextEls.add(el);
    const r = rectOf(el);
    if (r.w < 2 || r.h < 2) return;
    // Skip elements completely outside the current viewport
    if (r.x + r.w <= 0 || r.x >= window.innerWidth || r.y + r.h <= 0 || r.y >= window.innerHeight) return;
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

  // 1b. Explicit PII telemetry and value elements (e.g. [data-pii], .db-val, .tle-val, .badge-pii-val)
  querySelectorAllDeep("[data-pii], .db-val, .tle-val, .badge-pii-val").forEach(el => {
    const label = el.getAttribute("data-pii") || el.className || "pii_value";
    addRegion(el, "text", "context_labelled_pii", label);
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
          // Skip text nodes already contained in an explicitly redacted PII container or topbar chrome
          if (node.parentElement?.closest("[data-pii], .db-val, .tle-val, .badge-pii-val, .topbar-branding, .topbar-sub")) continue;
          const text = node.nodeValue || "";
          if (text.trim().length < 4) continue;
          if (isSafeAppChrome(text)) continue;
          if (testPII(text)) {
            const rangeBoxes = findPiiRangesInTextNode(node, text);
            if (rangeBoxes.length > 0) {
              for (const rBox of rangeBoxes) {
                addBoxRegion(rBox, node.parentElement, "text", "pii_text_match", rBox.label || "regex_pii");
              }
            } else {
              const pText = (node.parentElement?.innerText || "").trim();
              if (pText.length <= 40 && !isSafeAppChrome(pText)) {
                const r = rectOf(node.parentElement);
                if (r && r.h <= 50) {
                  addRegion(node.parentElement, "text", "pii_text_match", "regex_pii");
                }
              }
            }
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
  // 4. Media & Avatar Frames that hold a face, profile portrait, or identity document.
  const mediaElements = new Set([
    ...document.querySelectorAll("img, video, canvas, [role='img']"),
    ...document.querySelectorAll(".avatar, .badge-avatar-frame, .badge-avatar-img, [class*='avatar'], .emp-sidebar-avatar, .roster-avatar")
  ]);

  mediaElements.forEach(el => {
    const avatarParent = el.closest(".avatar, .badge-avatar-frame");
    const targetEl = avatarParent || el;
    if (targetEl.offsetParent === null && window.getComputedStyle(targetEl).position !== "fixed") return;
    const r = rectOf(targetEl);
    if (r.w >= 18 && r.h >= 18 && r.x + r.w > 0 && r.x < window.innerWidth && r.y + r.h > 0 && r.y < window.innerHeight) {
      const isAvatar = isAvatarElement(targetEl, r) || isAvatarElement(el, r);
      const isCirc = isAvatar || isCircular(targetEl, r) || isCircular(el, r);
      addRegion(targetEl, "media", isAvatar ? "profile_avatar" : "possible_face_or_media", isAvatar ? "profile_avatar" : "media", {
        alt: (el.getAttribute("alt") || targetEl.getAttribute("alt") || "").slice(0, 80),
        className: (typeof targetEl.className === "string" ? targetEl.className : "").slice(0, 80),
        src: (el.getAttribute("src") || targetEl.getAttribute("src") || "").slice(0, 120),
        circular: isCirc,
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
  if (role === "listitem" || role === "row" || role === "gridcell" || el.getAttribute("data-tab") != null) return "clickable";
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
    'a, button, input:not([type="hidden"]):not([type="file"]), textarea, select, label[for], [role="button"], [role="link"], [role="searchbox"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="listitem"], [role="row"], [role="gridcell"], [contenteditable="true"], [tabindex="0"], [aria-haspopup="listbox"], [aria-haspopup="true"], .nav-link, .nav-item, [data-page], [data-tab], [onclick], .btn, [id*="search" i], [name*="search" i], [name*="keywords" i], [class*="searchCity" i], [class*="searchToCity" i], [data-testid*="cell" i], [data-testid*="chat" i], [data-testid*="conversation" i]'
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

/**
 * Extracts a lightweight, token-efficient semantic screen representation.
 * Enables server/planner to reason over structured DOM elements with 0 pixel overhead.
 */
function extractSemanticScreen(marks) {
  const elements = (marks || []).map((m) => {
    const el = resolveMarkElement(m.id);
    const tag = el ? el.tagName.toLowerCase() : "unknown";
    const type = el && el.getAttribute("type") ? el.getAttribute("type").toLowerCase() : (tag === "button" ? "button" : tag);
    const isSensitive = isInsideSensitiveText(el) || (el && PII_INPUT_SELECTORS.some(sel => {
      try { return el.matches(sel); } catch (_) { return false; }
    }));
    return {
      id: String(m.id),
      type: type,
      role: m.role || "clickable",
      label: isSensitive ? null : (m.label || null),
      bbox: [m.box.x, m.box.y, m.box.w, m.box.h],
      sensitive: !!isSensitive,
      vaultKey: m.vaultKey || (el ? el.getAttribute("data-vault-key") : null),
      value: isSensitive ? (m.vaultKey ? `VAULT:${m.vaultKey.toUpperCase()}` : "VAULT:MASKED") : (el ? (el.value || el.innerText || "").slice(0, 80) : null)
    };
  });

  return {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    },
    elements
  };
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
    let piiRegions = [];
    try {
      piiRegions = scanForPII();
    } catch (err) {
      console.warn("[vagent] scanForPII non-fatal:", err);
    }

    let marks = [];
    try {
      marks = tagInteractiveElements();
    } catch (err) {
      console.warn("[vagent] tagInteractiveElements non-fatal:", err);
    }

    const semanticScreen = extractSemanticScreen(marks);

    return {
      piiRegions,
      marks,
      semanticScreen,
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

  if (actionType === "batch") {
    const executor = globalThis.ActionExecutor && globalThis.ActionExecutor.executeAction;
    if (typeof executor !== "function") {
      return { ok: false, error: "ActionExecutor not loaded in this frame." };
    }
    return executor(payload, resolveMarkElement);
  }

  // The executor owns the definition of which actions need a marked element; asking it keeps
  // the two from drifting apart. The fallback covers the (impossible in practice) case of
  // this frame having content.js without action-executor.js.
  const targetless = globalThis.ActionExecutor?.TARGETLESS_ACTIONS ||
    new Set(["scroll_page", "wait", "done", "dismiss_overlays", "open_search", "probe_query", "batch"]);

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

// ── In-Page Voice Dictation HUD ──────────────────────────────────────────────
let inPageRecognition = null;
let voiceHudEl = null;

function showVoiceHud(text) {
  if (voiceHudEl) voiceHudEl.remove();
  voiceHudEl = document.createElement("div");
  voiceHudEl.className = "vv-voice-hud";
  voiceHudEl.id = "vv-voice-hud-root";

  const micIcon = document.createElement("div");
  micIcon.className = "vv-voice-mic-icon";
  micIcon.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/>
    </svg>
  `;

  const transcript = document.createElement("div");
  transcript.className = "vv-voice-transcript";
  transcript.id = "vv-voice-transcript-text";
  transcript.textContent = text || "Listening…";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "vv-voice-close";
  cancelBtn.id = "vv-voice-cancel-btn";
  cancelBtn.title = "Stop listening";
  cancelBtn.textContent = "✕";
  cancelBtn.addEventListener("click", () => stopInPageVoiceDictation());

  voiceHudEl.appendChild(micIcon);
  voiceHudEl.appendChild(transcript);
  voiceHudEl.appendChild(cancelBtn);
  document.body.appendChild(voiceHudEl);
}

function updateVoiceHud(text) {
  const el = document.getElementById("vv-voice-transcript-text");
  if (el) {
    el.textContent = text || "Listening…";
    el.classList.add("live");
  }
}

function hideVoiceHud(msg = "", isError = false) {
  if (!voiceHudEl) return;
  if (msg) {
    const el = document.getElementById("vv-voice-transcript-text");
    if (el) {
      el.textContent = msg;
      if (isError) el.style.color = "#f87171";
    }
    setTimeout(() => {
      if (voiceHudEl) {
        voiceHudEl.remove();
        voiceHudEl = null;
      }
    }, 1500);
  } else {
    voiceHudEl.remove();
    voiceHudEl = null;
  }
}

function stopInPageVoiceDictation() {
  if (inPageRecognition) {
    try { inPageRecognition.stop(); } catch (_) {}
    inPageRecognition = null;
  }
  hideVoiceHud();
  try {
    chrome.runtime.sendMessage({ type: "VOICE_END" });
  } catch (_) {}
}

function startInPageVoiceDictation() {
  const Recognizer = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognizer) {
    try {
      chrome.runtime.sendMessage({
        type: "VOICE_ERROR",
        error: "Web Speech API is not supported in this browser tab."
      });
    } catch (_) {}
    return { ok: false, error: "not supported" };
  }

  stopInPageVoiceDictation();

  try {
    const rec = new Recognizer();
    rec.lang = navigator.language || "en-IN";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    showVoiceHud("Listening… Speak your command");

    rec.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      transcript = transcript.trim();
      updateVoiceHud(transcript);
      const isFinal = event.results[event.results.length - 1].isFinal;
      try {
        chrome.runtime.sendMessage({
          type: "VOICE_RESULT",
          transcript,
          isFinal
        });
      } catch (_) {}
      if (isFinal) {
        setTimeout(() => hideVoiceHud(), 800);
      }
    };

    rec.onerror = (event) => {
      const err = event.error || "unknown";
      hideVoiceHud(err === "no-speech" ? "Didn't catch that" : `Mic error: ${err}`, true);
      try {
        chrome.runtime.sendMessage({ type: "VOICE_ERROR", error: err });
      } catch (_) {}
    };

    rec.onend = () => {
      inPageRecognition = null;
      hideVoiceHud();
      try {
        chrome.runtime.sendMessage({ type: "VOICE_END" });
      } catch (_) {}
    };

    rec.start();
    inPageRecognition = rec;
    return { ok: true };
  } catch (err) {
    hideVoiceHud(`Could not start mic: ${err.message}`, true);
    try {
      chrome.runtime.sendMessage({ type: "VOICE_ERROR", error: err.message });
    } catch (_) {}
    return { ok: false, error: err.message };
  }
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

  if (msg.type === "INSERT_TEXT_TO_INPUT" && msg.text) {
    try {
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

      chatInput.focus();
      const isContentEditable = chatInput.isContentEditable;
      if (isContentEditable) {
        document.execCommand("insertText", false, (chatInput.innerText?.trim() ? "\n\n" : "") + msg.text);
        chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const proto = chatInput.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        const newText = (chatInput.value?.trim() ? chatInput.value + "\n\n" : "") + msg.text;
        if (setter) setter.call(chatInput, newText); else chatInput.value = newText;
        chatInput.dispatchEvent(new Event("input", { bubbles: true }));
        chatInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
    return true;
  }

  if (msg.type === "START_IN_PAGE_VOICE") {
    const res = startInPageVoiceDictation();
    sendResponse(res);
    return true;
  }

  if (msg.type === "STOP_IN_PAGE_VOICE") {
    stopInPageVoiceDictation();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "READ_VAULT_FIELDS") {
    const fields = {};
    const TELEMETRY_KEYS = new Set([
      "satellite_name", "mission_id", "orbit_type", "orbital_inclination",
      "apogee", "perigee", "ground_station_freq", "encryption_key_ref",
      "tle_line_1", "tle_line_2", "launch_date"
    ]);

    const KEY_ALIASES = {
      "satellite": "satellite_name",
      "satellite name": "satellite_name",
      "satellite_name": "satellite_name",
      "mission id": "mission_id",
      "mission": "mission_id",
      "mission_id": "mission_id",
      "operator": "operator",
      "operator on duty": "operator",
      "launch": "launch_date",
      "launch date": "launch_date",
      "launch_date": "launch_date",
      "orbit": "orbit_type",
      "orbit type": "orbit_type",
      "orbit_type": "orbit_type",
      "inclination": "orbital_inclination",
      "orbital inclination": "orbital_inclination",
      "orbital_inclination": "orbital_inclination",
      "apogee": "apogee",
      "perigee": "perigee",
      "freq": "ground_station_freq",
      "frequency": "ground_station_freq",
      "downlink": "ground_station_freq",
      "downlink freq": "ground_station_freq",
      "downlink frequency": "ground_station_freq",
      "downlink_freq": "ground_station_freq",
      "ground station freq": "ground_station_freq",
      "ground station frequency": "ground_station_freq",
      "ground_station_freq": "ground_station_freq",
      "enc key ref": "encryption_key_ref",
      "encryption key ref": "encryption_key_ref",
      "encryption key": "encryption_key_ref",
      "encryption_key_ref": "encryption_key_ref",
      "tle1": "tle_line_1",
      "tle 1": "tle_line_1",
      "tle-1": "tle_line_1",
      "tle_1": "tle_line_1",
      "tle line 1": "tle_line_1",
      "tle_line_1": "tle_line_1",
      "tle2": "tle_line_2",
      "tle 2": "tle_line_2",
      "tle-2": "tle_line_2",
      "tle_2": "tle_line_2",
      "tle line 2": "tle_line_2",
      "tle_line_2": "tle_line_2",
      "name": "name",
      "full name": "name",
      "username": "username",
      "user name": "username",
      "empid": "username",
      "emp id": "username",
      "emp_id": "username",
      "employee id": "username",
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
      "desc": "about",
      "description": "about",
      "dept": "about",
      "department": "about",
      "occupation": "occupation",
      "annual income": "annual_income",
      "income": "annual_income",
      "salary": "annual_income"
    };

    // Helper: detect active employee ID and name if present on page
    let activeEmp = "";
    let activeName = "";
    try {
      activeEmp = localStorage.getItem("isro_active_emp") || "";
      if (!activeEmp) {
        const selectEl = document.querySelector("#emp-select-box, select[name='active_employee']");
        if (selectEl) activeEmp = selectEl.value;
      }
      const nameEl = document.querySelector("#ov-name, .emp-chat-item.active .emp-chat-name, #topbar-emp-sub");
      if (nameEl) {
        const rawName = (nameEl.innerText || nameEl.textContent || "").trim();
        const m = rawName.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]*)+)/);
        if (m) activeName = m[1];
        else activeName = rawName;
      }
    } catch (_) {}

    // Priority 1 (Base): Scan localStorage for stored plaintext vault object or active chat messages
    try {
      const plainRaw = localStorage.getItem("isro_vault_plain");
      if (plainRaw) {
        const parsed = JSON.parse(plainRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v === "string" && v.trim()) fields[k] = v.trim();
          }
        }
      }
      if (activeEmp) {
        const empChatRaw = localStorage.getItem("isro_chat_hr_" + activeEmp);
        if (empChatRaw) {
          const msgs = JSON.parse(empChatRaw);
          if (Array.isArray(msgs)) {
            for (const m of msgs) {
              if (m.text) {
                try {
                  const obj = JSON.parse(m.text);
                  if (obj.type === "VAULT_MISSION" && obj.vault) {
                    for (const [vk, vv] of Object.entries(obj.vault)) {
                      if (vv && typeof vv === "string" && vv.trim()) fields[vk] = vv.trim();
                    }
                  }
                } catch (_) {}
              }
            }
          }
        }
      }
    } catch (_) {}

    // Priority 2: Inputs/controls on active page
    document.querySelectorAll(".page.active [data-vault-key], [data-vault-key]").forEach(el => {
      if (el.closest(".page:not(.active)")) return;
      const key = el.getAttribute("data-vault-key");
      const val = (el.value || el.innerText || el.textContent || "").trim();
      if (!key || !val || val === "Loading…") return;
      if (TELEMETRY_KEYS.has(key)) {
        if (fields.name && val.toLowerCase() === fields.name.toLowerCase()) return;
        if (/natesh/i.test(val) && key !== "operator") return;
      }
      if (!fields[key]) fields[key] = val;
    });

    // Priority 3: Overview & Badge Elements on page (Synchronous ground truth for active scientist)
    const ovMappings = [
      ["#ov-name", "name"],
      ["#ov-empid", "username"],
      ["#ov-email", "email"],
      ["#ov-org", "company"],
      ["#ov-sat-name", "satellite_name"],
      ["#ov-orbit-type", "orbit_type"],
      ["#ov-freq", "ground_station_freq"],
      ["#ov-dept", "about"]
    ];
    for (const [sel, key] of ovMappings) {
      const el = document.querySelector(sel);
      if (el) {
        let val = (el.innerText || el.textContent || "").trim();
        if (key === "ground_station_freq") val = val.replace(/^[●\s]+/, "").replace(/\s*LOCKED\s*$/i, "").trim();
        if (val && val !== "Loading…" && !val.includes("───")) fields[key] = val;
      }
    }

    // Priority 4: window.vaultData (authoritative full mission telemetry for active employee)
    try {
      if (typeof window.vaultData === "object" && window.vaultData !== null) {
        for (const [k, v] of Object.entries(window.vaultData)) {
          if (v && typeof v === "string" && v.trim()) fields[k] = v.trim();
        }
      }
    } catch (_) {}

    // Priority 5: Structured Key-Value blocks in visible DOM on active page
    const structuredContainers = document.querySelectorAll(".page.active .datablock, .page.active [data-vault-source='verified'], .page.active .bubble.in, .page.active .msg-row");
    for (const container of structuredContainers) {
      const text = container.innerText || container.textContent || "";
      if (!text || text.length < 5) continue;
      const lines = text.split(/[\r\n|]+/);
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z0-9\s_-]+)\s*[:=]\s*(.+?)\s*$/);
        if (match) {
          const rawKey = match[1].toLowerCase().trim();
          const rawVal = match[2].trim();
          const mappedKey = KEY_ALIASES[rawKey] || rawKey.replace(/[^a-z0-9]+/g, "_");
          if (mappedKey && rawVal && rawVal !== "Loading…" && !rawVal.includes("───")) {
            fields[mappedKey] = rawVal;
          }
        }
      }
    }

    // Priority 6 (HIGHEST): Explicit verified JSON payload on the ACTIVE screen
    const payloadEls = document.querySelectorAll(".page.active [data-vault-payload], [data-vault-payload]");
    payloadEls.forEach(payloadEl => {
      if (payloadEl.closest(".page:not(.active)")) return; // Skip inactive tabs
      try {
        const raw = payloadEl.getAttribute("data-vault-payload");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            // Guard: ensure payload belongs to active scientist if known
            if (activeName && (parsed.operator || parsed.name)) {
              const op = (parsed.operator || parsed.name).toLowerCase();
              const an = activeName.toLowerCase();
              const opFirst = op.split(" ")[0];
              const anFirst = an.split(" ")[0];
              if (!op.includes(anFirst) && !an.includes(opFirst)) {
                return; // Discard payload belonging to previous/different employee!
              }
            }
            for (const [k, v] of Object.entries(parsed)) {
              const cleanKey = k.toLowerCase().trim().replace(/[-_]/g, " ");
              const mappedKey = KEY_ALIASES[cleanKey] || KEY_ALIASES[k.toLowerCase().trim()] || k;
              if (v && typeof v === "string" && v.trim()) fields[mappedKey] = v.trim();
            }
          }
        }
      } catch (_) {}
    });

    // 5. Specific regex extraction for TLE lines if present in text
    const fullBodyText = document.body ? (document.body.innerText || "") : "";
    if (!fields.tle_line_1 || /natesh/i.test(fields.tle_line_1)) {
      const tle1Match = fullBodyText.match(/\b(1\s+\d{5}[A-Z]\s+[^\r\n]{30,60})/);
      if (tle1Match) fields.tle_line_1 = tle1Match[1].trim();
    }
    if (!fields.tle_line_2 || /natesh/i.test(fields.tle_line_2)) {
      const tle2Match = fullBodyText.match(/\b(2\s+\d{5}\s+[^\r\n]{30,60})/);
      if (tle2Match) fields.tle_line_2 = tle2Match[1].trim();
    }

    // 6. Final safety check: if telemetry fields are polluted by the user's name, clean them!
    const userName = fields.name || "";
    if (userName) {
      for (const tKey of TELEMETRY_KEYS) {
        if (fields[tKey] && fields[tKey].toLowerCase() === userName.toLowerCase()) {
          delete fields[tKey];
        }
      }
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
        "form6": ["form-gaganyaan", "form6", "gaganyaan"],
        "form-gaganyaan": ["form-gaganyaan", "form6", "gaganyaan"],
        "gaganyaan": ["form-gaganyaan", "form6", "gaganyaan"],
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
    let container = activePage || document;
    let allFields = Array.from(container.querySelectorAll("input[data-vault-key], textarea[data-vault-key], select[data-vault-key]"));

    if (!allFields.length) {
      // If currently on messages page or container has no fields, check if there's a form-hr page
      const formPage = document.getElementById("page-form-hr") || document.querySelector(".page[id*='form']");
      if (formPage) {
        document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
        document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
        formPage.classList.add("active");
        const hrNav = document.querySelector(".nav-item[data-page='form-hr']");
        if (hrNav) hrNav.classList.add("active");
        container = formPage;
        allFields = Array.from(container.querySelectorAll("input[data-vault-key], textarea[data-vault-key], select[data-vault-key]"));
      }
    }

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

// ── In-Page Live Chat Shield & Auto-Paste Redaction ──────────────────────────
function initInPageShield() {
  const LLM_HOSTS = [
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com",
    "perplexity.ai",
    "poe.com",
    "huggingface.co"
  ];

  const currentHost = (window.location.hostname || "").toLowerCase();
  const isLlmHost = LLM_HOSTS.some(host => currentHost === host || currentHost.endsWith("." + host));
  if (!isLlmHost) {
    // PrivacyScrubber, file interception, and RAM Redaction HUD only activate on LLM interfaces (ChatGPT, Claude, etc.)
    return;
  }

  let sessionRedactions = 0;
  let activePopover = null;
  let lastRedactedDoc = null;
  let globalSessionMap = {};

  // ── High-Tech RAM Processing HUD Overlay ──
  function showProcessingOverlay(fileName, fileType) {
    hideProcessingOverlay();
    const overlay = document.createElement("div");
    overlay.className = "vv-proc-overlay";
    overlay.id = "vv-proc-overlay";
    overlay.innerHTML = `
      <div class="vv-proc-card">
        <div style="font-size:28px;margin-bottom:8px;">🛡️</div>
        <div class="vv-proc-title">Zero-Trust RAM Redaction</div>
        <div class="vv-proc-sub">${fileName} · ${fileType}</div>
        <div class="vv-proc-bar"><div class="vv-proc-bar-fill"></div></div>
        <div class="vv-proc-note">Sanitizing 100% locally in memory · Zero data leaves device</div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function hideProcessingOverlay() {
    const existing = document.getElementById("vv-proc-overlay");
    if (existing) existing.remove();
  }

  function showToast(message, isSecret = false) {
    const existingToast = document.querySelector(".vv-shield-toast");
    if (existingToast) existingToast.remove();

    const toast = document.createElement("div");
    toast.className = "vv-shield-toast" + (isSecret ? " vv-toast-secret" : "");
    toast.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${isSecret ? '#fb7185' : '#38bdf8'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <polyline points="9 12 11 14 15 10"/>
      </svg>
      <div>${message}</div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.transition = "opacity 0.3s, transform 0.3s";
        toast.style.opacity = "0";
        toast.style.transform = "translateY(8px)";
        setTimeout(() => toast.remove(), 300);
      }
    }, 4000);
  }

  // ── Dispatch Clean Synthetic File to Chat (ChatGPT / Claude / Gemini) ──
  function dispatchCleanFileToChat(cleanFile, mode = "paste", targetEl = null) {
    const dt = new DataTransfer();
    dt.items.add(cleanFile);

    if (mode === "input") {
      const fileInput = (targetEl && targetEl.tagName === "INPUT" && targetEl.type === "file")
        ? targetEl
        : document.querySelector('input[type="file"]');
      if (fileInput) {
        try {
          Object.defineProperty(fileInput, "files", { value: dt.files, configurable: true });
        } catch (_) {}
        const chEvt = new Event("change", { bubbles: true });
        chEvt.isVvSynthetic = true;
        fileInput.dispatchEvent(chEvt);

        // Restore native HTMLInputElement.prototype.files getter and reset value
        // so subsequent file uploads work cleanly without needing page refresh.
        setTimeout(() => {
          try {
            delete fileInput.files;
            fileInput.value = "";
          } catch (_) {}
        }, 50);
        return;
      }
    }


    if (mode === "drop") {
      const dropTarget = targetEl || document.querySelector("#prompt-textarea, [data-testid='prompt-textarea'], textarea, form") || document.body;
      try {
        const dropEvt = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt
        });
        dropEvt.isVvSynthetic = true;
        dropTarget.dispatchEvent(dropEvt);
        return;
      } catch (_) {}
    }

    // mode === "paste" or universal fallback
    const pasteTarget = (targetEl && targetEl !== document.body)
      ? targetEl
      : (document.querySelector("#prompt-textarea, [data-testid='prompt-textarea'], textarea, div.ProseMirror[contenteditable='true']") || document.activeElement || document.body);
    try {
      const pasteEvt = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt
      });
      pasteEvt.isVvSynthetic = true;
      pasteTarget.dispatchEvent(pasteEvt);
    } catch (_) {}
  }

  // ── Find Active Prompt Composer Across LLM Platforms ──
  function findComposerElement() {
    const selectors = [
      "#prompt-textarea",
      "[data-testid='prompt-textarea']",
      "div.ProseMirror[contenteditable='true']",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true'][aria-label*='prompt' i]",
      "div[contenteditable='true'][aria-label*='message' i]",
      "rich-textarea .textarea",
      "div.ql-editor",
      "div[contenteditable='true']",
      "textarea",
      "input[type='text']"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height >= 12) return el;
      }
    }
    return document.activeElement && (document.activeElement.isContentEditable || document.activeElement.tagName === "TEXTAREA" || document.activeElement.tagName === "INPUT")
      ? document.activeElement
      : null;
  }

  // ── Inject Scrubbed Text into React / ProseMirror Composers (Whole Replacement) ──
  function injectScrubbedTextToComposer(text) {
    const el = findComposerElement();
    if (!el) return;

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const prev = el.value;
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      if (el._valueTracker) el._valueTracker.setValue(prev);
      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.focus();
      let ok = false;
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("delete", false);
        ok = document.execCommand("insertText", false, text.replace(/\r\n/g, "\n"));
      } catch (_) {
        ok = false;
      }

      if (!ok) {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          const pasteEvt = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt
          });
          pasteEvt.isVvSynthetic = true;
          pasteEvt.isVvBypass = true;
          pasteEvt.__vvRedacted = true;
          el.dispatchEvent(pasteEvt);
        } catch (_) {}
      }

      const cur = (el.innerText || el.textContent || "").trim();
      if (!cur && text.trim()) {
        try {
          let p = el.querySelector("p");
          if (!p) {
            p = document.createElement("p");
            el.innerHTML = "";
            el.appendChild(p);
          }
          p.textContent = text;
          p.classList.remove("placeholder");
          p.removeAttribute("data-placeholder");
        } catch (_) {
          el.innerText = text;
        }
      }

      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      } catch (_) {}
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
  }

  // ── Paste Scrubbed Text at Active Caret Position ──
  function insertPastedScrubbedText(target, text) {
    if (!target) {
      target = document.activeElement || findComposerElement();
    }
    if (!target) return false;

    // A. Native Input or Textarea
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const val = target.value || "";
      const nextVal = val.slice(0, start) + text + val.slice(end);
      const proto = target.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(target, nextVal);
      if (target._valueTracker) target._valueTracker.setValue(val);
      target.selectionStart = target.selectionEnd = start + text.length;
      target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    }

    // B. Rich-text contenteditable (ChatGPT ProseMirror, Claude, etc.)
    if (typeof target.focus === "function") {
      try { target.focus(); } catch (_) {}
    }

    // Step 1: Native execCommand("insertText") at active selection/caret
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (_) {
      ok = false;
    }

    // Step 2: If execCommand returned false, dispatch synthetic paste with DataTransfer
    if (!ok) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        const pasteEvt = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt
        });
        pasteEvt.isVvSynthetic = true;
        pasteEvt.isVvBypass = true;
        pasteEvt.__vvRedacted = true;
        target.dispatchEvent(pasteEvt);
        ok = true;
      } catch (_) {}
    }

    // Step 3: Check if text actually landed in composer
    const composer = target.closest?.('#prompt-textarea, [data-testid="prompt-textarea"], div.ProseMirror, [contenteditable="true"]') ||
                     findComposerElement() ||
                     target;
    const composerText = (composer.innerText || composer.textContent || "").trim();
    if (!composerText && text.trim()) {
      // Step 4: Fallback to whole-composer injection
      injectScrubbedTextToComposer(text);
    }

    return true;
  }

  // ── Intercept File Uploads & Drag-and-Drop ──
  async function handleInterceptedFile(file, targetEl = null, mode = "input") {
    if (!file || file.isVvSynthetic || file.__vvRedacted) return;

    const ext = (file.name || "").toLowerCase().split(".").pop();
    const isImage = file.type?.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "bmp"].includes(ext);
    const isDoc = file.type?.includes("pdf") || ["pdf", "txt", "csv", "json", "md", "py", "js", "ts", "log"].includes(ext);

    if (!isImage && !isDoc) return;

    showProcessingOverlay(file.name, isImage ? "Image (Faces & PII)" : "Document (Secrets & PII)");

    if (isImage) {
      const reader = new FileReader();
      reader.onload = function () {
        chrome.runtime.sendMessage({
          type: "REDACT_IMAGE_BLOB",
          dataUrl: reader.result
        }, async (resp) => {
          hideProcessingOverlay();
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            console.warn("[VisionVault] REDACT_IMAGE_BLOB notice:", chrome.runtime.lastError?.message || resp?.error);
            showToast(`⚠️ <strong>VisionVault Reloaded</strong>: Please refresh this page (F5) to re-arm the shield before pasting!`, true);
            return;
          }

          if (resp && resp.ok && resp.redactedDataUrl && (resp.regionsCount > 0)) {
            const count = resp.regionsCount || 0;
            sessionRedactions += count;
            updateComposerPillUI();
            showToast(`🛡️ <strong>VisionVault</strong>: Blacked out ${count} sensitive region(s) in "${file.name}"!`, true);

            try {
              const res = await fetch(resp.redactedDataUrl);
              const cleanBlob = await res.blob();
              const cleanFile = new File([cleanBlob], file.name || "redacted_image.png", { type: "image/png" });
              cleanFile.isVvSynthetic = true;
              cleanFile.__vvRedacted = true;
              dispatchCleanFileToChat(cleanFile, mode, targetEl);
            } catch (_) {}
          } else {
            showToast(`🛡️ VisionVault: Image "${file.name}" clean. Zero secrets detected.`, false);
            file.isVvSynthetic = true;
            file.__vvRedacted = true;
            dispatchCleanFileToChat(file, mode, targetEl);
          }
        });
      };
      reader.readAsDataURL(file);
      return;
    }

    if (isDoc) {
      const Scrubber = window.PdfScrubber || globalThis.PdfScrubber;
      if (!Scrubber) {
        hideProcessingOverlay();
        file.isVvSynthetic = true;
        dispatchCleanFileToChat(file, mode, targetEl);
        return;
      }
      try {
        const res = await Scrubber.redactDocument(file, file.name);
        hideProcessingOverlay();
        if (res && res.findings && res.findings.length > 0) {
          sessionRedactions += res.findings.length;
          lastRedactedDoc = res;
          Object.assign(globalSessionMap, res.tokenMap || {});
          updateComposerPillUI();
          renderTokenChipsBar();

          const summaryTokens = res.findings.map(f => f.token).slice(0, 3).join(", ");
          const extra = res.findings.length > 3 ? ` +${res.findings.length - 3} more` : "";
          showToast(`🛡️ <strong>VisionVault</strong>: Auto-redacted ${res.findings.length} secret(s) in "${file.name}" <span class="vv-toast-badge">[${summaryTokens}${extra}]</span>`, true);

          // Upload sanitized document file to ChatGPT (PrivacyScrubber pattern)
          const baseName = file.name.replace(/\.[^/.]+$/, "");
          const scrubbedFileName = `${baseName}_scrubbed.txt`;
          const cleanDocFile = new File([res.sanitizedText], scrubbedFileName, { type: "text/plain" });
          cleanDocFile.isVvSynthetic = true;
          cleanDocFile.__vvRedacted = true;
          dispatchCleanFileToChat(cleanDocFile, mode, targetEl);
        } else {
          showToast(`🛡️ VisionVault: Document "${file.name}" clean. Zero secrets detected.`, false);
          file.isVvSynthetic = true;
          file.__vvRedacted = true;
          dispatchCleanFileToChat(file, mode, targetEl);
        }
      } catch (err) {
        hideProcessingOverlay();
        console.warn("[VisionVault] Document scan warning:", err);
        file.isVvSynthetic = true;
        dispatchCleanFileToChat(file, mode, targetEl);
      }
    }
  }

  // Intercept file input change events
  window.addEventListener("change", async function (e) {
    if (e.isVvSynthetic) return;
    const target = e.target;
    if (target && target.tagName === "INPUT" && target.type === "file" && target.files && target.files.length > 0) {
      const files = Array.from(target.files);
      const hasInterceptable = files.some(f => {
        const ext = (f.name || "").toLowerCase().split(".").pop();
        return ["pdf", "txt", "csv", "json", "md", "py", "js", "ts", "log", "png", "jpg", "jpeg", "webp", "bmp"].includes(ext);
      });
      if (!hasInterceptable) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      for (const file of files) {
        await handleInterceptedFile(file, target, "input");
      }
    }
  }, true);


  // Intercept file drag-and-drop
  window.addEventListener("drop", async function (e) {
    if (e.isVvSynthetic) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      for (const file of files) {
        await handleInterceptedFile(file, e.target, "drop");
      }
    }
  }, true);

  // Intercept Paste Events in capturing phase
  document.addEventListener("paste", function (e) {
    if (e.isVvSynthetic || e.isVvBypass || e.__vvRedacted) return;

    // Check for image pastes
    if (e.clipboardData && e.clipboardData.items) {
      const imgItem = Array.from(e.clipboardData.items).find(it => it.type && it.type.startsWith("image/"));
      if (imgItem) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const file = imgItem.getAsFile();
        if (file) {
          handleInterceptedFile(file, e.target, "paste");
        }
        return;
      }
    }

    const pastedText = e.clipboardData?.getData("text/plain");
    if (!pastedText || !window.PromptScrubber) return;

    const scrubResult = window.PromptScrubber.scrub(pastedText);
    if (scrubResult.matches && scrubResult.matches.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      sessionRedactions += scrubResult.matches.length;
      Object.assign(globalSessionMap, scrubResult.tokenMap || {});
      insertPastedScrubbedText(e.target, scrubResult.sanitized);
      updateComposerPillUI();
      renderTokenChipsBar();

      const summaryList = scrubResult.matches.map(m => m.token).slice(0, 3).join(", ");
      const extraCount = scrubResult.matches.length > 3 ? ` +${scrubResult.matches.length - 3} more` : "";
      showToast(`🛡️ <strong>VisionVault</strong>: Auto-redacted ${scrubResult.matches.length} secret(s) <span class="vv-toast-badge">[${summaryList}${extraCount}]</span>`, true);
    }
  }, true);

  // ── Mid-Flight Enter Key & Send Button Interceptors ──
  function setupSubmitInterceptors() {
    // Keydown capturing for Enter
    document.addEventListener("keydown", function (e) {
      if (e.isVvBypass) return;
      if (e.key === "Enter" && !e.shiftKey) {
        const target = e.target;
        if (!target) return;
        const isComposer = target.id === "prompt-textarea" ||
                           target.matches?.('[data-testid="prompt-textarea"], #prompt-textarea, div.ProseMirror[contenteditable="true"], textarea') ||
                           target.closest?.('#prompt-textarea, [data-testid="prompt-textarea"]');
        if (!isComposer) return;

        const currentText = target.tagName === "TEXTAREA" || target.tagName === "INPUT" ? target.value : (target.innerText || target.textContent || "");
        if (!currentText || !window.PromptScrubber) return;

        const scrubRes = window.PromptScrubber.scrub(currentText);
        if (scrubRes.matches && scrubRes.matches.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          sessionRedactions += scrubRes.matches.length;
          Object.assign(globalSessionMap, scrubRes.tokenMap || {});
          injectScrubbedTextToComposer(scrubRes.sanitized);
          updateComposerPillUI();
          renderTokenChipsBar();

          showToast(`🛡️ VisionVault: Protected ${scrubRes.matches.length} sensitive item(s) before sending!`, true);

          setTimeout(() => {
            const bypassEvt = new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
              composed: true
            });
            bypassEvt.isVvBypass = true;
            target.dispatchEvent(bypassEvt);
          }, 80);
        }
      }
    }, true);

    // Send button click capturing
    document.addEventListener("click", function (e) {
      if (e.isVvBypass) return;
      const btn = e.target.closest?.('button[data-testid="send-button"], button[data-testid="composer-send-button"], button[aria-label="Send prompt"], form button[type="submit"], button[aria-label="Send message"]');
      if (!btn) return;

      const composer = findComposerElement();
      if (!composer || !window.PromptScrubber) return;

      const currentText = composer.tagName === "TEXTAREA" || composer.tagName === "INPUT" ? composer.value : (composer.innerText || composer.textContent || "");
      if (!currentText) return;

      const scrubRes = window.PromptScrubber.scrub(currentText);
      if (scrubRes.matches && scrubRes.matches.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        sessionRedactions += scrubRes.matches.length;
        Object.assign(globalSessionMap, scrubRes.tokenMap || {});
        injectScrubbedTextToComposer(scrubRes.sanitized);
        updateComposerPillUI();
        renderTokenChipsBar();

        showToast(`🛡️ VisionVault: Protected ${scrubRes.matches.length} sensitive item(s) before sending!`, true);

        setTimeout(() => {
          const bypassClick = new MouseEvent("click", { bubbles: true, cancelable: true });
          bypassClick.isVvBypass = true;
          btn.dispatchEvent(bypassClick);
        }, 80);
      }
    }, true);
  }

  // ── Protected Token Chips Bar ──
  function renderTokenChipsBar() {
    let bar = document.getElementById("vv-token-chips-bar");
    const activeTokens = Object.entries(globalSessionMap);

    if (activeTokens.length === 0) {
      if (bar) bar.remove();
      return;
    }

    if (!bar) {
      bar = document.createElement("div");
      bar.id = "vv-token-chips-bar";
      bar.className = "vv-token-chips-bar";

      const composerParent = document.querySelector("form, #composer-background, [class*='composer'], fieldset") || document.body;
      if (composerParent.parentElement) {
        composerParent.parentElement.insertBefore(bar, composerParent.nextSibling);
      } else {
        document.body.appendChild(bar);
      }
    }

    bar.innerHTML = `
      <div class="vv-chips-header">
        <div class="vv-chips-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          Protected Session Tokens (${activeTokens.length})
        </div>
        <div>Hover preview · Click ✕ to restore</div>
      </div>
      <div class="vv-chips-list"></div>
    `;

    const list = bar.querySelector(".vv-chips-list");
    for (const [token, original] of activeTokens) {
      const chip = document.createElement("div");
      chip.className = "vv-token-chip";
      chip.innerHTML = `
        <span>${token}</span>
        <div class="vv-chip-lens">Original: <strong>${original}</strong></div>
        <button type="button" class="vv-chip-restore" title="Restore original value">✕</button>
      `;

      chip.querySelector(".vv-chip-restore").addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        delete globalSessionMap[token];
        const composer = findComposerElement();
        if (composer) {
          const cur = composer.tagName === "TEXTAREA" || composer.tagName === "INPUT" ? composer.value : (composer.innerText || composer.textContent || "");
          if (cur.includes(token)) {
            injectScrubbedTextToComposer(cur.split(token).join(original));
          }
        }
        renderTokenChipsBar();
        updateComposerPillUI();
        showToast(`Restored "${original}"`);
      });

      list.appendChild(chip);
    }
  }

  // ── In-Composer Pill & Floating Badge ──
  function updateComposerPillUI() {
    const pill = document.querySelector(".vv-composer-pill");
    const composer = findComposerElement();
    if (!composer || !window.PromptScrubber) return;

    const text = composer.tagName === "TEXTAREA" || composer.tagName === "INPUT" ? composer.value : (composer.innerText || composer.textContent || "");
    const res = window.PromptScrubber.scrub(text || "");
    const count = res.matches?.length || 0;

    if (pill) {
      if (count > 0) {
        pill.classList.add("has-pii");
        pill.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>🛡️ ${count} PII</span>
        `;
      } else {
        pill.classList.remove("has-pii");
        pill.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>🛡️ VV Active</span>
        `;
      }
    }

    const statCount = document.getElementById("vv-stat-count");
    if (statCount) statCount.textContent = sessionRedactions;
  }

  function createComposerPill() {
    const pill = document.createElement("div");
    pill.className = "vv-composer-pill";
    pill.setAttribute("title", "VisionVault Shield Active (100% On-Device RAM Redaction)");
    pill.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <span>🛡️ VV Active</span>
    `;
    pill.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePopover(pill);
    });
    return pill;
  }

  function togglePopover(anchor) {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
      anchor.classList.remove("active");
      return;
    }

    anchor.classList.add("active");
    const popover = document.createElement("div");
    popover.className = "vv-shield-popover";
    popover.innerHTML = `
      <div class="vv-popover-header">
        <div class="vv-popover-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          VisionVault In-Page Shield
        </div>
        <div class="vv-popover-status">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;"></span>
          100% LOCAL
        </div>
      </div>
      <div class="vv-popover-desc">
        Zero-trust local prompt, image, and document scrubber. Masks PII, Aadhaar numbers, and API keys before submission to cloud LLMs.
      </div>
      <div class="vv-popover-stats">
        <div class="vv-stat-item">
          <span class="vv-stat-val" id="vv-stat-count">${sessionRedactions}</span>
          <span class="vv-stat-lbl">Redacted Items</span>
        </div>
        <div class="vv-stat-item" style="text-align:right;">
          <span class="vv-stat-val" style="color:#10b981;">0ms</span>
          <span class="vv-stat-lbl">Network Latency</span>
        </div>
      </div>
      <button type="button" class="vv-popover-btn" id="vv-scrub-input-btn">
        Scrub Current Input Box Now
      </button>
      <button type="button" class="vv-popover-btn" id="vv-reveal-chat-btn" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);">
        De-Scrub / Reveal Assistant Response
      </button>
    `;

    popover.querySelector("#vv-scrub-input-btn").addEventListener("click", () => {
      manualScrubActiveInput();
    });

    popover.querySelector("#vv-reveal-chat-btn").addEventListener("click", () => {
      revealTokensInChat();
    });

    anchor.appendChild(popover);
    activePopover = popover;

    const outsideListener = function (evt) {
      if (!anchor.contains(evt.target)) {
        if (activePopover) {
          activePopover.remove();
          activePopover = null;
          anchor.classList.remove("active");
        }
        document.removeEventListener("click", outsideListener, true);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", outsideListener, true);
    }, 10);
  }

  function revealTokensInChat() {
    const turns = document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn, div.markdown.prose, [data-message-model-slug]');
    let revealedCount = 0;
    for (const turn of turns) {
      let html = turn.innerHTML;
      for (const [token, original] of Object.entries(globalSessionMap)) {
        if (html.includes(token)) {
          html = html.split(token).join(`<span style="background:rgba(16,185,129,0.15);color:#10b981;padding:1px 4px;border-radius:4px;border:1px solid rgba(16,185,129,0.3);font-weight:600;" title="VisionVault Restored: ${token}">${original}</span>`);
          revealedCount++;
        }
      }
      turn.innerHTML = html;
    }
    showToast(`🛡️ VisionVault: Restored ${revealedCount} token(s) locally in response!`);
  }

  function manualScrubActiveInput() {
    const input = findComposerElement();
    if (!input || !window.PromptScrubber) {
      showToast("No active chat input found to scrub.");
      return;
    }

    const currentText = input.tagName === "TEXTAREA" || input.tagName === "INPUT" ? input.value : (input.innerText || input.textContent || "");
    if (!currentText || !currentText.trim()) {
      showToast("Input box is empty.");
      return;
    }

    const res = window.PromptScrubber.scrub(currentText);
    if (res.matches && res.matches.length > 0) {
      sessionRedactions += res.matches.length;
      Object.assign(globalSessionMap, res.tokenMap || {});
      injectScrubbedTextToComposer(res.sanitized);
      updateComposerPillUI();
      renderTokenChipsBar();
      showToast(`🛡️ VisionVault: Sanitized ${res.matches.length} item(s) in prompt!`, true);
    } else {
      showToast("🛡️ VisionVault: No secrets or PII detected in prompt. Ready to send!", false);
    }
  }

  function tryMountComposerPill() {
    if (document.querySelector(".vv-composer-pill")) return;

    // Strategy 1: Modern ChatGPT composer action controls container
    const chatGptSend = document.querySelector(
      'button[data-testid="send-button"], button[data-testid="composer-send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="voice" i], button[aria-label*="speech" i], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"], form button[type="submit"], button[class*="send"][class*="button"]'
    );
    if (chatGptSend && chatGptSend.parentElement) {
      const pill = createComposerPill();
      chatGptSend.parentElement.insertBefore(pill, chatGptSend);
      return;
    }

    // Strategy 2: Claude controls
    const claudeSend = document.querySelector('button[aria-label="Send Message"], fieldset button:last-child');
    if (claudeSend && claudeSend.parentElement) {
      const pill = createComposerPill();
      claudeSend.parentElement.insertBefore(pill, claudeSend);
      return;
    }

    // Strategy 3: Gemini controls
    const geminiSend = document.querySelector('.send-button-container, button[aria-label*="Send prompt"]');
    if (geminiSend && geminiSend.parentElement) {
      const pill = createComposerPill();
      geminiSend.parentElement.insertBefore(pill, geminiSend);
      return;
    }

    // Strategy 4: Relative / absolute positioning inside composer wrapper (PrivacyScrubber style fallback)
    const composerWrapper = document.querySelector(
      'form:has(#prompt-textarea), #composer-background, [class*="composer-background"], div:has(> #prompt-textarea)'
    );
    if (composerWrapper) {
      const pill = createComposerPill();
      pill.style.position = "absolute";
      pill.style.bottom = "10px";
      pill.style.right = "145px";
      pill.style.zIndex = "100";
      composerWrapper.style.position = composerWrapper.style.position || "relative";
      composerWrapper.appendChild(pill);
      return;
    }

    // Strategy 5: Near #prompt-textarea or any textarea on LLM page
    const promptArea = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], form textarea');
    if (promptArea && promptArea.parentElement) {
      const pill = createComposerPill();
      promptArea.parentElement.appendChild(pill);
      return;
    }
  }

  // Initialize mid-flight prompt submit interceptors
  setupSubmitInterceptors();

  // Periodic poll & observer for dynamic SPA re-renders
  tryMountComposerPill();
  const obs = new MutationObserver(() => {
    tryMountComposerPill();
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Re-check on input, keyup, focusin (matching PrivacyScrubber ChatGPT fallback)
  const onUserActivity = (e) => {
    const target = e.target;
    if (target && (target.closest?.('#prompt-textarea, [data-testid="prompt-textarea"]') || target.id === 'prompt-textarea' || target.closest?.('form'))) {
      tryMountComposerPill();
      updateComposerPillUI();
    }
  };
  document.addEventListener("input", onUserActivity, { capture: true, passive: true });
  document.addEventListener("keyup", onUserActivity, { capture: true, passive: true });
  document.addEventListener("focusin", onUserActivity, { capture: true, passive: true });
  document.addEventListener("paste", onUserActivity, { capture: true, passive: true });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initInPageShield);
  } else {
    initInPageShield();
  }
}


} // end guard

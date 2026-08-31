if (window.__vagentLoaded) { /* already loaded */ } else {
window.__vagentLoaded = true;

const markMap = new Map();

// ── PII input selectors ──────────────────────────────────────────────────────
const PII_INPUT_SELECTORS = [
  'input[type="password"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[autocomplete*="cc-"]',
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
];

// ── PII text regexes ─────────────────────────────────────────────────────────
const EMAIL_RE   = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE   = /(\+?\d[\d\s\-().]{7,}\d)/g;
const CARD_RE    = /\b(?:\d[ -]*?){13,16}\b/g;
const SSN_RE     = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;

// ── Safe label whitelist (only these words travel to server) ─────────────────
const SAFE_LABEL_WHITELIST = [
  "submit", "next", "continue", "login", "log in", "sign in", "sign up",
  "search", "send", "cancel", "back", "confirm", "ok", "save", "register",
  "proceed", "finish", "done", "apply", "update", "create", "delete",
  "upload", "download", "close", "open", "add", "remove", "edit",
];

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

function safeLabel(el) {
  const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
  if (!text) return null;
  const match = SAFE_LABEL_WHITELIST.find(w => text === w || text.startsWith(w + " ") || text.endsWith(" " + w));
  return match || null;
}

function testPII(text) {
  const tests = [EMAIL_RE, PHONE_RE, CARD_RE, SSN_RE, AADHAAR_RE];
  const result = tests.some(re => { re.lastIndex = 0; return re.test(text); });
  tests.forEach(re => { re.lastIndex = 0; });
  return result;
}

// ── Phase 1: scan for PII regions ────────────────────────────────────────────
function scanForPII() {
  const regions = [];
  const seen = new Set();

  function addRegion(el, type, reason) {
    if (!el) return;
    const r = rectOf(el);
    if (r.w < 2 || r.h < 2) return;
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (seen.has(key)) return;
    seen.add(key);
    regions.push({ ...r, type, reason });
  }

  // Sensitive form fields
  document.querySelectorAll(PII_INPUT_SELECTORS.join(",")).forEach(el => {
    addRegion(el, "form_field", "sensitive_input");
  });

  // PII text nodes
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || "";
    if (text.trim().length < 4) continue;
    if (testPII(text)) addRegion(node.parentElement, "text", "pii_text_match");
  }

  // Images and videos (potential faces)
  document.querySelectorAll("img, video, canvas").forEach(el => {
    if (el.offsetParent === null) return;
    const r = rectOf(el);
    // Skip tiny icons (< 48x48)
    if (r.w >= 48 && r.h >= 48) addRegion(el, "media", "possible_face_or_media");
  });

  return regions;
}

// ── Phase 1: tag interactive elements ────────────────────────────────────────
function inferRole(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.type || "").toLowerCase();
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (tag === "input") {
    if (type === "submit" || type === "button") return "button";
    if (type === "search" || role === "searchbox" || role === "combobox") return "input:search";
    return `input:${type || "text"}`;
  }
  if (tag === "button" || role === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  if (el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "plaintext-only") return "editable";
  return "element";
}

function tagInteractiveElements() {
  markMap.clear();
  const marks = [];
  let id = 1;

  const interactive = document.querySelectorAll(
    'button, a[href], input:not([type="hidden"]):not([type="file"]), select, textarea, [role="button"], [role="link"], [role="searchbox"], [role="combobox"], [onclick], [contenteditable="true"], [contenteditable="plaintext-only"]'
  );

  interactive.forEach(el => {
    // offsetParent is null for fixed/sticky elements too — use a rect check instead
    const r = rectOf(el);
    if (r.w < 4 || r.h < 4) return;

    el.setAttribute("data-vagent-mark", String(id));
    markMap.set(id, el);

    marks.push({
      id,
      role: inferRole(el),
      box: r,
      label: safeLabel(el),
      // NOT sent: el.value, el.name, el.id, el.textContent (unfiltered)
    });
    id++;
  });

  return marks;
}

// ── Phase 2: execute actions ──────────────────────────────────────────────────
async function executeAction(action, mark_id, value) {
  const el = markMap.get(mark_id);
  if (!el) return { ok: false, error: `mark_id ${mark_id} not found` };

  try {
    switch (action) {
      case "press_key":
        el.focus();
        el.dispatchEvent(new KeyboardEvent("keydown",  { key: value, code: value === "Enter" ? "Enter" : value, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: value, code: value === "Enter" ? "Enter" : value, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keyup",    { key: value, code: value === "Enter" ? "Enter" : value, bubbles: true }));
        // For non-contenteditable: also submit closest form
        if ((value === "Enter" || value === "Return") && !el.isContentEditable) {
          const form = el.closest("form");
          if (form) {
            const submitBtn = form.querySelector('[type="submit"]');
            if (submitBtn) submitBtn.click();
            else form.submit();
          }
        }
        break;

      case "wait":
        // value = milliseconds to wait (max 5000)
        await new Promise(r => setTimeout(r, Math.min(Number(value) || 1000, 5000)));
        break;

      case "click":
        el.focus();
        el.click();
        break;

      case "type": {
        const delay = (ms) => new Promise(r => setTimeout(r, ms));
        const humanDelay = () => delay(18 + Math.random() * 17); // 18-35ms per char
        el.focus();
        await delay(60); // focus settle
        if (el.isContentEditable) {
          el.focus();
          await delay(150);
          // Select all existing content and delete it
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false, null);
          await delay(50);
          // Insert text character by character so React state updates
          for (const char of (value ?? '')) {
            document.execCommand('insertText', false, char);
            await humanDelay();
          }
          // Fire input event so framework picks up the change
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: true,
            inputType: 'insertText', data: value
          }));
        } else {
          const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          let current = "";
          for (const char of (value ?? "")) {
            current += char;
            if (nativeSetter) nativeSetter.call(el, current);
            else el.value = current;
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
            await humanDelay();
          }
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        break;
      }

      case "clear":
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        break;

      case "select":
        // For <select> dropdowns — value is the option value or visible text
        if (el.tagName.toLowerCase() === "select") {
          const opt = Array.from(el.options).find(
            o => o.value === value || o.text.toLowerCase() === (value || "").toLowerCase()
          );
          if (opt) {
            el.value = opt.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            return { ok: false, error: `Option "${value}" not found in select` };
          }
        }
        break;

      case "hover":
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        break;

      case "focus":
        el.focus();
        break;

      case "scroll":
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        break;

      case "scroll_page":
        window.scrollBy({ top: value ?? 300, behavior: "smooth" });
        break;

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SCAN_PAGE") {
    const piiRegions = scanForPII();
    const marks = tagInteractiveElements();
    sendResponse({ piiRegions, marks });
    return true;
  }

  if (msg.type === "EXECUTE_ACTION") {
    const { action, mark_id, value } = msg.payload;
    executeAction(action, mark_id, value).then(result => sendResponse(result));
    return true;
  }

  if (msg.type === "GET_PAGE_INFO") {
    sendResponse({
      title: document.title.substring(0, 80),
      url: location.origin + location.pathname,
      url_path: location.pathname,
      scroll_y: window.scrollY,
      page_height: document.body.scrollHeight,
      viewport_height: window.innerHeight,
    });
    return true;
  }
});

} // end __vagentLoaded guard

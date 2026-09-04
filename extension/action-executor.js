/**
 * action-executor.js — THE action executor for VisionVault.
 *
 * This is the single, authoritative implementation of DOM action dispatch. It is loaded as a
 * content script (see manifest.json content_scripts) into every frame, alongside content.js,
 * which delegates to it. There is deliberately no second executor anywhere in the codebase.
 *
 * Everything here is generic. There are no per-site selectors, no hostname checks and no
 * hardcoded class names: the executor works from standard HTML semantics (form ownership,
 * input types, submit buttons), ARIA (`role`, `aria-label`, `aria-expanded`) and observable
 * behaviour (did a text field appear? did the value land?). That is the only way to behave
 * consistently on a site nobody has seen before.
 *
 * Supported action types:
 *   click, type, press_key, select, check, scroll_page, scroll_to, clear, scroll, hover,
 *   focus, wait, upload, dismiss_overlays, open_search, probe_query, search_url,
 *   detect_bot_wall, done
 */

(function (global) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const humanDelay = () => delay(8 + Math.random() * 12);

  // Above this length, typing is committed in one shot instead of per-character, so that long
  // values (addresses, bios) do not add seconds of latency to a step.
  const PER_CHAR_TYPING_LIMIT = 60;

  // ── Visibility helpers ──────────────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05) return false;
    return true;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /** Readable text for a control, from ARIA first and visible text second. Never from a value. */
  function controlText(el) {
    if (!el) return "";
    const bits = [
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("title"),
      el.getAttribute && el.getAttribute("placeholder"),
      el.getAttribute && el.getAttribute("data-testid"),
      el.getAttribute && el.getAttribute("name"),
      el.id,
      (el.textContent || "").trim().slice(0, 80),
    ];
    return bits.filter(Boolean).join(" ").toLowerCase();
  }

  // ── Overlays: cookie banners, consent walls, login modals ────────────────────────────────

  // Split in two on purpose. Closing something is always safe; agreeing to something is not.
  //
  //   CLOSE_RE    dismisses an overlay without agreeing to anything. Allowed anywhere.
  //   CONSENT_RE  accepts something. Allowed ONLY inside an overlay that is demonstrably a
  //               cookie or tracking notice, because "I agree" on a terms-of-service gate is
  //               a decision with consequences, and one the user should make rather than the
  //               agent. "Accept" is permitted at all because a cookie wall otherwise blocks
  //               every subsequent action, which makes the agent unusable on much of the web.
  const CLOSE_RE = /^(?:\s*)(?:close|dismiss|no thanks|not now|maybe later|skip|later|×|✕|✖|x)(?:\s*)$/i;
  const CONSENT_RE = /^(?:\s*)(?:accept(?:\s+all)?(?:\s+cookies)?|allow all|allow cookies|agree|i agree|got it|ok|okay|continue)(?:\s*)$/i;
  const CLOSE_LABEL_RE = /\b(?:close|dismiss|no thanks|not now|skip)\b|(?:^|[^a-z])(?:×|✕|✖)(?:[^a-z]|$)/i;

  // What makes an overlay a cookie notice rather than an agreement to something.
  const CONSENT_CONTEXT_RE =
    /\b(?:cookies?|consent|tracking|gdpr|personalis|personaliz|advertising partners|privacy (?:policy|choices|settings|preferences))\b/i;

  // Never click these while dismissing, whatever they look like.
  const NEVER_DISMISS_RE = /\b(?:sign\s?in|log\s?in|sign\s?up|register|subscribe|buy|pay|checkout|delete|remove|confirm order|place order)\b/i;

  // An overlay whose own text is about money, orders or deleting something is not a cookie
  // notice - it is a decision. Overlay dismissal runs automatically and therefore bypasses
  // the click-approval gate, so a dialog like this is left strictly alone: a "Continue"
  // button inside a purchase confirmation means something very different from the same word
  // inside a consent banner, and nothing here can tell them apart from the button alone.
  const TRANSACTIONAL_OVERLAY_RE =
    /\b(?:payment|checkout|order|purchase|billing|card number|cvv|total|delete|permanently|unsubscribe|cancel (?:your )?(?:subscription|booking|order))\b/i;

  /** An element that visually blocks the page: a dialog, or a large fixed high-z-index layer. */
  function isBlockingOverlay(el) {
    if (!isVisible(el)) return false;
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky" && style.position !== "absolute") {
      if (el.getAttribute("role") !== "dialog" && el.getAttribute("aria-modal") !== "true") return false;
    }
    const r = el.getBoundingClientRect();
    const area = (r.width * r.height) / (innerWidth * innerHeight);
    const z = Number(style.zIndex) || 0;
    const isDialog = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || el.tagName === "DIALOG";
    return isDialog || (area > 0.12 && z >= 100) || (area > 0.5 && style.position === "fixed");
  }

  /**
   * Closes cookie banners and modal dialogs that would otherwise swallow every click.
   *
   * Conservative by construction: it only clicks a control whose own text is a dismissal word,
   * only inside something that is actually covering the page, and never a control that looks
   * like sign-in or a purchase.
   *
   * @returns {{ dismissed: number, labels: string[] }}
   */
  function dismissOverlays(maxToClose = 3) {
    const labels = [];
    const candidates = Array.from(document.querySelectorAll(
      'dialog[open], [role="dialog"], [aria-modal="true"], [class*="cookie" i], [class*="consent" i], ' +
      '[id*="cookie" i], [id*="consent" i], [class*="modal" i], [class*="overlay" i], [class*="popup" i]'
    )).filter(isBlockingOverlay).slice(0, 12);

    for (const overlay of candidates) {
      if (labels.length >= maxToClose) break;
      if (TRANSACTIONAL_OVERLAY_RE.test((overlay.textContent || "").slice(0, 600))) continue;

      // Not only real buttons. A great many sites draw their close control as a bare <span>
      // or <div> holding a "✕" glyph, with the click handler bound to it — Flipkart's login
      // modal is one, and it defeated this entirely: the dialog stayed up, swallowed every
      // click beneath it, and the run ended having done nothing. So anything small, visible
      // and labelled as a close counts, whatever tag it happens to use.
      const buttons = Array.from(overlay.querySelectorAll(
        'button, [role="button"], a[href="#"], input[type="button"], ' +
        '[aria-label*="close" i], [title*="close" i], [class*="close" i], [data-testid*="close" i], ' +
        'span, div, i, svg'
      )).filter((el) => {
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        // A <div> the size of the dialog is the dialog, not its close button.
        if (r.width > 220 || r.height > 220) return false;
        if (/^(?:BUTTON|A|INPUT)$/.test(el.tagName) || el.getAttribute("role") === "button") return true;
        // A generic element only qualifies if it is labelled or reads as a close glyph.
        const text = (el.textContent || "").trim();
        return CLOSE_RE.test(text) || CLOSE_LABEL_RE.test(controlText(el));
      }).slice(0, 40);

      const overlayText = (overlay.textContent || "").slice(0, 1200);
      const isConsentNotice = CONSENT_CONTEXT_RE.test(overlayText);
      const safe = (b) => !NEVER_DISMISS_RE.test(controlText(b));

      // Prefer closing outright. Only fall back to accepting on a genuine cookie notice.
      let target = buttons.find((b) => CLOSE_RE.test((b.textContent || "").trim()) && safe(b));
      if (!target) {
        target = buttons.find((b) => CLOSE_LABEL_RE.test(controlText(b)) && safe(b));
      }
      if (!target && isConsentNotice) {
        target = buttons.find((b) => CONSENT_RE.test((b.textContent || "").trim()) && safe(b));
      }
      if (target) {
        const shown = ((target.textContent || "").trim() || controlText(target)).slice(0, 40);
        try { target.click(); labels.push(shown); } catch (_) {}
      }
    }

    // A dialog with no recognisable dismiss control still responds to Escape, which is safe to
    // press even on a dialog we would not click inside: Escape cancels, it never confirms.
    if (!labels.length && candidates.length) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
      const stillThere = candidates.filter(isBlockingOverlay).length;
      if (stillThere < candidates.length) labels.push("Escape");
    }

    return { dismissed: labels.length, labels };
  }

  // ── Search affordances ───────────────────────────────────────────────────────────────────

  const SEARCH_TEXT_RE = /\b(?:search|find|look ?up|query)\b|🔍/i;

  /** Every text-entry element the user could actually type into right now. */
  function visibleTextInputs() {
    return Array.from(document.querySelectorAll(
      'input:not([type]), input[type="text"], input[type="search"], input[type="email"], ' +
      'input[type="tel"], input[type="url"], textarea, [contenteditable="true"], [role="searchbox"], [role="combobox"]'
    )).filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
  }

  function looksLikeSearchInput(el) {
    if (!el) return false;
    if (el.type === "search") return true;
    const role = (el.getAttribute && el.getAttribute("role") || "").toLowerCase();
    if (role === "searchbox") return true;
    return SEARCH_TEXT_RE.test(controlText(el)) || !!(el.form && SEARCH_TEXT_RE.test(controlText(el.form)));
  }

  /** True when the element behaves like a search box whose form should auto-submit. */
  function isSearchInput(el) {
    if (!el) return false;
    const name = (el.name || "").toLowerCase();
    return looksLikeSearchInput(el) || name === "q" || name.includes("keywords");
  }

  /**
   * Finds a control that *opens* a search box rather than being one.
   *
   * GitHub and MDN both render a button (not an input) on first paint; the input is created
   * only after that button is clicked. Without this, the planner sees no fillable element and
   * correctly but uselessly concludes there is nothing to do.
   */
  function findSearchAffordance() {
    const controls = Array.from(document.querySelectorAll(
      'button, [role="button"], a[href*="search" i], summary, [aria-haspopup], [data-testid*="search" i]'
    )).filter((el) => isVisible(el) && inViewport(el));

    // Prefer an explicit label over incidental text, and prefer smaller controls (an icon
    // button) over a large container that merely contains the word somewhere.
    const scored = controls
      .filter((el) => SEARCH_TEXT_RE.test(controlText(el)) && !NEVER_DISMISS_RE.test(controlText(el)))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").toLowerCase();
        return { el, score: (SEARCH_TEXT_RE.test(aria) ? 0 : 1) + r.width * r.height / 100000 };
      })
      .sort((a, b) => a.score - b.score);

    return scored.length ? scored[0].el : null;
  }

  /**
   * Clicks a search affordance and waits for a text field to actually appear.
   * @returns {Promise<{ ok: boolean, opened?: boolean, error?: string }>}
   */
  async function openSearch() {
    // A search box may already be sitting there unopened — present in the DOM but missed by
    // the mark scan because it mounted after the page was read. Focusing it and reporting
    // success lets the caller re-scan and find it, which is cheaper and safer than clicking
    // something to "open" a box that is already open.
    const existing = visibleTextInputs().find(looksLikeSearchInput);
    if (existing) {
      try { existing.focus(); } catch (_) {}
      return { ok: true, alreadyOpen: true };
    }

    const before = visibleTextInputs().length;
    const control = findSearchAffordance();
    if (!control) return { ok: false, error: "No control on this page opens a search box." };

    try { control.focus(); } catch (_) {}
    control.click();

    // Wait for the field, rather than guessing a fixed delay: SPAs mount it asynchronously.
    for (let i = 0; i < 25; i++) {
      await delay(120);
      const inputs = visibleTextInputs();
      if (inputs.length > before || inputs.some(looksLikeSearchInput)) {
        const box = inputs.find(looksLikeSearchInput) || inputs[inputs.length - 1];
        try { box.focus(); } catch (_) {}
        return { ok: true, opened: true };
      }
    }
    return { ok: false, error: "Clicked a search control but no input appeared." };
  }

  /**
   * Builds the site's own search URL from its OpenSearch descriptor.
   *
   * Last resort, and a standards-based one rather than a per-site rule: a page that offers
   * search to browsers advertises it as
   *   <link rel="search" type="application/opensearchdescription+xml" href="...">
   * pointing at a document whose <Url template="...{searchTerms}"> says exactly how to
   * construct a query URL. Probed on live sites, GitHub and MDN both publish one and neither
   * exposes a search input the agent can type into — the box is mounted inside a dialog on
   * one and absent until hydration on the other. This turns "there is nothing to type into"
   * into a URL the agent can simply open.
   *
   * @returns {Promise<{ok: boolean, url?: string, error?: string}>}
   */
  async function searchUrlFromOpenSearch(query) {
    const link = document.querySelector('link[rel="search"][href]');
    if (!link) return { ok: false, error: "This site publishes no OpenSearch descriptor." };
    try {
      const res = await fetch(new URL(link.getAttribute("href"), location.href).href,
                              { credentials: "omit" });
      if (!res.ok) return { ok: false, error: `OpenSearch descriptor returned ${res.status}.` };
      const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
      const urls = Array.from(doc.getElementsByTagName("Url"));
      const html = urls.find((u) => (u.getAttribute("type") || "").includes("text/html")) || urls[0];
      const template = html && html.getAttribute("template");
      if (!template || !template.includes("{searchTerms}")) {
        return { ok: false, error: "OpenSearch descriptor has no usable HTML template." };
      }
      // Fill the standard placeholders; drop any optional ones the site left in.
      const url = template
        .replace(/\{searchTerms\??\}/g, encodeURIComponent(query))
        .replace(/\{[^}]*\?\}/g, "");
      return { ok: true, url: new URL(url, location.href).href };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  // Signals that a site has decided we are a robot. Deliberately specific: "verify" or
  // "challenge" alone appear all over ordinary pages.
  const BOT_WALL_URL_RE = /\/(?:nocaptcha|captcha|challenge|bot-?check|are-?you-?human|access-?denied|blocked)\b/i;
  const BOT_WALL_TEXT_RE =
    /\b(?:verify (?:you are|that you are) (?:a )?human|are you a (?:robot|human)|unusual traffic|automated queries|complete the security check|prove you.{0,10}re not a robot)\b/i;
  const BOT_WALL_WIDGET = 'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], ' +
                          'iframe[src*="challenges.cloudflare.com" i], iframe[title*="captcha" i], ' +
                          '.g-recaptcha, .h-captcha, .cf-turnstile';

  /**
   * Has the site put a human-verification wall in front of us?
   *
   * Observed live: Stack Overflow redirected to /nocaptcha after two typed queries. Continuing
   * past that is pointless and looks exactly like the agent malfunctioning, so it is detected
   * and reported instead. Nothing here attempts to solve or evade the check.
   */
  function detectBotWall() {
    let href = location.href;
    try { href = decodeURIComponent(href); } catch (_) {}
    if (BOT_WALL_URL_RE.test(href)) return { blocked: true, how: "the site redirected to a verification page" };
    if (document.querySelector(BOT_WALL_WIDGET)) return { blocked: true, how: "the page is showing a CAPTCHA" };
    const text = (document.body && document.body.innerText || "").slice(0, 3000);
    if (BOT_WALL_TEXT_RE.test(text)) return { blocked: true, how: "the page is asking for human verification" };
    return { blocked: false };
  }

  /** Did the query actually reach the page? Checks fields, URL and title. */
  function queryLanded(query) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const target = norm(query);
    if (!target) return { landed: false, inBox: false, inUrl: false, inTitle: false };
    const inBox = Array.from(document.querySelectorAll("input, textarea"))
      .some((i) => norm(i.value).includes(target));
    let href = location.href;
    try { href = decodeURIComponent(location.href); } catch (_) {}
    const inUrl = norm(href).includes(target);
    const inTitle = norm(document.title).includes(target);
    return { landed: inBox || inUrl || inTitle, inBox, inUrl, inTitle };
  }

  // ── Submission ───────────────────────────────────────────────────────────────────────────

  /** Submits the form owning `el`, preferring a real submit button click. */
  function submitOwningForm(el) {
    const form = el.form || (el.closest && el.closest("form"));
    if (!form) return false;
    const submitBtn = form.querySelector(
      'input[type="submit"], button[type="submit"], [role="button"][type="submit"], ' +
      'button[aria-label*="search" i], button[title*="search" i], button:not([type="reset"]):not([type="button"])'
    );
    if (submitBtn && isVisible(submitBtn)) {
      submitBtn.click();
      return true;
    }
    if (typeof form.requestSubmit === "function") {
      try { form.requestSubmit(); return true; } catch (_) {}
    }
    try {
      form.submit();
    } catch (_) {
      try { HTMLFormElement.prototype.submit.call(form); } catch (_) { return false; }
    }
    return true;
  }

  /**
   * Clicks a submit-looking control that sits beside a search input.
   *
   * Only used after Enter and form submission have already been attempted, and only within the
   * input's immediate ancestry, so it cannot wander off and click something unrelated.
   */
  function clickNearbySearchControl(el) {
    let scope = el.parentElement;
    for (let depth = 0; depth < 4 && scope; depth++) {
      const candidates = Array.from(scope.querySelectorAll(
        'button[type="submit"], input[type="submit"], ' +
        '[aria-label*="search" i], [title*="search" i], [data-testid*="search" i], button'
      )).filter((c) => c !== el && isVisible(c) && !NEVER_DISMISS_RE.test(controlText(c)));
      const best = candidates.find((c) => SEARCH_TEXT_RE.test(controlText(c)) || c.type === "submit");
      if (best) {
        best.click();
        return true;
      }
      scope = scope.parentElement;
    }
    return false;
  }

  /** Dispatches a full keydown/keypress/keyup sequence for `key` on `el`. */
  function dispatchKey(el, key) {
    const isEnter = key === "Enter" || key === "Return";
    const init = {
      key: isEnter ? "Enter" : key,
      code: isEnter ? "Enter" : key,
      keyCode: isEnter ? 13 : undefined,
      which: isEnter ? 13 : undefined,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", { ...init, cancelable: false }));
  }

  /**
   * Sets text on an input, textarea, or contenteditable element with realistic events.
   */
  async function simulateType(element, text) {
    if (!element) return false;
    try { element.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    element.focus();
    element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await delay(40);

    const val = text ?? "";

    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete", false, null);
      await delay(30);

      for (const char of val) {
        document.execCommand("insertText", false, char);
        await humanDelay();
      }

      element.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: true, inputType: "insertText", data: val,
      }));
      return true;
    }

    const proto = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const setValue = (v) => {
      if (nativeSetter) nativeSetter.call(element, v);
      else element.value = v;
    };

    // Clear anything already there, so a re-typed query does not concatenate.
    setValue("");
    element.dispatchEvent(new Event("input", { bubbles: true }));

    if (val.length > PER_CHAR_TYPING_LIMIT) {
      setValue(val);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      let current = "";
      for (const char of val) {
        current += char;
        dispatchKeyChar(element, char, "keydown");
        setValue(current);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
        dispatchKeyChar(element, char, "keyup");
        await humanDelay();
      }
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function dispatchKeyChar(el, char, kind) {
    el.dispatchEvent(new KeyboardEvent(kind, { key: char, bubbles: true, cancelable: true, composed: true }));
  }

  /**
   * A click that works on frameworks which ignore `.click()` alone.
   *
   * Many SPA components listen for `pointerdown`/`mousedown` and never see the synthetic
   * `click` that HTMLElement.click() dispatches on its own.
   */
  function realisticClick(el) {
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };

    try { el.focus({ preventScroll: true }); } catch (_) {}
    for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, opts)); } catch (_) {}
    }
    el.click();
  }

  // Actions that operate on the page as a whole rather than on one marked element. Exported,
  // because content.js gates on the same question before dispatching and the two lists
  // silently disagreeing meant every page-level probe was rejected as "not in this frame".
  const TARGETLESS_ACTIONS = new Set([
    "scroll_page", "wait", "done", "dismiss_overlays", "open_search", "probe_query",
    "search_url", "detect_bot_wall", "scroll_to",
  ]);

  /**
   * Chooses `value` in a dropdown that is not a <select>: a combobox/listbox button that opens
   * a list of options. Clicks it open, waits for options to appear, and clicks the one whose
   * text means the requested value. Generic: works from ARIA roles and visible text.
   */
  async function selectCustomOption(el, value) {
    const want = String(value || "").trim().toLowerCase();
    if (!want) return { ok: false, error: "No option value given." };
    const optionsNow = () => Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li[data-value], li[role="presentation"] > *'))
      .filter(isVisible);
    let options = optionsNow();
    if (!options.length) {
      realisticClick(el);
      for (let i = 0; i < 20 && !options.length; i++) {
        await delay(100);
        options = optionsNow();
      }
    }
    if (!options.length) return { ok: false, error: "The dropdown opened no options." };
    const norm = (s) => String(s || "").trim().toLowerCase();
    const match = options.find((o) => norm(o.textContent) === want) ||
                  options.find((o) => norm(o.textContent).includes(want)) ||
                  options.find((o) => norm(o.getAttribute("data-value")) === want);
    if (!match) return { ok: false, error: `Option "${value}" not found among ${options.length} option(s).` };
    realisticClick(match);
    return { ok: true, chosen: (match.textContent || "").trim().slice(0, 60) };
  }

  /**
   * Executes an action on a target element.
   *
   * @param {Object} action - { type, target|mark_id, value }
   * @param {Map|Function} elementResolver - markMap or resolver function to get DOM element from ID
   * @returns {Promise<{ ok: boolean, error?: string, ... }>}
   */
  async function executeAction(action = {}, elementResolver) {
    const actionType = (action.type || action.action || "").toLowerCase();
    const targetId = action.target ?? action.mark_id;
    const value = action.value;

    let el = null;
    // "scroll" is target-optional rather than target-less: with an id it scrolls that element
    // into view, without one it scrolls the page.
    const targetOptional = actionType === "scroll" && targetId == null;
    if (!TARGETLESS_ACTIONS.has(actionType) && !targetOptional) {
      if (typeof elementResolver === "function") {
        el = elementResolver(targetId);
      } else if (elementResolver instanceof Map) {
        el = elementResolver.get(Number(targetId)) || elementResolver.get(String(targetId));
      } else if (document.querySelector) {
        el = document.querySelector(`[data-vagent-mark="${targetId}"]`) || document.getElementById(targetId);
      }
      if (!el) return { ok: false, error: `Target element with ID "${targetId}" not found.` };
      if (!isVisible(el)) return { ok: false, error: `Target element "${targetId}" is no longer visible.` };
    }

    try {
      switch (actionType) {
        case "click":
          // A file chooser cannot be driven from a content script; opening it and leaving the
          // person to pick a file is the honest outcome, and the loop asks them to.
          if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file") {
            return { ok: false, needsUser: true, error: "This is a file chooser; the person must pick the file." };
          }
          realisticClick(el);
          return { ok: true, label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60) };

        case "upload":
          return { ok: false, needsUser: true, error: "File uploads need the person to choose the file." };

        case "type": {
          await simulateType(el, value);

          // Search boxes: submitting is part of "typing a query" for the agent, so the loop can
          // re-scan the results page on the next step instead of spending a step on submit.
          //
          // Real sites disagree about what "submit" means. Classic pages have a <form>;
          // React/SPA search boxes often have none and listen for an Enter keydown; some have a
          // form whose real submit control is an icon button our generic selector misses.
          // Measured on live sites, doing only one of these left the query typed but never run
          // on Flipkart, GitHub and Stack Overflow. So escalate — and stop as soon as the query
          // demonstrably landed, so we do not keep poking a page that already navigated.
          if (isSearchInput(el)) {
            await delay(100);
            dispatchKey(el, "Enter");
            // Reply NOW, before the escalation. Enter on a search box usually navigates, and a
            // navigation destroys this content script along with the pending sendMessage reply
            // — which the service worker then reads as a failed action even though the search
            // ran. Answering first, escalating after, keeps the reply on the near side of the
            // navigation. The escalation continues in this frame for as long as it survives.
            escalateSubmit(el, value);
            return { ok: true, typed: true, landing: queryLanded(value) };
          }
          return { ok: true, landing: queryLanded(value) };
        }

        case "clear":
          el.focus();
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };

        case "press_key": {
          const keyVal = value || "Enter";
          el.focus();
          dispatchKey(el, keyVal);
          if ((keyVal === "Enter" || keyVal === "Return") && !el.isContentEditable) {
            submitOwningForm(el);
          }
          return { ok: true };
        }

        case "check":
        case "toggle": {
          const isInput = el.tagName === "INPUT";
          const before = isInput ? el.checked : el.getAttribute("aria-checked") === "true";
          realisticClick(el);
          await delay(80);
          const after = isInput ? el.checked : el.getAttribute("aria-checked") === "true";
          return { ok: true, changed: before !== after, checked: after };
        }

        case "select":
          if (el.tagName.toLowerCase() === "select") {
            const want = String(value || "").trim().toLowerCase();
            const opts = Array.from(el.options);
            const opt = opts.find((o) => o.value === value || o.text.trim().toLowerCase() === want) ||
                        opts.find((o) => o.text.trim().toLowerCase().includes(want));
            if (opt) {
              el.focus();
              el.value = opt.value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return { ok: true, chosen: opt.text.trim().slice(0, 60) };
            }
            return { ok: false, error: `Option "${value}" not found in <select> (${opts.length} options).` };
          }
          // A custom dropdown: combobox / listbox / a button that opens a list.
          return await selectCustomOption(el, value);

        case "scroll_to": {
          const reader = global.__vagentReader;
          if (!reader || typeof reader.scrollToText !== "function") {
            return { ok: false, error: "Page reader not loaded in this frame." };
          }
          const r = reader.scrollToText(value);
          if (r.ok) await delay(250);
          return r;
        }

        case "scroll":
          // "scroll" with an element means bring it into view; without one it means scroll the
          // page. Planners emit both spellings — the prompt says "scroll", the action list says
          // "scroll_page" — and a page scroll must not fail merely over the name.
          if (!el) return await executeAction({ ...action, type: "scroll_page" }, elementResolver);
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return { ok: true };

        case "scroll_page": {
          const scrollAmount = Number(value) || 600;
          const before = window.scrollY;
          window.scrollBy({ top: scrollAmount, behavior: "smooth" });
          await delay(500);
          // Report honestly whether the page actually moved; a page already at the bottom
          // otherwise looks like endless successful scrolling to the planner.
          const moved = Math.abs(window.scrollY - before) > 4;
          return { ok: true, moved, scrollY: window.scrollY };
        }

        case "hover":
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          return { ok: true };

        case "focus":
          el.focus();
          return { ok: true };

        case "wait":
          await delay(Math.min(Number(value) || 1000, 5000));
          return { ok: true };

        case "dismiss_overlays": {
          const r = dismissOverlays();
          return { ok: true, ...r };
        }

        case "open_search":
          return await openSearch();

        case "probe_query":
          return { ok: true, landing: queryLanded(value) };

        case "search_url":
          return await searchUrlFromOpenSearch(value);

        case "detect_bot_wall":
          return { ok: true, ...detectBotWall() };

        case "done":
          return { ok: true, done: true };

        default:
          return { ok: false, error: `Unsupported action type: "${actionType}"` };
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Escalating submit for a search box, run detached from the action's reply.
   *
   * Real sites disagree about what "submit" means. Classic pages have a <form>; React search
   * boxes often have none and listen for an Enter keydown; some have a form whose real submit
   * control is an icon button no generic selector will find. Measured on live sites, doing
   * only one of these left the query typed but never run on Flipkart, GitHub and Stack
   * Overflow. Each stage is skipped once the query is visibly in the URL or title, and the
   * whole thing dies harmlessly if the page navigates away underneath it.
   */
  async function escalateSubmit(el, value) {
    try {
      await delay(450);
      if (urlOrTitleHas(value) || !el.isConnected) return;
      submitOwningForm(el);
      await delay(500);
      if (urlOrTitleHas(value) || !el.isConnected) return;
      clickNearbySearchControl(el);
    } catch (_) {
      // The page navigated mid-escalation. That is the outcome we wanted anyway.
    }
  }

  /** Cheap check used to decide whether a search has already committed. */
  function urlOrTitleHas(value) {
    const l = queryLanded(value);
    return l.inUrl || l.inTitle;
  }

  const ActionExecutor = {
    executeAction,
    TARGETLESS_ACTIONS,
    simulateType,
    dismissOverlays,
    openSearch,
    findSearchAffordance,
    queryLanded,
    searchUrlFromOpenSearch,
    detectBotWall,
    visibleTextInputs,
    looksLikeSearchInput,
  };

  global.ActionExecutor = ActionExecutor;
  global.executeAction = executeAction;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ActionExecutor;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

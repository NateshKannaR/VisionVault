/**
 * action-executor.js — THE action executor for VisionVault.
 *
 * This is the single, authoritative implementation of DOM action dispatch. It is loaded as a
 * content script (see manifest.json content_scripts) into every frame, alongside content.js,
 * which delegates to it. There is deliberately no second executor anywhere in the codebase.
 *
 * Supported action types:
 *   click, type, press_key, select, scroll_page, clear, scroll, hover, focus, wait, done
 */

(function (global) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const humanDelay = () => delay(10 + Math.random() * 15);

  // Above this length, typing is committed in one shot instead of per-character, so that long
  // values (addresses, bios) do not add seconds of latency to a step.
  const PER_CHAR_TYPING_LIMIT = 60;

  /** True when the element behaves like a search box whose form should auto-submit. */
  function isSearchInput(el) {
    if (!el) return false;
    const id = (el.id || "").toLowerCase();
    const name = (el.name || "").toLowerCase();
    const role = (el.getAttribute && el.getAttribute("role") || "").toLowerCase();
    return (
      el.type === "search" ||
      role === "searchbox" ||
      id.includes("search") ||
      name.includes("search") ||
      name.includes("keywords")
    );
  }

  /** Submits the form owning `el`, preferring a real submit button click. */
  function submitOwningForm(el) {
    const form = el.form || (el.closest && el.closest("form"));
    if (!form) return false;
    // Generic, in order of confidence. No site-specific selectors: the agent must behave the
    // same on any page, so it relies on standard submit semantics and ARIA rather than on
    // knowing a particular site's markup.
    const submitBtn = form.querySelector(
      'input[type="submit"], button[type="submit"], [role="button"][type="submit"], ' +
      'button[aria-label*="search" i], button[title*="search" i], button:not([type="reset"])'
    );
    if (submitBtn) {
      submitBtn.click();
      return true;
    }
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return true;
    }
    try {
      form.submit();
    } catch (_) {
      HTMLFormElement.prototype.submit.call(form);
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
      const candidate = scope.querySelector(
        'button[type="submit"], input[type="submit"], ' +
        '[aria-label*="search" i]:is(button,[role="button"]), ' +
        '[data-testid*="search" i]:is(button,[role="button"]), ' +
        'button:has(svg)'
      );
      if (candidate && candidate !== el && typeof candidate.click === "function") {
        candidate.click();
        return true;
      }
      scope = scope.parentElement;
    }
    return false;
  }

  /** Dispatches a full keydown/keypress/keyup sequence for `key` on `el`. */
  function dispatchKey(el, key) {
    const init = { key, code: key === "Enter" ? "Enter" : key, keyCode: key === "Enter" ? 13 : undefined, which: key === "Enter" ? 13 : undefined, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", { ...init, cancelable: false }));
  }

  /**
   * Sets text on an input, textarea, or contenteditable element with realistic events.
   */
  async function simulateType(element, text) {
    if (!element) return false;
    element.focus();
    await delay(50);

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
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: val
      }));
      return true;
    }

    const proto = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const setValue = (v) => {
      if (nativeSetter) nativeSetter.call(element, v);
      else element.value = v;
    };

    if (val.length > PER_CHAR_TYPING_LIMIT) {
      setValue(val);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      let current = "";
      for (const char of val) {
        current += char;
        setValue(current);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        await humanDelay();
      }
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /**
   * Executes an action on a target element.
   *
   * @param {Object} action - { type: "click"|"type"|"scroll"|"select"|"press_key", target: id, value: string }
   * @param {Map|Function} elementResolver - markMap or resolver function to get DOM element from ID
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function executeAction(action = {}, elementResolver) {
    const actionType = (action.type || action.action || "").toLowerCase();
    const targetId = action.target ?? action.mark_id;
    const value = action.value;

    let el = null;
    if (typeof elementResolver === "function") {
      el = elementResolver(targetId);
    } else if (elementResolver instanceof Map) {
      el = elementResolver.get(Number(targetId)) || elementResolver.get(String(targetId));
    } else if (document.querySelector) {
      el = document.querySelector(`[data-vagent-mark="${targetId}"]`) || document.getElementById(targetId);
    }

    if (!el && actionType !== "scroll_page" && actionType !== "wait" && actionType !== "done") {
      return { ok: false, error: `Target element with ID "${targetId}" not found.` };
    }

    try {
      switch (actionType) {
        case "click":
          el.focus();
          el.click();
          return { ok: true };

        case "type": {
          await simulateType(el, value);
          // Search boxes: submitting is part of "typing a query" for the agent, so the loop can
          // re-scan the results page on the next step instead of spending a step on submit.
          //
          // Real sites disagree about what "submit" means. Classic pages have a <form>;
          // React/SPA search boxes often have none and listen for an Enter keydown; some have a
          // form whose real submit control is an icon button our generic selector misses.
          // Measured on live sites, doing only one of these left the query typed but never run
          // on Flipkart, GitHub and Stack Overflow. So do all three, cheapest first — they are
          // harmless in combination for a search box.
          if (isSearchInput(el)) {
            await delay(150);
            dispatchKey(el, "Enter");
            await delay(120);
            submitOwningForm(el);
            await delay(120);
            clickNearbySearchControl(el);
          }
          return { ok: true };
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

        case "select":
          if (el.tagName.toLowerCase() === "select") {
            const opt = Array.from(el.options).find(
              (o) => o.value === value || o.text.toLowerCase() === (value || "").toLowerCase()
            );
            if (opt) {
              el.value = opt.value;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return { ok: true };
            }
            return { ok: false, error: `Option "${value}" not found in <select>.` };
          }
          return { ok: false, error: "Target is not a select element." };

        case "scroll":
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return { ok: true };

        case "scroll_page": {
          const scrollAmount = Number(value) || 400;
          window.scrollBy({ top: scrollAmount, behavior: "smooth" });
          return { ok: true };
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

        case "done":
          return { ok: true, done: true };

        default:
          return { ok: false, error: `Unsupported action type: "${actionType}"` };
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  const ActionExecutor = {
    executeAction,
    simulateType
  };

  global.ActionExecutor = ActionExecutor;
  global.executeAction = executeAction;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ActionExecutor;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

/**
 * agent-guard.js — the supervisor that sits between the planner and the DOM.
 *
 * A planner (cloud VLM or on-device) proposes one action per step. Left unsupervised, planners
 * fail in a small number of recurring, measurable ways. Every rule below was written against an
 * observed failure on a live site, recorded in server/logs/session.jsonl:
 *
 *   MakeMyTrip     seven consecutive identical `type` actions — the value never landed because
 *                  the target was a city picker, not a search box, and nothing noticed.
 *   Hacker News    task "scroll down and show me more stories" produced
 *                  `click [codex is down]` — a link whose text merely contained "down". The
 *                  agent left the site entirely and scrolled GitHub for nine more steps.
 *   Flipkart       `type "running shoes and show me"` — the conversational tail was typed
 *                  into the search box.
 *   GitHub / MDN   `done` on step 1, because the search box is behind a button and so no
 *                  fillable element was visible to plan against.
 *
 * The guard is deliberately conservative: it can veto or substitute an action, but it never
 * invents a target the planner did not have. When it vetoes, it says why, and that reason is
 * surfaced in the UI instead of the agent silently stalling.
 *
 * Loaded by the service worker via importScripts, and exported for `node eval/test-agent-guard.js`.
 */

(function (global) {
  /** How many times the same action signature may run before it is treated as a loop. */
  const MAX_SIGNATURE_REPEATS = 2;

  /** How many steps may pass with no observable page change before the run is abandoned. */
  const MAX_STEPS_WITHOUT_PROGRESS = 4;

  /** How many times a planner's `done` may be overruled. Prevents guard-vs-planner ping-pong. */
  const MAX_DONE_OVERRIDES = 2;

  function normalizeType(resp) {
    return (resp?.action?.type || resp?.action || resp?.type || "").toString().toLowerCase().trim();
  }

  /** A stable string for "this exact action on this exact target with this exact value". */
  function signatureOf(type, markId, value) {
    return [type, markId ?? "-", String(value ?? "").slice(0, 60).toLowerCase()].join("|");
  }

  /**
   * A cheap fingerprint of what the agent can currently see, plus how much it has done.
   *
   * Two steps with the same fingerprint mean nothing changed, however busy the agent looked.
   * `completed` is part of it because filling a form legitimately changes none of the page
   * signals — same URL, same scroll position, same elements — and without it a run that was
   * working perfectly well looked like a stall and was cut off four fields into six.
   */
  function fingerprintOf(pageInfo, marks, completed = 0) {
    const url = (pageInfo && pageInfo.url) || "";
    const y = Math.round(((pageInfo && pageInfo.scroll_y) || 0) / 100) * 100;
    const n = (marks || []).length;
    return `${url}#${y}#${n}#${completed}`;
  }

  // "the first result", "the top one", "the best match" — a target defined by POSITION rather
  // than by name. The user cannot know what it will be called, so no label can ever match it.
  const ORDINAL_TARGET_RE =
    /^(?:the\s+)?(?:very\s+)?(?:first|1st|second|2nd|third|3rd|top|best|cheapest|last|next|one|item|product|result|link|option|match|thing|it)\b|\b(?:result|one|item|product|match|option)$/i;

  /**
   * Whether an open target the instruction named has actually been opened.
   *
   * The exact-match test this replaces (`opened.includes(t)`) could not pass for the most
   * common phrasing there is. "open the first result" records openTargets:["first result"],
   * while `opened` records the label of what was clicked — "hurricane running shoes for men".
   * Those never match, so a completed task looked outstanding and the agent kept clicking.
   * Observed on Flipkart: the first result was opened correctly at step 3, and the run then
   * wandered through the mega-menu for seven more steps before the stall detector stopped it.
   *
   * Two rules, in order:
   *   Positional target   satisfied by anything having been opened. `productOpened` is the
   *                       stronger signal where the page identified itself as a product.
   *   Named target        matched loosely in both directions, because a user types "nike
   *                       shoes" and the page says "Nike Revolution 6 Running Shoes".
   */
  function openTargetMet(target, progress) {
    const p = progress || {};
    const opened = p.opened || [];
    const t = String(target || "").trim().toLowerCase();
    if (!t) return true;

    // Outcome, not intent. `opened` is appended in background.js only after an action has
    // actually executed, so it means something was opened. `productOpened` looks like the same
    // signal and is not: task-planner sets it while DECIDING to click a product, before the
    // click runs, and reads it back in the same step. Trusting it here made the guard call a
    // run complete on the search-results page with nothing opened at all — the opposite
    // failure to the one this function was written to fix, and the worse of the two, because
    // over-running is visible and stopping early looks like success.
    if (ORDINAL_TARGET_RE.test(t)) return opened.length > 0;

    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const nt = norm(t);
    if (!nt) return opened.length > 0;
    return opened.some((o) => {
      const no = norm(o);
      if (!no) return false;
      if (no.includes(nt) || nt.includes(no)) return true;
      // Every significant word of the request present in the label. "nike shoes" is met by
      // "Nike Revolution 6 Running Shoes"; "adidas shoes" is not.
      const words = nt.split(" ").filter((w) => w.length > 2);
      return words.length > 0 && words.every((w) => no.includes(w));
    });
  }

  /**
   * Has the user's instruction actually been carried out?
   *
   * This is what makes `done` trustworthy. A planner saying "done" on step 1 with an empty
   * search box is wrong, and this is how the guard knows.
   */
  function goalSatisfied(parsed, progress) {
    const p = progress || {};
    if (!parsed) return true;

    // Booking tasks: queryLanded is meaningless (no single search box).
    // Progress is judged by filledAny + navigated instead.
    if (parsed.wantsBook) {
      if (parsed.wantsNonStop && !p.nonStopFiltered) return false;
      return p.filledAny || p.bookingCompleted || false;
    }

    if (parsed.query && !p.queryLanded) return false;
    if (parsed.wantsFilter && !p.filterApplied && !p.sortApplied && !p.nonStopFiltered) return false;

    // A constraint is a requirement even when the user never says the word "filter".
    //
    // "laptops under 70000 with 16GB ram" parses a maxPrice but not wantsFilter, which is
    // driven by the literal words filter/sort/refine. The run therefore counted as complete
    // the moment the search landed, and the budget - the whole point of the instruction -
    // was ignored. Measured on eval/pages/laptop-compare.html: one action, then done.
    //
    // Satisfied by acting on the constraint in either of the two ways a page allows: narrowing
    // the list, or picking from it. Requiring a filter control specifically would hang on the
    // many sites that have none.
    const hasConstraint = parsed.maxPrice != null || parsed.minPrice != null || parsed.minRating != null ||
                          parsed.wantsBest || parsed.wantsCheapest;
    // filterUnavailable means the planner looked and this page offers no control that can
    // express the constraint. That is a real answer, not a success - but holding the run open
    // for a control that does not exist would loop forever, so it counts as settled.
    if (hasConstraint && !p.filterApplied && !p.sortApplied && !p.filterUnavailable &&
        !p.productOpened && !(p.opened || []).length && !p.cartAdded) {
      return false;
    }
    if (parsed.wantsSort && !p.sortApplied) return false;
    if (parsed.wantsAddToCart && !p.cartAdded) return false;
    if (parsed.wantsStar && !p.starred) return false;
    if (parsed.wantsFork && !p.forked) return false;
    if (parsed.wantsClone && !p.cloned) return false;
    if (parsed.wantsIssue && !p.issueOpened) return false;
    if (parsed.wantsPR && !p.prOpened) return false;
    if ((parsed.openTargets || []).length) {
      if (!parsed.openTargets.every((t) => openTargetMet(t, p))) return false;
    }
    if (parsed.wantsScroll && !p.scrolled) return false;
    if (parsed.wantsFill && !p.filledAny) return false;
    if (parsed.wantsMessage && !p.messageSent) return false;
    return true;
  }

  /**
   * True when the instruction had a completion signal this code can actually check, and that
   * signal has fired.
   *
   * Deliberately narrower than `goalSatisfied`. Form filling is excluded because there is no
   * way to tell "the form is complete" from "one field is filled" without knowing which fields
   * the page requires — so a fill task is left to the planner to end. Everything here can be
   * verified from the page itself: the query reached the URL, every named target was opened,
   * the page scrolled.
   */
  function goalFullyVerified(parsed, progress) {
    if (!parsed || parsed.wantsFill || parsed.wantsBook) return false;
    if (parsed.wantsFilter && !progress?.filterApplied && !progress?.sortApplied) return false;
    if (parsed.wantsSort && !progress?.sortApplied) return false;
    if (parsed.wantsAddToCart && !progress?.cartAdded) return false;
    if (parsed.wantsStar && !progress?.starred) return false;
    if (parsed.wantsFork && !progress?.forked) return false;
    if (parsed.wantsClone && !progress?.cloned) return false;
    if (parsed.wantsIssue && !progress?.issueOpened) return false;
    if (parsed.wantsPR && !progress?.prOpened) return false;
    const hasVerifiableIntent = !!parsed.query || (parsed.openTargets || []).length > 0 || parsed.wantsScroll ||
      (parsed.wantsMessage && progress?.messageSent) || (parsed.wantsAddToCart && progress?.cartAdded) ||
      (parsed.wantsFilter && (progress?.filterApplied || progress?.sortApplied)) ||
      (parsed.wantsStar && progress?.starred) || (parsed.wantsFork && progress?.forked) ||
      (parsed.wantsClone && progress?.cloned) || (parsed.wantsIssue && progress?.issueOpened) ||
      (parsed.wantsPR && progress?.prOpened);
    if (!hasVerifiableIntent) return false;
    return goalSatisfied(parsed, progress);
  }

  /** Human-readable summary of what remains, used in UI messages. */
  function describeRemaining(parsed, progress) {
    const p = progress || {};
    const left = [];
    if (parsed?.wantsBook) {
      if (!p.filledAny && !p.bookingCompleted) left.push("search flights");
      if (parsed?.wantsNonStop && !p.nonStopFiltered) left.push("filter non-stop flights");
      return left.join(", ");
    }
    if (parsed?.query && !p.queryLanded) left.push(`search for "${parsed.query}"`);
    if (parsed?.wantsFilter && !p.filterApplied && !p.sortApplied) left.push("apply filter");
    if ((parsed?.maxPrice != null || parsed?.minRating != null || parsed?.wantsBest || parsed?.wantsCheapest) &&
        !p.filterApplied && !p.sortApplied && !p.productOpened && !(p.opened || []).length && !p.cartAdded) {
      left.push(parsed.maxPrice != null ? `narrow to under ${parsed.maxPrice}` : "pick the best match");
    }
    if (parsed?.wantsSort && !p.sortApplied) left.push("apply sorting");
    if (parsed?.wantsAddToCart && !p.cartAdded) left.push("add item to cart");
    if (parsed?.wantsStar && !p.starred) left.push("star the repository");
    if (parsed?.wantsFork && !p.forked) left.push("fork the repository");
    if (parsed?.wantsClone && !p.cloned) left.push("open clone options");
    if (parsed?.wantsIssue && !p.issueOpened) left.push("open issues tab");
    if (parsed?.wantsPR && !p.prOpened) left.push("open pull requests tab");
    if (parsed?.wantsNonStop && !p.nonStopFiltered) left.push("filter non-stop flights");
    for (const t of parsed?.openTargets || []) if (!openTargetMet(t, p)) left.push(`open "${t}"`);
    if (parsed?.wantsScroll && !p.scrolled) left.push("scroll the page");
    if (parsed?.wantsFill && !p.filledAny) left.push("fill the form");
    if (parsed?.wantsMessage && !p.messageSent) left.push(`send message to ${parsed.recipient || "recipient"}`);
    return left.join(", ");
  }

  /**
   * True when the instruction is purely about moving down the page. Such a task must never
   * produce a click: on Hacker News that turned "scroll down" into leaving the site.
   */
  function isPureScrollTask(parsed) {
    return !!(parsed && parsed.wantsScroll && !parsed.query && !(parsed.openTargets || []).length && !parsed.wantsFill);
  }

  const FILLABLE_ROLES = new Set([
    "input:text", "input:search", "input:email", "input:tel", "input:password",
    "input:url", "textarea", "editable", "combobox", "select",
  ]);

  // Controls that commit a form. Narrower than the click-risk list: this is about "would this
  // end the form", not "is this dangerous".
  const SUBMIT_LABEL_RE =
    /\b(?:submit|create account|sign\s?up|register|continue|next|save|apply|confirm|place order|checkout|pay|send)\b/i;

  /** Fields still waiting to be filled, ignoring search boxes. */
  function unfilledFields(marks, filledIds) {
    const done = new Set((filledIds || []).map(String));
    return (marks || []).filter(
      (m) => FILLABLE_ROLES.has(m.role) && !done.has(String(m.id)) && !isSearchLikeMark(m)
    );
  }

  function isSearchLikeMark(mark) {
    if (!mark) return false;
    if (mark.role === "input:search") return true;
    return /search|find|query|keyword|what are you looking for|explore/i.test(mark.label || "");
  }

  /** One line describing what the run achieved, for the panel. */
  function describeCompletion(parsed, progress) {
    const p = progress || {};
    const bits = [];
    if (p.navigated && parsed?.site) bits.push(`opened ${parsed.site}`);
    if (p.queryLanded && parsed?.query) bits.push(`searched for "${parsed.query}"`);
    if (p.filterApplied) bits.push("applied filter");
    if (p.sortApplied) bits.push("applied sorting");
    if (p.cartAdded) bits.push("added item to cart");
    if (p.starred) bits.push("starred repository");
    if (p.forked) bits.push("forked repository");
    if (p.cloned) bits.push("opened clone options");
    if (p.issueOpened) bits.push("opened issues");
    if (p.prOpened) bits.push("opened pull requests");
    if (p.nonStopFiltered) bits.push("filtered non-stop flights");
    if ((p.opened || []).length) bits.push(`opened ${p.opened.length} item(s)`);
    if (p.scrolled) bits.push("scrolled the page");
    return bits.length ? `Done — ${bits.join(", ")}.` : "Done.";
  }

  function createGuard(parsed, options = {}) {
    const history = [];          // { signature, type, fingerprintBefore, progressed }
    const signatureCounts = new Map();
    let doneOverrides = 0;
    let staleSteps = 0;
    let lastFingerprint = null;

    const maxRepeats = options.maxSignatureRepeats ?? MAX_SIGNATURE_REPEATS;
    const maxStale = options.maxStepsWithoutProgress ?? MAX_STEPS_WITHOUT_PROGRESS;

    /**
     * Called once per step, before executing. Returns the action that should actually run.
     *
     * @param {Object} proposed     the planner's action (normalized or raw StepResponse shape)
     * @param {Object} ctx          { marks, pageInfo, progress, deterministic, task }
     * @returns {{ action: Object, stop?: boolean, reason: string, substituted: boolean }}
     */
    function review(proposed, ctx = {}) {
      const marks = ctx.marks || [];
      const progress = ctx.progress || {};
      const fingerprint = fingerprintOf(ctx.pageInfo, marks, (ctx.filledIds || []).length);

      // ── Stall detection. Nothing visible has changed for several steps. ──────────────────
      if (lastFingerprint !== null && fingerprint === lastFingerprint) {
        staleSteps++;
      } else {
        staleSteps = 0;
        // Something changed since the last decision, so any earlier override of a premature
        // "done" was justified rather than a disagreement going nowhere. The cap exists to
        // stop guard and planner trading the same two answers forever; it must not stop the
        // guard from carrying a weak planner through a ten-field form, which is exactly what
        // it did once the hosted models were rate-limited and a 1.5B local model took over.
        doneOverrides = 0;
      }
      lastFingerprint = fingerprint;

      if (staleSteps >= maxStale) {
        return {
          action: { action: "done", reasoning: "" },
          stop: true,
          substituted: true,
          reason: `The page stopped responding to the agent — ${staleSteps} steps with no visible change. ` +
                  (describeRemaining(parsed, progress) ? `Not completed: ${describeRemaining(parsed, progress)}.` : ""),
        };
      }

      let type = normalizeType(proposed);
      let action = { ...proposed, action: type };
      let substituted = false;
      let reason = "";

      // ── Rule 0: everything the instruction asked for has demonstrably happened. ──────────
      // Further actions at this point are the planner inventing work — which is how "scroll
      // down and show me more headlines" became six scrolls, and how a finished search turned
      // into a tour of the results page.
      if (type && type !== "done" && goalFullyVerified(parsed, progress)) {
        return {
          action: { action: "done", reasoning: describeCompletion(parsed, progress) },
          substituted: true,
          reason: "",
        };
      }

      // ── Rule 1: a pure scroll instruction may not click anything. ────────────────────────
      // "scroll down and show me more stories" is not permission to open a link whose text
      // happens to contain "down".
      if (type === "click" && isPureScrollTask(parsed)) {
        if (progress.scrolled) {
          return {
            action: { action: "done", reasoning: "Scrolled as requested." },
            substituted: true, reason: "Scroll task complete; refused a click that was not asked for.",
          };
        }
        action = { action: "scroll_page", value: 600, reasoning: "Scroll down (the task asked to scroll, not to click)" };
        type = "scroll_page";
        substituted = true;
        reason = "Planner proposed a click on a scroll-only task; substituted a scroll.";
      }

      // ── Rule 2: do not submit a form that is still half empty. ───────────────────
      // Observed on the evaluation fixture: after filling one field of six, the planner
      // proposed clicking "Create account". The click-risk gate caught it and asked for
      // approval, which is the safety net working - but the right answer was to carry on
      // filling, not to ask the user whether to submit an incomplete form.
      if (type === "click" && parsed?.wantsFill) {
        const target = marks.find((m) => String(m.id) === String(action.mark_id));
        const remaining = unfilledFields(marks, ctx.filledIds);
        const alt = ctx.deterministic;
        const altType = normalizeType(alt);

        // While there is an empty field in front of it and a known value for one, filling beats
        // clicking. Submit controls are the obvious case, but not the only one: observed live,
        // a planner opened a six-field form with `click` on a link it described as "navigate to
        // the signup form", the risk gate stopped for approval, and nothing was filled at all.
        // The deterministic plan only proposes a type when it has a labelled field and a vault
        // key for it, so a click that genuinely reveals more of the form still goes through.
        if (remaining.length && alt && altType === "type") {
          const submitish = target && SUBMIT_LABEL_RE.test(target.label || "");
          return {
            action: { ...alt, action: altType },
            substituted: true,
            reason: submitish
              ? `Not submitting yet - ${remaining.length} field(s) still empty.`
              : `Filling "${target?.label || "the next field"}" first - ${remaining.length} field(s) still empty.`,
          };
        }
      }

      // ── Rule 2b: search query must be typed before clicking navigation/login links ───
      if (type === "click" && parsed?.query && !progress.queryLanded && !parsed?.wantsBook) {
        const target = marks.find((m) => String(m.id) === String(action.mark_id));
        const tLabel = ((target?.label || "") + " " + (proposed?.reasoning || "")).toLowerCase();
        const isSearchBtn = target && (
          /search|find|go|submit/i.test(target.label || "") ||
          target.role === "input:submit"
        );
        const isDismiss = target && /close|dismiss|accept|agree|got it/i.test(target.label || "");
        const isDistraction = /sign\s*in|login|log\s*in|account|register|bestseller|trending|deal|cart|order/i.test(tLabel);

        const alt = ctx.deterministic;
        const altType = normalizeType(alt);

        if ((isDistraction || (!isSearchBtn && !isDismiss)) && alt && altType === "type") {
          return {
            action: { ...alt, action: altType },
            substituted: true,
            reason: `Intercepted click on "${target?.label || "link"}" before search ran; typing "${parsed.query}" into search box first.`,
          };
        }
      }

      // ── Rule 3: never type the user's whole sentence into a search box. ──────────────────
      if (type === "type" && !action.use_vault_field && parsed?.query && action.value) {
        const target = marks.find((m) => String(m.id) === String(action.mark_id));
        const value = String(action.value);
        const wholeTask = String(ctx.task || "").trim().toLowerCase();
        const looksLikeWholeTask =
          value.trim().toLowerCase() === wholeTask ||
          (value.length > parsed.query.length && value.toLowerCase().includes(parsed.query.toLowerCase()));
        if ((isSearchLikeMark(target) || !target) && looksLikeWholeTask) {
          action = { ...action, value: parsed.query };
          substituted = true;
          reason = `Trimmed the typed value to the parsed query "${parsed.query}".`;
        }
      }

      // ── Rule 4: `done` is only honoured once the instruction is actually carried out. ────
      if (type === "done" || type === "none" || type === "finish" || type === "stop" || !type) {
        // A form is not finished because one field is. `goalSatisfied` can only ask whether
        // anything was filled at all, so the remaining fields are counted here: on the
        // evaluation fixture the planner called a six-field signup done after five, leaving
        // the address blank. Bounded by MAX_DONE_OVERRIDES, so a form with fields nothing can
        // fill still terminates.
        const fillIncomplete = !!parsed?.wantsFill && unfilledFields(marks, ctx.filledIds).length > 0;

        if ((goalSatisfied(parsed, progress) && !fillIncomplete) || doneOverrides >= MAX_DONE_OVERRIDES) {
          const unmet = describeRemaining(parsed, progress);
          return {
            action: { action: "done", reasoning: proposed?.reasoning || "Task complete." },
            substituted: false,
            reason: unmet && doneOverrides >= MAX_DONE_OVERRIDES
              ? `Stopping: could not complete ${unmet} on this page.`
              : "",
          };
        }
        const alt = ctx.deterministic;
        const altType = normalizeType(alt);
        if (alt && altType && altType !== "done") {
          doneOverrides++;
          const outstanding = fillIncomplete
            ? `${unfilledFields(marks, ctx.filledIds).length} form field(s)`
            : `"${describeRemaining(parsed, progress)}"`;
          return {
            action: { ...alt, action: altType },
            substituted: true,
            reason: `Planner stopped early with ${outstanding} outstanding; using the on-device plan instead.`,
          };
        }
        return {
          action: { action: "done", reasoning: proposed?.reasoning || "" },
          substituted: false,
          reason: describeRemaining(parsed, progress) ? `Could not complete: ${describeRemaining(parsed, progress)}.` : "",
        };
      }

      // ── Rule 5: loop detection. ──────────────────────────────────────────────────────────
      const target = marks.find((m) => String(m.id) === String(action.mark_id));
      const targetLabel = (target?.label || "").toLowerCase().trim();
      const sig = signatureOf(type, action.mark_id, action.value);
      const semSig = targetLabel ? ["semantic", type, targetLabel.slice(0, 30), String(action.value || "").slice(0, 60).toLowerCase()].join("|") : null;
      const seenExact = signatureCounts.get(sig) || 0;
      const seenSem = semSig ? (signatureCounts.get(semSig) || 0) : 0;
      const seen = Math.max(seenExact, seenSem);

      if (seen >= maxRepeats) {
        const alt = ctx.deterministic;
        const altType = normalizeType(alt);
        const altSig = alt ? signatureOf(altType, alt.mark_id, alt.value) : null;
        if (alt && altType && altType !== "done" && (signatureCounts.get(altSig) || 0) < maxRepeats) {
          return {
            action: { ...alt, action: altType },
            substituted: true,
            reason: `Refused a ${seen + 1}th identical ${type}; trying a different approach.`,
          };
        }
        return {
          action: { action: "done", reasoning: "" },
          stop: true,
          substituted: true,
          reason: `The same ${type} produced no effect ${seen} times — stopping rather than looping. ` +
                  (describeRemaining(parsed, progress) ? `Not completed: ${describeRemaining(parsed, progress)}.` : ""),
        };
      }

      return { action, substituted, reason };
    }

    /** Records what actually happened, after execution. */
    function record(type, markId, value, ok, targetLabel = "") {
      const sig = signatureOf(type, markId, value);
      const inc = ok ? 1 : 0.5;
      signatureCounts.set(sig, (signatureCounts.get(sig) || 0) + inc);
      if (targetLabel) {
        const cleanLabel = targetLabel.slice(0, 30).toLowerCase().trim();
        const semSig = ["semantic", type, cleanLabel, String(value || "").slice(0, 60).toLowerCase()].join("|");
        signatureCounts.set(semSig, (signatureCounts.get(semSig) || 0) + inc);
      }
      history.push({ signature: sig, type, ok, at: Date.now() });
    }

    /** Clears stall accounting after a real navigation, where a fresh page is expected. */
    function resetStall() {
      staleSteps = 0;
      lastFingerprint = null;
    }

    return {
      review,
      record,
      resetStall,
      get history() { return history.slice(); },
      get stats() { return { steps: history.length, doneOverrides, staleSteps }; },
    };
  }

  const AgentGuard = {
    createGuard,
    goalSatisfied,
    openTargetMet,
    goalFullyVerified,
    describeCompletion,
    describeRemaining,
    isPureScrollTask,
    isSearchLikeMark,
    unfilledFields,
    fingerprintOf,
    signatureOf,
    MAX_SIGNATURE_REPEATS,
    MAX_STEPS_WITHOUT_PROGRESS,
  };

  global.AgentGuard = AgentGuard;
  if (typeof module !== "undefined" && module.exports) module.exports = AgentGuard;
})(typeof globalThis !== "undefined" ? globalThis : this);

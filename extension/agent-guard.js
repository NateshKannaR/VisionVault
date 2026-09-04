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

  /**
   * Has the user's instruction actually been carried out?
   *
   * This is what makes `done` trustworthy. A planner saying "done" on step 1 with an empty
   * search box is wrong, and this is how the guard knows.
   */
  /** With a workflow plan, "done" means every milestone is done — nothing less. */
  function planOutstanding(plan) {
    if (!plan || !Array.isArray(plan.milestones) || !plan.milestones.length) return null;
    return plan.milestones.find((m) => m.status !== "done" && m.status !== "skipped") || null;
  }
  function hasPlan(plan) {
    return !!(plan && Array.isArray(plan.milestones) && plan.milestones.length);
  }

  function goalSatisfied(parsed, progress, plan) {
    const p = progress || {};
    if (hasPlan(plan)) return planOutstanding(plan) === null;
    if (!parsed) return true;

    // A search is only done when the query demonstrably reached the page — typed into a field,
    // or present in the URL or title. `searched` alone means "we typed something", which on
    // MakeMyTrip was true seven times over while the query never landed.
    if (parsed.query && !p.queryLanded) return false;

    if ((parsed.openTargets || []).length) {
      const opened = p.opened || [];
      if (!parsed.openTargets.every((t) => opened.includes(t))) return false;
    }
    if (parsed.wantsScroll && !p.scrolled) return false;
    if (parsed.wantsFill && !p.filledAny) return false;
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
  function goalFullyVerified(parsed, progress, plan) {
    if (hasPlan(plan)) return planOutstanding(plan) === null;
    if (!parsed || parsed.wantsFill) return false;
    const hasVerifiableIntent = !!parsed.query || (parsed.openTargets || []).length > 0 || parsed.wantsScroll;
    if (!hasVerifiableIntent) return false;
    return goalSatisfied(parsed, progress);
  }

  /** Human-readable summary of what remains, used in UI messages. */
  function describeRemaining(parsed, progress, plan) {
    const p = progress || {};
    const left = [];
    if (hasPlan(plan)) {
      const m = planOutstanding(plan);
      return m ? m.title.toLowerCase() : "";
    }
    if (parsed?.query && !p.queryLanded) left.push(`search for "${parsed.query}"`);
    for (const t of parsed?.openTargets || []) if (!(p.opened || []).includes(t)) left.push(`open "${t}"`);
    if (parsed?.wantsScroll && !p.scrolled) left.push("scroll the page");
    if (parsed?.wantsFill && !p.filledAny) left.push("fill the form");
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
    "input:url", "textarea", "editable",
  ]);

  /**
   * What each kind of milestone may legitimately do.
   *
   * Only the kinds whose work is NOT clicking are listed: `open`, `act`, `fill` and `navigate`
   * are open-ended by nature and are policed by the other rules instead. Terminal and
   * workflow-level verbs are allowed everywhere, because ending a run or moving to the next
   * milestone is always a valid answer.
   */
  const ALWAYS_ALLOWED = ["done", "next_milestone", "wait", "none", "finish", "stop", ""];
  const ALLOWED_BY_KIND = {
    answer: new Set([...ALWAYS_ALLOWED, "answer", "read_page"]),
    read: new Set([...ALWAYS_ALLOWED, "read_page", "answer", "scroll_page", "scroll", "scroll_to"]),
    scroll: new Set([...ALWAYS_ALLOWED, "scroll_page", "scroll", "scroll_to", "read_page"]),
    search: new Set([...ALWAYS_ALLOWED, "type", "click", "press_key", "select", "scroll_page", "scroll", "navigate", "read_page"]),
  };

  /** "a 3rd", "a 2nd" — these strings are shown to the user, so they read as English. */
  function ordinal(n) {
    const i = Math.round(n);
    const suffix = (i % 100 >= 11 && i % 100 <= 13) ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" }[i % 10] || "th");
    return `a ${i}${suffix}`;
  }

  function describeKind(kind) {
    return {
      answer: "a conclusion from what was read",
      read: "reading the page",
      scroll: "scrolling",
      search: "running the search",
    }[kind] || "something else";
  }

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
  function describeCompletion(parsed, progress, plan) {
    const p = progress || {};
    const bits = [];
    if (hasPlan(plan)) {
      const done = plan.milestones.filter((m) => m.status === "done");
      return done.length ? `Done — ${done.map((m) => m.title.toLowerCase()).join(", ")}.` : "Done.";
    }
    if (p.navigated && parsed?.site) bits.push(`opened ${parsed.site}`);
    if (p.queryLanded && parsed?.query) bits.push(`searched for "${parsed.query}"`);
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
      const plan = ctx.plan || null;
      // Milestones completed count as progress: a read, an answer or a navigation can leave
      // every page signal unchanged while the workflow has genuinely moved on.
      const milestonesDone = hasPlan(plan) ? plan.milestones.filter((m) => m.status === "done").length : 0;
      const fingerprint = fingerprintOf(ctx.pageInfo, marks, (ctx.filledIds || []).length + milestonesDone);
      // A fill milestone in a workflow behaves exactly like a fill task without one.
      const current = planOutstanding(plan);
      const filling = current ? current.kind === "fill" : !!parsed?.wantsFill;

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
                  (describeRemaining(parsed, progress, plan) ? `Not completed: ${describeRemaining(parsed, progress, plan)}.` : ""),
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
      if (type && type !== "done" && goalFullyVerified(parsed, progress, plan)) {
        return {
          action: { action: "done", reasoning: describeCompletion(parsed, progress, plan) },
          substituted: true,
          reason: "",
        };
      }

      // ── Rule 1: a pure scroll instruction may not click anything. ────────────────────────
      // "scroll down and show me more stories" is not permission to open a link whose text
      // happens to contain "down".
      if (type === "click" && isPureScrollTask(parsed) && (!current || current.kind === "scroll")) {
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
      if (type === "click" && filling) {
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

      // ── Rule 2b: the action must suit the milestone in hand. ─────────────────────────────
      //
      // A milestone says what kind of work is outstanding, and some kinds do not involve the
      // DOM at all. "Confirm selection" is an `answer`: it means state the conclusion from
      // what was read. Observed live, a planner answered it with a click on a different
      // product — the run had already put the right laptop in the cart, then opened the wrong
      // one on the way to writing its summary. Reading is similar: once a page has been read,
      // clicking around it is not what "compare the options" asked for.
      if (current && ALLOWED_BY_KIND[current.kind] && !ALLOWED_BY_KIND[current.kind].has(type)) {
        const alt = ctx.deterministic;
        const altType = normalizeType(alt);
        if (alt && altType && ALLOWED_BY_KIND[current.kind].has(altType)) {
          return {
            action: { ...alt, action: altType },
            substituted: true,
            reason: `"${current.title}" calls for ${describeKind(current.kind)}, not a ${type}.`,
          };
        }
      }

      // ── Rule 2c: do not navigate away from the search box you are about to use. ──────────
      //
      // A link click during an outstanding search leaves the page, and the box goes with it.
      // Observed live on eBay: step one clicked an unlabelled link, the home page was replaced,
      // two attempts to reveal a search box failed, and the milestone was abandoned. A button
      // is left alone — on GitHub and MDN a button is what mounts the search input — but a link
      // is never how a search is run when a box is already visible.
      if (type === "click" && parsed?.query && !progress.queryLanded && (!current || current.kind === "search")) {
        const target = marks.find((m) => String(m.id) === String(action.mark_id));
        const box = marks.find((m) => FILLABLE_ROLES.has(m.role) && !(ctx.filledIds || []).map(String).includes(String(m.id)));
        if (target && target.role === "link" && box) {
          return {
            action: { action: "type", mark_id: box.id, value: parsed.query,
                      reasoning: `Search for "${parsed.query}"` },
            substituted: true,
            reason: `Not following a link while the search is outstanding — typing into "${box.label || "the search box"}" instead.`,
          };
        }
      }

      // ── Rule 3: never type the user's whole sentence into a search box. ──────────────────
      if (type === "type" && !action.use_vault_field && parsed?.query && action.value &&
          (!current || current.kind === "search")) {
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
        const fillIncomplete = filling && unfilledFields(marks, ctx.filledIds).length > 0;

        if ((goalSatisfied(parsed, progress, plan) && !fillIncomplete) || doneOverrides >= MAX_DONE_OVERRIDES) {
          const unmet = describeRemaining(parsed, progress, plan);
          return {
            action: { ...proposed, action: "done", reasoning: proposed?.reasoning || "Task complete." },
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
            : `"${describeRemaining(parsed, progress, plan)}"`;
          return {
            action: { ...alt, action: altType },
            substituted: true,
            reason: `Planner stopped early with ${outstanding} outstanding; using the on-device plan instead.`,
          };
        }
        return {
          action: { ...proposed, action: "done", reasoning: proposed?.reasoning || "" },
          substituted: false,
          reason: describeRemaining(parsed, progress, plan) ? `Could not complete: ${describeRemaining(parsed, progress, plan)}.` : "",
        };
      }

      // ── Rule 5: loop detection. ──────────────────────────────────────────────────────────
      const sig = signatureOf(type, action.mark_id, action.value);
      const seen = signatureCounts.get(sig) || 0;
      if (seen >= maxRepeats) {
        const alt = ctx.deterministic;
        const altType = normalizeType(alt);
        const altSig = alt ? signatureOf(altType, alt.mark_id, alt.value) : null;
        if (alt && altType && altType !== "done" && (signatureCounts.get(altSig) || 0) < maxRepeats) {
          return {
            action: { ...alt, action: altType },
            substituted: true,
            reason: `Refused ${ordinal(seen + 1)} identical ${type}; trying a different approach.`,
          };
        }
        return {
          action: { action: "done", reasoning: "" },
          stop: true,
          substituted: true,
          reason: `The same ${type} produced no effect ${seen} times — stopping rather than looping. ` +
                  (describeRemaining(parsed, progress, plan) ? `Not completed: ${describeRemaining(parsed, progress, plan)}.` : ""),
        };
      }

      return { action, substituted, reason };
    }

    /** Records what actually happened, after execution. */
    function record(type, markId, value, ok) {
      const sig = signatureOf(type, markId, value);
      // Only a *successful* action counts toward the repeat budget in a way that blocks retry;
      // a failed action is allowed one honest retry before the same rule applies.
      signatureCounts.set(sig, (signatureCounts.get(sig) || 0) + (ok ? 1 : 0.5));
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
    goalFullyVerified,
    describeCompletion,
    describeRemaining,
    isPureScrollTask,
    isSearchLikeMark,
    unfilledFields,
    fingerprintOf,
    signatureOf,
    planOutstanding,
    MAX_SIGNATURE_REPEATS,
    MAX_STEPS_WITHOUT_PROGRESS,
  };

  global.AgentGuard = AgentGuard;
  if (typeof module !== "undefined" && module.exports) module.exports = AgentGuard;
})(typeof globalThis !== "undefined" ? globalThis : this);

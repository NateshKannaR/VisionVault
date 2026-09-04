/**
 * task-planner.js — Understands the user's instruction, breaks it into a workflow, and decides
 * the next action when no cloud planner is available.
 *
 * This is the on-device planner. It runs on every step as the yardstick the guard compares
 * the model's answer against, and it takes over entirely whenever the planning server is
 * unreachable — which in practice is often, so it has to be genuinely useful, not a stub.
 *
 * Three responsibilities:
 *
 *   parseTask(text)      Turn a sentence into structure: which site, what to search for, what
 *                        to open afterwards, whether to scroll or fill a form. Crucially it
 *                        strips conversational tails, so "search for iqoo neo 6 and show me"
 *                        searches for "iqoo neo 6" and not for "iqoo neo 6 and show me".
 *
 *   decomposeTask(text)  Turn a sentence into an ordered list of milestones — the workflow.
 *                        "find the best laptop under my budget, compare the options, add the
 *                        best one to cart" becomes search -> read -> open -> act. The server's
 *                        model tiers produce the same shape and are preferred when available;
 *                        this is the version that needs no model. Mirrored in server/main.py.
 *
 *   planNextAction()     Pick ONE next action for the current milestone, or decide it is done.
 *                        It stops as soon as the instruction has been carried out. It will not
 *                        click a link merely because a word from the task appears in the link's
 *                        text — that behaviour made the agent wander a results page indefinitely.
 *
 * Loaded by the service worker (importScripts) and exported for Node so the parser can be unit
 * tested without a browser: `node eval/test-task-planner.js`, `node eval/test-workflow.js`.
 */

(function (global) {
  // Sites worth knowing by name, because "open amazon" should not become amazon.com for a user
  // in India. Anything not listed falls back to https://www.<name>.com.
  const KNOWN_SITES = {
    amazon: "https://www.amazon.in",
    flipkart: "https://www.flipkart.com",
    myntra: "https://www.myntra.com",
    makemytrip: "https://www.makemytrip.com",
    "make my trip": "https://www.makemytrip.com",
    goibibo: "https://www.goibibo.com",
    irctc: "https://www.irctc.co.in",
    swiggy: "https://www.swiggy.com",
    zomato: "https://www.zomato.com",
    whatsapp: "https://web.whatsapp.com",
    youtube: "https://www.youtube.com",
    google: "https://www.google.com",
    wikipedia: "https://www.wikipedia.org",
    github: "https://github.com",
    reddit: "https://www.reddit.com",
    "stack overflow": "https://stackoverflow.com",
    stackoverflow: "https://stackoverflow.com",
    "hacker news": "https://news.ycombinator.com",
    bbc: "https://www.bbc.com/news",
    mdn: "https://developer.mozilla.org",
    linkedin: "https://www.linkedin.com",
    twitter: "https://twitter.com",
    x: "https://x.com",
    instagram: "https://www.instagram.com",
    gmail: "https://mail.google.com",
    sih: "https://www.sih.gov.in",
    booking: "https://www.booking.com",
    ebay: "https://www.ebay.com",
    imdb: "https://www.imdb.com",
    bookmyshow: "https://in.bookmyshow.com",
    snapdeal: "https://www.snapdeal.com",
    duckduckgo: "https://duckduckgo.com",
    bing: "https://www.bing.com",
    npm: "https://www.npmjs.com",
    pypi: "https://pypi.org",
  };

  // Conversational tail: "... and show me", "... then tell me the results", "... please".
  // These describe what the user wants to SEE, not what to type into a search box.
  const TAIL_RE = /\s*(?:,|\band\b|\bthen\b)?\s*(?:please\s+)?(?:can\s+you\s+)?(?:show|display|tell|give|list|find)\s+(?:me|us|it)?\s*(?:the\s+)?(?:results?|details?|options?|list|prices?|it)?\s*[.!]?\s*$/i;

  // Verbs that start a new instruction. A clause boundary is a comma/semicolon/full stop, or
  // a conjunction, followed by one of these — so "search for salt and pepper" stays one
  // clause, and "find laptops, compare them" splits at the comma.
  const CLAUSE_VERBS =
    "open|click|select|choose|pick|scroll|show|tell|display|go|buy|add|book|play|read|check|" +
    "compare|analy[sz]e|extract|summari[sz]e|note|find|search|look|fill|enter|type|navigate|visit|" +
    "prepare|proceed|apply|filter|sort|verify|make sure|ensure|save|copy|list|get|bring|report|" +
    "give|send|compose|write|reply|log|sign|register|track|remove|update|create|complete|start|" +
    "review|evaluate|examine|research|then|finally";
  const CLAUSE_SPLIT_RE = new RegExp(
    "(?:\\s*[,;.]\\s*(?:and\\s+then|and|then|after that|afterwards|finally|next)?\\s*" +
    "|\\s+(?:and\\s+then|and|then|after that|afterwards|finally|next)\\s+)" +
    "(?:also\\s+)?(?=(?:" + CLAUSE_VERBS + ")\\b)", "i");

  const LEAD_RE = /^\s*(?:hey|hi|ok|okay|please|can you|could you|would you|i want to|i want you to|i need to|help me|let's|lets)\s+/i;

  // Trailing politeness and punctuation, stripped after the tail clause.
  const POLITE_TAIL_RE = /[\s,.!]*\b(?:please|thanks|thank you|pls|plz)\b[\s,.!]*$/i;

  const SEARCH_RE = /\b(?:search|look|find|browse)\s+(?:for\s+|up\s+|me\s+)?(.+)$/i;
  const SITE_RE = /\b(?:open|go\s+to|goto|visit|navigate\s+to|launch|browse)\s+(.+?)(?=\s+(?:and|then|,)\s+|$)/i;
  const OPEN_TARGET_RE = /\b(?:open|click|select|choose|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)(?=\s+(?:and|then|,)\s+|$)/i;
  const QUERY_LEAD_RE = /^(?:the\s+)?(?:best|cheapest|top(?:\s+rated)?|good|a|an|some|most (?:suitable|popular))\s+/i;
  // Qualifiers that describe how to choose, not what to type: "laptop under my budget"
  // searches for "laptop"; the budget is applied when the results are compared.
  const QUERY_STOP_RE = /\s+(?:that|which|having|with the (?:best|highest|most|lowest)|(?:under|within|below|inside) (?:my|our|the) budget)\b.*$/i;
  // A clause that only says what the user wants to SEE. Not an instruction to the browser.
  const TAIL_CLAUSE_RE = /^(?:show|display)\s+(?:me|us)\b/i;
  const ANSWER_CLAUSE_RE = /^(?:tell|give)\s+(?:me|us)\b|^(?:list|report|extract|summari[sz]e|note|what|which|how much|how many)\b/i;
  const BEST_RE = /\b(?:best|cheapest|top rated|highest rated|most suitable|good|compare)\b/i;

  function stripQuotes(s) {
    return String(s || "").replace(/^["'`“‘]+|["'`”’]+$/g, "").trim();
  }

  function siteUrlFor(name) {
    const key = String(name || "").toLowerCase().trim().replace(/\.(com|in|org|net|co\.in)$/, "");
    if (KNOWN_SITES[key]) return KNOWN_SITES[key];

    // A bare domain the user typed, e.g. "open example.co.uk"
    if (/^[a-z0-9-]+(\.[a-z]{2,})+$/i.test(name)) return `https://${name}`;
    if (/^[a-z0-9 -]{2,30}$/i.test(key)) return `https://www.${key.replace(/\s+/g, "")}.com`;
    return null;
  }

  /** The search string inside one clause, with tails and qualifiers removed. */
  function extractQuery(clause) {
    const m = String(clause || "").match(SEARCH_RE);
    if (!m) return null;
    let q = m[1];
    q = q.split(CLAUSE_SPLIT_RE)[0];   // drop "... and open the first result"
    q = q.replace(TAIL_RE, "");        // drop "... and show me"
    q = q.replace(POLITE_TAIL_RE, ""); // drop "... please"
    q = q.replace(QUERY_STOP_RE, "");  // drop "... under my budget"
    q = q.replace(QUERY_LEAD_RE, "");  // drop "the best ..."
    q = stripQuotes(q).replace(/\s+/g, " ").trim();
    q = q.replace(/[\s,;:.\-]+$/, "").trim(); // trailing punctuation left by a clause split
    // Guard against the query collapsing to a filler word.
    if (!q || /^(?:me|it|this|that|results?|them)$/i.test(q)) return null;
    return q.slice(0, 120);
  }

  /**
   * Turns an instruction into structure.
   * @returns {{raw, site, siteUrl, query, openTargets, wantsScroll, wantsFill, wantsSearch, wantsCompare, wantsAnswer}}
   */
  function parseTask(raw) {
    const original = String(raw || "").trim();
    let text = original.replace(LEAD_RE, "").trim();

    const result = {
      raw: original,
      site: null,
      siteUrl: null,
      query: null,
      openTargets: [],
      wantsScroll: /\b(scroll|load more|read more|next page|more results|scroll down)\b/i.test(text),
      wantsFill: /\b(fill|register|sign\s*up|signup|form|apply|checkout|book|enter my details)\b/i.test(text),
      wantsSearch: false,
      wantsCompare: BEST_RE.test(text) || /\b(analy[sz]e|review|evaluate)\b/i.test(text),
      wantsAnswer: /\b(summari[sz]e|summary|tell me|extract|report|what is|how much|how many|which)\b/i.test(text),
    };

    // 1. Site to open first: "open amazon and ..." / "go to makemytrip, search ..."
    const siteMatch = text.match(SITE_RE);
    if (siteMatch) {
      const candidate = stripQuotes(siteMatch[1]);
      // "open the first result" is a target on the current page, not a site to navigate to.
      const looksLikeSite = !/\b(result|link|item|product|tab|menu|first|second|third|top|best|page)\b/i.test(candidate);
      const url = looksLikeSite ? siteUrlFor(candidate) : null;
      if (url) {
        result.site = candidate.toLowerCase();
        result.siteUrl = url;
        // Remove the navigation clause so it cannot leak into the search query.
        text = (text.slice(0, siteMatch.index) + " " + text.slice(siteMatch.index + siteMatch[0].length)).trim();
        text = text.replace(/^\s*(?:and|then|,)\s+/i, "").trim();
      }
    }

    // 2. Search query: everything after "search for", minus follow-up clauses and tails.
    const searchMatch = text.match(SEARCH_RE);
    if (searchMatch) {
      result.wantsSearch = true;
      result.query = extractQuery(text.slice(searchMatch.index));
    }

    // 3. Explicit things to open/click AFTER the search.
    const remainder = searchMatch ? text.slice(searchMatch.index + searchMatch[0].length) : text;
    const clauses = (searchMatch ? searchMatch[1] : remainder).split(CLAUSE_SPLIT_RE).slice(1).concat(
      remainder.split(CLAUSE_SPLIT_RE).slice(1)
    );
    for (const clause of clauses) {
      const m = clause.match(OPEN_TARGET_RE) || clause.match(/^(?:open|click|select)\s+(.+)$/i);
      const target = m ? stripQuotes(m[1]).replace(TAIL_RE, "").trim() : "";
      if (target && target.length >= 2) result.openTargets.push(target.toLowerCase());
    }
    if (!searchMatch) {
      const m = text.match(OPEN_TARGET_RE);
      if (m) {
        const target = stripQuotes(m[1]).replace(TAIL_RE, "").trim().toLowerCase();
        if (target && target.length >= 2 && target !== result.site) result.openTargets.push(target);
      }
    }

    return result;
  }

  // ── Workflow decomposition ─────────────────────────────────────────────────────────────

  /**
   * Breaks an instruction into ordered milestones. Rules only; the model tiers on the server
   * produce the same shape and are preferred when they answer.
   *
   * Kinds: navigate | search | read | open | fill | scroll | act | answer | confirm
   * @returns {{goal: string, milestones: Array, current: number}}
   */
  function decomposeTask(task) {
    let text = String(task || "").replace(LEAD_RE, "").trim();
    text = text.replace(TAIL_RE, "").replace(POLITE_TAIL_RE, "").trim();
    const clauses = text.split(CLAUSE_SPLIT_RE).map((c) => c.replace(/^[\s,.;]+|[\s,.;]+$/g, "")).filter(Boolean);
    const milestones = [];
    let wantsAnswer = false;
    let wantsBest = false;

    const add = (kind, title, target = null, note = null) => {
      // Two reads in a row ("compare the options", "analyse the ratings") are one read of one
      // page; keep both titles but do not read the page twice.
      if (kind === "read" && milestones.length && milestones[milestones.length - 1].kind === "read") {
        if (title !== "Read the page") {
          const last = milestones[milestones.length - 1];
          last.title = (last.title + "; " + title).slice(0, 80);
        }
        return;
      }
      milestones.push({
        id: milestones.length + 1, kind, title: String(title).slice(0, 80), status: "pending",
        target: target ? String(target).slice(0, 120) : null, note: note || null,
      });
    };
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    for (let clause of clauses) {
      let low = clause.toLowerCase();
      if (TAIL_CLAUSE_RE.test(low)) continue;

      const siteMatch = clause.match(SITE_RE);
      if (siteMatch) {
        const candidate = stripQuotes(siteMatch[1]);
        const looksLikeSite = !/\b(result|link|item|product|tab|menu|first|second|third|top|best|page)\b/i.test(candidate);
        const url = looksLikeSite ? siteUrlFor(candidate) : null;
        if (url) {
          add("navigate", `Open ${candidate}`, url);
          let rest = (clause.slice(0, siteMatch.index) + " " + clause.slice(siteMatch.index + siteMatch[0].length)).trim();
          rest = rest.replace(/^[\s,]+|[\s,]+$/g, "").replace(/^(?:and|then)\s+/i, "").trim();
          if (!rest) continue;
          clause = rest;
          low = rest.toLowerCase();
        }
      }

      const query = extractQuery(clause);
      if (query && /^(?:search|look|find|browse)\b/.test(low)) {
        add("search", `Search for "${query}"`, query);
        if (BEST_RE.test(low)) wantsBest = true;
        continue;
      }
      if (/^(?:compare|analy[sz]e|check|review|evaluate|examine|research|read|look at)\b/.test(low)) {
        add("read", cap(clause), null, "compare");
        continue;
      }
      if (ANSWER_CLAUSE_RE.test(low) || /\b(summary|summari[sz]e)\b/.test(low)) {
        add("read", "Read the page", null, "extract");
        add("answer", cap(clause), clause);
        wantsAnswer = true;
        continue;
      }
      if (/^(?:select|choose|pick)\b/.test(low) && /\b(best|most suitable|top|cheapest|highest|first)\b/.test(low)) {
        add("open", cap(clause), "best");
        continue;
      }
      if (/^add\b.*\b(?:cart|bag|basket)\b/.test(low)) {
        add("act", "Add it to the cart", "add to cart", "asks for approval");
        continue;
      }
      if (/\b(checkout|check out|buy now|place (?:the )?order|proceed to (?:buy|pay))\b/.test(low)) {
        add("act", "Go to checkout", "checkout", "asks for approval");
        continue;
      }
      if (/\b(fill|register|sign\s?up|signup|enter my details|complete the form|apply)\b/.test(low)) {
        add("fill", "Fill in the form from the vault");
        continue;
      }
      if (/\b(scroll|load more|next page|more results|read more)\b/.test(low)) {
        add("scroll", "Scroll for more");
        continue;
      }
      const om = clause.match(OPEN_TARGET_RE);
      if (om && /^(?:open|click|select|choose|tap)\b/.test(low)) {
        const target = stripQuotes(om[1]).replace(TAIL_RE, "").trim().toLowerCase();
        if (target) {
          add("open", `Open "${target}"`, target);
          continue;
        }
      }
      if (/\b(log\s?in|sign\s?in|login)\b/.test(low)) {
        add("act", "Sign in", "sign in", "asks for approval");
        continue;
      }
      add("act", cap(clause), clause);
    }

    if (!milestones.length) add("act", text || task || "Do the task", text || task);

    // "the best X" implies comparing and choosing, even when the sentence never says so. Only
    // added when the user did not spell those steps out themselves.
    const kinds = milestones.map((m) => m.kind);
    if (wantsBest && !kinds.includes("read")) {
      const at = kinds.indexOf("search") >= 0 ? kinds.indexOf("search") + 1 : milestones.length;
      milestones.splice(at, 0,
        { id: 0, kind: "read", title: "Read and compare the results", status: "pending", target: null, note: "compare" },
        { id: 0, kind: "open", title: "Open the best match", status: "pending", target: "best", note: null });
    } else if (wantsBest && !kinds.includes("open")) {
      const at = kinds.lastIndexOf("read") + 1;
      milestones.splice(at, 0, { id: 0, kind: "open", title: "Open the best match", status: "pending", target: "best", note: null });
    }
    if (wantsAnswer && milestones[milestones.length - 1].kind !== "answer") {
      add("answer", "Summarise what was found", "summary");
    }
    milestones.forEach((m, i) => { m.id = i + 1; });
    return { goal: String(task || "").slice(0, 200), milestones, current: 0 };
  }

  /** The first milestone that is neither done nor skipped, or null. */
  function currentMilestone(plan) {
    if (!plan || !Array.isArray(plan.milestones)) return null;
    return plan.milestones.find((m) => m.status !== "done" && m.status !== "skipped") || null;
  }

  // Leading words that describe the act rather than name the thing to act on.
  //
  // Deliberately short. "Add to cart" and "Go to checkout" ARE what the button says, so
  // stripping their verbs turns a matchable label into "cart" and "checkout" — which then
  // matches half the page. Only verbs that never appear on the control itself are removed.
  const VERB_LEAD_RE = /^(?:select|choose|pick|click|tap|locate|navigate to)\s+(?:the\s+|a\s+|an\s+|on\s+)?/i;
  const BEST_TITLE_RE = /\b(?:best|most suitable|top[- ]?rated|highest[- ]?rated|cheapest|top result|first result|first one|best one|best match)\b/i;

  /**
   * Fills in what a milestone left unsaid.
   *
   * A model asked for a workflow returns titles reliably and targets erratically: "Select
   * best-rated laptop" arrives with `target: null` perhaps half the time. A milestone with no
   * target gave the on-device planner nothing to match against, so it answered "done" — and
   * "done" ends the run. Measured: a five-milestone shopping journey stopped dead on milestone
   * three with two of five achieved, purely because that field was empty.
   *
   * So the title is read for what it means: anything about the "best" one becomes the symbolic
   * target `best`, and anything else keeps its own words with the leading verb removed.
   * Mutates and returns the plan.
   */
  function normalizePlan(plan) {
    if (!plan || !Array.isArray(plan.milestones)) return plan;
    for (const m of plan.milestones) {
      m.status = m.status || "pending";
      if (m.target) continue;
      const title = String(m.title || "");
      if ((m.kind === "open" || m.kind === "act") && BEST_TITLE_RE.test(title)) {
        m.target = "best";
        if (m.kind === "act") m.kind = "open";
        continue;
      }
      if (m.kind === "act" || m.kind === "open") {
        const bare = title.replace(VERB_LEAD_RE, "").trim();
        if (bare && bare.length >= 2) m.target = bare.toLowerCase().slice(0, 120);
      } else if (m.kind === "search") {
        const q = extractQuery(title) || title.replace(/^search\s+(?:for\s+)?/i, "").trim();
        if (q) m.target = q.slice(0, 120);
      }
    }
    return plan;
  }

  function planComplete(plan) {
    return !!(plan && Array.isArray(plan.milestones) && plan.milestones.length) && currentMilestone(plan) === null;
  }

  /** True when `url` is already on the site the task asked for. */
  function alreadyOnSite(url, siteUrl) {
    if (!url || !siteUrl) return false;
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const want = new URL(siteUrl).hostname.replace(/^www\./, "");
      // Match the registrable part so amazon.in and www.amazon.in and m.amazon.in all count.
      const tail = want.split(".").slice(-2).join(".");
      return host === want || host.endsWith("." + tail) || host === tail;
    } catch (_) {
      return false;
    }
  }

  const FILLABLE_ROLES = new Set([
    "input:text", "input:email", "input:tel", "input:password", "input:url", "input:number",
    "textarea", "editable", "input:search",
  ]);
  const CLICKABLE_ROLES = new Set([
    "link", "button", "clickable", "input:submit", "input:checkbox", "input:radio",
    "checkbox", "option", "tab", "menuitem",
  ]);

  const FIELD_LABEL_RULES = [
    [/user\s*name|username|user id|handle|login\s*id/, "username"],
    [/e-?mail/, "email"],
    [/phone|mobile|tel(ephone)?|contact number/, "phone"],
    [/password|passcode/, "password"],
    [/address|street|city|postcode|post code|zip|postal/, "address"],
    [/company|organisation|organization|employer/, "company"],
    [/about|bio|description|notes/, "about"],
    [/full\s*name|first\s*name|last\s*name|surname|\bname\b/, "name"],
  ];

  // Fields that hold a personal identifier the vault has no equivalent for. Typing a phone
  // number into one because "phone" was the closest available key is worse than not filling
  // it: the value is wrong, it is personal, and it goes into a field that may validate it.
  // These are asked about instead.
  const UNKNOWN_IDENTIFIER_RE =
    /aadhaar|aadhar|\bpan\b|passport|licence|license|voter|ssn|social security|nino|national insurance|tax id|gst|ifsc|upi|account number|card number|cvv|otp|pin\b/i;

  /**
   * Which vault key a field's own label calls for, judged from the label alone.
   *
   * Used to sanity-check what a planner asked for. A model looking at "Aadhaar number" and an
   * eight-key menu will pick the nearest key rather than decline — observed live, it chose
   * "phone" — so the label gets the final say on its own field.
   *
   * @returns {{key: string|null, unknownIdentifier: boolean}}
   */
  function vaultKeyForLabel(label) {
    const text = String(label || "").toLowerCase();
    if (!text) return { key: null, unknownIdentifier: false };
    if (UNKNOWN_IDENTIFIER_RE.test(text)) return { key: null, unknownIdentifier: true };
    for (const [pattern, key] of FIELD_LABEL_RULES) {
      if (pattern.test(text)) return { key, unknownIdentifier: false };
    }
    return { key: null, unknownIdentifier: false };
  }

  function isSearchBox(mark) {
    if (mark.role === "input:search") return true;
    const label = (mark.label || "").toLowerCase();
    return (mark.role === "input:text" || mark.role === "editable") && /search|find|query|keyword/.test(label);
  }

  // ── Purpose-based label matching ───────────────────────────────────────────────────────
  //
  // Controls are matched by what they do, not by their exact wording. A site that says
  // "Proceed" where another says "Continue" must not defeat a rule about continuing, and
  // "Add to bag" is "Add to cart" on a clothing site.
  const SYNONYMS = {
    "add to cart": [/add to (?:cart|bag|basket)/i, /\bbuy\b(?! now)/i, /add item/i],
    "checkout": [/check ?out/i, /buy now/i, /place order/i, /proceed to (?:buy|pay|checkout)/i, /continue to payment/i, /pay now/i],
    "continue": [/\bcontinue\b/i, /\bproceed\b/i, /\bnext\b/i, /\bgo\b/i, /\bok\b/i, /\bdone\b/i],
    "sign in": [/sign ?in/i, /log ?in/i, /\blogin\b/i],
    "sign up": [/sign ?up/i, /register/i, /create (?:an )?account/i, /\bjoin\b/i],
    "search": [/\bsearch\b/i, /\bfind\b/i, /\bgo\b/i],
    "submit": [/\bsubmit\b/i, /\bapply\b/i, /\bsend\b/i, /\bsave\b/i, /\bconfirm\b/i],
    "filter": [/\bfilter/i, /\bsort\b/i, /refine/i],
    "book": [/\bbook\b/i, /reserve/i, /select (?:seat|room|flight)/i],
    "next page": [/next page/i, /\bnext\b/i, /load more/i, /show more/i, /see more/i],
  };
  const STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "into", "from", "one", "its", "it"]);

  /** Does a control's label mean what `target` means? */
  function labelMatches(target, label) {
    const t = String(target || "").toLowerCase().trim();
    const l = String(label || "").toLowerCase();
    if (!t || !l) return false;
    if (l.includes(t)) return true;
    for (const [key, patterns] of Object.entries(SYNONYMS)) {
      if (t.includes(key) || key.includes(t)) {
        if (patterns.some((p) => p.test(l))) return true;
      }
    }
    const words = (t.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    return words.length > 0 && words.every((w) => l.includes(w));
  }

  // ── Choosing among what was read ───────────────────────────────────────────────────────

  function moneyOf(v) {
    const m = String(v || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  function ratingOf(v) {
    const m = String(v || "").match(/(\d(?:\.\d)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  /**
   * The item a person would pick: highest rating, then lowest price, within any stated budget.
   * The budget may come from the task ("under 50000") or the user's preferences.
   */
  function pickBestItem(findings, preferences, task) {
    const items = [];
    for (const f of findings || []) for (const it of f.items || []) if (it && it.title) items.push(it);
    if (!items.length) return null;
    const budgetText = `${task || ""} ${preferences || ""}`;
    const bm = budgetText.match(/(?:under|below|less than|upto|up to|max(?:imum)?|within)\s*(?:rs\.?|₹|\$|inr)?\s*(\d[\d,]*)/i);
    const budget = bm ? parseFloat(bm[1].replace(/,/g, "")) : null;
    let pool = items.filter((i) => budget === null || moneyOf(i.price) === null || moneyOf(i.price) <= budget);
    if (!pool.length) pool = items;
    pool.sort((a, b) => ((ratingOf(b.rating) || 0) - (ratingOf(a.rating) || 0)) ||
                        ((moneyOf(a.price) ?? 1e12) - (moneyOf(b.price) ?? 1e12)));
    return pool[0];
  }

  /**
   * Chooses the next action, or returns `done`.
   *
   * @param {Object} state
   * @param {string} state.task            the user's raw instruction
   * @param {Array}  state.marks           safe marks from the latest scan
   * @param {Array}  state.filledIds       marks already acted on
   * @param {Object} state.pageInfo        { url, title, page_height, scroll_y, viewport_height }
   * @param {Object} state.progress        { searched, navigated, opened: [], scrolled }
   * @param {Object} [state.plan]          { milestones: [...] } — milestone-aware when present
   * @param {Array}  [state.findings]      what earlier read_page steps recorded
   * @param {Object} [state.pageContent]   what the page says, if it was just read
   * @param {Array}  [state.recentActions] [{type, label, ok}] most recent last
   * @param {string} [state.preferences]   the user's standing preferences
   * @returns {{action, mark_id?, value?, use_vault_field?, reasoning, milestoneDone?, findings?}}
   */
  function planNextAction(state) {
    const parsed = state.parsed || parseTask(state.task);
    const marks = state.marks || [];
    const done = new Set((state.filledIds || []).map(String));
    const progress = state.progress || {};
    const url = (state.pageInfo && state.pageInfo.url) || "";
    const findings = state.findings || [];
    const recent = state.recentActions || [];
    const last = recent.length ? recent[recent.length - 1] : null;
    const justRead = !!last && last.type === "read_page" && last.ok !== false;

    const available = marks.filter((m) => !done.has(String(m.id)));
    const first = (pred) => available.find(pred) || null;
    const clickable = (m) => CLICKABLE_ROLES.has(m.role) && m.label;

    const fillStep = () => {
      for (const m of available) {
        if (!FILLABLE_ROLES.has(m.role) || isSearchBox(m)) continue;
        const label = (m.label || "").toLowerCase();
        if (!label) continue;
        for (const [pattern, key] of FIELD_LABEL_RULES) {
          if (pattern.test(label)) {
            return { action: "type", mark_id: m.id, use_vault_field: key, reasoning: `Fill "${label}" from the local vault (${key})` };
          }
        }
      }
      return null;
    };

    const milestone = currentMilestone(state.plan);
    if (milestone) {
      const kind = milestone.kind;
      const target = milestone.target || "";
      const doneStep = (reasoning) => ({ action: "next_milestone", reasoning, milestoneDone: true });

      if (kind === "navigate") {
        if (progress.navigated || (target && alreadyOnSite(url, target))) return doneStep("Already on the site");
        return { action: "navigate", value: target || parsed.siteUrl, reasoning: `Open ${milestone.title.replace(/^open\s+/i, "")}`, milestoneDone: true };
      }
      if (kind === "search") {
        const query = target || parsed.query;
        if (progress.queryLanded) return doneStep("The search has run");
        const box = first(isSearchBox) || first((m) => FILLABLE_ROLES.has(m.role));
        if (box && query) return { action: "type", mark_id: box.id, value: query, reasoning: `Search for "${query}"` };
        return { action: "next_milestone", milestoneStuck: true, reasoning: "No search box is visible on this page" };
      }
      if (kind === "read") {
        if (state.pageContent && justRead) {
          const items = (state.pageContent.items || []).filter((i) => i && i.title).slice(0, 20);
          const text = !items.length && state.pageContent.text ? String(state.pageContent.text).slice(0, 600) : null;
          return {
            action: "answer",
            value: items.length ? `Found ${items.length} items on this page.` : (text || "Read the page."),
            reasoning: items.length ? `Read ${items.length} item(s) from the page` : "Read the page",
            milestoneDone: true,
            findings: { kind: "items", title: milestone.title, milestone: milestone.id, items, text },
          };
        }
        if (!justRead) return { action: "read_page", reasoning: "Read what the page shows" };
        return doneStep("Nothing more to read here");
      }
      if (kind === "answer") {
        const best = pickBestItem(findings, state.preferences, state.task);
        let text;
        if (best) {
          text = `Best match: ${best.title}${best.price ? ` at ${best.price}` : ""}${best.rating ? ` rated ${best.rating}` : ""}.`;
        } else {
          const n = findings.reduce((s, f) => s + (f.items || []).length, 0);
          text = findings.length ? `Read ${n} item(s) across ${findings.length} page read(s).` : "No structured results were found on the pages visited.";
        }
        return { action: "answer", value: text, reasoning: "Summarise the findings", milestoneDone: true };
      }
      if (kind === "open") {
        if (target === "best") {
          const best = pickBestItem(findings, state.preferences, state.task);
          if (!best) {
            if (!justRead && !findings.length) return { action: "read_page", reasoning: "Read the options before choosing" };
            const link = first((m) => m.role === "link" && m.label && m.label.length > 8);
            if (link) return { action: "click", mark_id: link.id, reasoning: `Open the first result: ${link.label}`, milestoneDone: true, openTarget: "best" };
            return { action: "done", reasoning: "Nothing to choose from on this page" };
          }
          const title = String(best.title || "");
          let hit = best.mark_id != null ? first((m) => String(m.id) === String(best.mark_id)) : null;
          if (!hit) hit = first((m) => m.role === "link" && m.label && labelMatches(title.slice(0, 40), m.label));
          if (hit) return { action: "click", mark_id: hit.id, reasoning: `Open the best match: ${title.slice(0, 60)}`, milestoneDone: true, openTarget: "best" };
          if (best.url && /^https?:\/\//i.test(best.url)) {
            return { action: "navigate", value: best.url, reasoning: `Open the best match: ${title.slice(0, 60)}`, milestoneDone: true, openTarget: "best" };
          }
          return { action: "scroll_to", value: title.slice(0, 60), reasoning: "Bring the best match into view" };
        }
        if (/^(?:the\s+)?(?:first|top|1st)\b/.test(target)) {
          const link = first((m) => m.role === "link" && m.label && m.label.length > 8);
          if (link) return { action: "click", mark_id: link.id, reasoning: `Open the first result: ${link.label}`, milestoneDone: true, openTarget: target };
        } else {
          const hit = first((m) => clickable(m) && labelMatches(target, m.label));
          if (hit) return { action: "click", mark_id: hit.id, reasoning: `Open "${hit.label}"`, milestoneDone: true, openTarget: target };
          if (target && !justRead && target.split(/\s+/).length <= 5) {
            return { action: "scroll_to", value: target, reasoning: `Look for "${target}" on the page` };
          }
        }
        return { action: "next_milestone", milestoneStuck: true, reasoning: `Could not find "${target}" on this page` };
      }
      if (kind === "act") {
        const hit = first((m) => clickable(m) && labelMatches(target, m.label));
        if (hit) return { action: "click", mark_id: hit.id, reasoning: `${milestone.title} ("${hit.label}")`, milestoneDone: true };
        // A short target is a label to look for. A long one is an instruction ("book a flight
        // from delhi to goa") that rules cannot carry out; say so rather than hunt for it.
        if (target && !justRead && target.split(/\s+/).length <= 4) {
          return { action: "scroll_to", value: target, reasoning: `Look for "${target}" on the page` };
        }
        // Nothing here can advance it. That is about this milestone, not the task: the caller
        // moves on to the next one rather than treating this as the end of the run.
        return { action: "next_milestone", milestoneStuck: true,
                 reasoning: `Nothing on this page carries out "${milestone.title}"` };
      }
      if (kind === "scroll") {
        if (progress.scrolled) return doneStep("Scrolled");
        return { action: "scroll_page", value: 600, reasoning: "Scroll down to reveal more content", milestoneDone: true };
      }
      if (kind === "fill") {
        const step = fillStep();
        if (step) return step;
        return doneStep("Every field that could be filled has been");
      }
      if (kind === "confirm") return doneStep("Nothing to confirm on this page");
      return { action: "next_milestone", milestoneStuck: true,
               reasoning: `No rule could advance "${milestone.title}" on this page` };
    }

    // ── No plan: the classic rules. ────────────────────────────────────────────────────

    // 1. Get to the right site before anything else.
    if (parsed.siteUrl && !alreadyOnSite(url, parsed.siteUrl) && !progress.navigated) {
      return { action: "navigate", value: parsed.siteUrl, reasoning: `Open ${parsed.site}` };
    }

    // 2. Run the search, once.
    if (parsed.query && !progress.searched) {
      const box = first(isSearchBox) || first((m) => FILLABLE_ROLES.has(m.role));
      if (box) return { action: "type", mark_id: box.id, value: parsed.query, reasoning: `Search for "${parsed.query}"` };
    }

    // 3. Open something the user explicitly named. Only an explicit instruction justifies a
    //    click — matching any task word against any link label is what made the agent wander.
    for (const target of parsed.openTargets) {
      if ((progress.opened || []).includes(target)) continue;

      if (/^(?:the\s+)?(?:first|top|1st)\b/.test(target)) {
        const link = first((m) => m.role === "link" && m.label && m.label.length > 8);
        if (link) return { action: "click", mark_id: link.id, openTarget: target, reasoning: `Open the first result: ${link.label}` };
        continue;
      }
      const hit = first((m) => clickable(m) && (m.role === "link" || m.role === "button" || m.role === "clickable") && labelMatches(target, m.label));
      if (hit) return { action: "click", mark_id: hit.id, openTarget: target, reasoning: `Open "${hit.label}"` };
    }

    // 4. Fill a form from the local vault.
    if (parsed.wantsFill) {
      const step = fillStep();
      if (step) return step;
      const anyText = first((m) => FILLABLE_ROLES.has(m.role) && !isSearchBox(m));
      if (anyText) return { action: "type", mark_id: anyText.id, use_vault_field: "name", reasoning: "Fill the next text field" };
    }

    // 5. Scroll, but only while there is more page below and only once per request.
    if (parsed.wantsScroll && !progress.scrolled) {
      const info = state.pageInfo || {};
      const remaining = (info.page_height || 0) - (info.scroll_y || 0) - (info.viewport_height || 0);
      if (!info.page_height || remaining > 50) {
        return { action: "scroll_page", value: 600, reasoning: "Scroll down to reveal more content" };
      }
    }

    // 6. Nothing left that the instruction actually asked for.
    return { action: "done", reasoning: describeCompletion(parsed, progress) };
  }

  function describeCompletion(parsed, progress) {
    const bits = [];
    if (progress.navigated && parsed.site) bits.push(`opened ${parsed.site}`);
    if (progress.searched && parsed.query) bits.push(`searched for "${parsed.query}"`);
    if ((progress.opened || []).length) bits.push(`opened ${progress.opened.length} item(s)`);
    if (progress.scrolled) bits.push("scrolled the page");
    return bits.length ? `Task complete — ${bits.join(", ")}.` : "Nothing further to do for this task.";
  }

  const TaskPlanner = {
    parseTask, decomposeTask, normalizePlan, planNextAction, alreadyOnSite, siteUrlFor,
    vaultKeyForLabel, labelMatches, pickBestItem, currentMilestone, planComplete,
    KNOWN_SITES, SYNONYMS,
  };

  global.TaskPlanner = TaskPlanner;
  if (typeof module !== "undefined" && module.exports) module.exports = TaskPlanner;
})(typeof globalThis !== "undefined" ? globalThis : this);

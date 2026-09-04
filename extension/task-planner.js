/**
 * task-planner.js — Understands the user's instruction, and decides the next action when no
 * cloud planner is available.
 *
 * This is the on-device fallback. It runs whenever the planning server is unreachable or
 * errors, which in practice is often — so it has to be genuinely useful, not a stub.
 *
 * Two responsibilities:
 *
 *   parseTask(text)   Turn a sentence into structure: which site, what to search for, what to
 *                     open afterwards, whether to scroll or fill a form. Crucially it strips
 *                     conversational tails, so "search for iqoo neo 6 and show me" searches for
 *                     "iqoo neo 6" and not for "iqoo neo 6 and show me".
 *
 *   planNextAction()  Pick ONE next action, or decide the task is finished. It stops as soon as
 *                     the instruction has been carried out. It will not click a link merely
 *                     because a word from the task appears in the link's text — that behaviour
 *                     made the agent wander a results page indefinitely.
 *
 * Loaded by the service worker (importScripts) and exported for Node so the parser can be unit
 * tested without a browser: `node eval/test-task-planner.js`.
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
  };

  // Conversational tail: "... and show me", "... then tell me the results", "... please".
  // These describe what the user wants to SEE, not what to type into a search box.
  const TAIL_RE = /\s*(?:,|\band\b|\bthen\b)?\s*(?:please\s+)?(?:can\s+you\s+)?(?:show|display|tell|give|list|find)\s+(?:me|us|it)?\s*(?:the\s+)?(?:results?|details?|options?|list|prices?|it)?\s*[.!]?\s*$/i;

  // A follow-up clause that is a separate instruction, not part of the query.
  const CLAUSE_SPLIT_RE = /\s+(?:and|then|,)\s+(?:also\s+)?(?=open|click|select|scroll|show|tell|display|go|buy|add|book|play|read|check)/i;

  const LEAD_RE = /^\s*(?:hey|hi|ok|okay|please|can you|could you|would you|i want to|i want you to|i need to|help me|let's|lets)\s+/i;

  // Trailing politeness and punctuation, stripped after the tail clause.
  const POLITE_TAIL_RE = /[\s,.!]*\b(?:please|thanks|thank you|pls|plz)\b[\s,.!]*$/i;

  const SEARCH_RE = /\b(?:search|look)\s+(?:for\s+|up\s+)?(.+)$/i;
  const SITE_RE = /\b(?:open|go\s+to|goto|visit|navigate\s+to|launch|browse)\s+(.+?)(?=\s+(?:and|then|,)\s+|$)/i;
  const OPEN_TARGET_RE = /\b(?:open|click|select|choose|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)(?=\s+(?:and|then|,)\s+|$)/i;

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

  /**
   * Turns an instruction into structure.
   * @returns {{raw, site, siteUrl, query, openTargets, wantsScroll, wantsFill, wantsSearch}}
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
      wantsFill: /\b(fill|register|sign\s*up|signup|form|apply|checkout|enter my details)\b/i.test(text),
      wantsBook: /\b(book|booking|reserve|reservation|order|buy|purchase|ticket|flight|hotel|cab|train|bus|ride)\b/i.test(text),
      wantsSearch: false,
      // Extracted travel/booking parameters
      category: null,
      from: null,
      to: null,
      date: null,
      passengers: null,
      travelClass: null,
      tripType: null, // "one-way", "round-trip"
    };

    const isTravel = result.wantsBook ||
      /\b(flights?|flying|fly|airline|airlines?|airways?|airport|airports?|hotels?|homestays?|villas?|resorts?|rooms?|lodging|trains?|rail|irctc|buses?|bus|volvo|cabs?|taxi|car rental|makemytrip|goibibo|cleartrip)\b/i.test(text);

    if (isTravel) {
      if (/\b(hotels?|homestays?|villas?|resorts?|rooms?|lodging)\b/i.test(text)) result.category = "hotels";
      else if (/\b(trains?|rail|irctc)\b/i.test(text)) result.category = "trains";
      else if (/\b(buses?|bus|volvo)\b/i.test(text)) result.category = "buses";
      else if (/\b(cabs?|taxi|car rental)\b/i.test(text)) result.category = "cabs";
      else result.category = "flights";

      // Extract travel parameters: "from X to Y", "to Y from X", or "X to Y flights"
      const fromToMatch = text.match(/\bfrom\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)/i);
      const toFromMatch = text.match(/\bto\s+([a-zA-Z\s]+?)\s+from\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)/i);
      const bareToMatch = text.match(/\b(?:flights?|tickets?|cabs?|bus|trains?)\s+(?:from\s+)?([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,)|$)/i) ||
                          text.match(/\b([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)\s+(?:flights?|tickets?|cabs?|bus|trains?)\b/i);

      if (fromToMatch) {
        result.from = fromToMatch[1].trim();
        result.to = fromToMatch[2].trim();
      } else if (toFromMatch) {
        result.to = toFromMatch[1].trim();
        result.from = toFromMatch[2].trim();
      } else if (bareToMatch) {
        result.from = bareToMatch[1].trim();
        result.to = bareToMatch[2].trim();
      } else {
        const singleTo = text.match(/\bto\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)/i);
        const singleFrom = text.match(/\bfrom\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)/i);
        if (singleTo) result.to = singleTo[1].trim();
        if (singleFrom) result.from = singleFrom[1].trim();
      }

      // Clean leading articles / trailing keywords from extracted cities
      for (const key of ["from", "to"]) {
        if (result[key]) {
          result[key] = result[key]
            .replace(/^(?:the|a|an)\s+/i, "")
            .replace(/\s+(?:flights?|tickets?|cabs?|bus|trains?|hotels?)$/i, "")
            .trim();
        }
      }
    }

    // Messaging / Chat task detection:
    // e.g. "send hi to niswan", "message niswan saying hi", "send a message to niswan"
    const msgMatch = text.match(/\b(?:send|message|msg|text|dm)\s+(?:a\s+message\s+(?:saying\s+|that\s+)?|message\s+)?['"]?([^'"]+?)['"]?\s+to\s+([a-zA-Z0-9_\s]+?)(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i) ||
                     text.match(/\b(?:to\s+([a-zA-Z0-9_\s]+?)\s+(?:send|message|msg|text)\s+['"]?([^'"]+?)['"]?)(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);

    if (msgMatch) {
      result.wantsMessage = true;
      result.message = msgMatch[1].trim();
      result.recipient = msgMatch[2].trim();
    } else if (/\b(send|message|msg|text|chat)\b/i.test(text) && /\bto\s+([a-zA-Z0-9_\s]+)/i.test(text)) {
      const rec = text.match(/\bto\s+([a-zA-Z0-9_\s]+?)(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);
      if (rec) {
        result.wantsMessage = true;
        result.recipient = rec[1].trim();
      }
    }

    // Date: "on 15 jan", "on 2025-01-15", "tomorrow", "next monday"
    const dateMatch = text.match(/\bon\s+([\w\s,]+?)(?:\s+(?:for|with|and|,|$))/i) ||
                      text.match(/\b(tomorrow|today|next\s+\w+|\d{1,2}[\s/-]\w+[\s/-]?\d{0,4})\b/i);
    if (dateMatch) result.date = dateMatch[1].trim();

    // Passengers: "for 2", "2 passengers", "2 adults"
    const passMatch = text.match(/\bfor\s+(\d+)\b|\b(\d+)\s+(?:passenger|adult|person|people|travell?er)/i);
    if (passMatch) result.passengers = parseInt(passMatch[1] || passMatch[2]);

    // Travel class
    if (/\bbusiness\b/i.test(text)) result.travelClass = "business";
    else if (/\bfirst\s*class\b/i.test(text)) result.travelClass = "first";
    else if (/\beconomy\b/i.test(text)) result.travelClass = "economy";

    // Trip type
    if (/\bround\s*trip\b|\breturn\b/i.test(text)) result.tripType = "round-trip";
    else if (/\bone\s*way\b/i.test(text)) result.tripType = "one-way";

    // 1. Site to open first
    const siteMatch = text.match(SITE_RE);
    if (siteMatch) {
      const candidate = stripQuotes(siteMatch[1]);
      const looksLikeSite = !/\b(result|link|item|product|tab|menu|first|second|third|top)\b/i.test(candidate);
      const url = looksLikeSite ? siteUrlFor(candidate) : null;
      if (url) {
        result.site = candidate.toLowerCase();
        result.siteUrl = url;
        text = (text.slice(0, siteMatch.index) + " " + text.slice(siteMatch.index + siteMatch[0].length)).trim();
        text = text.replace(/^\s*(?:and|then|,)\s+/i, "").trim();
      }
    }

    // 2. Search query
    const searchMatch = text.match(SEARCH_RE);
    if (searchMatch) {
      result.wantsSearch = true;
      let q = searchMatch[1];
      q = q.split(CLAUSE_SPLIT_RE)[0];
      q = q.replace(TAIL_RE, "");
      q = q.replace(POLITE_TAIL_RE, "");
      q = stripQuotes(q).replace(/\s+/g, " ").trim();
      q = q.replace(/[\s,;:.\-]+$/, "").trim();
      if (q && !/^(?:me|it|this|that|results?|them)$/i.test(q)) result.query = q;
    }

    // 3. Explicit open targets
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
    "input:text", "input:email", "input:tel", "input:password", "textarea", "editable", "input:search", "combobox", "select",
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

  /**
   * Chooses the next action, or returns `done`.
   *
   * @param {Object} state
   * @param {string} state.task            the user's raw instruction
   * @param {Array}  state.marks           safe marks from the latest scan
   * @param {Array}  state.filledIds       marks already acted on
   * @param {Object} state.pageInfo        { url, title, page_height, scroll_y, viewport_height }
   * @param {Object} state.progress        { searched, navigated, opened: [], scrolled }
   * @returns {{action, mark_id?, value?, use_vault_field?, reasoning}}
   */
  function planNextAction(state) {
    const parsed = state.parsed || parseTask(state.task);
    const marks = state.marks || [];
    const done = new Set((state.filledIds || []).map(String));
    const progress = state.progress || {};
    const url = (state.pageInfo && state.pageInfo.url) || "";

    const available = marks.filter((m) => !done.has(String(m.id)));
    const first = (pred) => available.find(pred) || null;

    // 1. Navigate to the target site first.
    if (parsed.siteUrl && !alreadyOnSite(url, parsed.siteUrl) && !progress.navigated) {
      return { action: "navigate", value: parsed.siteUrl, reasoning: `Open ${parsed.site}` };
    }

    // 2. Booking/travel flow — deterministic city-picker sequence.
    //    The model cannot reliably handle autocomplete pickers, so we drive this ourselves.
    if (parsed.wantsBook && (parsed.from || parsed.to)) {
      const bookPlan = planBookingStep(parsed, available, done, progress);
      if (bookPlan) return bookPlan;
    }

    // 2b. Messaging / Chat flow (WhatsApp, Telegram, Slack, etc.)
    const isMsgPlatform = /web\.whatsapp\.com|telegram|slack/i.test(url || "");
    if (parsed.wantsMessage || isMsgPlatform) {
      // Step 0: Recovery if stuck in calls or dialpad screen (e.g. on WhatsApp Web)
      const isDialpadScreen = available.some((m) =>
        /enter a phone number|phone number|voice and video calling|go to calls/i.test(m.label || "")
      );
      if (isDialpadScreen) {
        const backBtn = first((m) => /^\s*(back|<|←)\s*$/i.test(m.label || "") && (m.role === "button" || m.role === "clickable"));
        if (backBtn) {
          return { action: "click", mark_id: backBtn.id, reasoning: "Click Back to exit phone dialpad and return to chats" };
        }
        const chatsTab = first((m) => /^\s*chats?\b/i.test(m.label || "") && (m.role === "button" || m.role === "clickable" || m.role === "tab"));
        if (chatsTab) {
          return { action: "click", mark_id: chatsTab.id, reasoning: "Switch back to Chats tab" };
        }
      }

      // Step A: If the real Send button is visible, click it to send the message!
      // Must NOT match attachments like "Send document", "Send photo", etc.
      const isRealSendBtn = (m) => {
        const l = (m.label || "").trim().toLowerCase();
        if (/\b(document|photo|video|contact|location|file|media|audio|voice|call)\b/i.test(l)) return false;
        return /^\s*send(\s+message)?\s*$/i.test(l) || (l === "send" && (m.role === "button" || m.role === "clickable"));
      };
      const sendBtn = first(isRealSendBtn);
      if (sendBtn) {
        return { action: "click", mark_id: sendBtn.id, reasoning: "Click Send to send the message" };
      }

      // Step B: If in chat and message box is available, type message
      const msgBox = first((m) =>
        m.role === "editable" ||
        /type a message/i.test(m.label || "") ||
        (FILLABLE_ROLES.has(m.role) && /message/i.test(m.label || ""))
      );
      if (msgBox && parsed.message && !progress.messageTyped) {
        return { action: "type", mark_id: msgBox.id, value: parsed.message, reasoning: `Type "${parsed.message}" into message box` };
      }

      // Step C: If recipient is specified and not yet opened, click contact or use search
      if (parsed.recipient && !progress.contactOpened) {
        const contact = first((m) => {
          const l = (m.label || "").toLowerCase();
          return l.includes(parsed.recipient.toLowerCase()) && (m.role === "clickable" || m.role === "button" || m.role === "link");
        });
        if (contact) {
          return { action: "click", mark_id: contact.id, reasoning: `Open chat with ${parsed.recipient}` };
        }
        const searchChat = first((m) => /search or start a new chat/i.test(m.label || "") || /search\s*(contacts|chats)/i.test(m.label || "") || isSearchBox(m));
        if (searchChat) {
          return { action: "type", mark_id: searchChat.id, value: parsed.recipient, reasoning: `Search for contact "${parsed.recipient}"` };
        }
      }
    }

    // 3. Run the search, once.
    if (parsed.query && !progress.searched) {
      const box = first(isSearchBox) || first((m) => FILLABLE_ROLES.has(m.role));
      if (box) {
        return { action: "type", mark_id: box.id, value: parsed.query, reasoning: `Search for "${parsed.query}"` };
      }
    }

    // 4. Open something the user explicitly named.
    for (const target of parsed.openTargets) {
      if ((progress.opened || []).includes(target)) continue;
      if (/^(?:the\s+)?(?:first|top|1st)\b/.test(target)) {
        const link = first((m) => m.role === "link" && m.label && m.label.length > 8);
        if (link) return { action: "click", mark_id: link.id, openTarget: target, reasoning: `Open the first result: ${link.label}` };
        continue;
      }
      const words = target.split(/\s+/).filter((w) => w.length >= 3);
      const hit = first((m) => {
        const label = (m.label || "").toLowerCase();
        if (!label || (m.role !== "link" && m.role !== "button" && m.role !== "clickable")) return false;
        return label.includes(target) || (words.length > 0 && words.every((w) => label.includes(w)));
      });
      if (hit) return { action: "click", mark_id: hit.id, openTarget: target, reasoning: `Open "${hit.label}"` };
    }

    // 5. Fill a form from the local vault.
    if (parsed.wantsFill) {
      for (const m of available) {
        if (!FILLABLE_ROLES.has(m.role) || isSearchBox(m)) continue;
        const label = (m.label || "").toLowerCase();
        if (!label) continue;
        for (const [pattern, key] of FIELD_LABEL_RULES) {
          if (pattern.test(label)) {
            return { action: "type", mark_id: m.id, use_vault_field: key, reasoning: `Fill "${label}" from vault (${key})` };
          }
        }
      }
      const anyText = first((m) => FILLABLE_ROLES.has(m.role) && !isSearchBox(m));
      if (anyText) return { action: "type", mark_id: anyText.id, use_vault_field: "name", reasoning: "Fill the next text field" };
    }

    // 6. Scroll.
    if (parsed.wantsScroll && !progress.scrolled) {
      const info = state.pageInfo || {};
      const remaining = (info.page_height || 0) - (info.scroll_y || 0) - (info.viewport_height || 0);
      if (!info.page_height || remaining > 50) {
        return { action: "scroll_page", value: 600, reasoning: "Scroll down to reveal more content" };
      }
    }

    return { action: "done", reasoning: describeCompletion(parsed, progress) };
  }

  /**
   * Deterministic step planner for travel booking flows.
   *
   * MakeMyTrip / Goibibo / Cleartrip all follow the same pattern:
   *   1. Click the "Flights" tab if not already there
   *   2. Click the From/Origin field → type city → click first suggestion
   *   3. Click the To/Destination field → type city → click first suggestion
   *   4. Click the Search button
   *
   * The model cannot reliably sequence this because each step changes the DOM
   * (suggestion dropdowns appear/disappear). We track progress via bookingStep
   * in the progress object.
   */
  function planBookingStep(parsed, available, done, progress) {
    const step = progress.bookingStep || 0;
    const norm = (s) => (s || "").toLowerCase();

    // Label matchers for common travel site field names
    const isFromField = (m) => /\b(from|origin|source|departure|departing|flying from|from city)\b/i.test(m.label || "");
    const isToField = (m) => /\b(to|destination|arrival|arriving|flying to|to city)\b/i.test(m.label || "");
    const isSearchBtn = (m) => /\b(search|find|search flights|search buses|search trains|get flights)\b/i.test(m.label || "") &&
                               (m.role === "button" || m.role === "clickable" || m.role === "input:submit");
    const isFlightsTab = (m) => /\bflights?\b/i.test(m.label || "") && !/\b(hotels?|packages?|homestays?)\b/i.test(m.label || "") && (m.role === "link" || m.role === "button" || m.role === "clickable");
    const isSuggestion = (m) => !/\b(hotels?|homestays?|villas?|resorts?)\b/i.test(m.label || "") &&
                                 (/\b(suggestion|option|result|item|listitem)\b/i.test(m.role || "") ||
                                  (m.role === "link" && (m.label || "").length > 2 && (m.label || "").length < 60));

    // Step 0: Ensure we are on the flights page
    const currentUrl = progress.currentUrl || "";
    const isWrongTravelPage = /\/(hotels|cabs|activities|tours|railways|trains|bus-tickets|buses|holidays|homestays)/i.test(currentUrl);
    if (isWrongTravelPage) {
      return { action: "navigate", value: "https://www.makemytrip.com/flights/", reasoning: "Navigate back to Flights section" };
    }
    if (step === 0) {
      const flightsTab = available.find(isFlightsTab);
      if (flightsTab && !/\/flights/i.test(currentUrl)) {
        progress.bookingStep = 1;
        return { action: "click", mark_id: flightsTab.id, reasoning: "Click Flights tab to ensure we are in Flights section" };
      }
      progress.bookingStep = 1;
    }

    // Helper to find the best suggestion for a given city name
    function pickCitySuggestion(cityName) {
      if (!cityName) return null;
      const rawTarget = norm(cityName);
      const target = rawTarget.split(" ")[0];

      const isCandidate = (m) => {
        if (!isSuggestion(m)) return false;
        const txt = norm(m.label);
        if (target === "goa" && !rawTarget.includes("genoa") && !rawTarget.includes("italy")) {
          if (txt.includes("genoa") || txt.includes("italy")) return false;
        }
        if (target === "mumbai" && !rawTarget.includes("navi") && txt.includes("navi mumbai")) return false;
        return true;
      };

      const candidates = available.filter(isCandidate);
      if (!candidates.length) return null;

      const score = (m) => {
        const txt = norm(m.label);
        let s = 0;
        if (target === "goa") {
          if (txt.includes("dabolim") || txt.includes("goi") || txt.includes("mopa") || txt.includes("gox")) s += 200;
          if (txt.includes("goa") && txt.includes("india")) s += 150;
        }
        if (txt.includes("india")) s += 50;
        if (txt.includes(target)) s += 30;
        return s;
      };

      candidates.sort((a, b) => score(b) - score(a));
      return candidates[0];
    }

    // Step 1: Type origin city into From field
    if (step <= 1 && parsed.from && !progress.fromTyped) {
      // First check if a suggestion dropdown is open from a previous type
      const suggestion = pickCitySuggestion(parsed.from);
      if (suggestion) {
        progress.fromTyped = true;
        progress.bookingStep = 2;
        return { action: "click", mark_id: suggestion.id, reasoning: `Select origin: ${parsed.from}` };
      }
      const fromField = available.find(isFromField) ||
                        available.find((m) => FILLABLE_ROLES.has(m.role) && !isSearchBox(m));
      if (fromField) {
        return { action: "type", mark_id: fromField.id, value: parsed.from, reasoning: `Type origin city: ${parsed.from}` };
      }
    }

    // Step 2: Click origin suggestion
    if (step <= 2 && parsed.from && !progress.fromTyped) {
      const suggestion = pickCitySuggestion(parsed.from) || available.find((m) => {
        const txt = norm(m.label);
        if (norm(parsed.from) === "goa" && (txt.includes("genoa") || txt.includes("italy"))) return false;
        return isSuggestion(m);
      });
      if (suggestion) {
        progress.fromTyped = true;
        progress.bookingStep = 3;
        return { action: "click", mark_id: suggestion.id, reasoning: `Select origin city suggestion` };
      }
      progress.bookingStep = 3;
    }

    // Step 3: Type destination city into To field
    if (!progress.toTyped && parsed.to) {
      const suggestion = pickCitySuggestion(parsed.to);
      if (suggestion) {
        progress.toTyped = true;
        progress.bookingStep = 4;
        return { action: "click", mark_id: suggestion.id, reasoning: `Select destination: ${parsed.to}` };
      }
      const toField = available.find(isToField) ||
                      available.find((m) => FILLABLE_ROLES.has(m.role) && !isSearchBox(m) && !done.has(String(m.id)));
      if (toField) {
        return { action: "type", mark_id: toField.id, value: parsed.to, reasoning: `Type destination city: ${parsed.to}` };
      }
    }

    // Step 4: Click destination suggestion
    if (!progress.toTyped) {
      const suggestion = pickCitySuggestion(parsed.to) || available.find((m) => {
        const txt = norm(m.label);
        if (norm(parsed.to) === "goa" && (txt.includes("genoa") || txt.includes("italy"))) return false;
        return isSuggestion(m);
      });
      if (suggestion) {
        progress.toTyped = true;
        progress.bookingStep = 5;
        return { action: "click", mark_id: suggestion.id, reasoning: `Select destination city suggestion` };
      }
    }

    // Step 5: Click Search button
    if (progress.fromTyped && progress.toTyped) {
      const searchBtn = available.find(isSearchBtn);
      if (searchBtn) {
        progress.bookingStep = 6;
        return { action: "click", mark_id: searchBtn.id, reasoning: "Click Search to find flights" };
      }
    }

    return null; // fall through to model
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
    parseTask, planNextAction, alreadyOnSite, siteUrlFor, vaultKeyForLabel, KNOWN_SITES,
  };

  global.TaskPlanner = TaskPlanner;
  if (typeof module !== "undefined" && module.exports) module.exports = TaskPlanner;
})(typeof globalThis !== "undefined" ? globalThis : this);

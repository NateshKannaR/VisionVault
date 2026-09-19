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
  const TAIL_RE = /\s*(?:,|\band\b|\bthen\b)?\s*(?:please\s+)?(?:can\s+you\s+)?(?:show|display|tell|give|list|find|see)\s+(?:me|us|it)?\s*(?:the\s+)?(?:results?|details?|options?|list|prices?|it|best(?:\s+among\s+them)?)?\s*[.!]?\s*$/i;

  // A follow-up clause that is a separate instruction, not part of the query.
  const CLAUSE_SPLIT_RE = /\s+(?:and|then|,)\s+(?:also\s+)?(?=open|click|select|scroll|show|tell|display|go|buy|add|book|play|read|check|see|view|pick|choose|filter|sort|find|get|checkout|put|apply|set|use|refine|star|fork|clone|compare|save|analy[sz]e|review|evaluate|summari[sz]e|list|submit|confirm|raise|write|tick|enter|fill|note|report)/i;

  const LEAD_RE = /^\s*(?:hey|hi|ok|okay|please|can you|could you|would you|i want to|i want you to|i need to|help me|let's|lets)\s+/i;

  // Trailing politeness and punctuation, stripped after the tail clause.
  const POLITE_TAIL_RE = /[\s,.!]*\b(?:please|thanks|thank you|pls|plz)\b[\s,.!]*$/i;

  const SEARCH_VERB = "search|seach|serach|searh|sarch|seaarch|serch|look|find|locate|lookup";
  const SEARCH_RE = new RegExp("\\b(?:" + SEARCH_VERB + ")\\s+(?:for\\s+|up\\s+)?(.+)$", "i");
  const SITE_RE = new RegExp(
    "\\b(?:open|go\\s+to|goto|visit|navigate\\s+to|launch|browse)\\s+(.+?)" +
    "(?=\\s+(?:and|then|,)\\s+|\\s+(?:" + SEARCH_VERB + ")\\b|$)", "i");
  const OPEN_TARGET_RE = /\b(?:open|click|select|choose|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)(?=\s+(?:and|then|,)\s+|$)/i;

  const NON_SITE_WORDS = new Set([
    "logs", "log", "history", "settings", "overview", "profile", "comms", "details",
    "summary", "cart", "checkout", "form", "tab", "page", "section", "menu", "first",
    "second", "third", "result", "top", "link", "button", "item", "product", "next",
    "previous", "back", "home", "dashboard", "console", "data", "orbital", "satellite",
    "input", "field", "account", "signup", "login", "register", "more", "telemetry"
  ]);

  function stripQuotes(s) {
    return String(s || "").replace(/^["'`“‘]+|["'`”’]+$/g, "").trim();
  }

  function siteUrlFor(name) {
    const rawName = String(name || "").toLowerCase().trim();
    const key = rawName.replace(/\.(com|in|org|net|co\.in)$/, "");
    if (NON_SITE_WORDS.has(key) || NON_SITE_WORDS.has(rawName)) return null;
    if (KNOWN_SITES[key]) return KNOWN_SITES[key];

    // A bare domain the user typed, e.g. "open example.co.uk"
    if (/^[a-z0-9-]+(\.[a-z]{2,})+$/i.test(name)) return `https://${name}`;

    if (/^[a-z0-9-]{2,30}$/i.test(key)) return `https://www.${key}.com`;
    return null;
  }

  /**
   * Turns an instruction into structure.
   * @returns {{raw, site, siteUrl, query, openTargets, wantsScroll, wantsFill, wantsSearch, wantsShop, wantsAddToCart, maxPrice, minPrice, minRating, wantsBest, wantsCheapest}}
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
      wantsFill: /\b(fill|register|sign\s*up|signup|login|log\s*in|sign\s*in|signin|authenticate|credentials|form|checkout|enter my details|apply\s+(?:for|job|loan|form|membership|card|visa)|load\s+(?:the\s+)?details|take\s+(?:the\s+)?details|populate|transfer\s+details|load\s+into)\b/i.test(text),
      wantsBook: /\b(book|booking|reserve|reservation|order|buy|purchase|tickets?|flights?|hotels?|cabs?|trains?|buses|bus|rides?|flying|stay|stays)\b/i.test(text),
      wantsSearch: false,
      wantsShop: false,
      wantsFilter: /\b(filter|filters?|narrow|refine|sort)\b/i.test(text),
      wantsAddToCart: false,
      maxPrice: null,
      minPrice: null,
      minRating: null,
      wantsBest: false,
      wantsCheapest: false,
      // GitHub intents
      wantsStar: false,
      wantsFork: false,
      wantsIssue: false,
      wantsPR: false,
      wantsClone: false,
      wantsNewRepo: false,
      repoName: null,
      repoDesc: null,
      wantsReadme: false,
      wantsPrivate: false,
      // Extracted travel/booking parameters
      category: null,
      from: null,
      to: null,
      date: null,
      passengers: null,
      travelClass: null,
      tripType: null, // "one-way", "round-trip"
      wantsNonStop: false,
      // Sorting
      wantsSort: false,
      sort: null,
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
            .replace(/\s+(?:flights?|tickets?|cabs?|bus|trains?|hotels?|non[\s-]*stop|direct)$/i, "")
            .trim();
        }
      }
    }

    // The word "flights" is not by itself a request to book anything. "search for flights to
    // goa" is an ordinary search; "flights from chennai to goa" is a route, and only a route
    // (or an explicit booking verb, or a date) means the multi-field booking form is what the
    // user wants. Recognising travel NOUNS as booking sent plain searches down the booking
    // flow, where the planner clicks form controls instead of typing a query.
    const explicitBooking = /\b(book|booking|reserve|reservation|purchase|place\s+(?:an?\s+)?order)\b/i.test(text);
    const hasRoute = !!(result.from && result.to);
    if (result.wantsBook && !explicitBooking && !hasRoute && !result.date) {
      result.wantsBook = false;
    }


    // Messaging / Chat task detection:
    // e.g. "open whatsapp and send hi message to niswan", "message niswan saying hi", "send a message to niswan"
    const m1 = text.match(/\b(?:send|post)\s+(?:a\s+)?messages?\s+to\s+([a-zA-Z0-9_\s]+?)\s+(?:saying|with|that)\s+['"]?([^'"]+?)['"]?(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);
    const m2 = text.match(/\b(?:message|text|dm|tell)\s+([a-zA-Z0-9_\s]+?)\s+(?:saying|with|that)\s+['"]?([^'"]+?)['"]?(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);
    const m3 = text.match(/\b(?:send|message|msg|text|dm)\s+['"]?([^'"]+?)['"]?\s+(?:message\s+)?to\s+([a-zA-Z0-9_\s]+?)(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);
    const m4 = text.match(/\bto\s+([a-zA-Z0-9_\s]+?)\s+(?:send|message|msg|text)\s+['"]?([^'"]+?)['"]?(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);

    if (m1) {
      result.wantsMessage = true;
      result.recipient = m1[1].trim();
      result.message = m1[2].trim();
    } else if (m2) {
      result.wantsMessage = true;
      result.recipient = m2[1].trim();
      result.message = m2[2].trim();
    } else if (m3) {
      result.wantsMessage = true;
      let msg = m3[1].replace(/^(?:a\s+)?messages?\s+(?:saying\s+|that\s+)?/i, "").replace(/\s+messages?$/i, "").trim();
      result.message = msg || "hi";
      result.recipient = m3[2].trim();
    } else if (m4) {
      result.wantsMessage = true;
      result.recipient = m4[1].trim();
      result.message = m4[2].trim();
    } else if (text.match(/\b(?:whatsapp|message|text|dm)\s+([a-zA-Z0-9_]+)\s+['"]?([^'"]+?)['"]?(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i)) {
      const mDirect = text.match(/\b(?:whatsapp|message|text|dm)\s+([a-zA-Z0-9_]+)\s+['"]?([^'"]+?)['"]?(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);
      result.wantsMessage = true;
      result.recipient = mDirect[1].trim();
      result.message = mDirect[2].trim();
    } else if (/\b(send|message|msg|text|chat)\b/i.test(text) && /\bto\s+([a-zA-Z0-9_\s]+)/i.test(text)) {
      const rec = text.match(/\bto\s+([a-zA-Z0-9_\s]+?)(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);
      if (rec) {
        result.wantsMessage = true;
        result.recipient = rec[1].trim();
        result.message = "hi";
      }
    } else {
      const m5 = text.match(/\b(?:send|post|type|message|msg)\s+['"]?([^'"]+?)['"]?(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram|teams)|$)/i);
      if (m5 && (result.site === "whatsapp" || /whatsapp|slack|telegram/i.test(text))) {
        result.wantsMessage = true;
        result.message = m5[1].replace(/\s+(?:message|msg)$/i, "").trim();
        result.recipient = null;
      }
    }

    if (result.wantsMessage) {
      result.query = null;
      result.wantsSearch = false;
    }

    // E-commerce & Shopping task detection:
    const cartKeywords = /\b(add\s+to\s+cart|add\s+to\s+basket|buy\s+now|add\s+it\s+to\s+cart|put\s+(?:it\s+)?in\s+(?:the\s+)?cart)\b/i;
    result.wantsAddToCart = cartKeywords.test(text);

    const priceUnderMatch = text.match(/\b(?:under|below|less\s+than|max(?:imum)?|cheaper\s+than|within|up\s+to)\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:[\d,]*)?(?:\.\d+)?)\s*([kKlL])?\b/i);
    const priceOverMatch = text.match(/\b(?:above|over|more\s+than|min(?:imum)?|at\s+least)\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:[\d,]*)?(?:\.\d+)?)\s*([kKlL])?\b/i);
    // "60k" and "1.5L" are how prices get written in practice. Without the multiplier the
    // number parsed as sixty rupees, and the stray suffix stayed glued to the product name -
    // measured, "search best laptop under 60k" put "laptopk" in the search box.
    const scaleOf = (suffix) => (/^[kK]$/.test(suffix || "") ? 1000 : /^[lL]$/.test(suffix || "") ? 100000 : 1);
    if (priceUnderMatch) {
      result.maxPrice = Math.round(parseFloat(priceUnderMatch[1].replace(/,/g, "")) * scaleOf(priceUnderMatch[2]));
    }
    if (priceOverMatch) result.minPrice = parseInt(priceOverMatch[1].replace(/,/g, ""), 10);

    const ratingMatch = text.match(/\b(?:rating\s*(?:of|above|over|at\s*least|min(?:imum)?|\>=?)?\s*|rated\s+)?([1-5](?:\.\d+)?)\s*(?:stars?|\+|\s*and\s*above|\s*or\s*more|\s*rating)\b/i) ||
                        text.match(/\b(?:with\s+)?rating\s+([1-5](?:\.\d+)?)\b/i);
    if (ratingMatch) result.minRating = parseFloat(ratingMatch[1]);

    result.wantsBest = /\b(best|top\s*rated|highest\s*rated|top\s*pick|top\s*one)\b/i.test(text);
    result.wantsCheapest = /\b(cheapest|lowest\s*price|most\s*affordable)\b/i.test(text);

    // Date: only check if travel or explicit month keywords are present
    if (isTravel || /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text)) {
      const dateMatch = text.match(/\bon\s+([\w\s,]+?)(?:\s+(?:for|with|and|,|$))/i) ||
                        text.match(/\b(tomorrow|today|next\s+\w+|\d{1,2}[\s/-]\w+[\s/-]?\d{0,4})\b/i);
      if (dateMatch) result.date = dateMatch[1].trim();
    }

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

    if (/\b(non[\s-]*stop|direct\s*flights?|direct)\b/i.test(text)) {
      result.wantsNonStop = true;
      result.wantsFilter = true;
    }

    // Sorting detection:
    if (/\b(low\s+to\s+high|cheapest\s+first|price\s*:\s*low|price\s+low)\b/i.test(text)) {
      result.wantsSort = true;
      result.sort = "price_asc";
      result.wantsFilter = true;
    } else if (/\b(high\s+to\s+low|expensive\s+first|price\s*:\s*high|price\s+high)\b/i.test(text)) {
      result.wantsSort = true;
      result.sort = "price_desc";
      result.wantsFilter = true;
    } else if (/\b(customer\s*ratings?|highest\s*rated|top\s*rated)\b/i.test(text)) {
      result.wantsSort = true;
      result.sort = "rating";
      result.wantsFilter = true;
    } else if (/\b(popularity|most\s*popular|bestselling)\b/i.test(text)) {
      result.wantsSort = true;
      result.sort = "popularity";
      result.wantsFilter = true;
    } else if (/\b(newest|latest)\b/i.test(text)) {
      result.wantsSort = true;
      result.sort = "newest";
      result.wantsFilter = true;
    }

    // 1. Site to open first
    const siteMatch = text.match(SITE_RE);
    if (siteMatch) {
      const candidate = stripQuotes(siteMatch[1]);
      const looksLikeSite = !/\b(result|link|item|product|tab|menu|first|second|third|top)\b/i.test(candidate);
      const onSiteInner = candidate.match(/^(.+?)\s+(?:on|in|at)\s+([a-z0-9-]+)$/i);
      let siteName = candidate;
      let targetPrefix = null;
      if (onSiteInner && KNOWN_SITES[onSiteInner[2].toLowerCase()]) {
        targetPrefix = onSiteInner[1].trim();
        siteName = onSiteInner[2].toLowerCase();
      }

      const url = looksLikeSite ? siteUrlFor(siteName) : null;
      if (url) {
        result.site = siteName.toLowerCase();
        result.siteUrl = url;
        if (targetPrefix && !result.query) {
          result.query = targetPrefix;
        }
        text = (text.slice(0, siteMatch.index) + " " + text.slice(siteMatch.index + siteMatch[0].length)).trim();
        text = text.replace(/^\s*(?:and|then|,)\s+/i, "").trim();
      }
    }

    if (!result.site) {
      const onSiteMatch = text.match(/\b(?:on|in|at)\s+(github|amazon|flipkart|makemytrip|whatsapp|youtube|wikipedia)\b/i);
      if (onSiteMatch) {
        const candidate = onSiteMatch[1].toLowerCase();
        result.site = candidate;
        result.siteUrl = siteUrlFor(candidate);
      }
    }

    // GitHub intent detection:
    const wantsNewRepo = /\b(?:create|make|add|new|init|initialize)\s+(?:a\s+)?(?:new\s+)?repo(?:sitory)?\b/i.test(text) ||
                         /\brepo(?:sitory)?\s+creation\b/i.test(text);
    const isGitHub = (result.site && /github/i.test(result.site)) || /\bgithub\b/i.test(text) || wantsNewRepo;
    if (isGitHub || /\b(star\s+(?:the\s+)?(?:repo|repository|it)|stargaze)\b/i.test(text) || wantsNewRepo) {
      result.wantsStar = /\b(star|stargaze)\b/i.test(text) && !/\b([1-5]\s*stars?|star\s*rating)\b/i.test(text);
      result.wantsFork = /\bfork\b/i.test(text);
      result.wantsIssue = /\b(issues?|bug\s*report)\b/i.test(text);
      result.wantsPR = /\b(pull\s*requests?|prs?)\b/i.test(text);
      result.wantsClone = /\b(clone|copy\s*url|git\s*clone)\b/i.test(text);
      result.wantsNewRepo = wantsNewRepo;

      if (wantsNewRepo) {
        if (!result.site) {
          result.site = "github";
        }
        result.siteUrl = "https://github.com/new";

        // Extract repository name if specified: e.g. named my-app, named my cool-project, called test-repo
        const nameMatch = text.match(/\b(?:named|called|with\s+(?:the\s+)?name)\s+["']?([a-zA-Z0-9_\-\.\s]+?)["']?(?=\s+(?:with|on|in|at|and|then)\b|\s*$)/i) ||
                          text.match(/\b(?:create|make|new|add)\s+(?:a\s+)?(?:new\s+)?repo(?:sitory)?\s+(?:for\s+)?["']?([a-zA-Z0-9_\-\.]+)["']?/i);
        const REPO_STOPWORDS = new Set(["a", "an", "the", "new", "on", "in", "at", "with", "and", "then", "named", "called", "repo", "repository", "for", "using", "it", "to", "github"]);
        if (nameMatch) {
          const cleanName = nameMatch[1].trim().replace(/\s+/g, "-");
          if (cleanName && !REPO_STOPWORDS.has(cleanName.toLowerCase())) {
            result.repoName = cleanName;
          } else {
            result.repoName = null;
          }
        } else {
          result.repoName = null;
        }

        result.wantsReadme = /\b(?:with\s+(?:a\s+)?readme|add\s+(?:a\s+)?readme)\b/i.test(text);
        result.wantsPrivate = /\b(?:private|secret)\b/i.test(text);

        const descMatch = text.match(/\b(?:with\s+description|description)\s+["']([^"']+)["']/i);
        if (descMatch) result.repoDesc = descMatch[1].trim();

        result.query = null;
        result.wantsSearch = false;
      }
    }

    const ecomSite = (result.site && /amazon|flipkart|myntra|ebay|meesho|walmart|target|bestbuy/i.test(result.site)) ||
                     /amazon|flipkart|myntra|ebay/i.test(text);
    if (ecomSite || result.wantsAddToCart || result.maxPrice || result.minRating || result.wantsBest || result.wantsCheapest) {
      result.wantsShop = true;
    }

    // 2. Search query
    const searchMatch = text.match(SEARCH_RE);
    if (searchMatch) {
      result.wantsSearch = true;
      let q = searchMatch[1];
      q = q.split(CLAUSE_SPLIT_RE)[0];
      q = q.replace(TAIL_RE, "");
      q = q.replace(POLITE_TAIL_RE, "");
      if (result.wantsShop || result.wantsFilter || result.wantsStar || result.wantsFork || result.wantsClone || result.wantsIssue || result.wantsPR) {
        q = q.replace(/\s*(?:and\s+)?(?:also\s+)?(?:apply|set|put|use)?\s*(?:a\s+)?(?:filters?|refine)\s+(?:from|for|by|on|with|to)?\s*(?:the\s+)?(?:price)?\b.*/gi, "");
        q = q.replace(/\s*(?:and\s+)?(?:also\s+)?sort\s+(?:by\s+)?(?:the\s+)?\b.*/gi, "");
        q = q.replace(/\s*(?:and\s+)?(?:also\s+)?(?:star|fork|clone)\s+(?:the\s+)?(?:repo|repository|it)?\b.*/gi, "");
        q = q.replace(/\s*(?:and\s+)?(?:also\s+)?(?:open|view|see)\s+(?:the\s+)?(?:issues?|pull\s*requests?|prs?)\b.*/gi, "");
        q = q.replace(/\s*\b(?:from|with)?\s*price\s+(?:under|below|less\s+than|cheaper\s+than|within|up\s+to|above|over|more\s+than)\b.*/gi, "");
        q = q.replace(/\s*\b(?:from\s+)?price\b.*/gi, "");
        q = q.replace(/\s*\b(?:under|below|less\s+than|cheaper\s+than|within|up\s+to|above|over|more\s+than)\s*(?:rs\.?|inr|₹|\$)?\s*\d+(?:[\d,]*)?(?:\.\d+)?(?:\s*[kKlL])?/gi, "");
        q = q.replace(/\s*\b(?:with\s+)?(?:rating\s*(?:of|above|over|at\s*least|min|\>=)?\s*|rated\s+)[1-5](?:\.\d+)?\s*(?:stars?|\+|\s*and\s*above|\s*rating)?/gi, "");
        q = q.replace(/\s*\b[1-5](?:\.\d+)?\s*stars?\b/gi, "");
        q = q.replace(/\s*\b(?:and\s+)?(?:see|view|pick|choose|find)\s+(?:the\s+)?(?:best|top|cheapest)(?:\s+(?:one|item|product|among\s+them)?)?/gi, "");
      }
      q = stripQuotes(q).replace(/\s+/g, " ").trim();
      q = q.replace(/[\s,;:.\-]+$/, "").trim();
      // "find the best laptop" should search for a laptop. The superlative is already
      // captured in wantsBest/wantsCheapest and steers the CHOICE among results; leaving it in
      // the query narrows the search itself, which is not what the user meant. Stripped only
      // when something remains, so "find the cheapest" alone still searches for what it says.
      if (q && (result.wantsBest || result.wantsCheapest)) {
        const stripped = q.replace(/^(?:the\s+)?(?:best|cheapest|top[- ]?rated|highest[- ]?rated|top)\s+/i, "").trim();
        if (stripped.length >= 2) q = stripped;
      }
      // A search box takes a noun phrase, not a sentence.
      //
      // A long natural instruction defeats clause splitting - there is always one more way to
      // join two thoughts - and what survived was the rest of the paragraph. Measured on
      // seven-step instructions: "React roles, narrow the list to 5 - 8 years experience..."
      // and "the transaction history for \"MG Road\", set Category to..." went into the search
      // box whole. Cutting at the first comma and capping the length costs nothing on a real
      // query, which is two or three words, and rescues every one of those.
      if (q) {
        q = q.split(/\s*[,;]\s*/)[0].trim();
        const words = q.split(/\s+/);
        if (words.length > 8) q = words.slice(0, 8).join(" ");
        q = q.replace(/\s+(?:and|then|or|with|for|to|from|by|in|on)$/i, "").trim();
      }
      if (q && !/^(?:me|it|this|that|results?|them)$/i.test(q)) result.query = q;
    }

    // If no explicit search query found on GitHub, check for repository/target extraction
    if (!result.query && !result.wantsNewRepo && (isGitHub || result.site === "github")) {
      const repoMatch = text.match(/\b(?:star|fork|clone|open|repo|repository)\s+([a-zA-Z0-9_\-\.\/]+)(?:\s+(?:on|in|at)\s+github|$)/i);
      if (repoMatch && !/^(the|a|an|it|this|that|repo|repository)$/i.test(repoMatch[1])) {
        result.query = repoMatch[1].trim();
      }
    }

    // Travel booking route queries are not standard text queries
    if (result.wantsBook && (result.from && result.to)) {
      result.query = null;
      result.wantsSearch = false;
    }
    if (result.wantsNewRepo) {
      result.query = null;
      result.wantsSearch = false;
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

    // Extract on-page navigation targets (e.g., "go to logs", "into logs", "open history", "switch to telemetry")
    const onPageTargetMatch = text.match(/\b(?:into|to|go\s+to|open|visit|switch\s+to|navigate\s+to)\s+(logs?|history|settings|overview|profile|comms?|telemetry|dashboard)\b/i);
    if (onPageTargetMatch && !result.openTargets.includes(onPageTargetMatch[1].toLowerCase())) {
      result.openTargets.push(onPageTargetMatch[1].toLowerCase());
    }

    // Extract form navigation / fill targets (e.g. "fill form 2", "fill the form fill form 2", "click that form 2 and fill that form", "open form 2")
    const formNumMatch = text.match(/\bform\s*(\d+)\b/i);
    const formSlugMatch = text.match(/\bform\s*-\s*([a-z0-9_-]+)\b/i);
    const formNamedMatch = text.match(/\b(payroll|hr|mission\s*systems?|it\b|housing|medical)\b/i);

    if (formNumMatch) {
      const fTarget = `form ${formNumMatch[1]}`;
      if (!result.openTargets.includes(fTarget)) result.openTargets.push(fTarget);
      result.wantsFill = true;
    } else if (formSlugMatch) {
      const fTarget = `form-${formSlugMatch[1].toLowerCase()}`;
      if (!result.openTargets.includes(fTarget)) result.openTargets.push(fTarget);
      result.wantsFill = true;
    } else if (formNamedMatch && /\b(fill|form|click|open|switch)\b/i.test(text)) {
      const fTarget = formNamedMatch[1].toLowerCase();
      if (!result.openTargets.includes(fTarget)) result.openTargets.push(fTarget);
      result.wantsFill = true;
    } else if (/\bfill\s+(?:the\s+)?(?:form|details|fields|values)\b/i.test(text) || /\b(fill|autofill)\b/i.test(text)) {
      result.wantsFill = true;
    }

    if (/\b(?:store|save)\s+(?:the\s+)?(?:values?|details?|fields?|data)\s+(?:in|to|into)\s+(?:the\s+)?vault\b/i.test(text) ||
        /\b(?:store|save)\s+(?:to|in|into)\s+(?:the\s+)?vault\b/i.test(text)) {
      result.wantsStoreVault = true;
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
    "input", "input:text", "input:email", "input:tel", "input:password", "textarea", "editable", "input:search", "combobox", "select",
  ]);

  const FIELD_LABEL_RULES = [
    // satellite & orbital telemetry (matched FIRST so specific terms are never shadowed by generic words)
    [/satellite[\s_-]*name|satellite|sat[\s_-]*name/, "satellite_name"],
    [/mission[\s_-]*id|mission/, "mission_id"],
    [/operator[\s_-]*on[\s_-]*duty|operator[\s_-]*name|\boperator\b|\bduty\b/, "operator"],
    [/launch[\s_-]*date|\blaunch\b/, "launch_date"],
    [/orbit[\s_-]*type|\borbit\b/, "orbit_type"],
    [/orbital[\s_-]*inclination|\binclination\b/, "orbital_inclination"],
    [/\bapogee\b/, "apogee"],
    [/\bperigee\b/, "perigee"],
    [/tle[\s_-]*line[\s_-]*1|\btle[\s_-]*1\b|\btle1\b/, "tle_line_1"],
    [/tle[\s_-]*line[\s_-]*2|\btle[\s_-]*2\b|\btle2\b/, "tle_line_2"],
    [/ground[\s_-]*station[\s_-]*freq(uency)?|ground[\s_-]*station|ground[\s_-]*frequency|\bfreq(uency)?\b/, "ground_station_freq"],
    [/encryption[\s_-]*key[\s_-]*ref(erence)?|encryption[\s_-]*key|\bencryption\b|key[\s_-]*ref/, "encryption_key_ref"],

    // professional, financial & extended form fields
    [/occupation|job[\s_-]*title|\bjob\b|profession|designation|profession[\s_-]*type|\bwork\b/, "occupation"],
    [/annual[\s_-]*income|income|salary|annual[\s_-]*salary|ctc|earnings|net[\s_-]*income/, "annual_income"],
    [/marital[\s_-]*status|marital/, "marital_status"],
    [/gender|\bsex\b/, "gender"],
    [/father[\s_-]*name|father/, "father_name"],
    [/mother[\s_-]*name|mother/, "mother_name"],
    [/qualification|degree|education/, "qualification"],
    [/nationality|citizenship/, "nationality"],
    [/dob|date[\s_-]*of[\s_-]*birth|birth[\s_-]*date/, "dob"],

    // identity & contact (matched next for general forms, registrations, profiles)
    [/user[\s_-]*name|username|user[\s_-]*id|handle|login[\s_-]*id|login|sign[\s_-]*in|roll[\s_-]*no|roll[\s_-]*number|registration[\s_-]*no|reg[\s_-]*no|student[\s_-]*id|staff[\s_-]*id|admission[\s_-]*no|member[\s_-]*id|account[\s_-]*id|user\b/, "username"],
    [/e-?mail|email[\s_-]*address/, "email"],
    [/\b(phone|mobile|cell|contact[\s_-]*number)\b|\btel(ephone)?\b/, "phone"],
    [/password|passcode|pwd|\bpin\b(?![\s_-]*code)/, "password"],
    [/pin[\s_-]*code|pincode|postal[\s_-]*code|\bzip\b|\bpostal\b/, "zip"],
    [/\bcity\b|\btown\b/, "city"],
    [/\bstate\b|\bprovince\b|\bregion\b/, "state"],
    [/\bcountry\b|\bnation\b/, "country"],
    [/postcode|post[\s_-]*code|street[\s_-]*address|address[\s_-]*line|\baddress\b|\bstreet\b/, "address"],
    [/company|organisation|organization|employer|institution|college|university|school/, "company"],
    [/\b(about|bio|biography|description|notes|comment|comments|cover[\s_-]*letter)\b/i, "about"],
    [/first[\s_-]*name|given[\s_-]*name/, "first_name"],
    [/last[\s_-]*name|family[\s_-]*name|surname/, "last_name"],
    [/full[\s_-]*name|\bname\b/, "name"],
  ];

  // Fields that hold a personal identifier the vault has no equivalent for. Typing a phone
  // number into one because "phone" was the closest available key is worse than not filling
  // it: the value is wrong, it is personal, and it goes into a field that may validate it.
  // These are asked about instead.
  const UNKNOWN_IDENTIFIER_RE =
    /aadhaar|aadhar|\bpan\b|passport|licence|license|voter|ssn|social security|nino|national insurance|tax id|gst|ifsc|upi|account number|card number|cvv|otp\b/i;

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
   * Generates a single-pass compound batch of actions to fill all fields on the current screen.
   */
  function planBatchFormFill(state) {
    const parsed = state.parsed || parseTask(state.task || "");
    const marks = state.marks || [];
    const filled = new Set((state.filledIds || []).map(Number));
    const available = marks.filter((m) => !filled.has(Number(m.id)));
    const fillable = available.filter((m) => FILLABLE_ROLES.has(m.role) && !isSearchBox(m));

    if (fillable.length === 0) return null;

    const batchActions = [];
    for (const m of fillable) {
      let key = m.vaultKey || null;
      if (!key) {
        if (m.role === "input:password") key = "password";
        else if (m.role === "input:email") key = "email";
        else if (m.role === "input:tel") key = "phone";
      }

      if (!key && m.label) {
        const label = m.label.toLowerCase();
        for (const [pattern, ruleKey] of FIELD_LABEL_RULES) {
          if (pattern.test(label)) {
            key = ruleKey;
            break;
          }
        }
      }

      if (!key) {
        const fromLabel = vaultKeyForLabel(m.label);
        key = fromLabel.key || null;
      }

      if (!key && m.label) {
        key = m.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
      }

      if (key) {
        batchActions.push({
          action: "type",
          type: "type",
          mark_id: m.id,
          target: m.id,
          use_vault_field: key,
          reasoning: `Fill "${m.label || key}" from vault (${key})`
        });
      }
    }

    const submitBtn = available.find((m) =>
      (m.role === "button" || m.role === "clickable" || m.role === "input:submit") &&
      /^\s*(sign\s*in|log\s*in|submit|continue|next|register|save|save\s+changes|save\s+mission\s+payroll|create\s*account|submit\s+log\s+entry|submit\s+update|confirm\s+allotment|save\s+details)\b/i.test(m.label || "")
    );
    if (submitBtn && batchActions.length > 0) {
      batchActions.push({
        action: "click",
        type: "click",
        mark_id: submitBtn.id,
        target: submitBtn.id,
        reasoning: `Submit form (${submitBtn.label || 'Submit'})`
      });
    }

    if (batchActions.length >= 2) {
      return {
        action: "batch",
        type: "batch",
        actions: batchActions,
        reasoning: `Batch filling ${batchActions.length} fields from vault in one pass`
      };
    }
    return null;
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
    const available = marks.filter((m) => !done.has(String(m.id)));
    const progress = state.progress || {};
    const url = state.pageInfo?.url || "";

    const first = (pred) => available.find(pred) || null;

    // 0. Store to Vault flow
    if (parsed.wantsStoreVault) {
      if (progress.vaultStored) {
        return { action: "done", reasoning: "Values stored to vault successfully." };
      }
      return { action: "store_vault", reasoning: "Read page data and store into encrypted local vault." };
    }

    // 1. Initial navigation if on the wrong site.
    if (parsed.siteUrl && !progress.navigated && !alreadyOnSite(url, parsed.siteUrl)) {
      return { action: "navigate", value: parsed.siteUrl, reasoning: `Open ${parsed.site}` };
    }

    // 2. Booking/travel flow — deterministic city-picker sequence.
    if (parsed.wantsBook && (parsed.from || parsed.to)) {
      const bookPlan = planBookingStep(parsed, available, done, progress, state.pageInfo);
      if (bookPlan) return bookPlan;
    }

    // 2b. Messaging / Chat flow (WhatsApp, Telegram, Slack, etc.)
    const isMsgPlatform = /web\.whatsapp\.com|telegram|slack/i.test(url || "");
    if (parsed.wantsMessage || isMsgPlatform) {
      // 1. Recover from dialpad / calls screen if present
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

      // 2. Real Send button (when visible and message has been typed or send is active)
      const isRealSendBtn = (m) => {
        const l = (m.label || "").trim().toLowerCase();
        if (/\b(document|photo|video|contact|location|file|media|audio|voice|call)\b/i.test(l)) return false;
        return /\bsend\b/i.test(l) || l.includes("compose-btn-send") || (l === "send" && (m.role === "button" || m.role === "clickable"));
      };
      const sendBtn = first(isRealSendBtn);

      if (progress.messageSent) {
        return { action: "done", reasoning: "WhatsApp message sent successfully" };
      }

      if (sendBtn && (progress.messageTyped || !parsed.recipient || !available.some(m => isSearchBox(m)))) {
        return { action: "click", mark_id: sendBtn.id, reasoning: "Click Send to send the message" };
      }

      // Message typing box (Type a message / Chat input)
      const isMsgBox = (m) => {
        const l = (m.label || "").toLowerCase();
        if (/search|find|filter/i.test(l)) return false;
        return /type a message|type a msg|\bmessage\b|chat input|write a message/i.test(l) ||
               (m.role === "editable" && !/search/i.test(l));
      };
      const msgBox = first(isMsgBox);

      if (progress.messageTyped) {
        if (sendBtn) {
          return { action: "click", mark_id: sendBtn.id, reasoning: "Click Send to send the message" };
        }
        const targetId = (msgBox && msgBox.id) || progress.lastTypedMarkId || (available.find(m => m.role === "editable")?.id) || 1;
        return { action: "press_key", mark_id: targetId, key: "Enter", value: "Enter", reasoning: "Press Enter to send the message" };
      }

      // 3. Open or Search for Recipient Contact first (if specified and not yet opened)
      const pageTitle = (state.pageInfo?.title || "").toLowerCase();
      const isContactActive = parsed.recipient && (pageTitle.includes(parsed.recipient.toLowerCase()) || available.some(m => (m.label || "").toLowerCase() === parsed.recipient.toLowerCase() && m.role === "heading"));

      if (parsed.recipient && !progress.contactOpened && !isContactActive) {
        const contact = first((m) => {
          const l = (m.label || "").toLowerCase();
          return l.includes(parsed.recipient.toLowerCase()) && (m.role === "clickable" || m.role === "button" || m.role === "link");
        });
        if (contact) {
          return { action: "click", mark_id: contact.id, reasoning: `Open chat with ${parsed.recipient}` };
        }
        const searchChat = first((m) =>
          /search or start a new chat|search or start new chat|search\s*(contacts|chats)/i.test(m.label || "") ||
          (isSearchBox(m) && !/type a message/i.test(m.label || ""))
        );
        if (searchChat && !progress.contactSearched) {
          return { action: "type", mark_id: searchChat.id, value: parsed.recipient, reasoning: `Search for contact "${parsed.recipient}"` };
        }
      }

      // 4. Type message into composer
      if (msgBox && parsed.message && !progress.messageTyped) {
        progress.lastTypedMarkId = msgBox.id;
        return { action: "type", mark_id: msgBox.id, value: parsed.message, reasoning: `Type "${parsed.message}" into message box` };
      }

      // 5. Click Send button if present after typing
      if (sendBtn) {
        return { action: "click", mark_id: sendBtn.id, reasoning: "Click Send to send the message" };
      }
    }

    // 2c. GitHub flow
    const isGitHubSite = (parsed.site && /github/i.test(parsed.site)) || /github\.com/i.test(url || "");
    if (isGitHubSite || parsed.wantsStar || parsed.wantsFork || parsed.wantsIssue || parsed.wantsPR || parsed.wantsClone || parsed.wantsNewRepo) {
      const gitPlan = planGitHubStep(parsed, available, done, progress, state.pageInfo);
      if (gitPlan) return gitPlan;
    }

    // 2d. YouTube flow
    const isYouTubeSite = (parsed.site && /youtube/i.test(parsed.site)) || /youtube\.com/i.test(url || "");
    if (isYouTubeSite) {
      const ytPlan = planYouTubeStep(parsed, available, done, progress, state.pageInfo);
      if (ytPlan) return ytPlan;
    }

    // 2e. Shopping / E-commerce flow
    if (parsed.wantsShop || parsed.wantsAddToCart || isShoppingSite(url)) {
      const shopPlan = planShoppingStep(parsed, available, done, progress, state.pageInfo);
      if (shopPlan) return shopPlan;
    }

    // 3. Search query
    if (parsed.query && !progress.searched) {
      const box = first(isSearchBox) || first((m) => FILLABLE_ROLES.has(m.role));
      if (box) {
        return { action: "type", mark_id: box.id, value: parsed.query, reasoning: `Search for "${parsed.query}"` };
      }
    }

    // 4. Explicit follow-up target clicks
    const FORM_TARGET_ALIASES = {
      "form 1": ["form 1", "form1", "form-hr", "personal", "hr"],
      "form 2": ["form 2", "form2", "form-payroll", "payroll", "banking", "salary", "isro mission payroll"],
      "form 3": ["form 3", "form3", "form-it", "asset", "access", "itam", "mission systems"],
      "form 4": ["form 4", "form4", "form-housing", "housing", "quarters", "allotment", "staff quarters"],
      "form 5": ["form 5", "form5", "form-medical", "medical", "insurance", "dependents", "health & welfare", "health and welfare"],
    };

    for (const target of parsed.openTargets) {
      if ((progress.opened || []).includes(target)) continue;
      if (/^(?:the\s+)?(?:first|top|1st)\b/.test(target)) {
        const link = first((m) => m.role === "link" && m.label && m.label.length > 8);
        if (link) return { action: "click", mark_id: link.id, openTarget: target, reasoning: `Open the first result: ${link.label}` };
        continue;
      }

      const formAliases = FORM_TARGET_ALIASES[target] || [target];
      let hit = first((m) => {
        const label = (m.label || "").toLowerCase();
        if (!label || (m.role !== "link" && m.role !== "button" && m.role !== "clickable")) return false;
        return formAliases.some((alias) => label.includes(alias));
      });

      if (!hit) {
        const targetDigits = (target.match(/\b\d+\b/g) || []);
        const words = target.split(/\s+/).filter((w) => w.length >= 2 || /\d/.test(w));
        hit = first((m) => {
          const label = (m.label || "").toLowerCase();
          if (!label || (m.role !== "link" && m.role !== "button" && m.role !== "clickable")) return false;
          if (targetDigits.length > 0 && !targetDigits.every((d) => label.includes(d))) return false;
          return label.includes(target) || (words.length > 0 && words.every((w) => label.includes(w)));
        });
      }

      if (hit) return { action: "click", mark_id: hit.id, openTarget: target, reasoning: `Open "${hit.label}"` };
    }

    // 5. Fill a form from the local vault.
  if (parsed.wantsFill) {
    if (state.allowBatch) {
      const batchPlan = planBatchFormFill(state);
      if (batchPlan) return batchPlan;
    }
      // Pass 0: Explicit mark.vaultKey (directly tagged from data-vault-key)
      for (const m of available) {
        if (!FILLABLE_ROLES.has(m.role) || isSearchBox(m)) continue;
        if (m.vaultKey) {
          return { action: "type", mark_id: m.id, use_vault_field: m.vaultKey, reasoning: `Fill "${m.label || m.vaultKey}" from vault (${m.vaultKey})` };
        }
      }

      // Pass A: Type specific input roles (password, email, tel)
      for (const m of available) {
        if (!FILLABLE_ROLES.has(m.role) || isSearchBox(m)) continue;
        if (m.role === "input:password") {
          return { action: "type", mark_id: m.id, use_vault_field: "password", reasoning: "Fill password from vault" };
        }
        if (m.role === "input:email") {
          return { action: "type", mark_id: m.id, use_vault_field: "email", reasoning: "Fill email from vault" };
        }
        if (m.role === "input:tel") {
          return { action: "type", mark_id: m.id, use_vault_field: "phone", reasoning: "Fill phone from vault" };
        }
      }

      // Pass B: Matched label rules
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

      // Pass C: Contextual fallback for remaining text fields
      const anyText = first((m) => FILLABLE_ROLES.has(m.role) && !isSearchBox(m));
      if (anyText) {
        const fromLabel = vaultKeyForLabel(anyText.label);
        const isTelemetryContext = /satellite|satops|telemetry|orbit|ground\s*station/i.test((state.task || "") + " " + (url || ""));
        const hasPasswordOnPage = available.some((m) => m.role === "input:password" || /password/i.test(m.label || ""));
        let defaultKey = "name";
        if (hasPasswordOnPage) {
          defaultKey = "username";
        } else if (isTelemetryContext) {
          defaultKey = "satellite_name";
        }
        const rawCleanLabel = anyText.label ? anyText.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) : "";
        const key = fromLabel.key || rawCleanLabel || defaultKey;
        return { action: "type", mark_id: anyText.id, use_vault_field: key, reasoning: `Fill "${anyText.label || 'field'}" from vault (${key})` };
      }

      // Pass D: If all inputs are filled, click submit/sign-in button if present
      const submitBtn = first((m) =>
        (m.role === "button" || m.role === "clickable" || m.role === "input:submit") &&
        /^\s*(sign\s*in|log\s*in|submit|continue|next|register|save|save\s+changes|save\s+mission\s+payroll|create\s*account|submit\s+log\s+entry|submit\s+update|confirm\s+allotment|save\s+details)\b/i.test(m.label || "")
      );
      if (submitBtn && (parsed.wantsFill || /\b(login|sign\s*in|submit)\b/i.test(state.task || ""))) {
        return { action: "click", mark_id: submitBtn.id, reasoning: `Click ${submitBtn.label || 'Submit'} button` };
      }
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
  function planBookingStep(parsed, available, done, progress, pageInfo) {
    const step = progress.bookingStep || 0;
    const norm = (s) => (s || "").toLowerCase();

    // Label matchers for common travel site field names
    const isFromField = (m) => /\b(from|origin|source|departure|departing|flying from|from city)\b/i.test(m.label || "");
    const isToField = (m) => /\b(to|destination|arrival|arriving|flying to|to city)\b/i.test(m.label || "");
    const isSearchBtn = (m) => /\b(search|find|search flights|search buses|search trains|get flights)\b/i.test(m.label || "") &&
                               (m.role === "button" || m.role === "clickable" || m.role === "input:submit" || m.role === "link");
    const isFlightsTab = (m) => /\bflights?\b/i.test(m.label || "") && !/\b(hotels?|packages?|homestays?)\b/i.test(m.label || "") && (m.role === "link" || m.role === "button" || m.role === "clickable");
    const isSuggestion = (m) => !/\b(hotels?|homestays?|villas?|resorts?)\b/i.test(m.label || "") &&
                                 (/\b(suggestion|option|result|item|listitem)\b/i.test(m.role || "") ||
                                  (m.role === "link" && (m.label || "").length > 2 && (m.label || "").length < 60));

    // Step 0: Ensure we are on the flights page
    const currentUrl = (pageInfo && pageInfo.url) || progress.currentUrl || "";
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
        progress.bookingStep = 3;
        return { action: "click", mark_id: suggestion.id, reasoning: `Select origin city suggestion` };
      }
      progress.bookingStep = 3;
    }

    // Step 3: Type destination city into To field
    if (!progress.toTyped && parsed.to) {
      const suggestion = pickCitySuggestion(parsed.to);
      if (suggestion) {
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
        progress.bookingStep = 5;
        return { action: "click", mark_id: suggestion.id, reasoning: `Select destination city suggestion` };
      }
    }

    // Step 5: Click Search button
    if (progress.fromTyped && progress.toTyped && step <= 5) {
      const searchBtn = available.find(isSearchBtn);
      if (searchBtn) {
        progress.bookingStep = 6;
        return { action: "click", mark_id: searchBtn.id, isBookingSearch: true, reasoning: "Click Search to find flights" };
      }
    }

    // Step 6: On search results page, if wantsNonStop or wantsCheapest, apply filter
    if (progress.bookingStep >= 6 || /flight-review|flight\/review|flight\/search|flight-list/i.test(currentUrl)) {
      if (parsed.wantsNonStop && !progress.nonStopFiltered) {
        const nonStopFilter = available.find(m => {
          const l = (m.label || "").toLowerCase();
          return (m.role === "checkbox" || m.role === "clickable" || m.role === "button" || m.role === "link") &&
                 /\b(non[\s-]*stop|0\s*stops?|direct)\b/i.test(l);
        });
        if (nonStopFilter) {
          return { action: "click", mark_id: nonStopFilter.id, isNonStop: true, reasoning: "Filter for non-stop flights" };
        }
      }
      if (progress.bookingStep >= 6 && (!parsed.openTargets || parsed.openTargets.length === 0)) {
        return { action: "done", reasoning: "Flight search completed" + (progress.nonStopFiltered ? " with non-stop filter applied" : "") };
      }
    }

    return null; // fall through to model
  }

  /**
   * Deterministic step planner for GitHub workflows.
   *
   * Supports:
   *   - Search repository or code
   *   - Open repository from search results
   *   - Star repository (with detection of already-starred state)
   *   - Fork repository
   *   - Switch to Issues tab
   *   - Switch to Pull requests tab
   *   - Open Code / clone options
   */
  function planGitHubStep(parsed, available, done, progress, pageInfo) {
    const url = (pageInfo && pageInfo.url) || "";
    const isRepoPage = /github\.com\/[^\/]+\/[^\/]+/i.test(url) &&
                       !/github\.com\/(search|explore|topics|trending|settings|login|signup|features|pricing|organizations|notifications)(?:\/|$)/i.test(url);
    const isSearchPage = /github\.com\/search/i.test(url);

    // 0. Completed conditions
    if (parsed.wantsNewRepo && progress.repoCreated) {
      return { action: "done", reasoning: `Repository "${parsed.repoName || "new repository"}" created successfully.` };
    }
    if (parsed.wantsNewRepo && (progress.createClicked || progress.repoNameTyped) && isRepoPage && !/\/new(?:\/|$)/i.test(url)) {
      progress.repoCreated = true;
      return { action: "done", reasoning: `Repository "${parsed.repoName || "new repository"}" created successfully.` };
    }
    if (parsed.wantsNewRepo && /github\.com\/login/i.test(url)) {
      return {
        action: "done",
        reasoning: "GitHub requires you to sign in before creating a repository. Please sign in to your GitHub account and try again."
      };
    }
    if (parsed.wantsStar && progress.starred) {
      return { action: "done", reasoning: "Repository starred successfully." };
    }
    if (parsed.wantsFork && progress.forked) {
      return { action: "done", reasoning: "Repository forked successfully." };
    }
    if (parsed.wantsIssue && progress.issueOpened) {
      return { action: "done", reasoning: "Issues tab opened successfully." };
    }
    if (parsed.wantsPR && progress.prOpened) {
      return { action: "done", reasoning: "Pull requests tab opened successfully." };
    }
    if (parsed.wantsClone && progress.cloned) {
      return { action: "done", reasoning: "Clone options opened successfully." };
    }
    if (progress.repoOpened && !parsed.wantsStar && !parsed.wantsFork && !parsed.wantsIssue && !parsed.wantsPR && !parsed.wantsClone && (!parsed.openTargets || parsed.openTargets.length === 0)) {
      return { action: "done", reasoning: "Repository opened successfully." };
    }

    // 0b. Create New Repository flow
    if (parsed.wantsNewRepo) {
      const isNewPage = /github\.com\/(?:repositories\/new|new)(?:$|[?#])/i.test(url);
      if (!isNewPage) {
        const newBtn = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          return (m.role === "button" || m.role === "link" || m.role === "clickable") &&
                 (/^\s*new\b/i.test(l) || /new\s+repository/i.test(l) || /create\s+(?:a\s+)?(?:new\s+)?repository/i.test(l));
        });
        if (newBtn && !progress.newClicked) {
          progress.newClicked = true;
          return { action: "click", mark_id: newBtn.id, reasoning: "Click 'New' button to create a new repository" };
        }
        return { action: "navigate", value: "https://github.com/new", reasoning: "Navigate to GitHub New Repository page" };
      }

      // On https://github.com/new:
      // Substep A: Type repository name
      if (!progress.repoNameTyped) {
        const nameToUse = parsed.repoName || ("repo-" + Math.floor(1000 + Math.random() * 9000));
        const repoInput = available.find(m => {
          if (!FILLABLE_ROLES.has(m.role)) return false;
          const l = (m.label || "").toLowerCase();
          if (/search/i.test(l)) return false;
          return /repository\s*name|repo\s*name|name\s*your\s*new|name\s*\*|\brepo\b/i.test(l);
        }) || available.find(m => {
          if (!FILLABLE_ROLES.has(m.role) || isSearchBox(m)) return false;
          const l = (m.label || "").toLowerCase();
          return !/description|readme/i.test(l);
        });

        if (repoInput) {
          return {
            action: "type",
            mark_id: repoInput.id,
            value: nameToUse,
            isRepoName: true,
            reasoning: `Type repository name "${nameToUse}"`
          };
        }
      }

      // Substep B: Optional description
      if (parsed.repoDesc && !progress.repoDescTyped) {
        const descInput = available.find(m => {
          if (!FILLABLE_ROLES.has(m.role)) return false;
          return /description/i.test((m.label || "").toLowerCase());
        });
        if (descInput) {
          progress.repoDescTyped = true;
          return { action: "type", mark_id: descInput.id, value: parsed.repoDesc, reasoning: "Type repository description" };
        }
      }

      // Substep C: Optional private
      if (parsed.wantsPrivate && !progress.privateSelected) {
        const privateOpt = available.find(m => {
          const l = (m.label || "").toLowerCase();
          return (m.role === "radio" || m.role === "clickable" || m.role === "button") && /\bprivate\b/i.test(l);
        });
        if (privateOpt) {
          progress.privateSelected = true;
          return { action: "click", mark_id: privateOpt.id, reasoning: "Select Private repository" };
        }
      }

      // Substep D: Optional README
      if (parsed.wantsReadme && !progress.readmeChecked) {
        const readmeCb = available.find(m => {
          const l = (m.label || "").toLowerCase();
          return (m.role === "checkbox" || m.role === "clickable") && /\breadme\b/i.test(l);
        });
        if (readmeCb) {
          progress.readmeChecked = true;
          return { action: "click", mark_id: readmeCb.id, reasoning: "Check 'Add a README file'" };
        }
      }

      // Substep E: Click "Create repository" button
      if (progress.repoNameTyped) {
        const createBtn = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          return (m.role === "button" || m.role === "clickable" || m.role === "input:submit") &&
                 (/create\s+repository/i.test(l) || /create\s+(?:a\s+)?new\s+repository/i.test(l) || /^\s*create\s+repo\b/i.test(l));
        });
        if (createBtn) {
          progress.createClicked = true;
          return { action: "click", mark_id: createBtn.id, isCreateRepo: true, reasoning: "Click 'Create repository' button" };
        }

        if ((progress.createScrolls || 0) < 3) {
          progress.createScrolls = (progress.createScrolls || 0) + 1;
          return { action: "scroll_page", value: 500, reasoning: "Scroll down to locate 'Create repository' button" };
        }
      }
    }

    // 1. Actions on Repository Page
    if (isRepoPage || progress.repoOpened) {
      // Star action
      if (parsed.wantsStar && !progress.starred) {
        const alreadyStarred = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          return (m.role === "button" || m.role === "clickable") && /\b(unstar|starred)\b/i.test(l);
        });
        if (alreadyStarred) {
          progress.starred = true;
          return { action: "done", reasoning: "Repository is already starred." };
        }

        const starBtn = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          if (m.role !== "button" && m.role !== "clickable") return false;
          if (/\b(unstar|starred|stargazers?|starring|history)\b/i.test(l)) return false;
          return /^\s*star\b/i.test(l) || /star this repository/i.test(l) || l === "star";
        });
        if (starBtn) {
          return { action: "click", mark_id: starBtn.id, isStar: true, reasoning: "Click Star button to star this repository" };
        }
      }

      // Fork action
      if (parsed.wantsFork && !progress.forked) {
        const forkBtn = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          return (m.role === "button" || m.role === "clickable" || m.role === "link") &&
                 (/\bfork\b/i.test(l) && !/\bforks\b/i.test(l));
        });
        if (forkBtn) {
          return { action: "click", mark_id: forkBtn.id, isFork: true, reasoning: "Click Fork button to fork repository" };
        }
      }

      // Issues tab
      if (parsed.wantsIssue && !progress.issueOpened) {
        if (/\/issues/i.test(url)) {
          progress.issueOpened = true;
          return { action: "done", reasoning: "On Issues page." };
        }
        const issuesTab = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          return (m.role === "link" || m.role === "tab" || m.role === "clickable") &&
                 (/\bissues\b/i.test(l) && !/\b(new issue|closed issues|label)\b/i.test(l));
        });
        if (issuesTab) {
          return { action: "click", mark_id: issuesTab.id, isIssue: true, reasoning: "Click Issues tab" };
        }
      }

      // Pull Requests tab
      if (parsed.wantsPR && !progress.prOpened) {
        if (/\/pulls/i.test(url)) {
          progress.prOpened = true;
          return { action: "done", reasoning: "On Pull requests page." };
        }
        const prTab = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          return (m.role === "link" || m.role === "tab" || m.role === "clickable") &&
                 /\bpull\s*requests?\b/i.test(l);
        });
        if (prTab) {
          return { action: "click", mark_id: prTab.id, isPR: true, reasoning: "Click Pull requests tab" };
        }
      }

      // Clone / Code button
      if (parsed.wantsClone && !progress.cloned) {
        const codeBtn = available.find(m => {
          const l = (m.label || "").trim().toLowerCase();
          return (m.role === "button" || m.role === "clickable") &&
                 (/\b(code|clone)\b/i.test(l) && !/\b(view code|browse code)\b/i.test(l));
        });
        if (codeBtn) {
          return { action: "click", mark_id: codeBtn.id, isClone: true, reasoning: "Click Code button to view clone URLs" };
        }
      }
    }

    // 2. Select matching repository on Search Results Page
    if (isSearchPage || progress.searched || progress.queryLanded) {
      if (!progress.repoOpened) {
        const queryTerm = (parsed.query || "").toLowerCase();
        const words = queryTerm.split(/[\s/]+/).filter(w => w.length > 1);

        const repoLink = available.find(m => {
          if (m.role !== "link" && m.role !== "clickable") return false;
          const l = (m.label || "").toLowerCase();
          if (l.length < 3 || l.length > 80) return false;
          if (/\b(repositories|code|commits|issues|discussions|packages|marketplace|topics|wikis|users|sort|filter|sponsor|sign|jump to|next|prev)\b/i.test(l)) return false;
          if (words.length > 0 && words.some(w => l.includes(w))) return true;
          return false;
        });

        if (repoLink) {
          return { action: "click", mark_id: repoLink.id, isRepoSelection: true, reasoning: `Open repository "${repoLink.label}"` };
        }
      }
    }

    // 3. Search for query on GitHub
    if (parsed.query && !progress.searched) {
      const searchBox = available.find(m => isSearchBox(m) || (FILLABLE_ROLES.has(m.role) && /search|jump to/i.test(m.label || "")));
      if (searchBox) {
        return { action: "type", mark_id: searchBox.id, value: parsed.query, reasoning: `Search GitHub for "${parsed.query}"` };
      }

      const searchBtn = available.find(m => {
        const l = (m.label || "").toLowerCase();
        return (m.role === "button" || m.role === "clickable") &&
               (/search or jump to|type \/ to search|search\b/i.test(l));
      });
      if (searchBtn && !progress.searchOpened) {
        progress.searchOpened = true;
        return { action: "click", mark_id: searchBtn.id, reasoning: "Click GitHub search button to open search bar" };
      }

      const anyFillable = available.find(m => FILLABLE_ROLES.has(m.role));
      if (anyFillable) {
        return { action: "type", mark_id: anyFillable.id, value: parsed.query, reasoning: `Search GitHub for "${parsed.query}"` };
      }
    }

    return null;
  }

  /**
   * Deterministic step planner for YouTube workflows.
   */
  function planYouTubeStep(parsed, available, done, progress, pageInfo) {
    const url = (pageInfo && pageInfo.url) || "";
    const isWatchPage = /youtube\.com\/watch/i.test(url);

    if (isWatchPage || progress.videoOpened) {
      return { action: "done", reasoning: "Playing YouTube video." };
    }

    if (progress.searched || progress.queryLanded || /youtube\.com\/results/i.test(url)) {
      const videoLink = available.find(m => {
        if (m.role !== "link" && m.role !== "clickable") return false;
        const l = (m.label || "").toLowerCase();
        if (l.length < 8) return false;
        if (/\b(home|explore|subscriptions|library|history|shorts|filters?|subscribers?|views?|ago|nav|menu)\b/i.test(l)) return false;
        return true;
      });
      if (videoLink) {
        progress.videoOpened = true;
        return { action: "click", mark_id: videoLink.id, reasoning: `Click video: "${videoLink.label.slice(0, 60)}"` };
      }
    }

    if (parsed.query && !progress.searched) {
      const searchBox = available.find(m => isSearchBox(m) || (FILLABLE_ROLES.has(m.role) && /search/i.test(m.label || "")));
      if (searchBox) {
        return { action: "type", mark_id: searchBox.id, value: parsed.query, reasoning: `Search YouTube for "${parsed.query}"` };
      }
    }

    return null;
  }

  function isShoppingSite(url) {
    return /amazon\.|flipkart\.|myntra\.|ebay\.|meesho\.|walmart\.|target\.|bestbuy\./i.test(url || "");
  }

  function planShoppingStep(parsed, available, done, progress, pageInfo) {
    const url = (pageInfo && pageInfo.url) || "";
    const title = (pageInfo && pageInfo.title) || "";

    // "Add to cart" and "Buy now" are not interchangeable. One puts an item in a basket the
    // user can still empty; the other starts a purchase. Treating them as the same control
    // meant that on a page offering both, "add it to cart" reached for Buy now — observed on
    // an Amazon product page, where the risk gate caught it and asked, but the agent should
    // never have proposed it. Buy now is only considered when the instruction actually asked
    // to buy, and even then only if no cart button exists.
    const isClickableRole = (m) =>
      m.role === "button" || m.role === "clickable" || m.role === "input:submit";
    const notCartNav = (l) => !/view\s*cart|items?\s*in\s*cart|go\s*to\s*cart|shopping\s*cart/i.test(l);

    const isAddToCartBtn = (m) => {
      const l = (m.label || "").toLowerCase();
      return isClickableRole(m) && notCartNav(l) && /\b(add\s*to\s*(?:cart|bag|basket))\b/i.test(l);
    };
    const isBuyNowBtn = (m) => {
      const l = (m.label || "").toLowerCase();
      return isClickableRole(m) && notCartNav(l) && /\b(buy\s*now|place\s*order|proceed\s*to\s*buy)\b/i.test(l);
    };
    const wantsToBuyOutright = /\b(buy\s*(?:it\s*)?now|purchase|place\s*(?:the\s*)?order|proceed\s*to\s*buy|checkout)\b/i
      .test(parsed.raw || "");

    // Substep 0: Cart confirmation / Done
    if (progress.cartAdded) {
      return { action: "done", reasoning: "Item successfully added to cart" };
    }

    // If explicit open targets or product were already opened and user did not ask to add to cart, done
    if (!parsed.wantsAddToCart && (
      (parsed.openTargets && parsed.openTargets.length > 0 && parsed.openTargets.every((t) => (progress.opened || []).includes(t))) ||
      progress.productOpened ||
      (progress.opened && progress.opened.length > 0)
    )) {
      return { action: "done", reasoning: "Target item opened as requested." };
    }

    const isCartConfirmation = available.some((m) =>
      /added\s+to\s+cart|added\s+to\s+basket|proceed\s+to\s+checkout|item\s+added|cart\s+subtotal/i.test(m.label || "")
    ) || /added to cart|cart/i.test(title);

    if (progress.cartClicked && isCartConfirmation) {
      progress.cartAdded = true;
      return { action: "done", reasoning: "Verified item added to cart" };
    }

    // Substep 1: If Add to Cart button is visible on a product page or after product selection
    const isProductPage = progress.productOpened || /amazon\..+\/(?:dp|gp\/product|gp\/aw\/d)\/|flipkart\..+\/p\//i.test(url);
    // Cart first, always. Buy now is a fallback only when the user asked to buy outright and
    // the page offers no cart button at all.
    const addBtn = available.find(isAddToCartBtn) ||
                   (wantsToBuyOutright ? available.find(isBuyNowBtn) : null);
    if (addBtn && (isProductPage || (parsed.wantsAddToCart && (progress.searched || progress.queryLanded)))) {
      // cartClicked records that we are about to try — the confirmation check above reads it.
      // cartAdded is deliberately NOT set here: it is an outcome, and background.js sets it
      // once the click has actually executed.
      //
      // Setting it here was self-defeating. The planner marked the task complete, the guard
      // then read that flag, concluded there was nothing left to do, and replaced this very
      // click with `done`. The click never ran, no confirmation gate fired, and the run
      // reported "added item to cart" having added nothing — the worst of the three failures,
      // because a false success is invisible.
      progress.cartClicked = true;
      return { action: "click", mark_id: addBtn.id, isAddToCart: true, reasoning: `Click "${addBtn.label || "Add to Cart"}" button` };
    }

    // Substep 1b: If on product page and wantsAddToCart but Add to Cart button not in viewport yet, scroll down!
    if (isProductPage && parsed.wantsAddToCart && !progress.cartAdded) {
      if ((progress.productScrolls || 0) < 5) {
        progress.productScrolls = (progress.productScrolls || 0) + 1;
        return { action: "scroll_page", value: 650, reasoning: "Scroll down to bring Add to Cart button into view" };
      }
    }

    // Substep 2: If we have not searched yet, type query into search box
    if (parsed.query && !progress.searched) {
      const searchBox = available.find(isSearchBox) || available.find((m) => FILLABLE_ROLES.has(m.role));
      if (searchBox) {
        return { action: "type", mark_id: searchBox.id, value: parsed.query, reasoning: `Search for "${parsed.query}"` };
      }
    }

    // Substep 2.5: Apply filter on search results page if requested
    if ((progress.searched || progress.queryLanded) && (parsed.wantsFilter || parsed.maxPrice || parsed.minPrice) && !progress.filterApplied) {
      if (parsed.maxPrice) {
        const selectEls = available.filter(m => m.role === "select" || m.role === "combobox");
        const PRICEY = /\b(price|budget|cost|amount)\b|₹|\brs\.?\b|\binr\b/i;

        // What the control is CALLED comes first. "the second select is the Max" is true of a
        // Min/Max pair and of nothing else - on a page whose two visible selects were "price"
        // and "sort by" it chose "sort by", which has no numeric options at all, and the price
        // filter then failed four times against a control that could never satisfy it.
        //
        // Marks are viewport-only, so which selects are visible depends on the scroll position.
        // A positional rule is guessing about a list it cannot see all of.
        let maxSelect = selectEls.find(m => /\b(max|upper|high(?:est)?)\b/i.test(m.label || "") && PRICEY.test(m.label || ""));
        if (!maxSelect) maxSelect = selectEls.find(m => PRICEY.test(m.label || ""));
        // The pair heuristic survives only where it was ever true: both controls priced.
        if (!maxSelect && selectEls.length >= 2 &&
            PRICEY.test(selectEls[0].label || "") && PRICEY.test(selectEls[1].label || "")) {
          maxSelect = selectEls[1];
        }
        if (maxSelect) {
          return {
            action: "select",
            mark_id: maxSelect.id,
            value: String(parsed.maxPrice),
            isFilter: true,
            reasoning: `Apply price filter under ₹${parsed.maxPrice}`,
          };
        }

        const priceRe = new RegExp(`(?:under|below|less\\s+than|up\\s+to)\\s*(?:₹|rs\\.?|inr)?\\s*${parsed.maxPrice}`, "i");
        const filterBtn = available.find(m => (m.role === "link" || m.role === "button" || m.role === "clickable" || m.role === "checkbox") && priceRe.test(m.label || ""));
        if (filterBtn) {
          return {
            action: "click",
            mark_id: filterBtn.id,
            isFilter: true,
            reasoning: `Click price filter: "${filterBtn.label}"`,
          };
        }

        const maxInput = available.find(m => FILLABLE_ROLES.has(m.role) && (/\b(high|max|upper)\s*price\b|\bhigh-price\b|\bmaxprice\b/i.test(m.label || "")));
        if (maxInput) {
          return {
            action: "type",
            mark_id: maxInput.id,
            value: String(parsed.maxPrice),
            isFilter: true,
            reasoning: `Enter max price ₹${parsed.maxPrice}`,
          };
        }
      }
      // No control on this page can express the constraint. Recorded as
      // unavailable rather than applied: the loop must stop retrying, but
      // nothing may report a filter it never used.
      progress.filterUnavailable = true;
    }

    // Substep 2.8: Apply sorting on search results page if requested
    if ((progress.searched || progress.queryLanded) && parsed.wantsSort && !progress.sortApplied) {
      const sortAsc = parsed.sort === "price_asc";
      const sortDesc = parsed.sort === "price_desc";
      const sortRating = parsed.sort === "rating";
      const sortPop = parsed.sort === "popularity";

      const sortSelect = available.find(m => (m.role === "select" || m.role === "combobox") && /sort/i.test(m.label || ""));
      if (sortSelect) {
        const val = sortAsc ? "price-asc-rank" : (sortDesc ? "price-desc-rank" : (sortRating ? "review-rank" : "popularity-rank"));
        return {
          action: "select",
          mark_id: sortSelect.id,
          value: val,
          isSort: true,
          reasoning: `Sort results by ${parsed.sort || "price"}`,
        };
      }

      const sortTab = available.find(m => {
        const l = (m.label || "").toLowerCase();
        if (m.role !== "link" && m.role !== "button" && m.role !== "clickable" && m.role !== "tab") return false;
        if (sortAsc && (/low\s*to\s*high/i.test(l) || /price\s*--\s*low/i.test(l))) return true;
        if (sortDesc && (/high\s*to\s*low/i.test(l) || /price\s*--\s*high/i.test(l))) return true;
        if (sortRating && (/rating/i.test(l) || /customer\s*rating/i.test(l))) return true;
        if (sortPop && /popularity/i.test(l)) return true;
        return false;
      });
      if (sortTab) {
        return {
          action: "click",
          mark_id: sortTab.id,
          isSort: true,
          reasoning: `Click sort option: "${sortTab.label}"`,
        };
      }
      progress.sortApplied = true;
    }

    // If filter or sort was applied and user didn't ask to add to cart or pick/open specific products, complete task
    if ((progress.filterApplied || progress.sortApplied) && (progress.searched || progress.queryLanded) && !parsed.wantsAddToCart && !parsed.wantsBest && (!parsed.openTargets || parsed.openTargets.length === 0)) {
      return { action: "done", reasoning: "Search completed with filters/sorting applied." };
    }

    // Substep 3: Product evaluation and selection on search results page
    if (progress.searched || progress.queryLanded) {
      if (!progress.productOpened && !progress.cartAdded) {
        const isProductCandidate = (m) => {
          if (m.role !== "link" && m.role !== "clickable") return false;
          const l = (m.label || "").toLowerCase();
          if (l.length < 10) return false;
          if (/\b(sign\s*in|account|returns|orders|customer\s*service|customer\s*care|prime|todays?\s*deals|bestsellers|best\s*sellers|registry|sell|sellers?|selling|become\s+a|advertise|download\s+app|track\s+order|gift\s*cards|feedback|help|privacy|terms|skip\s*to|next|previous|page\s*\d+|cookie|explore|see\s*more|filter|sort\s*by|menu|nav)\b/i.test(l)) {
            return false;
          }
          return true;
        };

        // A product has to look like one. Site chrome that survives the exclusion list above
        // still scored the full baseline, so with no real product among the visible marks the
        // highest scorer was whatever link happened to be there - observed on Flipkart, where
        // "become a seller" was clicked as the best matching laptop.
        //
        // Evidence means a price, or a word from what the user searched for. Applied only when
        // there IS a query to match against; a bare "open the first result" has nothing to
        // compare and falls back to the ordering the page gave.
        const queryWords = (parsed.query || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const hasProductEvidence = (c) => {
          const l = (c.label || "").toLowerCase();
          if (/(?:₹|rs\.?|inr|\$)\s*[\d,]+/i.test(l)) return true;
          if (queryWords.some((w) => l.includes(w))) return true;
          // A product is usually named by its brand and model, not by the category the user
          // searched for - "Aurex Stratos 14" contains neither a price nor the word "laptop".
          // Length separates those from site chrome, which is uniformly short: "become a
          // seller" is sixteen characters, a product title rarely under twenty.
          //
          // The role constraint is what makes length safe to use. A search box carries a long
          // placeholder - "search for products, brands and more" - and was duly opened as the
          // best matching laptop the first time length alone was trusted. You navigate to a
          // product by following a link, never by clicking into a field.
          // A genuine link only. "clickable" is the role given to a wrapper div, and the one
          // wrapping the search box carries its placeholder as a 43-character label - long
          // enough to look like a product title, and duly opened as the best matching laptop.
          // The real product beside it is an <a>, which is how anyone reaches a product page.
          return c.role === "link" && l.length >= 20;
        };

        const candidates = queryWords.length
          ? available.filter(isProductCandidate).filter(hasProductEvidence)
          : available.filter(isProductCandidate);

        // Nothing product-shaped on screen yet, on a page that is meant to be full of them.
        //
        // Marks are viewport-only, and deliberately so: the screenshot is the viewport, and a
        // mark for something off-screen would carry coordinates that do not map onto the image
        // the redaction was painted on. The consequence is that a results page shows the agent
        // its header and navigation, and the products sit below the fold. Measured on a
        // Flipkart laptop search: 83 links on the page, 28 of them carrying a price, and 16
        // marks - none of which was a product.
        //
        // So scroll and look again. Bounded, because a page that never yields a product is a
        // page this agent cannot shop on, and saying so beats scrolling to the footer.
        // Only when the instruction actually wants an item. "search for iqoo neo 6 and show
        // me" is finished when the results are on screen; scrolling for a product it never
        // asked to open would turn a completed task into a tour of the page.
        const wantsAnItem = parsed.wantsAddToCart || parsed.wantsBest || parsed.wantsCheapest ||
                            parsed.maxPrice != null || parsed.minPrice != null ||
                            parsed.minRating != null || (parsed.openTargets || []).length > 0;

        if (candidates.length === 0 && wantsAnItem && (progress.searched || progress.queryLanded) &&
            (progress.productScrolls || 0) < 3) {
          progress.productScrolls = (progress.productScrolls || 0) + 1;
          return {
            action: "scroll_page",
            value: 700,
            reasoning: "No products in view yet; scrolling to bring the results into the viewport",
          };
        }

        if (candidates.length > 0) {
          const scoreCandidate = (c) => {
            const l = (c.label || "").toLowerCase();
            let score = 100;

            if (parsed.query) {
              const words = parsed.query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
              for (const w of words) {
                if (l.includes(w)) score += 50;
              }
            }

            // Price parsing: ₹1,699 or rs. 1699 or 1699
            const priceM = l.match(/(?:₹|rs\.?|inr|\$)\s*([\d,]+)/i);
            const price = priceM ? parseInt(priceM[1].replace(/,/g, ""), 10) : null;
            if (price !== null) {
              if (parsed.maxPrice && price > parsed.maxPrice) {
                score -= 500;
              } else if (parsed.maxPrice && price <= parsed.maxPrice) {
                score += 150;
                if (parsed.wantsCheapest) score += (parsed.maxPrice - price) / 10;
              }
              if (parsed.minPrice && price < parsed.minPrice) {
                score -= 300;
              }
            }

            // Rating parsing: 3.6 out of 5, 4.2 stars, 3.6
            const ratingM = l.match(/([1-5](?:\.\d+)?)\s*(?:out of 5|\★|stars?)/i) || l.match(/\b([1-5]\.\d)\b/);
            const rating = ratingM ? parseFloat(ratingM[1]) : null;
            if (rating !== null) {
              if (parsed.minRating && rating < parsed.minRating) {
                score -= 500;
              } else {
                score += rating * 40;
              }
            }

            if (l.includes("sponsored")) score -= 30;
            return score;
          };

          candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
          const best = candidates[0];
          if (best && scoreCandidate(best) > 0) {
            return {
              action: "click",
              mark_id: best.id,
              isProductSelection: true,
              openTarget: best.label,
              reasoning: `Select best matching product: "${best.label.slice(0, 60)}"`,
            };
          }
        }
      }
    }

    return null;
  }

  function describeCompletion(parsed, progress) {
    const bits = [];
    if (progress.navigated && parsed.site) bits.push(`opened ${parsed.site}`);
    if (progress.searched && parsed.query) bits.push(`searched for "${parsed.query}"`);
    if (progress.filterApplied) bits.push("applied filter");
    if (progress.sortApplied) bits.push("applied sorting");
    if (progress.cartAdded) bits.push("added item to cart");
    if (progress.starred) bits.push("starred repository");
    if (progress.forked) bits.push("forked repository");
    if (progress.cloned) bits.push("opened clone options");
    if (progress.issueOpened) bits.push("opened issues");
    if (progress.prOpened) bits.push("opened pull requests");
    if (progress.nonStopFiltered) bits.push("filtered non-stop flights");
    if (progress.videoOpened) bits.push("opened video");
    if ((progress.opened || []).length) bits.push(`opened ${progress.opened.length} item(s)`);
    if (progress.scrolled) bits.push("scrolled the page");
    return bits.length ? `Task complete — ${bits.join(", ")}.` : "Nothing further to do for this task.";
  }

  let TaskChecklist = global.TaskChecklist;
  let VisualGrounding = global.VisualGrounding;
  let TaskParser = global.TaskParser;
  if (typeof require !== "undefined") {
    try { TaskChecklist = TaskChecklist || require("./planner/task-checklist.js"); } catch (_) {}
    try { VisualGrounding = VisualGrounding || require("./planner/visual-grounding.js"); } catch (_) {}
    try { TaskParser = TaskParser || require("./planner/task-parser.js"); } catch (_) {}
  }

  const TaskPlanner = {
    parseTask, planNextAction, planBatchFormFill, alreadyOnSite, siteUrlFor, vaultKeyForLabel, KNOWN_SITES,
    isShoppingSite, planShoppingStep, planGitHubStep, planBookingStep, planYouTubeStep,
    TaskChecklist, VisualGrounding, TaskParser,
  };

  global.TaskPlanner = TaskPlanner;
  if (typeof module !== "undefined" && module.exports) module.exports = TaskPlanner;
})(typeof globalThis !== "undefined" ? globalThis : this);

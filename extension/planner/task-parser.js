/**
 * task-parser.js — Natural language task parsing and entity extraction for VisionVault.
 *
 * Extracts structured intent: target website, search terms, form autofill flags,
 * travel/booking details, GitHub intents, e-commerce filters, and PII vault label mappings.
 */

(function (global) {
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

  const TAIL_RE = /\s*(?:,|\band\b|\bthen\b)?\s*(?:please\s+)?(?:can\s+you\s+)?(?:show|display|tell|give|list|find|see)\s+(?:me|us|it)?\s*(?:the\s+)?(?:results?|details?|options?|list|prices?|it|best(?:\s+among\s+them)?)?\s*[.!]?\s*$/i;
  const CLAUSE_SPLIT_RE = /\s+(?:and|then|,)\s+(?:also\s+)?(?=open|click|select|scroll|show|tell|display|go|buy|add|book|play|read|check|see|view|pick|choose|filter|sort|find|get|checkout|put|apply|set|use|refine|star|fork|clone|compare|save|analy[sz]e|review|evaluate|summari[sz]e|list|submit|confirm|raise|write|tick|enter|fill|note|report)/i;
  const LEAD_RE = /^\s*(?:hey|hi|ok|okay|please|can you|could you|would you|i want to|i want you to|i need to|help me|let's|lets)\s+/i;
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

    if (/^[a-z0-9-]+(\.[a-z]{2,})+$/i.test(name)) return `https://${name}`;
    if (/^[a-z0-9-]{2,30}$/i.test(key)) return `https://www.${key}.com`;
    return null;
  }

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
      tripType: null,
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

      for (const key of ["from", "to"]) {
        if (result[key]) {
          result[key] = result[key]
            .replace(/^(?:the|a|an)\s+/i, "")
            .replace(/\s+(?:flights?|tickets?|cabs?|bus|trains?|hotels?|non[\s-]*stop|direct)$/i, "")
            .trim();
        }
      }
    }

    const explicitBooking = /\b(book|booking|reserve|reservation|purchase|place\s+(?:an?\s+)?order)\b/i.test(text);
    const hasRoute = !!(result.from && result.to);
    if (result.wantsBook && !explicitBooking && !hasRoute && !result.date) {
      result.wantsBook = false;
    }

    // Messaging / Chat task detection:
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

    const cartKeywords = /\b(add\s+to\s+cart|add\s+to\s+basket|buy\s+now|add\s+it\s+to\s+cart|put\s+(?:it\s+)?in\s+(?:the\s+)?cart)\b/i;
    result.wantsAddToCart = cartKeywords.test(text);

    const priceUnderMatch = text.match(/\b(?:under|below|less\s+than|max(?:imum)?|cheaper\s+than|within|up\s+to)\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:[\d,]*)?(?:\.\d+)?)\s*([kKlL])?\b/i);
    const priceOverMatch = text.match(/\b(?:above|over|more\s+than|min(?:imum)?|at\s+least)\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:[\d,]*)?(?:\.\d+)?)\s*([kKlL])?\b/i);
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

    if (isTravel || /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text)) {
      const dateMatch = text.match(/\bon\s+([\w\s,]+?)(?:\s+(?:for|with|and|,|$))/i) ||
                        text.match(/\b(tomorrow|today|next\s+\w+|\d{1,2}[\s/-]\w+[\s/-]?\d{0,4})\b/i);
      if (dateMatch) result.date = dateMatch[1].trim();
    }

    const passMatch = text.match(/\bfor\s+(\d+)\b|\b(\d+)\s+(?:passenger|adult|person|people|travell?er)/i);
    if (passMatch) result.passengers = parseInt(passMatch[1] || passMatch[2]);

    if (/\bbusiness\b/i.test(text)) result.travelClass = "business";
    else if (/\bfirst\s*class\b/i.test(text)) result.travelClass = "first";
    else if (/\beconomy\b/i.test(text)) result.travelClass = "economy";

    if (/\bround\s*trip\b|\breturn\b/i.test(text)) result.tripType = "round-trip";
    else if (/\bone\s*way\b/i.test(text)) result.tripType = "one-way";

    if (/\b(non[\s-]*stop|direct\s*flights?|direct)\b/i.test(text)) {
      result.wantsNonStop = true;
      result.wantsFilter = true;
    }

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
      if (q && (result.wantsBest || result.wantsCheapest)) {
        const stripped = q.replace(/^(?:the\s+)?(?:best|cheapest|top[- ]?rated|highest[- ]?rated|top)\s+/i, "").trim();
        if (stripped.length >= 2) q = stripped;
      }
      if (q) {
        q = q.split(/\s*[,;]\s*/)[0].trim();
        const words = q.split(/\s+/);
        if (words.length > 8) q = words.slice(0, 8).join(" ");
        q = q.replace(/\s+(?:and|then|or|with|for|to|from|by|in|on)$/i, "").trim();
      }
      if (q && !/^(?:me|it|this|that|results?|them)$/i.test(q)) result.query = q;
    }

    if (!result.query && !result.wantsNewRepo && (isGitHub || result.site === "github")) {
      const repoMatch = text.match(/\b(?:star|fork|clone|open|repo|repository)\s+([a-zA-Z0-9_\-\.\/]+)(?:\s+(?:on|in|at)\s+github|$)/i);
      if (repoMatch && !/^(the|a|an|it|this|that|repo|repository)$/i.test(repoMatch[1])) {
        result.query = repoMatch[1].trim();
      }
    }

    if (result.wantsBook && (result.from && result.to)) {
      result.query = null;
      result.wantsSearch = false;
    }
    if (result.wantsNewRepo) {
      result.query = null;
      result.wantsSearch = false;
    }

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

    const onPageTargetMatch = text.match(/\b(?:into|to|go\s+to|open|visit|switch\s+to|navigate\s+to)\s+(logs?|history|settings|overview|profile|comms?|telemetry|dashboard)\b/i);
    if (onPageTargetMatch && !result.openTargets.includes(onPageTargetMatch[1].toLowerCase())) {
      result.openTargets.push(onPageTargetMatch[1].toLowerCase());
    }

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

  function alreadyOnSite(url, siteUrl) {
    if (!url || !siteUrl) return false;
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const want = new URL(siteUrl).hostname.replace(/^www\./, "");
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
    [/occupation|job[\s_-]*title|\bjob\b|profession|designation|profession[\s_-]*type|\bwork\b/, "occupation"],
    [/annual[\s_-]*income|income|salary|annual[\s_-]*salary|ctc|earnings|net[\s_-]*income/, "annual_income"],
    [/marital[\s_-]*status|marital/, "marital_status"],
    [/gender|\bsex\b/, "gender"],
    [/father[\s_-]*name|father/, "father_name"],
    [/mother[\s_-]*name|mother/, "mother_name"],
    [/qualification|degree|education/, "qualification"],
    [/nationality|citizenship/, "nationality"],
    [/dob|date[\s_-]*of[\s_-]*birth|birth[\s_-]*date/, "dob"],
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

  const UNKNOWN_IDENTIFIER_RE =
    /aadhaar|aadhar|\bpan\b|passport|licence|license|voter|ssn|social security|nino|national insurance|tax id|gst|ifsc|upi|account number|card number|cvv|otp\b/i;

  function vaultKeyForLabel(label) {
    const text = String(label || "").toLowerCase();
    if (!text) return { key: null, unknownIdentifier: false };
    if (UNKNOWN_IDENTIFIER_RE.test(text)) return { key: null, unknownIdentifier: true };
    for (const [pattern, key] of FIELD_LABEL_RULES) {
      if (pattern.test(text)) return { key, unknownIdentifier: false };
    }
    return { key: null, unknownIdentifier: false };
  }

  const TaskParser = {
    KNOWN_SITES,
    NON_SITE_WORDS,
    stripQuotes,
    siteUrlFor,
    parseTask,
    alreadyOnSite,
    FILLABLE_ROLES,
    FIELD_LABEL_RULES,
    vaultKeyForLabel,
  };

  global.TaskParser = TaskParser;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = TaskParser;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

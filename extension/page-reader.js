/**
 * page-reader.js — What the page says, for an agent that has to compare and decide.
 *
 * Set-of-Marks tells a planner what it can click. It does not tell it which of twelve laptops
 * has the best rating, what a booking confirmation number is, or what an article concludes.
 * This reads that — headings, the main text, repeated "card" structures (product tiles,
 * search results, listings) and tables — as small, structured, PII-scrubbed JSON.
 *
 * Privacy: everything here is page content, not user data, but pages show personal data too —
 * a dashboard of customers, an order page with the user's own address. So every string is
 * passed through the same PII patterns the DOM scanner uses (emails, phone numbers, card and
 * ID numbers) and any match is replaced with "[redacted]"; table columns whose header names a
 * sensitive field are dropped wholesale; and an item whose title is itself a PII match is
 * discarded. Personal names have no pattern and are not caught — see LIMITATIONS.md.
 *
 * Generic by construction: repeated structures are found by shape (several siblings sharing
 * a tag and class, each with a link or heading), not by any site's class names.
 *
 * Content script, every frame; only the top frame answers READ_PAGE (see content.js).
 */

(function (global) {
  const MAX_TEXT = 1200;
  const MAX_ITEMS = 20;
  const MAX_TABLES = 2;
  const MAX_ROWS = 10;
  const MAX_NODES = 4000;

  const PII_RES = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,          // email
    /(\+?\d[\d\s\-().]{7,}\d)/g,                                    // phone
    /\b(?:\d{4}[- ]?){3}\d{4}\b/g,                                  // card
    /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,                             // ssn
    /\b\d{4}\s?\d{4}\s?\d{4}\b/g,                                   // aadhaar
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,                                   // pan
    /\b[A-Z][0-9]{7}\b/g,                                           // passport
    /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,                                    // ifsc
    /\b[a-zA-Z0-9.\-_]{2,40}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|axl|upi)\b/gi, // upi
  ];
  const PII_HEADER_RE = /\b(?:name|surname|email|e-mail|phone|mobile|telephone|contact|address|street|postcode|zip|aadhaar|pan|passport|dob|birth|card|account|ssn|salary|password|username|customer|patient|employee)\b/i;
  const PRICE_RE = /(?:₹|rs\.?\s?|inr\s?|\$|€|£|usd\s?|eur\s?|gbp\s?)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:₹|rs\.?|inr|usd|eur|gbp)\b/i;
  const RATING_RE = /\b([0-5](?:\.\d)?)\s*(?:out of 5|\/\s?5|★|stars?\b)/i;
  const RATING_ARIA_RE = /([0-5](?:\.\d)?)\s*out of\s*5/i;

  function scrub(text) {
    let out = String(text || "");
    for (const re of PII_RES) {
      re.lastIndex = 0;
      out = out.replace(re, "[redacted]");
    }
    return out;
  }

  function looksLikePII(text) {
    return PII_RES.some((re) => { re.lastIndex = 0; const hit = re.test(text || ""); re.lastIndex = 0; return hit; });
  }

  function collapse(text, max) {
    const s = String(text || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    return max && s.length > max ? s.slice(0, max) : s;
  }

  function isShown(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }

  function textOf(el) {
    return collapse(el ? (el.innerText || el.textContent || "") : "");
  }

  function absoluteUrl(href) {
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return null;
      return (u.origin + u.pathname + u.search).slice(0, 220);
    } catch (_) {
      return null;
    }
  }

  function headings() {
    const out = [];
    for (const h of document.querySelectorAll("h1, h2, h3")) {
      if (!isShown(h)) continue;
      const t = scrub(textOf(h)).slice(0, 80);
      if (t && !out.includes(t)) out.push(t);
      if (out.length >= 10) break;
    }
    return out;
  }

  function mainText() {
    const root = document.querySelector("main, [role='main'], article") || document.body;
    if (!root) return "";
    return scrub(collapse(root.innerText || "", MAX_TEXT * 2)).slice(0, MAX_TEXT);
  }

  /** The class part of a child's shape signature, tolerant of hashed utility classes. */
  function shapeOf(el) {
    const cls = (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${el.tagName}.${cls}`;
  }

  /** Does this element look like one entry of a listing — a link or heading, and some text? */
  function isEntry(el) {
    if (!isShown(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.height < 24 || r.width < 60) return false;
    const link = el.querySelector("a[href], h1, h2, h3, h4, h5, h6, [role='heading']");
    if (!link) return false;
    const t = textOf(el);
    return t.length >= 12;
  }

  /**
   * Finds the container whose children most look like a listing: at least three visible
   * siblings sharing a shape, each holding a link or heading. Scored by count, then area, so
   * a results grid beats a footer link list.
   */
  function findListing() {
    let best = null;
    let visited = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > MAX_NODES) break;
      if (node.children.length < 3) continue;
      if (/^(?:NAV|HEADER|FOOTER|SCRIPT|STYLE|SELECT|UL)$/.test(node.tagName) && node.closest("nav, header, footer")) continue;
      if (node.closest("nav, header, footer, [role='navigation'], [role='banner']")) continue;
      const groups = new Map();
      for (const child of node.children) {
        if (!isEntry(child)) continue;
        const key = shapeOf(child);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(child);
      }
      for (const [, members] of groups) {
        if (members.length < 3) continue;
        const area = members.reduce((s, m) => { const r = m.getBoundingClientRect(); return s + r.width * r.height; }, 0);
        const score = members.length * 1000 + Math.min(area / 10000, 900);
        if (!best || score > best.score) best = { members, score };
      }
    }
    return best ? best.members : [];
  }

  function itemFrom(el) {
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
    const links = Array.from(el.querySelectorAll("a[href]")).filter((a) => textOf(a).length >= 8);
    const titleSource = heading || links[0] || el.querySelector("a[href]");
    let title = titleSource ? textOf(titleSource) : "";
    if (!title && titleSource && titleSource.getAttribute) title = collapse(titleSource.getAttribute("aria-label") || "");
    title = title.slice(0, 120);
    if (!title || looksLikePII(title)) return null;

    const whole = textOf(el);
    const priceMatch = whole.match(PRICE_RE);
    const price = priceMatch ? priceMatch[0].trim().slice(0, 24) : null;

    let rating = null;
    const rm = whole.match(RATING_RE);
    if (rm) rating = rm[1] + "/5";
    if (!rating) {
      const aria = el.querySelector("[aria-label*='out of 5' i], [title*='out of 5' i]");
      const am = aria && (aria.getAttribute("aria-label") || aria.getAttribute("title") || "").match(RATING_ARIA_RE);
      if (am) rating = am[1] + "/5";
    }

    let meta = whole;
    if (title) meta = meta.replace(title, " ");
    if (price) meta = meta.replace(price, " ");
    meta = scrub(collapse(meta)).slice(0, 110);

    const linkEl = (heading && heading.closest("a[href]")) || (heading && heading.querySelector("a[href]")) || links[0] || el.querySelector("a[href]");
    const marked = (linkEl && linkEl.getAttribute("data-vagent-mark")) ||
                   (el.querySelector("a[data-vagent-mark]") || {}).getAttribute?.("data-vagent-mark") || null;

    const item = { title: scrub(title) };
    if (price) item.price = price;
    if (rating) item.rating = rating;
    if (meta) item.meta = meta;
    if (marked) item.mark_id = Number(marked);
    const url = linkEl ? absoluteUrl(linkEl.getAttribute("href")) : null;
    if (url) item.url = url;
    return item;
  }

  function readItems() {
    const members = findListing();
    const items = [];
    for (const el of members) {
      const item = itemFrom(el);
      if (item) items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    return { items, truncated: members.length > items.length };
  }

  function readTables() {
    const out = [];
    for (const table of document.querySelectorAll("table")) {
      if (!isShown(table)) continue;
      const headerCells = Array.from(table.querySelectorAll("thead th, tr:first-child th"));
      const headers = headerCells.map((th) => collapse(textOf(th), 40));
      const drop = new Set();
      headers.forEach((h, i) => { if (PII_HEADER_RE.test(h)) drop.add(i); });
      const rows = [];
      for (const tr of table.querySelectorAll("tr")) {
        if (tr.closest("thead")) continue;
        const cells = Array.from(tr.children).filter((c) => /^td$/i.test(c.tagName));
        if (!cells.length) continue;
        rows.push(cells.map((c, i) => (drop.has(i) ? "[redacted]" : scrub(collapse(textOf(c), 60)))));
        if (rows.length >= MAX_ROWS) break;
      }
      if (rows.length < 2) continue;
      out.push({ headers: headers.map((h, i) => (drop.has(i) ? h + " (hidden)" : h)), rows });
      if (out.length >= MAX_TABLES) break;
    }
    return out;
  }

  /**
   * Reads the page. Cheap enough to run on every step that asks for it: a few thousand
   * nodes at most, no layout thrash beyond getBoundingClientRect on candidates.
   */
  function readPage() {
    const t0 = performance.now();
    const { items, truncated } = readItems();
    const tables = readTables();
    const text = mainText();
    return {
      url: location.origin + location.pathname,
      title: scrub(collapse(document.title, 120)),
      headings: headings(),
      text,
      items,
      tables,
      truncated,
      ms: Math.round(performance.now() - t0),
    };
  }

  /**
   * Scrolls the first visible element whose text contains `needle` into the middle of the
   * viewport, so the next scan can tag it. Case-insensitive; matches the longest common prefix
   * of the needle's words when the whole phrase is not found, because titles get truncated.
   */
  function scrollToText(needle) {
    const want = collapse(needle).toLowerCase();
    if (!want) return { ok: false, error: "Nothing to look for." };
    const words = want.split(" ").filter((w) => w.length > 2);
    const tries = [want];
    if (words.length > 3) tries.push(words.slice(0, 4).join(" "));
    if (words.length > 1) tries.push(words.slice(0, 2).join(" "));

    const candidates = Array.from(document.querySelectorAll("a, h1, h2, h3, h4, h5, h6, button, li, p, span, div, td"));
    for (const phrase of tries) {
      let bestEl = null;
      let bestLen = Infinity;
      for (const el of candidates) {
        const t = (el.innerText || "").toLowerCase();
        if (!t || t.length > 600 || !t.includes(phrase)) continue;
        if (!isShown(el)) continue;
        if (t.length < bestLen) { bestLen = t.length; bestEl = el; }
      }
      if (bestEl) {
        try { bestEl.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) { bestEl.scrollIntoView(); }
        return { ok: true, found: true, matched: phrase };
      }
    }
    return { ok: false, found: false, error: `Could not find "${needle.slice(0, 60)}" on this page.` };
  }

  const PageReader = { readPage, scrollToText, scrub };
  global.__vagentReader = PageReader;
  global.PageReader = PageReader;
  if (typeof module !== "undefined" && module.exports) module.exports = PageReader;
})(typeof globalThis !== "undefined" ? globalThis : this);

/**
 * audit-log.js — a record of everything this extension has ever transmitted.
 *
 * The privacy claim in PS 26171 is that personal data never leaves the device. Every part of
 * this codebase is built to make that true, but none of it lets the person using it *check*.
 * They are asked to trust the redaction pipeline, the fail-closed gate and the vault
 * indirection because we say those work.
 *
 * This log replaces that trust with evidence. Every outbound request is recorded here, on the
 * device, with the exact bytes that were sent and the redacted image as it was sent — so the
 * question "what did you send about me?" has an answer the user can read for themselves rather
 * than a reassurance from the people who wrote the code.
 *
 * Two properties matter and are easy to lose:
 *
 *   It is local.        Entries live in chrome.storage.local and are never transmitted. An
 *                       audit log that phoned home would be self-defeating.
 *   It cannot lie.      The entry is written from inside callServer, from the same object that
 *                       is handed to fetch(). It is not a reconstruction of what should have
 *                       been sent; it is what was sent.
 *
 * Storage is bounded. Metadata is small and worth keeping for a long history; the redacted
 * images are ~60-200KB each and only the most recent few are retained, which is enough to
 * answer "show me" without turning the log into the largest thing on disk.
 */

(function (global) {
  const STORE_KEY = "auditLog";
  // Enough history to cover several runs. Metadata only, a few hundred bytes each.
  const MAX_ENTRIES = 120;
  // Redacted captures are large. Keeping the newest few is what makes the log demonstrable
  // ("here is the actual image that went to the model") without unbounded growth.
  const MAX_IMAGES = 6;

  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * Origin and path only. A query string can carry the very thing this project exists to keep
   * on the device, and the log must not become the leak.
   */
  function safeUrl(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (_) {
      return String(url || "").split("?")[0].slice(0, 200);
    }
  }

  async function read() {
    try {
      const got = await chrome.storage.local.get(STORE_KEY);
      const list = got && got[STORE_KEY];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  async function write(list) {
    try {
      await chrome.storage.local.set({ [STORE_KEY]: list });
    } catch (err) {
      // A full quota must not break a run. Drop the oldest half and try once more; if that
      // fails too, the run continues without a log entry rather than failing the user's task.
      try {
        await chrome.storage.local.set({ [STORE_KEY]: list.slice(0, Math.floor(list.length / 2)) });
      } catch (_) {
        console.warn("[audit] could not persist audit entry:", err && err.message);
      }
    }
  }

  /**
   * Records one transmission.
   *
   * @param {object} e
   * @param {string} e.url          where it went
   * @param {string} e.task         the instruction the user typed — their own words
   * @param {string} e.body         the exact serialised request body
   * @param {string} [e.image]      the redacted capture, as sent
   * @param {number} [e.marks]      how many page elements were described
   * @param {number} [e.step]       step number within the run
   * @param {number} [e.durationMs] round-trip time
   * @param {string} [e.outcome]    "ok" | "error"
   * @param {string} [e.tier]       which planning tier answered
   * @param {string} [e.error]      failure detail, when outcome is "error"
   * @param {string} [e.vaultField] the vault field the model asked for, if any - a NAME,
   *                                never a value; the value is resolved locally after this
   *                                point, so this line is the indirection made auditable
   */
  async function record(e) {
    const body = e.body || "";

    const entry = {
      at: nowIso(),
      url: safeUrl(e.url),
      task: String(e.task || "").slice(0, 240),
      step: e.step || null,
      bytes: body.length,
      imageBytes: (e.image || "").length,
      marks: e.marks || 0,
      durationMs: e.durationMs || null,
      outcome: e.outcome || "ok",
      tier: e.tier || null,
      error: e.error ? String(e.error).slice(0, 200) : null,
      // The vault indirection, made visible. When the model asked for a personal value it
      // could only name the FIELD; the value was resolved on this device afterwards. Recording
      // the name lets a reader confirm for themselves that a name is all that ever crossed.
      vaultFieldRequested: e.vaultField || null,
      // The full request body, so the claim is inspectable rather than summarised. It is
      // truncated only if a page produced an unusually large mark set.
      body: body.length > 60000 ? body.slice(0, 60000) + "…[truncated]" : body,
      image: e.image || null,
    };

    const list = await read();
    list.unshift(entry);

    // Trim: metadata for MAX_ENTRIES, images for only the newest MAX_IMAGES.
    const trimmed = list.slice(0, MAX_ENTRIES);
    for (let i = MAX_IMAGES; i < trimmed.length; i++) {
      if (trimmed[i].image) trimmed[i] = { ...trimmed[i], image: null, imageDropped: true };
    }
    await write(trimmed);
    return entry;
  }

  async function list() {
    return read();
  }

  /** Totals for the panel header, so the log reads as a summary before it reads as a list. */
  async function summary() {
    const items = await read();
    const bytes = items.reduce((a, x) => a + (x.bytes || 0), 0);
    return {
      count: items.length,
      bytes,
      lastAt: items.length ? items[0].at : null,
      destinations: Array.from(new Set(items.map((x) => x.url))),
      errors: items.filter((x) => x.outcome === "error").length,
    };
  }

  async function clear() {
    try {
      await chrome.storage.local.remove(STORE_KEY);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** The whole log as JSON, for a user who wants to keep or inspect it elsewhere. */
  async function exportJson() {
    const items = await read();
    return JSON.stringify({
      exportedAt: nowIso(),
      note: "Every network request VisionVault made. Recorded on this device; never transmitted.",
      entries: items,
    }, null, 2);
  }

  const AuditLog = { record, list, summary, clear, exportJson, STORE_KEY, MAX_ENTRIES, MAX_IMAGES };

  global.AuditLog = AuditLog;
  if (typeof module !== "undefined" && module.exports) module.exports = AuditLog;
})(typeof globalThis !== "undefined" ? globalThis : this);

/**
 * site-memory.js — What worked before, so the agent gets faster and more reliable with use.
 *
 * Two stores, both in chrome.storage.local and never transmitted as-is:
 *
 *   sites     per origin: the label of the search box that actually ran a search, which
 *             overlay controls were pressed, how many tasks completed here, and short notes.
 *             Only element LABELS are kept — never values, never page text — and only the
 *             labels are offered to the planner as hints ("the search box that worked last
 *             time was labelled ...").
 *
 *   history   the last runs: task text, site, outcome, duration, summary. This is the
 *             History tab, and the "recent tasks" chips. It stays on the device.
 *
 * Loaded by the service worker via importScripts, exported for Node tests.
 */

(function (global) {
  const MAX_SITES = 60;
  const MAX_HISTORY = 50;
  const MAX_NOTES = 6;

  function storage() {
    return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  }

  async function load() {
    const store = storage();
    if (!store) return { sites: {}, history: [] };
    const { memory } = await store.get("memory");
    const m = memory || {};
    return { sites: m.sites || {}, history: Array.isArray(m.history) ? m.history : [] };
  }

  async function save(memory) {
    const store = storage();
    if (!store) return false;
    await store.set({ memory });
    return true;
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch (_) { return null; }
  }

  /** What is known about a site, in the shape the planner is given. */
  async function recall(url) {
    const origin = originOf(url);
    if (!origin) return null;
    const { sites } = await load();
    const s = sites[origin];
    if (!s) return null;
    return {
      search_label: s.searchLabel || null,
      dismissed: s.dismissed || [],
      successes: s.successes || 0,
      notes: s.notes || [],
      lastVisited: s.lastVisited || null,
    };
  }

  /**
   * Records something that worked. `patch` may carry searchLabel, dismissed (array of labels),
   * success (true to count one more completed task), note (a short sentence).
   */
  async function remember(url, patch = {}) {
    const origin = originOf(url);
    if (!origin) return;
    const memory = await load();
    const s = memory.sites[origin] || { dismissed: [], notes: [], successes: 0 };
    if (patch.searchLabel) s.searchLabel = String(patch.searchLabel).slice(0, 60);
    if (Array.isArray(patch.dismissed)) {
      for (const d of patch.dismissed) {
        const label = String(d).slice(0, 40);
        if (label && !s.dismissed.includes(label)) s.dismissed.push(label);
      }
      s.dismissed = s.dismissed.slice(-6);
    }
    if (patch.success) s.successes = (s.successes || 0) + 1;
    if (patch.note) {
      const note = String(patch.note).slice(0, 120);
      if (!s.notes.includes(note)) s.notes.push(note);
      s.notes = s.notes.slice(-MAX_NOTES);
    }
    s.lastVisited = Date.now();
    memory.sites[origin] = s;

    // Keep the store bounded: drop the least recently visited sites first.
    const origins = Object.keys(memory.sites);
    if (origins.length > MAX_SITES) {
      origins.sort((a, b) => (memory.sites[a].lastVisited || 0) - (memory.sites[b].lastVisited || 0));
      for (const o of origins.slice(0, origins.length - MAX_SITES)) delete memory.sites[o];
    }
    await save(memory);
  }

  /**
   * Appends a completed run to the history.
   * @param {{task, url, outcome, summary, elapsedMs, steps, startedAt, milestones}} entry
   */
  async function recordTask(entry) {
    const memory = await load();
    const row = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      task: String(entry.task || "").slice(0, 240),
      url: String(entry.url || "").slice(0, 200),
      site: (originOf(entry.url) || "").replace(/^https?:\/\/(www\.)?/, ""),
      outcome: entry.outcome || "unknown",
      summary: String(entry.summary || "").slice(0, 600),
      highlights: Array.isArray(entry.highlights) ? entry.highlights.slice(0, 5).map((h) => String(h).slice(0, 160)) : [],
      elapsedMs: Number(entry.elapsedMs) || 0,
      steps: Number(entry.steps) || 0,
      startedAt: entry.startedAt || Date.now(),
      finishedAt: Date.now(),
      milestones: Array.isArray(entry.milestones)
        ? entry.milestones.slice(0, 8).map((m) => ({ title: String(m.title || "").slice(0, 80), status: m.status || "pending" }))
        : [],
    };
    memory.history.unshift(row);
    memory.history = memory.history.slice(0, MAX_HISTORY);
    await save(memory);
    return row;
  }

  async function history(limit = MAX_HISTORY) {
    const { history: rows } = await load();
    return rows.slice(0, limit);
  }

  /** Distinct task strings, most recent first, for the quick-pick chips. */
  async function recentTasks(limit = 4) {
    const rows = await history();
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const key = r.task.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r.task);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function clearHistory() {
    const memory = await load();
    memory.history = [];
    await save(memory);
  }

  async function clearAll() {
    await save({ sites: {}, history: [] });
  }

  const SiteMemory = { recall, remember, recordTask, history, recentTasks, clearHistory, clearAll, originOf };
  global.SiteMemory = SiteMemory;
  if (typeof module !== "undefined" && module.exports) module.exports = SiteMemory;
})(typeof globalThis !== "undefined" ? globalThis : this);

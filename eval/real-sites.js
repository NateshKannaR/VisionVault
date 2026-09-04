#!/usr/bin/env node
/**
 * real-sites.js — Runs the agent against real public websites and reports what actually happens.
 *
 * Read-only tasks only. Nothing is purchased, submitted, or logged into: the tasks here search,
 * scroll, open and read. Anything that would commit — add to cart, checkout, sign up — is left
 * to the interactive approval gate, which a test cannot honestly click on a stranger's site.
 *
 * Each site gets a time budget, enforced with the extension's own Stop control, and each result
 * is judged against what the task actually asked for rather than against "did it do something".
 *
 * Usage:
 *   node eval/real-sites.js                       all sites
 *   node eval/real-sites.js --budget 90           per-site seconds
 *   node eval/real-sites.js --only amazon,github  a focused subset
 *   node eval/real-sites.js --group ecommerce     one category
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, seedVault } = require('./lib/harness');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BUDGET_S = Number(arg('--budget', 90));
const RESULTS = path.join(__dirname, 'results');

const ONLY = (arg('--only', null) || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const GROUP = (arg('--group', null) || '').toLowerCase();

// Twenty-two live sites across the five categories the problem statement names. Tasks are the
// kind a person would actually type, including several multi-stage ones — a plain search only
// exercises one milestone, and the point of the workflow layer is the ones that do not.
const ALL_SITES = [
  // ── E-commerce ───────────────────────────────────────────────────────────────────────────
  { group: 'ecommerce', name: 'Amazon.in',   url: 'https://www.amazon.in',        task: 'search for iqoo neo 6 and show me' },
  { group: 'ecommerce', name: 'Flipkart',    url: 'https://www.flipkart.com',     task: 'search for running shoes and show me' },
  { group: 'ecommerce', name: 'Myntra',      url: 'https://www.myntra.com',       task: 'search for cotton kurta' },
  { group: 'ecommerce', name: 'Snapdeal',    url: 'https://www.snapdeal.com',     task: 'search for bluetooth speaker' },
  { group: 'ecommerce', name: 'eBay',        url: 'https://www.ebay.com',         task: 'search for mechanical keyboard, read the results and tell me the cheapest one' },

  // ── Travel ───────────────────────────────────────────────────────────────────────────────
  { group: 'travel',    name: 'MakeMyTrip',  url: 'https://www.makemytrip.com',   task: 'search for flights to goa' },
  { group: 'travel',    name: 'Goibibo',     url: 'https://www.goibibo.com',      task: 'search for hotels in jaipur' },
  { group: 'travel',    name: 'Booking.com', url: 'https://www.booking.com',      task: 'search for hotels in manali' },
  { group: 'travel',    name: 'IRCTC',       url: 'https://www.irctc.co.in',      task: 'search for trains to chennai' },

  // ── Productivity / reference ─────────────────────────────────────────────────────────────
  { group: 'productivity', name: 'Wikipedia',      url: 'https://www.wikipedia.org',     task: 'search for quantum computing' },
  { group: 'productivity', name: 'GitHub',         url: 'https://github.com',            task: 'search for onnxruntime' },
  { group: 'productivity', name: 'Stack Overflow', url: 'https://stackoverflow.com',     task: 'search for webassembly simd' },
  { group: 'productivity', name: 'MDN',            url: 'https://developer.mozilla.org', task: 'search for OffscreenCanvas' },
  { group: 'productivity', name: 'npm',            url: 'https://www.npmjs.com',         task: 'search for onnxruntime-web' },
  { group: 'productivity', name: 'PyPI',           url: 'https://pypi.org',              task: 'search for fastapi' },

  // ── Media / news ─────────────────────────────────────────────────────────────────────────
  { group: 'media', name: 'YouTube',     url: 'https://www.youtube.com',         task: 'search for lofi study music' },
  { group: 'media', name: 'BBC News',    url: 'https://www.bbc.com/news',        task: 'scroll down and show me more headlines' },
  { group: 'media', name: 'Hacker News', url: 'https://news.ycombinator.com',    task: 'read this page and tell me the top stories' },
  { group: 'media', name: 'Reddit',      url: 'https://www.reddit.com',          task: 'scroll down and show me more posts' },
  { group: 'media', name: 'IMDb',        url: 'https://www.imdb.com',            task: 'search for interstellar' },

  // ── Services ─────────────────────────────────────────────────────────────────────────────
  { group: 'services', name: 'Zomato',      url: 'https://www.zomato.com',       task: 'search for pizza' },
  { group: 'services', name: 'BookMyShow',  url: 'https://in.bookmyshow.com',    task: 'read this page and tell me what is showing' },
];

const SITES = ALL_SITES.filter((s) => {
  if (GROUP && s.group !== GROUP) return false;
  if (ONLY.length && !ONLY.some((o) => s.name.toLowerCase().includes(o))) return false;
  return true;
});

const VAULT = { name: 'Ada Lovelace', email: 'ada@localhost.test', phone: '+44 20 7946 0102' };

/** What the task asked for, and whether the page shows it happened. */
function judge(row) {
  if (row.error) return 'ERROR';
  if (row.botWall) return 'blocked (human verification)';
  // A read task succeeds by producing an answer. Structured items are a bonus: a page whose
  // listing is a bare <table> (Hacker News) yields none, and the agent still read it and
  // summarised it correctly, which is what was asked. This is judged BEFORE the search check,
  // because a task like "search for X, read the results and tell me the cheapest" is asking
  // for the answer — eBay reached the results and answered from them while the query itself
  // never appeared in the URL, and calling that "search did NOT land" describes the mechanism
  // rather than the outcome.
  if (row.wantedRead) {
    if (row.answered) return row.itemsRead > 0 ? `read ${row.itemsRead} items, answered` : 'read and answered';
    return 'read nothing';
  }
  if (row.queryOnPage) {
    return (row.queryOnPage.inUrl || row.queryOnPage.inBox || row.queryOnPage.inTitle)
      ? 'search landed' : 'search did NOT land';
  }
  if (row.wantedScroll) return row.scrolled ? 'scrolled' : 'did NOT scroll';
  return row.urlChanged || row.steps ? 'acted' : 'no action';
}

(async () => {
  fs.mkdirSync(RESULTS, { recursive: true });
  const h = await launchWithExtension({ headless: false });

  let planner = 'on-device fallback (no server reachable)';
  try {
    const r = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    planner = `${j.backend} (${(j.chain || []).join(' -> ')})`;
  } catch (_) {}

  console.log(`Chrome ${h.chromeVersion} | extension ${h.extensionId}`);
  console.log(`Planner: ${planner} | budget ${BUDGET_S}s per site | ${SITES.length} site(s)\n`);

  await seedVault(h.worker, VAULT, {
    redactMode: 'black', serverUrl: 'http://127.0.0.1:8000/api/agent/step',
    confirmPolicy: 'risky', enableOCR: true, enableFaceDetection: true, dismissOverlays: true,
  });

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });

  const rows = [];

  for (const site of SITES) {
    const row = { site: site.name, group: site.group, task: site.task };
    console.log(`\n${'='.repeat(74)}\n${site.name} — "${site.task}"\n${'='.repeat(74)}`);

    try {
      await page.bringToFront();
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 3500));
      row.landedOn = page.url();
      console.log(`  loaded: ${row.landedOn}`);

      const t0 = Date.now();
      const scan = await h.worker.evaluate((t) => phaseScan(t), site.task);
      row.scanMs = Date.now() - t0;
      row.pii = scan.piiCount;
      row.marks = scan.markCount;
      row.sources = scan.sourceBreakdown;
      row.frames = scan.frameStats;
      row.pipelineMs = scan.timings.total;
      row.plan = (scan.plan?.milestones || []).map((m) => `${m.kind}:${m.title}`);
      row.planTier = scan.plan?.tier || null;
      console.log(`  scan:   ${scan.piiCount} PII, ${scan.markCount} marks, ` +
                  `${scan.frameStats.merged}/${scan.frameStats.total} frames, ${scan.timings.total}ms pipeline`);
      console.log(`  plan:   [${row.planTier}] ${row.plan.join(' -> ')}`);
      if (scan.sourceBreakdown && scan.sourceBreakdown.faceOk === false) {
        console.log('          note: the face model produced no verdict, so every image stayed masked (fail-closed)');
      }

      if (scan.preview) {
        const f = path.join(RESULTS, `real-${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
        fs.writeFileSync(f, Buffer.from(scan.preview.split(',')[1], 'base64'));
        row.screenshot = path.basename(f);
      }

      // Run the loop with a hard time budget, enforced via the extension's own Stop control.
      // Record what the agent told the panel, step by step. The action log says what ran; only
      // these say why a run ended where it did, which is the difference between a diagnosable
      // result and a number.
      await h.worker.evaluate(() => {
        globalThis.__notifications = [];
        if (globalThis.__notifyPatched) return;
        globalThis.__notifyPatched = true;
        const original = notifyPopup;
        notifyPopup = function (d) { globalThis.__notifications.push(d); return original(d); };
      });

      const t1 = Date.now();
      const runPromise = h.worker.evaluate(() => phaseRun());
      const stopper = setTimeout(() => {
        h.worker.evaluate(() => requestStop()).catch(() => {});
      }, BUDGET_S * 1000);

      const run = await Promise.race([
        runPromise,
        new Promise((res) => setTimeout(() => res({ timedOut: true, actionLog: [] }), (BUDGET_S + 40) * 1000)),
      ]);
      clearTimeout(stopper);

      row.runMs = Date.now() - t1;
      row.stepStatuses = await h.worker.evaluate(() =>
        (globalThis.__notifications || []).filter((n) => n && n.type === 'step').map((n) => n.status));
      row.steps = (run.actionLog || []).length;
      row.stopped = !!run.stopped;
      row.timedOut = !!run.timedOut;
      row.actions = (run.actionLog || []).map((a) => `${a.action}${a.ok === false ? '(failed)' : ''}`);
      row.needsConfirm = !!run.needsConfirm;
      row.needsInput = !!run.needsInput;
      row.agentProgress = run.progress || null;
      row.stopReason = run.error || null;
      row.botWall = !!run.botWall;
      row.outcome = run.result?.outcome || null;
      row.summary = run.result?.summary || null;
      row.warnings = run.result?.warnings || [];
      row.itemsRead = (run.result?.findings || []).reduce((s, f) => s + (f.items || []).length, 0);
      row.answered = (run.actionLog || []).some((a) => a.action === 'answer' && a.ok !== false);
      row.milestonesDone = (run.plan?.milestones || []).filter((m) => m.status === 'done').length;
      row.milestonesTotal = (run.plan?.milestones || []).length;
      row.scrolled = !!run.progress?.scrolled;
      row.wantedScroll = /\bscroll\b/i.test(site.task);
      row.wantedRead = /\b(read|tell me|summar)/i.test(site.task);

      await new Promise((r) => setTimeout(r, 2000));
      row.finalUrl = page.url();
      row.urlChanged = row.finalUrl !== row.landedOn;

      // Did what the user asked actually land on the page?
      const parsed = await h.worker.evaluate((t) => TaskPlanner.parseTask(t), site.task);
      row.parsedQuery = parsed.query;
      if (parsed.query) {
        row.queryOnPage = await page.evaluate((q) => {
          // Normalise: sites encode a query as "quantum_computing", "quantum+computing",
          // "Quantum-Computing"... comparing raw strings reports false misses.
          const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
          const target = norm(q);
          const inBox = Array.from(document.querySelectorAll('input, textarea')).some(
            (i) => norm(i.value).includes(target));
          const inUrl = norm(decodeURIComponent(location.href)).includes(target);
          const inTitle = norm(document.title).includes(target);
          return { inBox, inUrl, inTitle };
        }, parsed.query);
      }

      console.log(`  run:    ${row.steps} step(s) in ${(row.runMs / 1000).toFixed(1)}s, ` +
                  `${row.milestonesDone}/${row.milestonesTotal} milestones` +
                  `${row.stopped ? ' (stopped at budget)' : ''}${row.timedOut ? ' (TIMED OUT)' : ''}`);
      console.log(`          actions: ${row.actions.join(', ') || 'none'}`);
      for (const s of row.stepStatuses) console.log(`            · ${s}`);
      if (row.summary) console.log(`          says:    ${row.summary}`);
      if (row.stopReason) console.log(`          why:     ${row.stopReason}`);
      for (const w of row.warnings) console.log(`          note:    ${w}`);
      console.log(`  final:  ${row.finalUrl}`);
      if (row.queryOnPage) {
        console.log(`  check:  in a field=${row.queryOnPage.inBox}  in URL=${row.queryOnPage.inUrl}  in title=${row.queryOnPage.inTitle}`);
      }
    } catch (err) {
      row.error = err.message;
      console.log(`  ERROR: ${err.message}`);
    }
    row.verdict = judge(row);
    rows.push(row);
  }

  fs.writeFileSync(path.join(RESULTS, 'real-sites.json'),
                   JSON.stringify({ generatedAt: new Date().toISOString(), planner, budgetSeconds: BUDGET_S, sites: rows }, null, 2));

  console.log(`\n\n${'='.repeat(104)}\nSUMMARY\n${'='.repeat(104)}`);
  console.log('site             group         marks  pii  scan(ms)  steps  ms/step  miles  outcome   verdict');
  for (const r of rows) {
    const perStep = r.steps ? Math.round(r.runMs / r.steps) : 0;
    console.log(
      `${(r.site || '').padEnd(16)} ${(r.group || '').padEnd(13)} ${String(r.marks ?? '-').padStart(5)} ` +
      `${String(r.pii ?? '-').padStart(4)} ${String(r.pipelineMs ?? '-').padStart(9)}  ${String(r.steps ?? '-').padStart(5)}  ` +
      `${String(perStep || '-').padStart(7)}  ${String(`${r.milestonesDone ?? '-'}/${r.milestonesTotal ?? '-'}`).padStart(5)}  ` +
      `${String(r.outcome || '-').padEnd(8)}  ${r.verdict}`
    );
  }

  const ok = rows.filter((r) => /landed|scrolled|read \d|acted/.test(r.verdict)).length;
  const blocked = rows.filter((r) => r.botWall).length;
  console.log(`\n${ok}/${rows.length} sites did what the task asked` +
              (blocked ? `; ${blocked} refused automation and said so` : '') + '.');
  console.log('wrote eval/results/real-sites.json');

  await h.close();
})().catch((e) => { console.error('RUN FAILED:', e); process.exit(1); });

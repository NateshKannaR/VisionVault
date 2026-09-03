#!/usr/bin/env node
/**
 * real-sites.js — Runs the agent against real public websites and reports what actually happens.
 *
 * Read-only tasks only: search and navigation. Nothing is purchased, submitted, or logged into.
 * Each site gets a time budget, enforced with the extension's own Stop control.
 *
 * Usage: node eval/real-sites.js [--budget 90]
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, tabIdForPage, seedVault } = require('./lib/harness');

const argv = process.argv.slice(2);
const BUDGET_S = Number((argv[argv.indexOf('--budget') + 1] || 90));
const RESULTS = path.join(__dirname, 'results');

// A focused subset can be run with:  node eval/real-sites.js --only flipkart,github
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i !== -1 && process.argv[i + 1]
    ? process.argv[i + 1].toLowerCase().split(',').map((x) => x.trim())
    : null;
})();

const ALL_SITES = [
  { name: 'Amazon.in',      url: 'https://www.amazon.in',            task: 'search for iqoo neo 6 and show me' },
  { name: 'Flipkart',       url: 'https://www.flipkart.com',         task: 'search for running shoes and show me' },
  { name: 'Wikipedia',      url: 'https://www.wikipedia.org',        task: 'search for quantum computing' },
  { name: 'YouTube',        url: 'https://www.youtube.com',          task: 'search for lofi study music' },
  { name: 'GitHub',         url: 'https://github.com',               task: 'search for onnxruntime' },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com',        task: 'search for webassembly simd' },
  { name: 'MDN',            url: 'https://developer.mozilla.org',    task: 'search for OffscreenCanvas' },
  { name: 'BBC News',       url: 'https://www.bbc.com/news',         task: 'scroll down and show me more headlines' },
  { name: 'Hacker News',    url: 'https://news.ycombinator.com',     task: 'scroll down and show me more stories' },
  { name: 'MakeMyTrip',     url: 'https://www.makemytrip.com',       task: 'search for flights to goa' },
];

const SITES = ONLY
  ? ALL_SITES.filter((s) => ONLY.some((o) => s.name.toLowerCase().includes(o)))
  : ALL_SITES;

const VAULT = { name: 'Ada Lovelace', email: 'ada@localhost.test', phone: '+44 20 7946 0102' };

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
  console.log(`Planner: ${planner} | budget ${BUDGET_S}s per site\n`);

  await seedVault(h.worker, VAULT, {
    redactMode: 'black', serverUrl: 'http://127.0.0.1:8000/api/agent/step',
    confirmPolicy: 'risky', enableOCR: true, enableFaceDetection: true,
  });

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });

  const rows = [];

  for (const site of SITES) {
    const row = { site: site.name, task: site.task };
    console.log(`\n${'='.repeat(72)}\n${site.name} — "${site.task}"\n${'='.repeat(72)}`);

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
      console.log(`  scan:   ${scan.piiCount} PII, ${scan.markCount} marks, ` +
                  `${scan.frameStats.merged}/${scan.frameStats.total} frames, ${scan.timings.total}ms pipeline`);
      console.log(`          sources ${JSON.stringify(scan.sourceBreakdown)}`);
      if (scan.sourceBreakdown && scan.sourceBreakdown.faceOk === false) {
        console.log('          note: the face model produced no verdict, so every image stayed masked (fail-closed)');
      }

      if (scan.preview) {
        const f = path.join(RESULTS, `real-${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
        fs.writeFileSync(f, Buffer.from(scan.preview.split(',')[1], 'base64'));
        row.screenshot = path.basename(f);
      }

      // Run the loop with a hard time budget, enforced via the extension's own Stop control.
      const t1 = Date.now();
      const runPromise = h.worker.evaluate(() => phaseRun());
      const stopper = setTimeout(() => {
        h.worker.evaluate(() => requestStop()).catch(() => {});
      }, BUDGET_S * 1000);

      const run = await Promise.race([
        runPromise,
        new Promise((res) => setTimeout(() => res({ timedOut: true, actionLog: [] }), (BUDGET_S + 30) * 1000)),
      ]);
      clearTimeout(stopper);

      row.runMs = Date.now() - t1;
      row.steps = (run.actionLog || []).length;
      row.stopped = !!run.stopped;
      row.timedOut = !!run.timedOut;
      row.actions = (run.actionLog || []).map((a) => `${a.action}${a.ok === false ? '(failed)' : ''}`);
      row.needsConfirm = !!run.needsConfirm;
      row.needsInput = !!run.needsInput;
      row.agentProgress = run.progress || null;
      row.stopReason = run.error || null;
      // A site that demands human verification is a different result from a site the agent
      // could not work out, and reporting them the same way flatters neither.
      row.botWall = !!run.botWall;

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

      console.log(`  parsed: query=${JSON.stringify(parsed.query)} site=${parsed.siteUrl || '-'}`);
      console.log(`  run:    ${row.steps} step(s) in ${row.runMs}ms ${row.stopped ? '(stopped at budget)' : ''}${row.timedOut ? '(TIMED OUT)' : ''}`);
      console.log(`          actions: ${row.actions.join(', ') || 'none'}`);
      if (row.stopReason) console.log(`          why:     ${row.stopReason}`);
      if (row.agentProgress) console.log(`          agent believes: ${JSON.stringify(row.agentProgress)}`);
      console.log(`  final:  ${row.finalUrl}`);
      if (row.queryOnPage) {
        console.log(`  check:  in a field=${row.queryOnPage.inBox}  in URL=${row.queryOnPage.inUrl}  in title=${row.queryOnPage.inTitle}`);
      }
    } catch (err) {
      row.error = err.message;
      console.log(`  ERROR: ${err.message}`);
    }
    rows.push(row);
  }

  fs.writeFileSync(path.join(RESULTS, 'real-sites.json'),
                   JSON.stringify({ generatedAt: new Date().toISOString(), planner, budgetSeconds: BUDGET_S, sites: rows }, null, 2));

  console.log(`\n\n${'='.repeat(90)}\nSUMMARY\n${'='.repeat(90)}`);
  console.log('site             marks  pii  pipeline  steps  query typed  outcome');
  for (const r of rows) {
    const ok = r.error ? 'ERROR'
      : r.botWall ? 'blocked (human verification)'
      : (r.queryOnPage ? ((r.queryOnPage.inUrl || r.queryOnPage.inBox || r.queryOnPage.inTitle) ? 'search landed' : 'search did NOT land')
                       : (r.urlChanged || r.steps ? 'acted' : 'no action'));
    console.log(
      `${(r.site || '').padEnd(16)} ${String(r.marks ?? '-').padStart(5)} ${String(r.pii ?? '-').padStart(4)} ` +
      `${String(r.pipelineMs ?? '-').padStart(8)}  ${String(r.steps ?? '-').padStart(5)}  ` +
      `${String(r.parsedQuery ?? '-').slice(0, 11).padEnd(11)}  ${ok}`
    );
  }
  console.log(`\nwrote eval/results/real-sites.json`);

  await h.close();
})().catch((e) => { console.error('RUN FAILED:', e); process.exit(1); });

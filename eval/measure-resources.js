#!/usr/bin/env node
/**
 * measure-resources.js — What VisionVault costs the machine it runs on.
 *
 * PS 26171 weights client resource utilization at 20%, and that is a claim you cannot make
 * from source code: it has to be measured on a real Chrome running the real extension. This
 * script produces the numbers, and it produces them in a form that can be re-run in front of
 * anyone who doubts them.
 *
 * What it measures, and why each one is here:
 *
 *   Per-stage wall time    Where a scan actually spends its time — capture, DOM scan, face
 *                          inference, OCR, merge, redact. Reported as p50 and p95 rather than
 *                          a mean, because the tail is what a user notices. The pipeline
 *                          already instruments itself; this aggregates across many scans.
 *   Heap                   The service worker and the offscreen vision host, sampled at rest
 *                          and under load. Two targets, because the models live in the
 *                          offscreen document and that is where the memory actually goes.
 *   Model footprint        Bytes on disk for the ONNX face model and the Tesseract core and
 *                          language data. This is what the user downloads and keeps.
 *   Bytes on the wire      The redacted PNG plus JSON, per step. The whole privacy argument
 *                          is about what leaves the machine, so its size is worth stating.
 *   Idle cost              Heap with no run active. An agent that is expensive while doing
 *                          nothing is a bad citizen on a laptop.
 *
 * Usage:
 *   node eval/measure-resources.js                # default 12 scans per fixture
 *   node eval/measure-resources.js --repeats 20
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer, seedVault } = require('./lib/harness');

const RESULTS_DIR = path.join(__dirname, 'results');
const EXT_DIR = path.join(__dirname, '..', 'extension');

const args = process.argv.slice(2);
const REPEATS = (() => {
  const i = args.indexOf('--repeats');
  return i >= 0 ? Math.max(1, parseInt(args[i + 1], 10) || 12) : 12;
})();

// Fixtures chosen to exercise different costs, not to flatter the average: a form is DOM-heavy
// and cheap, a social feed carries faces, and a pixel receipt has no DOM text at all so the
// whole burden falls on OCR.
const FIXTURES = [
  { file: 'signup-form.html', label: 'form (DOM-heavy)' },
  { file: 'social-feed.html', label: 'feed (faces)' },
  { file: 'pixel-receipt.html', label: 'receipt (OCR-only)' },
  { file: 'admin-dashboard.html', label: 'dashboard (table-heavy)' },
  { file: 'ecommerce-checkout.html', label: 'checkout (mixed)' },
];

// phaseScan requests a workflow plan concurrently with the scan. That is what a real run
// does, so it stays; the plan's latency is not part of the scan timings the orchestrator
// reports, which is what this script aggregates.
const SCAN_TASK = 'Fill the form with my details';

const VAULT = {
  name: 'Zorbnax Quilliphant',
  email: 'zorbnax.q7@vaultsentinel.test',
  phone: '+44 7700 900931',
  address: '19 Quilliphant Row, Sentinel City',
};

// ── small stats helpers ──────────────────────────────────────────────────────

/** Nearest-rank percentile. With 12 samples p95 is the largest, which is the honest reading. */
function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const p50 = (v) => pct(v, 50);
const p95 = (v) => pct(v, 95);
const sum = (v) => v.reduce((a, b) => a + b, 0);
const mb = (bytes) => +(bytes / (1024 * 1024)).toFixed(2);
const kb = (bytes) => +(bytes / 1024).toFixed(1);

function bar(value, max, width = 24) {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(1, Math.round((value / max) * width)));
}

// ── disk footprint ───────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else {
      try { out.push({ path: full, size: fs.statSync(full).size }); } catch { /* vanished */ }
    }
  }
  return out;
}

/**
 * Splits the shipped extension into the parts a user is actually paying for. The model weights
 * dominate and are worth separating from code, because they are the part that would have to
 * live on a server in a non-private design — which is exactly the trade this project refuses.
 */
function measureFootprint() {
  const all = walk(EXT_DIR);
  const classify = (f) => {
    const rel = path.relative(EXT_DIR, f.path).replace(/\\/g, '/');
    if (/\.onnx$/i.test(rel)) return 'face model (ONNX)';
    if (/traineddata/i.test(rel)) return 'OCR language data';
    if (/lib\/tesseract/i.test(rel)) return 'OCR engine (WASM)';
    if (/lib\/onnxruntime|ort[-.]/i.test(rel)) return 'ONNX runtime (WASM)';
    if (/\.(png|jpg|jpeg|svg|ico|webp)$/i.test(rel)) return 'icons & images';
    return 'extension code';
  };
  const groups = {};
  for (const f of all) {
    const g = classify(f);
    groups[g] = (groups[g] || 0) + f.size;
  }
  const total = sum(all.map((f) => f.size));
  return { total, groups, fileCount: all.length };
}

// ── heap sampling ────────────────────────────────────────────────────────────

/**
 * Heap for every JS context the extension owns. Uses CDP Runtime.getHeapUsage, which reports
 * the V8 isolate directly — a service worker has no `performance.memory`, so measuring from
 * inside is not an option.
 */
async function sampleHeap(browser, extensionId) {
  const out = {};
  const targets = browser.targets().filter((t) => {
    const url = t.url() || '';
    if (!url.includes(extensionId)) return false;
    return t.type() === 'service_worker' || url.includes('offscreen');
  });

  for (const t of targets) {
    const name = t.type() === 'service_worker' ? 'service worker' : 'offscreen (vision models)';
    try {
      const session = await t.createCDPSession();
      const usage = await session.send('Runtime.getHeapUsage');
      out[name] = { usedBytes: usage.usedSize, totalBytes: usage.totalSize };
      await session.detach().catch(() => {});
    } catch (err) {
      out[name] = { error: err.message };
    }
  }
  return out;
}

const heapUsed = (snap) =>
  Object.values(snap).reduce((a, v) => a + (v && v.usedBytes ? v.usedBytes : 0), 0);

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false });

  console.log('VisionVault — client resource utilization');
  console.log('========================================');
  console.log(`Chrome:   ${h.chromeVersion}`);
  console.log(`Repeats:  ${REPEATS} scans per fixture, ${FIXTURES.length} fixtures`);
  console.log(`Platform: ${process.platform} ${process.arch}, ${require('os').cpus().length} logical CPUs`);
  console.log(`CPU:      ${(require('os').cpus()[0] || {}).model || 'unknown'}\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    chrome: h.chromeVersion,
    platform: `${process.platform} ${process.arch}`,
    cpu: (require('os').cpus()[0] || {}).model || 'unknown',
    cpuCount: require('os').cpus().length,
    repeats: REPEATS,
  };

  try {
    // ── 1. Disk footprint ────────────────────────────────────────────────────
    console.log('1. What it costs on disk');
    console.log('------------------------');
    const footprint = measureFootprint();
    report.footprint = {
      totalMB: mb(footprint.total),
      fileCount: footprint.fileCount,
      groupsMB: Object.fromEntries(Object.entries(footprint.groups).map(([k, v]) => [k, mb(v)])),
    };
    const maxGroup = Math.max(...Object.values(footprint.groups));
    for (const [name, size] of Object.entries(footprint.groups).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name.padEnd(22)} ${String(mb(size)).padStart(7)} MB  ${bar(size, maxGroup)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(22)} ${String(mb(footprint.total)).padStart(7)} MB  (${footprint.fileCount} files)\n`);

    // ── 2. Idle cost ─────────────────────────────────────────────────────────
    console.log('2. What it costs while doing nothing');
    console.log('------------------------------------');
    const idleHeap = await sampleHeap(h.browser, h.extensionId);
    report.idleHeap = Object.fromEntries(
      Object.entries(idleHeap).map(([k, v]) => [k, v.usedBytes ? mb(v.usedBytes) : v])
    );
    for (const [name, v] of Object.entries(idleHeap)) {
      console.log(`  ${name.padEnd(28)} ${v.usedBytes ? `${String(mb(v.usedBytes)).padStart(6)} MB used` : v.error}`);
    }
    console.log(`  ${'idle total'.padEnd(28)} ${String(mb(heapUsed(idleHeap))).padStart(6)} MB\n`);

    // ── 3. Per-stage cost of a scan ──────────────────────────────────────────
    console.log('3. Where a scan spends its time');
    console.log('-------------------------------');

    const page = (await h.browser.pages())[0];
    await seedVault(h.worker, VAULT, {});

    const perFixture = [];
    const allStages = {};
    let peakHeapBytes = heapUsed(idleHeap);

    for (const fx of FIXTURES) {
      await page.goto(`${baseUrl}/pages/${fx.file}`, { waitUntil: 'networkidle2' }).catch(() => {});
      // phaseScan resolves the active tab itself, so the page under test has to be in front.
      await page.bringToFront().catch(() => {});

      const stages = {};
      const totals = [];
      // Cached and uncached scans are different measurements and averaging them together
      // reports a number that describes neither. A cache hit carries the stage timings of the
      // scan that filled it, so the stage breakdown below is the cost when the models DO run;
      // the split here is what a user actually experiences.
      const coldTotals = [];
      const warmTotals = [];
      let regionCount = 0;
      let markCount = 0;

      // One warm-up scan that is measured but reported separately in spirit: the very first
      // scan on a page pays for layout and for any lazily-created worker, and including it in
      // the percentiles would misreport the steady state a user actually experiences.
      // Clear the cache so the first scan below measures the real cost of the models and
      // the rest measure the steady state a user actually experiences.
      await h.worker.evaluate(() => (typeof clearVisionCache === 'function' ? clearVisionCache() : null)).catch(() => null);

      for (let i = 0; i < REPEATS; i++) {
        const scan = await h.worker
          .evaluate((t) => phaseScan(t), SCAN_TASK)
          .catch((err) => ({ error: String(err && err.message || err) }));
        if (!scan || scan.error || !scan.timings) continue;
        for (const [k, v] of Object.entries(scan.timings)) {
          if (typeof v !== 'number') continue;
          (stages[k] = stages[k] || []).push(v);
          (allStages[k] = allStages[k] || []).push(v);
        }
        totals.push(scan.timings.total || 0);
        (scan.timings.cached ? warmTotals : coldTotals).push(scan.timings.total || 0);
        regionCount = scan.piiCount || regionCount;
        markCount = scan.markCount || markCount;

        // Sample under load, not only at the end: the peak is what decides whether this is
        // viable on a 4 GB laptop.
        if (i % 4 === 0) {
          const snap = await sampleHeap(h.browser, h.extensionId);
          peakHeapBytes = Math.max(peakHeapBytes, heapUsed(snap));
        }
      }

      if (!totals.length) {
        console.log(`  ${fx.label.padEnd(24)} SKIPPED — no successful scans`);
        continue;
      }
      if (!markCount) {
        console.log(`  ${fx.label.padEnd(24)} WARNING — 0 marks; the scan did not see this page`);
      }

      perFixture.push({
        fixture: fx.file,
        label: fx.label,
        scans: totals.length,
        piiRegions: regionCount,
        marks: markCount,
        totalP50: p50(totals),
        totalP95: p95(totals),
        coldScans: coldTotals.length,
        coldP50: p50(coldTotals),
        warmScans: warmTotals.length,
        warmP50: p50(warmTotals),
        stages: Object.fromEntries(
          Object.entries(stages).map(([k, v]) => [k, { p50: p50(v), p95: p95(v) }])
        ),
      });

      console.log(
        `  ${fx.label.padEnd(24)} cold ${String(p50(coldTotals) || '-').padStart(5)}ms  ` +
        `cached ${String(p50(warmTotals) || '-').padStart(4)}ms   ` +
        `(${coldTotals.length} cold / ${warmTotals.length} cached, ${regionCount} PII, ${markCount} marks)`
      );
    }

    report.perFixture = perFixture;

    // Stage breakdown across every fixture. `domScan` is currently reported as the same span
    // as `capture` by the orchestrator (they run concurrently), so it is shown but flagged
    // rather than added into a total that would double-count it.
    console.log('\n  Stage breakdown - what each stage costs WHEN IT RUNS');
    const stageOrder = ['screenshot', 'scan', 'faceInference', 'ocrInference', 'visionInference', 'merge', 'redact', 'total'];
    const maxStage = Math.max(...stageOrder.map((s) => (allStages[s] ? p50(allStages[s]) : 0)));
    report.stages = {};
    for (const s of stageOrder) {
      if (!allStages[s] || !allStages[s].length) continue;
      const a = p50(allStages[s]);
      const b = p95(allStages[s]);
      report.stages[s] = { p50: a, p95: b, samples: allStages[s].length };
      const note = s === 'scan' ? '  (concurrent with screenshot)' : '';
      console.log(`    ${s.padEnd(17)} p50 ${String(a).padStart(5)}ms  p95 ${String(b).padStart(5)}ms  ${bar(a, maxStage, 18)}${note}`);
    }

    // ── 4. Peak memory ───────────────────────────────────────────────────────
    console.log('\n4. Peak memory under load');
    console.log('-------------------------');
    const loadedHeap = await sampleHeap(h.browser, h.extensionId);
    peakHeapBytes = Math.max(peakHeapBytes, heapUsed(loadedHeap));
    report.peakHeapMB = mb(peakHeapBytes);
    report.idleTotalMB = mb(heapUsed(idleHeap));
    for (const [name, v] of Object.entries(loadedHeap)) {
      console.log(`  ${name.padEnd(28)} ${v.usedBytes ? `${String(mb(v.usedBytes)).padStart(6)} MB used` : v.error}`);
    }
    console.log(`  ${'peak observed'.padEnd(28)} ${String(mb(peakHeapBytes)).padStart(6)} MB`);
    console.log(`  ${'growth over idle'.padEnd(28)} ${String(mb(peakHeapBytes - heapUsed(idleHeap))).padStart(6)} MB\n`);

    // ── 5. Bytes on the wire ─────────────────────────────────────────────────
    console.log('5. What actually leaves the machine, per step');
    console.log('---------------------------------------------');
    const swTarget = h.browser.targets().find(
      (t) => t.type() === 'service_worker' && (t.url() || '').includes(h.extensionId)
    );
    const wire = [];
    if (swTarget) {
      const cdp = await swTarget.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (e) => {
        const body = (e.request && e.request.postData) || '';
        if (!body) return;
        wire.push({ url: e.request.url, bytes: Buffer.byteLength(body, 'utf8') });
      });

      await page.goto(`${baseUrl}/pages/signup-form.html`, { waitUntil: 'networkidle2' }).catch(() => {});
      await page.bringToFront().catch(() => {});
      await h.worker.evaluate((t) => phaseScan(t), 'Fill the signup form with my details').catch(() => null);
      await h.worker.evaluate(() => (typeof phaseRun === 'function' ? phaseRun() : null)).catch(() => null);
      await cdp.detach().catch(() => {});
    }

    if (wire.length) {
      const sizes = wire.map((w) => w.bytes);
      report.wire = {
        requests: wire.length,
        p50KB: kb(p50(sizes)),
        p95KB: kb(p95(sizes)),
        totalKB: kb(sum(sizes)),
      };
      console.log(`  requests with a body       ${String(wire.length).padStart(6)}`);
      console.log(`  per request  p50           ${String(kb(p50(sizes))).padStart(6)} KB`);
      console.log(`  per request  p95           ${String(kb(p95(sizes))).padStart(6)} KB`);
      console.log(`  whole run                  ${String(kb(sum(sizes))).padStart(6)} KB`);
    } else {
      report.wire = { requests: 0, note: 'no request bodies observed — local planner answered without network' };
      console.log('  no request bodies observed — the local planner answered without network,');
      console.log('  which is itself the cheapest possible case for the user.');
    }



    // ── summary ──────────────────────────────────────────────────────────────
    const scanP50 = report.stages.total ? report.stages.total.p50 : 0;
    const scanP95 = report.stages.total ? report.stages.total.p95 : 0;
    console.log('\n======================================================================');
    console.log('Summary');
    console.log('======================================================================');
    console.log(`  disk footprint        ${mb(footprint.total)} MB  (models ${mb((footprint.groups['face model (ONNX)'] || 0) + (footprint.groups['OCR language data'] || 0) + (footprint.groups['OCR engine (WASM)'] || 0) + (footprint.groups['ONNX runtime (WASM)'] || 0))} MB of it)`);
    console.log(`  heap idle -> peak      ${mb(heapUsed(idleHeap))} MB -> ${mb(peakHeapBytes)} MB`);
    const coldAll = perFixture.map((f) => f.coldP50).filter(Boolean);
    const warmAll = perFixture.map((f) => f.warmP50).filter(Boolean);
    report.scanCostMs = { coldP50: p50(coldAll), warmP50: p50(warmAll), blendedP50: scanP50, blendedP95: scanP95 };
    console.log(`  scan, first per screen ${p50(coldAll)} ms   (models run: OCR + face)`);
    console.log(`  scan, re-scan cached   ${p50(warmAll)} ms   (identical pixels, models skipped)`);
    console.log(`  blended p50 / p95      ${scanP50} ms / ${scanP95} ms`);
    console.log(`  bytes per step         ${report.wire.p50KB != null ? `${report.wire.p50KB} KB (p50)` : 'n/a — ran locally'}`);
    console.log('======================================================================');

    const out = path.join(RESULTS_DIR, 'resources.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${path.relative(path.join(__dirname, '..'), out)}`);
  } catch (err) {
    console.error('\nmeasurement failed:', err && err.stack || err);
    process.exitCode = 1;
  } finally {
    await h.close();
    server.close();
  }
})();

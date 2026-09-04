#!/usr/bin/env node
/**
 * run-full-eval.js — LIVE evaluation of the VisionVault client pipeline.
 *
 * This script measures. It does not estimate, and it contains no pre-set scores.
 *
 * What it does:
 *   1. Launches a real Chrome window and installs extension/ unpacked (see lib/harness.js).
 *   2. Serves eval/pages/ over http://127.0.0.1 and opens each of the 5 annotated fixtures.
 *   3. Reads ground truth from the fixtures' own data-gt-* attributes, using the elements'
 *      real rendered geometry in the live layout — across the top document AND same-origin
 *      iframes, mapped into top-level viewport coordinates.
 *   4. Calls the extension service worker's own scanAndRedact() for that tab, so the numbers
 *      come from the shipped pipeline: DOM scan, UltraFace ONNX, Tesseract OCR, region merge,
 *      OffscreenCanvas redaction.
 *   5. Decodes the returned redacted PNG and samples the actual pixels inside every ground
 *      truth region to verify masking (the leak check is pixels, not bookkeeping).
 *   6. Runs one end-to-end agent task (scan -> plan -> execute) and times it.
 *
 * Output: eval/results/live-eval.json  (then run `node eval/generate-report.js`)
 *
 * Usage:
 *   node eval/run-full-eval.js                 # 3 repeats per page (default)
 *   node eval/run-full-eval.js --repeats 5
 *   node eval/run-full-eval.js --mode blur     # evaluate mosaic redaction instead of black
 *   node eval/run-full-eval.js --keep-open     # leave the browser open at the end
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer, tabIdForPage, seedVault } = require('./lib/harness');
const { decodePNG, decodeDataUrl, regionStats, inkSurvival } = require('./lib/png');
const M = require('./lib/metrics');

const RESULTS_DIR = path.join(__dirname, 'results');
const PAGES = [
  { file: 'signup-form.html', label: 'Signup form', kind: 'form' },
  { file: 'admin-dashboard.html', label: 'Admin dashboard', kind: 'dashboard' },
  { file: 'ecommerce-checkout.html', label: 'E-commerce checkout', kind: 'ecommerce' },
  { file: 'survey-form.html', label: 'Registration survey', kind: 'form' },
  { file: 'social-feed.html', label: 'Social feed (+ same-origin iframe)', kind: 'social' },
  { file: 'pixel-receipt.html', label: 'Pixel-only receipt (DOM blind spot)', kind: 'pixel-only' },
  { file: 'shop-results.html', label: 'Product results (multi-step journey)', kind: 'ecommerce' },
];

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const REPEATS = Math.max(1, parseInt(argVal('--repeats', '3'), 10));
const REDACT_MODE = argVal('--mode', 'black');
const KEEP_OPEN = argv.includes('--keep-open');

// Matching threshold: a prediction counts as covering a ground-truth region when it hides at
// least this share of it. Redaction is asymmetric — a mask larger than the region still hides
// the data — so IoU is reported separately as the tightness measure rather than used to match.
const COVER_THRESHOLD = 0.5;

// Minimum gap between scans of the same tab, to stay under Chrome's captureVisibleTab quota.
const CAPTURE_SPACING_MS = 900;

// ── Ground truth, read from the live layout ──────────────────────────────────
// Evaluated inside every same-origin frame; boxes come back in TOP-LEVEL viewport coordinates.
function collectGroundTruth() {
  let offX = 0, offY = 0;
  try {
    let w = window;
    while (w !== w.top) {
      const fe = w.frameElement;
      if (!fe) return null; // cross-origin: not mappable
      const r = fe.getBoundingClientRect();
      const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      offX += r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      offY += r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
      w = w.parent;
    }
  } catch (_) {
    return null;
  }

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + offX), y: Math.round(r.top + offY),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const b = box(el);
    return b.w >= 4 && b.h >= 4;
  };

  const pii = [];
  const safe = [];
  const marks = [];

  document.querySelectorAll('[data-gt-pii]').forEach((el) => {
    if (!visible(el)) return;
    pii.push({ type: el.getAttribute('data-gt-pii'), tag: el.tagName.toLowerCase(), ...box(el) });
  });
  document.querySelectorAll('[data-gt-safe]').forEach((el) => {
    if (!visible(el)) return;
    safe.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 40), ...box(el) });
  });
  document.querySelectorAll('[data-gt-mark]').forEach((el) => {
    if (!visible(el)) return;
    marks.push({ role: el.getAttribute('data-gt-mark'), tag: el.tagName.toLowerCase(), ...box(el) });
  });

  return { pii, safe, marks, isTop: window === window.top, frameUrl: location.href };
}

/** Clips a box to the viewport; returns null if it falls outside entirely. */
function clipToViewport(b, vpW, vpH) {
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
  const x1 = Math.min(vpW, b.x + b.w), y1 = Math.min(vpH, b.y + b.h);
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  return { ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

async function gatherGroundTruth(page, vpW, vpH) {
  const pii = [], safe = [], marks = [];
  let framesSeen = 0, framesMapped = 0;

  for (const frame of page.frames()) {
    framesSeen++;
    let res = null;
    try {
      res = await frame.evaluate(collectGroundTruth);
    } catch (_) {
      continue; // detached or cross-origin frame
    }
    if (!res) continue;
    framesMapped++;
    for (const p of res.pii) { const c = clipToViewport(p, vpW, vpH); if (c) pii.push(c); }
    for (const s of res.safe) { const c = clipToViewport(s, vpW, vpH); if (c) safe.push(c); }
    for (const m of res.marks) { const c = clipToViewport(m, vpW, vpH); if (c) marks.push(c); }
  }
  return { pii, safe, marks, framesSeen, framesMapped };
}

// ── One scan of one page through the extension's own pipeline ────────────────
async function runScan(worker, tabInfo, vpW, vpH, dpr, opts = {}) {
  const enableOCR = opts.enableOCR !== false;
  const enableFaceDetection = opts.enableFaceDetection !== false;
  return worker.evaluate(
    async (tabId, windowId, redactMode, viewportWidth, viewportHeight, devicePixelRatio, ocrOn, faceOn) => {
      const t0 = performance.now();
      const r = await scanAndRedact(tabId, windowId, {
        redactMode, viewportWidth, viewportHeight, devicePixelRatio,
        enableOCR: ocrOn, enableFaceDetection: faceOn,
      });
      return {
        wallMs: Math.round(performance.now() - t0),
        redactedImage: r.redactedImage,
        redactionOk: r.redactionOk !== false,
        redactionError: r.redactionError || null,
        regions: r.regions || [],
        marks: r.marks || [],
        sourceBreakdown: r.sourceBreakdown || {},
        frameStats: r.frameStats || {},
        timings: r.timings || {},
      };
    },
    tabInfo.tabId, tabInfo.windowId, REDACT_MODE, vpW, vpH, dpr, enableOCR, enableFaceDetection
  );
}

// ── Scoring ──────────────────────────────────────────────────────────────────
function scoreScan(gt, scan, vpW, vpH) {
  const regions = (scan.regions || []).map((r) => ({
    x: r.x, y: r.y, w: r.w, h: r.h, source: r.source, reason: r.reason, label: r.label,
  }));

  // --- PII detection: recall / precision against annotated ground truth ---
  const det = M.matchDetections(gt.pii, regions, COVER_THRESHOLD);
  const recall = M.safeDiv(det.truePositives, gt.pii.length);

  // A prediction is a false positive only if it hides something the fixture marked SAFE.
  // Unmatched predictions that overlap nothing annotated (page chrome, decorative media) are
  // neither credited nor penalised — the fixture makes no claim about them.
  let harmfulFp = 0;
  const overRedactedSafe = [];
  regions.forEach((p, pi) => {
    if (det.matchedPred.has(pi)) return;
    const hit = gt.safe.find((s) => M.coverage(s, p) >= COVER_THRESHOLD);
    if (hit) { harmfulFp++; overRedactedSafe.push({ safe: hit, pred: p }); }
  });
  const precision = M.safeDiv(det.truePositives, det.truePositives + harmfulFp);

  // --- Redaction precision: how tightly masks hug the regions, and how much extra is hidden ---
  const matchedIoUs = det.matches.map((m) => m.iou);
  const totalRegionArea = regions.reduce((a, r) => a + M.area(r), 0);
  const gtArea = gt.pii.reduce((a, r) => a + M.area(r), 0);
  const viewportArea = vpW * vpH;

  // --- Visual-context accuracy: are the interactive elements tagged, and tagged correctly? ---
  const gtMarks = gt.marks;
  const predMarks = (scan.marks || []).map((m) => ({ ...m.box, role: m.role, id: m.id }));
  const markMatch = M.matchDetections(gtMarks, predMarks, COVER_THRESHOLD);
  let roleCorrect = 0;
  for (const m of markMatch.matches) {
    if (gtMarks[m.ti].role === predMarks[m.pi].role) roleCorrect++;
  }
  const markRecall = M.safeDiv(markMatch.truePositives, gtMarks.length);
  const roleAccuracy = M.safeDiv(roleCorrect, markMatch.truePositives);
  const markIoU = M.mean(markMatch.matches.map((m) => m.iou));

  // Which detector actually covered each ground-truth region? A region covered only by
  // OCR-sourced predictions would have leaked without OCR; that count is what justifies (or
  // fails to justify) the OCR stage's cost on a given page.
  const coveredBy = { dom: 0, vision_ocr: 0, vision_face: 0, ocrOnly: 0, faceOnly: 0, uncovered: 0 };
  for (const truth of gt.pii) {
    const sources = new Set();
    for (const pred of regions) {
      if (M.coverage(truth, pred) < COVER_THRESHOLD) continue;
      for (const src of String(pred.source || 'dom').split(',')) sources.add(src.trim());
    }
    if (sources.size === 0) { coveredBy.uncovered++; continue; }
    if (sources.has('dom')) coveredBy.dom++;
    if (sources.has('vision_ocr')) coveredBy.vision_ocr++;
    if (sources.has('vision_face')) coveredBy.vision_face++;
    if (sources.has('vision_ocr') && !sources.has('dom') && !sources.has('vision_face')) coveredBy.ocrOnly++;
    if (sources.has('vision_face') && !sources.has('dom') && !sources.has('vision_ocr')) coveredBy.faceOnly++;
  }

  return {
    coveredBy,
    pii: {
      truth: gt.pii.length,
      detected: regions.length,
      truePositives: det.truePositives,
      falseNegatives: det.falseNegatives,
      harmfulFalsePositives: harmfulFp,
      recall, precision,
      meanIoU: M.mean(matchedIoUs),
      misses: gt.pii.filter((_, i) => !det.matchedTruth.has(i)).map((t) => ({ type: t.type, ...t })),
      overRedactedSafe: overRedactedSafe.slice(0, 6).map((o) => ({
        text: o.safe.text, tag: o.safe.tag, maskedBy: o.pred.reason || o.pred.source,
      })),
    },
    redaction: {
      maskedAreaPx: totalRegionArea,
      truthAreaPx: gtArea,
      maskedShareOfViewport: totalRegionArea / viewportArea,
      areaInflation: gtArea > 0 ? totalRegionArea / gtArea : null,
    },
    visualContext: {
      truthMarks: gtMarks.length,
      reportedMarks: predMarks.length,
      matched: markMatch.truePositives,
      missed: markMatch.falseNegatives,
      recall: markRecall,
      roleAccuracy,
      meanIoU: markIoU,
      missedMarks: gtMarks.filter((_, i) => !markMatch.matchedTruth.has(i)).map((m) => ({ role: m.role, tag: m.tag })),
    },
    sourceBreakdown: scan.sourceBreakdown,
    frameStats: scan.frameStats,
    timings: scan.timings,
    wallMs: scan.wallMs,
  };
}

/**
 * Pixel-level leak check: decode the redacted PNG and sample every ground-truth region.
 * `black` mode expects near-black pixels; `blur` mode expects the region's detail to collapse,
 * so it is judged on variance instead.
 */
function checkPixels(gt, scan, vpW, vpH, mode, referenceImage) {
  if (!scan.redactedImage) {
    return { ok: false, note: 'no redacted image returned', regions: [], leaks: gt.pii.length };
  }
  const img = decodeDataUrl(scan.redactedImage);
  const sx = img.width / vpW;
  const sy = img.height / vpH;

  const rows = gt.pii.map((t) => {
    const st = regionStats(img, { x: t.x * sx, y: t.y * sy, w: t.w * sx, h: t.h * sy });

    // Primary test: did any of this region's original ink survive into the redacted frame?
    // Falls back to a coverage test only if no reference capture was available.
    let survival = null;
    let masked;
    if (referenceImage) {
      survival = inkSurvival(referenceImage, img, t, { viewportWidth: vpW, viewportHeight: vpH });
      masked = !survival.leaked;
    } else {
      masked = mode === 'blur' ? st.variance < 120 : st.maskedFraction >= 0.98;
    }

    return {
      type: t.type, box: { x: t.x, y: t.y, w: t.w, h: t.h },
      maskedFraction: Number(st.maskedFraction.toFixed(4)),
      variance: Number(st.variance.toFixed(1)),
      sampled: st.sampled,
      inkPixels: survival ? survival.inkPixels : null,
      survivingInk: survival ? Number(survival.unchangedInkFraction.toFixed(4)) : null,
      masked,
    };
  });

  // Sanity: at least one SAFE region must remain legible, otherwise "everything is black" would
  // trivially pass the leak check and the image would be useless to the planner.
  const safeRows = gt.safe.slice(0, 12).map((s) => {
    const st = regionStats(img, { x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy });
    return { text: s.text, maskedFraction: Number(st.maskedFraction.toFixed(4)), variance: Number(st.variance.toFixed(1)) };
  });
  const legibleSafe = safeRows.filter((r) => r.maskedFraction < 0.5).length;

  return {
    ok: true,
    imageSize: { width: img.width, height: img.height },
    scale: { sx: Number(sx.toFixed(3)), sy: Number(sy.toFixed(3)) },
    regions: rows,
    leaks: rows.filter((r) => !r.masked).length,
    leakTest: referenceImage ? 'ink-survival vs unredacted reference' : 'coverage-only (no reference capture)',
    meanSurvivingInk: M.mean(rows.map((r) => r.survivingInk).filter((v) => v !== null)),
    meanMaskedFraction: M.mean(rows.map((r) => r.maskedFraction)),
    safeSampled: safeRows.length,
    safeLegible: legibleSafe,
  };
}

// ── End-to-end agent task ────────────────────────────────────────────────────
async function runEndToEnd(worker, page, baseUrl, serverUrl) {
  await page.goto(`${baseUrl}/pages/signup-form.html`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => window.scrollTo(0, 0));

  // Wipe the pre-filled fixture values so the agent has real work to do.
  await page.evaluate(() => {
    ['fullName', 'email', 'phone', 'username', 'password', 'address'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  });

  const t0 = Date.now();
  const scanRes = await worker.evaluate((task) => phaseScan(task), 'Fill the signup form with my details');
  const scanMs = Date.now() - t0;

  const t1 = Date.now();
  const runRes = await worker.evaluate(() => phaseRun());
  const runMs = Date.now() - t1;

  const filled = await page.evaluate(() => ({
    fullName: document.getElementById('fullName').value,
    email: document.getElementById('email').value,
    phone: document.getElementById('phone').value,
    username: document.getElementById('username').value,
    password: document.getElementById('password').value ? '(non-empty)' : '',
    address: document.getElementById('address').value,
  }));

  return {
    serverUrl,
    scanMs, runMs, totalMs: scanMs + runMs,
    piiCount: scanRes.piiCount,
    markCount: scanRes.markCount,
    scanTimings: scanRes.timings,
    steps: (runRes.actionLog || []).length,
    actionLog: runRes.actionLog || [],
    needsConfirm: !!runRes.needsConfirm,
    confirmReason: runRes.confirmReason || null,
    done: !!runRes.done,
    fieldsAfterRun: filled,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log('VisionVault live evaluation');
  console.log('===========================');

  const { server, baseUrl } = await startFixtureServer();
  console.log(`Fixture server: ${baseUrl}`);

  const h = await launchWithExtension({ headless: false });
  console.log(`Chrome:    ${h.chromeVersion}`);
  console.log(`Extension: ${h.extensionId} (unpacked from extension/)`);

  // A local server is optional. Without one the extension's built-in deterministic planner
  // drives the loop; either way the run is real, and the report says which was used.
  let serverUrl = 'http://127.0.0.1:8000/api/agent/step';
  let serverBackend = 'unreachable (extension used its local deterministic planner)';
  try {
    const res = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    serverBackend = `${j.backend} (chain: ${(j.chain || []).join(' -> ')})`;
  } catch (_) {}
  console.log(`Planner:   ${serverBackend}`);

  await seedVault(
    h.worker,
    {
      name: 'Ada Lovelace', email: 'ada@localhost.test', phone: '+44 20 7946 0102',
      address: '12 Analytical Way, London', username: 'ada', password: 'EngineNo1!', company: 'AE',
    },
    { redactMode: REDACT_MODE, serverUrl, confirmPolicy: 'risky' }
  );

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1200, height: 820, deviceScaleFactor: 1 });

  const pageResults = [];

  for (const fixture of PAGES) {
    process.stdout.write(`\n[${fixture.file}] `);
    await page.goto(`${baseUrl}/pages/${fixture.file}`, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all(
      Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))
    ));
    // Fixtures that build their ground-truth markers asynchronously announce readiness.
    await page.waitForFunction(
      () => !document.querySelector('script[src], body[data-gt-pending]') || true
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));

    const view = await page.evaluate(() => ({
      vpW: window.innerWidth, vpH: window.innerHeight, dpr: window.devicePixelRatio || 1,
    }));
    const tabInfo = await tabIdForPage(h.worker, page);
    if (!tabInfo) throw new Error(`Could not resolve tabId for ${fixture.file}`);

    // Re-anchor before every scan: scroll to a known position, then read ground truth from
    // the live layout, so ground truth and the scan always describe the same pixels.
    const anchorAndReadGroundTruth = async () => {
      // captureVisibleTab only captures the FOREGROUND tab of the window, so the fixture must
      // be the active tab for the screenshot and the DOM scan to describe the same page.
      await page.bringToFront();
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 120));
      return gatherGroundTruth(page, view.vpW, view.vpH);
    };

    const gt0 = await anchorAndReadGroundTruth();
    process.stdout.write(`gt: ${gt0.pii.length} PII / ${gt0.safe.length} safe / ${gt0.marks.length} marks `);
    process.stdout.write(`(${gt0.framesMapped}/${gt0.framesSeen} frames) `);

    const runs = [];
    const idSets = [];
    const shotPath = path.join(RESULTS_DIR, `redacted-${fixture.file.replace('.html', '')}.png`);

    for (let i = 0; i < REPEATS; i++) {
      // chrome.tabs.captureVisibleTab is rate limited to ~2 calls/second; pace the repeats so
      // every scan captures a real frame rather than hitting the quota.
      if (i > 0) await new Promise((r) => setTimeout(r, CAPTURE_SPACING_MS));
      const gt = await anchorAndReadGroundTruth();
      const stateBefore = await page.evaluate(() => ({
        scrollY: window.scrollY, scrollX: window.scrollX,
        vpW: window.innerWidth, vpH: window.innerHeight,
      }));
      // Unredacted reference, captured by the HARNESS (not the extension) purely so the leak
      // test can tell "painted over" from "left untouched". It is never transmitted anywhere.
      const referenceImage = decodePNG(await page.screenshot({ type: 'png' }));
      const scan = await runScan(h.worker, tabInfo, view.vpW, view.vpH, view.dpr);
      if (!scan.redactionOk) {
        console.log(`\n  ! redaction reported failure: ${scan.redactionError}`);
      }
      const scored = scoreScan(gt, scan, view.vpW, view.vpH);
      const pixels = checkPixels(gt, scan, view.vpW, view.vpH, REDACT_MODE, referenceImage);
      const diag = {
        stateBefore,
        regionCount: (scan.regions || []).length,
        markCount: (scan.marks || []).length,
        imageBytes: (scan.redactedImage || '').length,
        imageSize: pixels.imageSize || null,
        frameStats: scan.frameStats,
        sourceBreakdown: scan.sourceBreakdown,
        regionSample: (scan.regions || []).slice(0, 3).map((r) => `${r.reason}@${r.x},${r.y},${r.w}x${r.h}`),
        markSample: (scan.marks || []).slice(0, 3).map((m) => `${m.role}@${m.box.x},${m.box.y},${m.box.w}x${m.box.h}`),
        gtSample: gt.pii.slice(0, 3).map((t) => `${t.type}@${t.x},${t.y},${t.w}x${t.h}`),
      };
      if (scored.pii.recall === 0 || scored.visualContext.recall === 0) {
        console.log('\n  ZERO-MATCH RUN diagnostics:\n   ' + JSON.stringify(diag, null, 2).replace(/\n/g, '\n   '));
      }
      runs.push({ ...scored, pixels, redactionOk: scan.redactionOk, diag });

      // Deterministic-ID check: the same page must yield the same mark IDs on every scan.
      idSets.push((scan.marks || []).map((m) => m.id).sort((a, b) => a - b).join(','));

      // Keep the first redacted frame as visual evidence of the run.
      if (i === 0 && scan.redactedImage) {
        fs.writeFileSync(shotPath, Buffer.from(scan.redactedImage.split(',')[1], 'base64'));
      }
      process.stdout.write('.');
    }

    const idsStable = idSets.length > 1 && idSets[0].length > 0 && idSets.every((v) => v === idSets[0]);

    // Fast profile: same page, same pipeline, OCR switched off. This is what makes the
    // latency/accuracy trade-off in the report a measurement rather than an assertion.
    await new Promise((r) => setTimeout(r, CAPTURE_SPACING_MS));
    const gtFast = await anchorAndReadGroundTruth();
    const fastReference = decodePNG(await page.screenshot({ type: 'png' }));
    const fastScan = await runScan(h.worker, tabInfo, view.vpW, view.vpH, view.dpr, { enableOCR: false });
    const fastScored = scoreScan(gtFast, fastScan, view.vpW, view.vpH);
    const fastPixels = checkPixels(gtFast, fastScan, view.vpW, view.vpH, REDACT_MODE, fastReference);

    const agg = {
      file: fixture.file,
      label: fixture.label,
      kind: fixture.kind,
      viewport: view,
      groundTruth: { pii: gt0.pii.length, safe: gt0.safe.length, marks: gt0.marks.length, framesSeen: gt0.framesSeen, framesMapped: gt0.framesMapped },
      repeats: runs.length,
      markIdsStableAcrossScans: idsStable,
      markIdSets: idSets.length > 1 ? { distinct: new Set(idSets).size, sample: idSets[0].slice(0, 120) } : null,
      redactedImageFile: path.basename(shotPath),
      piiRecall: M.mean(runs.map((r) => r.pii.recall)),
      piiPrecision: M.mean(runs.map((r) => r.pii.precision)),
      piiMeanIoU: M.mean(runs.map((r) => r.pii.meanIoU)),
      piiTruePositives: M.mean(runs.map((r) => r.pii.truePositives)),
      piiFalseNegatives: M.mean(runs.map((r) => r.pii.falseNegatives)),
      piiHarmfulFalsePositives: M.mean(runs.map((r) => r.pii.harmfulFalsePositives)),
      pixelLeaks: runs.reduce((a, r) => a + (r.pixels.leaks || 0), 0),
      meanMaskedFraction: M.mean(runs.map((r) => r.pixels.meanMaskedFraction)),
      meanSurvivingInk: M.mean(runs.map((r) => r.pixels.meanSurvivingInk)),
      leakTest: runs[0].pixels.leakTest,
      safeLegible: runs[0].pixels.safeLegible,
      safeSampled: runs[0].pixels.safeSampled,
      maskedShareOfViewport: M.mean(runs.map((r) => r.redaction.maskedShareOfViewport)),
      areaInflation: M.mean(runs.map((r) => r.redaction.areaInflation)),
      markRecall: M.mean(runs.map((r) => r.visualContext.recall)),
      markRoleAccuracy: M.mean(runs.map((r) => r.visualContext.roleAccuracy)),
      markMeanIoU: M.mean(runs.map((r) => r.visualContext.meanIoU)),
      reportedMarks: M.mean(runs.map((r) => r.visualContext.reportedMarks)),
      sourceBreakdown: runs[0].sourceBreakdown,
      coveredBy: runs[0].coveredBy,
      frameStats: runs[0].frameStats,
      latency: {
        capture: M.mean(runs.map((r) => r.timings.capture)),
        faceInference: M.mean(runs.map((r) => r.timings.faceInference)),
        ocrInference: M.mean(runs.map((r) => r.timings.ocrInference)),
        visionInference: M.mean(runs.map((r) => r.timings.visionInference)),
        merge: M.mean(runs.map((r) => r.timings.merge)),
        redact: M.mean(runs.map((r) => r.timings.redact)),
        total: M.mean(runs.map((r) => r.timings.total)),
        totalP95: M.percentile(runs.map((r) => r.timings.total), 95),
      },
      missedPiiTypes: [...new Set(runs.flatMap((r) => r.pii.misses.map((m) => m.type)))],
      overRedactedSafe: runs[0].pii.overRedactedSafe,
      missedMarkRoles: [...new Set(runs.flatMap((r) => r.visualContext.missedMarks.map((m) => m.role)))],
      fastProfile: {
        piiRecall: fastScored.pii.recall,
        piiPrecision: fastScored.pii.precision,
        pixelLeaks: fastPixels.leaks,
        sourceBreakdown: fastScan.sourceBreakdown,
        latencyMs: fastScan.timings.total,
      },
      perRun: runs.map((r) => ({
        recall: r.pii.recall, precision: r.pii.precision, iou: r.pii.meanIoU,
        leaks: r.pixels.leaks, totalMs: r.timings.total, markRecall: r.visualContext.recall,
        diag: r.diag,
      })),
    };
    pageResults.push(agg);

    console.log(
      `\n  recall ${M.pct(agg.piiRecall)} | precision ${M.pct(agg.piiPrecision)} | IoU ${M.pct(agg.piiMeanIoU)}` +
      ` | pixel leaks ${agg.pixelLeaks} | marks ${M.pct(agg.markRecall)} | ${Math.round(agg.latency.total)}ms`
    );
  }

  // ── Client-side resource utilisation ──
  const bundle = measureBundle(path.join(__dirname, '..', 'extension'));
  let heap = null;
  try {
    const offscreen = (await h.browser.targets()).find((t) => t.url().includes('offscreen.html'));
    if (offscreen) {
      // The offscreen document is reported as a `background_page` target, for which
      // puppeteer's target.page() yields null — so talk to it over a raw CDP session.
      const ocdp = await offscreen.createCDPSession();
      const r = await ocdp.send('Runtime.evaluate', {
        expression: `(() => (performance.memory ? {
          usedJSHeapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
          totalJSHeapMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
        } : null))()`,
        returnByValue: true,
      });
      heap = r.result && r.result.value;
      await ocdp.detach().catch(() => {});
    }
  } catch (_) {}

  // ── End-to-end task ──
  console.log('\n[end-to-end] running one full agent task...');
  let e2e = null;
  try {
    e2e = await runEndToEnd(h.worker, page, baseUrl, serverUrl);
    console.log(`  ${e2e.steps} step(s) in ${e2e.totalMs}ms (scan ${e2e.scanMs}ms, loop ${e2e.runMs}ms)`);
    console.log(`  fields after run: ${JSON.stringify(e2e.fieldsAfterRun)}`);
  } catch (err) {
    console.log('  end-to-end run failed:', err.message);
    e2e = { error: err.message };
  }

  const out = {
    schemaVersion: 2,
    measurement: 'automated-live-browser',
    generatedAt: new Date().toISOString(),
    environment: {
      chrome: h.chromeVersion,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      extensionId: h.extensionId,
      redactMode: REDACT_MODE,
      repeatsPerPage: REPEATS,
      coverThreshold: COVER_THRESHOLD,
      planner: serverBackend,
    },
    resourceUtilisation: { bundle, offscreenHeap: heap },
    pages: pageResults,
    endToEnd: e2e,
    overall: summarise(pageResults),
  };

  const outPath = path.join(RESULTS_DIR, 'live-eval.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log('Next: node eval/generate-report.js');

  if (!KEEP_OPEN) await h.close();
  server.close();
})().catch((e) => {
  console.error('\nEVALUATION FAILED:', e);
  process.exit(1);
});

function summarise(pages) {
  return {
    pageCount: pages.length,
    piiRecall: M.mean(pages.map((p) => p.piiRecall)),
    fastPiiRecall: M.mean(pages.map((p) => p.fastProfile && p.fastProfile.piiRecall)),
    fastLatencyMs: M.mean(pages.map((p) => p.fastProfile && p.fastProfile.latencyMs)),
    fastPixelLeaks: pages.reduce((a, p) => a + ((p.fastProfile && p.fastProfile.pixelLeaks) || 0), 0),
    piiPrecision: M.mean(pages.map((p) => p.piiPrecision)),
    piiMeanIoU: M.mean(pages.map((p) => p.piiMeanIoU)),
    markRecall: M.mean(pages.map((p) => p.markRecall)),
    markRoleAccuracy: M.mean(pages.map((p) => p.markRoleAccuracy)),
    markMeanIoU: M.mean(pages.map((p) => p.markMeanIoU)),
    totalPixelLeaks: pages.reduce((a, p) => a + p.pixelLeaks, 0),
    totalGroundTruthRegions: pages.reduce((a, p) => a + p.groundTruth.pii, 0),
    meanMaskedFraction: M.mean(pages.map((p) => p.meanMaskedFraction)),
    meanSurvivingInk: M.mean(pages.map((p) => p.meanSurvivingInk)),
    meanLatencyMs: M.mean(pages.map((p) => p.latency.total)),
    p95LatencyMs: M.percentile(pages.map((p) => p.latency.totalP95), 95),
    meanFaceMs: M.mean(pages.map((p) => p.latency.faceInference)),
    meanOcrMs: M.mean(pages.map((p) => p.latency.ocrInference)),
    meanRedactMs: M.mean(pages.map((p) => p.latency.redact)),
    meanCaptureMs: M.mean(pages.map((p) => p.latency.capture)),
    markIdsStable: pages.every((p) => p.markIdsStableAcrossScans),
    regionsCoveredByOcrOnly: pages.reduce((a, p) => a + ((p.coveredBy && p.coveredBy.ocrOnly) || 0), 0),
    regionsCoveredByFaceOnly: pages.reduce((a, p) => a + ((p.coveredBy && p.coveredBy.faceOnly) || 0), 0),
  };
}

function measureBundle(dir) {
  const group = { models: 0, lib: 0, code: 0, other: 0, total: 0 };
  const walk = (d, rel = '') => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, r); continue; }
      const size = fs.statSync(full).size;
      group.total += size;
      if (r.startsWith('models/')) group.models += size;
      else if (r.startsWith('lib/')) group.lib += size;
      else if (r.endsWith('.js') || r.endsWith('.html') || r.endsWith('.css') || r.endsWith('.json')) group.code += size;
      else group.other += size;
    }
  };
  walk(dir);
  const mb = (b) => +(b / 1048576).toFixed(2);
  return { modelsMB: mb(group.models), libMB: mb(group.lib), codeMB: mb(group.code), otherMB: mb(group.other), totalMB: mb(group.total) };
}

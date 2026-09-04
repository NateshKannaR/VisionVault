#!/usr/bin/env node
/**
 * diagnose.js — Opens one fixture in real Chrome with the extension installed, runs a single
 * scan, and prints everything the pipeline logs on the way: service-worker console, offscreen
 * console, per-source detection counts, and the raw offscreen DETECT_PII reply.
 *
 * Use this when a number in eval_report.md looks wrong and you need to see which stage produced
 * it. Usage:  node eval/diagnose.js [fixture.html]
 */

const path = require('path');
const { launchWithExtension, startFixtureServer, tabIdForPage } = require('./lib/harness');

const FIXTURE = process.argv[2] || 'signup-form.html';

(async () => {
  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false });
  console.log(`Chrome ${h.chromeVersion} | extension ${h.extensionId}\n`);

  // Mirror the console of every extension context.
  h.browser.on('targetcreated', async (t) => {
    try {
      if (t.url().includes('offscreen.html')) {
        const p = await t.page();
        if (p) p.on('console', (m) => console.log('  [offscreen]', m.text()));
      }
    } catch (_) {}
  });
  for (const t of await h.browser.targets()) {
    if (t.url().includes('offscreen.html')) {
      const p = await t.page().catch(() => null);
      if (p) p.on('console', (m) => console.log('  [offscreen]', m.text()));
    }
  }

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1200, height: 820 });
  await page.goto(`${baseUrl}/pages/${FIXTURE}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1500));

  const tab = await tabIdForPage(h.worker, page);
  const view = await page.evaluate(() => ({ vpW: innerWidth, vpH: innerHeight, dpr: devicePixelRatio }));
  console.log('tab:', JSON.stringify(tab), 'viewport:', JSON.stringify(view), '\n');

  // 1. Is the offscreen document alive and are its detectors initialised?
  const probe = await h.worker.evaluate(async () => {
    await ensureOffscreenDocument();
    return new Promise((resolve) => {
      const to = setTimeout(() => resolve({ ok: false, error: 'PING timed out after 5s' }), 5000);
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' }, (res) => {
        clearTimeout(to);
        resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
      });
    });
  });
  console.log('offscreen PING ->', JSON.stringify(probe));

  // 2. Call DETECT_PII directly with a real screenshot, with a generous timeout, and time it.
  const direct = await h.worker.evaluate(async (windowId, vpW, vpH, dpr) => {
    const shot = await captureScreenshot(windowId);
    const t0 = performance.now();
    const res = await new Promise((resolve) => {
      const to = setTimeout(() => resolve({ ok: false, error: 'DETECT_PII timed out after 30s' }), 30000);
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'DETECT_PII',
        payload: { rawScreenshot: shot, domRegions: [], viewportWidth: vpW, viewportHeight: vpH, devicePixelRatio: dpr },
      }, (r) => {
        clearTimeout(to);
        resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
      });
    });
    return {
      elapsedMs: Math.round(performance.now() - t0),
      screenshotBytes: shot ? shot.length : 0,
      ok: res && res.ok,
      error: res && res.error,
      faces: res?.result?.faceBoxes?.length ?? null,
      ocr: res?.result?.ocrRegions?.length ?? null,
      timings: res?.result?.timings ?? null,
      ocrSample: (res?.result?.ocrRegions || []).slice(0, 6).map((r) => ({ label: r.label, text: r.text, x: r.x, y: r.y })),
    };
  }, tab.windowId, view.vpW, view.vpH, view.dpr);
  console.log('\ndirect DETECT_PII ->', JSON.stringify(direct, null, 2));

  // 3. Full scanAndRedact, as the agent calls it.
  await new Promise((r) => setTimeout(r, 1200));
  const scan = await h.worker.evaluate(async (tabId, windowId, vpW, vpH, dpr) => {
    const r = await scanAndRedact(tabId, windowId, {
      redactMode: 'black', viewportWidth: vpW, viewportHeight: vpH, devicePixelRatio: dpr,
    });
    return {
      sourceBreakdown: r.sourceBreakdown, timings: r.timings, frameStats: r.frameStats,
      marks: r.marks.length, redactionOk: r.redactionOk,
      regionsByReason: r.regions.reduce((acc, x) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {}),
    };
  }, tab.tabId, tab.windowId, view.vpW, view.vpH, view.dpr);
  console.log('\nscanAndRedact ->', JSON.stringify(scan, null, 2));

  await h.close();
  server.close();
})().catch((e) => { console.error('DIAGNOSE FAILED:', e); process.exit(1); });

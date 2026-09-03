#!/usr/bin/env node
/**
 * ocr-tuning.js — Measures the OCR accuracy/latency trade-off on a real captured screenshot.
 *
 * The OCR stage downscales the screenshot before recognition; smaller rasters are much faster
 * but drop small text below Tesseract's legibility floor. This script sweeps the raster size
 * and the preprocessing mode on an actual fixture capture and prints, for each setting, how
 * many PII strings were recovered and how long recognition took — so `maxDimension` in
 * vision/ocrDetect.js is chosen from data instead of guessed.
 *
 * Usage: node eval/ocr-tuning.js [fixture.html]
 */

const { launchWithExtension, startFixtureServer, tabIdForPage } = require('./lib/harness');

const FIXTURE = process.argv[2] || 'admin-dashboard.html';

(async () => {
  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false });

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1200, height: 820 });
  await page.goto(`${baseUrl}/pages/${FIXTURE}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1200));
  const tab = await tabIdForPage(h.worker, page);

  // Capture one screenshot in the service worker and hand it to the offscreen document.
  const shot = await h.worker.evaluate((windowId) => captureScreenshot(windowId), tab.windowId);
  console.log(`captured ${Math.round(shot.length / 1024)} KB\n`);

  const off = (await h.browser.targets()).find((t) => t.url().includes('offscreen.html'));
  const cdp = await off.createCDPSession();
  await cdp.send('Runtime.enable');

  const run = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description?.slice(0, 300) };
    return r.result.value;
  };

  await run(`globalThis.__shot = ${JSON.stringify(shot)}; "ok"`);
  await run(`globalThis.OCRDetector.initOCRWorker().then(()=>"ready")`);

  console.log('maxDim  preprocess     recogMs   words  piiFound  sample');
  console.log('------  -------------  -------  ------  --------  ------------------------------');

  for (const maxDim of [640, 900, 1200, 1600]) {
    for (const preprocess of ['none', 'threshold']) {
      const out = await run(`(async () => {
        const blob = await (await fetch(globalThis.__shot)).blob();
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, ${maxDim} / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * scale), hh = Math.round(bmp.height * scale);
        const c = new OffscreenCanvas(w, hh);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0, w, hh);
        if ('${preprocess}' === 'threshold') {
          const d = g.getImageData(0, 0, w, hh);
          const a = d.data;
          for (let i = 0; i < a.length; i += 4) {
            const gray = 0.299*a[i] + 0.587*a[i+1] + 0.114*a[i+2];
            const v = gray > 170 ? 255 : (gray < 75 ? 0 : gray);
            a[i] = a[i+1] = a[i+2] = v;
          }
          g.putImageData(d, 0, 0);
        }
        const worker = await globalThis.OCRDetector.initOCRWorker();
        const t0 = performance.now();
        const res = await worker.recognize(c);
        const ms = Math.round(performance.now() - t0);
        const text = res.data.text || '';
        const pii = globalThis.OCRDetector.findPiiInText(text);
        bmp.close();
        return { ms, words: (res.data.words || []).length, pii: pii.length,
                 sample: pii.slice(0, 2).map(p => p.label + ':' + p.text).join(' | '),
                 raster: w + 'x' + hh };
      })()`);
      if (out.error) { console.log(`${String(maxDim).padEnd(6)}  ${preprocess.padEnd(13)}  ERROR ${out.error}`); continue; }
      console.log(
        `${String(maxDim).padEnd(6)}  ${preprocess.padEnd(13)}  ${String(out.ms).padStart(7)}  ${String(out.words).padStart(6)}  ${String(out.pii).padStart(8)}  ${(out.sample || '').slice(0, 40)}`
      );
    }
  }

  await h.close();
  server.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });

/**
 * harness.js — Launches real Chrome with the VisionVault extension loaded and exposes the
 * extension's own service worker for direct invocation.
 *
 * Loading path: Chrome 137+ ignores the --load-extension command-line switch, so the extension
 * is installed at runtime through the DevTools `Extensions.loadUnpacked` command (available
 * with --enable-unsafe-extension-debugging). That installs the SAME unpacked directory a user
 * would pick in chrome://extensions, so the code under test is the shipped code: real MV3
 * service worker, real offscreen document, real ONNX/Tesseract WASM workers.
 */

const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT_DIR = path.resolve(__dirname, '..', '..', 'extension');
const EVAL_DIR = path.resolve(__dirname, '..');

const CHROME_CANDIDATES = [
  process.env.VV_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Serves the repository over http://127.0.0.1:<port>/ so every fixture and demo page loads as
 * an ordinary web page. Two reasons not to use file:// instead: each file:// iframe gets an
 * opaque origin, which changes what the extension can scan, and content scripts need the
 * "Allow access to file URLs" permission, which is off by default.
 *
 * `/pages/...` and `/assets/...` resolve under eval/ so fixture URLs stay short;
 * everything else resolves from the repository root (e.g. /mock-apps/demo-page.html).
 */
function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const base = /^(pages|assets|results)\//.test(rel) ? EVAL_DIR : REPO_ROOT;
      const full = path.resolve(base, rel);
      if (!full.startsWith(base) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Launches Chrome, installs the extension, and returns handles to both. */
async function launchWithExtension({ headless = false, windowSize = '1280,900' } = {}) {
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error(
      'No Chrome executable found. Set VV_CHROME to your chrome.exe path, e.g.\n' +
      '  VV_CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node eval/run-full-eval.js'
    );
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'visionvault-eval-'));
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless,
    userDataDir: profile,
    // A single agent step can wait on a cloud VLM; the whole loop can run for minutes. The
    // default 180s protocol timeout aborts that mid-run and looks like an agent failure.
    protocolTimeout: 900000,
    // Puppeteer passes its own --disable-features / --disable-extensions; both must go, or the
    // extension is disabled before it is installed.
    ignoreDefaultArgs: ['--disable-features', '--disable-extensions'],
    args: [
      '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${windowSize}`,
    ],
  });

  const cdp = await browser.target().createCDPSession();
  const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });

  // The MV3 service worker starts on install; wait for its target to appear.
  let swTarget = null;
  for (let i = 0; i < 60; i++) {
    swTarget = (await browser.targets()).find(
      (t) => t.type() === 'service_worker' && t.url().includes(extensionId)
    );
    if (swTarget) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!swTarget) {
    await browser.close();
    throw new Error('Extension service worker never started — cannot evaluate.');
  }
  const worker = await swTarget.worker();

  // Give the offscreen host time to compile the ONNX graph and the Tesseract core.
  await worker.evaluate(() => (typeof ensureOffscreenDocument === 'function' ? ensureOffscreenDocument() : null));
  await new Promise((r) => setTimeout(r, 3000));

  return {
    browser,
    worker,
    extensionId,
    chromePath,
    chromeVersion: await browser.version(),
    async close() {
      await browser.close().catch(() => {});
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/** Resolves the extension's tabId for a puppeteer Page (matched by URL). */
async function tabIdForPage(worker, page) {
  const url = page.url();
  return worker.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => t.url === u) || tabs.find((t) => (t.url || '').startsWith(u.split('#')[0]));
    return hit ? { tabId: hit.id, windowId: hit.windowId, width: hit.width, height: hit.height } : null;
  }, url);
}

/** Writes the extension's local vault + settings, exactly as the side panel would. */
async function seedVault(worker, vault, settings) {
  return worker.evaluate(
    async (v, s) => {
      await chrome.storage.local.set({ vault: v, settings: s });
      return chrome.storage.local.get(['vault', 'settings']);
    },
    vault,
    settings
  );
}

module.exports = { launchWithExtension, startFixtureServer, tabIdForPage, seedVault, findChrome, EXT_DIR, EVAL_DIR };

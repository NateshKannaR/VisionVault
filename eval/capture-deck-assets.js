#!/usr/bin/env node
/**
 * capture-deck-assets.js — captures the before/after pair used in the SIH deck.
 *
 * The "after" images already exist: every evaluation run writes the redacted frame it actually
 * produced. What is missing is the matching "before", and it has to come from the same fixture
 * at the same viewport or the pair proves nothing.
 *
 * Only the synthetic fixtures are used. The people, emails and ID numbers on them are invented,
 * so the unredacted image is safe to put in a slide deck — which is the whole reason the
 * fixtures carry fake data rather than screenshots of real pages.
 *
 * Usage: node eval/capture-deck-assets.js
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer } = require('./lib/harness');

const OUT = path.join(__dirname, 'results', 'deck');

const SHOTS = [
  { page: 'admin-dashboard.html', name: 'before-admin-dashboard', height: 1000 },
  { page: 'signup-form.html', name: 'before-signup-form', height: 1000 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false });
  const page = await h.browser.newPage();

  for (const shot of SHOTS) {
    await page.setViewport({ width: 1500, height: shot.height, deviceScaleFactor: 1 });
    await page.bringToFront();
    await page.goto(`${baseUrl}/eval/pages/${shot.page}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));
    const file = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }

  await h.close();
  server.close();
})().catch((e) => { console.error('CAPTURE FAILED:', e); process.exit(1); });

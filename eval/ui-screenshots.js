// Renders the side panel inside the real extension and screenshots each state, so the UI can be
// reviewed as it will actually appear rather than as it is described. Every state is driven
// through the panel's own rendering functions with real data from a real scan — nothing here
// mocks up markup that the running panel would not produce.
const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer, seedVault } = require('./lib/harness');

(async () => {
  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false });
  const out = path.join(__dirname, 'results');
  fs.mkdirSync(out, { recursive: true });

  await seedVault(h.worker, {
    name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 20 7946 0102',
    address: '12 Analytical Way, London', username: 'ada', company: 'Analytical Engines',
    zip: 'SW1A 1AA', password: 'stored-locally', about: 'Mathematician.',
  }, {
    redactMode: 'black', serverUrl: 'http://127.0.0.1:8000/api/agent/step',
    confirmPolicy: 'risky', enableOCR: true, enableFaceDetection: true, dismissOverlays: true,
    preferences: 'budget under ₹50,000 · prefer a lighter machine',
  });

  const TASK = 'find the best laptop under 50000, compare the ratings and add the best one to the cart';

  const target = await h.browser.newPage();
  await target.setViewport({ width: 1180, height: 860 });
  await target.goto(`${baseUrl}/eval/pages/shop-results.html`, { waitUntil: 'load' });
  await target.bringToFront();
  await new Promise((r) => setTimeout(r, 1400));

  const panel = await h.browser.newPage();
  await panel.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
  await panel.goto(`chrome-extension://${h.extensionId}/popup.html`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 900));

  const shot = async (name) => {
    // Back to the top first. reveal() scrolls a gate into view, and a fullPage capture of a
    // scrolled page paints the sticky header wherever it happens to be sitting.
    await panel.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 400));
    await panel.screenshot({ path: path.join(out, `ui-${name}.png`), fullPage: true });
    console.log(`wrote eval/results/ui-${name}.png`);
  };

  // 1. Idle — what a user sees before doing anything. Captured before any scan exists, because
  // the panel restores a live session when it finds one, and a restored panel is not idle.
  await shot('idle');

  await target.bringToFront();
  const scan = await h.worker.evaluate((t) => phaseScan(t), TASK);
  console.log(`scan: ${scan.piiCount} regions, ${scan.markCount} marks, ` +
              `${(scan.regions || []).length} region boxes, plan [${scan.plan?.tier}] ` +
              `${(scan.plan?.milestones || []).length} milestones`);
  await panel.bringToFront();

  // 2. Mid-run: the workflow checklist, the live line, the preview, the activity log.
  await panel.evaluate((d) => {
    document.getElementById('task').value = d.task;
    document.getElementById('task').dispatchEvent(new Event('input'));
    renderScan(d.scan, false);
    renderPlan(d.plan);
    // Two milestones behind us, the third running.
    const p = JSON.parse(JSON.stringify(d.plan));
    p.milestones.forEach((m, i) => { m.status = i < 2 ? 'done' : (i === 2 ? 'active' : 'pending'); });
    renderPlan(p);
    addLogEntry('type', 'Filled <strong>the search box</strong> in “Search the store”', 1655);
    addLogEntry('flag', 'Completed <strong>Search for "laptop under 50000"</strong>', null);
    addLogEntry('book', 'Read the page — <strong>4</strong> item(s) found', 2104);
    addLogEntry('sparkle', 'Concluded: <strong>Found 4 items on this page.</strong>', 812);
    setLiveStep('Step 5 — click: Open the best match: Vertex 16 Slim', 'gemini', 0.86);
    setRunning(true);
  }, { task: TASK, scan, plan: scan.plan });
  await shot('run');

  // 3. The approval gate — the safety story, in the words the user actually sees.
  await panel.evaluate(() => {
    handleStepResult({
      actionLog: [], plan: null, needsConfirm: true,
      confirmReason: 'Target labelled "add to bag" matches the high-risk action list.',
      action: { action: 'click', mark_id: 3396866, label: 'add to bag',
                reasoning: 'Add the chosen laptop to the cart' },
    });
  });
  await shot('approval');

  // 4. The completion card — what was achieved, and what it found.
  await panel.evaluate(() => {
    document.getElementById('confirmWrap').hidden = true;
    setRunning(false);
    renderResult({
      outcome: 'success',
      elapsedMs: 45100,
      actions: 9,
      failedActions: 0,
      summary: 'Found the best-rated laptop within your ₹50,000 budget — the Vertex 16 Slim at ' +
               '₹48,500, rated 4.7/5 — and added it to the cart after you approved it.',
      highlights: [
        'Best match: Vertex 16 Slim at ₹48,500 (4.7/5)',
        'Compared 4 laptops by rating and price',
        'Nimbus Pro 15 rates the same but costs ₹22,500 more',
      ],
      warnings: [],
      findings: [{ items: [
        { title: 'Vertex 16 Slim', price: '₹48,500', rating: '4.7/5' },
        { title: 'Nimbus Pro 15 32GB', price: '₹71,000', rating: '4.7/5' },
        { title: 'Aurora 14 Ultrabook 16GB', price: '₹54,999', rating: '4.4/5' },
        { title: 'Zephyr X1 Creator', price: '₹88,000', rating: '4.9/5' },
      ] }],
    });
  });
  await shot('result');

  // 5. A run that could not finish everything — the honest case.
  await panel.evaluate(() => {
    renderResult({
      outcome: 'partial',
      elapsedMs: 62400,
      actions: 6,
      failedActions: 1,
      summary: 'Searched for running shoes and read the results. The price filter this plan ' +
               'expected does not exist on this site, so that step was skipped.',
      highlights: ['Read 12 products from the results page'],
      warnings: ['Skipped "Apply price filter" — this page offers no way to do it.'],
      findings: [],
    });
  });
  await shot('partial');

  // 6-8. The other tabs.
  for (const tab of ['history', 'vault', 'settings']) {
    await panel.evaluate((t) => showTab(t), tab);
    await shot(tab);
  }

  await h.close();
  server.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });

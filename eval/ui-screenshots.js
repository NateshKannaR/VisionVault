// Renders the side panel inside the real extension and screenshots each tab, so the UI can be
// reviewed as it will actually appear. Also exercises the populated states (preview + region
// overlay, metrics, timings, activity) rather than only the empty ones.
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
    confirmPolicy: 'risky', enableOCR: true, enableFaceDetection: true,
  });

  const target = await h.browser.newPage();
  await target.setViewport({ width: 1100, height: 820 });
  await target.goto(`${baseUrl}/mock-apps/demo-page.html`, { waitUntil: 'load' });
  await target.bringToFront();
  await new Promise((r) => setTimeout(r, 1500));

  const scan = await h.worker.evaluate((t) => phaseScan(t), 'search for wireless earbuds and show me');
  console.log(`scan: ${scan.piiCount} regions, ${scan.markCount} marks, ` +
              `${(scan.regions || []).length} region boxes, viewport ${JSON.stringify(scan.viewport)}`);

  const panel = await h.browser.newPage();
  await panel.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
  await panel.goto(`chrome-extension://${h.extensionId}/popup.html`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 900));

  // Idle state first — this is what a user sees before doing anything.
  await panel.screenshot({ path: path.join(out, 'ui-idle.png'), fullPage: true });
  console.log('wrote eval/results/ui-idle.png');

  // Drive the panel's own rendering paths with the real scan result.
  await panel.evaluate((d) => {
    document.getElementById('task').value = 'search for wireless earbuds and show me';
    document.getElementById('task').dispatchEvent(new Event('input'));
    document.getElementById('idleState').hidden = true;

    document.getElementById('preview').src = d.preview;
    document.getElementById('previewWrap').hidden = false;
    document.getElementById('statsGrid').hidden = false;
    renderRegions(d.regions, d.viewport);
    renderTimings(d.timings);

    document.getElementById('s-pii').textContent = d.piiCount;
    document.getElementById('s-marks').textContent = d.markCount;
    document.getElementById('s-total').textContent = d.timings.total + 'ms';
    document.getElementById('runBtn').hidden = false;

    showStatus('statusMsg', 'success',
      `<strong>${d.piiCount}</strong> sensitive regions masked on this device. ` +
      'The image above is exactly what would be sent.');

    addLogEntry('type', 'Filled <strong>email</strong> in element #5615249', 412);
    addLogEntry('cursor', 'Clicked element #9001122', 318);
    addLogEntry('refresh', 'Page changed — re-scanned (9 elements, 10 masked)', 1904);
    setLiveStep('Step 4 — type: filling the address field');
  }, scan);
  await new Promise((r) => setTimeout(r, 400));
  await panel.screenshot({ path: path.join(out, 'ui-run.png'), fullPage: true });
  console.log('wrote eval/results/ui-run.png');

  // The approval gate, which is the safety story.
  await panel.evaluate(() => {
    clearLiveStep();
    document.getElementById('confirmWrap').hidden = false;
    document.getElementById('confirmText').innerHTML =
      '<strong>CLICK</strong> on element #9001122<br>Submit the completed signup form' +
      '<br><span style="color:var(--text-muted)">Why you are being asked: Target labelled ' +
      '"create free account" matches the high-risk action list.</span>';
    showStatus('statusMsg', 'warn', 'Approval required before this click is dispatched.');
  });
  await new Promise((r) => setTimeout(r, 300));
  await panel.screenshot({ path: path.join(out, 'ui-approval.png'), fullPage: true });
  console.log('wrote eval/results/ui-approval.png');

  for (const tab of ['vault', 'settings']) {
    await panel.evaluate((t) => {
      document.querySelectorAll('.tab').forEach((b) => {
        const on = b.dataset.tab === t;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + t));
    }, tab);
    await new Promise((r) => setTimeout(r, 350));
    await panel.screenshot({ path: path.join(out, `ui-${tab}.png`), fullPage: true });
    console.log(`wrote eval/results/ui-${tab}.png`);
  }

  await h.close();
  server.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });

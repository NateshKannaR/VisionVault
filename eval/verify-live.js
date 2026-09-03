#!/usr/bin/env node
/**
 * verify-live.js — End-to-end verification against the real extension in real Chrome.
 *
 * Where run-full-eval.js measures detection quality, this script verifies BEHAVIOUR and the
 * privacy invariants, and prints what it actually observed. It intercepts the service worker's
 * network traffic, so the claim "no unredacted image and no vault value is ever sent" is
 * checked against the bytes on the wire rather than against the source code.
 *
 * Checks:
 *   1. Scan produces real, non-zero detections and a redacted preview.
 *   2. The known sensitive fields are actually masked in the returned image.
 *   3. Automation runs multiple steps, fills fields from the local vault, and terminates.
 *   4. Every outbound request body is inspected: no vault value, no raw capture.
 *   5. A risky click halts for confirmation and only proceeds when approved.
 *   6. Fail-closed: with redaction forced to fail, the scan aborts and NOTHING is transmitted.
 *
 * Usage:
 *   node eval/verify-live.js            # uses the local planner if no server is running
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer, tabIdForPage, seedVault } = require('./lib/harness');
const { decodeDataUrl, decodePNG, inkSurvival } = require('./lib/png');

const RESULTS_DIR = path.join(__dirname, 'results');

// Distinctive sentinels: if any of these ever appears in an outbound request body, a real
// personal value escaped the device.
const VAULT = {
  name: 'Zorbnax Quilliphant',
  email: 'zorbnax.q7@vaultsentinel.test',
  phone: '+44 7700 900931',
  address: '19 Quilliphant Row, Sentinel City',
  username: 'zorbnax_q7',
  password: 'Tr0ub4dor&Sentinel',
  company: 'Sentinel Works',
};

let pass = 0;
let fail = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false });

  console.log('VisionVault — live verification');
  console.log('===============================');
  console.log(`Chrome:    ${h.chromeVersion}`);
  console.log(`Extension: ${h.extensionId} (loaded unpacked from extension/)`);

  let plannerLabel = 'none reachable — extension used its on-device planner';
  try {
    const r = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    plannerLabel = `${j.backend} (chain: ${(j.chain || []).join(' -> ')})`;
  } catch (_) {}
  console.log(`Planner:   ${plannerLabel}`);

  // ── Intercept everything the service worker sends ──────────────────────────
  const sentBodies = [];
  const swTarget = (await h.browser.targets()).find((t) => t.type() === 'service_worker');
  const swCdp = await swTarget.createCDPSession();
  await swCdp.send('Network.enable');
  swCdp.on('Network.requestWillBeSent', (e) => {
    if (!e.request || !e.request.url) return;
    if (/\/(api\/agent\/step|plan-action)/.test(e.request.url)) {
      sentBodies.push({ url: e.request.url, body: e.request.postData || '' });
    }
  });

  await seedVault(h.worker, VAULT, {
    redactMode: 'black',
    serverUrl: 'http://127.0.0.1:8000/api/agent/step',
    confirmPolicy: 'risky',
    enableOCR: true,
    enableFaceDetection: true,
  });

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/mock-apps/demo-page.html`, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all(
    Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))
  ));
  await new Promise((r) => setTimeout(r, 1200));
  console.log(`Demo page: ${page.url()}`);

  // chrome.tabs.captureVisibleTab photographs the FOREGROUND tab of the window. If the demo
  // page is not in front, the extension redacts one page while this script compares against
  // another, and the mismatch looks like a leak that never happened.
  await page.bringToFront();
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 400));

  // ── 1. Scan ────────────────────────────────────────────────────────────────
  section('1. Scan & redact the demo page');
  const readBoxes = () => page.evaluate(() => {
    const ids = ['fullName', 'email', 'phone', 'aadhaar', 'password', 'address'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out[id] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    const img = document.querySelector('.avatar-img');
    if (img) {
      const r = img.getBoundingClientRect();
      out.avatar = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  });

  // Reference capture, scan, and geometry must all describe the same layout. Re-read the
  // geometry afterwards and retry if anything moved (late font or image load, a stray scroll).
  let reference = null;
  let scan = null;
  let boxes = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.bringToFront();
    await page.evaluate(() => window.scrollTo(0, 0));
    const boxesBefore = await readBoxes();
    reference = decodePNG(await page.screenshot({ type: 'png' }));
    scan = await h.worker.evaluate((task) => phaseScan(task), 'Fill the signup form with my details');
    const boxesAfter = await readBoxes();
    if (JSON.stringify(boxesBefore) === JSON.stringify(boxesAfter)) {
      boxes = boxesAfter;
      break;
    }
    console.log(`  note:     layout moved during attempt ${attempt}; retrying so the comparison stays honest`);
    boxes = boxesAfter;
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log(`  observed: piiCount=${scan.piiCount}  marks=${scan.markCount}`);
  console.log(`  observed: sources=${JSON.stringify(scan.sourceBreakdown)}  frames=${JSON.stringify(scan.frameStats)}`);
  console.log(`  observed: timings=${JSON.stringify(scan.timings)}`);

  check(scan.piiCount > 0, `scan reports a non-zero PII count (${scan.piiCount})`);
  check(scan.markCount > 0, `scan reports a non-zero mark count (${scan.markCount})`);
  check(!!scan.preview && scan.preview.startsWith('data:image/png'), 'scan returns a redacted preview image');
  check((scan.timings.total || 0) > 0, `scan reports real timings (${scan.timings.total}ms total)`);
  check(
    (scan.sourceBreakdown?.vision_ocr || 0) > 0 || (scan.sourceBreakdown?.vision_face || 0) > 0,
    'local ML contributed detections (face and/or OCR ran)',
    `sourceBreakdown=${JSON.stringify(scan.sourceBreakdown)}`
  );

  const previewPath = path.join(RESULTS_DIR, 'verify-demo-redacted.png');
  fs.writeFileSync(previewPath, Buffer.from(scan.preview.split(',')[1], 'base64'));
  console.log(`  saved:    ${path.relative(path.join(__dirname, '..'), previewPath)}`);

  // ── 2. Are the sensitive fields really masked? ─────────────────────────────
  section('2. Verify the sensitive fields are masked in the returned image');
  const redacted = decodeDataUrl(scan.preview);
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  for (const [name, box] of Object.entries(boxes)) {
    const s = inkSurvival(reference, redacted, box, { viewportWidth: view.w, viewportHeight: view.h });
    check(
      !s.leaked,
      `${name}: masked in the redacted image (${(s.unchangedInkFraction * 100).toFixed(2)}% of its ink survived)`,
      `inkPixels=${s.inkPixels}`
    );
  }

  // ── 3. Automation ──────────────────────────────────────────────────────────
  section('3. Run the automation loop');
  await page.bringToFront();
  const run = await h.worker.evaluate(() => phaseRun());
  const stepsTaken = (run.actionLog || []).length;

  console.log(`  observed: ${stepsTaken} action(s), done=${run.done}, needsConfirm=${!!run.needsConfirm}`);
  for (const a of run.actionLog || []) console.log(`            ${JSON.stringify(a)}`);

  const filled = await page.evaluate(() => {
    const g = (id) => (document.getElementById(id) || {}).value || '';
    return { fullName: g('fullName'), email: g('email'), phone: g('phone'), username: g('username'), password: g('password'), address: g('address') };
  });
  console.log(`  observed: field values now = ${JSON.stringify(filled)}`);

  check(stepsTaken >= 2, `loop executed multiple steps (${stepsTaken})`);
  check(run.done === true || run.needsConfirm === true, 'loop reached a terminal state (done, or halted for approval)');

  const resolvedFromVault = Object.values(filled).filter((v) => v && Object.values(VAULT).includes(v));
  check(
    resolvedFromVault.length > 0,
    `vault values were resolved locally and typed into the page (${resolvedFromVault.length} field(s))`,
    JSON.stringify(filled)
  );

  // ── 4. What actually went over the wire ────────────────────────────────────
  section('4. Inspect every outbound request body');
  console.log(`  observed: ${sentBodies.length} request(s) to the planning endpoint`);

  let vaultLeaks = [];
  let imageIssues = [];
  for (const [i, req] of sentBodies.entries()) {
    if (!req.body) continue;
    for (const [key, value] of Object.entries(VAULT)) {
      if (value && req.body.includes(value)) vaultLeaks.push(`request #${i + 1} contains vault.${key}`);
    }
    try {
      const parsed = JSON.parse(req.body);
      const img = parsed.redactedImage || parsed.image || '';
      if (img) {
        if (!img.startsWith('data:image/png')) imageIssues.push(`request #${i + 1}: image is not a PNG data URL`);
      }
    } catch (e) {
      imageIssues.push(`request #${i + 1}: body is not valid JSON`);
    }
  }

  check(sentBodies.length > 0 || plannerLabel.startsWith('none'), 'planning requests were captured (or no server was running)');
  check(vaultLeaks.length === 0, 'no vault value appears in any request body', vaultLeaks.join('; '));
  check(imageIssues.length === 0, 'every transmitted image is a PNG data URL', imageIssues.join('; '));

  // The transmitted image must be the REDACTED one: verify by re-checking ink survival on it.
  if (sentBodies.length) {
    try {
      const lastImg = JSON.parse(sentBodies[sentBodies.length - 1].body).redactedImage;
      if (lastImg) {
        const sentDecoded = decodeDataUrl(lastImg);
        const worst = Object.entries(boxes).map(([name, box]) => ({
          name, ...inkSurvival(reference, sentDecoded, box, { viewportWidth: view.w, viewportHeight: view.h }),
        })).filter((r) => r.leaked);
        check(worst.length === 0, 'the image actually transmitted has every sensitive field masked',
              worst.map((w) => w.name).join(', '));
      }
    } catch (e) {
      check(false, 'could not parse the transmitted image', e.message);
    }
  }

  // ── 5. Click confirmation ──────────────────────────────────────────────────
  section('5. Risky click halts for human approval');
  await h.worker.evaluate(() => {
    // Drive the gate directly with a synthetic plan, so the check does not depend on what the
    // cloud model happens to choose on this run.
    const submit = (session.marks || []).find((m) => (m.label || '').includes('create free account'))
      || (session.marks || []).find((m) => m.role === 'button');
    session.lastAction = { action: 'click', mark_id: submit && submit.id, reasoning: 'Submit the completed form' };
    return submit;
  });
  const risky = await h.worker.evaluate(() => {
    const submit = (session.marks || []).find((m) => (m.label || '').includes('create free account'))
      || (session.marks || []).find((m) => m.role === 'button');
    return assessClickRisk({ action: 'click', mark_id: submit && submit.id, reasoning: 'Submit the completed form' }, session);
  });
  console.log(`  observed: assessClickRisk -> ${JSON.stringify(risky)}`);
  check(risky.needsConfirm === true, 'a submit-style click requires confirmation', JSON.stringify(risky));

  const benign = await h.worker.evaluate(() => {
    // A labelled, non-consequential link. Fail loudly if the page has none, rather than
    // silently testing an undefined target (which would be gated as unknown risk).
    const link = (session.marks || []).find((m) => m.role === 'link' && m.label);
    if (!link) return { error: 'no labelled link on the page to test with' };
    return Object.assign(
      { label: link.label },
      assessClickRisk({ action: 'click', mark_id: link.id, reasoning: 'Open the linked page' }, session)
    );
  });
  console.log(`  observed: benign click -> ${JSON.stringify(benign)}`);
  check(!benign.error && benign.needsConfirm === false,
        'an ordinary labelled navigation click runs without confirmation', JSON.stringify(benign));

  const unlabelled = await h.worker.evaluate(() =>
    assessClickRisk({ action: 'click', mark_id: 999999999, reasoning: 'Click it' }, session));
  console.log(`  observed: unknown/unlabelled target -> ${JSON.stringify(unlabelled)}`);
  check(unlabelled.needsConfirm === true,
        'a target with no readable label is gated (unknown risk is treated as risk)');

  // ── 6. Fail-closed ─────────────────────────────────────────────────────────
  section('6. Fail closed: redaction failure must transmit nothing');
  const beforeFail = sentBodies.length;

  // Break redaction for real. Patching globalThis.redactImage would do nothing — scanAndRedact
  // calls the closure-scoped function inside detection-orchestrator.js. Instead we break a
  // primitive that redactImage genuinely depends on, so the failure happens where it would in
  // the wild (a decode failure, an out-of-memory canvas) rather than at a stub boundary.
  const failResult = await h.worker.evaluate(async () => {
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => {
      throw new Error('forced decode failure (verification)');
    };

    const observed = { scanThrew: null, runThrew: null, runResult: null, sessionIsNull: null };
    try {
      await phaseScan('Fill the signup form with my details');
    } catch (e) {
      observed.scanThrew = e.message;
    }
    observed.sessionIsNull = session === null;

    // The loop must also refuse to run: with no verified redacted frame there is nothing it
    // may legitimately transmit.
    try {
      observed.runResult = await phaseRun();
    } catch (e) {
      observed.runThrew = e.message;
    }

    globalThis.createImageBitmap = originalCreateImageBitmap;
    return observed;
  });
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`  observed: phaseScan threw -> ${JSON.stringify(failResult.scanThrew)}`);
  console.log(`  observed: phaseRun  threw -> ${JSON.stringify(failResult.runThrew)}`);
  console.log(`  observed: session === null -> ${failResult.sessionIsNull}`);
  console.log(`  observed: requests sent during the failure = ${sentBodies.length - beforeFail}`);

  check(
    !!failResult.scanThrew && /redaction/i.test(failResult.scanThrew),
    'redaction failure aborts the scan with an explicit error',
    `got: ${failResult.scanThrew}`
  );
  check(failResult.sessionIsNull, 'no session state is left behind after a failed scan');
  check(
    !!failResult.runThrew || (failResult.runResult && failResult.runResult.error),
    'the agent loop refuses to run without a verified redacted frame',
    `runThrew=${failResult.runThrew} runResult=${JSON.stringify(failResult.runResult)}`
  );
  check(
    sentBodies.length === beforeFail,
    'no request whatsoever was transmitted while redaction was failing',
    `${sentBodies.length - beforeFail} request(s) went out`
  );

  // And prove the guard is not merely incidental: callServer itself must refuse an unverified
  // payload even if something upstream tried to hand it one.
  const guard = await h.worker.evaluate(async () => {
    try {
      await callServer({ task: 'x', image: 'data:image/png;base64,AAAA', marks: [] }, 'http://127.0.0.1:8000/api/agent/step');
      return { refused: false };
    } catch (e) {
      return { refused: true, message: e.message };
    }
  });
  console.log(`  observed: callServer without redactionVerified -> ${JSON.stringify(guard)}`);
  check(guard.refused === true, 'callServer refuses a payload that is not marked redaction-verified',
        JSON.stringify(guard));

  // ── 7. DOM-change re-scan ──────────────────────────────────────────────────
  section('7. A DOM change triggers a re-scan that updates session state and the panel');

  // Re-establish a session (section 6 deliberately destroyed it).
  await h.worker.evaluate((task) => phaseScan(task), 'Fill the signup form with my details');

  // Spy on the panel notifications so we can prove the UI is told, not just the session.
  await h.worker.evaluate(() => {
    globalThis.__notifications = [];
    if (!globalThis.__notifyPatched) {
      globalThis.__notifyPatched = true;
      const original = notifyPopup;
      notifyPopup = function (data) {
        globalThis.__notifications.push(data);
        return original(data);
      };
    }
  });

  const beforeChange = await h.worker.evaluate(() => ({
    marks: session.marks.length,
    preview: (session.redacted || '').length,
  }));
  const piiBeforeChange = scan.piiCount;

  // Mutate the page the way a single-page app would: inject new fields carrying PII.
  await page.evaluate(() => {
    const host = document.querySelector('form') || document.body;
    const block = document.createElement('div');
    block.innerHTML = `
      <label for="latePan">Billing PAN</label>
      <input type="text" id="latePan" name="pan" value="AXKPR4471J" />
      <label for="lateIfsc">Bank IFSC</label>
      <input type="text" id="lateIfsc" name="ifsc" value="HDFC0004471" />
      <p id="lateContact">Escalations: late.contact@examplemail.com</p>`;
    host.appendChild(block);
  });

  // MutationObserver debounce (700ms) + service-worker debounce (900ms) + a scan.
  await new Promise((r) => setTimeout(r, 7000));

  const afterChange = await h.worker.evaluate(() => ({
    marks: session.marks.length,
    preview: (session.redacted || '').length,
    notifications: globalThis.__notifications || [],
  }));

  const rescans = afterChange.notifications.filter((n) => n && n.type === 'rescanned');
  const domRescans = rescans.filter((n) => n.reason === 'dom_change');

  console.log(`  observed: marks ${beforeChange.marks} -> ${afterChange.marks}`);
  console.log(`  observed: preview bytes ${beforeChange.preview} -> ${afterChange.preview}`);
  console.log(`  observed: rescan notifications = ${rescans.length} (dom_change: ${domRescans.length})`);
  if (domRescans.length) {
    const n = domRescans[domRescans.length - 1];
    console.log(`  observed: latest -> marks=${n.markCount} pii=${n.piiCount} preview=${(n.preview || '').length} bytes`);
  }

  const latestPii = domRescans.length ? domRescans[domRescans.length - 1].piiCount : null;
  console.log(`  observed: PII count ${piiBeforeChange} -> ${latestPii}`);

  check(domRescans.length > 0, 'a DOM change produced a dom_change re-scan');
  check(latestPii !== null && latestPii > piiBeforeChange,
        `the re-scan detected the newly injected PII (${piiBeforeChange} -> ${latestPii} regions)`);
  check(afterChange.preview > 0 && afterChange.preview !== beforeChange.preview,
        'session.redacted was refreshed by the re-scan');
  check(domRescans.length > 0 && !!domRescans[domRescans.length - 1].preview,
        'the panel was pushed a fresh preview and stats, exactly as a manual scan does');

  // Mark count is deliberately NOT asserted to grow: tagging is viewport-only, and the
  // injected fields land below the fold on this page. session.marks is still replaced
  // wholesale by the re-scan, which is what the loop reads on its next step.
  console.log(`  note:     marks ${beforeChange.marks} -> ${afterChange.marks} ` +
              '(tagging is viewport-only; the injected fields are below the fold)');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(70));

  await h.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nVERIFICATION FAILED TO RUN:', e); process.exit(2); });

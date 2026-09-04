#!/usr/bin/env node
/**
 * verify-journey.js — the complex multi-step workflow, driven end to end in real Chrome.
 *
 * verify-live.js proves the privacy invariants and the single-step behaviours. This proves the
 * thing the problem statement actually asks for: a task with several stages, where the agent
 * has to read a page, compare what it found, choose on the user's terms, act, and report.
 *
 * The task is:
 *   "find the best laptop under 50000, compare the ratings and add the best one to the cart"
 *
 * On eval/pages/shop-results.html the right answer is knowable and fixed: Vertex 16 Slim
 * (4.7, ₹48,500). Nimbus Pro rates the same but costs more; Zephyr rates higher but is over
 * budget. So this checks a decision, not merely that some buttons were pressed.
 *
 * It also checks the two things a demo lives or dies by: that the page read is scrubbed of
 * personal data before it is transmitted, and that the run ends with a summary a person can
 * read.
 *
 * Usage: node eval/verify-journey.js
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer, seedVault } = require('./lib/harness');

const RESULTS_DIR = path.join(__dirname, 'results');

// The one PII string on the fixture. If it ever appears in an outbound body, the page reader
// leaked it — which is the specific risk of sending page CONTENT rather than only geometry.
const PAGE_PII = 'maya.venkatesh@examplemail.com';

const VAULT = {
  name: 'Zorbnax Quilliphant',
  email: 'zorbnax.q7@vaultsentinel.test',
  phone: '+44 7700 900931',
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

  console.log('VisionVault — multi-step workflow verification');
  console.log('==============================================');
  console.log(`Chrome:    ${h.chromeVersion}`);
  console.log(`Extension: ${h.extensionId}`);

  let plannerLabel = 'none reachable — the extension planned on-device';
  try {
    const r = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    plannerLabel = `${j.backend} (chain: ${(j.chain || []).join(' -> ')})`;
  } catch (_) {}
  console.log(`Planner:   ${plannerLabel}`);

  // Everything the service worker sends, so the page-content channel can be inspected.
  const sentBodies = [];
  const swTarget = (await h.browser.targets()).find((t) => t.type() === 'service_worker');
  const swCdp = await swTarget.createCDPSession();
  await swCdp.send('Network.enable');
  swCdp.on('Network.requestWillBeSent', (e) => {
    if (/\/api\/agent\/(step|plan|summary)/.test(e.request?.url || '')) {
      sentBodies.push({ url: e.request.url, body: e.request.postData || '' });
    }
  });

  await seedVault(h.worker, VAULT, {
    redactMode: 'black',
    serverUrl: 'http://127.0.0.1:8000/api/agent/step',
    // The agent must reach "Add to bag" on its own; the gate is exercised separately below.
    confirmPolicy: 'risky',
    enableOCR: true,
    enableFaceDetection: true,
    dismissOverlays: true,
    preferences: '',
  });

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/eval/pages/shop-results.html`, { waitUntil: 'load' });
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 900));

  const TASK = 'find the best laptop under 50000, compare the ratings and add the best one to the cart';

  // ── 1. Decomposition ───────────────────────────────────────────────────────
  section('1. The task becomes an ordered workflow');
  const scan = await h.worker.evaluate((t) => phaseScan(t), TASK);
  const plan = scan.plan;
  console.log(`  observed: planner tier = ${plan?.tier}`);
  for (const m of plan?.milestones || []) console.log(`            ${m.id}. (${m.kind}) ${m.title}`);

  check(!!plan && plan.milestones.length >= 3,
        `the task decomposed into ${plan?.milestones?.length || 0} milestones`,
        JSON.stringify(plan));
  const kinds = (plan?.milestones || []).map((m) => m.kind);
  check(kinds.includes('read'), 'the plan includes reading the page before choosing', kinds.join(','));
  check(kinds.includes('open') || kinds.includes('act'), 'the plan includes acting on the choice', kinds.join(','));
  check(scan.piiCount > 0, `the scan masked the signed-in customer's details (${scan.piiCount} region(s))`);

  // ── 2. Run it ──────────────────────────────────────────────────────────────
  section('2. Run the workflow');
  await h.worker.evaluate(() => {
    globalThis.__notifications = [];
    if (globalThis.__notifyPatched) return;
    globalThis.__notifyPatched = true;
    const original = notifyPopup;
    notifyPopup = function (d) { globalThis.__notifications.push(d); return original(d); };
  });

  const t0 = Date.now();
  let run = await h.worker.evaluate(() => phaseRun());
  // A risky click ("Add to bag" matches the add-to-cart rule) stops for approval. That is the
  // designed behaviour; approve it once, exactly as a person would, and let the run finish.
  let approvals = 0;
  while (run && run.needsConfirm && approvals < 3) {
    console.log(`  observed: approval requested — ${run.confirmReason}`);
    approvals++;
    run = await h.worker.evaluate(() => phaseConfirm());
  }
  const elapsed = Date.now() - t0;

  const steps = await h.worker.evaluate(() =>
    (globalThis.__notifications || []).filter((n) => n && n.type === 'step').map((n) => n.status));
  console.log('  observed: step-by-step ->');
  for (const s of steps) console.log(`            ${s}`);
  console.log(`  observed: ${(run.actionLog || []).length} action(s) in ${(elapsed / 1000).toFixed(1)}s, ${approvals} approval(s)`);
  for (const a of run.actionLog || []) console.log(`            ${JSON.stringify(a)}`);

  check(run.done === true, 'the run reached a terminal state', JSON.stringify({ done: run.done, error: run.error }));
  check(approvals >= 1, 'adding to the cart stopped for human approval first');

  // ── 3. Did it read, and did it choose correctly? ───────────────────────────
  section('3. It read the page, compared, and chose on the user\'s terms');
  const readActions = (run.actionLog || []).filter((a) => a.action === 'read_page');
  const answers = (run.actionLog || []).filter((a) => a.action === 'answer');
  console.log(`  observed: ${readActions.length} page read(s), ${answers.length} conclusion(s)`);
  for (const a of answers) console.log(`            "${a.value}"`);

  check(readActions.length >= 1, 'the agent read the page content at least once');
  check(readActions.some((a) => (a.items || 0) >= 4),
        `the read found all four products (best: ${Math.max(0, ...readActions.map((a) => a.items || 0))})`);

  const selected = await page.evaluate(() => window.__selected);
  const cart = await page.evaluate(() => window.__cart);
  console.log(`  observed: product opened = ${JSON.stringify(selected)}`);
  console.log(`  observed: cart contents  = ${JSON.stringify(cart)}`);

  // The decision under test. Vertex is the best-rated item inside the ₹50,000 budget.
  check(/vertex/i.test(selected || cart || ''),
        'it chose Vertex 16 Slim — the best-rated laptop within the budget',
        `opened ${JSON.stringify(selected)}, cart ${JSON.stringify(cart)}`);
  check(!!cart && cart !== '(nothing selected)', 'something was actually added to the cart', JSON.stringify(cart));

  // ── 4. What went over the wire ─────────────────────────────────────────────
  section('4. The page content that was transmitted carries no personal data');
  console.log(`  observed: ${sentBodies.length} request(s) to the server`);
  const withContent = sentBodies.filter((b) => /"page_content"\s*:\s*\{/.test(b.body));
  console.log(`  observed: ${withContent.length} of them carried page content`);

  const pagePiiLeaks = sentBodies.filter((b) => (b.body || '').includes(PAGE_PII));
  check(pagePiiLeaks.length === 0,
        'the customer email printed on the page never reached the server',
        `${pagePiiLeaks.length} request(s) contained it`);

  const vaultLeaks = [];
  for (const b of sentBodies) {
    for (const [k, v] of Object.entries(VAULT)) if (v && (b.body || '').includes(v)) vaultLeaks.push(k);
  }
  check(vaultLeaks.length === 0, 'no vault value appears in any request body', vaultLeaks.join(', '));

  // The redaction gate still applies to every step of a longer run, not just the first.
  let unredacted = 0;
  for (const b of sentBodies) {
    try {
      const parsed = JSON.parse(b.body);
      if (parsed.redactedImage && !parsed.redactedImage.startsWith('data:image/png')) unredacted++;
    } catch (_) {}
  }
  check(unredacted === 0, 'every transmitted image is still a redacted PNG');

  // The page reader replaces a PII match with "[redacted]" rather than dropping the row, so
  // the placeholder appearing is the mechanism working, not a leak.
  const scrubbed = withContent.some((b) => (b.body || '').includes('[redacted]'));
  console.log(`  observed: a "[redacted]" placeholder in transmitted content = ${scrubbed}`);

  // ── 5. The report ──────────────────────────────────────────────────────────
  section('5. It reports what it achieved, in words');
  const result = run.result || {};
  console.log(`  observed: outcome  = ${result.outcome}`);
  console.log(`  observed: summary  = ${JSON.stringify(result.summary)}`);
  for (const hl of result.highlights || []) console.log(`            • ${hl}`);
  console.log(`  observed: findings = ${(result.findings || []).reduce((s, f) => s + (f.items || []).length, 0)} item(s)`);
  console.log(`  observed: elapsed  = ${((result.elapsedMs || 0) / 1000).toFixed(1)}s`);

  check(!!result.summary && result.summary.length > 20, 'the run produced a written summary', JSON.stringify(result.summary));
  check(['success', 'partial'].includes(result.outcome), `the outcome is stated (${result.outcome})`);
  check((result.findings || []).some((f) => (f.items || []).length), 'the structured findings were kept for the report');

  // ── 6. It is remembered ────────────────────────────────────────────────────
  section('6. The run is recorded in local history');
  const history = await h.worker.evaluate(() => SiteMemory.history(5));
  console.log(`  observed: ${history.length} run(s) in history`);
  if (history[0]) console.log(`            ${history[0].outcome} · ${history[0].task}`);
  check(history.length >= 1, 'the completed run was written to history');
  check(history[0] && history[0].task === TASK, 'history records the task that was run');

  const stored = await h.worker.evaluate(async () => {
    const { memory } = await chrome.storage.local.get('memory');
    return JSON.stringify(memory).length;
  });
  console.log(`  observed: memory store = ${stored} bytes`);
  check(stored < 200000, 'the local memory store stays small', `${stored} bytes`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('='.repeat(70));

  fs.writeFileSync(path.join(RESULTS_DIR, 'journey.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), task: TASK, planner: plannerLabel,
    plan, steps, actionLog: run.actionLog, result, selected, cart,
    elapsedMs: elapsed, passed: pass, failed: fail,
  }, null, 2));
  console.log('wrote eval/results/journey.json');

  await h.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nJOURNEY VERIFICATION FAILED TO RUN:', e); process.exit(2); });

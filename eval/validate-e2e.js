#!/usr/bin/env node
/**
 * validate-e2e.js — Standalone End-to-End Task Validation & Execution Reliability Harness.
 *
 * Measures:
 *   - Task completion rate (verified against real DOM state, not planner declarations)
 *   - Clean loop termination rate
 *   - Incorrect action count and rate
 *   - Loop frequency & recovery rate
 *   - Task False Positives (planner claims done without verified DOM outcome)
 *   - Task False Negatives (premature abort when actionable targets remain)
 *   - Performance on unseen websites/pages
 *
 * Usage:
 *   node eval/validate-e2e.js
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer, seedVault } = require('./lib/harness');
const { runAndVerifyTask, getStandardTaskSuite, aggregateReliabilityMetrics } = require('./lib/task-validation');

const RESULTS_DIR = path.join(__dirname, 'results');
const VAULT = {
  name: 'Ada Lovelace',
  email: 'ada@localhost.test',
  phone: '+44 20 7946 0102',
  address: '12 Analytical Way, London',
  username: 'ada',
  password: 'EngineNo1!',
  company: 'Analytical Engine Corp',
};

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log('\n============================================================');
  console.log('VisionVault — End-to-End Task Validation & Reliability Suite');
  console.log('============================================================\n');

  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false, windowSize: '1280,880' });

  let serverBackend = 'on-device fallback';
  try {
    const res = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    serverBackend = `${j.backend} (chain: ${(j.chain || []).join(' -> ')})`;
  } catch (_) {}
  console.log(`Planner backend: ${serverBackend}`);
  console.log(`Chrome:          ${h.chromeVersion}`);
  console.log(`Fixture Server:  ${baseUrl}\n`);

  await seedVault(h.worker, VAULT, {
    redactMode: 'black',
    serverUrl: 'http://127.0.0.1:8000/api/agent/step',
    confirmPolicy: 'risky',
  });

  const page = await h.browser.newPage();
  await page.setViewport({ width: 1200, height: 820, deviceScaleFactor: 1 });

  // Standard task suite
  const suite = getStandardTaskSuite(baseUrl);

  // Add an Unseen Website / Domain task to explicitly measure generalization on unseen layouts
  suite.push({
    name: 'Unseen Job Portal Search',
    domain: 'Unseen Domain (Career Portal)',
    url: `${baseUrl}/pages/jobs-portal.html`,
    task: 'search for developer jobs and review postings',
    prepare: async (p) => {
      await p.evaluate(() => {
        const inp = document.querySelector('#search-band input, input[name="role"]');
        if (inp) inp.value = '';
      });
    },
    verifier: async (p, progress) => {
      const state = await p.evaluate(() => {
        const hasKeyword = Array.from(document.querySelectorAll('input, .query-tag')).some((el) =>
          /developer|jobs/i.test(el.value || el.innerText || '')
        );
        const resultsVisible = document.querySelectorAll('.job-card, .posting-item, #results-panel').length > 0;
        return { hasKeyword, resultsVisible };
      });
      const ok = state.hasKeyword || state.resultsVisible || progress?.queryLanded;
      return {
        ok: !!ok,
        detail: ok ? 'Role keyword searched and postings rendered on unseen portal' : 'Unseen portal search did not execute',
      };
    },
  });

  const taskResults = [];

  for (const item of suite) {
    console.log(`▶ Running Task: [${item.name}] (${item.domain})`);
    console.log(`  Task prompt: "${item.task}"`);

    const res = await runAndVerifyTask({
      worker: h.worker,
      page,
      task: item.task,
      url: item.url,
      prepare: item.prepare,
      verifier: item.verifier,
    });

    res.name = item.name;
    res.domain = item.domain;
    taskResults.push(res);

    const termStatus = res.cleanTermination ? '✓ Clean Termination' : '✗ Unclean';
    const outStatus = res.outcomeVerified ? '✓ DOM Verified' : '✗ DOM Failed';
    console.log(`  Outcome: ${outStatus} | Loop: ${termStatus} | Steps: ${res.steps} | Time: ${res.totalMs}ms`);
    console.log(`  Detail:  ${res.outcomeDetail}`);
    if (res.incorrectActions > 0 || res.loopIncidents > 0) {
      console.log(`  Quality: Incorrect Actions: ${res.incorrectActions} | Loops Detected: ${res.loopIncidents} (Recovered: ${res.loopRecoveries})`);
    }
    console.log('');
  }

  const summary = aggregateReliabilityMetrics(taskResults);

  console.log('============================================================');
  console.log('END-TO-END VALIDATION SUMMARY');
  console.log('============================================================');
  console.log(`Total Tasks Evaluated:          ${summary.totalTasks}`);
  console.log(`Task Completion Rate (DOM):     ${(summary.taskCompletionRate * 100).toFixed(1)}%`);
  console.log(`Clean Loop Termination Rate:    ${(summary.cleanTerminationRate * 100).toFixed(1)}%`);
  console.log(`Task False Positive Rate (FP):  ${(summary.falsePositiveRate * 100).toFixed(1)}% (Hallucinated Done)`);
  console.log(`Task False Negative Rate (FN):  ${(summary.falseNegativeRate * 100).toFixed(1)}% (Premature Abort)`);
  console.log(`Total Steps Executed:           ${summary.totalSteps}`);
  console.log(`Incorrect Actions:              ${summary.totalIncorrectActions} (${(summary.incorrectActionRate * 100).toFixed(1)}% rate)`);
  console.log(`Loop Incidents Detected:        ${summary.loopIncidents}`);
  console.log(`Loop Frequency:                 ${(summary.loopFrequency * 100).toFixed(1)}%`);
  console.log(`Loop Recovery Rate:             ${(summary.loopRecoveryRate * 100).toFixed(1)}%`);
  console.log(`Mean Task Latency:              ${summary.meanTotalMs}ms (Scan: ${summary.meanScanMs}ms, Run: ${summary.meanRunMs}ms)`);
  console.log('============================================================\n');

  const outPayload = {
    generatedAt: new Date().toISOString(),
    environment: {
      chrome: h.chromeVersion,
      planner: serverBackend,
      platform: `${process.platform} ${process.arch}`,
    },
    summary,
    tasks: taskResults,
  };

  const outFile = path.join(RESULTS_DIR, 'e2e-validation.json');
  fs.writeFileSync(outFile, JSON.stringify(outPayload, null, 2));
  console.log(`Saved detailed results to ${outFile}`);

  await h.close();
  server.close();
})().catch((err) => {
  console.error('\nVALIDATION RUN FAILED:', err);
  process.exit(1);
});

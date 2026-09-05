#!/usr/bin/env node
/**
 * test-agent-guard.js — unit tests for the planner supervisor.
 *
 * Every case here reproduces a failure actually observed against a live site and recorded in
 * server/logs/session.jsonl. Run: node eval/test-agent-guard.js
 */

const assert = require('assert');
const AgentGuard = require('../extension/agent-guard.js');
const TaskPlanner = require('../extension/task-planner.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const marks = [
  { id: 1, role: 'input:search', label: 'Search Amazon.in' },
  { id: 2, role: 'link', label: 'codex is down' },
  { id: 3, role: 'button', label: 'Go' },
];
const pageInfo = { url: 'https://example.test/', scroll_y: 0, page_height: 4000, viewport_height: 800 };

console.log('\nagent-guard\n');

// ── Hacker News: "scroll down" must never become a click ─────────────────────────────────
test('a click proposed for a pure scroll task becomes a scroll', () => {
  const parsed = TaskPlanner.parseTask('scroll down and show me more stories');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 2, reasoning: "matching 'down'" },
    { marks, pageInfo, progress: {}, task: 'scroll down and show me more stories' });
  assert.strictEqual(v.action.action, 'scroll_page', `got ${v.action.action}`);
  assert.ok(v.substituted);
});

test('a click on a scroll task that already scrolled ends the run', () => {
  const parsed = TaskPlanner.parseTask('scroll down and show me more stories');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 2 },
    { marks, pageInfo, progress: { scrolled: true }, task: 'scroll down' });
  assert.strictEqual(v.action.action, 'done');
});

// ── Flipkart: the conversational tail must not be typed ──────────────────────────────────
test('the whole sentence is trimmed to the parsed query', () => {
  const task = 'search for running shoes and show me';
  const parsed = TaskPlanner.parseTask(task);
  assert.strictEqual(parsed.query, 'running shoes');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'type', mark_id: 1, value: 'running shoes and show me' },
    { marks, pageInfo, progress: {}, task });
  assert.strictEqual(v.action.value, 'running shoes');
});

test('a legitimate value is left alone', () => {
  const task = 'search for running shoes';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'type', mark_id: 1, value: 'running shoes' },
    { marks, pageInfo, progress: {}, task });
  assert.strictEqual(v.action.value, 'running shoes');
  assert.ok(!v.substituted);
});

// ── GitHub / MDN: `done` on step 1 with nothing achieved ─────────────────────────────────
test('done is refused while the search has not landed', () => {
  const task = 'search for onnxruntime';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const deterministic = { action: 'type', mark_id: 1, value: 'onnxruntime' };
  const v = guard.review({ action: 'done', reasoning: 'All requested task actions completed' },
    { marks, pageInfo, progress: { searched: false }, task, deterministic });
  assert.strictEqual(v.action.action, 'type');
  assert.ok(/stopped early/i.test(v.reason), v.reason);
});

test('done is accepted once the query has landed', () => {
  const task = 'search for onnxruntime';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'done' },
    { marks, pageInfo, progress: { searched: true, queryLanded: true }, task });
  assert.strictEqual(v.action.action, 'done');
  assert.strictEqual(v.reason, '');
});

test('overriding done repeatedly with nothing changing is capped', () => {
  // The cap guards against guard and planner trading the same two answers forever. The page
  // state is held constant here, which is what "going nowhere" means.
  const task = 'search for onnxruntime';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const deterministic = { action: 'type', mark_id: 1, value: 'onnxruntime' };
  const ctx = () => ({ marks, pageInfo, progress: {}, filledIds: [], task, deterministic });
  assert.strictEqual(guard.review({ action: 'done' }, ctx()).action.action, 'type');
  assert.strictEqual(guard.review({ action: 'done' }, ctx()).action.action, 'type');
  const third = guard.review({ action: 'done' }, ctx());
  assert.strictEqual(third.action.action, 'done', 'a third fruitless override is not attempted');
  assert.ok(/could not complete/i.test(third.reason), third.reason);
});

test('overriding done stays available while the overrides are working', () => {
  // Measured live: with both hosted tiers rate-limited, a 1.5B local model answered "done" on
  // every step of a form fill. Each override filled one more field — real progress — so capping
  // at two left four fields empty. The cap counts fruitless overrides, not productive ones.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const fields = [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, role: 'input:text', label: `Field ${i}` }));
  const filled = [];
  for (let i = 0; i < 6; i++) {
    const v = guard.review({ action: 'done' }, {
      marks: fields, pageInfo, progress: { filledAny: filled.length > 0 }, filledIds: filled,
      deterministic: { action: 'type', mark_id: fields[i].id, use_vault_field: 'name' },
      task: 'fill the signup form with my details',
    });
    assert.strictEqual(v.action.action, 'type', `gave up at field ${i + 1}: ${v.reason}`);
    filled.push(fields[i].id);
  }
});

// ── MakeMyTrip: seven identical types in a row ───────────────────────────────────────────
test('an identical action repeated past the budget is refused', () => {
  const task = 'search for flights to goa';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const proposal = { action: 'type', mark_id: 1, value: 'flights to goa' };
  // Two successful executions of the same signature exhaust the budget.
  for (let i = 0; i < 2; i++) {
    const ctx = { marks, pageInfo: { ...pageInfo, scroll_y: i * 100 }, progress: {}, task };
    guard.review(proposal, ctx);
    guard.record('type', 1, 'flights to goa', true);
  }
  const v = guard.review(proposal, { marks, pageInfo: { ...pageInfo, scroll_y: 900 }, progress: {}, task });
  assert.ok(v.stop || v.substituted, 'third identical action must be blocked or replaced');
});

// ── A page that stops responding ─────────────────────────────────────────────────────────
test('an unchanging page stops the run instead of looping', () => {
  const parsed = TaskPlanner.parseTask('search for widgets');
  const guard = AgentGuard.createGuard(parsed, { maxStepsWithoutProgress: 3 });
  let v;
  for (let i = 0; i < 5; i++) {
    v = guard.review({ action: 'scroll_page', value: 600 }, { marks, pageInfo, progress: {}, task: 'search for widgets' });
    if (v.stop) break;
  }
  assert.ok(v.stop, 'guard should stop on a static page');
  assert.ok(/no visible change/i.test(v.reason), v.reason);
});

test('a navigation resets stall accounting', () => {
  const parsed = TaskPlanner.parseTask('search for widgets');
  const guard = AgentGuard.createGuard(parsed, { maxStepsWithoutProgress: 3 });
  for (let i = 0; i < 2; i++) guard.review({ action: 'scroll_page' }, { marks, pageInfo, progress: {}, task: '' });
  guard.resetStall();
  const v = guard.review({ action: 'scroll_page' }, { marks, pageInfo, progress: {}, task: '' });
  assert.ok(!v.stop, 'stall counter should have been cleared');
});

// ── Goal model ───────────────────────────────────────────────────────────────────────────
test('goalSatisfied distinguishes "typed" from "search ran"', () => {
  const parsed = TaskPlanner.parseTask('search for goa flights');
  assert.strictEqual(AgentGuard.goalSatisfied(parsed, { searched: true, queryLanded: false }), false);
  assert.strictEqual(AgentGuard.goalSatisfied(parsed, { searched: true, queryLanded: true }), true);
});

test('goalSatisfied requires every named target to be opened', () => {
  const parsed = TaskPlanner.parseTask('search for laptops and open the first result');
  assert.ok(parsed.openTargets.length >= 1, JSON.stringify(parsed.openTargets));
  assert.strictEqual(AgentGuard.goalSatisfied(parsed, { queryLanded: true, opened: [] }), false);
  assert.strictEqual(AgentGuard.goalSatisfied(parsed, { queryLanded: true, opened: parsed.openTargets }), true);
});

test('describeRemaining names what is outstanding', () => {
  const parsed = TaskPlanner.parseTask('search for goa flights');
  assert.ok(/goa flights/.test(AgentGuard.describeRemaining(parsed, {})));
  assert.strictEqual(AgentGuard.describeRemaining(parsed, { queryLanded: true }), '');
});

// ── Rule 0: stop as soon as the instruction is demonstrably carried out ──────────────────
test('a further action after the goal is met becomes done', () => {
  const parsed = TaskPlanner.parseTask('scroll down and show me more headlines');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'scroll_page', value: 600 },
    { marks, pageInfo, progress: { scrolled: true }, task: 'scroll down and show me more headlines' });
  assert.strictEqual(v.action.action, 'done');
  assert.ok(/scrolled the page/.test(v.action.reasoning), v.action.reasoning);
  assert.strictEqual(v.reason, '', 'a completed task is not an error');
});

test('a landed search stops the planner touring the results page', () => {
  const parsed = TaskPlanner.parseTask('search for iqoo neo 6 and show me');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 2, reasoning: 'Open a product' },
    { marks, pageInfo, progress: { searched: true, queryLanded: true }, task: 'search for iqoo neo 6' });
  assert.strictEqual(v.action.action, 'done');
});

test('form filling is never cut short by rule 0', () => {
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  assert.ok(parsed.wantsFill);
  assert.strictEqual(AgentGuard.goalFullyVerified(parsed, { filledAny: true }), false);
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'type', mark_id: 1, use_vault_field: 'email' },
    { marks, pageInfo, progress: { filledAny: true }, task: 'fill the signup form with my details' });
  assert.strictEqual(v.action.action, 'type', 'must keep filling the rest of the form');
});

test('an open-ended instruction is left to the planner to end', () => {
  const parsed = TaskPlanner.parseTask('do something useful here');
  assert.strictEqual(AgentGuard.goalFullyVerified(parsed, {}), false);
});

test('filling successive form fields is progress, not a stall', () => {
  // A form fill changes no page signal the guard can see: same URL, same scroll position, same
  // elements. Only the count of completed actions moves. Cutting a run off here stopped a
  // working end-to-end task four fields into six.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed, { maxStepsWithoutProgress: 3 });
  const formMarks = [
    { id: 11, role: 'input:text', label: 'Full name' },
    { id: 12, role: 'input:email', label: 'Email' },
    { id: 13, role: 'input:tel', label: 'Phone' },
    { id: 14, role: 'input:text', label: 'Address' },
    { id: 15, role: 'input:password', label: 'Password' },
    { id: 16, role: 'input:text', label: 'Username' },
  ];
  const filled = [];
  for (const m of formMarks) {
    const v = guard.review({ action: 'type', mark_id: m.id, use_vault_field: 'name' },
      { marks: formMarks, pageInfo, progress: { filledAny: filled.length > 0 }, filledIds: filled,
        task: 'fill the signup form with my details' });
    assert.ok(!v.stop, `stopped at field ${m.label}: ${v.reason}`);
    assert.strictEqual(v.action.action, 'type', `field ${m.label} -> ${v.action.action}`);
    filled.push(m.id);
  }
  assert.strictEqual(filled.length, 6, 'every field should have been attempted');
});

test('a page that changes nothing at all still stops', () => {
  // The stall rule must survive the fix above: no page change AND no completed work is still
  // a stall.
  const parsed = TaskPlanner.parseTask('search for widgets');
  const guard = AgentGuard.createGuard(parsed, { maxStepsWithoutProgress: 3 });
  let v;
  for (let i = 0; i < 6; i++) {
    v = guard.review({ action: 'scroll_page' },
      { marks, pageInfo, progress: {}, filledIds: [], task: 'search for widgets' });
    if (v.stop) break;
  }
  assert.ok(v.stop, 'a genuinely static page must still end the run');
});

// ── A half-filled form must not be submitted ─────────────────────────────────────────────
const formMarks6 = [
  { id: 21, role: 'input:text', label: 'Full name' },
  { id: 22, role: 'input:email', label: 'Email' },
  { id: 23, role: 'input:tel', label: 'Phone' },
  { id: 24, role: 'button', label: 'Create account' },
];

test('a submit click with fields still empty becomes the next field', () => {
  // Seen on the evaluation fixture: one field of six filled, then "Create account". The
  // click-risk gate caught it and asked the user — the right answer was to keep filling.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 24 }, {
    marks: formMarks6, pageInfo, progress: { filledAny: true }, filledIds: [21],
    deterministic: { action: 'type', mark_id: 22, use_vault_field: 'email' },
    task: 'fill the signup form with my details',
  });
  assert.strictEqual(v.action.action, 'type', `got ${v.action.action}`);
  assert.strictEqual(v.action.use_vault_field, 'email');
  assert.ok(/still empty/i.test(v.reason), v.reason);
});

test('the submit click is allowed once every field is filled', () => {
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 24 }, {
    marks: formMarks6, pageInfo, progress: { filledAny: true }, filledIds: [21, 22, 23],
    deterministic: { action: 'done' },
    task: 'fill the signup form with my details',
  });
  assert.strictEqual(v.action.action, 'click', 'nothing left to fill, so submitting is fair');
});

test('any click during a form fill yields to an empty field', () => {
  // Not only submit controls. Observed live: a planner opened a six-field form with a click on
  // a link it described as "navigate to the signup form", the risk gate stopped for approval,
  // and nothing was filled at all.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const withLink = [...formMarks6, { id: 25, role: 'link', label: 'Go to the signup form' }];
  const v = guard.review({ action: 'click', mark_id: 25 }, {
    marks: withLink, pageInfo, progress: { filledAny: true }, filledIds: [21],
    deterministic: { action: 'type', mark_id: 22, use_vault_field: 'email' },
    task: 'fill the signup form with my details',
  });
  assert.strictEqual(v.action.action, 'type', v.reason);
  assert.ok(/still empty/i.test(v.reason), v.reason);
});

test('a click goes through when the on-device plan has no field to fill', () => {
  // A click that genuinely reveals more of a form must not be blocked. The deterministic plan
  // only proposes a type when it has a labelled field and a vault key for it, so "nothing to
  // type" is the signal that clicking is the reasonable next move.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const withButton = [...formMarks6, { id: 25, role: 'button', label: 'Add another address' }];
  const v = guard.review({ action: 'click', mark_id: 25 }, {
    marks: withButton, pageInfo, progress: { filledAny: true }, filledIds: [21, 22, 23],
    deterministic: { action: 'done' },
    task: 'fill the signup form with my details',
  });
  assert.strictEqual(v.action.action, 'click');
});

test('the submit-label pattern respects word boundaries', () => {
  // Written as a test because this exact regex was silently disabled by a mangled word-boundary
  // escape: it parsed, loaded, and matched nothing at all for a whole evaluation run. It no
  // longer decides whether to defer the click — it decides how the reason is worded — so that
  // is what is asserted.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const fields = (label) => [
    { id: 31, role: 'input:text', label: 'Full name' },
    { id: 32, role: 'button', label },
  ];
  const reasonFor = (label) => AgentGuard.createGuard(parsed).review(
    { action: 'click', mark_id: 32 },
    {
      marks: fields(label), pageInfo, progress: {}, filledIds: [],
      deterministic: { action: 'type', mark_id: 31, use_vault_field: 'name' },
      task: 'fill the signup form with my details',
    }
  ).reason;

  assert.ok(/not submitting yet/i.test(reasonFor('Next')), 'a real submit control is named as one');
  assert.ok(/filling/i.test(reasonFor('Nextdoor neighbours')), '"Nextdoor" must not read as "next"');
});

test('done is refused while form fields remain empty', () => {
  // Seen on the evaluation fixture: a six-field signup was called done after five, leaving the
  // address blank. goalSatisfied can only ask whether anything was filled at all.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const fields = [
    { id: 41, role: 'input:text', label: 'Full name' },
    { id: 42, role: 'input:text', label: 'Address' },
  ];
  const v = guard.review({ action: 'done', reasoning: 'Form filled' }, {
    marks: fields, pageInfo, progress: { filledAny: true }, filledIds: [41],
    deterministic: { action: 'type', mark_id: 42, use_vault_field: 'address' },
    task: 'fill the signup form with my details',
  });
  assert.strictEqual(v.action.action, 'type');
  assert.strictEqual(v.action.use_vault_field, 'address');
  assert.ok(/form field/i.test(v.reason), v.reason);
});

test('done is accepted once every field is filled', () => {
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const fields = [
    { id: 41, role: 'input:text', label: 'Full name' },
    { id: 42, role: 'input:text', label: 'Address' },
  ];
  const v = guard.review({ action: 'done' }, {
    marks: fields, pageInfo, progress: { filledAny: true }, filledIds: [41, 42],
    deterministic: { action: 'done' },
    task: 'fill the signup form with my details',
  });
  assert.strictEqual(v.action.action, 'done');
  assert.strictEqual(v.reason, '');
});

test('a field that cannot be filled does not trap the agent', () => {
  // An optional field the vault has no value for is proposed, fails to change anything, and is
  // proposed again. Nothing moves, so the cap applies and the run ends.
  const parsed = TaskPlanner.parseTask('fill the signup form with my details');
  const guard = AgentGuard.createGuard(parsed);
  const fields = [
    { id: 41, role: 'input:text', label: 'Full name' },
    { id: 42, role: 'input:text', label: 'Referral code' },
  ];
  const ctx = () => ({
    marks: fields, pageInfo, progress: { filledAny: true }, filledIds: [41],
    deterministic: { action: 'type', mark_id: 42, use_vault_field: 'about' },
    task: 'fill the signup form with my details',
  });
  assert.strictEqual(guard.review({ action: 'done' }, ctx()).action.action, 'type');
  assert.strictEqual(guard.review({ action: 'done' }, ctx()).action.action, 'type');
  assert.strictEqual(guard.review({ action: 'done' }, ctx()).action.action, 'done',
    'nothing changed twice over, so the run ends');
});

// ── Search Task: Distractor / Sign-in clicks are intercepted ─────────────────────────────
test('clicking sign-in or bestsellers before search query lands is intercepted', () => {
  const task = 'open amazon and search headsets';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const amazonMarks = [
    { id: 101, role: 'input:search', label: 'Search Amazon.in' },
    { id: 102, role: 'link', label: 'Hello, sign in Account & Lists' },
    { id: 103, role: 'link', label: 'Bestsellers' },
  ];
  const deterministic = { action: 'type', mark_id: 101, value: 'headsets', reasoning: 'Search for "headsets"' };

  // Model hallucinates and tries to click "Bestsellers"
  const v1 = guard.review({ action: 'click', mark_id: 103, reasoning: "explore bestsellers" },
    { marks: amazonMarks, pageInfo, progress: { queryLanded: false }, task, deterministic });
  assert.strictEqual(v1.action.action, 'type');
  assert.strictEqual(v1.action.mark_id, 101);
  assert.strictEqual(v1.action.value, 'headsets');
  assert.ok(v1.substituted);

  // Model tries to click "Sign in"
  const v2 = guard.review({ action: 'click', mark_id: 102, reasoning: "sign in to account" },
    { marks: amazonMarks, pageInfo, progress: { queryLanded: false }, task, deterministic });
  assert.strictEqual(v2.action.action, 'type');
  assert.strictEqual(v2.action.mark_id, 101);
  assert.strictEqual(v2.action.value, 'headsets');
  assert.ok(v2.substituted);
});

test('semantic loop detection catches repeated clicks on same label with shifting mark IDs', () => {
  const task = 'explore items';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  // Step 1: Click "Sign in" (mark 201)
  const m1 = [{ id: 201, role: 'link', label: 'Sign in' }];
  guard.review({ action: 'click', mark_id: 201 }, { marks: m1, pageInfo, progress: {}, task });
  guard.record('click', 201, null, true, 'Sign in');

  // Step 2: Page re-rendered, new mark ID 305 for "Sign in"
  const m2 = [{ id: 305, role: 'link', label: 'Sign in' }];
  guard.review({ action: 'click', mark_id: 305 }, { marks: m2, pageInfo, progress: {}, task });
  guard.record('click', 305, null, true, 'Sign in');

  // Step 3: Page re-rendered again, mark ID 409 for "Sign in"
  const m3 = [{ id: 409, role: 'link', label: 'Sign in' }];
  const v3 = guard.review({ action: 'click', mark_id: 409 }, { marks: m3, pageInfo, progress: {}, task });
  assert.ok(v3.stop || v3.substituted, 'repeated semantic clicks must be blocked');
});

test('e-commerce add to cart task refuses done when search landed but cartAdded is false', () => {
  const task = 'go to amazon and search for headphones under 6000 with rating 3.5 and see the best among them and add to cart';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const marks = [{ id: 61, role: 'button', label: 'Add to Cart' }];

  // Planner proposes done prematurely on search results
  const v = guard.review({ action: 'done', reasoning: 'Search query landed' }, {
    marks,
    pageInfo: { url: 'https://www.amazon.in/s?k=headphones' },
    progress: { navigated: true, searched: true, queryLanded: true, cartAdded: false },
    deterministic: { action: 'click', mark_id: 61, reasoning: 'Click Add to Cart' },
    task,
  });
  // Guard must NOT accept done; it must substitute the pending action
  assert.notStrictEqual(v.action.action, 'done', 'premature done on add-to-cart task must be refused');
});

test('e-commerce add to cart task accepts done once cartAdded is true', () => {
  const task = 'go to amazon and search for headphones under 6000 with rating 3.5 and see the best among them and add to cart';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  const v = guard.review({ action: 'done', reasoning: 'Item added to cart' }, {
    marks: [{ id: 70, role: 'heading', label: 'Added to Cart' }],
    pageInfo: { url: 'https://www.amazon.in/cart' },
    progress: { navigated: true, searched: true, queryLanded: true, productOpened: true, cartAdded: true },
    task,
  });
  assert.strictEqual(v.action.action, 'done', 'done is accepted after cartAdded is true');
});

test('e-commerce filter task refuses done when query landed but filterApplied is false', () => {
  const task = 'go to flipkart and search for headsets and apply filter from price under 6000';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  const marks = [
    { id: 20, role: 'select', label: 'Min' },
    { id: 21, role: 'select', label: '₹4000+' },
  ];

  const v = guard.review({ action: 'done', reasoning: 'Search landed' }, {
    marks,
    pageInfo: { url: 'https://www.flipkart.com/search?q=headsets' },
    progress: { navigated: true, searched: true, queryLanded: true, filterApplied: false },
    deterministic: { action: 'select', mark_id: 21, value: '6000' },
    task,
  });
  assert.notStrictEqual(v.action.action, 'done', 'premature done on filter task must be refused');
});

test('e-commerce filter task accepts done once filterApplied is true', () => {
  const task = 'go to flipkart and search for headsets and apply filter from price under 6000';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  const v = guard.review({ action: 'done', reasoning: 'Filter applied' }, {
    marks: [{ id: 20, role: 'select', label: 'Min' }],
    pageInfo: { url: 'https://www.flipkart.com/search?q=headsets' },
    progress: { navigated: true, searched: true, queryLanded: true, filterApplied: true },
    task,
  });
  assert.strictEqual(v.action.action, 'done', 'done is accepted once filterApplied is true');
});

test('github star task refuses premature done before repo is starred', () => {
  const task = 'go to github and search for vision-agent and star it';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  const v = guard.review({ action: 'done', reasoning: 'Repo opened' }, {
    marks: [{ id: 320, role: 'button', label: 'Star' }],
    pageInfo: { url: 'https://github.com/NateshKannaR/vision-agent' },
    progress: { navigated: true, searched: true, queryLanded: true, repoOpened: true, starred: false },
    deterministic: { action: 'click', mark_id: 320, isStar: true },
    task,
  });
  assert.notStrictEqual(v.action.action, 'done', 'premature done on star task must be refused');
  assert.strictEqual(v.action.action, 'click');
});

test('github star task accepts done once starred is true', () => {
  const task = 'go to github and search for vision-agent and star it';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  const v = guard.review({ action: 'done', reasoning: 'Starred' }, {
    marks: [{ id: 320, role: 'button', label: 'Starred' }],
    pageInfo: { url: 'https://github.com/NateshKannaR/vision-agent' },
    progress: { navigated: true, searched: true, queryLanded: true, repoOpened: true, starred: true },
    task,
  });
  assert.strictEqual(v.action.action, 'done', 'done accepted once starred');
});

test('makemytrip non-stop flight task refuses done before non-stop filter applied', () => {
  const task = 'go to makemytrip and search flights from delhi to mumbai non stop';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  const v = guard.review({ action: 'done', reasoning: 'Searched flights' }, {
    marks: [{ id: 401, role: 'checkbox', label: 'Non Stop' }],
    pageInfo: { url: 'https://www.makemytrip.com/flight/search' },
    progress: { navigated: true, bookingStep: 6, fromTyped: true, toTyped: true, filledAny: true, nonStopFiltered: false },
    deterministic: { action: 'click', mark_id: 401, isNonStop: true },
    task,
  });
  assert.notStrictEqual(v.action.action, 'done', 'premature done on non-stop flight task must be refused');
});

test('sorting task refuses done before sortApplied is true', () => {
  const task = 'go to amazon and search for gaming mouse and sort by price low to high';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);

  const v = guard.review({ action: 'done', reasoning: 'Search landed' }, {
    marks: [{ id: 501, role: 'select', label: 'Sort by:' }],
    pageInfo: { url: 'https://www.amazon.in/s?k=gaming+mouse' },
    progress: { navigated: true, searched: true, queryLanded: true, sortApplied: false },
    deterministic: { action: 'select', mark_id: 501, value: 'price-asc-rank' },
    task,
  });
  assert.notStrictEqual(v.action.action, 'done', 'premature done on sort task must be refused');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);


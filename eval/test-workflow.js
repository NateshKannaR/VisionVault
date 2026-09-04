#!/usr/bin/env node
/**
 * test-workflow.js — the workflow layer: decomposition, milestone planning, and choosing.
 *
 * The agent now works to a plan rather than one action at a time, so three things have to hold
 * before anything reaches a browser:
 *
 *   1. A sentence becomes the right ordered milestones — including the steps the user implied
 *      but never said ("the best laptop" implies reading the options and choosing one).
 *   2. The on-device planner advances that plan one milestone at a time, and stops.
 *   3. Choosing between what was read respects ratings, price and a stated budget.
 *
 * Run: node eval/test-workflow.js
 */

const assert = require('assert');
const TaskPlanner = require('../extension/task-planner.js');
const AgentGuard = require('../extension/agent-guard.js');

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

const kinds = (task) => TaskPlanner.decomposeTask(task).milestones.map((m) => m.kind);
const titles = (task) => TaskPlanner.decomposeTask(task).milestones.map((m) => m.title);

console.log('\ndecomposition\n');

test('a plain search is one milestone', () => {
  assert.deepStrictEqual(kinds('search for onnxruntime'), ['search']);
});

test('a named site is opened before the search', () => {
  assert.deepStrictEqual(kinds('open amazon and search for iqoo neo 6 and show me'), ['navigate', 'search']);
  const m = TaskPlanner.decomposeTask('open amazon and search for iqoo neo 6').milestones;
  assert.strictEqual(m[0].target, 'https://www.amazon.in');
  assert.strictEqual(m[1].target, 'iqoo neo 6');
});

test('"and show me" is a way of talking, not a milestone', () => {
  // It described what the user wants to SEE. Treating it as an instruction produced an "act"
  // milestone called "Show me" that no page could ever satisfy.
  assert.ok(!kinds('open amazon and search for iqoo neo 6 and show me').includes('act'));
});

test('the full e-commerce journey decomposes in order', () => {
  const task = 'Find the best laptop under my budget, compare available options, analyze ratings ' +
               'and specifications, select the most suitable one, add it to cart, and prepare checkout.';
  assert.deepStrictEqual(kinds(task), ['search', 'read', 'open', 'act', 'act']);
  const m = TaskPlanner.decomposeTask(task).milestones;
  assert.strictEqual(m[0].target, 'laptop', `query was ${m[0].target}`);
  assert.strictEqual(m[2].target, 'best');
  assert.strictEqual(m[3].target, 'add to cart');
  assert.strictEqual(m[4].target, 'checkout');
});

test('"the best X" implies reading and choosing even when unsaid', () => {
  // The user never says "compare" here, but picking a best one without looking is guesswork.
  assert.deepStrictEqual(kinds('search for the best noise cancelling headphones'), ['search', 'read', 'open']);
});

test('two consecutive read clauses are one read of one page', () => {
  // "compare the options" and "analyse the ratings" describe one look at one results page.
  // Reading it twice cost a step and told the planner nothing new.
  const k = kinds('search for laptops, compare the options and analyze the ratings');
  assert.strictEqual(k.filter((x) => x === 'read').length, 1, k.join(','));
});

test('asking to be told something adds a read and an answer', () => {
  const k = kinds('go to flipkart, search for running shoes under 3000 and tell me the cheapest one');
  assert.deepStrictEqual(k, ['navigate', 'search', 'read', 'answer']);
});

test('research and summarise is read then answer', () => {
  assert.deepStrictEqual(kinds('Research and summarize the top 3 python web frameworks'), ['read', 'answer']);
});

test('a budget qualifier is a filter, not part of the query', () => {
  // "laptop under my budget" must search for "laptop"; the budget applies when choosing.
  const m = TaskPlanner.decomposeTask('find the best laptop under my budget').milestones;
  assert.strictEqual(m[0].target, 'laptop');
});

test('"and" inside a query is not a clause boundary', () => {
  // A clause only starts at a verb. "salt and pepper" has no verb after "and".
  assert.strictEqual(TaskPlanner.parseTask('search for salt and pepper').query, 'salt and pepper');
  assert.deepStrictEqual(kinds('search for salt and pepper'), ['search']);
});

test('form filling is one milestone', () => {
  assert.deepStrictEqual(kinds('fill the signup form with my details'), ['fill']);
});

test('a scroll task does not acquire a search', () => {
  // "show me more headlines" once became a search for "more headlines".
  assert.deepStrictEqual(kinds('scroll down and show me more headlines'), ['scroll']);
});

test('an instruction with no recognisable verb still yields a milestone', () => {
  const m = TaskPlanner.decomposeTask('book a flight from delhi to goa on 12 october').milestones;
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].kind, 'act');
});

test('milestone ids are contiguous from 1', () => {
  const m = TaskPlanner.decomposeTask('find the best laptop, add it to cart and checkout').milestones;
  assert.deepStrictEqual(m.map((x) => x.id), m.map((_, i) => i + 1));
});

console.log('\nplanning against a plan\n');

const pageInfo = { url: 'https://shop.test/', scroll_y: 0, page_height: 3000, viewport_height: 800 };
const resultMarks = [
  { id: 1, role: 'input:search', label: 'Search the store' },
  { id: 2, role: 'link', label: 'Aurora 14 Ultrabook 16GB' },
  { id: 3, role: 'link', label: 'Nimbus Pro 15 32GB' },
  { id: 4, role: 'button', label: 'Add to bag' },
];

function planFor(task) {
  return TaskPlanner.decomposeTask(task);
}
function step(state) {
  return TaskPlanner.planNextAction(state);
}

test('the first milestone drives the first action', () => {
  const plan = planFor('search for laptops');
  const a = step({ task: 'search for laptops', plan, marks: resultMarks, filledIds: [], pageInfo, progress: {} });
  assert.strictEqual(a.action, 'type');
  assert.strictEqual(a.mark_id, 1);
  assert.strictEqual(a.value, 'laptops');
});

test('a satisfied milestone is reported done rather than repeated', () => {
  const plan = planFor('search for laptops');
  const a = step({ task: 'search for laptops', plan, marks: resultMarks, filledIds: [1], pageInfo,
                   progress: { queryLanded: true, querySubmitted: true } });
  assert.strictEqual(a.action, 'next_milestone');
  assert.ok(a.milestoneDone);
});

test('a read milestone reads the page before concluding anything', () => {
  const plan = planFor('search for the best laptop');
  plan.milestones[0].status = 'done';
  const a = step({ task: 'search for the best laptop', plan, marks: resultMarks, filledIds: [], pageInfo,
                   progress: { queryLanded: true }, recentActions: [] });
  assert.strictEqual(a.action, 'read_page');
});

test('once read, the read milestone produces findings and completes', () => {
  const plan = planFor('search for the best laptop');
  plan.milestones[0].status = 'done';
  const a = step({
    task: 'search for the best laptop', plan, marks: resultMarks, filledIds: [], pageInfo,
    progress: { queryLanded: true },
    recentActions: [{ type: 'read_page', ok: true }],
    pageContent: { items: [{ title: 'Aurora 14 Ultrabook 16GB', price: '₹54,999', rating: '4.4/5' }] },
  });
  assert.strictEqual(a.action, 'answer');
  assert.ok(a.milestoneDone);
  assert.strictEqual(a.findings.items.length, 1);
});

test('the same page is never read twice in a row', () => {
  // A second read costs a step and returns the identical content; the planner must move on.
  const plan = planFor('read this page and summarize it');
  const a = step({
    task: 'read this page and summarize it', plan, marks: resultMarks, filledIds: [], pageInfo, progress: {},
    recentActions: [{ type: 'read_page', ok: true }],
    pageContent: { items: [], text: 'Some article text.' },
  });
  assert.notStrictEqual(a.action, 'read_page');
});

test('"open the best match" clicks the item the findings actually favour', () => {
  const plan = planFor('search for the best laptop');
  plan.milestones[0].status = 'done';
  plan.milestones[1].status = 'done';
  const a = step({
    task: 'search for the best laptop', plan, marks: resultMarks, filledIds: [], pageInfo,
    progress: { queryLanded: true },
    findings: [{ items: [
      { title: 'Nimbus Pro 15 32GB', price: '₹71,000', rating: '4.7/5' },
      { title: 'Aurora 14 Ultrabook 16GB', price: '₹54,999', rating: '4.4/5' },
    ] }],
  });
  assert.strictEqual(a.action, 'click');
  assert.strictEqual(a.mark_id, 3, 'the 4.7-rated item is mark 3');
});

test('an item that was read but is not on screen is scrolled to, not guessed at', () => {
  const plan = planFor('search for the best laptop');
  plan.milestones[0].status = 'done';
  plan.milestones[1].status = 'done';
  const a = step({
    task: 'search for the best laptop', plan, marks: [resultMarks[0]], filledIds: [], pageInfo,
    progress: { queryLanded: true },
    findings: [{ items: [{ title: 'Zephyr X1 Creator Edition', price: '₹88,000', rating: '4.9/5' }] }],
  });
  assert.strictEqual(a.action, 'scroll_to');
  assert.ok(/Zephyr/.test(a.value));
});

test('an act milestone matches a control by purpose, not exact words', () => {
  // The task says "add it to cart"; the page says "Add to bag".
  const plan = planFor('add it to cart');
  const a = step({ task: 'add it to cart', plan, marks: resultMarks, filledIds: [], pageInfo, progress: {} });
  assert.strictEqual(a.action, 'click');
  assert.strictEqual(a.mark_id, 4);
});

test('a milestone nothing on the page can advance is declared stuck, not "done"', () => {
  // "book a flight from delhi to goa on 12 october" is not a label on any page. Searching the
  // DOM for it wastes steps — but answering "done" is worse still: the loop treats done as
  // terminal, so one unachievable milestone ended a whole workflow with the achievable ones
  // untouched. Measured: a five-stage shopping journey stopped at two of five. `milestoneStuck`
  // says "not this one", and the caller moves to the next milestone.
  const plan = planFor('book a flight from delhi to goa on 12 october');
  const a = step({ task: 'book a flight from delhi to goa on 12 october', plan, marks: resultMarks,
                   filledIds: [], pageInfo, progress: {} });
  assert.strictEqual(a.action, 'next_milestone');
  assert.ok(a.milestoneStuck, 'it must be marked stuck, not achieved');
  assert.ok(/nothing on this page/i.test(a.reasoning), a.reasoning);
});

test('a milestone with no target is read from its title', () => {
  // Models return titles reliably and targets erratically. A null target left the planner with
  // nothing to match, so it answered "done" and ended the run two milestones in.
  const plan = TaskPlanner.normalizePlan({ milestones: [
    { id: 1, kind: 'search', title: 'Search for "laptop under 50000"', target: null },
    { id: 2, kind: 'read', title: 'Analyze laptop listings', target: null },
    { id: 3, kind: 'act', title: 'Select best-rated laptop', target: null },
    { id: 4, kind: 'act', title: 'Add to cart', target: null },
  ] });
  assert.strictEqual(plan.milestones[0].target, 'laptop under 50000');
  assert.strictEqual(plan.milestones[2].kind, 'open', '"select the best" is an open, not a generic act');
  assert.strictEqual(plan.milestones[2].target, 'best');
  assert.strictEqual(plan.milestones[3].target, 'add to cart', 'the verb IS part of the button label here');
});

test('a normalised "add to cart" milestone finds a button that says "Add to bag"', () => {
  const plan = TaskPlanner.normalizePlan({ milestones: [{ id: 1, kind: 'act', title: 'Add to cart', target: null }] });
  const a = step({ task: 'add it to the cart', plan, marks: resultMarks, filledIds: [], pageInfo, progress: {} });
  assert.strictEqual(a.action, 'click');
  assert.strictEqual(a.mark_id, 4);
});

test('a completed plan ends the run', () => {
  const plan = planFor('search for laptops');
  plan.milestones.forEach((m) => { m.status = 'done'; });
  assert.ok(TaskPlanner.planComplete(plan));
  assert.strictEqual(TaskPlanner.currentMilestone(plan), null);
});

console.log('\nchoosing between what was read\n');

const items = [
  { title: 'Aurora 14', price: '₹54,999', rating: '4.4/5' },
  { title: 'Nimbus Pro 15', price: '₹71,000', rating: '4.7/5' },
  { title: 'Basic 11', price: '₹22,000', rating: '3.6/5' },
  { title: 'Vertex 16', price: '₹48,500', rating: '4.7/5' },
];

test('the highest rating wins, and price breaks the tie', () => {
  const best = TaskPlanner.pickBestItem([{ items }], '', 'find the best laptop');
  assert.strictEqual(best.title, 'Vertex 16', 'two items rate 4.7; the cheaper one wins');
});

test('a budget in the task is respected', () => {
  const best = TaskPlanner.pickBestItem([{ items }], '', 'find the best laptop under 50000');
  assert.strictEqual(best.title, 'Vertex 16');
});

test('a budget that excludes the best forces the next one down', () => {
  const best = TaskPlanner.pickBestItem([{ items }], '', 'find the best laptop under 30000');
  assert.strictEqual(best.title, 'Basic 11');
});

test('a budget in the standing preferences works the same way', () => {
  const best = TaskPlanner.pickBestItem([{ items }], 'budget under ₹30,000', 'find the best laptop');
  assert.strictEqual(best.title, 'Basic 11');
});

test('an impossible budget still returns something rather than nothing', () => {
  // Refusing to choose leaves the run with no next action at all; the honest fallback is the
  // best available item, and the summary says what it cost.
  const best = TaskPlanner.pickBestItem([{ items }], '', 'find the best laptop under 100');
  assert.ok(best && best.title);
});

test('no findings means no choice, not a wrong one', () => {
  assert.strictEqual(TaskPlanner.pickBestItem([], '', 'anything'), null);
});

console.log('\nlabel matching by purpose\n');

const M = TaskPlanner.labelMatches;
test('synonyms of the same purpose match', () => {
  assert.ok(M('add to cart', 'Add to Bag'));
  assert.ok(M('add to cart', 'ADD TO BASKET'));
  assert.ok(M('checkout', 'Proceed to Buy'));
  assert.ok(M('checkout', 'Place order'));
  assert.ok(M('continue', 'Proceed'));
  assert.ok(M('sign in', 'Log in'));
});
test('unrelated labels do not match', () => {
  assert.ok(!M('continue', 'Nextdoor neighbours'), '"Nextdoor" is not "next"');
  assert.ok(!M('add to cart', 'Add a review'));
  assert.ok(!M('checkout', 'Check your order history'));
});
test('a multi-word target matches when every significant word is present', () => {
  assert.ok(M('documentation', 'Read the documentation'));
  assert.ok(M('privacy policy', 'Our Privacy Policy'));
  assert.ok(!M('privacy policy', 'Privacy'));
});

console.log('\nthe guard understands a plan\n');

test('a plan with milestones outstanding is not "done"', () => {
  const plan = planFor('find the best laptop, add it to cart');
  const parsed = TaskPlanner.parseTask('find the best laptop, add it to cart');
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'done' }, {
    marks: resultMarks, pageInfo, progress: { queryLanded: true }, plan,
    deterministic: { action: 'read_page' }, task: 'find the best laptop, add it to cart',
  });
  assert.notStrictEqual(v.action.action, 'done', v.reason);
});

test('a plan with every milestone done ends the run', () => {
  const plan = planFor('search for laptops');
  plan.milestones.forEach((m) => { m.status = 'done'; });
  const parsed = TaskPlanner.parseTask('search for laptops');
  assert.ok(AgentGuard.goalFullyVerified(parsed, {}, plan));
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 2 }, {
    marks: resultMarks, pageInfo, progress: {}, plan, task: 'search for laptops',
  });
  assert.strictEqual(v.action.action, 'done');
});

test('completing milestones counts as progress, so a working run is not called a stall', () => {
  // Reading a page and answering leaves the URL, scroll position and element list identical.
  // Without milestones in the fingerprint that read as four steps of nothing happening.
  const plan = planFor('read this page and summarize it');
  const parsed = TaskPlanner.parseTask('read this page and summarize it');
  const guard = AgentGuard.createGuard(parsed);
  let v;
  for (let i = 0; i < 4; i++) {
    if (i > 0) plan.milestones[Math.min(i - 1, plan.milestones.length - 1)].status = 'done';
    v = guard.review({ action: 'read_page' }, {
      marks: resultMarks, pageInfo, progress: {}, plan, filledIds: [],
      task: 'read this page and summarize it',
    });
  }
  assert.ok(!v.stop, `guard stopped a progressing run: ${v.reason}`);
});

test('the scroll-only rule does not fire inside a larger workflow', () => {
  // "scroll" appears in many multi-step tasks. Blocking every click in them would break the
  // workflow; the rule belongs to a task that is ONLY a scroll.
  const task = 'search for laptops, scroll down and open the best one';
  const plan = planFor(task);
  plan.milestones[0].status = 'done';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 2 }, {
    marks: resultMarks, pageInfo, progress: { queryLanded: true, scrolled: true }, plan, task,
  });
  assert.strictEqual(v.action.action, 'click', v.reason);
});

test('a link is not followed while the search still has to run', () => {
  // Observed live on eBay: the first action of a search task was a click on an unlabelled link.
  // It navigated off the home page, the search box went with it, two attempts to reveal another
  // failed, and the milestone was abandoned — one wrong click cost the whole task.
  const task = 'search for mechanical keyboard';
  const plan = planFor(task);
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 2, reasoning: 'Navigates to the deals page' }, {
    marks: resultMarks, pageInfo, progress: {}, plan, filledIds: [], task,
  });
  assert.strictEqual(v.action.action, 'type', v.reason);
  assert.strictEqual(v.action.mark_id, 1, 'it types into the search box');
  assert.strictEqual(v.action.value, 'mechanical keyboard');
});

test('a BUTTON may still be clicked while a search is outstanding', () => {
  // On GitHub and MDN a button is exactly what mounts the search input, so the rule must be
  // about links specifically, not about clicking.
  const task = 'search for mechanical keyboard';
  const plan = planFor(task);
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const marks = [{ id: 9, role: 'button', label: 'Open search' }];
  const v = guard.review({ action: 'click', mark_id: 9, reasoning: 'Open the search box' }, {
    marks, pageInfo, progress: {}, plan, filledIds: [], task,
  });
  assert.strictEqual(v.action.action, 'click', v.reason);
});

test('an "answer" milestone may not click things', () => {
  // Observed live: with the right laptop already in the cart, a planner answered the final
  // "Confirm selection" milestone with a click on a different, more expensive product. An
  // answer milestone is about stating a conclusion from what was read; the DOM is not involved.
  const task = 'find the best laptop and tell me which one you chose';
  const plan = planFor(task);
  for (const m of plan.milestones) if (m.kind !== 'answer') m.status = 'done';
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'click', mark_id: 2, reasoning: 'Navigates to the best laptop' }, {
    marks: resultMarks, pageInfo, progress: {}, plan, filledIds: [],
    deterministic: { action: 'answer', value: 'Best match: Vertex 16 Slim.' }, task,
  });
  assert.strictEqual(v.action.action, 'answer', v.reason);
  assert.ok(/conclusion/i.test(v.reason), v.reason);
});

test('a "read" milestone may still scroll to see more of the page', () => {
  // The rule bans clicking around during a read, not moving down the page to read the rest.
  const task = 'compare the options on this page';
  const plan = planFor(task);
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const v = guard.review({ action: 'scroll_page', value: 600 }, {
    marks: resultMarks, pageInfo, progress: {}, plan, filledIds: [],
    deterministic: { action: 'read_page' }, task,
  });
  assert.strictEqual(v.action.action, 'scroll_page', v.reason);
});

test('a fill milestone still refuses to submit a half-empty form', () => {
  const task = 'fill the signup form with my details';
  const plan = planFor(task);
  const parsed = TaskPlanner.parseTask(task);
  const guard = AgentGuard.createGuard(parsed);
  const formMarks = [
    { id: 21, role: 'input:text', label: 'Full name' },
    { id: 22, role: 'input:email', label: 'Email address' },
    { id: 23, role: 'button', label: 'Create account' },
  ];
  const v = guard.review({ action: 'click', mark_id: 23 }, {
    marks: formMarks, pageInfo, progress: { filledAny: true }, filledIds: [21], plan,
    deterministic: { action: 'type', mark_id: 22, use_vault_field: 'email' }, task,
  });
  assert.strictEqual(v.action.action, 'type', v.reason);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

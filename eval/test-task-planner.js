#!/usr/bin/env node
/**
 * test-task-planner.js — Unit tests for the on-device task parser and planner.
 *
 * These run in Node with no browser, and cover the two failures seen in real use:
 *   • "search for iqoo neo 6 and show me" typing the whole sentence into the search box;
 *   • the agent continuing to click links after the instruction had been carried out.
 */

const assert = require('assert');
const { parseTask, planNextAction, alreadyOnSite } = require('../extension/task-planner.js');

let checks = 0;
const failures = [];

function is(actual, expected, label) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`);
  }
}

console.log('\nQuery extraction');
console.log('----------------');
const queryCases = [
  ['search for iqoo neo 6 and show me', 'iqoo neo 6'],
  ['search for iqoo mobile and show me', 'iqoo mobile'],
  ['search iqoo neo 6', 'iqoo neo 6'],
  ['please search for wireless headphones and show me the results', 'wireless headphones'],
  ['look for noise cancelling earbuds, then show me', 'noise cancelling earbuds'],
  ['search for laptop bags and open the first result', 'laptop bags'],
  ['open amazon and search for iqoo neo 6 and show me', 'iqoo neo 6'],
  ['go to flipkart and search for running shoes', 'running shoes'],
  ['search for "quantum computing" and tell me', 'quantum computing'],
  ['can you search for flights to delhi please', 'flights to delhi'],
];
for (const [input, expected] of queryCases) {
  is(parseTask(input).query, expected, `"${input}"`);
}

console.log('\nSite resolution');
console.log('---------------');
is(parseTask('open amazon and search for shoes').siteUrl, 'https://www.amazon.in', 'amazon -> amazon.in');
is(parseTask('open makemytrip and search for flights to goa').siteUrl, 'https://www.makemytrip.com', 'makemytrip');
is(parseTask('go to flipkart').siteUrl, 'https://www.flipkart.com', 'flipkart');
is(parseTask('open whatsapp').siteUrl, 'https://web.whatsapp.com', 'whatsapp -> web.whatsapp.com');
is(parseTask('search for shoes').siteUrl, null, 'no site named -> stay on the current page');
is(parseTask('open the first result').siteUrl, null, '"open the first result" is not a site');

console.log('\nFollow-up targets');
console.log('-----------------');
is(parseTask('search for laptop bags and open the first result').openTargets, ['first result'], 'first result (leading article dropped)');
is(parseTask('search for python tutorials and click documentation').openTargets, ['documentation'], 'named target');
is(parseTask('search for shoes and show me').openTargets, [], 'a conversational tail is not a target');

console.log('\nalreadyOnSite');
console.log('-------------');
is(alreadyOnSite('https://www.amazon.in/s?k=x', 'https://www.amazon.in'), true, 'www.amazon.in matches');
is(alreadyOnSite('https://amazon.in/dp/123', 'https://www.amazon.in'), true, 'bare amazon.in matches');
is(alreadyOnSite('https://www.google.com', 'https://www.amazon.in'), false, 'different site does not match');

console.log('\nPlanning: the search runs once, then the task ends');
console.log('--------------------------------------------------');
const marks = [
  { id: 101, role: 'input:search', label: 'search amazon.in', box: {} },
  { id: 102, role: 'link', label: 'todays deals', box: {} },
  { id: 103, role: 'link', label: 'mobiles', box: {} },
  { id: 104, role: 'button', label: 'add to cart', box: {} },
];
const task = 'search for iqoo neo 6 and show me';

const step1 = planNextAction({ task, marks, filledIds: [], pageInfo: { url: 'https://www.amazon.in' }, progress: {} });
is({ a: step1.action, v: step1.value, m: step1.mark_id }, { a: 'type', v: 'iqoo neo 6', m: 101 },
   'step 1 types the clean query into the search box');

const step2 = planNextAction({ task, marks, filledIds: [101], pageInfo: { url: 'https://www.amazon.in/s?k=iqoo' }, progress: { searched: true } });
is(step2.action, 'done', 'step 2 stops instead of clicking "mobiles" because a task word matched');

console.log('\nPlanning: navigation happens before searching');
console.log('---------------------------------------------');
const navTask = 'open makemytrip and search for flights to goa';
const nav1 = planNextAction({ task: navTask, marks: [], filledIds: [], pageInfo: { url: 'https://www.google.com' }, progress: {} });
is({ a: nav1.action, v: nav1.value }, { a: 'navigate', v: 'https://www.makemytrip.com' }, 'navigates to the named site first');

const nav2 = planNextAction({
  task: navTask, marks, filledIds: [],
  pageInfo: { url: 'https://www.makemytrip.com' }, progress: { navigated: true },
});
is({ a: nav2.action, v: nav2.value }, { a: 'type', v: 'flights to goa' }, 'then searches on that site');

console.log('\nPlanning: an explicit target IS clicked');
console.log('---------------------------------------');
const openTask = 'search for laptop bags and open the first result';
const open1 = planNextAction({
  task: openTask,
  marks: [{ id: 201, role: 'link', label: 'wildcraft laptop backpack 30l', box: {} }],
  filledIds: [], pageInfo: { url: 'https://www.amazon.in/s?k=laptop+bags' },
  progress: { searched: true },
});
is({ a: open1.action, m: open1.mark_id }, { a: 'click', m: 201 }, 'clicks the first result when asked to');

const open2 = planNextAction({
  task: openTask,
  marks: [{ id: 201, role: 'link', label: 'wildcraft laptop backpack 30l', box: {} }],
  filledIds: [], pageInfo: { url: 'https://www.amazon.in/dp/xyz' },
  progress: { searched: true, opened: ['first result'] },
});
is(open2.action, 'done', 'and stops once that target has been opened');

// ── A field's own label decides what belongs in it ───────────────────────────────────────
//
// A planner shown "Aadhaar number" and a menu of eight vault keys picks the nearest one rather
// than declining; observed live, it chose `phone`. The label overrules it, and a label naming
// an identifier the vault has no equivalent for is put to the user instead of guessed at.
console.log('\nvault key from a field label\n');

is(TaskPlanner.vaultKeyForLabel('Email address').key, 'email', 'email address -> email');
is(TaskPlanner.vaultKeyForLabel('Mobile number').key, 'phone', 'mobile number -> phone');
is(TaskPlanner.vaultKeyForLabel('Username').key, 'username', 'username -> username');
is(TaskPlanner.vaultKeyForLabel('Full name').key, 'name', 'full name -> name');
is(TaskPlanner.vaultKeyForLabel('Postcode').key, 'address', 'postcode -> address');

is(TaskPlanner.vaultKeyForLabel('Aadhaar number'),
   { key: null, unknownIdentifier: true }, 'aadhaar is an identifier the vault has no key for');
is(TaskPlanner.vaultKeyForLabel('PAN card number'),
   { key: null, unknownIdentifier: true }, 'PAN likewise');
is(TaskPlanner.vaultKeyForLabel('Passport number'),
   { key: null, unknownIdentifier: true }, 'passport likewise');
is(TaskPlanner.vaultKeyForLabel('CVV'),
   { key: null, unknownIdentifier: true }, 'a card security code is never guessed at');

is(TaskPlanner.vaultKeyForLabel('Referral code'),
   { key: null, unknownIdentifier: false }, 'an unrecognised field is neither mapped nor flagged');
is(TaskPlanner.vaultKeyForLabel(''),
   { key: null, unknownIdentifier: false }, 'an empty label says nothing');

// "Company name" must not be read as a person's name by the trailing \bname\b rule.
is(TaskPlanner.vaultKeyForLabel('Company').key, 'company', 'company -> company');

// ── Messaging: WhatsApp task parsing and planning ──────────────────────────────────────────
console.log('\nMessaging: WhatsApp task parsing and planning\n');
const waParsed = TaskPlanner.parseTask('open whatsapp and send hi to niswan');
is(waParsed.site, 'whatsapp', 'site is whatsapp');
is(waParsed.siteUrl, 'https://web.whatsapp.com', 'siteUrl is web.whatsapp.com');
is(waParsed.wantsMessage, true, 'wantsMessage is true');
is(waParsed.recipient, 'niswan', 'recipient is niswan');
is(waParsed.message, 'hi', 'message is hi');
is(waParsed.category, null, 'category is null (not flights!)');
is(waParsed.to, null, 'to city is null (not niswan!)');

const waStep1 = TaskPlanner.planNextAction({
  task: 'open whatsapp and send hi to niswan',
  marks: [
    { id: 1, role: 'editable', label: 'Type a message' },
    { id: 2, role: 'button', label: 'Send' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://web.whatsapp.com' },
  progress: { navigated: true },
});
is(waStep1.action, 'click', 'clicks send button when visible');
is(waStep1.mark_id, 2, 'target is send button mark');

// Do NOT click "Send document"
const waDocStep = TaskPlanner.planNextAction({
  task: 'open whatsapp and send hi to niswan',
  marks: [
    { id: 10, role: 'button', label: 'Send document' },
    { id: 11, role: 'input:text', label: 'Search or start new chat' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://web.whatsapp.com' },
  progress: { navigated: true },
});
is(waDocStep.action, 'type', 'does not click send document; types into search');
is(waDocStep.mark_id, 11, 'target is search contact input');

// Dialpad / Calls screen recovery
const waDialpadStep = TaskPlanner.planNextAction({
  task: 'open whatsapp and send hi to Appa',
  marks: [
    { id: 20, role: 'heading', label: 'Phone number' },
    { id: 21, role: 'text', label: 'Enter a phone number to start a chat' },
    { id: 22, role: 'button', label: 'Back' },
    { id: 23, role: 'button', label: 'Send document' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://web.whatsapp.com' },
  progress: { navigated: true },
});
is(waDialpadStep.action, 'click', 'recovers from dialpad by clicking Back');
is(waDialpadStep.mark_id, 22, 'targets Back button');


console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} task-planner checks passed.`);


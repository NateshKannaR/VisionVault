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

// ── E-Commerce: Amazon complex search, filter, best product, add to cart ───────────────────
console.log('\nE-Commerce: Amazon multi-step shopping pipeline\n');
const ecomTask = 'go to amazon and search for headphones under 6000 with rating 3.5 and see the best among them and add to cart';
const ecomParsed = TaskPlanner.parseTask(ecomTask);

is(ecomParsed.site, 'amazon', 'site is amazon');
is(ecomParsed.siteUrl, 'https://www.amazon.in', 'siteUrl is amazon.in');
is(ecomParsed.query, 'headphones', 'query cleanly extracted as headphones');
is(ecomParsed.maxPrice, 6000, 'maxPrice is 6000');
is(ecomParsed.minRating, 3.5, 'minRating is 3.5');
is(ecomParsed.wantsBest, true, 'wantsBest is true');
is(ecomParsed.wantsAddToCart, true, 'wantsAddToCart is true');
is(ecomParsed.date, null, 'date is null (not confused with rating)');

// Step 1: Navigation
const shopStep1 = TaskPlanner.planNextAction({
  task: ecomTask,
  marks: [{ id: 1, role: 'link', label: 'Home' }],
  filledIds: [],
  pageInfo: { url: 'https://www.google.com' },
  progress: {},
});
is(shopStep1.action, 'navigate', 'shop step 1 navigates to Amazon');
is(shopStep1.value, 'https://www.amazon.in', 'navigates to amazon.in');

// Step 2: Search
const shopStep2 = TaskPlanner.planNextAction({
  task: ecomTask,
  marks: [
    { id: 10, role: 'input:search', label: 'Search Amazon.in' },
    { id: 11, role: 'button', label: 'Go' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.amazon.in' },
  progress: { navigated: true },
});
is(shopStep2.action, 'type', 'shop step 2 types query into search box');
is(shopStep2.value, 'headphones', 'types clean query "headphones" (not whole sentence)');
is(shopStep2.mark_id, 10, 'targets search box');

// Step 3: Selection of best product on results page
const shopStep3 = TaskPlanner.planNextAction({
  task: ecomTask,
  marks: [
    { id: 50, role: 'link', label: 'Best Sellers' },
    { id: 51, role: 'link', label: 'Sony WH-1000XM4 Noise Cancelling 4.7 stars ₹19,990' }, // over budget
    { id: 52, role: 'link', label: 'Generic Cheap Earbuds 2.8 stars ₹499' }, // below rating 3.5
    { id: 53, role: 'link', label: 'Noise Two Wireless On Ear Headphones 3.6 stars ₹1,699' }, // valid
    { id: 54, role: 'link', label: 'boAt Rockerz 450 Bluetooth On Ear Headphones 4.2 stars ₹1,499' }, // best valid
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.amazon.in/s?k=headphones' },
  progress: { navigated: true, searched: true, queryLanded: true },
});
is(shopStep3.action, 'click', 'shop step 3 selects product');
is(shopStep3.mark_id, 54, 'selects boAt Rockerz 450 (highest rating under budget)');

// Step 4: Add to cart on product page
const shopStep4 = TaskPlanner.planNextAction({
  task: ecomTask,
  marks: [
    { id: 60, role: 'heading', label: 'boAt Rockerz 450' },
    { id: 61, role: 'button', label: 'Add to Cart' },
    { id: 62, role: 'button', label: 'Buy Now' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.amazon.in/dp/B07PR1CL3S' },
  progress: { navigated: true, searched: true, queryLanded: true, productOpened: true },
});
is(shopStep4.action, 'click', 'shop step 4 clicks Add to Cart button');
is(shopStep4.mark_id, 61, 'targets Add to Cart button');

// Step 5: Finished after cart confirmation
const shopStep5 = TaskPlanner.planNextAction({
  task: ecomTask,
  marks: [
    { id: 70, role: 'heading', label: 'Added to Cart' },
    { id: 71, role: 'button', label: 'Proceed to checkout' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.amazon.in/cart' },
  progress: { navigated: true, searched: true, queryLanded: true, productOpened: true, cartAdded: true },
});
is(shopStep5.action, 'done', 'shop step 5 completes with done after cartAdded');

// ── E-Commerce: Flipkart search & filter pipeline ───────────────────
console.log('\nE-Commerce: Flipkart search & filter pipeline\n');
const fkTask = 'go to flipkart and search for headsets and apply filter from price under 6000';
const fkParsed = TaskPlanner.parseTask(fkTask);

is(fkParsed.site, 'flipkart', 'site is flipkart');
is(fkParsed.siteUrl, 'https://www.flipkart.com', 'siteUrl is flipkart.com');
is(fkParsed.query, 'headsets', 'query cleanly extracted as headsets');
is(fkParsed.maxPrice, 6000, 'maxPrice is 6000');
is(fkParsed.wantsFilter, true, 'wantsFilter is true');
is(fkParsed.wantsFill, false, 'wantsFill is false (not mistaken for form fill)');

// Step 1: Search on Flipkart
const fkStep2 = TaskPlanner.planNextAction({
  task: fkTask,
  marks: [
    { id: 10, role: 'input:text', label: 'Search for Products, Brands and More' },
    { id: 11, role: 'button', label: 'Search' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.flipkart.com' },
  progress: { navigated: true },
});
is(fkStep2.action, 'type', 'fk step 2 types clean query into search box');
is(fkStep2.value, 'headsets', 'types "headsets" (not "headsets and apply filter from price")');

// Step 2: Apply Max Price filter
const fkStep3 = TaskPlanner.planNextAction({
  task: fkTask,
  marks: [
    { id: 20, role: 'select', label: 'Min' },
    { id: 21, role: 'select', label: '₹4000+' },
    { id: 22, role: 'link', label: 'boAt Rockerz 450 ₹1,499' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.flipkart.com/search?q=headsets' },
  progress: { navigated: true, searched: true, queryLanded: true },
});
is(fkStep3.action, 'select', 'fk step 3 selects max price filter');
is(fkStep3.mark_id, 21, 'targets max price select dropdown');
is(fkStep3.value, '6000', 'selects value 6000');

// Step 3: Done after filter is applied
const fkStep4 = TaskPlanner.planNextAction({
  task: fkTask,
  marks: [
    { id: 20, role: 'select', label: 'Min' },
    { id: 21, role: 'select', label: '₹6000' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.flipkart.com/search?q=headsets' },
  progress: { navigated: true, searched: true, queryLanded: true, filterApplied: true },
});
is(fkStep4.action, 'done', 'fk step 4 completes with done after filter applied');

// ── GitHub Automation Pipeline ───────────────────────────────────────────
console.log('\nGitHub: Search, Open, Star, and Tab Navigation pipeline\n');
const ghTask = 'go to github and search for vision-agent and star it';
const ghParsed = TaskPlanner.parseTask(ghTask);

is(ghParsed.site, 'github', 'site is github');
is(ghParsed.siteUrl, 'https://github.com', 'siteUrl is github.com');
is(ghParsed.query, 'vision-agent', 'query cleanly extracted as vision-agent');
is(ghParsed.wantsStar, true, 'wantsStar is true');
is(ghParsed.wantsFork, false, 'wantsFork is false');

// Step 1: Navigate to GitHub
const ghStep1 = TaskPlanner.planNextAction({
  task: ghTask,
  marks: [],
  filledIds: [],
  pageInfo: { url: 'https://www.google.com' },
  progress: {},
});
is(ghStep1.action, 'navigate', 'gh step 1 navigates to GitHub');
is(ghStep1.value, 'https://github.com', 'navigates to https://github.com');

// Step 2: Search for repository on GitHub
const ghStep2 = TaskPlanner.planNextAction({
  task: ghTask,
  marks: [
    { id: 301, role: 'button', label: 'Search or jump to...' },
    { id: 302, role: 'input:search', label: 'Search or jump to...' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://github.com' },
  progress: { navigated: true },
});
is(ghStep2.action, 'type', 'gh step 2 types query into search box');
is(ghStep2.value, 'vision-agent', 'types "vision-agent"');
is(ghStep2.mark_id, 302, 'targets search box');

// Step 3: Select repository from search results
const ghStep3 = TaskPlanner.planNextAction({
  task: ghTask,
  marks: [
    { id: 310, role: 'link', label: 'Repositories' },
    { id: 311, role: 'link', label: 'NateshKannaR/vision-agent' },
    { id: 312, role: 'link', label: 'other/unrelated' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://github.com/search?q=vision-agent' },
  progress: { navigated: true, searched: true, queryLanded: true },
});
is(ghStep3.action, 'click', 'gh step 3 clicks repository link');
is(ghStep3.mark_id, 311, 'targets matching repo "NateshKannaR/vision-agent"');

// Step 4: Click Star on repository page
const ghStep4 = TaskPlanner.planNextAction({
  task: ghTask,
  marks: [
    { id: 320, role: 'button', label: 'Star' },
    { id: 321, role: 'button', label: 'Fork' },
    { id: 322, role: 'tab', label: 'Issues' },
    { id: 323, role: 'tab', label: 'Pull requests' },
    { id: 324, role: 'button', label: 'Code' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://github.com/NateshKannaR/vision-agent' },
  progress: { navigated: true, searched: true, queryLanded: true, repoOpened: true },
});
is(ghStep4.action, 'click', 'gh step 4 clicks Star button');
is(ghStep4.mark_id, 320, 'targets Star button');

// Step 5: Finished after starring
const ghStep5 = TaskPlanner.planNextAction({
  task: ghTask,
  marks: [
    { id: 320, role: 'button', label: 'Starred' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://github.com/NateshKannaR/vision-agent' },
  progress: { navigated: true, searched: true, queryLanded: true, repoOpened: true, starred: true },
});
is(ghStep5.action, 'done', 'gh step 5 completes with done after starred');

// GitHub: Issues & PR tabs
const prTask = 'open langchain on github and view pull requests';
const prParsed = TaskPlanner.parseTask(prTask);
is(prParsed.site, 'github', 'pr task site is github');
is(prParsed.query, 'langchain', 'query is langchain');
is(prParsed.wantsPR, true, 'wantsPR is true');

const prStep = TaskPlanner.planNextAction({
  task: prTask,
  marks: [
    { id: 330, role: 'button', label: 'Star' },
    { id: 331, role: 'link', label: 'Issues' },
    { id: 332, role: 'link', label: 'Pull requests' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://github.com/hwchase17/langchain' },
  progress: { navigated: true, searched: true, queryLanded: true, repoOpened: true },
});
is(prStep.action, 'click', 'clicks Pull requests tab');
is(prStep.mark_id, 332, 'targets Pull requests link');

// ── MakeMyTrip: Non-Stop Flight Filter ────────────────────────────────────
console.log('\nMakeMyTrip: Non-Stop flight filtering\n');
const travelTask = 'go to makemytrip and search flights from delhi to mumbai non stop';
const travelParsed = TaskPlanner.parseTask(travelTask);
is(travelParsed.from, 'delhi', 'from city is delhi');
is(travelParsed.to, 'mumbai', 'to city is mumbai');
is(travelParsed.wantsNonStop, true, 'wantsNonStop is true');

const travelStep6 = TaskPlanner.planBookingStep(travelParsed, [
  { id: 401, role: 'checkbox', label: 'Non Stop' },
  { id: 402, role: 'checkbox', label: '1 Stop' },
], new Set(), { bookingStep: 6, fromTyped: true, toTyped: true });

is(travelStep6.action, 'click', 'clicks Non Stop filter checkbox');
is(travelStep6.mark_id, 401, 'targets Non Stop filter checkbox mark');

// ── E-Commerce: Sorting ───────────────────────────────────────────────────
console.log('\nE-Commerce: Sorting pipeline\n');
const sortTask = 'go to amazon and search for gaming mouse and sort by price low to high';
const sortParsed = TaskPlanner.parseTask(sortTask);
is(sortParsed.query, 'gaming mouse', 'query cleanly extracted as gaming mouse');
is(sortParsed.wantsSort, true, 'wantsSort is true');
is(sortParsed.sort, 'price_asc', 'sort is price_asc');

const sortStep = TaskPlanner.planNextAction({
  task: sortTask,
  marks: [
    { id: 501, role: 'select', label: 'Sort by:' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://www.amazon.in/s?k=gaming+mouse' },
  progress: { navigated: true, searched: true, queryLanded: true },
});
is(sortStep.action, 'select', 'selects sort option');
is(sortStep.mark_id, 501, 'targets sort select');
is(sortStep.value, 'price-asc-rank', 'selects price-asc-rank');

// ── GitHub: Create Repository ─────────────────────────────────────────────
console.log('\nGitHub: Create Repository pipeline\n');
const newRepoTask = 'open github and create a new repository named vision-demo';
const newRepoParsed = TaskPlanner.parseTask(newRepoTask);

is(newRepoParsed.site, 'github', 'site is github');
is(newRepoParsed.siteUrl, 'https://github.com/new', 'siteUrl is https://github.com/new');
is(newRepoParsed.wantsNewRepo, true, 'wantsNewRepo is true');
is(newRepoParsed.repoName, 'vision-demo', 'repoName is extracted as vision-demo');
is(newRepoParsed.query, null, 'query is null');

// Prompt without explicit name:
const unnamedTask = 'open github and create a new repository';
const unnamedParsed = TaskPlanner.parseTask(unnamedTask);
is(unnamedParsed.wantsNewRepo, true, 'unnamed task wantsNewRepo is true');
is(unnamedParsed.site, 'github', 'unnamed task site is github');
is(unnamedParsed.query, null, 'unnamed task query is null');

// Prompt with compound name with space:
const spacedTask = 'open github and create a new repository named my cool-project';
const spacedParsed = TaskPlanner.parseTask(spacedTask);
is(spacedParsed.repoName, 'my-cool-project', 'repoName with space normalized to my-cool-project');

// Step 1: Navigate from external site
const crStep1 = TaskPlanner.planNextAction({
  task: newRepoTask,
  marks: [],
  filledIds: [],
  pageInfo: { url: 'https://www.google.com' },
  progress: {},
});
is(crStep1.action, 'navigate', 'cr step 1 navigates to GitHub new repo page');
is(crStep1.value, 'https://github.com/new', 'navigates to https://github.com/new');

// Step 2: On github.com/new, types repository name
const crStep2 = TaskPlanner.planNextAction({
  task: newRepoTask,
  marks: [
    { id: 601, role: 'input:text', label: 'Repository name *' },
    { id: 602, role: 'input:text', label: 'Description' },
    { id: 603, role: 'button', label: 'Create repository' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://github.com/new' },
  progress: { navigated: true },
});
is(crStep2.action, 'type', 'cr step 2 types repository name');
is(crStep2.value, 'vision-demo', 'types "vision-demo"');
is(crStep2.mark_id, 601, 'targets repository name input');

// Step 3: Click Create repository button
const crStep3 = TaskPlanner.planNextAction({
  task: newRepoTask,
  marks: [
    { id: 601, role: 'input:text', label: 'Repository name *' },
    { id: 602, role: 'input:text', label: 'Description' },
    { id: 603, role: 'button', label: 'Create repository' },
  ],
  filledIds: [601],
  pageInfo: { url: 'https://github.com/new' },
  progress: { navigated: true, repoNameTyped: true },
});
is(crStep3.action, 'click', 'cr step 3 clicks Create repository button');
is(crStep3.mark_id, 603, 'targets Create repository button');

// Step 4: After navigation to repo page, completes with done
const crStep4 = TaskPlanner.planNextAction({
  task: newRepoTask,
  marks: [
    { id: 701, role: 'button', label: 'Code' },
  ],
  filledIds: [601, 603],
  pageInfo: { url: 'https://github.com/NateshKannaR/vision-demo' },
  progress: { navigated: true, repoNameTyped: true, createClicked: true },
});
is(crStep4.action, 'done', 'cr step 4 completes with done');

console.log('\nForm 2 Navigation & Fill pipeline');
console.log('---------------------------------');
const form2Task = parseTask('fill form 2');
is(form2Task.wantsFill, true, 'fill form 2 has wantsFill true');
is(form2Task.openTargets.includes('form 2'), true, 'fill form 2 has form 2 in openTargets');

const form2VoiceTask = parseTask('click that form 2 and fill that form');
is(form2VoiceTask.wantsFill, true, 'click that form 2 and fill that form has wantsFill true');
is(form2VoiceTask.openTargets.some(t => t.includes('form 2')), true, 'openTargets includes form 2');

// Step 1: When on Messages tab, Form 2 nav tab is visible
const f2Step1 = planNextAction({
  task: 'fill form 2',
  parsedTask: form2Task,
  marks: [
    { id: 10, role: 'clickable', label: 'Secure Messages' },
    { id: 11, role: 'clickable', label: 'Form 1 — HR Personal' },
    { id: 12, role: 'clickable', label: 'Form 2 — ISRO Mission Payroll' },
    { id: 13, role: 'clickable', label: 'Form 3 — ISRO Mission Systems' },
  ],
  filledIds: [],
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  progress: { opened: [] }
});
is(f2Step1.action, 'click', 'form 2 step 1 clicks form 2 nav tab');
is(f2Step1.mark_id, 12, 'form 2 step 1 targets Form 2 mark (id 12, not id 11)');

// Step 2: On Form 2, fills inputs from vault
const f2Step2 = planNextAction({
  task: 'fill form 2',
  parsedTask: form2Task,
  marks: [
    { id: 12, role: 'clickable', label: 'Form 2 — ISRO Mission Payroll' },
    { id: 21, role: 'input:text', label: 'Full Name', vaultKey: 'name' },
    { id: 22, role: 'input:tel', label: 'Phone', vaultKey: 'phone' },
    { id: 23, role: 'textarea', label: 'Address for Payslips', vaultKey: 'address' },
    { id: 24, role: 'input:text', label: 'PIN Code', vaultKey: 'zip' },
  ],
  filledIds: [],
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  progress: { opened: ['form 2'] }
});
is(f2Step2.action, 'type', 'form 2 step 2 types field');
is(f2Step2.use_vault_field, 'name', 'form 2 step 2 uses vault key name');

// Step 3: When all inputs filled, clicks submit
const f2Step3 = planNextAction({
  task: 'fill form 2',
  parsedTask: form2Task,
  marks: [
    { id: 21, role: 'input:text', label: 'Full Name', vaultKey: 'name' },
    { id: 22, role: 'input:tel', label: 'Phone', vaultKey: 'phone' },
    { id: 30, role: 'button', label: 'Save Mission Payroll' },
  ],
  filledIds: [21, 22],
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  progress: { opened: ['form 2'] }
});
is(f2Step3.action, 'click', 'form 2 step 3 clicks submit button');
is(f2Step3.mark_id, 30, 'form 2 step 3 targets Save Mission Payroll button');

// Label resolution checks for Form 2
is(TaskPlanner.vaultKeyForLabel('Satellite Name').key, 'satellite_name', 'satellite name -> satellite_name (not phone or name)');
is(TaskPlanner.vaultKeyForLabel('Mission ID').key, 'mission_id', 'mission id -> mission_id');
is(TaskPlanner.vaultKeyForLabel('Orbit Type').key, 'orbit_type', 'orbit type -> orbit_type');
is(TaskPlanner.vaultKeyForLabel('PIN Code').key, 'zip', 'pin code -> zip');
is(TaskPlanner.vaultKeyForLabel('Address for Payslips').key, 'address', 'address for payslips -> address');
is(TaskPlanner.vaultKeyForLabel('Organisation').key, 'company', 'organisation -> company');
is(TaskPlanner.vaultKeyForLabel('Occupation *').key, 'occupation', 'occupation * -> occupation');
is(TaskPlanner.vaultKeyForLabel('Annual Income *').key, 'annual_income', 'annual income * -> annual_income');
is(TaskPlanner.vaultKeyForLabel('Marital Status').key, 'marital_status', 'marital status -> marital_status');
is(TaskPlanner.vaultKeyForLabel('Father Name').key, 'father_name', 'father name -> father_name');
is(TaskPlanner.vaultKeyForLabel('City').key, 'city', 'city -> city');
is(TaskPlanner.vaultKeyForLabel('Country').key, 'country', 'country -> country');
is(TaskPlanner.vaultKeyForLabel('State').key, 'state', 'state -> state');
is(TaskPlanner.vaultKeyForLabel('Street Address').key, 'address', 'street address -> address');
is(TaskPlanner.vaultKeyForLabel('Date of Birth').key, 'dob', 'date of birth -> dob');
is(TaskPlanner.vaultKeyForLabel('First Name').key, 'first_name', 'first name -> first_name');
is(TaskPlanner.vaultKeyForLabel('Last Name').key, 'last_name', 'last name -> last_name');

// Multi-field Google form planning check: distinct fields must NOT all collapse to "name"
const googleFormPlan1 = planNextAction({
  task: 'fill this form',
  parsedTask: TaskPlanner.parseTask('fill this form'),
  marks: [
    { id: 101, role: 'input:text', label: 'Occupation *' },
    { id: 102, role: 'input:text', label: 'Annual Income *' },
  ],
  filledIds: [],
  pageInfo: { url: 'https://docs.google.com/forms/d/e/.../viewform' },
  progress: {}
});
is(googleFormPlan1.action, 'type', 'google form step 1 types');
is(googleFormPlan1.mark_id, 101, 'google form step 1 targets occupation field');
is(googleFormPlan1.use_vault_field, 'occupation', 'google form step 1 uses vault field occupation (not name)');

const googleFormPlan2 = planNextAction({
  task: 'fill this form',
  parsedTask: TaskPlanner.parseTask('fill this form'),
  marks: [
    { id: 101, role: 'input:text', label: 'Occupation *' },
    { id: 102, role: 'input:text', label: 'Annual Income *' },
  ],
  filledIds: [101],
  pageInfo: { url: 'https://docs.google.com/forms/d/e/.../viewform' },
  progress: {}
});
is(googleFormPlan2.action, 'type', 'google form step 2 types');
is(googleFormPlan2.mark_id, 102, 'google form step 2 targets annual income field');
is(googleFormPlan2.use_vault_field, 'annual_income', 'google form step 2 uses vault field annual_income (not name)');

// Prompt variation checks
const p1 = TaskPlanner.parseTask('fill the form fill form 2');
is(p1.wantsFill, true, 'fill the form fill form 2 sets wantsFill');
is(p1.openTargets.includes('form 2'), true, 'fill the form fill form 2 includes form 2');
const p2 = TaskPlanner.parseTask('fill the form 2');
is(p2.openTargets.includes('form 2'), true, 'fill the form 2 includes form 2');

console.log('\nISRO Prototype: 3 Automation Scenarios');
console.log('--------------------------------------');

// Scenario 1: Chandrayaan Missions Search & Retrieval
const isroSearchTask = 'find latest updates on chandrayaan missions on isro';
const isroSearchParsed = TaskPlanner.parseTask(isroSearchTask);
is(isroSearchParsed.site, 'isro', 'isro search site is isro');
is(isroSearchParsed.siteUrl, 'https://www.isro.gov.in', 'isro search siteUrl is isro.gov.in');
is(isroSearchParsed.query, 'chandrayaan missions', 'query cleanly extracted as chandrayaan missions');
is(isroSearchParsed.wantsSearch, true, 'wantsSearch is true');

const isroSearchStep1 = planNextAction({
  task: isroSearchTask,
  parsed: isroSearchParsed,
  pageInfo: { url: 'https://www.google.com' },
  marks: [],
  progress: {}
});
is(isroSearchStep1.action, 'navigate', 'isro search step 1 navigates to isro.gov.in');
is(isroSearchStep1.value, 'https://www.isro.gov.in', 'navigates to https://www.isro.gov.in');

const isroSearchStep2 = planNextAction({
  task: isroSearchTask,
  parsed: isroSearchParsed,
  pageInfo: { url: 'https://www.isro.gov.in/' },
  marks: [
    { id: 10, role: 'input:text', label: 'search' },
    { id: 25, role: 'link', label: 'Chandrayaan-3 Hop Experiment Reveals Lunar Secrets' }
  ],
  progress: { navigated: true }
});
is(isroSearchStep2.action, 'click', 'isro search step 2 clicks visible Chandrayaan mission link');
is(isroSearchStep2.mark_id, 25, 'targets Chandrayaan link mark');

const isroSearchStep3 = planNextAction({
  task: isroSearchTask,
  parsed: isroSearchParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Chandrayaan_3Hop_Experiment_Reveals.html' },
  marks: [],
  progress: { navigated: true, chandrayaanOpened: true }
});
is(isroSearchStep3.action, 'done', 'isro search completes on mission detail page');

// Scenario 2: Contact/Grievance Form Autofill with Vault
const isroFormTask = 'fill contact form on isro with my details';
const isroFormParsed = TaskPlanner.parseTask(isroFormTask);
is(isroFormParsed.site, 'isro', 'isro form site is isro');
is(isroFormParsed.siteUrl, 'https://www.isro.gov.in/ISROAPP/fFBF', 'isro form siteUrl is feedback form');
is(isroFormParsed.wantsFill, true, 'isro form wantsFill is true');

const isroFormStep1 = planNextAction({
  task: isroFormTask,
  parsed: isroFormParsed,
  pageInfo: { url: 'https://www.isro.gov.in/ISROAPP/fFBF' },
  marks: [
    { id: 1, role: 'input:text', label: 'Enter Your Name Here' },
    { id: 2, role: 'input:text', label: 'Enter Your Email Address Here' },
    { id: 3, role: 'input:text', label: 'Feedback Message' }
  ],
  filledIds: [],
  progress: { navigated: true }
});
is(isroFormStep1.action, 'type', 'isro form step 1 types into name');
is(isroFormStep1.mark_id, 1, 'targets name field mark');
is(isroFormStep1.use_vault_field, 'name', 'uses vault field name');

const isroFormStep2 = planNextAction({
  task: isroFormTask,
  parsed: isroFormParsed,
  pageInfo: { url: 'https://www.isro.gov.in/ISROAPP/fFBF' },
  marks: [
    { id: 1, role: 'input:text', label: 'Enter Your Name Here' },
    { id: 2, role: 'input:text', label: 'Enter Your Email Address Here' },
    { id: 3, role: 'input:text', label: 'Feedback Message' }
  ],
  filledIds: [1],
  progress: { navigated: true }
});
is(isroFormStep2.action, 'type', 'isro form step 2 types into email');
is(isroFormStep2.mark_id, 2, 'targets email field mark');
is(isroFormStep2.use_vault_field, 'email', 'uses vault field email');

const isroFormStepPhone = planNextAction({
  task: isroFormTask,
  parsed: isroFormParsed,
  pageInfo: { url: 'https://www.isro.gov.in/ISROAPP/fFBF' },
  marks: [
    { id: 1, role: 'input:text', label: 'Enter Your Name Here' },
    { id: 2, role: 'input:text', label: 'Enter Your Email Address Here' },
    { id: 4, role: 'input:tel', label: 'Enter Your Mobile Number Here' },
    { id: 3, role: 'input:text', label: 'Feedback Message' }
  ],
  filledIds: [1, 2],
  progress: { navigated: true }
});
is(isroFormStepPhone.action, 'type', 'isro form step types into mobile number');
is(isroFormStepPhone.mark_id, 4, 'targets mobile field mark');
is(isroFormStepPhone.use_vault_field, 'phone', 'uses vault field phone');

// Scenario 3: Image Redaction Demo (Leadership gallery face detection)
const isroFaceTask = 'open isro leadership page and redact faces';
const isroFaceParsed = TaskPlanner.parseTask(isroFaceTask);
is(isroFaceParsed.site, 'isro', 'isro face task site is isro');
is(isroFaceParsed.siteUrl, 'https://www.isro.gov.in/leadership.html', 'isro face task siteUrl is leadership.html');
is(isroFaceParsed.wantsRedact, true, 'isro face task wantsRedact is true');

const isroFaceStep1 = planNextAction({
  task: isroFaceTask,
  parsed: isroFaceParsed,
  pageInfo: { url: 'https://www.isro.gov.in' },
  marks: [],
  progress: {}
});
is(isroFaceStep1.action, 'navigate', 'isro face step 1 navigates to leadership.html');
is(isroFaceStep1.value, 'https://www.isro.gov.in/leadership.html', 'navigates to leadership.html');

const isroFaceStep2 = planNextAction({
  task: isroFaceTask,
  parsed: isroFaceParsed,
  pageInfo: { url: 'https://www.isro.gov.in/leadership.html' },
  marks: [],
  progress: { navigated: true }
});
is(isroFaceStep2.action, 'done', 'isro face step 2 completes with on-device face redaction active');

// SIH Advanced ISRO Automations
// 1. Gaganyaan Mission Tracker
const gaganyaanTask = 'find latest test milestones for gaganyaan crew module on isro';
const gaganyaanParsed = TaskPlanner.parseTask(gaganyaanTask);
is(gaganyaanParsed.site, 'isro', 'gaganyaan task site is isro');
is(gaganyaanParsed.mission, 'gaganyaan', 'gaganyaan mission identified');
is(gaganyaanParsed.siteUrl, 'https://www.isro.gov.in', 'gaganyaan siteUrl is isro.gov.in');

const gaganyaanStep1 = planNextAction({
  task: gaganyaanTask,
  parsed: gaganyaanParsed,
  pageInfo: { url: 'https://www.isro.gov.in/' },
  marks: [
    { id: 10, role: 'link', label: 'Gaganyaan Crew Module IMAT Parachute Drop Test' }
  ],
  progress: {}
});
is(gaganyaanStep1.action, 'click', 'gaganyaan step 1 clicks Gaganyaan milestone link');
is(gaganyaanStep1.mark_id, 10, 'targets Gaganyaan milestone mark');

const gaganyaanStep2 = planNextAction({
  task: gaganyaanTask,
  parsed: gaganyaanParsed,
  pageInfo: { url: 'https://www.isro.gov.in/gaganyaan.html' },
  marks: [],
  progress: { missionOpened: true }
});
is(gaganyaanStep2.action, 'done', 'gaganyaan completes on mission page');

// 2. Aditya-L1 Solar Mission Tracker
const adityaTask = 'check aditya l1 solar mission updates on isro';
const adityaParsed = TaskPlanner.parseTask(adityaTask);
is(adityaParsed.site, 'isro', 'aditya task site is isro');
is(adityaParsed.mission, 'aditya-l1', 'aditya mission identified');

const adityaStep1 = planNextAction({
  task: adityaTask,
  parsed: adityaParsed,
  pageInfo: { url: 'https://www.isro.gov.in/' },
  marks: [
    { id: 15, role: 'link', label: 'Aditya-L1 Solar Flare & Coronal Observation status' }
  ],
  progress: {}
});
is(adityaStep1.action, 'click', 'aditya step 1 clicks Aditya-L1 link');
is(adityaStep1.mark_id, 15, 'targets Aditya-L1 mark');

// 3. Space Hardware Tender & Procurement Monitor
const tendersTask = 'check latest active tenders for electronics on isro';
const tendersParsed = TaskPlanner.parseTask(tendersTask);
is(tendersParsed.site, 'isro', 'tenders task site is isro');
is(tendersParsed.wantsTenders, true, 'wantsTenders is true');
is(tendersParsed.siteUrl, 'https://www.isro.gov.in/Tenders.html', 'tenders siteUrl is Tenders.html');

const tendersStep1 = planNextAction({
  task: tendersTask,
  parsed: tendersParsed,
  pageInfo: { url: 'https://www.isro.gov.in' },
  marks: [],
  progress: {}
});
is(tendersStep1.action, 'navigate', 'tenders step 1 navigates to Tenders.html');
is(tendersStep1.value, 'https://www.isro.gov.in/Tenders.html', 'navigates to Tenders.html');

const tendersStep2 = planNextAction({
  task: tendersTask,
  parsed: tendersParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Tenders.html' },
  marks: [
    { id: 31, role: 'link', label: 'RFP for Spacecraft Cryogenic Stage Actuator Electronics' }
  ],
  progress: { navigated: true }
});
is(tendersStep2.action, 'click', 'tenders step 2 clicks RFP mark');
is(tendersStep2.mark_id, 31, 'targets RFP mark');

const tendersStep3 = planNextAction({
  task: tendersTask,
  parsed: tendersParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Tenders.html' },
  marks: [],
  progress: { navigated: true, tenderOpened: true }
});
is(tendersStep3.action, 'done', 'tenders completes with active RFPs extracted');

// 4. ICRB Scientist / Engineer Recruitment Assistant
const careersTask = 'check latest scientist recruitment notifications on isro careers';
const careersParsed = TaskPlanner.parseTask(careersTask);
is(careersParsed.site, 'isro', 'careers task site is isro');
is(careersParsed.wantsCareers, true, 'wantsCareers is true');
is(careersParsed.siteUrl, 'https://www.isro.gov.in/Careers.html', 'careers siteUrl is Careers.html');

const careersStep1 = planNextAction({
  task: careersTask,
  parsed: careersParsed,
  pageInfo: { url: 'https://www.isro.gov.in' },
  marks: [],
  progress: {}
});
is(careersStep1.action, 'navigate', 'careers step 1 navigates to Careers.html');
is(careersStep1.value, 'https://www.isro.gov.in/Careers.html', 'navigates to Careers.html');

const careersStep2 = planNextAction({
  task: careersTask,
  parsed: careersParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Careers.html' },
  marks: [
    { id: 42, role: 'link', label: 'Advt No. ICRB:02:2024 Recruitment for Scientist/Engineer SC' }
  ],
  progress: { navigated: true }
});
is(careersStep2.action, 'click', 'careers step 2 clicks ICRB announcement link');
is(careersStep2.mark_id, 42, 'targets ICRB mark');

// 4b. ICRB Application Form Autofill with local Vault
const careersFillTask = 'fill isro scientist recruitment application with my details';
const careersFillParsed = TaskPlanner.parseTask(careersFillTask);
is(careersFillParsed.wantsCareers, true, 'careers fill wantsCareers is true');
is(careersFillParsed.wantsFill, true, 'careers fill wantsFill is true');

const careersFillStep1 = planNextAction({
  task: careersFillTask,
  parsed: careersFillParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Careers.html' },
  marks: [
    { id: 50, role: 'input:text', label: 'Candidate Full Name', vaultKey: 'name' },
    { id: 51, role: 'input:email', label: 'Email ID', vaultKey: 'email' },
    { id: 52, role: 'input:tel', label: 'Mobile Number', vaultKey: 'phone' }
  ],
  progress: { navigated: true }
});
is(careersFillStep1.action, 'type', 'careers fill types candidate name');
is(careersFillStep1.mark_id, 50, 'targets candidate name mark');
is(careersFillStep1.use_vault_field, 'name', 'uses vault field name');

// 5. On-Device Privacy & Data Leakage Security Auditor
const auditTask = 'audit isro press page for exposed contact numbers and unredacted faces';
const auditParsed = TaskPlanner.parseTask(auditTask);
is(auditParsed.site, 'isro', 'audit task site is isro');
is(auditParsed.wantsAudit, true, 'audit task wantsAudit is true');
is(auditParsed.siteUrl, 'https://www.isro.gov.in/Press.html', 'audit task siteUrl is Press.html');

const auditStep1 = planNextAction({
  task: auditTask,
  parsed: auditParsed,
  pageInfo: { url: 'https://www.isro.gov.in' },
  marks: [],
  progress: {}
});
is(auditStep1.action, 'navigate', 'audit step 1 navigates to Press.html');
is(auditStep1.value, 'https://www.isro.gov.in/Press.html', 'navigates to Press.html');

const auditStep2 = planNextAction({
  task: auditTask,
  parsed: auditParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Press.html' },
  marks: [],
  progress: { navigated: true }
});
is(auditStep2.action, 'done', 'audit step 2 completes compliance check');

// 6. SIH Flagship Demo: Security Clearance Zero-PII Fill
const demoTask = 'open security clearance and autofill with vault credentials';
const demoParsed = TaskPlanner.parseTask(demoTask);
is(demoParsed.wantsFill, true, 'flagship demo wantsFill is true');
is(demoParsed.openTargets.includes('security clearance'), true, 'openTargets includes security clearance');

const demoStep1 = planNextAction({
  task: demoTask,
  parsed: demoParsed,
  pageInfo: { url: 'http://127.0.0.1:8080/mock-apps/isro-portal.html' },
  marks: [
    { id: 1, role: 'clickable', label: 'Dashboard' },
    { id: 2, role: 'clickable', label: 'Security Clearance' }
  ],
  progress: {}
});
is(demoStep1.action, 'click', 'flagship demo step 1 clicks Security Clearance nav tab');
is(demoStep1.mark_id, 2, 'targets Security Clearance mark');

const demoStep2 = planNextAction({
  task: demoTask,
  parsed: demoParsed,
  pageInfo: { url: 'http://127.0.0.1:8080/mock-apps/isro-portal.html' },
  marks: [
    { id: 10, role: 'input:text', label: 'Satellite Name', vaultKey: 'satellite_name' },
    { id: 11, role: 'input:text', label: 'Encryption Key Reference', vaultKey: 'encryption_key_ref' }
  ],
  progress: { opened: ['security clearance'] }
});
is(demoStep2.action, 'type', 'flagship demo step 2 types satellite name');
is(demoStep2.mark_id, 10, 'targets satellite name input');
is(demoStep2.use_vault_field, 'satellite_name', 'uses vault field satellite_name');

// 7. Cross-Site Autonomous Intelligence Sync: isro.gov.in -> Local ISRO Mission Panel
const syncTask = 'fetch Gaganyaan mission details from isro.gov.in and register in ISRO Panel';
const syncParsed = TaskPlanner.parseTask(syncTask);
is(syncParsed.site, 'isro', 'sync task site is isro');
is(syncParsed.mission, 'gaganyaan', 'sync task mission is gaganyaan');
is(syncParsed.wantsMissionSync, true, 'sync task wantsMissionSync is true');

// Step 1: Navigate to official ISRO website
const syncStep1 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'https://google.com' },
  marks: [],
  progress: {}
});
is(syncStep1.action, 'navigate', 'sync step 1 navigates to isro.gov.in');
is(syncStep1.value, 'https://www.isro.gov.in', 'navigates to https://www.isro.gov.in');

// Step 2: On isro.gov.in, inspect Gaganyaan milestone link
const syncStep2 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'https://www.isro.gov.in' },
  marks: [
    { id: 101, role: 'link', label: 'Gaganyaan Flight Test Vehicle Abort Mission-1 (TV-D1)' }
  ],
  progress: {}
});
is(syncStep2.action, 'click', 'sync step 2 clicks Gaganyaan telemetry link on isro.gov.in');
is(syncStep2.mark_id, 101, 'targets Gaganyaan mark on isro.gov.in');

// Step 3: Telemetry captured, transition to local ISRO Panel
const syncStep3 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Gaganyaan.html' },
  marks: [],
  progress: { missionInspected: true }
});
is(syncStep3.action, 'navigate', 'sync step 3 transitions to local ISRO HR Mission Panel');
is(syncStep3.value, 'http://localhost:3000/hr-portal.html', 'navigates to http://localhost:3000/hr-portal.html');

// Step 4: On local ISRO panel, open Add New Mission tab
const syncStep4 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'http://localhost:3000/hr-portal.html' },
  marks: [
    { id: 201, role: 'tab', label: 'Active Missions' },
    { id: 202, role: 'tab', label: 'Add New Mission' }
  ],
  progress: { isroDataFetched: true }
});
is(syncStep4.action, 'click', 'sync step 4 clicks Add New Mission tab in registry');
is(syncStep4.mark_id, 202, 'targets Add New Mission tab mark');

// Step 5: Autofill live telemetry: Satellite Name
const syncStep5 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'http://localhost:3000/hr-portal.html' },
  marks: [
    { id: 301, role: 'input:text', label: 'Satellite Name', vaultKey: 'satellite_name' },
    { id: 302, role: 'input:text', label: 'Mission ID', vaultKey: 'mission_id' },
    { id: 303, role: 'input:text', label: 'Orbit Type', vaultKey: 'orbit_type' },
    { id: 304, role: 'input:text', label: 'Launch Vehicle' },
    { id: 305, role: 'input:text', label: 'Operator on Duty (Full Name)', vaultKey: 'operator' },
    { id: 306, role: 'input:tel', label: 'Phone', vaultKey: 'phone' },
    { id: 307, role: 'input:text', label: 'Encryption Key Reference', vaultKey: 'encryption_key_ref' },
    { id: 308, role: 'button', label: 'Add Mission to Registry' }
  ],
  progress: { isroDataFetched: true, addMissionTabOpened: true }
});
is(syncStep5.action, 'type', 'sync step 5 fills Satellite Name');
is(syncStep5.mark_id, 301, 'targets Satellite Name input');
is(syncStep5.value, 'Gaganyaan TV-D1 Crew Module', 'fills extracted Gaganyaan satellite name');

// Step 6: Autofill Zero-PII Vault credentials for Operator on duty
const syncStep6 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'http://localhost:3000/hr-portal.html' },
  marks: [
    { id: 305, role: 'input:text', label: 'Operator on Duty (Full Name)', vaultKey: 'operator' },
    { id: 306, role: 'input:tel', label: 'Phone', vaultKey: 'phone' },
    { id: 307, role: 'input:text', label: 'Encryption Key Reference', vaultKey: 'encryption_key_ref' },
    { id: 308, role: 'button', label: 'Add Mission to Registry' }
  ],
  progress: { isroDataFetched: true, addMissionTabOpened: true }
});
is(syncStep6.action, 'type', 'sync step 6 fills Operator from Vault');
is(syncStep6.mark_id, 305, 'targets operator input mark');
is(syncStep6.use_vault_field, 'operator', 'uses vault field operator');

// Step 7: Submit synchronized mission form
const syncStep7 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'http://localhost:3000/hr-portal.html' },
  marks: [
    { id: 308, role: 'button', label: 'Add Mission to Registry' }
  ],
  progress: { isroDataFetched: true, addMissionTabOpened: true }
});
is(syncStep7.action, 'click', 'sync step 7 clicks Add Mission to Registry button');
is(syncStep7.mark_id, 308, 'targets Add Mission button mark');

// Step 8: Completes with verified Zero-PII registry sync
const syncStep8 = planNextAction({
  task: syncTask,
  parsed: syncParsed,
  pageInfo: { url: 'http://localhost:3000/hr-portal.html' },
  marks: [],
  progress: { isroDataFetched: true, addMissionTabOpened: true, missionSubmitted: true }
});
is(syncStep8.action, 'done', 'sync step 8 completes with cross-site synchronization complete');

// 8. NISAR Dashboard Variant: "Get the next ISRO launch details and log it in our mission dashboard."
const nisarTask = 'Get the next ISRO launch details and log it in our mission dashboard.';
const nisarParsed = TaskPlanner.parseTask(nisarTask);
is(nisarParsed.wantsMissionSync, true, 'nisar task wantsMissionSync is true');
is(nisarParsed.mission, 'nisar', 'nisar task mission defaults to nisar');

// Step 1: Navigate to ISRO website
const nisarStep1 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'https://google.com' },
  marks: [],
  progress: {}
});
is(nisarStep1.action, 'navigate', 'nisar step 1 navigates to isro.gov.in');
is(nisarStep1.value, 'https://www.isro.gov.in', 'nisar step 1 navigates to https://www.isro.gov.in');

// Step 2: Click NISAR mission link
const nisarStep2 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'https://www.isro.gov.in' },
  marks: [
    { id: 101, role: 'link', label: 'Mission_GSLVF16_NISAR.html — NISAR upcoming launch' }
  ],
  progress: {}
});
is(nisarStep2.action, 'click', 'nisar step 2 clicks NISAR mission link');
is(nisarStep2.mark_id, 101, 'targets NISAR mark on isro.gov.in');

// Step 3: Transition to employee portal mission dashboard after data captured
const nisarStep3 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Mission_GSLVF16_NISAR.html' },
  marks: [],
  progress: { missionInspected: true }
});
is(nisarStep3.action, 'navigate', 'nisar step 3 navigates to local mission dashboard');

// Step 5: Fill Satellite Name with NISAR data
const nisarStep5 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 301, role: 'input:text', label: 'Satellite Name', vaultKey: 'satellite_name' },
    { id: 302, role: 'input:text', label: 'Mission ID', vaultKey: 'mission_id' },
    { id: 303, role: 'input:date', label: 'Launch Date', vaultKey: 'launch_date' },
    { id: 304, role: 'input:text', label: 'Orbit Type', vaultKey: 'orbit_type' },
    { id: 305, role: 'input:text', label: 'Launch Vehicle', vaultKey: 'vehicle' },
    { id: 306, role: 'button', label: 'Add Mission to Registry' }
  ],
  progress: { isroDataFetched: true, addMissionTabOpened: true }
});
is(nisarStep5.action, 'type', 'nisar step 5 fills Satellite Name');
is(nisarStep5.mark_id, 301, 'targets Satellite Name input');
is(nisarStep5.value, 'NISAR (NASA-ISRO SAR)', 'fills NISAR satellite name');

// Step 6: Fill Launch Date
const nisarStep6 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 303, role: 'input:date', label: 'Launch Date', vaultKey: 'launch_date' },
    { id: 304, role: 'input:text', label: 'Orbit Type', vaultKey: 'orbit_type' },
    { id: 305, role: 'input:text', label: 'Launch Vehicle', vaultKey: 'vehicle' },
    { id: 306, role: 'button', label: 'Add Mission to Registry' }
  ],
  progress: { isroDataFetched: true, addMissionTabOpened: true }
});
is(nisarStep6.action, 'type', 'nisar step 6 fills Launch Date');
is(nisarStep6.mark_id, 303, 'targets Launch Date input');
is(nisarStep6.value, '2025-07-30', 'fills NISAR launch date 2025-07-30');

// Step 7: Fill Launch Vehicle with GSLV-F16
const nisarStep7 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 305, role: 'input:text', label: 'Launch Vehicle', vaultKey: 'vehicle' },
    { id: 306, role: 'button', label: 'Add Mission to Registry' }
  ],
  progress: { isroDataFetched: true, addMissionTabOpened: true }
});
is(nisarStep7.action, 'type', 'nisar step 7 fills Launch Vehicle');
is(nisarStep7.mark_id, 305, 'targets Launch Vehicle input');
is(nisarStep7.value, 'GSLV-F16', 'fills GSLV-F16 as launch vehicle');

// Step 8: Submit mission to dashboard
const nisarStep8 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 306, role: 'button', label: 'Add Mission to Registry' }
  ],
  progress: { isroDataFetched: true, addMissionTabOpened: true }
});
is(nisarStep8.action, 'click', 'nisar step 8 clicks Add Mission to Registry');
is(nisarStep8.mark_id, 306, 'targets Add Mission button');

// Step 9: Done after submission
const nisarStep9 = planNextAction({
  task: nisarTask,
  parsed: nisarParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [],
  progress: { isroDataFetched: true, addMissionTabOpened: true, missionSubmitted: true }
});
is(nisarStep9.action, 'done', 'nisar step 9 completes mission dashboard sync');

// 9. Gaganyaan DB6 Cross-Site Sync: "Fetch Gaganyaan mission details from isro.gov.in and fill Database 6."
const gyTask = 'Fetch Gaganyaan mission details from isro.gov.in and fill Database 6.';
const gyParsed = TaskPlanner.parseTask(gyTask);
is(gyParsed.wantsGaganyaanSync, true, 'gy task wantsGaganyaanSync is true');
is(gyParsed.wantsMissionSync, true, 'gy task wantsMissionSync is true');
is(gyParsed.mission, 'gaganyaan', 'gy task mission is gaganyaan');
is(gyParsed.siteUrl, 'https://www.isro.gov.in/Gaganyaan.html', 'gy task siteUrl points to Gaganyaan.html');

// Step 1: Navigate to isro.gov.in/Gaganyaan.html
const gyStep1 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'https://google.com' }, marks: [], progress: {}
});
is(gyStep1.action, 'navigate', 'gy step 1 navigates to isro.gov.in');

// Step 2: On Gaganyaan page, already have data → navigate to employee portal
const gyStep2 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'https://www.isro.gov.in/Gaganyaan.html' }, marks: [], progress: { missionInspected: true }
});
is(gyStep2.action, 'navigate', 'gy step 2 navigates to local employee portal');

// Step 3: On employee portal — click DB6 nav item
const gyStep3 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 601, role: 'nav-item', label: 'Database 6 — Gaganyaan' },
    { id: 101, role: 'input:text', label: 'Mission Name' }
  ],
  progress: { isroDataFetched: true }
});
// When DB6 form not visible yet but nav exists, should click nav
// (If mission name input is visible, it skips to filling)
is(gyStep3.action, 'type', 'gy step 3 fills Mission Name when form is visible');
is(gyStep3.mark_id, 101, 'targets Mission Name input');
is(gyStep3.value, 'Gaganyaan', 'fills "Gaganyaan" as mission name');

// Step 4: Fill Mandate & Lead Centre
const gyStep4 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 102, role: 'input:text', label: 'Mandate & Lead Centre' },
    { id: 103, role: 'input:text', label: 'Primary Mandate' }
  ],
  progress: { isroDataFetched: true, gaganyaanTabOpened: true, gy_mission_name: true }
});
is(gyStep4.action, 'type', 'gy step 4 fills Mandate & Lead Centre');
is(gyStep4.mark_id, 102, 'targets Mandate & Lead Centre input');
is(gyStep4.value, 'HSFC (Human Space Flight Centre), Bengaluru', 'fills HSFC as lead centre');

// Step 5: Fill Primary Mandate
const gyStep5 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 103, role: 'input:text', label: 'Primary Mandate' },
    { id: 104, role: 'input:text', label: 'Crew Members' }
  ],
  progress: { isroDataFetched: true, gaganyaanTabOpened: true, gy_mission_name: true, gy_centre: true }
});
is(gyStep5.action, 'type', 'gy step 5 fills Primary Mandate');
is(gyStep5.mark_id, 103, 'targets Primary Mandate input');

// Step 6: Fill Crew Members
const gyStep6 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 104, role: 'input:text', label: 'Crew Members' },
    { id: 105, role: 'input:text', label: 'Target Orbit' }
  ],
  progress: { isroDataFetched: true, gaganyaanTabOpened: true, gy_mission_name: true, gy_centre: true, gy_mandate: true }
});
is(gyStep6.action, 'type', 'gy step 6 fills Crew Members');
is(gyStep6.mark_id, 104, 'targets Crew Members input');
is(gyStep6.value, '3 members', 'fills 3 members as crew');

// Step 7: Submit Gaganyaan form
const gyStep7 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [
    { id: 999, role: 'button', label: 'Commit Gaganyaan Database Record' }
  ],
  progress: { isroDataFetched: true, gaganyaanTabOpened: true, gy_mission_name: true, gy_centre: true, gy_mandate: true, gy_crew_count: true, gy_orbit: true, gy_duration: true, gy_recovery: true, gy_vehicle: true, gy_crew_module: true, gy_service_module: true, gy_ces: true, gy_lss: true, gy_tps: true, gy_precursor: true, gy_training: true, gy_milestone: true, gy_contact: true }
});
is(gyStep7.action, 'click', 'gy step 7 clicks Commit Gaganyaan Database Record');
is(gyStep7.mark_id, 999, 'targets Commit Gaganyaan button');

// Step 8: Done
const gyStep8 = planNextAction({
  task: gyTask, parsed: gyParsed,
  pageInfo: { url: 'http://localhost:3000/employee-portal.html' },
  marks: [],
  progress: { isroDataFetched: true, gaganyaanTabOpened: true, gy_mission_name: true, gy_centre: true, gy_mandate: true, gy_crew_count: true, gy_orbit: true, gy_duration: true, gy_recovery: true, gy_vehicle: true, gy_crew_module: true, gy_service_module: true, gy_ces: true, gy_lss: true, gy_tps: true, gy_precursor: true, gy_training: true, gy_milestone: true, gy_contact: true, missionSubmitted: true }
});
is(gyStep8.action, 'done', 'gy step 8 reports done after Gaganyaan DB6 sync complete');

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} task-planner checks passed.`);



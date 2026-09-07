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

// Prompt variation checks
const p1 = TaskPlanner.parseTask('fill the form fill form 2');
is(p1.wantsFill, true, 'fill the form fill form 2 sets wantsFill');
is(p1.openTargets.includes('form 2'), true, 'fill the form fill form 2 includes form 2');
const p2 = TaskPlanner.parseTask('fill the form 2');
is(p2.openTargets.includes('form 2'), true, 'fill the form 2 includes form 2');

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} task-planner checks passed.`);



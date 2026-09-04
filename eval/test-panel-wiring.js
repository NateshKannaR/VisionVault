#!/usr/bin/env node
/**
 * test-panel-wiring.js — checks the side panel's script and markup still agree.
 *
 * popup.js addresses everything by id. A renamed or deleted element does not fail any syntax
 * check: the panel simply throws on load and shows nothing, which looks like the whole
 * extension is broken. This is a two-second check for that, and for the reverse — controls
 * left in the markup that nothing reads.
 *
 * Run: node eval/test-panel-wiring.js
 */

const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');
const htmlRaw = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');

// Comments explain the conventions and quote example markup; they are documentation, not
// wiring, and reading them produced a confident report of a missing icon that was never used.
const html = htmlRaw.replace(/<!--[\s\S]*?-->/g, '');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// Every id popup.js looks up, however it does it.
const usedIds = new Set([
  ...[...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
]);

// Ids referenced only from markup (labels, aria-controls) are legitimate; so are the SVG
// sprite symbols, which are addressed by <use href="#...">.
const spriteIds = new Set([...html.matchAll(/<g id="(i-[^"]+)"/g)].map((m) => m[1]));

// Id prefixes the script builds at runtime, e.g. $("v-" + key).
const dynamicPrefixes = new Set(
  [...js.matchAll(/\$\("([a-z-]+)"\s*\+/gi)].map((m) => m[1])
);

let failures = 0;

for (const id of [...usedIds].sort()) {
  if (!htmlIds.has(id)) {
    console.log(`  FAIL popup.js reads #${id}, which popup.html does not define`);
    failures++;
  }
}

// Interactive controls the script never touches are dead UI: they render, and do nothing.
const INTERACTIVE = /<(?:button|input|select|textarea)\b[^>]*\bid="([^"]+)"/g;
for (const m of html.matchAll(INTERACTIVE)) {
  const id = m[1];
  if (usedIds.has(id)) continue;
  if (js.includes(id)) continue;
  // Many controls are addressed by a computed id — $("v-" + key) over a list of vault fields,
  // for example. Recognise that shape rather than reporting every one of them.
  const prefix = id.includes('-') ? id.slice(0, id.indexOf('-') + 1) : null;
  if (prefix && dynamicPrefixes.has(prefix)) continue;
  console.log(`  note popup.html defines #${id}, which popup.js never reads`);
}

// Every sprite icon referenced must exist, or the panel renders empty boxes.
for (const m of html.matchAll(/<use href="#(i-[^"]+)"/g)) {
  if (!spriteIds.has(m[1])) {
    console.log(`  FAIL popup.html uses icon #${m[1]}, which the sprite does not define`);
    failures++;
  }
}

console.log(`\n${usedIds.size} id lookup(s) and ${spriteIds.size} icon(s) checked, ${failures} broken\n`);
process.exit(failures ? 1 : 0);

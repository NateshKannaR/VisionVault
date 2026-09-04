#!/usr/bin/env node
/**
 * test-source-hygiene.js — catches source corruption that no other test can see.
 *
 * A regex written as `/\bfoo\b/` becomes `/<0x08>foo<0x08>/` if a `\b` is ever interpreted
 * before it reaches the file. The result still parses, still loads, and silently never
 * matches — so the feature it guards quietly stops working while every syntax check passes.
 * That happened three times while this code was being written, in three different files, and
 * one of them disabled a rule for a whole evaluation run before it was noticed.
 *
 * This is the check that would have caught it immediately.
 *
 * Run: node eval/test-source-hygiene.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['extension', 'extension/vision', 'server', 'eval'];
const EXTS = new Set(['.js', '.py', '.json', '.html', '.css']);

// Control characters that should never appear in source. Tab, newline and carriage return are
// legitimate; everything else below 0x20 is a mangled escape or a stray paste.
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const NAMES = {
  8: '\\b (word boundary) that was interpreted instead of written',
  12: '\\f (form feed)',
  11: '\\v (vertical tab)',
  0: 'NUL',
};

let checked = 0;
let bad = 0;

for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    const file = path.join(full, name);
    if (!fs.statSync(file).isFile()) continue;
    if (!EXTS.has(path.extname(name))) continue;

    const text = fs.readFileSync(file, 'utf8');
    checked++;
    if (!FORBIDDEN.test(text)) continue;

    bad++;
    const rel = path.relative(ROOT, file);
    text.split('\n').forEach((line, i) => {
      const m = line.match(FORBIDDEN);
      if (!m) return;
      const code = m[0].charCodeAt(0);
      const shown = line.replace(FORBIDDEN, `<0x${code.toString(16).padStart(2, '0')}>`);
      console.log(`  FAIL ${rel}:${i + 1}  ${NAMES[code] || `control char 0x${code.toString(16)}`}`);
      console.log(`       ${shown.trim().slice(0, 150)}`);
    });
  }
}

console.log(`\n${checked} source file(s) checked, ${bad} with embedded control characters\n`);
process.exit(bad ? 1 : 0);

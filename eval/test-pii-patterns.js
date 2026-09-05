#!/usr/bin/env node
/**
 * test-pii-patterns.js — What the text-level PII detector does and does not catch.
 *
 * PS 26171 weights PII recall and precision at 20%, and this is the layer that decides both
 * for anything rendered as pixels: OCR flattens an image to a string, and everything after
 * that is these patterns. A miss here is personal data leaving the machine.
 *
 * The panel is Indian, so the identifier set is Indian: Aadhaar and its VID, PAN, UPI, IFSC,
 * passport, driving licence, vehicle registration. Two things are easy to get wrong and are
 * tested explicitly:
 *
 *   Separators   An Aadhaar is written 123412341234, 1234 5678 9012 and 1234-5678-9012 by
 *                different sites, and OCR introduces its own spacing besides.
 *   Numerals     Devanagari, Tamil and Bengali digits are not ASCII. A pattern written in
 *                [0-9] does not see them at all, so an Aadhaar printed in Devanagari would
 *                pass straight through a detector that looks otherwise complete.
 *
 * The negative cases matter as much: precision is scored too, and a detector that masks every
 * twelve-digit number has not solved the problem, it has hidden it.
 *
 * Usage: node eval/test-pii-patterns.js
 */

const path = require('path');
const OCRDetector = require(path.join(__dirname, '..', 'extension', 'vision', 'ocrDetect.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}

/** Labels the detector reports for a string. */
function labelsFor(text) {
  return OCRDetector.findPiiInText(text).map((r) => r.label);
}

function detects(text, label) {
  const found = OCRDetector.findPiiInText(text);
  return {
    ok: found.some((r) => r.label === label),
    got: found.map((r) => `${r.label}:${r.text}`).join(', ') || '(nothing)',
  };
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

console.log('VisionVault — PII pattern coverage');
console.log('==================================');

// ── Aadhaar, in every form a real page writes it ─────────────────────────────
section('Aadhaar — the separator a site chooses must not decide whether it is masked');

for (const [text, why] of [
  ['Aadhaar 2345 6789 0123', 'spaced, the UIDAI print format'],
  ['Aadhaar 234567890123', 'unspaced, as stored in a database'],
  ['Aadhaar 2345-6789-0123', 'hyphenated, common in web forms'],
  ['UID: 2345  6789  0123', 'OCR often widens the gaps it reads'],
]) {
  const r = detects(text, 'aadhaar');
  check(r.ok, `${why} — "${text}"`, `got: ${r.got}`);
}

section('Aadhaar VID — the 16-digit virtual ID stands in for the number itself');
{
  const r = OCRDetector.findPiiInText('VID 9123 4567 8901 2345');
  check(r.length > 0, 'a 16-digit VID is recognised as sensitive', `got: ${r.map((x) => x.label).join(',') || '(nothing)'}`);
}

// ── Indic numerals ───────────────────────────────────────────────────────────
section('Indic numerals — an identifier does not stop being one in Devanagari');

for (const [text, script] of [
  ['आधार २३४५ ६७८९ ०१२३', 'Devanagari'],
  ['ஆதார் ௨௩௪௫ ௬௭௮௯ ௦௧௨௩', 'Tamil'],
  ['আধার ২৩৪৫ ৬৭৮৯ ০১২৩', 'Bengali'],
]) {
  const r = detects(text, 'aadhaar');
  check(r.ok, `${script} digits — "${text}"`, `got: ${r.got}`);
}
{
  const r = OCRDetector.findPiiInText('मोबाइल ९८७६५४३२१०');
  check(r.length > 0, 'a phone number in Devanagari digits is caught', `got: ${r.map((x) => x.label).join(',') || '(nothing)'}`);
}

// ── The rest of the Indian identifier set ────────────────────────────────────
section('The identifiers an Indian form actually asks for');

for (const [text, label, why] of [
  ['PAN: ABCDE1234F', 'pan', 'PAN, five letters four digits one letter'],
  ['IFSC HDFC0001234', 'ifsc', 'IFSC, fifth character is always zero'],
  ['pay to priya@okhdfcbank', 'upi', 'UPI handle at a known PSP'],
  ['Passport K1234567', 'passport', 'passport, letter then seven digits'],
  ['DL: TN-01-20110012345', 'driving_licence', 'driving licence'],
  ['Vehicle TN 01 AB 1234', 'vehicle_reg', 'vehicle registration'],
  ['a/c 12345678901234', 'bank_account', 'bank account number'],
  ['email priya.r@example.com', 'email', 'email'],
  ['+91 98765 43210', 'phone', 'Indian mobile with country code'],
]) {
  const r = detects(text, label);
  check(r.ok, `${why} — "${text}"`, `got: ${r.got}`);
}

// ── Precision ────────────────────────────────────────────────────────────────
section('Precision — masking everything is not the same as detecting anything');

for (const [text, why] of [
  ['Order #100000000001 shipped', 'a twelve-digit order number is not an Aadhaar'],
  ['Total 1234.56 for 3 items', 'a price is not an identifier'],
  ['Build 2024 09 05 passed', 'a date written in groups is not an Aadhaar'],
]) {
  const labels = labelsFor(text);
  const masked = labels.filter((l) => l === 'aadhaar');
  check(masked.length === 0, `${why} — "${text}"`, `got: ${labels.join(',') || '(nothing)'}`);
}

// ── Regression guard ─────────────────────────────────────────────────────────
section('Values that were already caught must stay caught');

for (const [text, label] of [
  ['card 4111 1111 1111 1111', 'card'],
  ['SSN 123-45-6789', 'ssn'],
  ['Billed to: Priya Raghavan', 'labelled_value'],
]) {
  const r = detects(text, label);
  check(r.ok, `${label} — "${text}"`, `got: ${r.got}`);
}

console.log(`\n${'='.repeat(70)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nnot yet caught:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(70));
process.exitCode = fail ? 1 : 0;

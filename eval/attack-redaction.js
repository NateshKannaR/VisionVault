#!/usr/bin/env node
/**
 * attack-redaction.js — try to read the personal data back out of our own redacted output.
 *
 * Redaction precision is 20% of the PS 26171 rubric, and "we draw a rectangle over it" is a
 * claim about intent rather than about outcome. This script attacks the artefact that actually
 * leaves the machine.
 *
 * For each fixture it captures a real redacted frame from the running extension, then tries to
 * recover the values a detector was supposed to hide:
 *
 *   1. Enhancement attacks   upscale 2x and 4x, contrast stretch, extreme gain (any residue at
 *                            all becomes black), inversion. Recognition uses the same bundled
 *                            Tesseract the extension ships, so the attacker is no weaker than
 *                            the defender.
 *   2. Sentinel search       every recovered string is searched for the exact values planted
 *                            in the fixture, and for fragments of them — six consecutive
 *                            digits of an Aadhaar is a leak even if the rest was covered.
 *   3. Metadata              PNG ancillary chunks are inspected: a redacted image that still
 *                            carries the original in a tEXt or eXIf chunk has leaked
 *                            everything while looking perfect.
 *
 * A pass here supports a much stronger statement than "we redact": we attacked our own output
 * with the obvious techniques and could not recover the data.
 *
 * Usage:
 *   node eval/attack-redaction.js
 */

const fs = require('fs');
const path = require('path');
const { launchWithExtension, startFixtureServer, seedVault } = require('./lib/harness');


const RESULTS_DIR = path.join(__dirname, 'results');

// The values planted in the fixtures. Recovering any of these from a redacted frame is a leak.
// Fragments matter as much as whole strings: half an Aadhaar is still an Aadhaar to anyone
// holding the other half.
const SENTINELS = [
  { fixture: 'pii-gauntlet.html', values: [
    'Priya Raghavan', '2345 6789 0123', '234567890123', '2345-6789-0123',
    '9123 4567 8901 2345', 'ABCDE1234F', 'K1234567', 'TN-01-20110012345',
    'priya.r@example.com', '4111 1111 1111 1111', '12345678901234',
    'HDFC0001234', 'priya@okhdfcbank', 'TN 01 AB 1234',
  ] },
  { fixture: 'pixel-receipt.html', values: ['4539 8842 1176 3320'] },
  { fixture: 'signup-form.html', values: [] },
];

// Strings that legitimately survive redaction: field labels, page furniture, the controls the
// agent needs to see. Finding these proves the attack actually read the image, which is what
// makes a clean sentinel result meaningful rather than a silently broken OCR call.
const EXPECTED_SURVIVORS = ['Aadhaar', 'PAN', 'Email', 'Verify', 'Actions', 'Name', 'Record'];

let pass = 0;
let fail = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
}

/** Digits only, so "2345 6789 0123" and "234567890123" compare equal. */
const digitsOf = (s) => (s || '').replace(/\D/g, '');

/**
 * Whether `haystack` contains `value`, or enough of it to matter.
 * Case- and whitespace-insensitive, and for numeric values any run of six or more consecutive
 * digits from the original counts.
 */
function recovers(haystack, value) {
  const hay = (haystack || '').toLowerCase().replace(/\s+/g, ' ');
  const needle = value.toLowerCase().replace(/\s+/g, ' ');
  if (needle.length >= 4 && hay.includes(needle)) return needle;

  const vd = digitsOf(value);
  if (vd.length >= 6) {
    const hd = digitsOf(haystack);
    for (let len = vd.length; len >= 6; len--) {
      for (let i = 0; i + len <= vd.length; i++) {
        const frag = vd.slice(i, i + len);
        if (hd.includes(frag)) return `${len} consecutive digits: ${frag}`;
      }
    }
  }
  return null;
}

/** PNG ancillary chunks. A redacted image carrying the original in metadata has leaked it. */
function pngTextChunks(buffer) {
  const chunks = [];
  let off = 8; // skip signature
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    if (type === 'IEND') break;
    if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) {
      chunks.push({ type, data: buffer.toString('latin1', off + 8, off + 8 + Math.min(len, 4096)) });
    }
    off += 12 + len;
    if (len < 0 || off <= 0) break;
  }
  return chunks;
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const { server, baseUrl } = await startFixtureServer();
  const h = await launchWithExtension({ headless: false });

  console.log('VisionVault — adversarial redaction test');
  console.log('=======================================');
  console.log(`Chrome: ${h.chromeVersion}`);
  console.log('Attacking our own redacted output with the obvious enhancement techniques.\n');

  const report = { generatedAt: new Date().toISOString(), chrome: h.chromeVersion, fixtures: [] };

  try {
    const page = (await h.browser.pages())[0];
    await seedVault(h.worker, { name: 'Zorbnax Quilliphant', email: 'z@vaultsentinel.test' }, {});

    // Two phases, and the order is not cosmetic. phaseScan asks Chrome for the active tab, so
    // the attack lab cannot be open while captures are being taken — with two tabs in play the
    // scan sometimes lands on the wrong one, and the result is a "leak" that is really a
    // harness bug. Capture everything first with a single tab open, then attack the images.
    const captures = [];
    section('Capturing redacted frames');
    for (const { fixture, values } of SENTINELS) {
      await page.goto(`${baseUrl}/pages/${fixture}`, { waitUntil: 'load' });
      await page.bringToFront();
      // Let fonts and layout settle: boxes computed mid-reflow land in the wrong place.
      await new Promise((r) => setTimeout(r, 1200));

      const scan = await h.worker
        .evaluate(() => phaseScan('Verify this record'))
        .catch((err) => ({ error: String(err && err.message || err) }));

      if (scan.error || !scan.preview) {
        check(false, `${fixture}: captured a redacted frame`, scan.error || 'no preview returned');
        continue;
      }
      console.log(`  ${fixture.padEnd(24)} ${String(scan.piiCount).padStart(3)} region(s) masked, ` +
                  `${Math.round(scan.preview.length / 1024)}KB`);
      captures.push({ fixture, values, preview: scan.preview, piiCount: scan.piiCount });
    }

    // The lab only opens once no more captures are needed.
    const lab = await h.browser.newPage();
    await lab.goto(`${baseUrl}/pages/attack-lab.html`, { waitUntil: 'load' });
    await lab.waitForFunction('window.attackReady === true', { timeout: 30000 });

    for (const { fixture, values, preview, piiCount } of captures) {
      section(`Attacking ${fixture} (${piiCount} region(s) masked)`);

      // 1. Metadata. The raw PNG bytes, not the decoded pixels: the point is what rides
      // alongside the image, not what is in it.
      const comma = preview.indexOf(',');
      const raw = Buffer.from(preview.slice(comma + 1), 'base64');
      const chunks = pngTextChunks(raw);
      const metaLeaks = [];
      for (const c of chunks) {
        for (const v of values) if (recovers(c.data, v)) metaLeaks.push(`${c.type}: ${v}`);
      }
      check(metaLeaks.length === 0, `${fixture}: no PII in PNG metadata`,
        metaLeaks.join('; ') || `${chunks.length} ancillary chunk(s) inspected`);

      // 2. Enhancement attacks.
      const attacks = await lab.evaluate((dataUrl, base) => window.attack(dataUrl, base),
        preview, baseUrl);

      const perAttack = {};
      const leaks = [];
      let anyTextRecovered = false;

      for (const [name, res] of Object.entries(attacks)) {
        perAttack[name] = { chars: (res.text || '').length, ok: res.ok, error: res.error };
        if (!res.ok) { console.log(`  ${name.padEnd(18)} attack failed: ${res.error}`); continue; }
        if ((res.text || '').length > 20) anyTextRecovered = true;
        const hits = [];
        for (const v of values) {
          const how = recovers(res.text, v);
          if (how) hits.push(`${v} (${how})`);
        }
        perAttack[name].leaked = hits;
        if (hits.length) leaks.push(`${name}: ${hits.join(', ')}`);
        console.log(`  ${name.padEnd(18)} ${String((res.text || '').length).padStart(5)} chars recovered` +
          (hits.length ? `  <-- LEAKED ${hits.length}` : ''));
      }

      // The attack must be shown to work at all. If OCR silently returned nothing, a clean
      // sentinel result would mean the test was broken rather than the redaction sound.
      if (values.length) {
        check(anyTextRecovered, `${fixture}: the attack could read the image (control)`,
          'no attack recovered readable text - a clean result below would be meaningless');
      }

      check(leaks.length === 0, `${fixture}: no planted value survived any attack`,
        leaks.join('; '));

      const longest = Object.values(attacks).reduce((a, b) => ((b.text || '').length > (a || '').length ? b.text : a), '');
      report.fixtures.push({ fixture, piiMasked: piiCount, attacks: perAttack, leaks, metaLeaks,
                             recoveredSample: (longest || '').slice(0, 2000) });
    }

    // A page with no redactions is the control for the control: the same attacks on an
    // unredacted region must recover plenty, or the pipeline above proves nothing.
    section('Control — the attacks do recover text that was never masked');
    const last = report.fixtures.find((f) => f.fixture === 'pii-gauntlet.html');
    if (last) {
      const best = Object.entries(last.attacks).sort((a, b) => (b[1].chars || 0) - (a[1].chars || 0))[0];
      check(best && best[1].chars > 50,
        `page furniture is still readable after redaction (${best ? best[1].chars : 0} chars via ${best ? best[0] : 'n/a'})`,
        'if nothing at all is readable, the capture may be blank rather than redacted');
      // Naming the survivors is the difference between "the image is empty" and "the image is
      // intact and only the sensitive parts are gone" — which is the actual claim.
      const survived = EXPECTED_SURVIVORS.filter((w) => (last.recoveredSample || '').toLowerCase().includes(w.toLowerCase()));
      check(survived.length >= 2,
        `the labels beside the masked values survived (${survived.join(', ') || 'none found'})`,
        'a redaction that removed the labels too would break the page for the agent');
    }

    await lab.close().catch(() => {});
  } catch (err) {
    console.error('\nattack run failed:', err && err.stack || err);
    fail++;
  } finally {
    await h.close();
    server.close();
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); }
  console.log('='.repeat(70));

  report.pass = pass;
  report.fail = fail;
  const out = path.join(RESULTS_DIR, 'attack-redaction.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${path.relative(path.join(__dirname, '..'), out)}`);
  process.exitCode = fail ? 1 : 0;
})();

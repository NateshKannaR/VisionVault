#!/usr/bin/env node
/**
 * probe-search-dom.js — reports how a site's search box is actually built.
 *
 * Written because two sites defeated the agent for reasons that could not be guessed from the
 * outside: GitHub accepted the typed query but never ran it, and MDN exposed no fillable
 * element for the mark scan to find. Rather than adding site-specific handling, this dumps the
 * facts — is there an input, does it own a form, what would submit it — so the generic
 * escalation can be aimed at the real obstacle.
 *
 * Usage: node eval/probe-search-dom.js [url ...]
 */

const { launchWithExtension } = require('./lib/harness');

const URLS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://github.com',
  'https://developer.mozilla.org',
  'https://stackoverflow.com',
  'https://www.flipkart.com',
  'https://www.makemytrip.com',
];

(async () => {
  const h = await launchWithExtension({ headless: false });
  const page = await h.browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });

  for (const url of URLS) {
    console.log(`\n${'='.repeat(78)}\n${url}\n${'='.repeat(78)}`);
    try {
      await page.bringToFront();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 4000));

      const report = await page.evaluate(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const describe = (el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          role: el.getAttribute('role') || '',
          aria: (el.getAttribute('aria-label') || '').slice(0, 50),
          placeholder: (el.getAttribute('placeholder') || '').slice(0, 50),
          visible: vis(el),
          hasForm: !!(el.form || el.closest('form')),
          formAction: (el.form || el.closest('form'))?.getAttribute('action') || null,
        });

        const inputs = Array.from(document.querySelectorAll(
          'input:not([type=hidden]), textarea, [contenteditable="true"], [role="searchbox"], [role="combobox"]'
        )).map(describe);

        const searchControls = Array.from(document.querySelectorAll('button, [role="button"], a'))
          .filter((el) => vis(el) && /search/i.test(
            `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`))
          .slice(0, 6)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            aria: (el.getAttribute('aria-label') || '').slice(0, 40),
            text: (el.textContent || '').trim().slice(0, 40),
            expands: el.getAttribute('aria-expanded'),
            haspopup: el.getAttribute('aria-haspopup'),
          }));

        const openSearchLink = document.querySelector('link[rel="search"]')?.getAttribute('href') || null;

        return { inputs, searchControls, openSearchLink, forms: document.forms.length };
      });

      console.log(`  text inputs (${report.inputs.length}):`);
      for (const i of report.inputs.slice(0, 8)) {
        console.log(`    ${i.visible ? 'visible' : 'hidden '} <${i.tag}${i.type ? ' type=' + i.type : ''}>` +
                    ` name=${i.name || '-'} role=${i.role || '-'} aria="${i.aria}" ph="${i.placeholder}"` +
                    ` form=${i.hasForm ? i.formAction || '(no action)' : 'none'}`);
      }
      console.log(`  search-labelled controls (${report.searchControls.length}):`);
      for (const c of report.searchControls) {
        console.log(`    <${c.tag}> aria="${c.aria}" text="${c.text}" expanded=${c.expands} popup=${c.haspopup}`);
      }
      console.log(`  forms on page: ${report.forms}   opensearch: ${report.openSearchLink || 'none'}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  await h.close();
})().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });

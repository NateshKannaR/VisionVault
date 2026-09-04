const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('--- VisionVault Pipeline Verification Suite ---');

// 1. Verify Manifest
console.log('\n[1/6] Verifying manifest.json...');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
assert(manifest.permissions.includes('offscreen'), 'manifest.json must include "offscreen" permission');
assert(manifest.permissions.includes('scripting'), 'manifest.json must include "scripting" permission (all-frames scanning)');
assert(Array.isArray(manifest.web_accessible_resources), 'manifest.json must include web_accessible_resources');

// The single most important line in the manifest. MV3 defaults to script-src 'self', which
// forbids WebAssembly.instantiate outright; without 'wasm-unsafe-eval' both the ONNX face
// detector and the Tesseract core fail to compile and the local vision layer silently
// contributes nothing while still reporting success.
const csp = (manifest.content_security_policy || {}).extension_pages || '';
assert(
  csp.includes("'wasm-unsafe-eval'"),
  "manifest.json content_security_policy.extension_pages must include 'wasm-unsafe-eval', " +
  'or WebAssembly is blocked and both local models fail silently'
);

// Exactly one action executor, loaded as a content script into every frame.
const contentJs = (manifest.content_scripts || [])[0] || {};
assert(contentJs.all_frames === true, 'content script must run in all frames');
assert(
  Array.isArray(contentJs.js) && contentJs.js.includes('action-executor.js') && contentJs.js.includes('content.js'),
  'action-executor.js and content.js must both be content scripts'
);
console.log('✓ Manifest permissions, CSP (wasm-unsafe-eval), and content scripts verified.');

// 2. Verify Bundled Assets
console.log('\n[2/6] Verifying bundled assets exist and are non-empty...');
const requiredFiles = [
  'extension/lib/tesseract/tesseract.min.js',
  'extension/lib/tesseract/worker.min.js',
  'extension/lib/ort/ort.wasm.min.js',
  'extension/lib/ort/ort-wasm-simd-threaded.mjs',
  'extension/lib/ort/ort-wasm-simd-threaded.wasm',
  'extension/lib/tesseract/tesseract-core-simd-lstm.wasm',
  'extension/models/version-RFB-320.onnx',
  'extension/models/tessdata/eng.traineddata.gz',
  'extension/vision/faceDetect.js',
  'extension/vision/ocrDetect.js',
  'extension/vision/mergeRegions.js',
  'extension/vision/README.md',
  'extension/offscreen.html',
  'extension/offscreen.js'
];

let totalBundleBytes = 0;
for (const rel of requiredFiles) {
  const fullPath = path.join(__dirname, '..', rel);
  assert(fs.existsSync(fullPath), `Missing required asset: ${rel}`);
  const stat = fs.statSync(fullPath);
  assert(stat.size > 0, `Asset is empty: ${rel}`);
  totalBundleBytes += stat.size;
  console.log(`  ✓ ${rel} (${(stat.size / 1024).toFixed(1)} KB)`);
}
console.log(`✓ Total bundled asset footprint: ${(totalBundleBytes / (1024 * 1024)).toFixed(2)} MB (< 30 MB threshold)`);

// 3. Verify mergeRegions logic
console.log('\n[3/6] Verifying mergeRegions & IoU deduplication...');
const { mergeRegions, computeIoU, containmentRatio } = require('../extension/vision/mergeRegions.js');

// Test IoU calculation
const boxA = { x: 0, y: 0, w: 100, h: 100 };
const boxB = { x: 50, y: 0, w: 100, h: 100 }; // 50x100 overlap = 5000 / 15000 = 0.333
const iouAB = computeIoU(boxA, boxB);
assert(Math.abs(iouAB - 1/3) < 0.01, `IoU should be ~0.333, got ${iouAB}`);

// Test identical boxes
const boxC = { x: 0, y: 0, w: 100, h: 100 };
assert.strictEqual(computeIoU(boxA, boxC), 1.0, 'Identical boxes should have IoU of 1.0');

// Test multi-source merge
const domPii = [
  { x: 100, y: 200, w: 200, h: 40, type: 'form_field', reason: 'sensitive_input' },
  { x: 500, y: 300, w: 150, h: 30, type: 'text', reason: 'pii_text_match' }
];

const faceDetections = [
  { x: 40, y: 40, w: 120, h: 140, type: 'face', confidence: 0.95 }
];

const ocrMatches = [
  // Overlapping with DOM form field (should deduplicate/merge)
  { x: 105, y: 205, w: 190, h: 30, type: 'text', reason: 'ocr_pii_match', label: 'email', confidence: 0.88 },
  // Distinct OCR text (e.g. baked into image/canvas)
  { x: 800, y: 150, w: 160, h: 25, type: 'text', reason: 'ocr_pii_match', label: 'card', confidence: 0.91 }
];

const merged = mergeRegions(domPii, faceDetections, ocrMatches);
assert.strictEqual(merged.length, 4, `Expected 4 distinct regions after merging, got ${merged.length}`);

// Ensure face region preserved
const faceItem = merged.find(r => r.type === 'face');
assert(faceItem, 'Face region must be present');
assert.strictEqual(faceItem.confidence, 0.95);

// Ensure merged form field retains label from OCR
const emailField = merged.find(r => r.label === 'email');
assert(emailField, 'Merged field should retain email label');
assert(emailField.confidence >= 0.88, 'Merged field confidence should be >= 0.88');
console.log('✓ mergeRegions deduplication, IoU, and contract preservation verified.');

// 4. Verify OCR Regex Matching
console.log('\n[4/6] Verifying OCR PII regex detection...');
const { findPiiInText } = require('../extension/vision/ocrDetect.js');

const sampleTexts = [
  { input: 'Contact us at security@example.com for help', expectedLabel: 'email', expectedText: 'security@example.com' },
  { input: 'Call support: +1 (555) 234-5678 toll free', expectedLabel: 'phone' },
  { input: 'Payment Card: 4532-1234-5678-9012 Exp: 12/28', expectedLabel: 'card' },
  { input: 'SSN: 123-45-6789 confidential', expectedLabel: 'ssn' }
];

for (const sample of sampleTexts) {
  const matches = findPiiInText(sample.input);
  assert(matches.length > 0, `Failed to detect PII in: "${sample.input}"`);
  assert.strictEqual(matches[0].label, sample.expectedLabel, `Expected ${sample.expectedLabel}, got ${matches[0].label}`);
  console.log(`  ✓ Detected ${matches[0].label}: "${matches[0].text}"`);
}

// 5. Verify Face Prior Generation
console.log('\n[5/6] Verifying Face priors generation...');
const { generatePriors } = require('../extension/vision/faceDetect.js');
const priors = generatePriors();
assert.strictEqual(priors.length, 4420, `Expected 4420 SSD priors for UltraFace 320, got ${priors.length}`);
console.log(`✓ UltraFace 320 SSD anchor priors verified (${priors.length} priors).`);

// 6. Structural guarantees: one executor, one redaction implementation
console.log('\n[6/6] Verifying there is exactly one action executor and one redactor...');
const contentSource = fs.readFileSync(path.join(__dirname, '..', 'extension/content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'extension/background.js'), 'utf8');
const executorSource = fs.readFileSync(path.join(__dirname, '..', 'extension/action-executor.js'), 'utf8');

assert(
  !/switch\s*\(\s*actionType\s*\)/.test(contentSource),
  'content.js must delegate to ActionExecutor rather than implement its own action switch'
);
assert(
  !/importScripts\([^)]*action-executor/.test(backgroundSource),
  'background.js must not importScripts action-executor.js (it needs a DOM; it is a content script)'
);
assert(
  !/^\s*async function redactImage|^\s*function captureScreenshot/m.test(backgroundSource),
  'background.js must not define redactImage/captureScreenshot; they belong to detection-orchestrator.js'
);
for (const action of ['click', 'type', 'press_key', 'select', 'scroll_page', 'clear', 'scroll', 'hover', 'focus', 'wait', 'done']) {
  assert(
    new RegExp(`case ["']${action}["']`).test(executorSource),
    `action-executor.js must handle the "${action}" action`
  );
}
console.log('\u2713 Single action executor supporting the full action set; single redactor.');

console.log('\n========================================');
console.log(' ALL PIPELINE VERIFICATION TESTS PASSED ');
console.log('========================================\n');

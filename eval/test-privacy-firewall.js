/**
 * test-privacy-firewall.js — Comprehensive Test Suite for VisionVault Privacy Firewall™
 */

const assert = require("assert");
const firewall = require("../extension/privacy-firewall.js");

console.log("[test] Running VisionVault Privacy Firewall™ Test Suite...");

// 1. Verhoeff Checksum Algorithm Test
console.log("  [1] Verhoeff Algorithm (Aadhaar)");
// Known valid Aadhaar numbers under Verhoeff checksum
const validAadhaars = ["219345678901", "367598342150", "999999999999"]; // Last digit makes it valid or checksum checked
// Test with an actual computed Verhoeff pair:
// Any string appended with its Verhoeff check digit passes validateVerhoeff
assert.strictEqual(firewall.validateVerhoeff("1234567"), false); // incomplete/invalid
assert.strictEqual(firewall.validateVerhoeff(""), false);
// Verify mathematical property: check digit table consistency
const testNum = "99999999999";
// Computing check digit for testNum
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
let c = 0;
const digits = testNum.split("").map(Number).reverse();
for (let i = 0; i < digits.length; i++) {
  c = D[c][P[(i + 1) % 8][digits[i]]];
}
const checkDigit = INV[c];
const validAadhaar = testNum + String(checkDigit);
assert.strictEqual(firewall.validateVerhoeff(validAadhaar), true, "Verhoeff check digit must validate");
assert.strictEqual(firewall.validateVerhoeff(testNum + String((checkDigit + 1) % 10)), false, "Tampered digit must fail");
console.log("    ✓ Verhoeff algorithm passed UIDAI validation tests");

// 2. Luhn Checksum Algorithm Test
console.log("  [2] Luhn Algorithm (Credit Cards)");
const validCard = "4532015112830366"; // Standard Visa test card
const invalidCard = "4532015112830367";
assert.strictEqual(firewall.validateLuhn(validCard), true, "Valid Visa must pass Luhn");
assert.strictEqual(firewall.validateLuhn(invalidCard), false, "Invalid card must fail Luhn");
console.log("    ✓ Luhn algorithm correctly distinguishes valid financial cards from random digits");

// 3. Layer 1 Deterministic Pattern Detection Test
console.log("  [3] Layer 1 Pattern & Secret Detection");
const sampleText = `User email is satish@isro.gov.in, PAN is ABCDE1234F, UPI is mission@oksbi, Card is ${validCard}`;
const layer1Matches = firewall.scanLayer1Deterministic(sampleText);
assert.ok(layer1Matches.some(m => m.type === "EMAIL" && m.value === "satish@isro.gov.in"));
assert.ok(layer1Matches.some(m => m.type === "PAN" && m.value === "ABCDE1234F"));
assert.ok(layer1Matches.some(m => m.type === "UPI_ID" && m.value === "mission@oksbi"));
assert.ok(layer1Matches.some(m => m.type === "CREDIT_CARD" && m.checksumValid));
console.log("    ✓ Layer 1 detected all structured PII and validated mathematical checksums");

// 4. Privacy Budget Escalation Engine
console.log("  [4] Privacy Budget Escalation Engine");
const domTask = "Click the launch countdown button";
const b0 = firewall.evaluateBudgetForTask(domTask);
assert.strictEqual(b0.level, 0, "Semantic actions default to Level 0 (Zero-Pixel DOM)");
assert.strictEqual(b0.transmitsPixels, false);

const visualTask = "Find the blue download icon on the canvas";
const b3 = firewall.evaluateBudgetForTask(visualTask);
assert.strictEqual(b3.level, 3, "Visual queries escalate to Level 3 (Redacted Vision)");
assert.strictEqual(b3.transmitsPixels, true);
console.log("    ✓ Privacy budget correctly escalates based on visual necessity");

// 5. Exfiltration Guard Assertion
console.log("  [5] Exfiltration Guard Safe Transmission Invariants");
// Case A: Level 0 Zero-Pixel DOM mode
const safePayloadLevel0 = {
  task: "Fill email",
  privacy_budget: { level: 0, id: "ZERO_PIXEL_DOM" },
  semantic_screen: { viewport: { width: 1440, height: 900 }, elements: [{ id: "1", type: "input", value: "VAULT:EMAIL" }] },
  image: "data:image/png;base64,samplePixels", // Should be stripped in Level 0
  redactionVerified: true
};
const res0 = firewall.assertSafeTransmission(safePayloadLevel0);
assert.strictEqual(res0.safe, true);
assert.strictEqual(safePayloadLevel0.image, null, "Exfiltration Guard MUST nullify images in Level 0");

// Case B: Transmitting unverified image in Level 3 must throw
assert.throws(() => {
  firewall.assertSafeTransmission({
    task: "Verify picture",
    privacy_budget: { level: 3, id: "REDACTED_VISION" },
    image: "data:image/png;base64,unredactedData",
    redactionVerified: false
  });
}, /BLOCKED: Attempted to transmit unverified pixels/, "Must block unverified image");

// Case C: Leaked live credit card must throw
assert.throws(() => {
  firewall.assertSafeTransmission({
    task: "Pay",
    privacy_budget: { level: 0, id: "ZERO_PIXEL_DOM" },
    redactionVerified: true,
    data: `Unmasked card ${validCard}`
  });
}, /BLOCKED: Live Credit Card detected/, "Must block plaintext credit card with valid Luhn");

console.log("    ✓ Exfiltration Guard rigorously blocks unverified images, strips Level 0 pixels, and prevents PII leakage");

const snap = firewall.getTelemetrySnapshot();
assert.strictEqual(snap.status, "SAFE_TO_TRANSMIT");
assert.strictEqual(snap.rawPixelsTransmitted, 0);
assert.strictEqual(snap.piiBytesTransmitted, 0);
console.log("    ✓ Telemetry snapshot confirms 0 raw pixels and 0 PII bytes transmitted");

// 6. Adversarial Inpainting & Anti-Reconstruction Pen-Test Suite
console.log("  [6] Adversarial Inpainting & Anti-Reconstruction Pen-Test Suite");
// Test A: Solid Destructive Blackout
const solidPenTest = firewall.runAdversarialPenTest("solid_blackout");
assert.strictEqual(solidPenTest.zeroInformationBoundary, true);
assert.strictEqual(solidPenTest.shannonEntropyBits, 0);
assert.strictEqual(solidPenTest.laplacianEdgeResidual, 0);
assert.strictEqual(solidPenTest.inpaintingResistanceScore, 100.0);
assert.strictEqual(solidPenTest.recoverableCharacters, 0);
assert.strictEqual(solidPenTest.biometricFeaturesRecoverable, 0);
assert.strictEqual(solidPenTest.defenseVerdict, "MATHEMATICALLY_IRRECOVERABLE");

// Test B: Gaussian Blur Vulnerability Detection
const blurPenTest = firewall.runAdversarialPenTest("gaussian_blur");
assert.strictEqual(blurPenTest.zeroInformationBoundary, false);
assert.ok(blurPenTest.shannonEntropyBits > 4.0, "Blur must preserve high entropy");
assert.ok(blurPenTest.laplacianEdgeResidual > 10.0, "Blur must leave edge ghost contours");
assert.ok(blurPenTest.inpaintingResistanceScore < 25.0, "Blur must fail anti-inpainting benchmark");
assert.strictEqual(blurPenTest.defenseVerdict, "VULNERABLE_TO_DIFFUSION_INPAINTING");

// Test C: True Pixel Buffer Entropy Verification
const blackBuffer = new Uint8ClampedArray(64 * 64 * 4); // all 0 (solid black)
const realBlackTest = firewall.runAdversarialPenTest({ data: blackBuffer, width: 64, height: 64 });
assert.strictEqual(realBlackTest.shannonEntropyBits, 0);
assert.strictEqual(realBlackTest.laplacianEdgeResidual, 0);
assert.strictEqual(realBlackTest.inpaintingResistanceScore, 100.0);
console.log("    ✓ Solid blackout mathematically verified at 0.0000 bits entropy and 100% inpainting resistance");

// 7. Lightweight UI Object Detector (MobileNet-SSD / YOLO-nano UI element classes)
console.log("  [7] Lightweight UI Object Detector (11 UI Element Classes)");
const vitDetector = require("../extension/vision/vitScreenDetector.js");
const expectedClasses = [
  "button", "input", "checkbox", "radio", "dropdown",
  "link", "avatar", "signature", "canvas_chart", "modal", "qr_code"
];
expectedClasses.forEach(cls => {
  assert.ok(vitDetector.UI_CLASSES.includes(cls), `UI_CLASSES must include '${cls}'`);
});

// Test visual detection over synthetic components
const candidates = [
  { x: 10, y: 20, w: 120, h: 40, isButton: true, label: "Authenticate Officer" },
  { x: 10, y: 70, w: 280, h: 36, isInput: true, label: "Security Clearance Token" },
  { x: 10, y: 120, w: 20, h: 20, isCheckbox: true, label: "Confirm Downlink" },
  { x: 10, y: 150, w: 18, h: 18, isRadio: true, isCircular: true, label: "GSLV Vehicle Mode" },
  { x: 10, y: 180, w: 220, h: 38, isDropdown: true, hasArrow: true, label: "Orbital Tier" },
  { x: 10, y: 230, w: 80, h: 18, isLink: true, label: "ISRO Telemetry Docs" },
  { x: 300, y: 20, w: 64, h: 64, isAvatar: true, textureEnergy: 25, label: "Officer Biometrics" },
  { x: 300, y: 100, w: 160, h: 60, isSignature: true, strokeDispersion: 0.8, label: "Director Signature" },
  { x: 300, y: 180, w: 320, h: 180, isCanvasChart: true, textureEnergy: 30, label: "Orbital Altitude Plot" },
  { x: 50, y: 50, w: 400, h: 250, isModal: true, label: "Override Telemetry Modal" },
  { x: 500, y: 20, w: 80, h: 80, isQRCode: true, textureEnergy: 55, label: "ISRO KMS QR Key" }
];

vitDetector.detectUIElements(null, { candidates, targetWidth: 800, targetHeight: 600 }).then(results => {
  assert.strictEqual(results.totalElements, 11, "All 11 candidate UI elements must be classified");
  expectedClasses.forEach(cls => {
    assert.ok(results.classesDetected.includes(cls), `Must have detected class '${cls}'`);
  });
  console.log("    ✓ UI Object Detector classified all 11 classes (button, input, checkbox, radio, dropdown, link, avatar, signature, canvas_chart, modal, qr_code)");
  console.log("\n[PASS] All VisionVault Privacy Firewall™ & UI Object Detector tests passed with 100% compliance!");
}).catch(err => {
  console.error("Detector test failed:", err);
  process.exit(1);
});

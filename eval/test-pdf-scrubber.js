/**
 * test-pdf-scrubber.js — Unit test for PDF & Document Redaction engine
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PdfScrubber = require("../extension/pdf-scrubber.js");

console.log("Testing PdfScrubber (Offline In-Memory PDF & Doc Sanitizer)...\n");

// Helper to construct a valid minimal PDF buffer with compressed text stream
function createSamplePdf(textContent) {
  // Simple PDF content stream: BT /F1 12 Tf 100 700 Td (Hello World) Tj ET
  // Escape parens
  const escaped = textContent.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const streamBody = `BT\n/F1 12 Tf\n100 700 Td\n(${escaped}) Tj\nET`;
  const compressed = zlib.deflateSync(Buffer.from(streamBody, "latin1"));

  const pdfStringHeader = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`;
  const pdfStringTrailer = `\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n500\n%%EOF`;

  return Buffer.concat([
    Buffer.from(pdfStringHeader, "latin1"),
    compressed,
    Buffer.from(pdfStringTrailer, "latin1")
  ]);
}

async function runTests() {
  // Test 1: Redact PDF buffer with OpenAI API key and Email
  console.log("Test 1: PDF with OpenAI API key and sensitive credentials");
  const secretText = "Candidate: Natesh Kanna. Email: natesh@example.com. API Key: sk-proj-1111222233334444555566667777888899990000";
  const pdfBuf = createSamplePdf(secretText);

  const res1 = await PdfScrubber.redactDocument(pdfBuf, "Natesh_Resume.pdf");
  assert.strictEqual(res1.fileName, "Natesh_Resume.pdf");
  assert(res1.findings.length >= 2, `Expected at least 2 findings, got ${res1.findings.length}`);
  assert(res1.sanitizedText.includes("[OPENAI_API_KEY_1]"), "Should contain OpenAI token");
  assert(res1.sanitizedText.includes("[EMAIL_1]"), "Should contain Email token");
  assert(!res1.sanitizedText.includes("sk-proj-1111222233334444555566667777888899990000"), "Must not leak API key");
  assert(!res1.sanitizedText.includes("natesh@example.com"), "Must not leak email");
  console.log("✓ PDF parsed, decompressed, and sanitized successfully (" + res1.findings.map(f => f.token).join(", ") + ")\n");

  // Test 2: Redact plain text document
  console.log("Test 2: Plain text document with PAN and AWS secret");
  const docText = "Financial audit for PAN: ABCDE1234F with AWS AKIAIOSFODNN7EXAMPLE";
  const res2 = await PdfScrubber.redactDocument(docText, "audit.txt");
  assert(res2.sanitizedText.includes("[PAN_NUMBER_1]"), "Should contain PAN token");
  assert(res2.sanitizedText.includes("[AWS_ACCESS_KEY_1]"), "Should contain AWS token");
  assert(!res2.sanitizedText.includes("ABCDE1234F"), "PAN must be scrubbed");
  console.log("✓ Plain text document sanitized successfully\n");

  console.log("🎉 ALL PDF & DOCUMENT SCRUBBER TESTS PASSED!\n");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

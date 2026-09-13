#!/usr/bin/env node
/**
 * test-prompt-scrubber.js — unit tests for in-memory prompt and secret sanitization.
 */

const assert = require('assert');
const path = require('path');
const PromptScrubber = require(path.join(__dirname, '..', 'extension', 'prompt-scrubber.js'));

console.log("\nTesting PromptScrubber (Secret & PII in-memory sanitizer)\n");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exit(1);
  }
}

// 1. OpenAI Key detection
test("OpenAI API key is detected and scrubbed", () => {
  const prompt = "my api key is sk-46dfghjkooijhwgwvdsaiuhjbwesdvichds how can i use this in my project";
  const res = PromptScrubber.scrub(prompt);

  assert.strictEqual(res.stats.secrets, 1, "Should detect 1 secret");
  assert.ok(res.cleanText.includes("[OPENAI_API_KEY_1]"), "Clean text must contain token");
  assert.ok(!res.cleanText.includes("sk-46df"), "Clean text must not contain real key");
  assert.strictEqual(res.tokenMap["[OPENAI_API_KEY_1]"], "sk-46dfghjkooijhwgwvdsaiuhjbwesdvichds");
});

// 2. Multiple secrets & PII in a code snippet
test("Multiple secrets and PII are scrubbed cleanly", () => {
  const code = `
    const apiKey = "sk-proj-99887766554433221100aabb";
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const email = "developer@isro.gov.in";
    const db = "postgres://admin:supersecret@db.internal:5432/telemetry";
  `;
  const res = PromptScrubber.scrub(code);

  assert.ok(res.stats.secrets >= 3, "Should detect OpenAI, AWS, and DB secrets");
  assert.ok(res.stats.pii >= 1, "Should detect email");
  assert.ok(!res.cleanText.includes("supersecret"), "Database password must be scrubbed");
  assert.ok(!res.cleanText.includes("developer@isro.gov.in"), "Email must be scrubbed");
  assert.ok(res.cleanText.includes("[EMAIL_1]"));
});

// 3. Indian PII (Aadhaar & PAN)
test("Aadhaar and PAN are scrubbed from text", () => {
  const prompt = "Customer Aadhaar is 5412 8901 2345 and PAN is ABCDE1234F.";
  const res = PromptScrubber.scrub(prompt);

  assert.strictEqual(res.stats.pii, 2);
  assert.ok(res.cleanText.includes("[AADHAAR_NUMBER_1]"));
  assert.ok(res.cleanText.includes("[PAN_NUMBER_1]"));
  assert.ok(!res.cleanText.includes("5412 8901 2345"));
  assert.ok(!res.cleanText.includes("ABCDE1234F"));
});

// 4. Reverse Unmasking
test("Unmask restores original values into LLM response", () => {
  const prompt = "how do I pass sk-46dfghjkooijhwgwvdsaiuhjbwesdvichds to my client?";
  const scrubbed = PromptScrubber.scrub(prompt);

  const mockLlmResponse = "Initialize the client using Client(api_key=\"[OPENAI_API_KEY_1]\").";
  const restored = PromptScrubber.unmask(mockLlmResponse, scrubbed.tokenMap);

  assert.strictEqual(
    restored,
    "Initialize the client using Client(api_key=\"sk-46dfghjkooijhwgwvdsaiuhjbwesdvichds\")."
  );
});

console.log(`\nAll ${passed} PromptScrubber tests passed.\n`);

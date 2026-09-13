/**
 * test-mcp-server.js — Unit & Integration tests for VisionVault MCP Server
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { handleToolCall, TOOLS } = require("../server/mcp-server.js");

console.log("Running VisionVault MCP Server Test Suite...\n");

// ── Test 1: Tools Declaration ────────────────────────────────────────────────
console.log("Test 1: MCP Tools declaration");
assert(Array.isArray(TOOLS), "TOOLS should be an array");
const toolNames = TOOLS.map(t => t.name);
assert(toolNames.includes("sanitize_prompt"), "Should have sanitize_prompt tool");
assert(toolNames.includes("unmask_response"), "Should have unmask_response tool");
assert(toolNames.includes("sanitize_file"), "Should have sanitize_file tool");
assert(toolNames.includes("check_status"), "Should have check_status tool");
console.log("✓ Tools declaration verified (" + toolNames.join(", ") + ")\n");

// ── Test 2: sanitize_prompt Tool Call ────────────────────────────────────────
console.log("Test 2: sanitize_prompt tool call");
const samplePrompt = "Here is my key: sk-proj-1234567890abcdef1234567890abcdef and my email test@example.com";
const scrubRes = handleToolCall("sanitize_prompt", { text: samplePrompt });
assert(!scrubRes.isError, "Should not return error");
const scrubData = JSON.parse(scrubRes.content[0].text);
assert.strictEqual(scrubData.status, "success");
assert.strictEqual(scrubData.detected_count, 2, "Should detect 2 items");
assert(scrubData.sanitized_text.includes("[OPENAI_API_KEY_1]"), "Should contain OpenAI token");
assert(scrubData.sanitized_text.includes("[EMAIL_1]"), "Should contain Email token");
assert(!scrubData.sanitized_text.includes("sk-proj-1234567890abcdef1234567890abcdef"), "Key must not be in sanitized text");
console.log("✓ sanitize_prompt successfully scrubbed prompt text\n");

// ── Test 3: unmask_response Tool Call ────────────────────────────────────────
console.log("Test 3: unmask_response tool call");
const maskedOutput = "I updated the client config with your key: [OPENAI_API_KEY_1]";
const unmaskRes = handleToolCall("unmask_response", {
  text: maskedOutput,
  tokenMap: scrubData.token_map
});
assert(!unmaskRes.isError, "Should not return error");
const unmaskData = JSON.parse(unmaskRes.content[0].text);
assert.strictEqual(unmaskData.status, "success");
assert(unmaskData.restored_text.includes("sk-proj-1234567890abcdef1234567890abcdef"), "Key should be restored");
console.log("✓ unmask_response successfully restored original credentials\n");

// ── Test 4: sanitize_file Tool Call ──────────────────────────────────────────
console.log("Test 4: sanitize_file tool call");
const tmpFilePath = path.join(__dirname, "test-secret-config.env");
fs.writeFileSync(tmpFilePath, "AWS_KEY=AKIAIOSFODNN7EXAMPLE\nSECRET=some_secret_value\nEMAIL=dev@corp.internal");

try {
  const fileRes = handleToolCall("sanitize_file", { path: tmpFilePath });
  assert(!fileRes.isError, "File scrub should not error");
  const fileData = JSON.parse(fileRes.content[0].text);
  assert.strictEqual(fileData.status, "success");
  assert(fileData.sanitized_content.includes("[AWS_ACCESS_KEY_1]"), "Should sanitize AWS key");
  assert(!fileData.sanitized_content.includes("AKIAIOSFODNN7EXAMPLE"), "Raw AWS key should be removed");
  console.log("✓ sanitize_file successfully protected file contents\n");
} finally {
  if (fs.existsSync(tmpFilePath)) {
    fs.unlinkSync(tmpFilePath);
  }
}

// ── Test 5: check_status Tool Call ───────────────────────────────────────────
console.log("Test 5: check_status tool call");
const statusRes = handleToolCall("check_status", {});
assert(!statusRes.isError, "Status check should not error");
const statusData = JSON.parse(statusRes.content[0].text);
assert.strictEqual(statusData.status, "active");
assert(statusData.supported_detectors.length > 10, "Should list supported detectors");
console.log("✓ check_status returned active status with " + statusData.supported_detectors.length + " detectors\n");

// ── Test 6: End-to-End JSON-RPC 2.0 stdio Subprocess ─────────────────────────
console.log("Test 6: End-to-End JSON-RPC 2.0 stdio subprocess");

const serverScript = path.join(__dirname, "../server/mcp-server.js");
const child = spawn("node", [serverScript], { stdio: ["pipe", "pipe", "inherit"] });

let stdoutBuffer = "";

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
});

const req1 = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05" }
}) + "\n";

const req2 = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {}
}) + "\n";

const req3 = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "sanitize_prompt",
    arguments: {
      text: "export ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890abcdef1234567890"
    }
  }
}) + "\n";

child.stdin.write(req1);
child.stdin.write(req2);
child.stdin.write(req3);

setTimeout(() => {
  child.kill();

  const lines = stdoutBuffer.trim().split("\n").filter(Boolean);
  assert(lines.length >= 3, `Expected at least 3 JSON-RPC responses, got ${lines.length}`);

  const resp1 = JSON.parse(lines[0]);
  assert.strictEqual(resp1.id, 1);
  assert.strictEqual(resp1.result.serverInfo.name, "visionvault-mcp");

  const resp2 = JSON.parse(lines[1]);
  assert.strictEqual(resp2.id, 2);
  assert(Array.isArray(resp2.result.tools));

  const resp3 = JSON.parse(lines[2]);
  assert.strictEqual(resp3.id, 3);
  const toolContent = JSON.parse(resp3.result.content[0].text);
  assert(toolContent.sanitized_text.includes("[ANTHROPIC_API_KEY_1]"));
  assert(!toolContent.sanitized_text.includes("sk-ant-api03-abcdef1234567890abcdef1234567890"));

  console.log("✓ End-to-End JSON-RPC stdio handshake & tool execution passed!\n");
  console.log("🎉 ALL MCP SERVER TESTS PASSED PERFECTLY!\n");
}, 500);

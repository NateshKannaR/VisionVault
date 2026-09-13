#!/usr/bin/env node
/**
 * mcp-server.js — VisionVault MCP Server for IDEs
 *
 * Model Context Protocol (MCP) server providing zero-trust local prompt, secret,
 * and PII scrubbing for Cursor IDE, Windsurf, and Claude Desktop.
 *
 * Runs 100% on-device via stdio JSON-RPC 2.0 with zero external dependencies.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Load core PromptScrubber
const PromptScrubber = require("../extension/prompt-scrubber.js");

const SERVER_NAME = "visionvault-mcp";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

// Session stats
let totalSanitizedCount = 0;
let totalFilesSanitized = 0;

// Supported MCP Tools
const TOOLS = [
  {
    name: "sanitize_prompt",
    description: "Detects and redacts API keys (OpenAI, Anthropic, AWS, GitHub, etc.), database connection strings, and PII from prompts or code before sending to an LLM. Returns sanitized text with safe tokens and the token map.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The prompt or source code snippet to sanitize"
        }
      },
      required: ["text"]
    }
  },
  {
    name: "unmask_response",
    description: "Replaces tokens (e.g. [OPENAI_API_KEY_1]) in LLM responses back with their original real values using the token map.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "LLM output text containing masked tokens"
        },
        tokenMap: {
          type: "object",
          description: "Key-value dictionary mapping tokens to original values returned by sanitize_prompt"
        }
      },
      required: ["text", "tokenMap"]
    }
  },
  {
    name: "sanitize_file",
    description: "Reads a local file, scrubs all sensitive credentials, keys, and PII, and returns safe sanitized content suitable for IDE context windows.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to sanitize"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "check_status",
    description: "Checks VisionVault Shield engine status, supported secret detectors, and session redaction statistics.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

function handleToolCall(name, args) {
  switch (name) {
    case "sanitize_prompt": {
      const text = args?.text || "";
      const result = PromptScrubber.scrub(text);
      totalSanitizedCount += result.matches.length;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                sanitized_text: result.sanitized,
                detected_count: result.matches.length,
                detected_secrets: result.matches.map(m => ({
                  type: m.type,
                  label: m.label,
                  token: m.token
                })),
                token_map: result.tokenMap,
                message: result.matches.length > 0
                  ? `Redacted ${result.matches.length} sensitive secret(s)/PII entry.`
                  : "No secrets or PII detected. Prompt is clean."
              },
              null,
              2
            )
          }
        ],
        isError: false
      };
    }

    case "unmask_response": {
      const text = args?.text || "";
      const tokenMap = args?.tokenMap || {};
      const restored = PromptScrubber.unmask(text, tokenMap);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                restored_text: restored,
                tokens_count: Object.keys(tokenMap).length
              },
              null,
              2
            )
          }
        ],
        isError: false
      };
    }

    case "sanitize_file": {
      const targetPath = args?.path;
      if (!targetPath) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Missing required argument 'path'" }) }],
          isError: true
        };
      }

      const resolved = path.resolve(process.cwd(), targetPath);
      if (!fs.existsSync(resolved)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `File not found: ${resolved}` }) }],
          isError: true
        };
      }

      try {
        const rawContent = fs.readFileSync(resolved, "utf8");
        const result = PromptScrubber.scrub(rawContent);
        totalFilesSanitized++;
        totalSanitizedCount += result.matches.length;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  file_path: resolved,
                  sanitized_content: result.sanitized,
                  detected_count: result.matches.length,
                  detected_secrets: result.matches.map(m => ({
                    type: m.type,
                    label: m.label,
                    token: m.token
                  })),
                  token_map: result.tokenMap
                },
                null,
                2
              )
            }
          ],
          isError: false
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Failed to read file: ${err.message}` }) }],
          isError: true
        };
      }
    }

    case "check_status": {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                engine: "VisionVault Zero-Trust Local Scrubber",
                version: SERVER_VERSION,
                status: "active",
                mode: "100% on-device volatile RAM",
                session_stats: {
                  total_redactions: totalSanitizedCount,
                  files_sanitized: totalFilesSanitized
                },
                supported_detectors: [
                  "OpenAI API Keys (sk-...)",
                  "Anthropic API Keys (sk-ant-...)",
                  "AWS Access & Secret Keys (AKIA...)",
                  "GitHub Personal Access Tokens",
                  "Google Cloud API Keys",
                  "Slack Bot & User Tokens",
                  "HuggingFace User Tokens",
                  "Database Connection Strings (postgres, mongodb, mysql, redis)",
                  "Private Keys (RSA, EC, PKCS8)",
                  "Email Addresses",
                  "Payment Card Numbers",
                  "Aadhaar Numbers (UIDAI)",
                  "PAN Cards",
                  "Indian IFSC & Bank Accounts",
                  "UPI IDs",
                  "US Social Security Numbers (SSN)",
                  "Passports & Driving Licenses"
                ]
              },
              null,
              2
            )
          }
        ],
        isError: false
      };
    }

    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true
      };
  }
}

// ── JSON-RPC 2.0 stdio Server ────────────────────────────────────────────────
function sendResponse(id, result, error = null) {
  const response = {
    jsonrpc: "2.0",
    id: id !== undefined ? id : null
  };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  process.stdout.write(JSON.stringify(response) + "\n");
}

function processMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      });
      break;

    case "notifications/initialized":
    case "initialized":
      // Client notification confirming initialization
      break;

    case "ping":
      sendResponse(id, {});
      break;

    case "tools/list":
      sendResponse(id, {
        tools: TOOLS
      });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments;
      if (!toolName) {
        sendResponse(id, null, { code: -32602, message: "Missing tool name in params" });
        return;
      }
      const toolResult = handleToolCall(toolName, toolArgs);
      sendResponse(id, toolResult);
      break;
    }

    default:
      if (id !== undefined && id !== null) {
        sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
      }
      break;
  }
}

function start() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      processMessage(msg);
    } catch (e) {
      sendResponse(null, null, { code: -32700, message: `Parse error: ${e.message}` });
    }
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

if (require.main === module) {
  start();
}

module.exports = {
  TOOLS,
  handleToolCall,
  processMessage
};

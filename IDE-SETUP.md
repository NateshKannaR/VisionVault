# 🛡️ VisionVault: In-Page Chat Shield & IDE MCP Server Guide

VisionVault protects sensitive credentials, cloud secrets, and personally identifiable information (PII) with **100% on-device, zero-trust local in-memory scrubbing**.

No keys, passwords, prompt text, or sanitized screens are ever transmitted over the network or stored in plaintext logs.

---

## 1. 🌐 Browser In-Page Chat Shield (ChatGPT, Claude, Gemini)

VisionVault injects an active shield badge directly into popular AI chat interfaces:
- **ChatGPT** (`chatgpt.com`, `chat.openai.com`) — Injected into the prompt toolbar right beside the `Think`, dictate, and action buttons.
- **Claude** (`claude.ai`) — Mounted in the composer footer next to the send button.
- **Google Gemini** (`gemini.google.com`) — Embedded directly in the prompt input container.

### How It Works:
1. **Real-Time Paste Interception**:
   Whenever you paste code or text into ChatGPT, Claude, or Gemini, VisionVault's content script intercepts the paste event before it reaches the webpage or LLM server.
2. **Instant Local Redaction**:
   Any detected API keys (`sk-...`, `sk-ant-...`, `AKIA...`, GitHub tokens, DB connection URIs) or PII (emails, phone numbers, PAN, Aadhaar, SSN, credit cards) are immediately replaced with safe deterministic tokens (e.g. `[OPENAI_API_KEY_1]`).
3. **On-Screen Toast Notification**:
   A sleek toast alert pops up confirming the redaction:
   ```
   🛡️ VisionVault: Auto-redacted 2 secret(s) [OPENAI_API_KEY_1, EMAIL_1]
   ```
4. **Interactive Shield Badge & Popover**:
   Click the shield icon next to the chatbox to view:
   - Active protection status (**100% RAM Isolated**)
   - Session redactions counter
   - **"Scrub Current Input Box"** button to scrub text you've typed manually.

---

## 2. 💻 Model Context Protocol (MCP) Server for IDEs

VisionVault includes a standalone, zero-dependency **Model Context Protocol (MCP)** server operating via standard input/output (stdio JSON-RPC 2.0).

This allows your IDE (Cursor, Windsurf, Claude Desktop) to invoke VisionVault's local secret-sanitizing tools before including files or code snippets into LLM context windows.

### Supported IDEs:
- **Cursor IDE**
- **Windsurf IDE (Codeium)**
- **Claude Desktop**
- Any MCP-compliant client

---

## 3. ⚙️ Configuration Instructions

### A. Cursor IDE Configuration

#### Method 1: Via Cursor Settings UI
1. Open Cursor and navigate to **Settings** (`Ctrl+,` or `Cmd+,`).
2. Go to **Features** → **MCP**.
3. Click **Add New MCP Server**.
4. Fill in:
   - **Name**: `visionvault`
   - **Type**: `command`
   - **Command**: `node /absolute/path/to/vision-agent/server/mcp-server.js`
5. Save. The green indicator will show **Connected**.

#### Method 2: Via `mcp.json` Configuration File
Edit your Cursor MCP configuration file:
- **Linux**: `~/.cursor/mcp.json`
- **macOS**: `~/Library/Application Support/Cursor/mcp.json`
- **Windows**: `%APPDATA%\Cursor\mcp.json`

Add the following entry:
```json
{
  "mcpServers": {
    "visionvault": {
      "command": "node",
      "args": ["/home/natesh/Downloads/vision-agent/server/mcp-server.js"]
    }
  }
}
```

---

### B. Windsurf IDE Configuration

Edit your Windsurf MCP configuration:
- **Linux/macOS**: `~/.codeium/windsurf/mcp_config.json`
- **Windows**: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

```json
{
  "mcpServers": {
    "visionvault": {
      "command": "node",
      "args": ["/home/natesh/Downloads/vision-agent/server/mcp-server.js"]
    }
  }
}
```

---

### C. Claude Desktop Configuration

Edit your Claude Desktop configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "visionvault": {
      "command": "node",
      "args": ["/home/natesh/Downloads/vision-agent/server/mcp-server.js"]
    }
  }
}
```

---

## 4. 🛠️ Available MCP Tools

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `sanitize_prompt` | `text: string` | Scans and redacts all cloud keys, tokens, and PII from prompt text or code. Returns sanitized text, tokens count, and token mapping. |
| `unmask_response` | `text: string`, `tokenMap: object` | Restores original values into LLM outputs locally on your machine. |
| `sanitize_file` | `path: string` | Reads a local file from disk and scrubs all credentials, producing a safe version for context inclusion. |
| `check_status` | *(none)* | Returns shield status, memory isolation mode, and supported pattern detectors. |

---

## 5. 🔍 Supported Secret & PII Detectors

- **AI & Cloud Providers**:
  - OpenAI API Keys (`sk-...`, `sk-proj-...`)
  - Anthropic API Keys (`sk-ant-...`)
  - AWS Access Keys (`AKIA...`) & Secret Access Keys
  - GitHub Tokens (`ghp_...`, `github_pat_...`)
  - Google Cloud & Gemini API Keys (`AIza...`)
  - Slack User & Bot Tokens (`xoxb-...`, `xoxp-...`)
  - HuggingFace Tokens (`hf_...`)
- **Infrastructure & Credentials**:
  - Database Connection Strings (`postgres://`, `mongodb://`, `mysql://`, `redis://`)
  - Private Keys (`-----BEGIN RSA PRIVATE KEY-----`)
  - Generic Bearer / Auth tokens
- **Personal Identifiable Information (PII)**:
  - Email addresses
  - Payment Cards (Visa, Mastercard, Amex)
  - Indian Aadhaar (UIDAI with Verhoeff validation)
  - Indian PAN Cards
  - Indian IFSC & Bank Account numbers
  - UPI IDs (`username@okhdfcbank`, etc.)
  - US Social Security Numbers (SSN)
  - Passports & Driving Licenses

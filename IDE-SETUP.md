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
1. **Real-Time Live Typing Radar & Safety Ribbon**:
   As you type into ChatGPT, VisionVault scans your draft in-memory with debounced zero-latency analysis. If secrets or PII are detected, the shield badge turns into a pulsing threat alert (`⚠️ 2 Secrets`), an alert glow outlines the prompt box, and an inline safety banner appears:
   ```
   ⚠️ VISIONVAULT RADAR: Unmasked in draft: [OPENAI_API_KEY, EMAIL] · [🛡️ Scrub Now (Ctrl+Shift+S)]
   ```
2. **Instant Local Redaction & Shortcut (`Ctrl+Shift+S`)**:
   Pressing `Ctrl+Shift+S` (or `Cmd+Shift+S`) or pasting text instantly scrubs detected API keys (`sk-...`, `sk-ant-...`, Stripe, AWS, GitHub PATs, JWTs, SSH private keys, DB connection strings, passwords, `.env` pairs) and PII (emails, phones, PAN, Aadhaar, SSN, IBAN, CVV) into safe typed tokens (e.g. `[OPENAI_API_KEY_1]`).
3. **Auto De-Scrub & Live Unmask for Assistant Responses**:
   When ChatGPT answers with code containing your tokens, VisionVault's streaming observer automatically restores the original values locally with a subtle green badge (`sk-... [Restored locally]`). When you click ChatGPT's **"Copy code"** button, the copied clipboard snippet automatically contains the restored, executable credentials!
4. **Zero-Trust File & `.env` Interception**:
   Dropping or attaching `.env`, `.env.local`, `.yaml`, `.sql`, code, or PDF documents instantly scrubs all credential lines in memory before the file reaches ChatGPT.
5. **Interactive Shield Badge & Glassmorphism Popover**:
   Click the shield icon next to the chatbox to:
   - Toggle **⚡ Auto De-Scrub Responses** On/Off.
   - View **Session Redacted Secrets** & 0.0ms network latency.
   - 1-Click **"Copy Scrubbed"** or **"Unmask All Chat"**.
   - Manage protected session tokens with hover-peek lens.

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

# Privacy-Preserving Vision Agent — Complete Prototype

A browser extension + server that automates on-screen tasks using a cloud/server
AI model, while guaranteeing:
1. Sensitive screen regions (passwords, cards, emails, phones, faces/media) are
   **redacted locally before any network call**.
2. Arbitrary page text is never sent — only a small whitelist of generic UI
   words (e.g. "submit", "cancel") can travel as a label.
3. Personal data (name, email, phone, address) is stored in a **local vault**
   and substituted into forms **entirely on-device** — the server only ever
   requests a field *type* (e.g. `"use_vault_field": "email"`), never a value.
4. Any `click` action requires **explicit user confirmation** before it runs.

## Project structure

```
extension/
  manifest.json     MV3 config
  content.js         DOM PII scan, whitelist-safe labeling, Set-of-Mark tagging, action execution
  background.js       Two-phase orchestrator + local vault resolution
  popup.html/js       UI: Vault tab + Run Agent tab (scan -> preview -> send -> confirm)

server/
  main.py              FastAPI /plan-action endpoint (mock planner + VLM stub)
  requirements.txt

demo-page.html         A sample signup form to demo redaction + auto-fill on
```

## Full pipeline (what actually happens, step by step)

1. **Vault tab**: user saves name/email/phone/address once — stored via
   `chrome.storage.local`, never leaves the browser directly.
2. **Run Agent tab**: user types a task and clicks **"1. Scan & Redact"**.
   - `content.js` scans the DOM for sensitive fields/text and tags every
     interactive element with a numbered mark (local-only map).
   - `background.js` screenshots the visible tab and blacks out every PII
     region on an `OffscreenCanvas` — before anything is sent anywhere.
   - The **redacted image is shown in the popup** as a privacy preview.
     Nothing has been transmitted yet at this point.
3. User reviews the preview, clicks **"2. Send Redacted Data to AI"**.
   - Only the redacted image + `{id, role, box, label}` marks (label is
     `null` unless whitelisted) + the task text are POSTed to the server.
4. **Server** (`main.py`) reasons over this sanitized payload and returns an
   action:
   - `type` actions include either a literal `value` (only for generic,
     non-personal content the agent composes itself) **or** a
     `use_vault_field` key like `"email"`.
   - `click` actions never auto-execute.
5. **background.js**:
   - For `type` + `use_vault_field`: looks up the real value from the local
     vault and fills it in immediately — the real value never touched the
     network.
   - For `click`: shows a confirm/reject prompt in the popup. Only executes
     after the user clicks **Confirm**.
6. Live stats (PII regions redacted, marks found, per-stage latency) are
   shown in the popup throughout — this maps directly to the evaluation
   metrics (accuracy, PII precision/recall, redaction precision, latency).

## Running it

**Server:**
```bash
cd server
pip install -r requirements.txt
python main.py
# -> http://localhost:8000
```

**Extension:**
1. `chrome://extensions` -> enable Developer mode -> "Load unpacked" -> select `extension/`
2. Open `demo-page.html` in a tab (or any real form online)
3. Click the extension icon
4. Go to **My Vault**, fill in sample name/email/phone/address, Save
5. Go to **Run Agent**, type a task like "fill this signup form", click
   **1. Scan & Redact** — see the redacted preview and stats
6. Click **2. Send Redacted Data to AI** — watch it fill the email/phone/name
   field from your local vault
7. Run it again until a submit button is proposed — you'll see the
   **Confirm/Reject** prompt before anything is clicked

## Demo script for your teachers (suggested order)

1. Show the **Vault tab** first — "this is the only place your real data lives."
2. Show **Scan & Redact** on the demo page — point at the preview image:
   password box, email/phone text, and the support-contact line are all
   blacked out. "This is what leaves the device. Nothing more."
3. Open the server terminal window so they can see the `[server audit]` log
   line — proof the server never received real values, just counts/sizes.
4. Click **Send to AI** — show the field getting auto-filled, and explain the
   value came from the local vault, not from the server's response.
5. Trigger a click action — show the **Confirm/Reject** box — "the agent
   proposes, the user disposes."
6. Point at the stats panel — tie it back to the 5 evaluation metrics from
   the problem statement.

## Extension points (for your "future work" slide)

| Piece | Current prototype | Full upgrade |
|---|---|---|
| PII detection | DOM/regex heuristics | Add OCR (Tesseract.js) + PII/NER model (Piiranha) + face detection (BlazeFace via Transformers.js, WebGPU) for true pixel-level detection |
| Redaction | Black-box rectangles | Add blur mode; semantic masking (`[REDACTED_EMAIL]` overlay text) |
| Server planner | `mock_plan` (deterministic) | Implement `vlm_plan`: self-hosted Qwen2.5-VL / UI-TARS via Ollama/vLLM, or a cloud API for the demo |
| Vault | 4 plain fields in `chrome.storage.local` | Encrypt at rest; add more field types; per-site scoping |
| Metrics | Live counts + timings in popup | Formal test set with labeled PII boxes -> precision/recall/IoU report |

## Why this is different from existing browser agents

Tools like Browser-Use, Skyvern, and UI-TARS-based agents send the **full raw
screen** to a cloud model. This prototype adds the missing privacy layer:
local detection, local redaction, local vault-based data filling, and
local-only element resolution — the cloud model only ever plans in the
abstract, and never sees or knows real personal data.
# VisionVault
# VisionVault
# VisionVault
# VisionVault
# VisionVault
# VisionVault

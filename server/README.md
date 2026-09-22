# VisionVault planning server

A small FastAPI service that turns a **sanitized** view of the user's screen into one browser
action at a time. It is deliberately the least-trusted component in the system: it never sees
personal data, and it cannot ask for any.

## The contract

**Receives** (`POST /api/agent/step`):

```jsonc
{
  "task": "Fill the signup form with my details",
  "redactedImage": "data:image/png;base64,...",   // already redacted, on the client
  "marks": [                                       // Set-of-Marks: what is clickable/typeable
    { "id": 4148216, "role": "input:email", "label": "email address",
      "box": { "x": 45, "y": 222, "w": 858, "h": 38 } }
  ],
  "filled_mark_ids": [4148216],
  "step": 3,
  "page_info": { "title": "...", "url": "https://host/path", "viewport_width": 1200, ... }
}
```

Note what is *absent*: no page text, no input values, no query string, no fragment. `label` is
a field's own name ("email address"), never its contents — the client's `safeLabel()` refuses
to use an input's `value` and drops any candidate matching a PII pattern.

**Returns** exactly one action:

```jsonc
{
  "reasoning": "Fill the email field from the local vault",
  "action": { "type": "type", "target": 5615249, "use_vault_field": "email", "value": null }
}
```

For anything personal the server sets `use_vault_field` and leaves `value` null. It names the
*kind* of data; the client resolves the actual value from `chrome.storage.local` on-device.
Valid keys: `name`, `username`, `email`, `phone`, `address`, `company`, `about`, `password`.

Action types: `click`, `type`, `press_key`, `select`, `scroll_page`, `scroll`, `clear`,
`hover`, `focus`, `wait`, `navigate`, `open_tab`, `done`. The client stops the loop immediately
on `done`.

## Planning chain

The actual runtime chain is a strict fallback order:

1. **Google Gemini** — active when `GEMINI_API_KEY` is configured.
2. **Groq** — used next when available.
3. **Ollama** — optional local VLM route when `OLLAMA_HOST` is active.
4. **Deterministic rule-based planner** — always available, no network, no key.

This is intentionally resilient: a quota issue, key issue, or unreachable hosted service does not
break the loop. The local extension always keeps the real personal data on-device and only sends
symbolic targets and a redacted view upstream.

`GET /health` reports the live chain:

```json
{"status":"ok","backend":"gemini","chain":["gemini","groq","ollama","mock"]}
```

The server is intentionally model-agnostic. Hosted providers can be swapped in or out without
changing the client-side contract, and the request layout remains compatible with local or remote
open-weight VLMs.

## Running

```bash
cd server
pip install -r requirements.txt
cp .env.example .env  # optional, only if you want to add API keys
python main.py         # http://127.0.0.1:8000
```

Common environment variables:

| Variable | Meaning |
| :--- | :--- |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | tier 1 |
| `GROQ_API_KEY` / `GROQ_MODEL` | tier 2 |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | optional local tier |
| `PORT` | listen port, default 8000 |

## Testing it

```bash
python eval/test-server-contract.py
```

This exercises the HTTP endpoint and checks the server-side portion of the privacy contract:
well-formed responses, valid mark ids, no invented personal values, graceful missing-image
handling, and clean termination semantics.

It does **not** test detection or redaction — those are client-side and are measured by
`node eval/run-full-eval.js` against a live Chrome session.

## Logs

Requests and responses are appended to `server/logs/session.jsonl`. Only metadata is recorded —
task text, mark counts, step number, whether an image was present, and the origin+path of the
page. No image bytes and no personal values, because none are received.

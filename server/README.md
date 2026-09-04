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

Tried in order; each tier only if the previous is absent or fails:

1. **Google Gemini** — used when `GEMINI_API_KEY` is set.
2. **Groq** — used when `GROQ_API_KEY` is set.
3. **Deterministic rule-based planner** — always available, no network, no key.

There is no OpenAI tier and no Ollama tier. They are not implemented and not called; if you see
them mentioned anywhere, that documentation is stale.

`GET /health` reports the live chain:

```json
{"status":"ok","backend":"gemini","chain":["gemini","groq","mock"]}
```

Both hosted tiers are open-weight-friendly substitutes for a self-hosted VLM — the request shape
is an ordinary chat-completion with one image, so pointing tier 2 at a local vLLM or Ollama
deployment is a change of base URL, not of architecture.

## Running

```bash
pip install -r requirements.txt
cp .env.example .env     # add a key, or leave both blank to use the rule-based planner
python main.py           # http://127.0.0.1:8000
```

| Variable | Meaning |
| :--- | :--- |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | tier 1 |
| `GROQ_API_KEY` / `GROQ_MODEL` | tier 2 |
| `PORT` | listen port, default 8000 |

## Testing it

```bash
python eval/test-server-contract.py
```

Exercises this endpoint over real HTTP against whichever backend is configured, and checks the
half of the privacy contract the server is responsible for: replies are well-formed, target only
supplied mark ids, never contain an invented personal value, terminate with `done`, and tolerate
a request that carries no image (the client's fail-closed path sends none).

It does **not** test detection or redaction — those are client-side and are measured by
`node eval/run-full-eval.js` against a live Chrome session.

## Logs

Requests and responses are appended to `server/logs/session.jsonl`. Only metadata is recorded —
task text, mark counts, step number, whether an image was present, and the origin+path of the
page. No image bytes and no personal values, because none are received.

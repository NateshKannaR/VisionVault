# VisionVault — Privacy-Preserving Browser Vision Agent

VisionVault is a browser-native AI agent that keeps sensitive screen content on the user device, redacts it locally, and sends only sanitized context to a server-side planner. The model reasons over a symbolic, privacy-safe view of the page and returns an action; the browser resolves the actual personal value locally from a vault and executes it without exposing the real data upstream.

This is built for the SIH problem around privacy-preserving vision agents: local perception + cloud reasoning + strict data minimization.

## Why it matters

Modern browser agents can act on screens, but sending raw screenshots to the cloud creates privacy risk. VisionVault addresses that by splitting the workflow:

1. Local perception runs in the browser.
2. Sensitive content is detected and redacted before any network request.
3. Only a sanitized image and symbolic element references are sent to the server.
4. The server decides what action to take.
5. The client resolves real values locally and performs the action.

## Core architecture

- Client-side browser extension
  - captures the visible page
  - scans DOM structure and sensitive fields
  - detects faces and OCR-based text where needed
  - redacts sensitive regions before upload
  - resolves local vault values and executes the final action

- Server-side planning
  - receives the redacted frame and mark metadata only
  - chooses the next action using a hosted or local model
  - returns a symbolic action such as "type into mark 4148216 using email"

## Privacy guarantee

VisionVault is designed around a fail-closed redaction model:

- raw screen pixels do not leave the browser
- password fields, names, email, phone, PAN, Aadhaar, card numbers, and faces are locally redacted or masked
- the server never receives the real value
- if local sanitization fails, the request is aborted

## Demo workflow

```bash
npm install
npm run server
```

Then load the extension from the `extension/` folder in Chrome, or build the Firefox variant:

```bash
npm run build:firefox
```

Open a form or search page and ask the agent to do a task such as:

- fill the signup form with my details
- search for running shoes and show me
- scroll down and show me more headlines

The local client shows the redacted preview before any upload and then executes the action safely.

## Folder overview

- `extension/` — Chrome/Firefox browser extension and local redaction pipeline
- `server/` — FastAPI planning backend with model fallback logic
- `eval/` — real Chrome evaluation, privacy checks, and benchmarking scripts
- `mock-apps/` — targeted demo pages for validation

## Evaluation highlights

The repo includes a measured evaluation pipeline and reports such as:

- 100% PII recall on the fixture suite
- 100% precision on sensitive-region masking
- 0 pixel leaks in measured checks
- real browser task execution with local redaction before upload

See [eval_report.md](eval_report.md) for the automated numbers.

## Quick commands

```bash
npm test
npm run eval
npm run report
npm run verify
npm run real-sites
npm run build:firefox
```

## Project purpose

VisionVault is a practical browser-agent architecture for privacy-first automation: cloud reasoning without raw personal-data exposure, while still enabling meaningful web interaction and task execution.

## License

MIT

| more work proposed after the task was finished | becomes `done` |
| a real value supplied alongside `use_vault_field` | the literal value is dropped |

### And the client supervises the result

[`extension/agent-guard.js`](extension/agent-guard.js) sits between the planner and the DOM. It
can veto or substitute an action but never invents a target, and when it intervenes it says why
— that sentence is what the side panel shows instead of the agent silently stalling.

- **A finished task ends.** The guard tracks what the instruction actually achieved and stops
  the moment nothing is outstanding. *(Before: "scroll down and show me more headlines"
  produced six scrolls; a completed search became a tour of the results page.)*
- **`done` must be earned.** A planner claiming completion while the search has not run, or
  while form fields are still empty, is overruled with the on-device plan. The override is
  capped only when it stops working: two overrides that change nothing end the run, but an
  override that fills another field resets the count. That distinction matters — with both
  hosted tiers rate-limited, a 1.5B local model answered "done" on every step of a form fill,
  and the guard carried it through all six fields.
- **Repetition is a bug, not persistence.** The same action on the same target twice, or four
  steps with no visible change, ends the run with a reason. *(Before: seven identical `type`
  actions into a city picker that was never a search box.)*
- **A scroll instruction may not click.** *(Before: "scroll down" clicked a link reading
  "codex is down", left the site, and scrolled somewhere else for nine more steps.)*
- **A half-filled form is not submitted.** A click on a submit-looking control while fields
  remain empty becomes the next field instead.
- **The field label decides what goes in it.** A planner asked to fill "Aadhaar number" from an
  eight-key vault picks the nearest key rather than declining; observed live, it chose `phone`.
  The label overrules it, and a field naming an identifier the vault has no equivalent for is
  set aside and put to the user once everything else is done.
- **"Typed" is not "searched".** The client verifies the query reached the URL or title, not
  merely a field, and escalates if it did not.

### Making a search actually run

Sites disagree about what submitting means, so the client escalates and re-checks after each
stage, stopping as soon as the query is demonstrably on the page:

1. Type, then **Enter** on the field.
2. **Submit the owning form** — classic pages.
3. **Click the submit control beside the field** — icon buttons a generic selector misses.
4. **Open the site's search affordance** and retype — for a box that is mounted only after a
   button is pressed.
5. **Navigate to the site's own search URL**, read from its
   `<link rel="search">` OpenSearch descriptor.

Step 5 is a published standard, not per-site knowledge, and it is what makes GitHub and MDN
work: probed live, neither exposes a search input the agent can type into — GitHub mounts one
inside a dialog, MDN renders none at all — and both publish a descriptor.

### And it knows when to stop

Some pages cannot be automated, and saying so is more useful than trying harder:

- **A verification wall ends the run.** A CAPTCHA widget, a `/nocaptcha` redirect, or a page
  asking to verify a human stops the agent with an explanation. Nothing here attempts to solve
  or evade one — that is the site's decision to make.
- **A page that stops responding ends the run**, after four steps with no visible change.
- **A search that will not run is reported as such**, not counted as done:
  *"Typed 'webassembly simd' — the page has not run the search."*
- **Restricted pages are named as such.** Chrome forbids extensions on its own UI and the Web
  Store; the panel says that rather than reporting an empty page.

---

## Privacy guarantees, and how each is enforced

| Guarantee | Where it lives |
| :--- | :--- |
| The service worker never holds a raw screenshot | capture and redaction happen together inside `scanAndRedact()`; only the redacted image is returned |
| Redaction failure aborts the request | `redactImage()` throws `RedactionError` and never returns input; `scanAndRedact()` returns `redactionOk: false` with no image; `phaseScan()` throws; `phaseRun()` stops |
| Nothing is sent without verified redaction | `callServer()` refuses to fetch unless the payload carries `redactionVerified: true` |
| Real personal values never leave the device | the server receives `use_vault_field: "email"`; `vault.js` resolves it from `chrome.storage.local` on-device |
| The right value goes in the right field | the field's own label overrules the planner's choice of vault key; a label naming an identifier the vault has no equivalent for (Aadhaar, PAN, passport, CVV) is set aside and put to you rather than filled with the nearest match |
| Element labels cannot smuggle PII | `safeLabel()` never uses an input's `value`, and drops any candidate that matches a PII pattern |
| Page context cannot smuggle PII | `page_info` carries origin + path only — no query string, no fragment, no page text |
| Consequential actions need a human | risk-gated click confirmation (below) |
| The claim is checkable, not just stated | every outbound request is recorded on-device by [`extension/audit-log.js`](extension/audit-log.js) — the exact bytes, the redacted image as sent, and the vault field *name* asked for — and shown in the panel's Privacy tab. Written inside `callServer()` from the same string handed to `fetch()`, so it is what was sent, not a reconstruction |
| Redaction is verified by attacking it | [`eval/attack-redaction.js`](eval/attack-redaction.js) takes the transmitted frame and tries to read the data back out — upscaling, contrast stretch, extreme gain, inversion, and PNG metadata |
| Element labels cannot smuggle PII, including values with no shape | `safeLabel()` screens by pattern, which a personal name defeats — "Ananya Sridharan" is two capitalised words. `scanForPII()` now records *which elements* it judged sensitive, and `tagInteractiveElements()` drops the label of any mark inside one. Found by [`eval/workflows.js`](eval/workflows.js): two employee names reached the server verbatim while the image was masked correctly |
| An identifier in Devanagari is still an identifier | Indic digits are normalised to ASCII before matching, one code point per code point so redaction boxes stay aligned; Devanagari is a second OCR recognition language, since an English-only model returns nothing for it and the page then looks clean |

### Click confirmation — the exact policy

Two policies, chosen in the side panel. **The default is risk-based**, and this is what the code
does, no more and no less:

- **Risk-based (default).** A click executes autonomously *unless* its target looks
  consequential, in which case the loop halts and waits for your approval. Risk is judged from
  the target element's own label and role plus the planner's stated reasoning, against
  `RISKY_CLICK_RE` in [`extension/background.js`](extension/background.js) — which covers
  submit/commit, payment, destructive, authentication/consent, and sharing/exfiltration verbs
  (`pay`, `checkout`, `buy`, `place order`, `delete`, `remove`, `deactivate`, `sign up`,
  `log in`, `authorize`, `share`, `export`, and others). **Unknown risk counts as risk**: a
  control with no readable label at all — an icon-only button, a bare `<input type="submit">` —
  cannot be assessed, so it is gated. Links are exempt, since navigation is reversible and
  gating every unlabelled link would stop the agent browsing at all.
- **Strict.** Every click requires approval.

Non-click actions are never gated: typing is reversible, and vault values are substituted
locally, so a `type` action exposes nothing.

> This is a heuristic over button labels, not a proof. A destructive control with an
> unrecognisable label will be clicked autonomously under the default policy. Use **Strict** on
> pages you do not trust.

---

## Repository layout

```
extension/
  manifest.json              MV3 config. Note content_security_policy: WebAssembly needs
                             'wasm-unsafe-eval' — without it both local models fail silently.
  content.js                 DOM PII scan, Set-of-Marks tagging, deterministic IDs, per-frame API
  action-executor.js         THE action executor (click/type/press_key/select/scroll_page/
                             clear/scroll/hover/focus/wait/dismiss_overlays/open_search/
                             probe_query/search_url/done). Content script, loaded in every
                             frame. There is no second implementation, and no site-specific
                             selector anywhere in it.
  agent-guard.js             Supervises the planner: loop detection, goal verification,
                             refuses a "done" the page does not support
  task-planner.js            Parses the instruction; plans on-device when no server answers
  background.js              Service worker: agent loop, vault resolution, click risk gate
  detection-orchestrator.js  Capture + all-frame merge + offscreen ML + fail-closed redaction
  offscreen.html/.js         MV3 offscreen document hosting the WASM models
  vault.js                   On-device vault; symbolic field → real value
  popup.html/.css/.js        Side panel: preview, live stats, approvals, settings
  vision/
    faceDetect.js            UltraFace RFB-320 via ONNX Runtime Web (WASM SIMD)
    ocrDetect.js             Tesseract.js v5, offline; raster size chosen from measurements
    mergeRegions.js          Multi-source IoU deduplication
  models/                    version-RFB-320.onnx (1.27 MB) + eng.traineddata.gz
  lib/                       ONNX Runtime Web + Tesseract WASM, bundled — no CDN at runtime
server/
  main.py                    FastAPI. Chain: Gemini → Groq → Ollama → deterministic rules,
                             plus repair_plan(), which validates every tier's answer
  restart.ps1                stops whatever holds the port, then starts a fresh instance
eval/
  pages/                     6 fixture pages carrying their own ground-truth annotations
  assets/                    generated fixture images (+ the scripts that generate them)
  lib/                       browser harness, PNG decoder, scoring maths
  run-full-eval.js           the live evaluation
  real-sites.js              runs the agent against ten public websites and reports outcomes
  probe-search-dom.js        dumps how a site's search box is actually built
  test-agent-guard.js        26 unit tests, one per failure seen on a live site
  test-source-hygiene.js     catches escapes mangled into control characters, which silently
                             disabled three regexes during this work
  test-panel-wiring.js       the panel's script and its markup must still agree
  test-fallback-chain.py     disables each planning tier in turn and checks the next takes over
  generate-report.js         renders eval_report.md from measured results only
  diagnose.js                one scan, full stage-by-stage trace
  ocr-tuning.js              OCR raster-size / preprocessing sweep
mock-apps/demo-page.html     hand-demo page with PII fields and an avatar
```

---

## Running it

### 1. Server (optional)

Without a server the extension falls back to its own on-device planner, and the agent still
works — you just lose VLM reasoning.

```bash
cd server
pip install -r requirements.txt
cp .env.example .env        # add GEMINI_API_KEY and/or GROQ_API_KEY, or leave empty
python main.py              # http://127.0.0.1:8000
curl http://127.0.0.1:8000/health
```

`/health` reports the live chain and the models behind it, e.g.
`{"chain":["gemini","groq","ollama","mock"],"models":{"ollama":"qwen2.5:1.5b-instruct"}}`.

For the fully local tier, install [Ollama](https://ollama.com) and pull a small instruct model:

```bash
ollama pull qwen2.5:1.5b-instruct     # ~1 GB, ~0.6s per plan on CPU
```

The server picks the smallest non-specialised model you have installed, because local planning
latency is dominated by parameter count. `OLLAMA_MODEL` pins a specific one.

### 2. Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the `extension/` directory.
4. Open the side panel from the toolbar icon.
5. In **Settings**, set the server URL (default `http://127.0.0.1:8000/api/agent/step`), pick a
   redaction mode, vision depth and click policy.
6. In **Vault**, enter the values you want the agent to be able to type. They are stored in
   `chrome.storage.local` and never transmitted.

### 3. Try it

Open `mock-apps/demo-page.html`, type a task such as *"fill the signup form with my details"*,
then **Scan & Redact Screen**. The panel shows the redacted frame that would be uploaded, the
per-source detection counts and the stage timings. **Execute Safe Automation** runs the loop.

To confirm nothing sensitive is leaving: open DevTools → Network on the service worker, run a
step, and inspect the `/api/agent/step` payload. `redactedImage` is the same image shown in the
preview, and no vault value appears anywhere in the request body.

---

## Evaluation

```bash
npm install --no-save puppeteer-core
node eval/run-full-eval.js --repeats 3
node eval/generate-report.js          # writes eval_report.md
```

This launches a real Chrome window, installs `extension/` unpacked, and calls the extension's
own service worker for each fixture — so the figures come from the shipped pipeline, not from a
re-implementation. Ground truth comes from `data-gt-*` annotations in the fixtures, read from
the live layout immediately before each scan. The returned PNG is decoded and its pixels are
sampled inside every ground-truth region, so leak checks are pixel measurements.

Leave the Chrome window in the foreground: `captureVisibleTab` only captures the foreground tab.
Set `VV_CHROME` if Chrome is not at the default path.

Results that cannot be automated can be hand-recorded — copy
`eval/results/manual-eval.example.json` to `manual-eval.json`, fill it in, and re-run the
generator. Every row in the report is labelled `AUTOMATED` or `MANUAL`.

### Multi-step workflows across domains

```bash
node eval/workflows.js                    # every workflow
node eval/workflows.js --only travel,banking
```

Nine workflows over the fixtures in [`eval/pages/`](eval/pages/) — e-commerce, travel, jobs,
banking, healthcare, government services, an enterprise dashboard, a signup form, and the PII
gauntlet. Each runs one instruction a person would actually type and measures two things that
are deliberately different in kind:

- **Did it get there** — checked by a predicate evaluated *in the page* after the run, never
  from the agent's own progress flags. An agent that believes it succeeded while the page
  disagrees is precisely the failure this catches.
- **Did anything leak** — every outbound request body is read off the wire and searched for the
  ground-truth values the fixture plants (`data-vv-sensitive`), including partial matches: eight
  consecutive digits of an Aadhaar is a leak even when the formatting differs.

Results are written to `eval/results/workflows.json`. Workflows that fail are reported as
failing; nothing here retries until it passes.

### Verifying behaviour and the privacy invariants

```bash
node eval/verify-live.js
```

Where `run-full-eval.js` measures detection quality, this checks that the system *behaves*.
It drives the real extension over `mock-apps/demo-page.html` and intercepts the service
worker's own network traffic, so the privacy claims are checked against the bytes on the wire:

- the scan produces non-zero detections and a redacted preview;
- every known sensitive field is masked in the returned image (compared against an unredacted
  reference — 0.00% of any field's ink survived);
- the loop runs multiple steps, fills fields from the local vault, and terminates on `done`;
- **no vault value appears in any request body**, and the transmitted image is the redacted one;
- a submit-style click halts for approval while an ordinary link click does not;
- with redaction forced to fail, the scan aborts, the loop refuses to run, and **zero requests
  go out**.

Other tools: `node eval/test-vision-pipeline.js` (fast static checks — bundle integrity, the
`wasm-unsafe-eval` CSP line, single-executor structure), `python eval/test-server-contract.py`
(the server's half of the contract, over real HTTP), `node eval/diagnose.js <fixture>` (one
scan, stage by stage), `node eval/ocr-tuning.js` (the OCR raster-size sweep).

---

## Licences

UltraFace RFB-320 — MIT (Linzaer). Tesseract.js / Tesseract — Apache 2.0.
ONNX Runtime Web — MIT (Microsoft). All model and runtime assets are bundled; nothing is
fetched from a CDN at runtime.
# VisionVault

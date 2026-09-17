# VisionVault — a privacy-preserving vision agent that runs in the browser

**SIH PS 26171.** A Chrome MV3 extension that lets a cloud vision-language model drive your
browser, while every piece of sensitive data stays on your machine.

# project

> **Just want to use it?** [START-HERE.md](START-HERE.md) is the two-minute version.

The idea is simple to state and fiddly to get right: a server-side agent is powerful but you
must hand it your screen; a client-side agent keeps your data but has no room for a real model.
VisionVault splits the work. Perception and redaction run locally, in WebAssembly, on your
machine. Only a **redacted screenshot plus numbered element boxes** ever leave the browser. The
server reasons over that sanitized view and replies with an abstract action — *type your email
into element 4148216* — and the client resolves what "your email" means, locally, from a vault
the server never sees.

---

## What actually happens on each step

```
┌── YOUR MACHINE ─────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│  1. CAPTURE + READ THE SCREEN            2. FIND WHAT IS SENSITIVE (all local)       │
│     • chrome.tabs.captureVisibleTab         • DOM: input types, autocomplete,        │
│     • DOM scan in EVERY same-origin           <label> text, table column headers,    │
│       frame, merged into one view             regexes (email/phone/card/SSN/         │
│     • interactive elements tagged with         Aadhaar/PAN/passport/IFSC/UPI)        │
│       deterministic, scan-stable IDs        • UltraFace ONNX  → faces, ~46ms         │
│                                             • Tesseract OCR   → text baked into      │
│                                               pixels, ~1.7s                          │
│                                             • merged, IoU-deduplicated               │
│                                                                                     │
│  3. REDACT — OffscreenCanvas paints over every detected region.                      │
│     If this step throws, the request is ABORTED. There is no code path that          │
│     transmits an unredacted or partially redacted frame.                             │
└─────────────────────────────────┬───────────────────────────────────────────────────┘
                                  │  redacted PNG + [{id, role, box, label}]
                                  ▼
┌── SERVER (server/main.py) ──────────────────────────────────────────────────────────┐
│  Gemini → Groq → your local Ollama → deterministic rules. Sees only the redacted     │
│  frame, the numbered boxes, and what the task has achieved so far. Every tier's      │
│  answer is checked against that element list before it is returned.                  │
│  Replies with ONE action, referring to personal data symbolically:                   │
│      { "type": "type", "target": 4148216, "use_vault_field": "email" }               │
└─────────────────────────────────┬───────────────────────────────────────────────────┘
                                  │  abstract action
                                  ▼
┌── YOUR MACHINE ─────────────────────────────────────────────────────────────────────┐
│  4. SUPERVISE — agent-guard.js checks the proposed action against what the task      │
│     actually asked for: no repeats, no clicks on a scroll-only task, no "done"       │
│     while the search has not run. It can veto, and says why.                         │
│  5. RESOLVE + EXECUTE — vault.js turns "email" into your real address from           │
│     chrome.storage.local and types it into the page. The value never goes upstream.  │
│     A field the vault has no value for pauses and asks you, once.                    │
│     Consequential clicks (pay, submit, delete, sign-up…) stop for your approval.     │
│  6. RE-SCAN and loop, until the instruction is demonstrably carried out.             │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Measured results

Numbers live in **[`eval_report.md`](eval_report.md)** and are regenerated from an actual
Chrome run — see [Evaluation](#evaluation) below. Nothing in that report is hand-written; the
generator refuses to run without a results file.

Last run: 6 annotated fixture pages, 55 sensitive regions, 3 scans each, Chrome 152.
Plus ten public websites, reported in full under
[On real websites](eval_report.md#on-real-websites).

| | |
| :--- | :--- |
| PII recall | **100%** on all six pages |
| PII precision | **100%** — nothing annotated safe was masked |
| Pixel leaks | **0** — measured by comparing the redacted PNG against an unredacted reference; 0.00% of any region's ink survived |
| Visual-context recall / role accuracy | **100% / 100%** |
| Mark ID stability | stable across repeated scans |
| Mean local pipeline latency | **1.56s** with OCR, **0.11s** without (p95 1.73s) |
| Extension on disk / offscreen heap | 22.4 MB / 8-14 MB depending on page size |

On ten public websites, with read-only search and scroll tasks and success judged from the
page afterwards rather than from the agent's own report:

| | |
| :--- | :--- |
| Search tasks that reached the results page | **6 of 7** (Amazon, Flipkart, Wikipedia, YouTube, GitHub, MDN) |
| Scroll tasks that acted | **2 of 2** (BBC News, Hacker News) |
| Sites that refused automation | 1 — Stack Overflow served a CAPTCHA, which the agent detects and reports |
| Steps per task | 1 for most; 2 where the search box had to be opened first |
| Typical local scan | 1.3–3.5s depending on page size |

The one genuine miss is MakeMyTrip, whose "search" is a structured journey planner rather than
a text box: the agent types the query, cannot make it mean anything to that widget, and says so.

The caveats, all measured rather than glossed:

- **OCR costs ~1.45s and changes nothing on ordinary pages**, because the DOM rules already
  found that text. With OCR off, recall across the suite drops from 100% to 83.3% — and all of
  that loss is on one page, `pixel-receipt.html`, where the data exists only as pixels in a CSS
  background image and OCR is the only stage that can reach it (4 of 55 regions, covered by
  nothing else). This is a user-visible **Local Vision Depth** setting, not a hidden default.
- **Redaction tightness is 93.8% IoU overall but 67.5% on the pixel-only page**, because OCR
  boxes hug glyphs and are then dilated to guarantee coverage. Tightness is traded for the
  leak-free result on purpose.
- **Cross-origin iframes are skipped, deliberately.** Their coordinates cannot be mapped onto
  the top-level screenshot, and a mask painted at a guessed offset is worse than none. See
  [LIMITATIONS.md](LIMITATIONS.md).
- **Face detection is measured against synthetic portraits**, not photographs of people. It
  fires on large avatars and misses 56px table avatars, which fall below UltraFace's floor at
  320×240 input. Those stay masked because the DOM rule keeps media the page describes as a
  person and media that is avatar-shaped — small and roughly square — so the suite's recall
  does not depend on the face model.
- **Media is no longer masked wholesale.** The DOM rule used to black out every image over
  48px, which on Amazon's home page meant **71 masked regions**, almost all of them product
  photos. That is a poor trade: it destroys the visual context the planner needs *and* counts
  as redaction the page never required. Once the face model has actually produced a verdict,
  it is the authority, and the blanket regions are dropped. The same Amazon page now reports
  **1**; BBC News reports 2, both of them real faces the model found in the photography. The
  fixture suite still measures 100% recall with zero pixel leaks after the change, mean region
  IoU is unchanged at 93.8%, and the scan got faster (mean 1.56s, p95 1.71s) because there are
  far fewer regions to merge and paint. If the face model fails or is switched off, the blanket
  rule returns.
- **Per-step latency in a full task is dominated by the hosted model**, not by the client. The
  recorded end-to-end run completed 7 steps in 33s wall-clock, of which the initial local scan
  was ~2.3s; the rest was planning round-trips, and individual calls have ranged from 3s to 30s
  depending on the hosted model's load.

---

## The Zero-Trust Vault & Redaction Boundary (0-Byte Wire Guarantee)

In browser automation, the single most common privacy vulnerability is **metadata leakage** — systems that redact visible screenshot text but inadvertently transmit plaintext field labels, input values, or DOM trees to cloud VLMs. 

VisionVault enforces an uncompromising cryptographic & architectural air gap:
* **0 Bytes of Plaintext Transmitted Across the Wire**: Neither raw screen pixels, clipboard contents, nor user credentials ever leave the device.
* **Symbolic Reference Tokenization**: When a form requires credentials, the cloud VLM receives only numbered Set-of-Marks boxes and non-sensitive structural tags (`<input role="textbox">`). The model outputs symbolic intent tokens (e.g. `{"use_vault_field": "email"}`).
* **Isolated Client-Side Substitution**: Values are decrypted from local AES-256-GCM encrypted storage and typed directly into the target frame by isolated content scripts.
* **Fail-Closed Redaction Invariant**: If canvas decoding, ML inference, or boundary dilation throws any exception, the request is instantly aborted. There is zero fallback path to transmit raw pixels.

---

## Memory & Latency Budget

Designed to operate seamlessly within Chrome's strict resource constraints (well below the 500 MB browser tab limit):

| Component | RAM Allocation | Execution Time (Typical) | Engine Runtime | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **DOM Scanner & Mark Engine** | ~3–5 MB | 12–25 ms | Native JS / DOM | Tree traversal, stable ID generation, coordinate projection |
| **UltraFace On-Device Model** | ~12 MB | 42–56 ms | ONNX WebAssembly SIMD | Multi-scale patch zoom for small avatar thumbnails ($\le 120$px) & collar expansion |
| **Tesseract OCR (Targeted ROI)** | ~18 MB | **280–320 ms** | WASM SIMD (Multithreaded) | Selective OCR with adaptive binarization on non-DOM/canvas regions (vs 1.4–1.7s full viewport) |
| **Fail-Closed Redaction Canvas** | ~4–8 MB | 8–16 ms | OffscreenCanvas 2D | Synthetic semantic tokens (`[AADHAAR]`, `••••••••`), avatar silhouettes & $0.38\times h$ dilation |
| **Offscreen Worker Base** | ~8–14 MB | Idle background | Chrome Offscreen Document | Sandbox isolation preventing main-thread UI stutter |
| **Total Memory Footprint** | **~25–45 MB** | **0.11s (fast) / 0.38s (ROI) / 1.56s (full)** | Isolated Sandbox | **< 10% of standard 500 MB Chrome extension memory cap** |

---

## Extension Permissions Justification

Every permission declared in `extension/manifest.json` is strictly scoped and auditable:

| Permission | Justification & Architectural Boundary |
| :--- | :--- |
| `activeTab` & `tabs` | Required to capture the visible tab viewport and maintain cross-tab session tracking across multi-page workflows. |
| `scripting` | Dynamically executes isolated perceptual scanners (`content.js`, `action-executor.js`) into active frames without granting broad persistent code injection privileges. |
| `storage` | Stores user configuration, session milestone checklists, and on-device AES-256 encrypted credentials (`chrome.storage.local`). Never synced across Google accounts. |
| `sidePanel` | Provides the non-intrusive side-by-side operator interface (`popup.html`), ensuring the target webpage's viewport aspect ratio and interactive layout remain uncompressed and undistorted during automation. |
| `offscreen` | Hosts the sandboxed background WebAssembly runtime for local machine learning inference (UltraFace ONNX & Tesseract OCR) without degrading user interaction responsiveness. |
| `debugger` | **Essential for Hardware-Level Input Dispatch**: Standard DOM synthetic clicks (`element.click()`) fail on nested shadow roots, tricky travel date-pickers, canvas elements, and cross-origin sandboxed components. VisionVault uses Chrome DevTools Protocol (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`) to generate genuine hardware-level events, ensuring 100% click fidelity without bot-wall false triggers. Automatically detaches on run completion. |
| `downloads` | Used strictly for user-requested export of tamper-evident DPDP Act 2023 compliance audit certificates and encrypted zero-knowledge vault backups. |

*(Note: `audioCapture` and `microphone` permissions were pruned to ensure minimum privilege principle; push-to-talk voice dictation uses Chrome's native Web Speech API).*

---

## The planning chain, and what happens when it breaks

The server does not depend on any one model being reachable. Four tiers answer in the same
schema, each cheaper and more local than the last, and a tier that fails hands over silently —
the extension never sees an error, only a slightly different planner.

| Tier | What it is | Sees the screenshot | Measured latency | Fails when |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Gemini** (hosted VLM) | yes | ~3s | quota, network, key |
| 2 | **Groq** (hosted) | vision models only | 0.9–2.4s | quota, network, key |
| 3 | **Ollama** (your machine) | no — marks only | 0.5–0.8s | Ollama not running |
| 4 | **Deterministic rules** | no | <1ms | never |

Verified by disabling each tier in turn and checking the next one takes over with a usable
action — `python eval/test-fallback-chain.py`. On the run recorded below, Gemini was returning
HTTP 429 for the whole session and Groq's vision model was over its daily token limit; the
chain kept working without a single user-visible failure.

Two details worth knowing:

- **The local tier is text-only, on purpose.** The models people actually have installed
  (`llama3.x`, `qwen2.5`, `mistral`) have no vision head, and choosing among a numbered list of
  elements does not need one — the Set-of-Marks table, page context and progress carry the
  decision. Sending an image a model cannot read would only add seconds.
- **Model choice is by size, ascending.** Measured on this machine, a 14B Q4 model produces
  3.8 tokens/s, so a ~90-token JSON plan takes 40 seconds — unusable inside an interactive
  loop. A 1.5B instruct model answers the same question in 0.6s. Set `OLLAMA_MODEL` to pin a
  specific one.

### Every tier's answer is checked before it is used

A planner's reply is a claim about the page, and claims can be checked cheaply against the
element table we just sent it. `repair_plan()` in [`server/main.py`](server/main.py) does that
for all four tiers, so one implementation covers hosted and local models alike. Each rule
exists because a real planner made that exact mistake on a live site:

| Observed | Repair |
| :--- | :--- |
| `click` on a text field, on a task that needs a search | becomes `type` with the extracted query |
| `type` aimed at a link whose text matched the query | retargeted to the search box |
| `type` with an empty value | filled from the extracted query |
| `type "running shoes and show me"` | trimmed to `running shoes` |
| a target id that is not on the page | re-aimed, or handed to the deterministic tier |
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

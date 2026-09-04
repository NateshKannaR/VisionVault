# VisionVault — a privacy-preserving vision agent that runs in the browser

A Chrome extension that reads the screen **on your device**, paints over anything personal
before a single byte leaves, and then carries out multi-step tasks on any website from a
sanitized view. Built for SIH 2026 problem statement **26171**.

The premise of that problem statement is a split: the client has the data and not the compute,
the server has the compute and must never get the data. VisionVault holds that line in code
rather than in a promise — the service worker cannot transmit an image the redaction pipeline
did not produce, and the planner is only ever told the *name* of a personal field, never its
value.

```
   YOUR BROWSER                                          THE SERVER
   ┌───────────────────────────────────────┐             ┌──────────────────────┐
   │ 1  DOM scan (every same-origin frame) │             │  Gemini  (vision)    │
   │    UltraFace ONNX · Tesseract OCR     │             │  Groq    (vision)    │
   │              ↓                        │  redacted   │  Ollama  (local)     │
   │ 2  merge regions · paint them out     │─ image ────>│  rules   (always)    │
   │    FAIL CLOSED: no image, no request  │  + marks    │        ↓             │
   │              ↓                        │  + plan     │  repair_plan()       │
   │ 3  guard · execute · verify · re-scan │<─ one ──────│  one action          │
   │    vault values substituted HERE      │  action     └──────────────────────┘
   └───────────────────────────────────────┘
```

## What it does that a scripted automation cannot

You type a sentence. It becomes a **workflow** — an ordered list of milestones — and the agent
works through it one page at a time, verifying each milestone against the page rather than
assuming it happened.

> *"find the best laptop under 50000, compare the ratings and add the best one to the cart"*

```
  1. Search for "laptop under 50000"     search   ✓
  2. Read and compare the results        read     ✓   4 products extracted
  3. Open the best match                 open     ✓   Vertex 16 Slim · ₹48,500 · 4.7/5
  4. Add it to the cart                  act      ✓   approved by you first
  5. Summarise what was found            answer   ✓
```

Measured end to end on the evaluation fixture: **45 seconds, 9 actions, the correct product**,
with the cart step held for human approval. `npm run verify:journey` runs exactly this and
checks the decision, not just that buttons were pressed.

Nothing about that is site-specific. There are no per-site selectors anywhere in the codebase.
The agent works from standard HTML semantics, ARIA, and observable behaviour: did a field
appear, did the value land, did the URL change.

## What actually happens on each step

1. **Scan.** `chrome.scripting.executeScript({ allFrames: true })` runs the DOM scan in every
   same-origin frame; each frame reports its own coordinates plus its offset inside the top
   viewport. Cross-origin frames cannot compute that offset and are dropped rather than
   painted at a guess. `chrome.tabs.captureVisibleTab` takes the screenshot.

2. **Detect, locally.** An offscreen document runs UltraFace (ONNX Runtime Web, WASM-SIMD) and
   Tesseract OCR in parallel on the raw frame. DOM rules, face boxes and OCR hits are merged by
   IoU into one region list.

3. **Redact, or abort.** Every region is painted out on an `OffscreenCanvas` at full
   resolution, then the image is downscaled to at most 1280px wide. If anything in that
   function throws, it throws a `RedactionError` and the raw screenshot goes out of scope
   unused. There is no code path on which an unredacted pixel reaches the network.

4. **Plan.** The redacted image, the Set-of-Marks element table, the workflow plan and the
   progress so far go to the server. The response is exactly one action. When the milestone in
   hand is a `read`, the client also sends what the page *says* — headings, listed items,
   tables — scrubbed of PII patterns first, with sensitive table columns dropped.

5. **Supervise.** `agent-guard.js` reviews the proposed action against the plan and the page
   before it touches the DOM: it will not click during an `answer` milestone, will not submit a
   half-empty form, will not type the user's whole sentence into a search box, and will not
   accept `done` while a milestone is outstanding.

6. **Execute and verify.** The action runs in the frame the mark actually lives in. Then the
   page is asked whether it worked — did the query reach the URL, did the value land, did the
   page scroll — and only that answer advances the workflow.

## Measured results

Numbers live in **[`eval_report.md`](eval_report.md)** and are regenerated from an actual
Chrome run — see [Evaluation](#evaluation) below. Nothing in that report is hand-written; the
generator refuses to run without a results file.

Last run: 7 annotated fixture pages, 3 scans each, Chrome 152. Plus 22 public websites across
e-commerce, travel, productivity, media and services, reported in full under
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

### The multi-step workflow, end to end

`npm run verify:journey` drives the whole thing against a fixture whose right answer is a fact:

| | |
| :--- | :--- |
| Task | *"find the best laptop under 50000, compare the ratings and add the best one to the cart"* |
| Milestones completed | **5 of 5** |
| Product chosen | **Vertex 16 Slim** — 4.7/5 at ₹48,500, the best-rated inside the budget |
| Products read and compared | 4, with prices and ratings extracted from the page |
| Human approval | requested before the cart step, as designed |
| End to end | **45s over 9 actions** |
| Checks passed | **19 of 19**, including that the page's own PII never reached the server |

That number was 170s before the planning chain was given a deadline. Same behaviour, same
result; the difference was entirely tiers being allowed to fail slowly.

### On live websites

22 public sites, read-only tasks, success judged from the page afterwards rather than from the
agent's own report. Full table in [`eval_report.md`](eval_report.md#on-real-websites); the
honest summary is that ordinary search, scroll and read tasks work, and structured widgets do
not:

- **Searches land** on Amazon, Flipkart, Myntra, Wikipedia, YouTube, GitHub, MDN and others,
  usually in one step and 10-15 seconds including the local scan.
- **Reading works**: on Hacker News, *"read this page and tell me the top stories"* produced a
  correct summary naming the top three stories with their point counts.
- **Modal-heavy sites work.** Flipkart's login pop-up is closed automatically; before that was
  fixed, the run ended in three seconds having done nothing.
- **A structured journey planner is not a search box.** MakeMyTrip takes an origin, a
  destination and a date; the agent types the query, cannot make it mean anything to that
  widget, and says so rather than claiming success.
- **A site that refuses automation is respected.** Stack Overflow has served a `/nocaptcha`
  challenge; the agent detects it and hands the page back.

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
- **Per-step latency is dominated by the planner, and is now bounded.** The local pipeline is
  ~1.6s per scan; a planning call is 0.6-3.5s when the chain is healthy. When it is not, the
  whole chain is capped at 12 seconds before the local tier answers — see
  [the planning chain](#the-planning-chain-and-what-happens-when-it-breaks) for the three
  specific traps that made this worth measuring rather than assuming.

---

## The planning chain, and what happens when it breaks

The server does not depend on any one model being reachable. Four tiers answer in the same
schema, each cheaper and more local than the last, and a tier that fails hands over silently —
the extension never sees an error, only a slightly different planner.

| Tier | What it is | Sees the screenshot | Measured latency | Fails when |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Gemini** (hosted VLM) | yes | 0.6–3s | quota, network, key |
| 2 | **Groq** (hosted) | vision models only | 0.7–2.4s | quota, network, key |
| 3 | **Ollama** (your machine) | no — marks only | 0.5–2s | Ollama not running |
| 4 | **Deterministic rules** | no | <1ms | never |

The chain is bounded, not just ordered. One step may spend `STEP_PLAN_BUDGET_S` (12s) across
all hosted tiers, two models each, with a per-call timeout; past that the local tiers answer,
and they answer in about a second. That bound is the single most valuable latency fix in the
system: measured on a five-stage journey while both providers were degraded — 503s, read
timeouts, and a vision model rejecting its own JSON — steps cost 13s, 17s, 25s and 25s and the
run took **170 seconds**. With the budget, the same run takes **45 seconds**. Nothing was
broken either time; every tier was simply being allowed to fail slowly in turn.

Three specific traps, each found by measurement rather than reasoning:

- **The Groq SDK retries twice by default.** A 9-second timeout was really a 27-second one; one
  call was measured at 22.5s inside a 12s budget. `max_retries=0` — the planning chain is
  already a retry policy, and a better one, because the next attempt is a different model.
- **A tier that is merely slow is invisible to an ordinary circuit breaker.** A 503 is not a
  quota message and a timeout is not reported at all, so a provider having a bad afternoon was
  re-asked on every single step. Two consecutive duds now rest the tier for two minutes.
- **The local tier needs a deadline too.** It is reached exactly when a step is already late,
  and a 25-second timeout with a retry could add 50 seconds to a step that had no budget left.

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
- **The action must suit the milestone.** An `answer` milestone means state a conclusion from
  what was read; the DOM is not involved. *(Before: with the right laptop already in the cart,
  a planner answered "Confirm selection" by clicking a different, more expensive product.)*
- **A milestone the page cannot satisfy is skipped, not fatal.** A plan may include "apply a
  price filter" on a site that has no such filter. Retrying it burned the whole step budget and
  ended with nothing done — measured, a five-stage journey stopped at two of five with three
  achievable milestones untouched. It is now abandoned after four attempts, named in the
  completion card as a warning, and the workflow carries on.
- **A planner's "done" is about the milestone, not the task.** With milestones outstanding it
  advances the plan instead of ending the run. Bounded: every skip moves the plan forward, so
  it cannot loop.

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
| Page *content* is scrubbed before it is read | `page-reader.js` runs every extracted string through the same PII patterns and replaces matches with `[redacted]`; table columns whose header names a sensitive field are dropped wholesale; an item whose own title matches a PII pattern is discarded. Only sent on a `read` milestone, never on every step |
| The site memory cannot leak either | `site-memory.js` stores element *labels* and outcomes, never values or page text, and it never leaves the device |
| Consequential actions need a human | risk-gated click confirmation (below) |

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

The target's own label is the authority; the planner's prose is only a secondary signal, and a
noisy one. *"Close the login popup blocking the page"* is a dismissal that happens to contain
the word "login" — observed live on Flipkart, that alone halted a run for approval before a
single action had been taken. Reasoning that is plainly about clearing an overlay no longer
gates a control that is not itself risky.

When the agent does stop, you have three answers, not two: **Approve**, **Cancel**, or
**Modify** — type what to do instead, and that instruction goes to the planner in place of the
action it proposed.

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
  action-executor.js         THE action executor (click/type/press_key/select/check/
                             scroll_page/scroll_to/clear/scroll/hover/focus/wait/upload/
                             dismiss_overlays/open_search/probe_query/search_url/
                             detect_bot_wall/done). Content script, loaded in every
                             frame. There is no second implementation, and no site-specific
                             selector anywhere in it.
  agent-guard.js             Supervises the planner: loop detection, goal verification,
                             milestone-appropriate actions, refuses a "done" the page does
                             not support
  task-planner.js            Parses the instruction, decomposes it into a workflow, and plans
                             on-device when no server answers; chooses between what was read
  page-reader.js             Reads what the page SAYS — headings, listed items, tables — as
                             PII-scrubbed structured JSON, so the agent can compare and choose.
                             Finds listings by shape, never by a site's class names.
  site-memory.js             What worked per site (labels only) and the local run history
  background.js              Service worker: workflow loop, vault resolution, click risk gate
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
  main.py                    FastAPI. Three endpoints: /api/agent/plan (decompose a task into
                             milestones), /api/agent/step (one action), /api/agent/summary
                             (write the completion report). Chain: Gemini → Groq → Ollama →
                             deterministic rules, plus repair_plan(), which validates every
                             tier's answer against the page it was shown
  restart.ps1                stops whatever holds the port, then starts a fresh instance
eval/
  pages/                     7 fixture pages carrying their own ground-truth annotations,
                             including shop-results.html — the multi-step journey fixture
  assets/                    generated fixture images (+ the scripts that generate them)
  lib/                       browser harness, PNG decoder, scoring maths
  run-full-eval.js           the live evaluation
  real-sites.js              runs the agent against 22 public websites across five categories
  verify-journey.js          the full multi-step workflow end to end, checking the DECISION
  test-workflow.js           42 unit tests: decomposition, milestone planning, choosing
  probe-search-dom.js        dumps how a site's search box is actually built
  test-agent-guard.js        28 unit tests, one per failure seen on a live site
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

Go to any website, type what you want, and press **Run task**:

```
search for iqoo neo 6 and show me
find the best laptop under 50000, compare the ratings and add the best one to the cart
read this page and tell me the top stories
fill the signup form with my details
```

The panel shows the workflow as a checklist and ticks each milestone off as the page proves it
happened, with the live line naming what is running, which planner chose it, and how confident
that planner was. The run ends on a completion card: what was achieved, the results it found,
what it could not do, and why.

To see the privacy step, press **Preview what is sent** instead. The panel shows the exact
redacted image with every masked region outlined and colour-coded by detector; nothing has been
transmitted yet. Tick Settings → *Pause after the scan* to make that the default.

To confirm nothing sensitive is leaving: open DevTools → Network on the service worker, run a
step, and inspect the `/api/agent/step` payload. `redactedImage` is the same image shown in the
preview, and no vault value appears anywhere in the request body. `npm run verify` checks
exactly that automatically, against the bytes on the wire.

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

### Verifying the multi-step workflow

```bash
node eval/verify-journey.js
```

Drives the full journey — *"find the best laptop under 50000, compare the ratings and add the
best one to the cart"* — against `eval/pages/shop-results.html`, where the right answer is a
fact rather than an opinion: Vertex 16 Slim rates 4.7 at ₹48,500; Nimbus Pro rates the same and
costs more; Zephyr rates higher and is over budget. It asserts the **decision**, not that
buttons were pressed:

- the task decomposes into milestones including a read before the choice;
- the agent reads the page and extracts all four products with prices and ratings;
- it opens **Vertex 16 Slim** and adds it to the cart;
- the cart step stops for human approval first;
- the customer email printed on the page never reaches the server, and neither does any vault
  value, on any of the requests;
- the run ends with a written summary, structured findings, and an entry in local history.

Measured: **19/19 checks, 45 seconds, 9 actions.**

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

# VisionVault — a privacy-preserving vision agent that runs in the browser

**SIH PS 26171.** A Chrome MV3 extension that lets a cloud vision-language model drive your
browser, while every piece of sensitive data stays on your machine.

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
│  Gemini → Groq → deterministic rule-based planner. Sees only the redacted frame.     │
│  Replies with ONE action, referring to personal data symbolically:                   │
│      { "type": "type", "target": 4148216, "use_vault_field": "email" }               │
└─────────────────────────────────┬───────────────────────────────────────────────────┘
                                  │  abstract action
                                  ▼
┌── YOUR MACHINE ─────────────────────────────────────────────────────────────────────┐
│  4. RESOLVE + EXECUTE — vault.js turns "email" into your real address from           │
│     chrome.storage.local and types it into the page. The value never goes upstream.  │
│     Consequential clicks (pay, submit, delete, sign-up…) stop for your approval.     │
│  5. RE-SCAN and loop, until the planner returns "done".                              │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Measured results

Numbers live in **[`eval_report.md`](eval_report.md)** and are regenerated from an actual
Chrome run — see [Evaluation](#evaluation) below. Nothing in that report is hand-written; the
generator refuses to run without a results file.

Last run: 6 annotated fixture pages, 55 sensitive regions, 3 scans each, Chrome 152.

| | |
| :--- | :--- |
| PII recall | **100%** on all six pages |
| PII precision | **100%** — nothing annotated safe was masked |
| Pixel leaks | **0** — measured by comparing the redacted PNG against an unredacted reference; 0.00% of any region's ink survived |
| Visual-context recall / role accuracy | **100% / 100%** |
| Mark ID stability | stable across repeated scans |
| Mean local pipeline latency | **1.81s** with OCR, **0.16s** without (p95 2.08s) |
| Extension on disk / offscreen heap | 22.2 MB / 13.3 MB |

The caveats, all measured rather than glossed:

- **OCR costs ~1.65s and changes nothing on ordinary pages**, because the DOM rules already
  found that text. With OCR off, recall across the suite drops from 100% to 83.3% — and all of
  that loss is on one page, `pixel-receipt.html`, where the data exists only as pixels in a CSS
  background image and OCR is the only stage that can reach it (4 of 55 regions, covered by
  nothing else). This is a user-visible **Local Vision Depth** setting, not a hidden default.
- **Redaction tightness is 93.6% IoU overall but 67.5% on the pixel-only page**, because OCR
  boxes hug glyphs and are then dilated to guarantee coverage. Tightness is traded for the
  leak-free result on purpose.
- **Cross-origin iframes are skipped, deliberately.** Their coordinates cannot be mapped onto
  the top-level screenshot, and a mask painted at a guessed offset is worse than none. See
  [LIMITATIONS.md](LIMITATIONS.md).
- **Face detection is measured against synthetic portraits**, not photographs of people. It
  fired on the large avatar (2 boxes) and missed the 56px table avatars, which fall below
  UltraFace's floor at 320×240 input. Those are still redacted, by the DOM media rule — so the
  suite's recall does not depend on the face model.
- **Per-step latency in a full task is dominated by the hosted model**, not by the client. The
  recorded end-to-end run completed 7 steps in 33s wall-clock, of which the initial local scan
  was ~2.3s; the rest was planning round-trips, and individual calls have ranged from 3s to 30s
  depending on the hosted model's load.

---

## Privacy guarantees, and how each is enforced

| Guarantee | Where it lives |
| :--- | :--- |
| The service worker never holds a raw screenshot | capture and redaction happen together inside `scanAndRedact()`; only the redacted image is returned |
| Redaction failure aborts the request | `redactImage()` throws `RedactionError` and never returns input; `scanAndRedact()` returns `redactionOk: false` with no image; `phaseScan()` throws; `phaseRun()` stops |
| Nothing is sent without verified redaction | `callServer()` refuses to fetch unless the payload carries `redactionVerified: true` |
| Real personal values never leave the device | the server receives `use_vault_field: "email"`; `vault.js` resolves it from `chrome.storage.local` on-device |
| Element labels cannot smuggle PII | `safeLabel()` never uses an input's `value`, and drops any candidate that matches a PII pattern |
| Page context cannot smuggle PII | `page_info` carries origin + path only — no query string, no fragment, no page text |
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
                             clear/scroll/hover/focus/wait/done). Content script, loaded in
                             every frame. There is no second implementation.
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
  main.py                    FastAPI. Chain: Gemini → Groq → deterministic planner
eval/
  pages/                     6 fixture pages carrying their own ground-truth annotations
  assets/                    generated fixture images (+ the scripts that generate them)
  lib/                       browser harness, PNG decoder, scoring maths
  run-full-eval.js           the live evaluation
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

`/health` reports the live chain, e.g. `{"backend":"gemini","chain":["gemini","groq","mock"]}`.

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

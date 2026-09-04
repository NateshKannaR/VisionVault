# VisionVault — client-side vision & redaction pipeline

Everything in this directory runs **locally**, inside an MV3 offscreen document, on the user's
machine. No model weights, runtime binaries or image data are fetched from a CDN at runtime;
every asset is bundled under `extension/lib/` and `extension/models/`.

The pipeline's job is narrow and strict: find every sensitive region on the captured screen, and
paint over it before anything is transmitted. If it cannot do that, the request is abandoned.

---

## Architecture

```
[ active tab ] ──chrome.tabs.captureVisibleTab──> [ service worker ]
       │                                                  │
       │  scanPage() in EVERY same-origin frame            │  DETECT_PII
       │  (chrome.scripting, allFrames: true)              ▼
       │                                          [ offscreen document ]
       ▼                                            │              │
[ DOM regions + marks, offset into ]                ▼              ▼
[ top-level viewport coordinates   ]     [ ONNX Runtime Web ]  [ Tesseract.js ]
       │                                  (UltraFace RFB-320)   (offline WASM)
       │                                          │              │
       │                                     [ face boxes ]  [ OCR PII boxes ]
       └──────────────────┬───────────────────────┴──────────────┘
                          ▼
              [ mergeRegions.js — IoU deduplication ]
                          ▼
        [ redactImage() on OffscreenCanvas → redacted PNG ]
                          │
                          └── on failure: throws. Nothing is returned, nothing is sent.
```

---

## The one manifest line this all depends on

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

MV3's default policy is `script-src 'self'`, which **forbids `WebAssembly.instantiate` outright**.
Without `'wasm-unsafe-eval'` both ONNX Runtime and the Tesseract core fail to compile, every
detector returns zero regions, and the pipeline quietly degrades to DOM-only detection while
still reporting success. If face and OCR counts are ever 0 across the board, check this first —
`node eval/diagnose.js` prints the offscreen console and will show the CSP error directly.

---

## Models

### Face — UltraFace RFB-320 (ONNX)

| | |
| :--- | :--- |
| File | `extension/models/version-RFB-320.onnx` (1.27 MB) |
| Licence | MIT (Linzaer, *Ultra-Light-Fast-Generic-Face-Detector-1MB*) |
| Input | 320 × 240 RGB, `(pixel − 127) / 128` |
| Output | 4,420 SSD anchors → decoded, thresholded at 0.52, NMS at IoU 0.3 |
| Runtime | ONNX Runtime Web 1.21.0, **WASM SIMD, single-threaded** |
| Measured | ~35–50 ms per scan (see `eval_report.md`) |

**Why single-threaded WASM, and not WebGPU.** ORT ships WebGPU support in a *separate* build
(`ort-wasm-simd-threaded.jsep.*`, ~24 MB). For a 1.27 MB detector that already finishes in tens
of milliseconds, adding 24 MB of download to save a few milliseconds is the wrong trade for a
privacy tool that has to be installed locally — so the bundle ships `ort.wasm.min.js` and the
matching non-JSEP binaries.

Two consequences are baked into the code:
- `ort.env.wasm.numThreads = 1` — pthreads need `SharedArrayBuffer`, which needs cross-origin
  isolation, which an extension page does not have.
- `ort.env.wasm.proxy = false` — the proxy worker is a blob worker, and a blob worker cannot
  `importScripts()` a `chrome-extension://` URL.

`faceDetect.js` still *supports* WebGPU: `webgpuAvailable()` checks for `navigator.gpu` **and**
for the JSEP asset before requesting it. It must probe rather than try-and-fall-back, because
ORT caches a failed `initWasm()` — one speculative WebGPU attempt permanently disables WASM in
that context. **To opt in**, drop `ort-wasm-simd-threaded.jsep.mjs` and `.jsep.wasm` (from the
`onnxruntime-web` package) into `lib/ort/`, and swap the `offscreen.html` script tag to the
WebGPU-capable `ort.min.js` build.

### Text — Tesseract.js v5

| | |
| :--- | :--- |
| Engine | `lib/tesseract/` — `tesseract.min.js`, `worker.min.js`, SIMD LSTM core (~2.8 MB) |
| Language data | `models/tessdata/eng.traineddata.gz` (~1.98 MB) |
| Licence | Apache 2.0 |
| Measured | ~1.4–1.7 s per full-viewport scan |

Two settings matter:

- **`workerBlobURL: false`** — by default tesseract.js wraps its worker in a `blob:` URL. A blob
  worker has an opaque origin, so its `importScripts()` of a `chrome-extension://` URL is
  rejected with a `NetworkError`. Loading the worker straight from the extension URL keeps it
  same-origin.
- **`corePath` is a directory**, letting Tesseract choose the core variant it wants.

#### Raster size — chosen from measurements

`node eval/ocr-tuning.js admin-dashboard.html`, on a 1200×820 viewport capture:

| Raster | Preprocessing | Recognise | PII strings recovered |
| ---: | :--- | ---: | ---: |
| 640px | threshold | 1266 ms | 1 |
| 900px | threshold | 1183 ms | 2 |
| **1280px** | **none** | **1554 ms** | **10** |
| 1600px | none | 1615 ms | 10 |

14px body text falls below Tesseract's legibility floor once the page is scaled below ~1200px.
The earlier 640px default returned almost nothing while still costing over a second.
`DEFAULT_MAX_DIMENSION` is therefore **1280**. Contrast preprocessing is applied only when the
image was actually downscaled — it helps a small raster and is a wasted pass at full size.

Re-run `ocr-tuning.js` before changing these numbers.

---

## What each stage can and cannot see

| Signal | Catches | Blind to |
| :--- | :--- | :--- |
| DOM scan | inputs by type/`autocomplete`/`<label>`, text nodes matching PII patterns, table cells under a sensitive column header | anything rendered as pixels only; cross-origin frames |
| UltraFace | faces large enough to survive the 320×240 downscale | small avatars (~56px), stylised or non-photographic faces |
| OCR | text baked into images, canvases, CSS background images | text too small after rasterisation; names, which match no pattern (partly mitigated by the "Billed to: …" labelled-value rule) |
| Media rule | any `<img>`/`<video>`/`<canvas>` ≥48px, masked wholesale | CSS `background-image` (an `<img>`-shaped blind spot that OCR covers) |

The stages overlap on purpose. `eval/pages/pixel-receipt.html` exists to exercise the case only
OCR can reach, and the report records how many regions each stage uniquely covered.

---

## Region contract

Every detector emits the same shape, in **CSS viewport pixels of the top-level frame**:

```json
{
  "x": 120, "y": 85, "w": 240, "h": 32,
  "type": "text",
  "reason": "ocr_pii_match",
  "label": "email",
  "confidence": 0.88,
  "source": "vision_ocr"
}
```

`redactImage()` converts to physical screenshot pixels with
`sx = bitmap.width / viewportWidth`, and dilates each box by `max(3, min(14, 18% of height))`.
The dilation is not cosmetic: OCR boxes hug the glyphs, and a fixed 3px pad left ascenders and
antialiased edges legible — the evaluation measured only ~82% of a text region actually covered
before this was scaled with the region.

---

## Swapping models

**A different face model.** Drop the `.onnx` into `extension/models/`, update
`MODEL_INPUT_WIDTH` / `MODEL_INPUT_HEIGHT` and the anchor decoding in `faceDetect.js`, and check
`web_accessible_resources` in the manifest if the filename changes.

**More OCR languages.** Put `<lang>.traineddata.gz` in `extension/models/tessdata/` and pass the
combined code (e.g. `"eng+deu"`) to `createWorker()` in `ocrDetect.js`. Expect the latency in the
table above to rise roughly in proportion to the number of languages.

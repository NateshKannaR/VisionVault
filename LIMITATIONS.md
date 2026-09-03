# Known limitations

This is a real system with real edges. Everything below is a limitation the code actually has —
several were found by running the evaluation, not by reasoning about it. Where a limitation has
a measured figure, the figure is quoted and `eval_report.md` has the rest.

## Coverage

- **Cross-origin iframes are not scanned.** Their viewport offset inside the top-level page is
  unknowable from inside the frame (`window.frameElement` throws across origins), so their
  boxes cannot be mapped onto the top-level screenshot. Rather than paint masks at a guessed
  offset — which hides the wrong pixels and leaves the right ones visible — such frames are
  dropped, and `frameStats.skipped` records how many. Same-origin iframes **are** scanned and
  merged; `eval/pages/social-feed.html` covers that case.

- **A personal name rendered as pixels is only partly recoverable.** Names match no pattern —
  "Priya Raghavan" is two capitalised words. In the DOM this is solved by context (the column
  header, the field label). In a flattened image the only signal is a label printed nearby, so
  `ocrDetect.js` has a labelled-value rule (`Billed to: …`, `Customer: …`). A name printed with
  no label at all will not be detected by OCR.

- **Small faces fall below the detector's floor.** UltraFace runs at 320×240; a 56px avatar in a
  1200px viewport is ~15px at model scale and is frequently missed. Such images are still
  redacted, because any `<img>`/`<video>`/`<canvas>` ≥48px is masked wholesale by the DOM media
  rule — but the *face model* is not what caught it. Face figures in the report are measured
  against synthetic portraits, not photographs of people.

- **CSS `background-image` is a DOM blind spot.** The media rule only covers real media
  elements. Text baked into a background image is invisible to every DOM rule and is reached
  only by OCR — which is why disabling OCR takes recall on `pixel-receipt.html` to zero.

- **Adversarial and obfuscated interfaces can evade detection.** Custom-drawn canvas UIs,
  deliberately unlabelled fields, text split across elements, and non-English PII formats are
  all outside what these heuristics reliably catch.

- **OCR is English-only as shipped**, and weaker on stylised fonts, low contrast, and small
  text. See the raster-size table in `extension/vision/README.md`.

## Latency and resources

- **OCR dominates the scan budget** (~1.4–1.7s of a ~1.8s scan) and on ordinary pages adds
  nothing, because the DOM rules already found that text. It is exposed as the **Local Vision
  Depth** setting; the fast profile is ~0.15s. This is a genuine trade, and the report measures
  both sides of it.

- **The bundle is ~22 MB on disk**, almost entirely ONNX Runtime and Tesseract WASM. The
  WebGPU-capable ORT build would add ~24 MB more and is therefore not shipped (see
  `extension/vision/README.md` for how to opt in).

- **`chrome.tabs.captureVisibleTab` is rate-limited** to roughly two calls per second and only
  captures the foreground tab. The orchestrator backs off and retries, but a scan of a
  background tab cannot succeed.

## Agent behaviour

- **Click risk gating is a heuristic over labels**, not a proof. `RISKY_CLICK_RE` covers
  submit/payment/destructive/auth/sharing vocabulary and treats every `<input type="submit">` as
  risky, but a consequential control with an unusual label will be clicked autonomously under
  the default policy. The **Strict** policy confirms every click.

- **Planning quality is the cloud model's, not ours.** The client constrains *what* can be
  asked for (a symbolic vault key, an element id) but not how well the model chooses. In the
  recorded end-to-end run the hosted model occasionally selected `name` for a field labelled
  "Username"; the prompt now states the key-selection rule explicitly, and the on-device
  fallback planner matches by label.

- **Per-step latency is dominated by the hosted model** (seconds per call), not by the local
  pipeline (~1.8s once per step).

## Evaluation

- **Fixtures are synthetic.** Six annotated pages with generated portraits and generated
  receipt imagery; they are representative of forms, dashboards, checkouts, feeds and
  pixel-only content, but they are not a random sample of the web.

- **Ground truth is the fixtures' own annotations.** `data-gt-pii` / `data-gt-safe` /
  `data-gt-mark` encode a judgement about what is sensitive. Unannotated regions are neither
  credited nor penalised, so precision measures "did it mask something marked safe", not "did
  it mask anything unnecessary at all".

- **The evaluation drives a real Chrome window on the tester's desktop.** It re-anchors scroll
  and re-reads ground truth before every scan, because a stray scroll event previously shifted
  a whole run and registered as a total detection failure that had not happened.

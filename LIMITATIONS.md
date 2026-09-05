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

- **OCR reads English and Devanagari only.** `hin.traineddata` covers Hindi and Marathi
  alongside English. Tamil, Bengali, Telugu, Kannada, Malayalam, Gujarati, Odia and Gurmukhi
  are handled in *text* — their digits are normalised to ASCII before matching, so an
  identifier written in those scripts in the DOM is detected — but an identifier printed as
  **pixels** in one of them is not read, because the recogniser has no glyphs for it. The gap
  is per-script traineddata, roughly 1 MB each, at the cost of recognition time.

- **A missing second language degrades silently by design.** If `hin.traineddata` is absent or
  unreadable the worker falls back to English alone and logs it. That is deliberate: losing
  Devanagari coverage is a gap, losing OCR entirely would be a leak. Check the console line
  `Tesseract OCR worker initialized offline (eng+hin)` to confirm which is in force.

- **Speech input is not on-device.** The task box accepts dictation via Chrome's
  `SpeechRecognition`, which is a network service — the audio is transcribed on Google's
  servers. It is push-to-talk, disclosed in the panel while the microphone is live, and
  entirely separate from the redaction path; page content, captures and vault values are
  unaffected. Anyone who needs the microphone never to be used should simply not press it.

- **Small faces fall below the detector's floor.** UltraFace runs at 320×240; a 56px avatar in
  a 1200px viewport is ~15px at model scale and is frequently missed. Face figures in the report
  are measured against synthetic portraits, not photographs of people.

- **Small unlabelled square images are judged by shape, and shape is a heuristic.** When the
  face model has run, media it did not flag is kept masked only if the page describes it as a
  person (`avatar`, `profile`, `passport`, ... in its `alt`, `class` or `src`) or it is small,
  roughly square **and rendered as a circle** — the shape a profile picture has almost
  everywhere and a product thumbnail almost nowhere. Squareness alone was tried first and was
  too broad: it put a shopping home page back to 65 masked regions, nearly all of them product
  tiles. A small, square, right-angled, unlabelled photograph of a face that the model also
  misses will not be masked.

- **Media masking now defers to the face model, which is a deliberate trade.** The DOM rule
  masks every `<img>`/`<video>`/`<canvas>` ≥48px, which is the right fail-closed default when
  no model is available. It is a poor rule when one has run: on Amazon's home page it masked
  **71 regions**, nearly all of them product photos, destroying the visual context the planner
  needs and counting as redaction the page never required. So when the face model has actually
  produced a verdict — not merely been enabled — those blanket regions are dropped and the
  model's boxes are used instead. Amazon then reports **1** masked region; on BBC News the
  model found and masked 2 real faces while leaving the rest of the photography intact.

  The cost is real: a face the model misses on a page where the DOM rule would have covered it
  is now exposed. Media the page itself describes as a person (`avatar`, `profile`, `selfie`,
  `passport`, `id-card`… in its `alt`, `class` or `src`) is kept masked regardless, and if the
  face model fails or is switched off, the blanket rule returns. See
  `filterMediaRegions()` in `extension/detection-orchestrator.js`.

- **Only the visible viewport is tagged.** Set-of-Marks numbers elements against a screenshot,
  so anything below the fold has no mark and the planner cannot see it. For form filling the
  agent now scrolls and re-scans before concluding — without that it filled two fields of six
  on the evaluation fixture and reported the form done. The same is not attempted for arbitrary
  tasks: scrolling a page hunting for something the user did not ask for is how an agent starts
  wandering.

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

- **The local tier is a fallback, not a peer.** A 1.5B model answers in half a second and is
  adequate at "which of these numbered elements", but on a multi-field form it repeatedly
  answered "done" and proposed clicks instead of typing. The guard and the on-device planner
  carry it through — measured, a six-field form still completes — but the further down the
  chain a run falls, the more of the thinking is being done by rules rather than by a model.
  With the hosted tiers available the same task takes fewer steps and needs less correcting.

- **Planning quality is the model's, not ours — but it is now checked.** The client constrains
  *what* can be asked for (a symbolic vault key, an element id), and `repair_plan()` on the
  server plus `agent-guard.js` on the client reject answers that contradict the page or the
  task. That converts most planner mistakes into a corrected action or an honest stop; it does
  not make a weak model into a strong one. The smaller the local model, the more often the
  repair layer is doing the real work — the 1.5B model routinely answers `click` for a field
  that needs typing, and is corrected every time.

- **Some sites refuse automation outright, and that is respected.** Stack Overflow served a
  `/nocaptcha` challenge after two typed queries during a live run. The agent detects a
  verification wall — by URL, by a CAPTCHA widget, or by the page asking to verify a human —
  and stops with an explanation. It does not attempt to solve or evade one; that is the site's
  decision, and the honest response is to hand the page back to you.

- **A structured search widget is not a search box.** "search for flights to goa" on MakeMyTrip
  types into a journey planner that wants an origin, a destination and a date, not a free-text
  query. The agent runs a search — the site's own default one — and reports honestly that the
  query did not land, because it did not. Mapping a sentence onto a domain-specific widget
  needs knowledge of that widget, which is exactly the site-specific coupling this codebase
  avoids everywhere else.

- **Some sites still defeat the search escalation.** Five routes are tried in order (Enter, form
  submit, the neighbouring control, opening the site's search affordance, then the site's
  published OpenSearch URL). A site that exposes none of these — a search implemented purely
  as a scripted overlay with no form, no submit control and no descriptor — leaves the query
  typed but unrun. The agent reports that outcome explicitly rather than claiming success:
  `"Typed … — the page has not run the search."`

- **Cookie banners are dismissed automatically, and that includes clicking "accept".** A
  consent wall intercepts every click beneath it, so leaving it up makes the agent unusable on
  much of the web. The rules are narrow:

  - Only inside an element that is actually covering the page (a dialog, or a large fixed
    high-z-index layer).
  - **Closing** — close, dismiss, not now, skip, × — is allowed on any overlay.
  - **Agreeing** — accept, allow all, I agree, got it, OK, continue — is allowed *only* on an
    overlay whose own text mentions cookies, consent, tracking, GDPR or privacy choices. An
    "I agree" on a terms-of-service gate is a decision with consequences and is left to you.
  - Never anything matching sign-in / sign-up / subscribe / buy / pay / checkout / delete.
  - Never inside an overlay about payment, orders, billing or deletion, whatever its buttons
    say — a "Continue" in a purchase confirmation is not a cookie banner.
  - Whatever it pressed is named in the activity log.
  - It can be switched off entirely under Settings.

  It is still a consent decision made on your behalf, so it is a setting you can switch off.

- **Per-step latency is dominated by the planner** (seconds per call for a hosted model), not by
  the local pipeline (~1.8s once per step). The local Ollama tier is the fastest of the three
  models at ~0.6s, provided the installed model is small; a 14B model on CPU takes ~40s per
  plan and is not usable in the loop.

- **The free tiers run out.** During this work Gemini returned HTTP 429 for an entire session
  and Groq's vision model exhausted its daily token budget. Nothing failed, because the chain
  degrades — but it is why the local tier exists rather than being a nicety.

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

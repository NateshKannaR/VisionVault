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

- **The same gap applies to page content the agent reads.** `page-reader.js` scrubs every string
  it extracts against the same PII patterns (email, phone, card, Aadhaar, PAN, passport, IFSC,
  UPI, SSN) and drops whole table columns whose header names a sensitive field, but a personal
  name sitting in an unlabelled `<div>` matches nothing and would travel with the page content.
  Reading only happens on a `read` milestone, so it is not on every step — but on such a step
  this is a wider channel than geometry alone, and it is the honest cost of being able to
  compare and choose at all.

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
  is now exposed. Media the page itself describes as a person is kept masked regardless, and if
  the face model fails or is switched off, the blanket rule returns. See `filterMediaRegions()`
  in `extension/detection-orchestrator.js`.

- **The transmitted image is downscaled to 1280px wide.** Redaction is applied at full capture
  resolution first, so nothing is smuggled through by the resize — but on a HiDPI display the
  image a planner sees has less detail than the screen did. That is deliberate: the planner is
  choosing among numbered marks, not reading fine print, and the full-resolution PNG was roughly
  four times the bytes on every step.

- **Only the visible viewport is tagged.** Set-of-Marks numbers elements against a screenshot,
  so anything below the fold has no mark and the planner cannot see it. For form filling the
  agent scrolls and re-scans before concluding — without that it filled two fields of six on the
  evaluation fixture and reported the form done. For everything else there is `scroll_to`, which
  brings a named item into view so the next scan can tag it; a planner has to ask for it.

- **CSS `background-image` is a DOM blind spot.** The media rule only covers real media
  elements. Text baked into a background image is invisible to every DOM rule and is reached
  only by OCR — which is why disabling OCR takes recall on `pixel-receipt.html` to zero.

- **Adversarial and obfuscated interfaces can evade detection.** Custom-drawn canvas UIs,
  deliberately unlabelled fields, text split across elements, and non-English PII formats are
  all outside what these heuristics reliably catch.

- **OCR is English-only as shipped**, and weaker on stylised fonts, low contrast, and small
  text. See the raster-size table in `extension/vision/README.md`.

- **Listings are found by shape, which is general but not universal.** `page-reader.js` looks
  for three or more sibling elements that share a tag and class and each contain a link or
  heading. That is what a results grid, a product list and a feed all look like, and it needs no
  knowledge of any site — but a listing rendered as one flat run of text, or as a canvas, or
  with every card structurally different, will not be recognised as a listing. The page's
  headings, main text and tables are still read.

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

- **A step re-scans the page, so a long workflow pays the scan cost repeatedly.** A nine-action
  journey performs roughly a dozen scans. That is what makes each step's decision current
  rather than made against a stale snapshot, and it is why the fail-closed rule holds on every
  step and not only the first — but it is the floor under the end-to-end time.

## Agent behaviour

- **Click risk gating is a heuristic over labels**, not a proof. `RISKY_CLICK_RE` covers
  submit/payment/destructive/auth/sharing vocabulary and treats every `<input type="submit">` as
  risky, but a consequential control with an unusual label will be clicked autonomously under
  the default policy. The **Strict** policy confirms every click.

- **A workflow plan is a model's opinion, and models pad.** Asked to plan "search for running
  shoes", a 1.5B local model returned seven milestones including "Fill form" and "Click 'Add to
  cart'" — a plausible shopping journey for a task that asked only to search. Two rules bound
  this: a task the deterministic decomposition sees as one or two stages uses that decomposition
  rather than the model's, and any milestone about buying, filling or scrolling is dropped
  unless the user's own words call for it. Neither rule can catch an invented milestone that
  *sounds* like the task, so the plan is shown in the panel before and during the run.

- **The plan is made once, at the start.** Milestones are skipped when a page cannot satisfy
  them and the workflow carries on, but the agent does not re-plan mid-run — a task whose right
  shape only becomes apparent three pages in will finish the plan it started with. What it does
  have is the **Modify** button: rejecting an action and typing what to do instead puts that
  instruction in front of the planner on the next step.

- **A milestone that is skipped is not a milestone that is done.** The completion card names
  each one and why, and the outcome is reported as *partial* rather than *success*. It is worth
  reading: a run can perform nine actions, look busy, and still have skipped the step that
  mattered.

- **The local tier is a fallback, not a peer.** A 1.5B model answers in half a second and is
  adequate at "which of these numbered elements", but on a multi-field form it repeatedly
  answered "done" and proposed clicks instead of typing. The guard and the on-device planner
  carry it through — measured, a six-field form still completes — but the further down the
  chain a run falls, the more of the thinking is being done by rules rather than by a model.

- **Planning quality is the model's, not ours — but it is now checked.** The client constrains
  *what* can be asked for (a symbolic vault key, an element id, a milestone-appropriate verb),
  and `repair_plan()` on the server plus `agent-guard.js` on the client reject answers that
  contradict the page or the task. That converts most planner mistakes into a corrected action
  or an honest stop; it does not make a weak model into a strong one.

- **Choosing "the best" is a documented rule, not judgement.** `pickBestItem()` sorts by rating
  descending, then price ascending, inside any budget stated in the task or the preferences. It
  does not read specifications, weigh brand reputation, or notice that a 4.7 from 2,310 ratings
  is worth more than a 4.7 from 12. When the model tiers are answering they can do better; the
  rule is what runs when they are not.

- **Some sites refuse automation outright, and that is respected.** Stack Overflow served a
  `/nocaptcha` challenge after two typed queries during a live run. The agent detects a
  verification wall — by URL, by a CAPTCHA widget, or by the page asking to verify a human —
  and hands the page back with an explanation and a Continue button. It does not attempt to
  solve or evade one.

- **File uploads need a person.** A content script cannot put a file into `<input type="file">`;
  the browser forbids it, for good reasons. The agent detects the case and asks.

- **A structured search widget is not a search box.** "search for flights to goa" on MakeMyTrip
  types into a journey planner that wants an origin, a destination and a date, not a free-text
  query. The agent runs the site's own default search and reports honestly that the query did
  not land, because it did not. Mapping a sentence onto a domain-specific widget needs knowledge
  of that widget, which is exactly the site-specific coupling this codebase avoids everywhere.

- **Some sites still defeat the search escalation.** Five routes are tried in order (Enter, form
  submit, the neighbouring control, opening the site's search affordance, then the site's
  published OpenSearch URL). A site that exposes none of these leaves the query typed but unrun.
  The agent reports that outcome explicitly rather than claiming success.

- **Cookie banners are dismissed automatically, and that includes clicking "accept".** A consent
  wall intercepts every click beneath it, so leaving it up makes the agent unusable on much of
  the web. The rules are narrow: only inside something actually covering the page; **closing**
  is allowed anywhere; **agreeing** only on an overlay whose own text mentions cookies, consent,
  tracking, GDPR or privacy choices; never anything matching sign-in / sign-up / subscribe /
  buy / pay / checkout / delete; never inside an overlay about payment, orders or deletion,
  whatever its buttons say. Whatever it pressed is named in the activity log. It is still a
  consent decision made on your behalf, so it is a setting you can switch off.

- **Site memory is per origin and label-only**, and it is a convenience rather than learning.
  It records which search box worked and which banner was closed, so a repeat visit takes fewer
  steps. It does not learn a site's structure, and it is cleared by Settings → Forget.

- **The hosted tiers run out, and the chain is bounded rather than fast.** During this work
  Gemini returned HTTP 429 for entire sessions and Groq's vision model rejected its own JSON.
  Nothing failed, because the chain degrades — but a step where both hosted tiers are tried and
  fail costs up to `STEP_PLAN_BUDGET_S` (12s) before the local tier answers. The circuit breaker
  removes a failing tier after two consecutive duds, so that cost is paid twice, not every step.

## Evaluation

- **Fixtures are synthetic.** Seven annotated pages with generated portraits and generated
  receipt imagery; they are representative of forms, dashboards, checkouts, feeds, product
  listings and pixel-only content, but they are not a random sample of the web.

- **The journey fixture has a knowable right answer, which real sites do not.**
  `verify-journey.js` asserts that the agent picks Vertex 16 Slim — the best-rated laptop inside
  the stated budget — because on `shop-results.html` that is a fact. No equivalent assertion is
  possible against a live retailer whose catalogue changes hourly, so the live-site suite
  measures whether the task's own goal was reached, not whether a particular product was chosen.

- **Live-site runs are read-only.** The 22 sites are searched, scrolled and read; nothing is
  purchased, submitted or logged into. The transactional half of the workflow is exercised
  against the fixture, where a cart can be inspected and nobody's account is touched.

- **Ground truth is the fixtures' own annotations.** `data-gt-pii` / `data-gt-safe` /
  `data-gt-mark` encode a judgement about what is sensitive. Unannotated regions are neither
  credited nor penalised, so precision measures "did it mask something marked safe", not "did
  it mask anything unnecessary at all".

- **The evaluation drives a real Chrome window on the tester's desktop.** It re-anchors scroll
  and re-reads ground truth before every scan, because a stray scroll event previously shifted
  a whole run and registered as a total detection failure that had not happened.

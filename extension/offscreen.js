/**
 * offscreen.js — Chrome MV3 Offscreen Inference Host
 *
 * Hosts local ONNX Runtime Web (UltraFace) and Tesseract.js OCR inference
 * outside the service worker to comply with MV3 CSP and lifecycle constraints.
 */

(function () {
  console.log("[vision] Offscreen inference host initialized.");

  // Pre-warm detectors in background
  Promise.all([
    globalThis.FaceDetector?.initFaceDetector?.().catch(e => console.warn("[vision] Face detector warmup error:", e)),
    globalThis.OCRDetector?.initOCRWorker?.().catch(e => console.warn("[vision] OCR worker warmup error:", e))
  ]).then(() => {
    console.log("[vision] All local vision models warmed up and ready.");
  });

  /**
   * Processes a screenshot for Face and OCR PII detection and merges with DOM regions.
   */
  async function handleDetectPII(payload = {}) {
    const {
      rawScreenshot,
      domRegions = [],
      viewportWidth = 0,
      viewportHeight = 0,
      devicePixelRatio = 1,
      enableOCR = true,
      enableFaceDetection = true
    } = payload;

    if (!rawScreenshot) {
      return {
        faceBoxes: [],
        ocrRegions: [],
        mergedRegions: domRegions || [],
        timings: { face: 0, ocr: 0, visionInference: 0, merge: 0 }
      };
    }

    const tStart = performance.now();

    // Decode screenshot image once
    const blob = await (await fetch(rawScreenshot)).blob();
    const bitmap = await createImageBitmap(blob);

    const vpW = viewportWidth || (bitmap.width / (devicePixelRatio || 1));
    const vpH = viewportHeight || (bitmap.height / (devicePixelRatio || 1));

    const options = {
      viewportWidth: vpW,
      viewportHeight: vpH,
      targetWidth: vpW,
      targetHeight: vpH,
      devicePixelRatio: devicePixelRatio || 1
    };

    // Run Face detection and OCR detection in parallel. Either can be switched off by the
    // user to trade coverage for latency; a disabled detector contributes nothing and costs
    // nothing, and the DOM pass still runs.
    const [faceResult, ocrResult] = await Promise.all([
      enableFaceDetection
        ? globalThis.FaceDetector.detectFaces(bitmap, options).catch(err => {
            console.warn("[vision] Face detection failed:", err);
            return { boxes: [], inferenceMs: 0, totalMs: 0, backend: "error" };
          })
        : Promise.resolve({ boxes: [], inferenceMs: 0, totalMs: 0, backend: "disabled" }),
      enableOCR
        ? globalThis.OCRDetector.detectOCR(bitmap, options).catch(err => {
            console.warn("[vision] OCR detection failed:", err);
            return { regions: [], text: "", inferenceMs: 0, totalMs: 0 };
          })
        : Promise.resolve({ regions: [], text: "", inferenceMs: 0, totalMs: 0, skipped: true })
    ]);

    bitmap.close();

    // Merge DOM, Face, and OCR detection regions
    const tMergeStart = performance.now();
    const merged = globalThis.mergeRegions(domRegions, faceResult.boxes || [], ocrResult.regions || []);
    const mergeMs = Math.round(performance.now() - tMergeStart);

    const totalVisionMs = Math.round(performance.now() - tStart);

    console.log(`[vision] Pipeline summary: ${domRegions.length} DOM + ${faceResult.boxes.length} Face + ${ocrResult.regions.length} OCR -> ${merged.length} Merged PII Regions in ${totalVisionMs}ms`);

    return {
      faceBoxes: faceResult.boxes || [],
      ocrRegions: ocrResult.regions || [],
      mergedRegions: merged,
      detectorsEnabled: { face: enableFaceDetection, ocr: enableOCR },
      // Did the models actually produce a verdict? "enabled" is what the user asked for;
      // this is what happened. Downstream decisions that relax a fail-closed default must
      // depend on the second, never the first.
      faceOk: enableFaceDetection && faceResult.backend !== "error",
      ocrOk: enableOCR && !ocrResult.skipped,
      timings: {
        faceInference: faceResult.inferenceMs || 0,
        ocrInference: ocrResult.inferenceMs || 0,
        visionInference: totalVisionMs,
        merge: mergeMs
      }
    };
  }

  // Message router for offscreen document
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== "offscreen") return false;

    if (msg.type === "PING") {
      sendResponse({ ok: true, status: "ready" });
      return true;
    }

    if (msg.type === "DETECT_PII") {
      handleDetectPII(msg.payload)
        .then(result => sendResponse({ ok: true, result }))
        .catch(err => {
          console.error("[vision] Detection error in offscreen host:", err);
          sendResponse({ ok: false, error: err.message || String(err) });
        });
      return true; // async
    }

    return false;
  });
})();

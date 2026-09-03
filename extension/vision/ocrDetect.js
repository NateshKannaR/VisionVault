/**
 * ocrDetect.js — Offline OCR-based PII Detection via bundled Tesseract.js
 *
 * Engine: Tesseract.js v5 (WASM core + fast English traineddata, bundled offline)
 * Detects: emails, phone numbers, card numbers, SSNs, Aadhaar, PAN, passport, IFSC, UPI IDs
 * Output: Array of { x, y, w, h, type: "text", reason: "ocr_pii_match", label, text, confidence }
 *
 * RASTER SIZE — the accuracy/latency trade-off, measured, not guessed.
 * `node eval/ocr-tuning.js admin-dashboard.html` on a 1200x820 viewport capture:
 *
 *     raster   preprocessing   recognise   PII strings recovered
 *      640px   threshold          1266ms   1
 *      900px   threshold          1183ms   2
 *     1280px   none               1554ms   10
 *     1600px   none               1615ms   10   (upscaling; no further gain)
 *
 * Body text at 14px falls below Tesseract's legibility floor once the page is scaled under
 * ~1200px, so the aggressive 640px downscale that used to be the default returned almost
 * nothing while still costing over a second. DEFAULT_MAX_DIMENSION is therefore 1280: it
 * recovers everything the larger raster does, for ~250ms more than the useless small one.
 * Callers that need a faster, shallower pass can pass a smaller `maxDimension`.
 */

(function (global) {
  const EMAIL_RE    = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE    = /(\+?\d[\d\s\-().]{7,}\d)/g;
  const CARD_RE     = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;
  const SSN_RE      = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
  const AADHAAR_RE  = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;
  const PAN_RE      = /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g;
  const PASSPORT_RE = /\b[A-Z][0-9]{7}\b/g;
  const IFSC_RE     = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
  const UPI_RE      = /\b[a-zA-Z0-9.\-_]{2,40}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|axl|upi)\b/gi;

  // Values that are sensitive because of the words printed next to them, not their shape.
  // A personal name matches no pattern — "Priya Raghavan" is just two capitalised words — so
  // the only way to recognise it in a flattened image is the field label rendered beside it.
  // Capture group 2 is the value; group 1 is the label, which is not itself sensitive.
  const LABELLED_VALUE_RE = /\b(billed to|bill to|invoice to|sold to|customer|client|account holder|card ?holder|patient|employee|member|full name|name|recipient|addressed to|deliver to|ship to)\s*[:\-]\s*([^\r\n]{2,60})/gi;

  const PII_PATTERNS = [
    { label: "email",    regex: EMAIL_RE },
    { label: "card",     regex: CARD_RE },
    { label: "ssn",      regex: SSN_RE },
    { label: "aadhaar",  regex: AADHAAR_RE },
    { label: "pan",      regex: PAN_RE },
    { label: "passport", regex: PASSPORT_RE },
    { label: "ifsc",     regex: IFSC_RE },
    { label: "upi",      regex: UPI_RE },
    { label: "phone",    regex: PHONE_RE },
    // Checked last so a value that already matched a specific pattern keeps that label.
    { label: "labelled_value", regex: LABELLED_VALUE_RE, valueGroup: 2 }
  ];

  // Chosen from the measurements in the file header. Do not lower it without re-running
  // eval/ocr-tuning.js — small rasters silently return zero regions.
  const DEFAULT_MAX_DIMENSION = 1280;

  let tesseractWorker = null;
  let initPromise = null;

  /**
   * Initializes the offline Tesseract.js worker using locally bundled assets.
   */
  async function initOCRWorker() {
    if (tesseractWorker) return tesseractWorker;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const Tesseract = global.Tesseract || (typeof require !== "undefined" ? require("tesseract.js") : null);
      if (!Tesseract || typeof Tesseract.createWorker !== "function") {
        throw new Error("Tesseract.js library not found in global scope.");
      }

      const isExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL;
      const assetUrl = (rel) => (isExtension ? chrome.runtime.getURL(rel) : "./" + rel);

      const workerPath = assetUrl("lib/tesseract/worker.min.js");
      // corePath is given as a DIRECTORY so Tesseract can pick the core variant it wants
      // (SIMD / non-SIMD, LSTM) from the bundled files.
      const corePath = assetUrl("lib/tesseract/");
      const langPath = assetUrl("models/tessdata");

      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath,
        corePath,
        langPath,
        // MUST be false. By default tesseract.js wraps the worker script in a blob: URL, and a
        // blob worker has an opaque origin, so its importScripts() of a chrome-extension:// URL
        // is rejected with a NetworkError. Loading the worker straight from the extension URL
        // keeps it same-origin and allowed.
        workerBlobURL: false,
        gzip: true,
        logger: () => {} // quiet logger
      });

      tesseractWorker = worker;
      console.log("[vision] Tesseract OCR worker initialized offline successfully.");
      return tesseractWorker;
    })();

    return initPromise;
  }

  /**
   * Scans text for PII regex matches.
   */
  function findPiiInText(text) {
    if (!text || typeof text !== "string") return [];
    const results = [];
    const coveredRanges = [];

    const isCovered = (start, end) => {
      return coveredRanges.some(([s, e]) => Math.max(start, s) < Math.min(end, e));
    };

    for (const { label, regex, valueGroup } of PII_PATTERNS) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        // For labelled values, keep only the value itself so the label text is not masked.
        const captured = valueGroup ? (match[valueGroup] || "") : match[0];
        const val = captured.trim();
        const offsetInMatch = valueGroup ? match[0].indexOf(captured) : 0;
        const start = match.index + (offsetInMatch > 0 ? offsetInMatch : 0);
        const end = start + captured.length;

        if (val.length >= 4 && !isCovered(start, end)) {
          // Filter common false positives for phone/card (e.g. isolated years or small numbers)
          if (label === "phone" && val.replace(/\D/g, "").length < 8) continue;
          if (label === "card" && val.replace(/\D/g, "").length < 13) continue;
          // A labelled value must look like a value, not a sentence fragment.
          if (label === "labelled_value" && (val.split(/\s+/).length > 6 || /[.?!]$/.test(val))) continue;

          results.push({
            label,
            text: val,
            index: start,
            length: val.length
          });
          coveredRanges.push([start, end]);
        }
      }
    }
    return results;
  }

  /**
   * Runs OCR detection on a screenshot or image canvas.
   *
   * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement|string} imageSource
   * @param {Object} options - { viewportWidth, viewportHeight, maxDimension }
   * @returns {Promise<{ regions: Array, text: string, inferenceMs: number }>}
   */
  async function detectOCR(imageSource, options = {}) {
    const t0 = performance.now();
    let worker;
    try {
      worker = await initOCRWorker();
    } catch (err) {
      console.warn("[vision] OCR worker unavailable, skipping OCR detection:", err.message || err);
      return { regions: [], text: "", inferenceMs: 0 };
    }

    let bitmap = imageSource;
    let needClose = false;

    if (typeof imageSource === "string" && imageSource.startsWith("data:")) {
      const blob = await (await fetch(imageSource)).blob();
      bitmap = await createImageBitmap(blob);
      needClose = true;
    }

    const origW = (bitmap && (bitmap.width || bitmap.naturalWidth || bitmap.videoWidth)) || 1280;
    const origH = (bitmap && (bitmap.height || bitmap.naturalHeight || bitmap.videoHeight)) || 720;

    // Only downscale when the capture is larger than the working raster; see the header table.
    const maxDim = options.maxDimension || DEFAULT_MAX_DIMENSION;
    let scale = 1.0;
    let ocrW = origW;
    let ocrH = origH;

    if (origW > maxDim || origH > maxDim) {
      scale = Math.min(maxDim / origW, maxDim / origH);
      ocrW = Math.round(origW * scale);
      ocrH = Math.round(origH * scale);
    }

    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(ocrW, ocrH)
      : document.createElement("canvas");
    canvas.width = ocrW;
    canvas.height = ocrH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, ocrW, ocrH);

    // Adaptive contrast preprocessing. It measurably helps a downscaled raster recover
    // characters, and makes no difference at full resolution (see the header table), so it is
    // applied only when the image was actually scaled down — saving a full-image pass otherwise.
    if (scale < 0.999) {
      try {
        const imgData = ctx.getImageData(0, 0, ocrW, ocrH);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const val = gray > 170 ? 255 : (gray < 75 ? 0 : gray);
          d[i] = val;
          d[i + 1] = val;
          d[i + 2] = val;
        }
        ctx.putImageData(imgData, 0, 0);
      } catch (e) {}
    }

    const tOcrStart = performance.now();
    let ocrData = null;
    try {
      // Budget: full-viewport recognition on a 640px-wide raster takes roughly 400-900 ms on a
      // mid-range laptop. The previous 1.2 s cap fired mid-recognition and silently returned
      // zero regions, so OCR contributed nothing. Callers can tighten this per call.
      const budgetMs = options.timeoutMs || 8000;
      const ocrTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("OCR_TIMEOUT")), budgetMs));
      const result = await Promise.race([
        worker.recognize(canvas),
        ocrTimeout
      ]);
      ocrData = result.data;
    } catch (e) {
      console.warn("[vision] OCR recognition aborted:", e.message || e);
      if (needClose && bitmap && typeof bitmap.close === "function") bitmap.close();
      return { regions: [], text: "", inferenceMs: Math.round(performance.now() - tOcrStart), error: String(e.message || e) };
    }
    const inferenceMs = Math.round(performance.now() - tOcrStart);

    const fullText = ocrData.text || "";
    const words = ocrData.words || [];
    const lines = ocrData.lines || [];
    const piiRegions = [];

    // Target viewport coordinates
    const vpW = options.viewportWidth || origW;
    const vpH = options.viewportHeight || origH;
    const toVpX = vpW / (ocrW || 1);
    const toVpY = vpH / (ocrH || 1);

    // 1. Line-level PII checks (for multi-word matches like phone numbers, formatted cards)
    for (const line of lines) {
      const lineText = line.text || "";
      const matches = findPiiInText(lineText);

      for (const m of matches) {
        // Find the word boxes that compose this match.
        //
        // Words are selected by CHARACTER SPAN, not by fuzzy text similarity. The previous
        // approach required a word to have more than two alphanumeric characters, which
        // silently dropped short but meaningful fragments — a phone number's "+91" country
        // code was excluded from its own bounding box and stayed legible in the redacted
        // image. Walking offsets is exact and has no such blind spot.
        const lineWords = line.words || [];
        let cursor = 0;
        const wordSpans = lineWords.map((w) => {
          const t = w.text || "";
          const found = lineText.indexOf(t, cursor);
          const start = found === -1 ? cursor : found;
          cursor = start + t.length;
          return { word: w, start, end: start + t.length };
        });

        const matchStart = m.index;
        const matchEnd = m.index + m.length;
        const matchedWords = wordSpans
          .filter((s) => s.start < matchEnd && s.end > matchStart)
          .map((s) => s.word)
          .filter((w) => w && w.bbox);

        let box;
        if (matchedWords.length > 0) {
          const x0 = Math.min(...matchedWords.map(w => w.bbox.x0));
          const y0 = Math.min(...matchedWords.map(w => w.bbox.y0));
          const x1 = Math.max(...matchedWords.map(w => w.bbox.x1));
          const y1 = Math.max(...matchedWords.map(w => w.bbox.y1));
          box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        } else if (line.bbox) {
          box = {
            x: line.bbox.x0,
            y: line.bbox.y0,
            w: line.bbox.x1 - line.bbox.x0,
            h: line.bbox.y1 - line.bbox.y0
          };
        }

        if (box) {
          const rx = Math.max(0, Math.round(box.x * toVpX));
          const ry = Math.max(0, Math.round(box.y * toVpY));
          const rw = Math.max(8, Math.round(box.w * toVpX));
          const rh = Math.max(8, Math.round(box.h * toVpY));

          // Check if already added
          const dup = piiRegions.some(r => Math.abs(r.x - rx) < 10 && Math.abs(r.y - ry) < 10);
          if (!dup) {
            piiRegions.push({
              x: rx,
              y: ry,
              w: rw,
              h: rh,
              type: "text",
              reason: "ocr_pii_match",
              label: m.label,
              text: m.text,
              confidence: 0.85,
              source: "vision_ocr"
            });
          }
        }
      }
    }

    // 2. Word-level PII checks (for standalone emails, numbers)
    for (const word of words) {
      const wordText = word.text || "";
      const matches = findPiiInText(wordText);

      for (const m of matches) {
        const bbox = word.bbox;
        if (!bbox) continue;

        const rx = Math.max(0, Math.round(bbox.x0 * toVpX));
        const ry = Math.max(0, Math.round(bbox.y0 * toVpY));
        const rw = Math.max(8, Math.round((bbox.x1 - bbox.x0) * toVpX));
        const rh = Math.max(8, Math.round((bbox.y1 - bbox.y0) * toVpY));

        const dup = piiRegions.some(r => Math.abs(r.x - rx) < 10 && Math.abs(r.y - ry) < 10);
        if (!dup) {
          piiRegions.push({
            x: rx,
            y: ry,
            w: rw,
            h: rh,
            type: "text",
            reason: "ocr_pii_match",
            label: m.label,
            text: m.text,
            confidence: Math.round((word.confidence || 85)) / 100,
            source: "vision_ocr"
          });
        }
      }
    }

    if (needClose && bitmap && typeof bitmap.close === "function") {
      bitmap.close();
    }

    const totalMs = Math.round(performance.now() - t0);
    console.log(`[vision] OCR detection: found ${piiRegions.length} PII text region(s) in ${inferenceMs}ms (total: ${totalMs}ms)`);

    return {
      regions: piiRegions,
      text: fullText,
      inferenceMs,
      totalMs
    };
  }

  const OCRDetector = {
    initOCRWorker,
    detectOCR,
    findPiiInText,
    PII_PATTERNS
  };

  global.OCRDetector = OCRDetector;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = OCRDetector;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

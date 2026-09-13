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
  // ── Indic numerals ─────────────────────────────────────────────────────────
  //
  // An Aadhaar printed as आधार २३४५ ६७८९ ०१२३ is an Aadhaar. Every pattern below is written
  // in [0-9], so without this step a page in Devanagari, Tamil or Bengali defeats the whole
  // detector while looking, in the logs, exactly like a page with no PII on it.
  //
  // The mapping is one code point to one code point, which is what makes it safe here:
  // callers use `index` and `length` to find the OCR word box that produced a match, so a
  // substitution that changed the string's length would misplace every redaction rectangle
  // after it.
  const INDIC_DIGITS = {
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",  // Devanagari
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
    "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4",  // Bengali
    "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9",
    "૦": "0", "૧": "1", "૨": "2", "૩": "3", "૪": "4",  // Gujarati
    "૫": "5", "૬": "6", "૭": "7", "૮": "8", "૯": "9",
    "୦": "0", "୧": "1", "୨": "2", "୩": "3", "୪": "4",  // Odia
    "୫": "5", "୬": "6", "୭": "7", "୮": "8", "୯": "9",
    "௦": "0", "௧": "1", "௨": "2", "௩": "3", "௪": "4",  // Tamil
    "௫": "5", "௬": "6", "௭": "7", "௮": "8", "௯": "9",
    "౦": "0", "౧": "1", "౨": "2", "౩": "3", "౪": "4",  // Telugu
    "౫": "5", "౬": "6", "౭": "7", "౮": "8", "౯": "9",
    "೦": "0", "೧": "1", "೨": "2", "೩": "3", "೪": "4",  // Kannada
    "೫": "5", "೬": "6", "೭": "7", "೮": "8", "೯": "9",
    "൦": "0", "൧": "1", "൨": "2", "൩": "3", "൪": "4",  // Malayalam
    "൫": "5", "൬": "6", "൭": "7", "൮": "8", "൯": "9",
    "੦": "0", "੧": "1", "੨": "2", "੩": "3", "੪": "4",  // Gurmukhi
    "੫": "5", "੬": "6", "੭": "7", "੮": "8", "੯": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",  // Arabic-Indic
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9"
  };
  const INDIC_DIGIT_RE = /[०-९০-৯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯੦-੯٠-٩]/g;

  /** ASCII digits, same length, so match offsets still address the original string. */
  function normalizeDigits(text) {
    if (!INDIC_DIGIT_RE.test(text)) { INDIC_DIGIT_RE.lastIndex = 0; return text; }
    INDIC_DIGIT_RE.lastIndex = 0;
    return text.replace(INDIC_DIGIT_RE, (d) => INDIC_DIGITS[d] || d);
  }

  function cleanOcrDigits(str) {
    if (!str || typeof str !== "string") return "";
    return str
      .replace(/[Il|!\]\[]/g, "1")
      .replace(/[OoQ]/g, "0")
      .replace(/[Ss]/g, "5")
      .replace(/[Bb]/g, "8")
      .replace(/[Zz]/g, "2");
  }

  const EMAIL_RE    = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE    = /(\+?\d[\d\s\-().]{7,}\d)/g;
  const CARD_RE     = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;
  const SSN_RE      = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
  // Separators are whatever the site chose, plus the wider gaps OCR tends to read out of printed cards.
  const AADHAAR_RE  = /\b[1-9]\d{3}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}\b/g;
  // The 16-digit virtual ID stands in for the Aadhaar itself and is exactly as sensitive.
  const VID_RE      = /\b\d{4}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4}\b/g;
  const PAN_RE      = /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g;
  const PASSPORT_RE = /\b[A-Z][0-9]{7}\b/g;
  const IFSC_RE     = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
  const UPI_RE      = /\b[a-zA-Z0-9.\-_]{2,40}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|axl|upi)\b/gi;
  // State code, RTO code, then year and serial: TN-01-2011-0012345
  const DL_RE       = /\b[A-Z]{2}[-\s]?\d{2}[-\s]?\d{4}[-\s]?\d{7}\b|\b[A-Z]{2}[-\s]?\d{2}[-\s]?\d{11}\b/g;
  const VEHICLE_RE  = /\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b/g;
  const ACCOUNT_RE  = /\b(?:a\/c|acc(?:oun)?t(?:\s*(?:no|number|#))?|bank\s*a\/?c)\s*[:.#-]?\s*(\d{9,18})\b/gi;

  // DOB & Gender patterns common on Indian national IDs
  const DOB_RE      = /\b(?:dob|date of birth|year of birth|birth|d\.o\.b)?[\s:/-]*((?:0?[1-9]|[12]\d|3[01])[\s/.-](?:0?[1-9]|1[0-2])[\s/.-](?:19|20)\d{2}|(?:19|20)\d{2}[\s/.-](?:0?[1-9]|1[0-2])[\s/.-](?:0?[1-9]|[12]\d|3[01]))\b/gi;
  const GENDER_RE   = /\b(male|female|transgender|पुरुष|महिला)\b/gi;

  // Name patterns on identity cards (e.g. "SAMARTH SHARMA", "JOHN DOE")
  const ID_NAME_RE  = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}|[A-Z]{3,}(?:\s+[A-Z]{2,}){1,3})\b/g;

  // Values that are sensitive because of the words printed next to them, not their shape.
  const LABELLED_VALUE_RE = /\b(billed to|bill to|invoice to|sold to|customer|client|account holder|card ?holder|patient|employee|member|full name|name|operator on duty|operator|duty|mission id|mission|officer|supervisor|pilot|commander|technician|personnel|satellite name|satellite|orbit type|launch date|orbital inclination|apogee|perigee|tle line 1|tle line 2|tle|ground station freq|ground station|encryption key ref|encryption key|encryption|recipient|addressed to|deliver to|ship to)\s*[:\-]\s*([^\r\n]{2,60})/gi;

  const PII_PATTERNS = [
    { label: "email",    regex: EMAIL_RE },
    { label: "card",     regex: CARD_RE },
    { label: "ssn",      regex: SSN_RE },
    { label: "vid",      regex: VID_RE },
    { label: "aadhaar",  regex: AADHAAR_RE },
    { label: "pan",      regex: PAN_RE },
    { label: "dob",      regex: DOB_RE },
    { label: "gender",   regex: GENDER_RE },
    { label: "driving_licence", regex: DL_RE },
    { label: "vehicle_reg", regex: VEHICLE_RE },
    { label: "bank_account", regex: ACCOUNT_RE, valueGroup: 1 },
    { label: "passport", regex: PASSPORT_RE },
    { label: "ifsc",     regex: IFSC_RE },
    { label: "upi",      regex: UPI_RE },
    { label: "phone",    regex: PHONE_RE },
    { label: "labelled_value", regex: LABELLED_VALUE_RE, valueGroup: 2 }
  ];

  // Recognition languages, most-likely first. Devanagari covers Hindi and Marathi, which is
  // where an Indian document is most likely to print an identifier in non-Latin digits.
  // A language whose traineddata is missing makes createWorker throw, taking OCR down
  // entirely, so initOCRWorker falls back to English alone rather than losing the stage.
  const OCR_LANGUAGES = "eng+hin";
  const OCR_FALLBACK_LANGUAGE = "eng";

  // Chosen from the measurements in the file header. Do not lower it without re-running
  // eval/ocr-tuning.js — small rasters silently return zero regions.
  const DEFAULT_MAX_DIMENSION = 1280;

  let tesseractWorker = null;
  let initPromise = null;
  // Which languages the worker actually came up with, so callers and tests can tell a
  // Devanagari-capable build from one that quietly fell back to English.
  let activeLanguages = null;

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

      // Devanagari is a second recognition language, not a replacement. An Aadhaar printed on
      // a card in Devanagari is invisible to an English-only model: it is not that the digits
      // are misread, it is that the engine has no glyphs for them and returns nothing, so the
      // page reports clean. Normalising Indic digits (see normalizeDigits) fixes the DOM path
      // but cannot help here — there is no text to normalise until Tesseract produces some.
      //
      // The cost is real: a second language roughly doubles recognition time. That is
      // affordable now only because detection-orchestrator caches the vision result against
      // the captured pixels, so it is paid once per distinct screen rather than once per
      // agent step. If that cache is ever removed, revisit this.
      const options = {
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
      };

      // Degrade, do not fail. If hin.traineddata is absent or unreadable, createWorker rejects
      // and — without this — the whole OCR stage goes down, taking English detection with it.
      // Losing Devanagari coverage is a gap; losing OCR entirely is a leak.
      let worker;
      let activeLangs = OCR_LANGUAGES;
      try {
        worker = await Tesseract.createWorker(OCR_LANGUAGES, 1, options);
      } catch (langErr) {
        if (OCR_LANGUAGES === OCR_FALLBACK_LANGUAGE) throw langErr;
        console.warn(`[vision] OCR language set "${OCR_LANGUAGES}" unavailable (${langErr && langErr.message || langErr}); ` +
                     `falling back to "${OCR_FALLBACK_LANGUAGE}". Text in Devanagari will not be read.`);
        activeLangs = OCR_FALLBACK_LANGUAGE;
        worker = await Tesseract.createWorker(OCR_FALLBACK_LANGUAGE, 1, options);
      }

      tesseractWorker = worker;
      activeLanguages = activeLangs;
      console.log(`[vision] Tesseract OCR worker initialized offline (${activeLangs}).`);
      return tesseractWorker;
    })();

    // Same reasoning as the face detector: a rejected promise left in the cache turns one
    // transient failure into a permanently disabled detector for the rest of the session.
    initPromise.catch((err) => {
      console.warn("[vision] Tesseract init failed; will retry on the next scan:", err);
      initPromise = null;
      tesseractWorker = null;
    });

    return initPromise;
  }

  /**
   * Scans text for PII regex matches.
   */
  function findPiiInText(text) {
    if (!text || typeof text !== "string") return [];
    // Matching runs against ASCII digits; `text` itself is kept for the reported value so the
    // caller still sees what was actually on the page. The substitution is length-preserving,
    // so offsets address both strings identically.
    const haystack = normalizeDigits(text);
    const results = [];
    const coveredRanges = [];

    const isCovered = (start, end) => {
      return coveredRanges.some(([s, e]) => Math.max(start, s) < Math.min(end, e));
    };

    for (const { label, regex, valueGroup } of PII_PATTERNS) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(haystack)) !== null) {
        // For labelled values, keep only the value itself so the label text is not masked.
        const captured = valueGroup ? (match[valueGroup] || "") : match[0];
        const offset0 = valueGroup ? match[0].indexOf(captured) : 0;
        const rawStart = match.index + (offset0 > 0 ? offset0 : 0);
        // Two views of the same span. Decisions below count ASCII digits, so they use the
        // normalized form; the reported value is the glyphs actually printed on the page, so
        // a Devanagari number is not silently rewritten in the audit trail.
        const val = captured.trim();
        const rawVal = (text.substr(rawStart, captured.length).trim() || val);
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
            text: rawVal,
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

    // 3. Multi-word Sliding Window checks (detects numbers and names split across word tokens)
    const windowSizes = [2, 3, 4, 5];
    for (const k of windowSizes) {
      for (let i = 0; i <= words.length - k; i++) {
        const slice = words.slice(i, i + k);
        const avgH = slice.reduce((acc, w) => acc + (w.bbox ? w.bbox.y1 - w.bbox.y0 : 0), 0) / k;
        const minY = Math.min(...slice.map(w => w.bbox ? w.bbox.y0 : 0));
        const maxY = Math.max(...slice.map(w => w.bbox ? w.bbox.y1 : 0));
        if (maxY - minY > avgH * 2.2) continue; // Words are on different lines

        const combinedRaw = slice.map(w => w.text || "").join(" ");
        const combinedClean = cleanOcrDigits(combinedRaw);

        const matches = [...findPiiInText(combinedRaw), ...findPiiInText(combinedClean)];
        for (const m of matches) {
          const x0 = Math.min(...slice.map(w => w.bbox ? w.bbox.x0 : 0));
          const y0 = Math.min(...slice.map(w => w.bbox ? w.bbox.y0 : 0));
          const x1 = Math.max(...slice.map(w => w.bbox ? w.bbox.x1 : 0));
          const y1 = Math.max(...slice.map(w => w.bbox ? w.bbox.y1 : 0));

          const rx = Math.max(0, Math.round(x0 * toVpX));
          const ry = Math.max(0, Math.round(y0 * toVpY));
          const rw = Math.max(12, Math.round((x1 - x0) * toVpX));
          const rh = Math.max(12, Math.round((y1 - y0) * toVpY));

          const dup = piiRegions.some(r => Math.abs(r.x - rx) < 15 && Math.abs(r.y - ry) < 15);
          if (!dup) {
            piiRegions.push({
              x: rx,
              y: ry,
              w: rw,
              h: rh,
              type: "text",
              reason: "ocr_multiword_pii",
              label: m.label,
              text: m.text || combinedRaw,
              confidence: 0.92,
              source: "vision_ocr"
            });
          }
        }
      }
    }

    // 4. Aadhaar Card & National ID Comprehensive Layout Guard
    // When an Aadhaar card or National ID is identified, redact all cardholder identity fields
    // (Aadhaar number, Name, DOB, Gender, and QR code) so zero personal data leaks.
    const isAadhaarCard = /aadhaar|uidai|government of india|mera aadhaar|unique identification|help@uidai|my aadhaar/i.test(fullText) ||
                          piiRegions.some(r => r.label === "aadhaar" || r.label === "vid");

    if (isAadhaarCard) {
      console.log("[vision] Aadhaar card identity layout detected. Enforcing full card PII coverage.");
      for (const line of lines) {
        const lt = (line.text || "").trim();
        if (!lt) continue;

        // Skip standard non-sensitive card institution headers and slogan
        if (/government of india|bharat sarkar|mera aadhaar|meri pehchan|my aadhaar|unique identification authority/i.test(lt)) {
          continue;
        }

        // On an Aadhaar card, any remaining line with text is cardholder identity data:
        // Name (e.g. SAMARTH SHARMA), DOB, Gender, or UIDAI Number.
        const box = line.bbox;
        if (box) {
          const rx = Math.max(0, Math.round(box.x0 * toVpX));
          const ry = Math.max(0, Math.round(box.y0 * toVpY));
          const rw = Math.max(12, Math.round((box.x1 - box.x0) * toVpX));
          const rh = Math.max(12, Math.round((box.y1 - box.y0) * toVpY));

          const dup = piiRegions.some(r => Math.abs(r.x - rx) < 15 && Math.abs(r.y - ry) < 15);
          if (!dup) {
            piiRegions.push({
              x: rx,
              y: ry,
              w: rw,
              h: rh,
              type: "text",
              reason: "aadhaar_card_field",
              label: "aadhaar_card_pii",
              text: lt,
              confidence: 0.95,
              source: "vision_ocr"
            });
          }
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
    normalizeDigits,
    PII_PATTERNS,
    OCR_LANGUAGES,
    /** Null until the worker has been initialised. */
    activeLanguages: () => activeLanguages
  };

  global.OCRDetector = OCRDetector;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = OCRDetector;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

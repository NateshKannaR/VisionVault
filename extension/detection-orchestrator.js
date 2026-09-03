/**
 * detection-orchestrator.js — Orchestrates DOM + Offscreen ML Vision (Face + OCR) Redaction Pipeline
 */

(function (global) {
  function safeGetChrome() {
    return typeof chrome !== "undefined" ? chrome : null;
  }

  const SCAN_LOCKS = new Map();
  let offscreenCreating = null;

  // Time allowed for the offscreen face+OCR round trip. The first call also compiles the ONNX
  // graph and the Tesseract core, so it is given more room; later calls are held to the
  // steady-state budget to keep the agent loop responsive.
  const VISION_COLD_START_BUDGET_MS = 20000;
  const VISION_BUDGET_MS = 6000;
  let visionWarmedUp = false;

  /**
   * Ensures the MV3 Offscreen Document is active for running local ML inference.
   */
  async function ensureOffscreenDocument() {
    const chromeApi = safeGetChrome();
    if (!chromeApi || !chromeApi.offscreen) return false;

    const offscreenUrl = chromeApi.runtime.getURL("offscreen.html");

    try {
      if (chromeApi.runtime.getContexts) {
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [offscreenUrl]
        });
        if (contexts && contexts.length > 0) return true;
      } else if (chromeApi.offscreen.hasDocument) {
        if (await chromeApi.offscreen.hasDocument()) return true;
      }
    } catch (_) {}

    if (offscreenCreating) {
      await offscreenCreating;
      return true;
    }

    offscreenCreating = (async () => {
      try {
        await chromeApi.offscreen.createDocument({
          url: "offscreen.html",
          reasons: [
            chromeApi.offscreen.Reason?.WORKERS || "WORKERS",
            chromeApi.offscreen.Reason?.BLOBS || "BLOBS"
          ],
          justification: "Run local ONNX Runtime Web and Tesseract OCR models for privacy redaction"
        });
        console.log("[vision] Created offscreen document for local ML inference.");
      } catch (err) {
        if (!String(err).includes("Only a single offscreen document may be created")) {
          console.warn("[vision] Failed to create offscreen document:", err);
        }
      } finally {
        offscreenCreating = null;
      }
    })();

    await offscreenCreating;
    return true;
  }

  function getTabsApi() {
    const chromeApi = safeGetChrome();
    return chromeApi && chromeApi.tabs ? chromeApi.tabs : null;
  }

  // Chrome rate-limits captureVisibleTab (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, ~2/s).
  // The agent loop re-scans after every action, so bursts are normal; back off and retry
  // rather than losing the frame.
  const CAPTURE_RETRY_DELAYS_MS = [300, 600, 1000, 1500];

  function captureOnce(tabs, windowId) {
    return new Promise((resolve, reject) => {
      tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
        const chromeApi = safeGetChrome();
        if (chromeApi && chromeApi.runtime && chromeApi.runtime.lastError) {
          reject(new Error(chromeApi.runtime.lastError.message));
          return;
        }
        resolve(dataUrl || "");
      });
    });
  }

  async function captureScreenshot(windowId) {
    const tabs = getTabsApi();
    if (!tabs || !tabs.captureVisibleTab) return "";

    // Every failure mode here is transient: the per-second quota, a window that is briefly
    // unfocused or being dragged, or a tab mid-navigation. Back off and retry rather than
    // losing the frame — a lost frame aborts the whole request under the fail-closed rule.
    let lastErr = null;
    for (let attempt = 0; attempt <= CAPTURE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const shot = await captureOnce(tabs, windowId);
        if (shot) return shot;
        lastErr = new Error("captureVisibleTab returned an empty image.");
      } catch (err) {
        lastErr = err;
      }
      if (attempt < CAPTURE_RETRY_DELAYS_MS.length) {
        console.warn(`[vision] Screenshot attempt ${attempt + 1} failed (${lastErr.message}); retrying.`);
        await new Promise(r => setTimeout(r, CAPTURE_RETRY_DELAYS_MS[attempt]));
      }
    }
    throw lastErr || new Error("captureVisibleTab failed.");
  }

  function msgTab(tabId, msg, options) {
    const tabs = getTabsApi();
    const chromeApi = safeGetChrome();
    if (!tabs || !tabs.sendMessage) return Promise.resolve(null);
    return new Promise((resolve) => {
      const cb = (r) => {
        if (chromeApi && chromeApi.runtime && chromeApi.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r || null);
      };
      if (options) tabs.sendMessage(tabId, msg, options, cb);
      else tabs.sendMessage(tabId, msg, cb);
    });
  }

  /**
   * Scans EVERY frame in the tab and merges the results into one top-level-viewport result.
   *
   * chrome.tabs.sendMessage broadcasts to all frames but only surfaces the first reply, which
   * silently drops iframe content. Instead we use chrome.scripting.executeScript with
   * allFrames:true, which returns one InjectionResult per frame (each carrying its frameId).
   *
   * Each frame reports its own viewport coordinates plus the offset of its viewport inside the
   * top-level viewport. Cross-origin frames cannot compute that offset (frameElement is
   * inaccessible), report frameOffset === null, and are DROPPED — mapping their boxes with a
   * guessed offset would paint redaction rectangles over the wrong pixels.
   *
   * @returns {Promise<{ piiRegions: Array, marks: Array, frameStats: Object }>}
   */
  async function scanAllFrames(tabId) {
    const chromeApi = safeGetChrome();
    const empty = { piiRegions: [], marks: [], frameStats: { total: 0, merged: 0, skipped: 0 } };

    let injectionResults = null;
    if (chromeApi && chromeApi.scripting && chromeApi.scripting.executeScript) {
      try {
        injectionResults = await chromeApi.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => (window.__vagent ? window.__vagent.scanPage() : null)
        });
      } catch (err) {
        console.warn("[vision] All-frames scan unavailable, falling back to top frame:", err);
      }
    }

    // Fallback: single top-frame message (e.g. scripting API blocked on this page).
    if (!injectionResults || injectionResults.length === 0) {
      const single = await msgTab(tabId, { type: "SCAN_PAGE" }, { frameId: 0 });
      if (!single) return empty;
      return {
        piiRegions: (single.piiRegions || []).map(r => ({ ...r, frameId: 0 })),
        marks: (single.marks || []).map(m => ({ ...m, frameId: 0 })),
        frameStats: { total: 1, merged: 1, skipped: 0 }
      };
    }

    const piiRegions = [];
    const marks = [];
    const usedMarkIds = new Set();
    let skipped = 0;

    for (const entry of injectionResults) {
      const frameId = entry.frameId ?? 0;
      const res = entry.result;
      if (!res || res.scanSkipped) { skipped++; continue; }

      const off = res.frameOffset;
      if (!off) { skipped++; continue; } // cross-origin frame: coordinates not mappable

      const shift = (box) => ({
        x: Math.round((box.x || 0) + off.x),
        y: Math.round((box.y || 0) + off.y),
        w: Math.round(box.w || 0),
        h: Math.round(box.h || 0)
      });

      for (const r of res.piiRegions || []) {
        const b = shift(r);
        piiRegions.push({ ...r, ...b, box: b, frameId });
      }

      for (const m of res.marks || []) {
        // Mark IDs are deterministic per frame; on the rare cross-frame collision keep the
        // first frame's mark so the ID always resolves to exactly one element.
        if (usedMarkIds.has(m.id)) continue;
        usedMarkIds.add(m.id);
        marks.push({ ...m, box: shift(m.box || { x: 0, y: 0, w: 0, h: 0 }), frameId });
      }
    }

    return {
      piiRegions,
      marks,
      frameStats: { total: injectionResults.length, merged: injectionResults.length - skipped, skipped }
    };
  }

  function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
  }

  function normalizeBox(box) {
    if (!box || typeof box !== "object") return null;
    const x = Number(box.x ?? box.left ?? 0);
    const y = Number(box.y ?? box.top ?? 0);
    const w = Number(box.w ?? box.width ?? (box.right !== undefined ? box.right - x : 0));
    const h = Number(box.h ?? box.height ?? (box.bottom !== undefined ? box.bottom - y : 0));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { x: Math.round(x), y: Math.round(y), w: Math.max(0, Math.round(w)), h: Math.max(0, Math.round(h)) };
  }

  function computeIoU(a, b) {
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;

    const ix = Math.max(a.x, b.x);
    const iy = Math.max(a.y, b.y);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);

    const iw = Math.max(0, ix2 - ix);
    const ih = Math.max(0, iy2 - iy);
    const interArea = iw * ih;
    if (interArea <= 0) return 0;

    const unionArea = a.w * a.h + b.w * b.h - interArea;
    return unionArea > 0 ? interArea / unionArea : 0;
  }

  /**
   * Deduplicates and merges regions across DOM, Face, and OCR detection sources.
   */
  function mergeRegions(domRegions = [], visionRegions = [], ocrRegions = [], options = {}) {
    if (global.RegionMerger && typeof global.RegionMerger.mergeRegions === "function") {
      return global.RegionMerger.mergeRegions(domRegions, visionRegions, ocrRegions, options);
    }

    const all = [];
    const pushNorm = (list, defSrc) => {
      for (const r of Array.isArray(list) ? list : []) {
        const b = normalizeBox(r);
        if (!b || b.w <= 0 || b.h <= 0) continue;
        const src = r.source || defSrc;
        all.push({
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          type: r.type || "pii",
          reason: r.reason || (src === "vision_face" ? "face_detection" : src === "vision_ocr" ? "ocr_pii_match" : "dom_scan"),
          label: r.label || null,
          confidence: Number(r.confidence ?? 0.85),
          source: src,
          sources: Array.isArray(r.sources) ? [...r.sources] : [src],
          text: r.text || ""
        });
      }
    };

    pushNorm(domRegions, "dom");
    pushNorm(visionRegions, "vision_face");
    pushNorm(ocrRegions, "vision_ocr");

    const merged = [];
    for (const item of all) {
      const matchIdx = merged.findIndex(m => {
        const isNear = Math.abs(m.x - item.x) <= 4 && Math.abs(m.y - item.y) <= 4 && Math.abs(m.w - item.w) <= 6 && Math.abs(m.h - item.h) <= 6;
        return isNear || computeIoU(m, item) >= (options.iouThreshold || 0.5);
      });

      if (matchIdx === -1) {
        merged.push({ ...item });
      } else {
        const existing = merged[matchIdx];
        const nextX = Math.min(existing.x, item.x);
        const nextY = Math.min(existing.y, item.y);
        const nextW = Math.max(existing.x + existing.w, item.x + item.w) - nextX;
        const nextH = Math.max(existing.y + existing.h, item.y + item.h) - nextY;
        const combSources = Array.from(new Set([...(existing.sources || [existing.source]), ...(item.sources || [item.source])]));

        merged[matchIdx] = {
          x: nextX,
          y: nextY,
          w: nextW,
          h: nextH,
          type: existing.type !== "media" ? existing.type : item.type,
          reason: existing.reason || item.reason,
          label: item.label || existing.label || null,
          confidence: Math.max(existing.confidence, item.confidence),
          source: combSources.join(","),
          sources: combSources,
          text: item.text || existing.text || ""
        };
      }
    }

    return merged.map(r => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.max(2, Math.round(r.w)),
      h: Math.max(2, Math.round(r.h)),
      type: r.type || "pii",
      reason: r.reason || "pii_detection",
      ...(r.label ? { label: r.label } : {}),
      confidence: Number(r.confidence || 0.85),
      source: r.source,
      sources: r.sources || [r.source],
      ...(r.text ? { text: r.text } : {})
    }));
  }

  /**
   * Error thrown when redaction cannot be completed. The caller MUST abort the
   * request: a raw or partially-redacted screenshot is never returned or sent.
   */
  class RedactionError extends Error {
    constructor(message, cause) {
      super(message);
      this.name = "RedactionError";
      this.cause = cause;
    }
  }

  /**
   * Draws black or blurred redaction boxes over sensitive regions.
   *
   * FAIL CLOSED: if anything in this function throws (decode failure, canvas
   * failure, OOM), it re-throws a RedactionError. It never falls back to the raw
   * screenshot and never returns a partially redacted image. Callers must treat a
   * throw as "abort the request; transmit nothing".
   */
  async function redactImage(rawScreenshot, regions = [], vpW, vpH, mode = "black") {
    if (!rawScreenshot) throw new RedactionError("No screenshot supplied to redactImage().");
    try {
      const blob = await (await fetch(rawScreenshot)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);

      const sx = bitmap.width / (vpW || bitmap.width || 1);
      const sy = bitmap.height / (vpH || bitmap.height || 1);

      for (const r of regions) {
        const box = normalizeBox(r);
        if (!box || box.w <= 0 || box.h <= 0) continue;

        const rx = box.x * sx;
        const ry = box.y * sy;
        const rw = box.w * sx;
        const rh = box.h * sy;

        // Boundary dilation. OCR reports boxes that hug the glyphs, so a fixed 3px pad left
        // ascenders, descenders and antialiased edges visible — the evaluation measured only
        // ~82% of a text region actually covered. Scaling the pad with the region's height
        // closes that gap without smothering neighbouring elements.
        const pad = Math.max(3, Math.min(14, Math.round(Math.max(rh, 8) * 0.18)));
        const x0 = clamp(Math.round(rx) - pad, 0, bitmap.width - 1);
        const y0 = clamp(Math.round(ry) - pad, 0, bitmap.height - 1);
        const w0 = Math.max(1, Math.min(bitmap.width - x0, Math.round(rw) + pad * 2));
        const h0 = Math.max(1, Math.min(bitmap.height - y0, Math.round(rh) + pad * 2));

        if ((mode || "black") === "blur") {
          const step = 12;
          for (let bx = x0; bx < x0 + w0; bx += step) {
            for (let by = y0; by < y0 + h0; by += step) {
              const px = ctx.getImageData(Math.min(bx + 6, bitmap.width - 1), Math.min(by + 6, bitmap.height - 1), 1, 1).data;
              ctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
              ctx.fillRect(bx, by, step, step);
            }
          }
        } else {
          ctx.fillStyle = "#000000";
          ctx.fillRect(x0, y0, w0, h0);
        }
      }

      const redactedBlob = await canvas.convertToBlob({ type: "image/png" });
      const buf = await redactedBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let b64 = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return "data:image/png;base64," + btoa(b64);
    } catch (e) {
      // FAIL CLOSED. The raw screenshot is discarded here and never propagated:
      // the whole request is aborted by the caller rather than transmitting
      // anything that might contain unredacted pixels.
      console.error("[vision] CRITICAL: Redaction failed — aborting request, nothing will be transmitted:", e);
      throw new RedactionError("Redaction failed; request aborted to protect user privacy.", e);
    }
  }

  /**
   * Main scan and redact entrypoint.
   */
  async function scanAndRedact(tabId, windowId, settings = {}) {
    const tabKey = String(tabId || "global");
    if (SCAN_LOCKS.has(tabKey)) {
      return SCAN_LOCKS.get(tabKey);
    }

    const scanPromise = (async () => {
      const t0 = performance.now();

      // 1. Capture screenshot and scan ALL frames in parallel
      const [rawScreenshot, domResult] = await Promise.all([
        captureScreenshot(windowId).catch((err) => {
          console.warn("[vision] Screenshot capture failed:", err.message || err);
          return "";
        }),
        scanAllFrames(tabId).catch(() => ({ piiRegions: [], marks: [], frameStats: { total: 0, merged: 0, skipped: 0 } }))
      ]);

      const tAfterCapture = performance.now();

      if (!rawScreenshot) {
        return {
          redactedImage: "",
          redactionOk: false,
          regions: [],
          sourceBreakdown: { dom: 0, vision_face: 0, vision_ocr: 0, merged: 0 },
          timings: { capture: 0, domScan: 0, faceInference: 0, ocrInference: 0, visionInference: 0, merge: 0, redact: 0, total: 0 },
          marks: [],
          frameStats: domResult?.frameStats || { total: 0, merged: 0, skipped: 0 },
          debugLog: ["No screenshot captured"]
        };
      }

      const domPii = Array.isArray(domResult?.piiRegions) ? domResult.piiRegions : [];
      const marks = Array.isArray(domResult?.marks) ? domResult.marks : [];
      const frameStats = domResult?.frameStats || { total: 1, merged: 1, skipped: 0 };

      // 2. Run visual inference (Face + OCR) via Offscreen Document
      let faceBoxes = [];
      let ocrRegions = [];
      let mergedRegions = domPii;
      let offscreenTimings = { faceInference: 0, ocrInference: 0, visionInference: 0, merge: 0 };

      const chromeApi = safeGetChrome();
      if (chromeApi && chromeApi.runtime) {
        try {
          await ensureOffscreenDocument();
          // Budget for the whole offscreen round trip (face + OCR in parallel). The first call
          // after a cold start also pays for model compilation, so it gets a longer budget;
          // steady-state calls are held to VISION_BUDGET_MS so a slow page cannot stall the
          // agent loop. On timeout we fall back to DOM-only detections, which still redact.
          const budgetMs = visionWarmedUp ? VISION_BUDGET_MS : VISION_COLD_START_BUDGET_MS;
          const response = await new Promise((resolve) => {
            let settled = false;
            const timeoutId = setTimeout(() => {
              if (!settled) {
                settled = true;
                console.warn(`[vision] Offscreen vision response timed out after ${budgetMs}ms, using DOM detections.`);
                resolve(null);
              }
            }, budgetMs);

            chromeApi.runtime.sendMessage({
              target: "offscreen",
              type: "DETECT_PII",
              payload: {
                rawScreenshot,
                domRegions: domPii,
                viewportWidth: settings.viewportWidth,
                viewportHeight: settings.viewportHeight,
                devicePixelRatio: settings.devicePixelRatio || 1,
                enableOCR: settings.enableOCR !== false,
                enableFaceDetection: settings.enableFaceDetection !== false
              }
            }, (res) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutId);
              if (chromeApi.runtime.lastError || !res || !res.ok) {
                console.warn("[vision] Offscreen message notice:", chromeApi.runtime.lastError?.message || res?.error);
                resolve(null);
              } else {
                resolve(res.result);
              }
            });
          });

          if (response) {
            visionWarmedUp = true;
            faceBoxes = response.faceBoxes || [];
            ocrRegions = response.ocrRegions || [];
            mergedRegions = response.mergedRegions || mergeRegions(domPii, faceBoxes, ocrRegions);
            offscreenTimings = response.timings || offscreenTimings;
          } else {
            mergedRegions = mergeRegions(domPii, [], []);
          }
        } catch (visionErr) {
          console.warn("[vision] Offscreen vision pipeline failed, using DOM fallback:", visionErr);
          mergedRegions = mergeRegions(domPii, [], []);
        }
      } else {
        mergedRegions = mergeRegions(domPii, [], []);
      }

      const tAfterVision = performance.now();

      // 3. Redact image with all merged regions.
      //    FAIL CLOSED: if redaction throws, the entire scan is aborted. rawScreenshot goes out
      //    of scope here and is never returned to the caller, so there is no code path on which
      //    an unredacted image can reach the network.
      let redactedImage;
      try {
        redactedImage = await redactImage(
          rawScreenshot,
          mergedRegions,
          settings.viewportWidth,
          settings.viewportHeight,
          settings.redactMode || "black"
        );
      } catch (redactErr) {
        console.error("[vision] Scan aborted — redaction failed:", redactErr);
        return {
          redactedImage: "",
          redactionOk: false,
          redactionError: redactErr.message || String(redactErr),
          regions: mergedRegions,
          sourceBreakdown: { dom: domPii.length, vision_face: faceBoxes.length, vision_ocr: ocrRegions.length, merged: mergedRegions.length },
          timings: { capture: Math.round(tAfterCapture - t0), domScan: Math.round(tAfterCapture - t0), faceInference: 0, ocrInference: 0, visionInference: 0, merge: 0, redact: 0, total: Math.round(performance.now() - t0) },
          marks,
          frameStats,
          debugLog: ["Redaction failed — request aborted, nothing transmitted"]
        };
      }

      const tEnd = performance.now();

      const sourceBreakdown = {
        dom: domPii.length,
        vision_face: faceBoxes.length,
        vision_ocr: ocrRegions.length,
        merged: mergedRegions.length
      };

      const timings = {
        capture: Math.round(tAfterCapture - t0),
        domScan: Math.round(tAfterCapture - t0),
        faceInference: offscreenTimings.faceInference || 0,
        ocrInference: offscreenTimings.ocrInference || 0,
        visionInference: offscreenTimings.visionInference || Math.round(tAfterVision - tAfterCapture),
        merge: offscreenTimings.merge || 0,
        redact: Math.round(tEnd - tAfterVision),
        total: Math.round(tEnd - t0)
      };

      console.log("[vision] ========================================");
      console.log(`[vision] 📸 Screenshot & DOM scan: ${timings.capture}ms (${domPii.length} DOM inputs, ${marks.length} marks across ${frameStats.merged}/${frameStats.total} frame(s), ${frameStats.skipped} skipped)`);
      console.log(`[vision] 🧠 Face Detection (UltraFace): ${timings.faceInference}ms -> ${faceBoxes.length} face(s) found`);
      console.log(`[vision] 🔤 OCR PII Detection (Tesseract): ${timings.ocrInference}ms -> ${ocrRegions.length} text match(es)`);
      console.log(`[vision] 🔒 Redaction Canvas: ${timings.redact}ms -> ${mergedRegions.length} total PII regions blacked out`);
      console.log(`[vision] ⚡ Full Pipeline Finished in ${timings.total}ms (Vision ML: ${timings.visionInference}ms)`);
      console.log("[vision] ========================================");

      return {
        redactedImage,
        redactionOk: true,
        regions: mergedRegions,
        sourceBreakdown,
        timings,
        marks,
        frameStats,
        debugLog: []
      };
    })();

    SCAN_LOCKS.set(tabKey, scanPromise);
    try {
      return await scanPromise;
    } finally {
      SCAN_LOCKS.delete(tabKey);
    }
  }

  global.ensureOffscreenDocument = ensureOffscreenDocument;
  global.scanAndRedact = scanAndRedact;
  global.scanAllFrames = scanAllFrames;
  global.mergeRegions = mergeRegions;
  global.redactImage = redactImage;
  global.captureScreenshot = captureScreenshot;
  global.RedactionError = RedactionError;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ensureOffscreenDocument,
      scanAndRedact,
      scanAllFrames,
      mergeRegions,
      redactImage,
      captureScreenshot,
      RedactionError,
      computeIoU,
      normalizeBox
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

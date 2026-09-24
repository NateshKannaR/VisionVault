/**
 * mergeRegions.js — Unified PII Region Merging & Deduplication
 *
 * Merges regions from:
 * 1. DOM structural scan (content.js)
 * 2. Visual Face Detection (faceDetect.js via ONNX Runtime Web)
 * 3. OCR Text PII matches (ocrDetect.js via Tesseract.js)
 *
 * Applies IoU-based deduplication (IoU > 0.5) to prevent double-redaction
 * while preserving the complete region contract.
 */

(function (global) {
  function areaOf(r) {
    return Math.max(0, r.w) * Math.max(0, r.h);
  }

  function computeIoU(a, b) {
    const ax1 = a.x;
    const ay1 = a.y;
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;

    const bx1 = b.x;
    const by1 = b.y;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;

    const ix1 = Math.max(ax1, bx1);
    const iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);

    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const interArea = iw * ih;

    if (interArea <= 0) return 0;

    const unionArea = areaOf(a) + areaOf(b) - interArea;
    return unionArea > 0 ? interArea / unionArea : 0;
  }

  function containmentRatio(inner, outer) {
    const ix1 = Math.max(inner.x, outer.x);
    const iy1 = Math.max(inner.y, outer.y);
    const ix2 = Math.min(inner.x + inner.w, outer.x + outer.w);
    const iy2 = Math.min(inner.y + inner.h, outer.y + outer.h);

    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const interArea = iw * ih;
    const innerArea = areaOf(inner);

    return innerArea > 0 ? interArea / innerArea : 0;
  }

  function normalizeRegion(r, defaultSource = "dom") {
    if (!r || typeof r !== "object") return null;
    const x = Number(r.x ?? r.left ?? 0);
    const y = Number(r.y ?? r.top ?? 0);
    const w = Number(r.w ?? r.width ?? (r.right !== undefined ? r.right - x : 0));
    const h = Number(r.h ?? r.height ?? (r.bottom !== undefined ? r.bottom - y : 0));

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    if (w <= 0 || h <= 0) return null;

    const src = r.source || defaultSource;
    const sources = Array.isArray(r.sources) ? [...r.sources] : [src];
    const isCirc = Boolean(r.circular || r.isCircle || (r.label && /avatar/i.test(r.label)));

    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.max(2, Math.round(w)),
      h: Math.max(2, Math.round(h)),
      type: r.type || "pii",
      reason: r.reason || (src === "vision_face" ? "face_detection" : src === "vision_ocr" ? "ocr_pii_match" : "dom_scan"),
      label: r.label || null,
      confidence: Number(r.confidence ?? (src === "dom" ? 0.95 : 0.85)),
      text: r.text || "",
      circular: isCirc,
      source: src,
      sources: sources
    };
  }

  /**
   * Merges and de-duplicates DOM regions, Face regions, and OCR regions.
   *
   * @param {Array} domRegions - Regions from content.js scanForPII()
   * @param {Array} faceRegions - Regions from faceDetect.js
   * @param {Array} ocrRegions - Regions from ocrDetect.js
   * @param {Object} options - { iouThreshold }
   * @returns {Array} Unified de-duplicated regions array
   */
  function mergeRegions(domRegions = [], faceRegions = [], ocrRegions = [], options = {}) {
    const iouThreshold = options.iouThreshold || 0.5;
    const allCandidates = [];

    // Normalize DOM regions
    for (const r of Array.isArray(domRegions) ? domRegions : []) {
      const norm = normalizeRegion(r, "dom");
      if (norm) allCandidates.push(norm);
    }

    // Normalize Face regions
    for (const r of Array.isArray(faceRegions) ? faceRegions : []) {
      const norm = normalizeRegion(r, "vision_face");
      if (norm) allCandidates.push(norm);
    }

    // Normalize OCR regions
    for (const r of Array.isArray(ocrRegions) ? ocrRegions : []) {
      const norm = normalizeRegion(r, "vision_ocr");
      if (norm) allCandidates.push(norm);
    }

    const merged = [];

    for (const candidate of allCandidates) {
      let matchIdx = -1;

      for (let i = 0; i < merged.length; i++) {
        const existing = merged[i];

        // 1. Exact or near-identical position
        const isNearDuplicate = Math.abs(existing.x - candidate.x) <= 6 &&
                               Math.abs(existing.y - candidate.y) <= 6 &&
                               Math.abs(existing.w - candidate.w) <= 8 &&
                               Math.abs(existing.h - candidate.h) <= 8;

        // 2. High IoU overlap
        const iou = computeIoU(existing, candidate);

        // 3. Significant containment
        const containedInExisting = containmentRatio(candidate, existing) > 0.55;
        const containsExisting = containmentRatio(existing, candidate) > 0.55;

        // 4. Avatar & Face intersection (ensure face inside avatar snaps to the full avatar frame)
        const isAvatarExisting = Boolean(existing.circular || existing.reason === "profile_avatar" || (existing.label && /avatar/i.test(existing.label)));
        const isAvatarCandidate = Boolean(candidate.circular || candidate.reason === "profile_avatar" || (candidate.label && /avatar/i.test(candidate.label)));
        const candCx = candidate.x + candidate.w / 2;
        const candCy = candidate.y + candidate.h / 2;
        const existCx = existing.x + existing.w / 2;
        const existCy = existing.y + existing.h / 2;
        const isAvatarFaceOverlap = (isAvatarExisting || isAvatarCandidate) && (
          iou > 0.10 ||
          containedInExisting ||
          containsExisting ||
          (candCx >= existing.x - 4 && candCx <= existing.x + existing.w + 4 && candCy >= existing.y - 4 && candCy <= existing.y + existing.h + 4) ||
          (existCx >= candidate.x - 4 && existCx <= candidate.x + candidate.w + 4 && existCy >= candidate.y - 4 && existCy <= candidate.y + candidate.h + 4)
        );

        if (isNearDuplicate || iou >= iouThreshold || containedInExisting || containsExisting || isAvatarFaceOverlap) {
          matchIdx = i;
          break;
        }
      }

      if (matchIdx === -1) {
        merged.push({ ...candidate });
      } else {
        const existing = merged[matchIdx];

        // Union bounding box
        let nextX = Math.min(existing.x, candidate.x);
        let nextY = Math.min(existing.y, candidate.y);
        let nextW = Math.max(existing.x + existing.w, candidate.x + candidate.w) - nextX;
        let nextH = Math.max(existing.y + existing.h, candidate.y + candidate.h) - nextY;

        // If one is a circular avatar, retain the exact avatar's neat square bounds rather than dilating
        const isAvatarExisting = Boolean(existing.circular || existing.reason === "profile_avatar" || (existing.label && /avatar/i.test(existing.label)));
        const isAvatarCandidate = Boolean(candidate.circular || candidate.reason === "profile_avatar" || (candidate.label && /avatar/i.test(candidate.label)));
        if (isAvatarExisting || isAvatarCandidate) {
          const avatar = isAvatarExisting ? existing : candidate;
          nextX = avatar.x;
          nextY = avatar.y;
          nextW = avatar.w;
          nextH = avatar.h;
        }

        // Combine sources
        const combinedSources = Array.from(new Set([...(existing.sources || [existing.source]), ...(candidate.sources || [candidate.source])]));

        // Retain higher confidence and meaningful labels
        const higherConfidence = Math.max(existing.confidence || 0, candidate.confidence || 0);
        const bestLabel = candidate.label || existing.label || null;
        const bestType = existing.type !== "media" && existing.type !== "pii" ? existing.type : candidate.type;
        const bestReason = existing.reason || candidate.reason;
        const isCirc = Boolean(existing.circular || candidate.circular || isAvatarExisting || isAvatarCandidate || (bestLabel && /avatar/i.test(bestLabel)));

        merged[matchIdx] = {
          x: nextX,
          y: nextY,
          w: nextW,
          h: nextH,
          type: bestType,
          reason: bestReason,
          label: bestLabel,
          confidence: Math.round(higherConfidence * 100) / 100,
          text: candidate.text || existing.text || "",
          circular: isCirc,
          source: combinedSources.join(","),
          sources: combinedSources
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
      ...(r.circular ? { circular: true, isCircle: true } : {}),
      confidence: Number(r.confidence || 0.85),
      source: r.source || "merged",
      sources: Array.isArray(r.sources) ? r.sources : [r.source || "merged"],
      ...(r.text ? { text: r.text } : {})
    }));
  }

  const RegionMerger = {
    mergeRegions,
    computeIoU,
    containmentRatio,
    normalizeRegion
  };

  global.RegionMerger = RegionMerger;
  global.mergeRegions = mergeRegions;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      mergeRegions,
      computeIoU,
      containmentRatio,
      normalizeRegion,
      RegionMerger
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

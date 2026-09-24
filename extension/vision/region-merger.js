/**
 * region-merger.js — Deduplication & IoU Region Merging for VisionVault.
 *
 * Merges bounding boxes across DOM inspection, local face detection (UltraFace),
 * and OCR text matches (Tesseract). Resolves overlaps, computes compound bounding boxes,
 * and maintains provenance sources.
 */

(function (global) {
  function normalizeBox(r) {
    if (!r) return null;
    const x = r.x ?? r.left ?? r.box?.x ?? 0;
    const y = r.y ?? r.top ?? r.box?.y ?? 0;
    const w = r.w ?? r.width ?? r.box?.width ?? r.box?.w ?? 0;
    const h = r.h ?? r.height ?? r.box?.height ?? r.box?.h ?? 0;
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

  function mergeRegions(domRegions = [], visionRegions = [], ocrRegions = [], options = {}) {
    const all = [];
    const pushNorm = (list, defSrc) => {
      for (const r of Array.isArray(list) ? list : []) {
        const b = normalizeBox(r);
        if (!b || b.w <= 0 || b.h <= 0) continue;
        const src = r.source || defSrc;
        const isCirc = Boolean(r.circular || r.isCircle || (r.label && /avatar/i.test(r.label)));
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
          circular: isCirc,
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
        const isNear = Math.abs(m.x - item.x) <= 6 && Math.abs(m.y - item.y) <= 6 && Math.abs(m.w - item.w) <= 8 && Math.abs(m.h - item.h) <= 8;
        const iou = computeIoU(m, item);
        const isAvatarM = Boolean(m.circular || m.reason === "profile_avatar" || (m.label && /avatar/i.test(m.label)));
        const isAvatarItem = Boolean(item.circular || item.reason === "profile_avatar" || (item.label && /avatar/i.test(item.label)));
        const itemCx = item.x + item.w / 2;
        const itemCy = item.y + item.h / 2;
        const mCx = m.x + m.w / 2;
        const mCy = m.y + m.h / 2;
        const isAvatarFaceOverlap = (isAvatarM || isAvatarItem) && (
          iou > 0.10 ||
          (itemCx >= m.x - 4 && itemCx <= m.x + m.w + 4 && itemCy >= m.y - 4 && itemCy <= m.y + m.h + 4) ||
          (mCx >= item.x - 4 && mCx <= item.x + item.w + 4 && mCy >= item.y - 4 && mCy <= item.y + item.h + 4)
        );
        return isNear || iou >= (options.iouThreshold || 0.5) || isAvatarFaceOverlap;
      });

      if (matchIdx === -1) {
        merged.push({ ...item });
      } else {
        const existing = merged[matchIdx];
        let nextX = Math.min(existing.x, item.x);
        let nextY = Math.min(existing.y, item.y);
        let nextW = Math.max(existing.x + existing.w, item.x + item.w) - nextX;
        let nextH = Math.max(existing.y + existing.h, item.y + item.h) - nextY;

        // If one is a circular avatar, retain the exact avatar's neat square bounds rather than dilating
        const isAvatarExisting = Boolean(existing.circular || existing.reason === "profile_avatar" || (existing.label && /avatar/i.test(existing.label)));
        const isAvatarItem = Boolean(item.circular || item.reason === "profile_avatar" || (item.label && /avatar/i.test(item.label)));
        if (isAvatarExisting || isAvatarItem) {
          const avatar = isAvatarExisting ? existing : item;
          nextX = avatar.x;
          nextY = avatar.y;
          nextW = avatar.w;
          nextH = avatar.h;
        }
        const combSources = Array.from(new Set([...(existing.sources || [existing.source]), ...(item.sources || [item.source])]));
        const isCirc = Boolean(existing.circular || item.circular || isAvatarExisting || isAvatarItem || ((existing.label || item.label) && /avatar/i.test(existing.label || item.label)));

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
          circular: isCirc,
          text: item.text || existing.text || ""
        };
      }
    }

    return merged.map(r => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.max(2, Math.round(r.w)),
      h: Math.max(2, Math.round(r.h)),
      type: r.type,
      reason: r.reason,
      label: r.label,
      confidence: r.confidence,
      source: r.source,
      sources: r.sources || [r.source],
      ...(r.circular ? { circular: true, isCircle: true } : {}),
      ...(r.text ? { text: r.text } : {})
    }));
  }

  const RegionMerger = {
    normalizeBox,
    computeIoU,
    mergeRegions,
  };

  global.RegionMerger = RegionMerger;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RegionMerger;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

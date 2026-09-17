/**
 * visual-grounding.js — On-device Visual Element Grounding for VisionVault.
 *
 * Runs locally in the browser/service worker to correlate DOM interactive marks,
 * OCR detected text bounding boxes, and parsed user intent. Proposes high-confidence
 * candidate target elements (with spatial & semantic scoring) to either:
 *   1. Augment the cloud VLM prompt (`grounded_candidates: [...]`) for fast verification.
 *   2. Directly drive on-device fallback execution with zero latency and zero wire transit.
 */

(function (global) {
  /**
   * Computes Intersection over Union (IoU) of two bounding boxes.
   * Box format: { x, y, width, height }
   */
  function computeIoU(b1, b2) {
    if (!b1 || !b2) return 0;
    const xA = Math.max(b1.x, b2.x);
    const yA = Math.max(b1.y, b2.y);
    const xB = Math.min(b1.x + b1.width, b2.x + b2.width);
    const yB = Math.min(b1.y + b1.height, b2.y + b2.height);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    if (interArea === 0) return 0;

    const area1 = b1.width * b1.height;
    const area2 = b2.width * b2.height;
    return interArea / (area1 + area2 - interArea);
  }

  /**
   * Computes semantic similarity score based on keyword overlap between target query and element label.
   */
  function computeSemanticScore(targetText, elementText) {
    if (!targetText || !elementText) return 0;
    const t = String(targetText).toLowerCase().trim();
    const e = String(elementText).toLowerCase().trim();

    if (e.includes(t)) return 1.0;
    if (t.includes(e) && e.length > 3) return 0.8;

    const targetWords = t.split(/\s+/).filter(w => w.length > 2);
    if (targetWords.length === 0) return 0;

    let matches = 0;
    for (const w of targetWords) {
      if (e.includes(w)) matches++;
    }
    return matches / targetWords.length;
  }

  /**
   * Proposes ranked candidate elements for a given task and visual/DOM marks.
   * @param {Array} marks - Interactive marks from content script [{id, tag, label, box, ...}]
   * @param {object} parsedTask - Parsed task intent (query, openTarget, site, etc.)
   * @param {Array} ocrRegions - OCR detected bounding boxes [{text, box}]
   * @returns {Array<{mark_id: number|string, score: number, tag: string, label: string, reason: string}>}
   */
  function proposeGroundedCandidates(marks, parsedTask, ocrRegions = []) {
    if (!Array.isArray(marks) || marks.length === 0) return [];

    const task = parsedTask || {};
    const query = (task.openTarget || (Array.isArray(task.openTargets) && task.openTargets[0]) || task.query || "").toLowerCase();
    const isSearchTask = !!task.query && !task.isProductSelection && !task.openTarget && (!Array.isArray(task.openTargets) || task.openTargets.length === 0);
    const isFormTask = !!task.isFormFill;

    const scoredCandidates = [];

    for (const m of marks) {
      if (!m || m.id === undefined) continue;
      let score = 0;
      const reasons = [];
      const label = String(m.label || m.text || m.placeholder || m.ariaLabel || "").toLowerCase();
      const tag = String(m.tag || "").toLowerCase();
      const box = m.box || { x: m.x || 0, y: m.y || 0, width: m.width || 0, height: m.height || 0 };

      // 1. Search intent grounding
      if (isSearchTask) {
        if (tag === "input" || tag === "textarea" || m.type === "search" || m.type === "text") {
          score += 0.5;
          reasons.push("input_type_match");
          if (/search|find|query|explore/i.test(label) || /search/i.test(m.name || "") || /search/i.test(m.id || "")) {
            score += 0.4;
            reasons.push("search_label_match");
          }
        }
      }

      // 2. Target selection intent (click specific item / link / button)
      if (query && !isSearchTask) {
        const semScore = computeSemanticScore(query, label);
        if (semScore > 0) {
          score += semScore * 0.8;
          reasons.push(`text_match_${Math.round(semScore * 100)}%`);
        }
      }

      // 3. Form fill intent
      if (isFormTask && (tag === "input" || tag === "select" || tag === "textarea")) {
        score += 0.6;
        reasons.push("form_control_candidate");
      }

      // 4. Spatial correlation with OCR regions (cross-modal verification)
      if (Array.isArray(ocrRegions) && ocrRegions.length > 0 && box.width > 0 && box.height > 0) {
        for (const ocr of ocrRegions) {
          if (!ocr.box) continue;
          const iou = computeIoU(box, ocr.box);
          if (iou > 0.3) {
            score += 0.3;
            reasons.push(`ocr_spatial_iou_${Math.round(iou * 100)}%`);
            if (query && computeSemanticScore(query, ocr.text) > 0.5) {
              score += 0.3;
              reasons.push("ocr_text_corroborated");
            }
            break;
          }
        }
      }

      // 5. Visibility and centrality prior (elements higher on page generally more relevant)
      if (box.y >= 0 && box.y < 800) {
        score += 0.05;
      }

      if (score > 0.2) {
        scoredCandidates.push({
          mark_id: m.id,
          score: Math.min(1.0, Math.round(score * 100) / 100),
          tag: m.tag || "",
          label: (m.label || m.placeholder || "").slice(0, 50),
          reasons: reasons.join(", ")
        });
      }
    }

    // Sort descending by score
    scoredCandidates.sort((a, b) => b.score - a.score);

    // Return top 5 candidate marks
    return scoredCandidates.slice(0, 5);
  }

  const VisualGrounding = {
    proposeGroundedCandidates,
    computeIoU,
    computeSemanticScore,
  };

  global.VisualGrounding = VisualGrounding;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = VisualGrounding;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

/**
 * metrics.js — Detection / redaction scoring used by run-full-eval.js.
 *
 * Every function here is pure arithmetic over boxes. Nothing is estimated or hard-coded; the
 * inputs come from the live browser run.
 */

function area(b) {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

function intersectionArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function iou(a, b) {
  const inter = intersectionArea(a, b);
  if (inter <= 0) return 0;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Share of `inner` that lies inside `outer`. */
function coverage(inner, outer) {
  const a = area(inner);
  return a > 0 ? intersectionArea(inner, outer) / a : 0;
}

/**
 * Share of `truth` covered by the UNION of `boxes`, computed exactly by scanline decomposition
 * over the distinct x-edges (no double counting where predictions overlap).
 */
function unionCoverage(truth, boxes) {
  const t = area(truth);
  if (t <= 0) return 1;

  const clipped = boxes
    .map((b) => ({
      x0: Math.max(truth.x, b.x),
      x1: Math.min(truth.x + truth.w, b.x + b.w),
      y0: Math.max(truth.y, b.y),
      y1: Math.min(truth.y + truth.h, b.y + b.h),
    }))
    .filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
  if (clipped.length === 0) return 0;

  const xs = new Set();
  for (const b of clipped) { xs.add(b.x0); xs.add(b.x1); }
  const edges = [...xs].sort((a, b) => a - b);

  let covered = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const xa = edges[i], xb = edges[i + 1];
    const width = xb - xa;
    if (width <= 0) continue;

    // Merge the y-intervals of every box spanning this x-slab.
    const spans = clipped
      .filter((b) => b.x0 <= xa && b.x1 >= xb)
      .map((b) => [b.y0, b.y1])
      .sort((p, q) => p[0] - q[0]);

    let height = 0, curStart = null, curEnd = null;
    for (const [s, e] of spans) {
      if (curStart === null) { curStart = s; curEnd = e; }
      else if (s <= curEnd) { curEnd = Math.max(curEnd, e); }
      else { height += curEnd - curStart; curStart = s; curEnd = e; }
    }
    if (curStart !== null) height += curEnd - curStart;
    covered += width * height;
  }
  return Math.min(1, covered / t);
}

/**
 * Greedy one-to-one match of predictions to ground truth, highest overlap first.
 *
 * A prediction counts as a hit when it covers at least `coverThreshold` of the truth box.
 * Coverage rather than IoU is the matching criterion because redaction is asymmetric: a mask
 * larger than the truth box is still a correct mask (it hides the data), while IoU would
 * penalise it. IoU is reported separately as the tightness/precision-of-redaction measure.
 */
function matchDetections(truths, predictions, coverThreshold = 0.5) {
  const pairs = [];
  truths.forEach((t, ti) => {
    predictions.forEach((p, pi) => {
      const cov = coverage(t, p);
      if (cov >= coverThreshold) pairs.push({ ti, pi, cov, iou: iou(t, p) });
    });
  });
  pairs.sort((a, b) => b.cov - a.cov || b.iou - a.iou);

  const usedT = new Set();
  const usedP = new Set();
  const matches = [];
  for (const pair of pairs) {
    if (usedT.has(pair.ti) || usedP.has(pair.pi)) continue;
    usedT.add(pair.ti);
    usedP.add(pair.pi);
    matches.push(pair);
  }

  return {
    matches,
    matchedTruth: usedT,
    matchedPred: usedP,
    truePositives: matches.length,
    falseNegatives: truths.length - usedT.size,
    falsePositives: predictions.length - usedP.size,
  };
}

function safeDiv(n, d) {
  return d > 0 ? n / d : null;
}

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? 'n/a' : `${(v * 100).toFixed(digits)}%`;
}

function mean(list) {
  const nums = list.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function percentile(list, p) {
  const nums = list.filter((v) => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

module.exports = {
  area, intersectionArea, iou, coverage, unionCoverage,
  matchDetections, safeDiv, pct, mean, percentile,
};

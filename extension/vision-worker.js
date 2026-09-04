/**
 * vision-worker.js
 * Runs as a Web Worker. Uses Transformers.js for:
 *   1. Object detection (YOLOS-tiny) — detects persons/faces for redaction
 *   2. Zero-shot classification used as a lightweight UI-element classifier
 *
 * Device priority: WebGPU -> WASM (automatic fallback)
 * Messages IN:  { type: "LOAD" }
 *               { type: "DETECT", imageData: { data: Uint8ClampedArray, width, height } }
 * Messages OUT: { type: "READY", device }
 *               { type: "DETECTIONS", boxes, inferenceMs, memoryMB }
 *               { type: "ERROR", message }
 *               { type: "PROGRESS", message }
 */

import { pipeline, env, RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;

let detector = null;
let deviceUsed = "wasm";

// Labels that should always be redacted when detected by the vision model
const REDACT_LABELS = new Set(["person", "cell phone", "laptop", "tv", "monitor"]);

function getMemoryMB() {
  try {
    // performance.memory is Chrome-only but fine for the demo
    return Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576);
  } catch { return 0; }
}

self.onmessage = async ({ data }) => {
  if (data.type === "LOAD") {
    try {
      self.postMessage({ type: "PROGRESS", message: "Loading vision model (first run ~6 MB download)…" });
      try {
        detector = await pipeline("object-detection", "Xenova/yolos-tiny", { device: "webgpu", dtype: "fp16" });
        deviceUsed = "webgpu";
      } catch {
        detector = await pipeline("object-detection", "Xenova/yolos-tiny", { device: "wasm", dtype: "q8" });
        deviceUsed = "wasm";
      }
      self.postMessage({ type: "READY", device: deviceUsed, memoryMB: getMemoryMB() });
    } catch (e) {
      self.postMessage({ type: "ERROR", message: String(e) });
    }
  }

  if (data.type === "DETECT") {
    if (!detector) { self.postMessage({ type: "ERROR", message: "Model not loaded" }); return; }
    try {
      const t0 = performance.now();
      const { data: pixels, width, height } = data.imageData;
      const img = new RawImage(pixels, width, height, 4);
      const results = await detector(img, { threshold: 0.35 });
      const inferenceMs = Math.round(performance.now() - t0);

      const boxes = results
        .filter(r => REDACT_LABELS.has(r.label) && r.score > 0.35)
        .map(r => ({
          x: Math.round(r.box.xmin), y: Math.round(r.box.ymin),
          w: Math.round(r.box.xmax - r.box.xmin),
          h: Math.round(r.box.ymax - r.box.ymin),
          label: r.label, score: Math.round(r.score * 100) / 100,
        }));

      self.postMessage({ type: "DETECTIONS", boxes, inferenceMs, memoryMB: getMemoryMB(), device: deviceUsed });
    } catch (e) {
      self.postMessage({ type: "ERROR", message: String(e) });
    }
  }
};

/**
 * vision-worker.js
 * Runs as a Web Worker inside the extension (background.js spawns it).
 * Uses Transformers.js to run a lightweight object-detection model (YOLOS-tiny)
 * on the screenshot to detect faces/persons for privacy redaction.
 *
 * Device priority: WebGPU -> WASM (automatic fallback via Transformers.js)
 * Model: Xenova/yolos-tiny (~6MB, COCO-trained, detects "person" class)
 *
 * Messages IN:
 *   { type: "LOAD" }
 *   { type: "DETECT", imageData: { data: Uint8ClampedArray, width, height } }
 *
 * Messages OUT:
 *   { type: "READY", device: "webgpu"|"wasm" }
 *   { type: "DETECTIONS", boxes: [{x,y,w,h,label,score}], inferenceMs: number }
 *   { type: "ERROR", message: string }
 *   { type: "PROGRESS", message: string }
 */

import { pipeline, env, RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true; // cache model weights in IndexedDB after first load

let detector = null;
let deviceUsed = "wasm";

self.onmessage = async ({ data }) => {
  if (data.type === "LOAD") {
    try {
      self.postMessage({ type: "PROGRESS", message: "Loading vision model (first run downloads ~6MB)..." });

      // Try WebGPU first, fall back to wasm automatically
      try {
        detector = await pipeline("object-detection", "Xenova/yolos-tiny", {
          device: "webgpu",
          dtype: "fp16",
        });
        deviceUsed = "webgpu";
      } catch {
        detector = await pipeline("object-detection", "Xenova/yolos-tiny", {
          device: "wasm",
          dtype: "q8",
        });
        deviceUsed = "wasm";
      }

      self.postMessage({ type: "READY", device: deviceUsed });
    } catch (e) {
      self.postMessage({ type: "ERROR", message: String(e) });
    }
  }

  if (data.type === "DETECT") {
    if (!detector) {
      self.postMessage({ type: "ERROR", message: "Model not loaded yet" });
      return;
    }
    try {
      const t0 = performance.now();
      const { data: pixels, width, height } = data.imageData;

      // Build a RawImage from the raw RGBA pixel data
      const img = new RawImage(pixels, width, height, 4);
      const results = await detector(img, { threshold: 0.4 });
      const inferenceMs = Math.round(performance.now() - t0);

      // Map detections to simple {x,y,w,h} boxes
      // We redact "person" (face/body) and any other sensitive COCO classes
      const REDACT_LABELS = new Set(["person", "cell phone", "laptop", "tv", "monitor"]);
      const boxes = results
        .filter(r => REDACT_LABELS.has(r.label) && r.score > 0.4)
        .map(r => ({
          x: r.box.xmin,
          y: r.box.ymin,
          w: r.box.xmax - r.box.xmin,
          h: r.box.ymax - r.box.ymin,
          label: r.label,
          score: Math.round(r.score * 100) / 100,
        }));

      self.postMessage({ type: "DETECTIONS", boxes, inferenceMs });
    } catch (e) {
      self.postMessage({ type: "ERROR", message: String(e) });
    }
  }
};

/**
 * faceDetect.js — Local Face Detection via ONNX Runtime Web
 *
 * Model: UltraFace RFB-320 (quantized lightweight SSD face detector, 1.27MB, MIT License)
 * Runtime: ONNX Runtime Web (WebAssembly SIMD / WebGPU)
 * Input: Screenshot image / ImageData -> 320x240 RGB float32 tensor
 * Output: Array of { x, y, w, h, type: "face", reason: "face_detection", label: "face", confidence }
 */

(function (global) {
  const MODEL_INPUT_WIDTH = 320;
  const MODEL_INPUT_HEIGHT = 240;
  const CONFIDENCE_THRESHOLD = 0.52; // High-recall threshold for avatars & small profile thumbnails
  const IOU_THRESHOLD = 0.3;
  const CENTER_VARIANCE = 0.1;
  const SIZE_VARIANCE = 0.2;

  let ortSession = null;
  let initPromise = null;
  let cachedPriors = null;
  let backendUsed = "wasm";

  /**
   * Generates SSD prior boxes for UltraFace 320x240 input.
   */
  function generatePriors() {
    if (cachedPriors) return cachedPriors;
    const featureMaps = [[40, 20, 10, 5], [30, 15, 8, 4]];
    const shrinkages = [[8, 16, 32, 64], [8, 16, 32, 64]];
    const minBoxes = [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]];
    const imageSize = [MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT];
    const priors = [];

    for (let idx = 0; idx < featureMaps[0].length; idx++) {
      const scaleW = imageSize[0] / shrinkages[0][idx];
      const scaleH = imageSize[1] / shrinkages[1][idx];
      const fw = featureMaps[0][idx];
      const fh = featureMaps[1][idx];

      for (let j = 0; j < fh; j++) {
        for (let i = 0; i < fw; i++) {
          const xCenter = (i + 0.5) / scaleW;
          const yCenter = (j + 0.5) / scaleH;

          for (const k of minBoxes[idx]) {
            const w = k / imageSize[0];
            const h = k / imageSize[1];
            priors.push([
              Math.max(0, Math.min(1, xCenter)),
              Math.max(0, Math.min(1, yCenter)),
              Math.max(0, Math.min(1, w)),
              Math.max(0, Math.min(1, h))
            ]);
          }
        }
      }
    }
    cachedPriors = priors;
    return priors;
  }

  /**
   * Decodes predicted offsets + priors into normalized corner boxes [xmin, ymin, xmax, ymax].
   */
  function decodeBoxes(locations, priors) {
    const numPriors = priors.length;
    const boxes = [];

    for (let i = 0; i < numPriors; i++) {
      const locIdx = i * 4;
      const prior = priors[i];

      const cx = locations[locIdx] * CENTER_VARIANCE * prior[2] + prior[0];
      const cy = locations[locIdx + 1] * CENTER_VARIANCE * prior[3] + prior[1];
      const w = Math.exp(locations[locIdx + 2] * SIZE_VARIANCE) * prior[2];
      const h = Math.exp(locations[locIdx + 3] * SIZE_VARIANCE) * prior[3];

      const xmin = Math.max(0, Math.min(1, cx - w / 2));
      const ymin = Math.max(0, Math.min(1, cy - h / 2));
      const xmax = Math.max(0, Math.min(1, cx + w / 2));
      const ymax = Math.max(0, Math.min(1, cy + h / 2));

      boxes.push([xmin, ymin, xmax, ymax]);
    }
    return boxes;
  }

  /**
   * Intersection over Union of two corner boxes.
   */
  function boxIoU(b1, b2) {
    const xmin = Math.max(b1[0], b2[0]);
    const ymin = Math.max(b1[1], b2[1]);
    const xmax = Math.min(b1[2], b2[2]);
    const ymax = Math.min(b1[3], b2[3]);

    const iw = Math.max(0, xmax - xmin);
    const ih = Math.max(0, ymax - ymin);
    const interArea = iw * ih;

    const a1 = (b1[2] - b1[0]) * (b1[3] - b1[1]);
    const a2 = (b2[2] - b2[0]) * (b2[3] - b2[1]);
    const unionArea = Math.max(1e-6, a1 + a2 - interArea);

    return interArea / unionArea;
  }

  /**
   * Non-Maximum Suppression to remove duplicate overlapping face detections.
   */
  function nonMaxSuppression(candidates, iouThreshold) {
    candidates.sort((a, b) => b.score - a.score);
    const kept = [];

    for (let i = 0; i < candidates.length; i++) {
      const current = candidates[i];
      let suppress = false;

      for (let j = 0; j < kept.length; j++) {
        if (boxIoU(current.box, kept[j].box) > iouThreshold) {
          suppress = true;
          break;
        }
      }

      if (!suppress) {
        kept.push(current);
      }
    }
    return kept;
  }

  /**
   * True only when this browser exposes WebGPU AND the optional ORT JSEP build is bundled.
   * Both must hold; requesting WebGPU without the asset poisons ORT's WASM initialisation.
   */
  async function webgpuAvailable(assetUrl) {
    try {
      if (typeof navigator === "undefined" || !navigator.gpu) return false;
      const res = await fetch(assetUrl("lib/ort/ort-wasm-simd-threaded.jsep.wasm"), { method: "HEAD" });
      if (!res || !res.ok) return false;
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch (_) {
      return false;
    }
  }

  /**
   * Initializes the ONNX Runtime session with offline model weights.
   */
  async function initFaceDetector() {
    if (ortSession) return ortSession;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const ort = global.ort || (typeof require !== "undefined" ? require("onnxruntime-web") : null);
      if (!ort) {
        throw new Error("ONNX Runtime Web library (ort) not found in global scope.");
      }

      const inExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL;
      const assetUrl = (rel) => (inExtension ? chrome.runtime.getURL(rel) : "./" + rel);

      // WASM runtime configuration.
      //  • wasmPaths must point at the bundled binaries — nothing is fetched from a CDN.
      //  • numThreads must be 1: pthreads need SharedArrayBuffer, which needs cross-origin
      //    isolation, which an extension page does not have. Asking for more threads makes
      //    ORT try (and fail) to spawn workers.
      //  • proxy must be false: the proxy worker is a blob worker, and a blob worker cannot
      //    importScripts() a chrome-extension:// URL.
      ort.env.wasm.wasmPaths = assetUrl("lib/ort/");
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;

      const modelUrl = assetUrl("models/version-RFB-320.onnx");

      // Execution provider selection.
      //
      // WebGPU in ORT Web is delivered by a SEPARATE build (ort-wasm-simd-threaded.jsep.*),
      // about 24 MB. It is not bundled by default: for a 1.27 MB detector that already runs in
      // tens of milliseconds on WASM SIMD, 24 MB of extra download is the wrong trade for a
      // client-side privacy tool. See extension/vision/README.md for how to opt in.
      //
      // Crucially, we must not *speculatively* ask for WebGPU and fall back: ORT caches a
      // failed initWasm(), so one failed WebGPU attempt permanently disables WASM in that
      // context. So probe for the asset first and only then choose the provider list.
      const providers = (await webgpuAvailable(assetUrl)) ? ["webgpu", "wasm"] : ["wasm"];

      ortSession = await ort.InferenceSession.create(modelUrl, {
        executionProviders: providers,
        graphOptimizationLevel: "all"
      });
      backendUsed = providers[0];

      console.log(`[vision] UltraFace model loaded successfully (backend: ${backendUsed}).`);
      return ortSession;
    })();

    return initPromise;
  }

  /**
   * Prepares Float32 RGB tensor normalized to (pixel - 127.0) / 128.0.
   */
  function prepareInputTensor(imageSource) {
    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT)
      : document.createElement("canvas");
    canvas.width = MODEL_INPUT_WIDTH;
    canvas.height = MODEL_INPUT_HEIGHT;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    ctx.drawImage(imageSource, 0, 0, MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT);
    const imgData = ctx.getImageData(0, 0, MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT);
    const data = imgData.data;

    const numPixels = MODEL_INPUT_WIDTH * MODEL_INPUT_HEIGHT;
    const floatData = new Float32Array(3 * numPixels);
    const rOffset = 0;
    const gOffset = numPixels;
    const bOffset = 2 * numPixels;

    for (let i = 0; i < numPixels; i++) {
      const srcIdx = i * 4;
      floatData[rOffset + i] = (data[srcIdx] - 127.0) / 128.0;
      floatData[gOffset + i] = (data[srcIdx + 1] - 127.0) / 128.0;
      floatData[bOffset + i] = (data[srcIdx + 2] - 127.0) / 128.0;
    }

    const ort = global.ort || (typeof require !== "undefined" ? require("onnxruntime-web") : null);
    return new ort.Tensor("float32", floatData, [1, 3, MODEL_INPUT_HEIGHT, MODEL_INPUT_WIDTH]);
  }

  /**
   * Detects faces in an image source (ImageBitmap, HTMLCanvasElement, HTMLImageElement, or dataUrl).
   *
   * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement|string} imageSource
   * @param {Object} options - { viewportWidth, viewportHeight, targetWidth, targetHeight, scoreThreshold }
   * @returns {Promise<{ boxes: Array, inferenceMs: number, backend: string }>}
   */
  async function detectFaces(imageSource, options = {}) {
    const t0 = performance.now();
    const session = await initFaceDetector();

    let imageEl = imageSource;
    let needCleanUp = false;

    if (typeof imageSource === "string" && imageSource.startsWith("data:")) {
      const blob = await (await fetch(imageSource)).blob();
      imageEl = await createImageBitmap(blob);
      needCleanUp = true;
    }

    const inputTensor = prepareInputTensor(imageEl);
    const priors = generatePriors();

    const tInfStart = performance.now();
    const results = await session.run({ input: inputTensor });
    const inferenceMs = Math.round(performance.now() - tInfStart);

    const scoresData = results.scores.data; // [1, 4420, 2] -> index 2*i + 1 is face confidence
    const boxesData = results.boxes.data;   // [1, 4420, 4]
    const decodedBoxes = decodeBoxes(boxesData, priors);

    const candidates = [];
    const scoreThreshold = options.scoreThreshold || CONFIDENCE_THRESHOLD;

    for (let i = 0; i < decodedBoxes.length; i++) {
      const faceScore = scoresData[i * 2 + 1];
      if (faceScore >= scoreThreshold) {
        candidates.push({
          box: decodedBoxes[i],
          score: faceScore
        });
      }
    }

    const filtered = nonMaxSuppression(candidates, IOU_THRESHOLD);

    // Target dimensions: map to CSS viewport coordinates or physical screenshot pixels
    const targetW = options.viewportWidth || options.targetWidth || (imageEl.width || MODEL_INPUT_WIDTH);
    const targetH = options.viewportHeight || options.targetHeight || (imageEl.height || MODEL_INPUT_HEIGHT);

    // Convert normalized [xmin, ymin, xmax, ymax] boxes to { x, y, w, h, type: "face" }
    // Adding 10% safety margin around detected face box
    const boxes = filtered.map(item => {
      const b = item.box;
      const rawX = b[0] * targetW;
      const rawY = b[1] * targetH;
      const rawW = (b[2] - b[0]) * targetW;
      const rawH = (b[3] - b[1]) * targetH;

      const padX = rawW * 0.10;
      const padY = rawH * 0.12;

      const x = Math.max(0, Math.round(rawX - padX));
      const y = Math.max(0, Math.round(rawY - padY));
      const w = Math.min(targetW - x, Math.round(rawW + 2 * padX));
      const h = Math.min(targetH - y, Math.round(rawH + 2 * padY));

      return {
        x,
        y,
        w: Math.max(4, w),
        h: Math.max(4, h),
        type: "face",
        reason: "face_detection",
        label: "face",
        confidence: Math.round(item.score * 100) / 100,
        source: "vision_face"
      };
    });

    if (needCleanUp && imageEl && typeof imageEl.close === "function") {
      imageEl.close();
    }

    const totalMs = Math.round(performance.now() - t0);
    console.log(`[vision] Face detection: found ${boxes.length} face(s) in ${inferenceMs}ms (total: ${totalMs}ms, backend: ${backendUsed})`);

    return {
      boxes,
      inferenceMs,
      totalMs,
      backend: backendUsed
    };
  }

  const FaceDetector = {
    initFaceDetector,
    detectFaces,
    generatePriors,
    get backend() { return backendUsed; }
  };

  global.FaceDetector = FaceDetector;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = FaceDetector;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

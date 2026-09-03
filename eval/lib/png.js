/**
 * png.js — Minimal PNG decoder (8-bit, non-interlaced) built on Node's zlib.
 *
 * Used by run-full-eval.js to read the ACTUAL pixels of the redacted screenshot, so the
 * "was this region really masked?" check is a pixel measurement rather than an assumption
 * about what the canvas drew. No third-party image dependency is required.
 */

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes a PNG buffer to { width, height, channels: 4, data: Uint8Array (RGBA) }.
 * Supports bit depth 8, colour types 0 (grey), 2 (RGB), 4 (grey+A) and 6 (RGBA), non-interlaced
 * — which covers everything Chrome's captureVisibleTab and OffscreenCanvas produce.
 */
function decodePNG(input) {
  // Accept Buffer, Uint8Array or ArrayBuffer — puppeteer's page.screenshot() returns a
  // Uint8Array, which has no .equals()/.readUInt32BE().
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file.');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null;

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'PLTE') {
      palette = buffer.subarray(dataStart, dataStart + length);
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + length + 4; // + CRC
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported.');

  const srcChannels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!srcChannels) throw new Error(`Unsupported PNG colour type: ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = srcChannels;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prior = new Uint8Array(stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let i = 0; i < stride; i++) line[i] = raw[rp + i];
    rp += stride;

    // Reverse the PNG per-scanline filter (RFC 2083 §6).
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prior[i];
      const c = i >= bpp ? prior[i - bpp] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`Unknown PNG filter type: ${filter}`);
      }
      line[i] = v;
    }
    prior.set(line);

    // Expand whatever colour type this is into RGBA.
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      if (colorType === 0) {
        out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255;
      } else if (colorType === 2) {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255;
      } else if (colorType === 3) {
        const p = line[s] * 3;
        out[d] = palette[p]; out[d + 1] = palette[p + 1]; out[d + 2] = palette[p + 2]; out[d + 3] = 255;
      } else if (colorType === 4) {
        out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1];
      } else {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3];
      }
    }
  }

  return { width, height, channels: 4, data: out };
}

/** Decodes a `data:image/png;base64,...` URL. */
function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('Malformed data URL.');
  return decodePNG(Buffer.from(dataUrl.slice(comma + 1), 'base64'));
}

/**
 * Statistics for one rectangle of an image, used for the leak check.
 *
 * `maskedFraction` is the share of sampled pixels that are near-black (solid-black redaction).
 * `variance` is the mean per-channel variance, which stays high for unmasked content and
 * collapses toward zero for a flat fill — the signal used when the mode is "blur"/mosaic.
 */
function regionStats(img, box, sampleStep = 2) {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return { sampled: 0, maskedFraction: 1, variance: 0, meanLuma: 0 };

  let sampled = 0, masked = 0, sum = 0, sumSq = 0;
  for (let y = y0; y < y1; y += sampleStep) {
    for (let x = x0; x < x1; x += sampleStep) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (r <= 12 && g <= 12 && b <= 12) masked++;
      sampled++;
      sum += luma;
      sumSq += luma * luma;
    }
  }
  const mean = sum / sampled;
  return {
    sampled,
    maskedFraction: masked / sampled,
    meanLuma: mean,
    variance: Math.max(0, sumSq / sampled - mean * mean),
  };
}

/**
 * The leak test: does any of the region's original ink survive into the redacted image?
 *
 * Comparing against the unredacted reference capture is what makes this a real measurement.
 * Counting "how much of the box is black" instead would penalise the harmless margin around a
 * tightly-drawn mask and reward a mask so large it swallows the page — neither of which is
 * what "did this leak?" means.
 *
 * Method, per ground-truth box:
 *   1. Take the box's median luma in the REFERENCE image — that is the local background.
 *   2. "Ink" is every pixel differing from that background by more than `inkContrast`; those
 *      are the pixels that carry the information (glyphs, facial features).
 *   3. A region leaks when an ink pixel is byte-for-byte unchanged in the redacted image,
 *      because that pixel was never painted over.
 *
 * Mode-agnostic: a blur/mosaic fill changes the pixels too, so it passes on the same terms.
 *
 * @returns {{ inkPixels, unchangedInk, unchangedInkFraction, leaked }}
 */
function inkSurvival(reference, redacted, box, opts = {}) {
  const inkContrast = opts.inkContrast ?? 35;
  const tolerance = opts.tolerance ?? 8;
  const step = opts.step ?? 1;

  const rsx = reference.width / opts.viewportWidth;
  const rsy = reference.height / opts.viewportHeight;
  const dsx = redacted.width / opts.viewportWidth;
  const dsy = redacted.height / opts.viewportHeight;

  const px = (img, x, y) => {
    const cx = Math.min(img.width - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(img.height - 1, Math.max(0, Math.round(y)));
    const i = (cy * img.width + cx) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  // Pass 1: the reference background level inside this box.
  const lumas = [];
  for (let y = box.y; y < box.y + box.h; y += step) {
    for (let x = box.x; x < box.x + box.w; x += step) {
      lumas.push(luma(px(reference, x * rsx, y * rsy)));
    }
  }
  if (!lumas.length) return { inkPixels: 0, unchangedInk: 0, unchangedInkFraction: 0, leaked: false };
  lumas.sort((a, b) => a - b);
  const background = lumas[Math.floor(lumas.length / 2)];

  // Pass 2: compare ink pixels.
  let inkPixels = 0;
  let unchangedInk = 0;
  for (let y = box.y; y < box.y + box.h; y += step) {
    for (let x = box.x; x < box.x + box.w; x += step) {
      const ref = px(reference, x * rsx, y * rsy);
      if (Math.abs(luma(ref) - background) <= inkContrast) continue; // background, carries nothing
      inkPixels++;
      const red = px(redacted, x * dsx, y * dsy);
      const unchanged =
        Math.abs(red[0] - ref[0]) <= tolerance &&
        Math.abs(red[1] - ref[1]) <= tolerance &&
        Math.abs(red[2] - ref[2]) <= tolerance;
      if (unchanged) unchangedInk++;
    }
  }

  const fraction = inkPixels > 0 ? unchangedInk / inkPixels : 0;
  return {
    inkPixels,
    unchangedInk,
    unchangedInkFraction: fraction,
    // A handful of surviving pixels along an antialiased edge is not readable content; a
    // surviving glyph is. 2% of a region's ink is well below one legible character.
    leaked: inkPixels >= 20 && fraction > 0.02,
  };
}

module.exports = { decodePNG, decodeDataUrl, regionStats, inkSurvival };

/**
 * redaction-engine.js — Fail-Closed Privacy Redaction Canvas Engine for VisionVault.
 *
 * Blots out detected PII, credentials, faces, and form regions from raw screenshots
 * before any data leaves the device. Supports black masking, pixelation, and synthetic tokens.
 *
 * FAIL CLOSED: If canvas painting, image decode, or buffer conversion fails, this engine
 * throws RedactionError and NEVER emits or leaks raw pixels.
 */

(function (global) {
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function normalizeBox(r) {
    if (!r) return null;
    const x = r.x ?? r.left ?? r.box?.x ?? 0;
    const y = r.y ?? r.top ?? r.box?.y ?? 0;
    const w = r.w ?? r.width ?? r.box?.width ?? r.box?.w ?? 0;
    const h = r.h ?? r.height ?? r.box?.height ?? r.box?.h ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { x: Math.round(x), y: Math.round(y), w: Math.max(0, Math.round(w)), h: Math.max(0, Math.round(h)) };
  }

  class RedactionError extends Error {
    constructor(message, cause) {
      super(message);
      this.name = "RedactionError";
      this.cause = cause;
    }
  }

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

        // Line-height adaptive boundary dilation: swallows glyph descenders (g, y, j, p, q) and card edges
        const isAadhaarField = (r.label === "aadhaar_card_pii" || r.label === "aadhaar" || r.label === "vid" || (r.reason && r.reason.includes("aadhaar")));
        const isSensitiveId = isAadhaarField || (r.label === "pan" || r.label === "passport" || r.label === "card" || r.label === "credit_card");
        const isPassword = (r.label === "password" || (r.reason && r.reason.includes("password")));

        const padX = isSensitiveId
          ? Math.max(16, Math.min(48, Math.round(Math.max(rw, 24) * 0.18)))
          : Math.max(8, Math.min(24, Math.round(Math.max(rw, 16) * 0.10)));
        const padY = isSensitiveId
          ? Math.max(10, Math.min(28, Math.round(Math.max(rh, 12) * 0.38)))
          : Math.max(7, Math.min(20, Math.round(Math.max(rh, 8) * 0.28)));

        const x0 = clamp(Math.round(rx) - padX, 0, bitmap.width - 1);
        const y0 = clamp(Math.round(ry) - padY, 0, bitmap.height - 1);
        const w0 = Math.max(1, Math.min(bitmap.width - x0, Math.round(rw) + padX * 2));
        const h0 = Math.max(1, Math.min(bitmap.height - y0, Math.round(rh) + padY * 2));

        const isFaceOrMedia = (r.type === "face" || r.type === "media" || r.reason === "face_detection" || r.reason === "face_detection_patch" || r.reason === "possible_face_or_media" || (r.label && /avatar|face|profile/i.test(r.label)));

        if ((mode || "black") === "blur") {
          const step = Math.max(8, Math.min(20, Math.round(Math.min(w0, h0) / 4)));
          for (let bx = x0; bx < x0 + w0; bx += step) {
            for (let by = y0; by < y0 + h0; by += step) {
              const sw = Math.min(step, x0 + w0 - bx);
              const sh = Math.min(step, y0 + h0 - by);
              const px = ctx.getImageData(Math.min(bx + Math.floor(sw / 2), bitmap.width - 1), Math.min(by + Math.floor(sh / 2), bitmap.height - 1), 1, 1).data;
              ctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
              ctx.fillRect(bx, by, sw, sh);
            }
          }
        } else if ((mode || "black") === "synthetic") {
          if (isFaceOrMedia) {
            // Enterprise synthetic silhouette avatar
            ctx.fillStyle = "#0f172a";
            ctx.fillRect(x0, y0, w0, h0);
            ctx.strokeStyle = "#475569";
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 0.5, y0 + 0.5, w0 - 1, h0 - 1);

            ctx.save();
            ctx.beginPath();
            ctx.rect(x0, y0, w0, h0);
            ctx.clip();
            const cx = x0 + w0 / 2;
            const cy = y0 + h0 / 2;
            const radius = Math.min(w0, h0) * 0.22;
            ctx.fillStyle = "#6366f1";
            ctx.beginPath();
            ctx.arc(cx, cy - radius * 0.4, Math.max(4, radius), 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx, cy + radius * 1.6, Math.max(6, radius * 1.5), Math.PI, 0, false);
            ctx.fill();
            ctx.restore();
          } else if (isPassword) {
            // High-tech masked bullet password representation
            ctx.fillStyle = "#090d16";
            ctx.fillRect(x0, y0, w0, h0);
            ctx.strokeStyle = "#818cf8";
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 0.5, y0 + 0.5, w0 - 1, h0 - 1);
            ctx.fillStyle = "#a5b4fc";
            ctx.font = `bold ${Math.max(10, Math.min(16, Math.round(h0 * 0.65)))}px monospace`;
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            ctx.fillText("••••••••", x0 + w0 / 2, y0 + h0 / 2);
          } else {
            // Semantic privacy token badge
            ctx.fillStyle = "#090d16";
            ctx.fillRect(x0, y0, w0, h0);
            const isCritical = isSensitiveId;
            ctx.strokeStyle = isCritical ? "#f59e0b" : "#38bdf8";
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 0.5, y0 + 0.5, w0 - 1, h0 - 1);

            let tokenText = "[MASKED]";
            if (isAadhaarField) tokenText = "[AADHAAR: REDACTED]";
            else if (r.label === "card" || r.label === "credit_card") tokenText = "[CARD: REDACTED]";
            else if (r.label === "pan") tokenText = "[PAN: REDACTED]";
            else if (r.label === "email") tokenText = "[EMAIL: REDACTED]";
            else if (r.label === "phone") tokenText = "[PHONE: REDACTED]";

            if (w0 > 45 && h0 > 13) {
              ctx.fillStyle = isCritical ? "#fbbf24" : "#38bdf8";
              ctx.font = `600 ${Math.max(9, Math.min(12, Math.round(h0 * 0.48)))}px system-ui, -apple-system, monospace`;
              ctx.textBaseline = "middle";
              ctx.textAlign = "center";
              ctx.fillText(tokenText, x0 + w0 / 2, y0 + h0 / 2);
            }
          }
        } else {
          // Fail-closed 100% black ink blot
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
      console.error("[vision] CRITICAL: Redaction failed — aborting request, nothing will be transmitted:", e);
      throw new RedactionError("Redaction failed; request aborted to protect user privacy.", e);
    }
  }

  const RedactionEngine = {
    RedactionError,
    clamp,
    normalizeBox,
    redactImage,
  };

  global.RedactionEngine = RedactionEngine;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RedactionEngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

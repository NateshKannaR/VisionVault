// WebCrypto vault backups and scan summaries.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.VaultCrypto = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const subtle = (typeof crypto !== "undefined" && crypto.subtle)
    ? crypto.subtle
    : (typeof window !== "undefined" && window.crypto ? window.crypto.subtle : null);

  function bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  }

  function base64ToBuffer(b64) {
    const binary = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Derives an AES-GCM 256-bit key from a master password using PBKDF2 with 100,000 iterations.
   */
  async function deriveKey(password, salt) {
    if (!subtle) throw new Error("WebCrypto SubtleCrypto is not available in this environment.");
    const enc = new TextEncoder();
    const keyMaterial = await subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypts vault contents using AES-256-GCM.
   * Returns a tamper-proof JSON-safe envelope.
   */
  async function encryptVault(plainObject, password) {
    if (!password || password.length < 4) {
      throw new Error("Master passphrase must be at least 4 characters long.");
    }
    const enc = new TextEncoder();
    const plainBytes = enc.encode(JSON.stringify(plainObject));

    const salt = (typeof crypto !== "undefined" && crypto.getRandomValues)
      ? crypto.getRandomValues(new Uint8Array(16))
      : new Uint8Array(16);
    const iv = (typeof crypto !== "undefined" && crypto.getRandomValues)
      ? crypto.getRandomValues(new Uint8Array(12))
      : new Uint8Array(12);

    const key = await deriveKey(password, salt);
    const cipherBuffer = await subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plainBytes
    );

    return {
      version: "1.0",
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: 100000,
      salt: bufferToBase64(salt),
      iv: bufferToBase64(iv),
      ciphertext: bufferToBase64(cipherBuffer),
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Decrypts an encrypted vault envelope.
   */
  async function decryptVault(envelope, password) {
    if (!envelope || !envelope.ciphertext || !envelope.iv || !envelope.salt) {
      throw new Error("Invalid .vvault file format.");
    }
    const salt = new Uint8Array(base64ToBuffer(envelope.salt));
    const iv = new Uint8Array(base64ToBuffer(envelope.iv));
    const cipherBuffer = base64ToBuffer(envelope.ciphertext);

    const key = await deriveKey(password, salt);
    let plainBuffer;
    try {
      plainBuffer = await subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        cipherBuffer
      );
    } catch (_) {
      throw new Error("Decryption failed: Incorrect master passphrase or corrupted file.");
    }

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plainBuffer));
  }

  /**
   * Computes a SHA-256 hash of a string or buffer.
   */
  async function sha256(data) {
    if (!subtle) return "N/A (WebCrypto disabled)";
    const enc = new TextEncoder();
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    const hashBuf = await subtle.digest("SHA-256", bytes);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function generateSessionReport({ piiCount, marksCount, timings } = {}) {
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const audit = {
      schemaVersion: 1,
      type: "visionvault_scan_summary",
      generatedAt: new Date().toISOString(),
      detectedRegions: count(piiCount),
      interactiveElements: count(marksCount),
      scanDurationMs: count(timings?.total),
    };
    const integrityChecksum = await sha256(JSON.stringify(audit));
    return {
      json: { ...audit, integrityChecksum },
      html: `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>VisionVault scan summary</title>
<style>
body{font:1rem/1.6 system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.25rem;color:#19312b}
dt{font-weight:700}dd{margin:0 0 1rem}code{overflow-wrap:anywhere}
</style>
<h1>VisionVault scan summary</h1>
<p>Generated from the local scan counters available at export.</p>
<dl>
<dt>Generated at</dt><dd>${audit.generatedAt}</dd>
<dt>Detected regions</dt><dd>${audit.detectedRegions ?? "Unavailable"}</dd>
<dt>Interactive elements</dt><dd>${audit.interactiveElements ?? "Unavailable"}</dd>
<dt>Scan duration</dt><dd>${audit.scanDurationMs === null ? "Unavailable" : audit.scanDurationMs + " ms"}</dd>
<dt>SHA-256 checksum</dt><dd><code>${integrityChecksum}</code></dd>
</dl>
</html>`,
    };
  }

  return {
    encryptVault,
    decryptVault,
    sha256,
    generateSessionReport
  };
});

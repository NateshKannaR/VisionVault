/**
 * pdf-scrubber.js — Zero-Trust In-Memory PDF & Document Redactor for VisionVault
 *
 * Runs 100% on-device in browser volatile RAM.
 * Extracts text layers from PDF, TXT, CSV, JSON, and code files,
 * detects and strips all secrets and PII via PromptScrubber,
 * and outputs sanitized documents/prompts.
 */

(function (global) {
  /**
   * Decompresses a raw FlateDecode / deflate byte buffer using browser native DecompressionStream
   * or Node.js zlib.
   */
  async function decompressFlate(bytes) {
    if (typeof DecompressionStream !== "undefined") {
      try {
        // Try raw deflate stream
        const ds = new DecompressionStream("deflate");
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        let totalLen = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalLen += value.byteLength;
        }
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          result.set(c, offset);
          offset += c.byteLength;
        }
        return new TextDecoder("latin1").decode(result);
      } catch (_) {
        try {
          const dsRaw = new DecompressionStream("deflate-raw");
          const writer = dsRaw.writable.getWriter();
          writer.write(bytes);
          writer.close();
          const reader = dsRaw.readable.getReader();
          const chunks = [];
          let totalLen = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalLen += value.byteLength;
          }
          const result = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) {
            result.set(c, offset);
            offset += c.byteLength;
          }
          return new TextDecoder("latin1").decode(result);
        } catch (__) {
          return new TextDecoder("latin1").decode(bytes);
        }
      }
    } else if (typeof require !== "undefined") {
      const zlib = require("zlib");
      try {
        const buf = zlib.inflateSync(Buffer.from(bytes));
        return buf.toString("latin1");
      } catch (_) {
        try {
          const buf = zlib.inflateRawSync(Buffer.from(bytes));
          return buf.toString("latin1");
        } catch (__) {
          return Buffer.from(bytes).toString("latin1");
        }
      }
    }
    return "";
  }

  /**
   * Extracts text from PDF stream content.
   * Handles Tj, TJ, and text blocks (BT ... ET).
   */
  function extractTextFromPdfStream(streamText) {
    let extracted = "";
    // Match text blocks
    const btBlocks = streamText.match(/BT[\s\S]*?ET/g) || [streamText];

    for (const block of btBlocks) {
      // 1. Match (literal string) Tj
      const tjMatches = [...block.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g)];
      for (const m of tjMatches) {
        extracted += unescapePdfString(m[1]) + " ";
      }

      // 2. Match [(array) (of) (strings)] TJ
      const tjArrayMatches = [...block.matchAll(/\[([\s\S]*?)\]\s*TJ/g)];
      for (const m of tjArrayMatches) {
        const innerStrings = [...m[1].matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g)];
        for (const is of innerStrings) {
          extracted += unescapePdfString(is[1]) + " ";
        }
      }

      // 3. Match ' (move to next line and show text)
      const quoteMatches = [...block.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*'/g)];
      for (const m of quoteMatches) {
        extracted += "\n" + unescapePdfString(m[1]) + " ";
      }
    }

    return extracted.trim();
  }

  function unescapePdfString(str) {
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\b/g, "\b")
      .replace(/\\f/g, "\f")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
  }

  /**
   * Parses raw PDF binary data (Uint8Array / ArrayBuffer) and extracts all text layers.
   */
  async function extractTextFromPdfBytes(pdfBuffer) {
    const bytes = new Uint8Array(pdfBuffer);
    const latin1 = new TextDecoder("latin1").decode(bytes);

    let fullText = "";

    // Find all stream ... endstream chunks
    const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
    let match;

    while ((match = streamRegex.exec(latin1)) !== null) {
      const streamStart = match.index + match[0].indexOf("\n") + 1;
      const streamDataRaw = match[1];

      // Get bytes corresponding to stream
      const streamBytes = bytes.subarray(streamStart, streamStart + streamDataRaw.length);

      // Check dictionary preceding stream for filter
      const headerChunk = latin1.substring(Math.max(0, match.index - 350), match.index);
      const isFlate = headerChunk.includes("/FlateDecode");

      let decodedText = "";
      if (isFlate) {
        decodedText = await decompressFlate(streamBytes);
      } else {
        decodedText = streamDataRaw;
      }

      const streamExtracted = extractTextFromPdfStream(decodedText);
      if (streamExtracted) {
        fullText += streamExtracted + "\n\n";
      }
    }

    // Fallback: If no streams had text (e.g. uncompressed raw text objects in body)
    if (!fullText.trim()) {
      fullText = extractTextFromPdfStream(latin1);
    }

    // Final fallback: Look for printable character sequences (> 4 chars)
    if (!fullText.trim()) {
      const textMatches = latin1.match(/[A-Za-z0-9@._:\-\/]{4,}/g);
      if (textMatches) {
        fullText = textMatches.join(" ");
      }
    }

    return fullText.trim();
  }

  /**
   * Redacts a document (PDF, TXT, CSV, JSON, Code).
   *
   * @param {File|Blob|ArrayBuffer|string} input - The document or file
   * @param {string} fileName - Name of the file (e.g. 'resume.pdf')
   * @returns {Promise<{ sanitizedText: string, originalText: string, findings: Array, tokenMap: Object, stats: Object, fileName: string }>}
   */
  async function redactDocument(input, fileName = "document.pdf") {
    const Scrubber = (typeof PromptScrubber !== "undefined")
      ? PromptScrubber
      : (typeof require !== "undefined" ? require("./prompt-scrubber.js") : null);

    if (!Scrubber) {
      throw new Error("PromptScrubber engine is not loaded.");
    }

    let rawText = "";

    const ext = (fileName || "").toLowerCase().split(".").pop();

    if (ext === "pdf" || (input.type && input.type.includes("pdf"))) {
      let arrayBuffer;
      if (typeof File !== "undefined" && input instanceof File) {
        arrayBuffer = await input.arrayBuffer();
      } else if (typeof Blob !== "undefined" && input instanceof Blob) {
        arrayBuffer = await input.arrayBuffer();
      } else if (input instanceof ArrayBuffer) {
        arrayBuffer = input;
      } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
        arrayBuffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
      } else {
        throw new Error("Unsupported PDF input type.");
      }
      rawText = await extractTextFromPdfBytes(arrayBuffer);
    } else {
      // Plain text, markdown, CSV, JSON, code files
      if (typeof File !== "undefined" && input instanceof File) {
        rawText = await input.text();
      } else if (typeof Blob !== "undefined" && input instanceof Blob) {
        rawText = await input.text();
      } else if (typeof input === "string") {
        rawText = input;
      } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
        rawText = input.toString("utf8");
      }
    }

    const scrubResult = Scrubber.scrub(rawText);

    return {
      fileName,
      originalText: rawText,
      sanitizedText: scrubResult.cleanText,
      findings: scrubResult.findings,
      matches: scrubResult.matches,
      tokenMap: scrubResult.tokenMap,
      stats: scrubResult.stats,
    };
  }

  const PdfScrubber = {
    extractTextFromPdfBytes,
    redactDocument
  };

  global.PdfScrubber = PdfScrubber;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PdfScrubber;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

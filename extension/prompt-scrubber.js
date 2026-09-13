/**
 * prompt-scrubber.js — Zero-Trust In-Memory Prompt, Secret & PII Sanitizer
 *
 * Runs 100% locally on-device in volatile RAM. No prompt text or keys are ever
 * logged or transmitted over the network.
 *
 * Detects:
 * - Cloud & AI API Keys (OpenAI, Anthropic, AWS, GitHub, Google, Slack, HuggingFace)
 * - Database credentials & connection URIs (PostgreSQL, MongoDB, MySQL, Redis)
 * - Private keys & bearer tokens
 * - Global & Indian PII (Emails, phones, credit cards, Aadhaar, PAN, UPI, SSN, passports)
 *
 * Supports deterministic token substitution and reverse de-scrubbing (unmasking).
 */

(function (global) {
  // ── Secret & Credential Regex Patterns ─────────────────────────────────────────
  const SECRET_PATTERNS = [
    {
      type: "anthropic_key",
      label: "Anthropic API Key",
      token: "ANTHROPIC_API_KEY",
      regex: /\b(sk-ant-[a-zA-Z0-9_\-]{20,})\b/g,
    },
    {
      type: "openai_key",
      label: "OpenAI API Key",
      token: "OPENAI_API_KEY",
      regex: /\b(sk-(?!ant-)(?:proj-|svcacct-)?[a-zA-Z0-9_\-]{20,})\b/g,
    },
    {
      type: "aws_access_key",
      label: "AWS Access Key",
      token: "AWS_ACCESS_KEY",
      regex: /\b(AKIA[0-9A-Z]{16})\b/g,
    },
    {
      type: "aws_secret_key",
      label: "AWS Secret Key",
      token: "AWS_SECRET_KEY",
      regex: /\b(?:aws_secret_access_key|aws_secret_key|secret_key)\s*[:=]\s*["']?([a-zA-Z0-9/+=]{40})["']?/gi,
      captureGroup: 1,
    },
    {
      type: "github_token",
      label: "GitHub Token",
      token: "GITHUB_TOKEN",
      regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{50,})\b/g,
    },
    {
      type: "google_api_key",
      label: "Google API Key",
      token: "GOOGLE_API_KEY",
      regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/g,
    },
    {
      type: "slack_token",
      label: "Slack Token",
      token: "SLACK_TOKEN",
      regex: /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/g,
    },
    {
      type: "huggingface_token",
      label: "HuggingFace Token",
      token: "HF_TOKEN",
      regex: /\b(hf_[a-zA-Z0-9]{34,})\b/g,
    },
    {
      type: "database_url",
      label: "Database Connection URI",
      token: "DB_CONNECTION_URI",
      regex: /\b((?:postgres|postgresql|mongodb|mongodb\+srv|mysql|redis):\/\/[^\s"'<>]+)\b/gi,
    },
    {
      type: "private_key",
      label: "Private Key",
      token: "PRIVATE_KEY",
      regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g,
    },
    {
      type: "generic_api_key",
      label: "API Secret / Token",
      token: "API_SECRET",
      regex: /(?:api[_-]?key|access[_-]?token|bearer[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{20,80})["']?/gi,
      captureGroup: 1,
    },
  ];

  // ── PII Regex Patterns ─────────────────────────────────────────────────────────
  const PII_PATTERNS = [
    {
      type: "email",
      label: "Email Address",
      token: "EMAIL",
      regex: /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
    },
    {
      type: "card",
      label: "Payment Card Number",
      token: "CARD_NUMBER",
      regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
    },
    {
      type: "aadhaar",
      label: "Aadhaar Number",
      token: "AADHAAR_NUMBER",
      regex: /\b([2-9]\d{3}[\s-]{0,2}\d{4}[\s-]{0,2}\d{4})\b/g,
    },
    {
      type: "pan",
      label: "PAN Card Number",
      token: "PAN_NUMBER",
      regex: /\b([A-Z]{5}[0-9]{4}[A-Z]{1})\b/g,
    },
    {
      type: "upi",
      label: "UPI ID / VPA",
      token: "UPI_ID",
      regex: /\b([a-zA-Z0-9.\-_]{2,40}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|axl|upi))\b/gi,
    },
    {
      type: "phone",
      label: "Phone Number",
      token: "PHONE_NUMBER",
      regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    },
    {
      type: "ssn",
      label: "Social Security Number",
      token: "SSN",
      regex: /\b(\d{3}[-\s]?\d{2}[-\s]?\d{4})\b/g,
    },
    {
      type: "passport",
      label: "Passport Number",
      token: "PASSPORT_NUMBER",
      regex: /\b([A-Z][0-9]{7})\b/g,
    },
  ];

  /**
   * Sanitizes a text prompt by replacing detected secrets and PII with typed tokens.
   *
   * @param {string} text - Raw prompt or code snippet.
   * @param {Object} [existingTokenMap] - Optional existing token dictionary for consistent substitution.
   * @returns {{ cleanText: string, findings: Array, tokenMap: Object, stats: Object }}
   */
  function scrub(text, existingTokenMap = {}) {
    if (!text || typeof text !== "string") {
      return { cleanText: "", sanitized: "", findings: [], matches: [], tokenMap: {}, stats: { total: 0, secrets: 0, pii: 0 } };
    }

    let cleanText = text;
    const tokenMap = { ...existingTokenMap };
    const findings = [];
    const counts = {};

    // Helper to generate or reuse a token
    function getTokenForValue(val, tokenPrefix) {
      // If we already mapped this exact secret, reuse the token
      for (const [t, orig] of Object.entries(tokenMap)) {
        if (orig === val && t.startsWith(`[${tokenPrefix}_`)) {
          return t;
        }
      }
      counts[tokenPrefix] = (counts[tokenPrefix] || 0) + 1;
      const token = `[${tokenPrefix}_${counts[tokenPrefix]}]`;
      tokenMap[token] = val;
      return token;
    }

    // 1. Process Secrets First
    let secretCount = 0;
    for (const p of SECRET_PATTERNS) {
      const matches = [...cleanText.matchAll(p.regex)];
      for (const m of matches) {
        const rawMatch = p.captureGroup ? m[p.captureGroup] : m[0];
        if (!rawMatch || rawMatch.length < 8) continue;

        const token = getTokenForValue(rawMatch, p.token);
        cleanText = cleanText.split(rawMatch).join(token);
        secretCount++;
        findings.push({
          type: p.type,
          category: "secret",
          label: p.label,
          token,
          maskedValue: rawMatch.slice(0, 4) + "..." + rawMatch.slice(-3),
        });
      }
    }

    // 2. Process PII
    let piiCount = 0;
    for (const p of PII_PATTERNS) {
      const matches = [...cleanText.matchAll(p.regex)];
      for (const m of matches) {
        const rawMatch = p.captureGroup ? m[p.captureGroup] : m[0];
        if (!rawMatch || rawMatch.length < 4) continue;
        // Skip if already a token
        if (rawMatch.startsWith("[") && rawMatch.endsWith("]")) continue;

        const token = getTokenForValue(rawMatch, p.token);
        cleanText = cleanText.split(rawMatch).join(token);
        piiCount++;
        findings.push({
          type: p.type,
          category: "pii",
          label: p.label,
          token,
          maskedValue: rawMatch.slice(0, 3) + "***" + rawMatch.slice(-2),
        });
      }
    }

    return {
      cleanText,
      sanitized: cleanText,
      findings,
      matches: findings,
      tokenMap,
      stats: {
        total: findings.length,
        secrets: secretCount,
        pii: piiCount,
      },
    };
  }

  /**
   * Reverses token replacement in LLM responses by restoring original values.
   *
   * @param {string} text - Response text containing tokens like [OPENAI_API_KEY_1].
   * @param {Object} tokenMap - Dictionary mapping { "[TOKEN]": "originalValue" }.
   * @returns {string} Text with real secrets/PII restored locally.
   */
  function unmask(text, tokenMap = {}) {
    if (!text || typeof text !== "string" || !tokenMap) return text || "";
    let restored = text;
    for (const [token, original] of Object.entries(tokenMap)) {
      if (token && original) {
        restored = restored.split(token).join(original);
      }
    }
    return restored;
  }

  const PromptScrubber = {
    scrub,
    unmask,
    SECRET_PATTERNS,
    PII_PATTERNS,
  };

  global.PromptScrubber = PromptScrubber;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PromptScrubber;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

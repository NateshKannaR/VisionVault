/**
 * obstacle-detector.js — Bot Wall, Overlay & CAPTCHA Detection for VisionVault.
 *
 * Detects blocking bot walls (Cloudflare Turnstile, Google reCAPTCHA, hCaptcha, 2FA OTP modals)
 * and safely dismisses non-transactional overlays (cookie notices, consent modals, banners).
 */

(function (global) {
  const BOT_WALL_URL_RE = /\/(?:nocaptcha|captcha|challenge|bot-?check|are-?you-?human|access-?denied|blocked)\b/i;
  const BOT_WALL_TEXT_RE =
    /\b(?:please verify (?:that )?you are (?:a )?human|complete the security check|enable javascript and cookies to continue|automated (?:queries|access)|suspicious activity detected|security verification)\b/i;
  const BOT_WALL_WIDGET = 'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], ' +
    'iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-running, [id*="cf-challenge"]';

  const CONSENT_CONTEXT_RE =
    /\b(?:cookies?|consent|tracking|gdpr|personalis|personaliz|advertising partners|privacy (?:policy|choices|settings|preferences))\b/i;
  const NEVER_DISMISS_RE = /\b(?:sign\s?in|log\s?in|sign\s?up|register|subscribe|buy|pay|checkout|delete|remove|confirm order|place order)\b/i;
  const TRANSACTIONAL_OVERLAY_RE =
    /\b(?:payment|checkout|order|purchase|billing|card number|cvv|total|delete|permanently|unsubscribe|cancel (?:your )?(?:subscription|booking|order))\b/i;

  const CLOSE_RE = /^(?:✕|×|✕|✖|close|dismiss|got it|ok|okay|no thanks|not now|maybe later|continue|accept all|agree|allow all|reject non-essential|decline optional)$/i;
  const CLOSE_LABEL_RE = /\b(?:close|dismiss|got it|no thanks|reject non-essential|decline optional)\b/i;
  const CONSENT_RE = /\b(?:accept all|agree|allow all|accept cookies|i agree|accept)\b/i;

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (typeof getComputedStyle !== "function") return true;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05) return false;
    return true;
  }

  function controlText(el) {
    if (!el) return "";
    return [
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("title"),
      el.innerText,
      el.value
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function detectObstacleOrCaptcha() {
    if (typeof document === "undefined") return { blocked: false, type: null, description: null };
    const cf = document.querySelector('iframe[src*="turnstile"], div.cf-turnstile, #cf-turnstile, [class*="cf-browser-verification"], #challenge-running, [id*="cf-challenge"]');
    if (cf && isVisible(cf)) {
      return { blocked: true, type: "cloudflare", description: "Cloudflare Turnstile verification challenge detected." };
    }
    const recaptcha = document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha, [class*="recaptcha"]');
    if (recaptcha && isVisible(recaptcha)) {
      return { blocked: true, type: "recaptcha", description: "Google reCAPTCHA challenge detected." };
    }
    const hcaptcha = document.querySelector('iframe[src*="hcaptcha"], .h-captcha, #hcaptcha');
    if (hcaptcha && isVisible(hcaptcha)) {
      return { blocked: true, type: "hcaptcha", description: "hCaptcha verification challenge detected." };
    }
    const twoFactor = document.querySelector('[data-testid*="otp"], [id*="2fa" i], [class*="2fa" i], [id*="otp" i], [class*="otp-modal" i]');
    if (twoFactor && isVisible(twoFactor)) {
      return { blocked: true, type: "2fa", description: "Two-Factor (2FA/OTP) verification prompt detected." };
    }
    return { blocked: false, type: null, description: null };
  }

  function detectBotWall() {
    if (typeof location === "undefined" || typeof document === "undefined") return { blocked: false };
    let href = location.href;
    try { href = decodeURIComponent(href); } catch (_) {}
    if (BOT_WALL_URL_RE.test(href)) return { blocked: true, how: "the site redirected to a verification page" };
    if (document.querySelector(BOT_WALL_WIDGET)) return { blocked: true, how: "the page is showing a CAPTCHA" };
    const text = (document.body && document.body.innerText || "").slice(0, 3000);
    if (BOT_WALL_TEXT_RE.test(text)) return { blocked: true, how: "the page is asking for human verification" };
    return { blocked: false };
  }

  function isBlockingOverlay(el) {
    if (!isVisible(el)) return false;
    if (typeof getComputedStyle !== "function") return false;
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky" && style.position !== "absolute") {
      if (el.getAttribute("role") !== "dialog" && el.getAttribute("aria-modal") !== "true") return false;
    }
    const r = el.getBoundingClientRect();
    const area = (r.width * r.height) / (innerWidth * innerHeight);
    const z = Number(style.zIndex) || 0;
    const isDialog = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || el.tagName === "DIALOG";
    return isDialog || (area > 0.12 && z >= 100) || (area > 0.5 && style.position === "fixed");
  }

  function dismissOverlays(maxToClose = 3) {
    if (typeof document === "undefined") return { dismissed: 0, labels: [] };
    const labels = [];
    const candidates = Array.from(document.querySelectorAll(
      'dialog[open], [role="dialog"], [aria-modal="true"], [class*="cookie" i], [class*="consent" i], ' +
      '[id*="cookie" i], [id*="consent" i], [class*="modal" i], [class*="overlay" i], [class*="popup" i]'
    )).filter(isBlockingOverlay).slice(0, 12);

    for (const overlay of candidates) {
      if (labels.length >= maxToClose) break;
      if (TRANSACTIONAL_OVERLAY_RE.test((overlay.textContent || "").slice(0, 600))) continue;

      const buttons = Array.from(overlay.querySelectorAll('button, [role="button"], a[href="#"], input[type="button"]'))
        .filter(isVisible);

      const overlayText = (overlay.textContent || "").slice(0, 1200);
      const isConsentNotice = CONSENT_CONTEXT_RE.test(overlayText);
      const safe = (b) => !NEVER_DISMISS_RE.test(controlText(b));

      let target = buttons.find((b) => CLOSE_RE.test((b.textContent || "").trim()) && safe(b));
      if (!target) {
        target = buttons.find((b) => CLOSE_LABEL_RE.test(controlText(b)) && safe(b));
      }
      if (!target && isConsentNotice) {
        target = buttons.find((b) => CONSENT_RE.test((b.textContent || "").trim()) && safe(b));
      }
      if (target) {
        const shown = ((target.textContent || "").trim() || controlText(target)).slice(0, 40);
        try { target.click(); labels.push(shown); } catch (_) {}
      }
    }

    if (!labels.length && candidates.length) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
      const stillThere = candidates.filter(isBlockingOverlay).length;
      if (stillThere < candidates.length) labels.push("Escape");
    }

    const openCalendar = document.querySelector('.DayPicker, .datePickerContainer, [class*="calendar" i]:not([style*="display: none"])');
    if (openCalendar && isVisible(openCalendar)) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
      labels.push("Escape (Calendar)");
    }

    return { dismissed: labels.length, labels };
  }

  const ObstacleDetector = {
    detectObstacleOrCaptcha,
    detectBotWall,
    isBlockingOverlay,
    dismissOverlays,
  };

  global.ObstacleDetector = ObstacleDetector;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ObstacleDetector;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

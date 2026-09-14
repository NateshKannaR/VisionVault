/**
 * screenClassifier.js — Client-Side Visual & Layout Screen State Classifier
 *
 * Implements a lightweight client-side vision & layout evaluator that reads
 * the current screen context, Set-of-Marks elements, and visual geometry to
 * categorize the screen state (e.g. FORM_SUBMISSION, AUTHENTICATION,
 * ECOMMERCE_CHECKOUT, SEARCH_DIRECTORY, DOCUMENT_VIEW) directly on-device.
 */

(function (global) {
  const SCREEN_TYPES = {
    FORM_SUBMISSION: "FORM_SUBMISSION",
    AUTHENTICATION: "AUTHENTICATION",
    ECOMMERCE_CHECKOUT: "ECOMMERCE_CHECKOUT",
    SEARCH_DIRECTORY: "SEARCH_DIRECTORY",
    DOCUMENT_VIEW: "DOCUMENT_VIEW",
    DASHBOARD_DATA: "DASHBOARD_DATA",
    GENERAL_INTERACTION: "GENERAL_INTERACTION"
  };

  /**
   * Classifies the visual and structural state of the screen.
   *
   * @param {Object} context
   * @param {Array} context.marks - Set-of-Marks extracted interactive elements
   * @param {Array} context.piiRegions - Detected sensitive regions (faces, credentials, PII)
   * @param {Object} context.pageInfo - Viewport, title, urlPath
   * @returns {Object} { category, confidence, visualComplexity, recommendedStrategy, features }
   */
  function classifyScreenState(context = {}) {
    const marks = Array.isArray(context.marks) ? context.marks : [];
    const pii = Array.isArray(context.piiRegions) ? context.piiRegions : [];
    const pageInfo = context.pageInfo || {};

    let inputCount = 0;
    let passwordCount = 0;
    let buttonCount = 0;
    let searchCount = 0;
    let cartCount = 0;
    let tableOrGridCount = 0;
    let linkCount = 0;

    const lowerTitle = (pageInfo.title || "").toLowerCase();
    const lowerPath = (pageInfo.url_path || pageInfo.url || "").toLowerCase();

    for (const m of marks) {
      const role = (m.role || "").toLowerCase();
      const label = (m.label || "").toLowerCase();
      const tag = (m.tag || "").toLowerCase();

      if (role === "input" || tag === "input" || tag === "textarea") {
        inputCount++;
        if (label.includes("password") || (m.type === "password")) {
          passwordCount++;
        }
        if (label.includes("search") || label.includes("find") || label.includes("query")) {
          searchCount++;
        }
      } else if (role === "button" || tag === "button") {
        buttonCount++;
        if (label.includes("cart") || label.includes("buy") || label.includes("checkout") || label.includes("pay")) {
          cartCount++;
        }
        if (label.includes("search") || label.includes("find")) {
          searchCount++;
        }
      } else if (role === "link" || tag === "a") {
        linkCount++;
      } else if (role === "table" || tag === "table") {
        tableOrGridCount++;
      }
    }

    // Scoring heuristics
    let category = SCREEN_TYPES.GENERAL_INTERACTION;
    let confidence = 0.70;
    let strategy = "hybrid_vlm";

    if (passwordCount > 0 || lowerTitle.includes("login") || lowerTitle.includes("sign in") || lowerPath.includes("login")) {
      category = SCREEN_TYPES.AUTHENTICATION;
      confidence = 0.95;
      strategy = "vault_credentials_only";
    } else if (cartCount > 0 || lowerTitle.includes("cart") || lowerTitle.includes("checkout") || lowerPath.includes("checkout")) {
      category = SCREEN_TYPES.ECOMMERCE_CHECKOUT;
      confidence = 0.92;
      strategy = "confirm_sensitive_actions";
    } else if (inputCount >= 3 || lowerTitle.includes("signup") || lowerTitle.includes("register") || lowerTitle.includes("form")) {
      category = SCREEN_TYPES.FORM_SUBMISSION;
      confidence = 0.94;
      strategy = "vault_autofill_pipeline";
    } else if (searchCount > 0 && marks.length > 8) {
      category = SCREEN_TYPES.SEARCH_DIRECTORY;
      confidence = 0.88;
      strategy = "fast_on_device_search";
    } else if (tableOrGridCount > 0 || marks.length > 25) {
      category = SCREEN_TYPES.DASHBOARD_DATA;
      confidence = 0.82;
      strategy = "som_visual_grounding";
    } else if (inputCount === 0 && linkCount > 5) {
      category = SCREEN_TYPES.DOCUMENT_VIEW;
      confidence = 0.80;
      strategy = "content_scroll_navigation";
    }

    // Visual complexity based on mark density and PII presence
    const density = marks.length / Math.max(1, (pageInfo.viewport_height || 800) / 100);
    const visualComplexity = density > 4 ? "high" : density > 1.5 ? "medium" : "low";

    return {
      category,
      confidence,
      visualComplexity,
      recommendedStrategy: strategy,
      features: {
        totalMarks: marks.length,
        inputs: inputCount,
        passwords: passwordCount,
        buttons: buttonCount,
        redactedPiiZones: pii.length
      }
    };
  }

  const ScreenClassifier = {
    SCREEN_TYPES,
    classifyScreenState
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ScreenClassifier;
  } else {
    global.ScreenClassifier = ScreenClassifier;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

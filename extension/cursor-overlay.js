/**
 * cursor-overlay.js — Visual Ghost Cursor & Interactive Feedback for VisionVault.
 *
 * Renders high-visibility animated cursor, click ripples, and element outlines
 * so the user can easily observe autonomous agent actions in real time.
 */

(function (global) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let cursorEl = null;
  let cursorBadgeEl = null;
  let cursorStyleEl = null;
  let cursorHideTimer = null;

  function ensureCursorStyles() {
    if (typeof document === "undefined") return;
    if (cursorStyleEl && cursorStyleEl.isConnected) return;
    cursorStyleEl = document.createElement("style");
    cursorStyleEl.id = "vagent-cursor-styles";
    cursorStyleEl.textContent = `
      #vagent-cursor-container {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        overflow: hidden !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      #vagent-ghost-cursor {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 28px !important;
        height: 28px !important;
        transform: translate3d(-100px, -100px, 0);
        transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
        pointer-events: none !important;
        filter: drop-shadow(0 3px 10px rgba(0, 0, 0, 0.5));
        opacity: 0;
        will-change: transform, opacity;
      }
      #vagent-ghost-cursor.visible {
        opacity: 1 !important;
      }
      #vagent-cursor-badge {
        position: absolute !important;
        left: 22px !important;
        top: 18px !important;
        background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%) !important;
        color: #e0e7ff !important;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        font-size: 11px !important;
        font-weight: 600 !important;
        padding: 2px 9px !important;
        border-radius: 6px !important;
        white-space: nowrap !important;
        border: 1px solid rgba(165, 180, 252, 0.45) !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35) !important;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.15s ease, transform 0.15s ease;
        pointer-events: none !important;
      }
      #vagent-cursor-badge.visible {
        opacity: 1 !important;
        transform: translateY(0) !important;
      }
      .vagent-click-ripple {
        position: absolute !important;
        border-radius: 50% !important;
        border: 2px solid #818cf8 !important;
        background: rgba(99, 102, 241, 0.25) !important;
        pointer-events: none !important;
        transform: translate(-50%, -50%) scale(0.2);
        animation: vagentRippleAnim 0.45s cubic-bezier(0.1, 0.8, 0.3, 1) forwards !important;
      }
      @keyframes vagentRippleAnim {
        0% { transform: translate(-50%, -50%) scale(0.2); opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(2.4); opacity: 0; }
      }
      .vagent-element-highlight {
        outline: 2.5px solid #6366f1 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 14px rgba(99, 102, 241, 0.55) !important;
        transition: outline 0.15s ease, box-shadow 0.15s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(cursorStyleEl);
  }

  function ensureCursor() {
    if (typeof document === "undefined") return { container: null, cursor: null, badge: null };
    ensureCursorStyles();
    let container = document.getElementById("vagent-cursor-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "vagent-cursor-container";
      container.innerHTML = `
        <div id="vagent-ghost-cursor">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 2L19 12L12 13.5L8.5 21L4 2Z" fill="#6366f1" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="2.2" fill="#a5b4fc"/>
          </svg>
          <div id="vagent-cursor-badge"></div>
        </div>
      `;
      (document.body || document.documentElement).appendChild(container);
    }
    cursorEl = document.getElementById("vagent-ghost-cursor");
    cursorBadgeEl = document.getElementById("vagent-cursor-badge");
    return { container, cursor: cursorEl, badge: cursorBadgeEl };
  }

  async function moveVisualCursor(targetX, targetY, label = "") {
    try {
      const { cursor, badge } = ensureCursor();
      if (!cursor) return;

      clearTimeout(cursorHideTimer);
      cursor.classList.add("visible");
      cursor.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;

      if (badge) {
        if (label) {
          badge.textContent = label;
          badge.classList.add("visible");
        } else {
          badge.classList.remove("visible");
        }
      }

      await delay(260);
    } catch (_) {}
  }

  function playClickRipple(x, y) {
    try {
      const { container } = ensureCursor();
      if (!container) return;
      const ripple = document.createElement("div");
      ripple.className = "vagent-click-ripple";
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      ripple.style.width = "34px";
      ripple.style.height = "34px";
      container.appendChild(ripple);
      setTimeout(() => {
        try { ripple.remove(); } catch (_) {}
      }, 500);
    } catch (_) {}
  }

  function highlightElement(el) {
    if (!el || !el.classList) return;
    try {
      el.classList.add("vagent-element-highlight");
      setTimeout(() => {
        try { el.classList.remove("vagent-element-highlight"); } catch (_) {}
      }, 600);
    } catch (_) {}
  }

  function scheduleCursorFade(ms = 1800) {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      try {
        if (cursorEl) cursorEl.classList.remove("visible");
        if (cursorBadgeEl) cursorBadgeEl.classList.remove("visible");
      } catch (_) {}
    }, ms);
  }

  const CursorOverlay = {
    ensureCursorStyles,
    ensureCursor,
    moveVisualCursor,
    playClickRipple,
    highlightElement,
    scheduleCursorFade,
  };

  global.CursorOverlay = CursorOverlay;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = CursorOverlay;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

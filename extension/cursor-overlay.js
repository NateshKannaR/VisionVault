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

  let currentCursorX = typeof window !== "undefined" ? Math.round(window.innerWidth * 0.45) : 100;
  let currentCursorY = typeof window !== "undefined" ? Math.round(window.innerHeight * 0.45) : 100;

  function generateCubicBezierPoints(x0, y0, x3, y3, steps = 20) {
    const dx = x3 - x0;
    const dy = y3 - y0;
    const dist = Math.hypot(dx, dy);

    if (dist < 5) return [{ x: x3, y: y3 }];

    const nx = -dy / dist;
    const ny = dx / dist;
    const lateralFactor1 = (Math.random() * 0.35 - 0.175) * dist;
    const lateralFactor2 = (Math.random() * 0.35 - 0.175) * dist;

    const p1Dist = 0.25 + Math.random() * 0.15;
    const cx1 = x0 + dx * p1Dist + nx * lateralFactor1;
    const cy1 = y0 + dy * p1Dist + ny * lateralFactor1;

    const p2Dist = 0.65 + Math.random() * 0.15;
    const cx2 = x0 + dx * p2Dist + nx * lateralFactor2;
    const cy2 = y0 + dy * p2Dist + ny * lateralFactor2;

    const points = [];
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const t = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const oneMinusT = 1 - t;

      let bx =
        Math.pow(oneMinusT, 3) * x0 +
        3 * Math.pow(oneMinusT, 2) * t * cx1 +
        3 * oneMinusT * Math.pow(t, 2) * cx2 +
        Math.pow(t, 3) * x3;

      let by =
        Math.pow(oneMinusT, 3) * y0 +
        3 * Math.pow(oneMinusT, 2) * t * cy1 +
        3 * oneMinusT * Math.pow(t, 2) * cy2 +
        Math.pow(t, 3) * y3;

      if (i < steps) {
        bx += (Math.random() - 0.5) * 1.4;
        by += (Math.random() - 0.5) * 1.4;
      }
      points.push({ x: bx, y: by });
    }
    return points;
  }

  async function moveVisualCursor(targetX, targetY, label = "") {
    try {
      const { cursor, badge } = ensureCursor();
      if (!cursor) return;

      clearTimeout(cursorHideTimer);
      cursor.classList.add("visible");

      if (badge) {
        if (label) {
          badge.textContent = label;
          badge.classList.add("visible");
        } else {
          badge.classList.remove("visible");
        }
      }

      const startX = currentCursorX;
      const startY = currentCursorY;
      const dist = Math.hypot(targetX - startX, targetY - startY);

      // Fitts's law organic duration (120ms to 320ms)
      const totalDuration = Math.min(320, Math.max(120, 80 + Math.log2(1 + dist / 25) * 40));
      const steps = Math.min(24, Math.max(6, Math.round(dist / 30)));
      const points = generateCubicBezierPoints(startX, startY, targetX, targetY, steps);
      const stepDelay = totalDuration / steps;

      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        cursor.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0)`;

        if (i % 2 === 0 || i === points.length - 1) {
          try {
            const moveTarget = document.elementFromPoint(pt.x, pt.y) || document.body;
            if (moveTarget) {
              const moveOpts = {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: pt.x,
                clientY: pt.y,
                screenX: pt.x + (window.screenX || 0),
                screenY: pt.y + (window.screenY || 0)
              };
              if (typeof PointerEvent === "function") {
                moveTarget.dispatchEvent(new PointerEvent("pointermove", moveOpts));
              }
              moveTarget.dispatchEvent(new MouseEvent("mousemove", moveOpts));
            }
          } catch (_) {}
        }

        if (stepDelay >= 4) {
          await delay(stepDelay);
        }
      }

      currentCursorX = targetX;
      currentCursorY = targetY;
      cursor.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      await delay(35);
    } catch (_) {}
  }

  async function smoothMomentumScroll(targetEl, deltaY, duration = 380) {
    const scrollTarget = targetEl || (typeof window !== "undefined" ? window : null);
    if (!scrollTarget) return;
    const isWindow = scrollTarget === window;
    const startScroll = isWindow ? window.scrollY : scrollTarget.scrollTop;
    const startTime = performance.now();

    return new Promise((resolve) => {
      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 4);
        const currentPos = startScroll + deltaY * ease;

        if (isWindow) {
          window.scrollTo(0, currentPos);
        } else {
          scrollTarget.scrollTop = currentPos;
        }

        try {
          const wheelEvent = new WheelEvent("wheel", {
            deltaY: (deltaY / (duration / 16)),
            bubbles: true,
            cancelable: true
          });
          (isWindow ? document.body : scrollTarget).dispatchEvent(wheelEvent);
        } catch (_) {}

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
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
    generateCubicBezierPoints,
    smoothMomentumScroll,
    playClickRipple,
    highlightElement,
    scheduleCursorFade,
  };

  global.CursorOverlay = CursorOverlay;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = CursorOverlay;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

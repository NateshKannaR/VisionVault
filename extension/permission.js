const allowBtn = document.getElementById("allowBtn");
const statusEl = document.getElementById("status");

async function requestAccess() {
  if (allowBtn) {
    allowBtn.disabled = true;
    allowBtn.textContent = "Requesting permission…";
  }
  statusEl.textContent = "Please click \"Allow\" when Chrome asks for microphone access…";
  statusEl.className = "info";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop all audio tracks immediately once permission is verified
    stream.getTracks().forEach((track) => track.stop());

    statusEl.textContent = "✓ Microphone access granted! Closing tab…";
    statusEl.className = "success";
    if (allowBtn) {
      allowBtn.textContent = "✓ Access Granted";
      allowBtn.style.background = "#10b981";
    }

    try {
      chrome.runtime.sendMessage({ type: "MIC_PERMISSION_GRANTED" });
    } catch (_) {}

    setTimeout(() => {
      window.close();
    }, 1200);
  } catch (err) {
    console.warn("Microphone request error:", err);
    if (allowBtn) {
      allowBtn.disabled = false;
      allowBtn.textContent = "Try Again";
    }
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      statusEl.textContent = "Microphone was blocked. Please click the site settings icon (left of URL) or allow microphone in Chrome.";
    } else {
      statusEl.textContent = `Error: ${err.message || err.name}. Please check your system microphone.`;
    }
    statusEl.className = "error";
  }
}

if (allowBtn) {
  allowBtn.addEventListener("click", () => {
    requestAccess();
  });
}

// Auto-request once DOM is ready
window.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    requestAccess();
  }, 100);
});

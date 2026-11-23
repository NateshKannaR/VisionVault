"use strict";

const samples = {
  support: "Help triage this support ticket.\n\nContact: riley@example.test\nPhone: +1 (415) 555-0136\n\nIssue: Cannot access the demo portal.",
  config: "Inspect this demo configuration.\n\nDATABASE_URL=postgres://demo:password@localhost/demo\nOWNER_EMAIL=dev@example.test",
  form: "Validate this sample registration.\n\nEmail: jordan@example.test\nPhone: +1 (415) 555-0136",
};

const source = document.getElementById("source");
const preview = document.getElementById("preview");
const matchCount = document.getElementById("match-count");
const findings = document.getElementById("lab-findings");
const copy = document.getElementById("copy");
const clear = document.getElementById("clear-lab");
const status = document.getElementById("lab-status");
const sampleButtons = [...document.querySelectorAll("[data-example]")];
let sanitized = "";

function showLabStatus(message) {
  status.textContent = message;
  status.hidden = !message;
}

function renderLab(sample) {
  showLabStatus("");
  const input = source.value;
  clear.disabled = !input;
  sampleButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.example === sample)));
  let matches;
  try {
    ({ sanitized, matches } = PromptScrubber.scrub(input));
  } catch {
    sanitized = "";
    matches = [];
    showLabStatus("The local scrubber could not load. Reload the page to try again.");
  }

  const tokens = new Set(matches.map(({ token }) => token));
  const nodes = sanitized.split(/(\[[A-Z0-9_]+_\d+\])/).map((part) => {
    if (!tokens.has(part)) return document.createTextNode(part);
    const mark = document.createElement("mark");
    mark.textContent = part;
    return mark;
  });
  preview.replaceChildren(...nodes);
  preview.dataset.empty = String(!sanitized);
  if (!sanitized) preview.textContent = "Redacted text appears here.";
  copy.disabled = !sanitized;

  const count = matches.length;
  matchCount.textContent = !input ? "—" : count === 0 ? "0 matches" : count === 1 ? "1 match" : count + " matches";
  const categories = new Map();
  for (const { label } of matches) categories.set(label, (categories.get(label) || 0) + 1);
  findings.replaceChildren(...Array.from(categories, ([label, total]) => {
    const item = document.createElement("li");
    item.textContent = total + " " + label;
    return item;
  }));
  findings.hidden = !count;
  if (input.trim() && !count && sanitized) showLabStatus("No supported patterns matched.");
}

function loadSample(sample) {
  source.value = samples[sample];
  renderLab(sample);
}

for (const button of sampleButtons) button.addEventListener("click", () => loadSample(button.dataset.example));
source.addEventListener("input", () => renderLab());
clear.addEventListener("click", () => {
  source.value = "";
  renderLab();
  source.focus();
});
copy.addEventListener("click", async () => {
  const output = sanitized;
  try {
    await navigator.clipboard.writeText(output);
    if (sanitized === output) showLabStatus("Redacted output copied.");
  } catch {
    if (sanitized === output) {
      showLabStatus("Select and copy the output manually.");
      preview.focus();
    }
  }
});
loadSample("support");

const menu = document.getElementById("site-menu");
const navigation = document.getElementById("site-navigation");
const mobile = window.matchMedia("(max-width: 760px)");
menu.hidden = false;
menu.closest(".vv-header").dataset.menuReady = "";

function setMenuOpen(open) {
  menu.setAttribute("aria-expanded", String(open));
  navigation.classList.toggle("is-open", open);
}
menu.addEventListener("click", () => setMenuOpen(menu.getAttribute("aria-expanded") !== "true"));
mobile.addEventListener("change", () => setMenuOpen(false));
navigation.addEventListener("click", (event) => {
  if (event.target.closest("a")) setMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    setMenuOpen(false);
    menu.focus();
  }
});

const video = document.getElementById("demoVideoPlayer");
const chapters = [...document.querySelectorAll("[data-seek]")];

function setCurrentChapter(current) {
  for (const button of chapters) {
    if (button === current) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

for (const button of chapters) {
  button.addEventListener("click", () => {
    video.currentTime = Number(button.dataset.seek);
    setCurrentChapter(button);
    video.play().catch(() => {});
    if (mobile.matches) video.scrollIntoView({ block: "nearest" });
  });
}
function syncChapter() {
  if (video.seeking) return;
  const timestamp = Math.round(video.currentTime * 1000) / 1000;
  const current = chapters.findLast((button) => Number(button.dataset.seek) <= timestamp);
  setCurrentChapter(current);
}
video.addEventListener("timeupdate", syncChapter);
video.addEventListener("seeked", syncChapter);

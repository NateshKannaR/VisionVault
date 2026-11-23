"use strict";

const examples = {
  support: "Help triage this support ticket.\nContact: riley@example.test\nReference: contact details should be kept private.",
  config: "Inspect this demo configuration.\nDATABASE_URL=postgres://demo:password@localhost/demo\nOWNER_EMAIL=dev@example.test",
  form: "Validate this sample registration.\nEmail: jordan@example.test\nPhone: +1 (415) 555-0136",
};

const source = document.getElementById("source");
const preview = document.getElementById("preview");
const matchCount = document.getElementById("match-count");
const copy = document.getElementById("copy");
const status = document.getElementById("lab-status");
const buttons = [...document.querySelectorAll("[data-example]")];
let sanitized = "";

function render() {
  status.textContent = "";
  try {
    const result = PromptScrubber.scrub(source.value);
    sanitized = result.sanitized;
    const tokens = new Set(result.matches.map((match) => match.token));
    const nodes = sanitized.split(/(\[[A-Z_]+_\d+\])/).map((part) => {
      if (!tokens.has(part)) return document.createTextNode(part);
      const mark = document.createElement("mark");
      mark.textContent = part;
      return mark;
    });
    preview.replaceChildren(...nodes);
    const count = result.matches.length;
    matchCount.textContent = count + (count === 1 ? " match" : " matches");
    copy.disabled = !sanitized;
  } catch {
    sanitized = "";
    copy.disabled = true;
    preview.textContent = "";
    matchCount.textContent = "Unavailable";
    status.textContent = "The scrubber could not load.";
  }
}

function setExample(example) {
  source.value = examples[example];
  buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.example === example)));
  render();
}

buttons.forEach((button) => button.addEventListener("click", () => setExample(button.dataset.example)));
source.addEventListener("input", () => {
  buttons.forEach((button) => button.setAttribute("aria-pressed", "false"));
  render();
});
copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(sanitized);
    status.textContent = "Copied.";
  } catch {
    status.textContent = "Select and copy the sanitized text.";
    preview.focus();
  }
});
setExample("support");

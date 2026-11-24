(() => {
  bindTabs($("shieldTabs"));

  const prompt = $("rawPromptInput");
  const promptOutput = $("scrubbedPromptOutput");
  const PLACEHOLDER = /\[[A-Z0-9_]+_\d+\]/g;
  const reply = $("llmResponseInput");
  const fileInput = $("pdfFileInput");
  const dropZone = $("pdfDropZone");
  const sources = new Map();
  let promptResult = null;
  let promptSpans = [];
  let manualMasks = 0;
  let undoMask = null;
  let documentTokens = {};
  let fileJob = 0;
  let chatJob = 0;
  let chatRevision = 0;
  let chatTarget = "";

  function renderFindings(result, list, counter) {
    const counts = new Map();
    for (const { label } of result.findings) counts.set(label, (counts.get(label) || 0) + 1);

    list.replaceChildren();
    for (const [label, count] of counts) {
      const item = document.createElement("li");
      item.textContent = `${label} · ${count}`;
      list.append(item);
    }

    const total = result.findings.length;
    counter.textContent = total ? `${total} match${total === 1 ? "" : "es"}` : "No matches";
  }

  function clearRestoredOutput() {
    $("unmaskedWrap").hidden = true;
    $("unmaskedOutput").value = "";
    hideStatus("restoreStatus");
  }

  function refreshRestore() {
    const select = $("restoreSource");
    const chosen = select.value;
    select.replaceChildren(new Option(sources.size ? "Choose a token source" : "No token sources yet", ""));
    for (const [key, source] of sources) select.add(new Option(source.label, key));
    select.value = sources.has(chosen) ? chosen : sources.size === 1 ? sources.keys().next().value : "";
    select.disabled = sources.size === 0;
    $("unmaskBtn").disabled = !select.value || !reply.value.trim();
    clearRestoredOutput();
  }

  function setSource(key, label, tokenMap) {
    if (tokenMap && Object.keys(tokenMap).length) {
      if (sources.size === 1 && !sources.has(key)) $("restoreSource").value = "";
      sources.set(key, { label, tokenMap });
    } else {
      sources.delete(key);
    }
    refreshRestore();
  }

  function updateTextState() {
    $("scrubPromptBtn").disabled = !prompt.value.trim();
    $("clearPromptBtn").disabled = !prompt.value;
    $("scrubFindingsWrap").hidden = true;
    promptOutput.value = "";
    promptResult = null;
    promptSpans = [];
    manualMasks = 0;
    undoMask = null;
    syncMaskTools();
    setSource("text");
    hideStatus("shieldTextStatus");
    hideStatus("shieldCopyStatus");
  }

  function withPermanentMasks(text, tokenMap) {
    return text.replace(PLACEHOLDER, (token) => Object.hasOwn(tokenMap, token) ? "[REDACTED]" : token);
  }

  function syncMaskTools() {
    const selection = promptOutput.value.slice(promptOutput.selectionStart, promptOutput.selectionEnd);
    $("maskPromptSelection").disabled = !selection.trim() || selection === "[REDACTED]";
    $("undoPromptMask").disabled = undoMask === null;
    $("manualMaskCount").textContent = manualMasks
      ? `${manualMasks} manual mask${manualMasks === 1 ? "" : "s"}`
      : "";
  }

  function renderPromptOutput() {
    if (!promptResult) return;
    const { cleanText, tokenMap } = promptResult;
    const permanent = $("permanentMasks").checked;
    const visibleMap = {};
    promptSpans = [];
    let shift = 0;
    promptOutput.value = cleanText.replace(PLACEHOLDER, (token, offset) => {
      if (!Object.hasOwn(tokenMap, token)) return token;
      visibleMap[token] = tokenMap[token];
      const shown = permanent ? "[REDACTED]" : token;
      const start = offset + shift;
      shift += shown.length - token.length;
      promptSpans.push({ sourceStart: offset, sourceEnd: offset + token.length, start, end: start + shown.length });
      return shown;
    });
    setSource("text", "Masked prompt", permanent ? null : visibleMap);
    hideStatus("shieldCopyStatus");
    syncMaskTools();
  }

  function originalOffset(offset, edge) {
    let shift = 0;
    for (const span of promptSpans) {
      if (offset <= span.start) break;
      if (offset < span.end) return edge === "start" ? span.sourceStart : span.sourceEnd;
      shift = span.sourceEnd - span.end;
    }
    return offset + shift;
  }

  promptOutput.addEventListener("select", syncMaskTools);
  $("maskPromptSelection").addEventListener("click", () => {
    if (!promptResult || $("maskPromptSelection").disabled) return;
    const { selectionStart, selectionEnd } = promptOutput;
    const start = originalOffset(selectionStart, "start");
    const end = originalOffset(selectionEnd, "end");
    const text = promptResult.cleanText;
    undoMask = text;
    promptResult.cleanText = text.slice(0, start) + "[REDACTED]" + text.slice(end);
    manualMasks++;
    renderPromptOutput();
    promptOutput.focus();
    promptOutput.setSelectionRange(0, 0);
    syncMaskTools();
    showStatus("shieldCopyStatus", "success", "Selected text replaced with [REDACTED].");
  });
  $("undoPromptMask").addEventListener("click", () => {
    if (!promptResult || undoMask === null) return;
    promptResult.cleanText = undoMask;
    undoMask = null;
    manualMasks--;
    renderPromptOutput();
    promptOutput.focus();
    showStatus("shieldCopyStatus", "info", "Last manual mask undone.");
  });

  async function copyMaskedText(output, status) {
    if (!output.value) return;
    try {
      await navigator.clipboard.writeText(output.value);
      showStatus(status, "success", "Masked text copied.");
    } catch (_) {
      output.focus();
      output.select();
      showStatus(status, "error", "Clipboard access failed. The masked text is selected for manual copy.");
    }
  }

  async function downloadMaskedText(text, filename, status) {
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=UTF-8" }));
    try {
      await chrome.downloads.download({ url, filename });
      showStatus(status, "success", "Masked text download started.");
    } catch (_) {
      showStatus(status, "error", "The download did not start. Try copying the text instead.");
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  prompt.addEventListener("input", updateTextState);
  $("loadPromptSample").addEventListener("click", () => {
    if (prompt.value.trim() && !window.confirm("Replace the current input with a sample?")) return;
    prompt.value = "Draft an incident update for jordan@example.test. The callback number is +1 (202) 555-0142.";
    updateTextState();
    prompt.focus();
  });
  $("clearPromptBtn").addEventListener("click", () => {
    prompt.value = "";
    updateTextState();
    prompt.focus();
  });
  $("scrubPromptBtn").addEventListener("click", () => {
    if (!prompt.value.trim()) return;
    try {
      promptResult = PromptScrubber.scrub(prompt.value);
      manualMasks = 0;
      undoMask = null;
      renderFindings(promptResult, $("scrubFindingsList"), $("scrubFindingsCount"));
      renderPromptOutput();
      $("scrubFindingsWrap").hidden = false;
      showStatus("shieldTextStatus", "success", "Masking complete. Review the output below.");
    } catch (_) {
      updateTextState();
      showStatus("shieldTextStatus", "error", "Masking failed. No output was generated.");
    }
  });
  $("permanentMasks").addEventListener("change", renderPromptOutput);
  $("copyCleanPromptBtn").addEventListener("click", () => copyMaskedText($("scrubbedPromptOutput"), "shieldCopyStatus"));
  $("saveCleanPromptBtn").addEventListener("click", () => downloadMaskedText($("scrubbedPromptOutput").value, "visionvault-masked-prompt.txt", "shieldCopyStatus"));

  function resetFile() {
    fileJob++;
    documentTokens = {};
    fileInput.value = "";
    $("pdfResultWrap").hidden = true;
    $("pdfSanitizedOutput").value = "";
    $("pdfFileNameDisplay").textContent = "";
    $("pdfDropZoneTitle").textContent = "Choose a file or drop it here";
    hideStatus("fileStatus");
    hideStatus("fileOutputStatus");
    setSource("file");
  }

  async function processFile(file) {
    resetFile();
    const job = fileJob;
    const sizeLimit = 5 * 1024 * 1024;
    if (file.size > sizeLimit) {
      showStatus("fileStatus", "error", "Choose a file that is 5 MB or smaller.");
      return;
    }
    const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    $("pdfDropZoneTitle").textContent = "Processing file locally…";
    try {
      const bytes = await file.arrayBuffer();
      if (!isPdf && (!/\.(txt|csv|json|md|py|js|ts|log|env|xml|html|ya?ml)$/i.test(file.name) || new Uint8Array(bytes).includes(0))) {
        throw new Error("Choose a PDF or a supported UTF-8 text file.");
      }
      const input = isPdf ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const report = await PdfScrubber.redactDocument(input, isPdf ? "document.pdf" : "document.txt", { maxTextLength: 200000 });
      if (job !== fileJob) return;
      if (!report.sanitizedText.trim()) throw new Error("No readable text was found. Scanned PDFs require a text layer.");
      documentTokens = report.tokenMap;
      $("pdfSanitizedOutput").value = report.sanitizedText;
      $("pdfFileNameDisplay").textContent = file.name;
      renderFindings(report, $("pdfFindingsList"), $("pdfFindingsCount"));
      setSource("file", "Masked document", report.tokenMap);
      $("pdfResultWrap").hidden = false;
      showStatus("fileStatus", "success", "Masked text is ready to review.");
    } catch (err) {
      if (job === fileJob) showStatus("fileStatus", "error", err.message || "Unable to read the file.");
    } finally {
      if (job === fileJob) $("pdfDropZoneTitle").textContent = "Choose a file or drop it here";
    }
  }

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    const file = event.dataTransfer.files[0];
    if (file) processFile(file);
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) processFile(file);
  });
  $("clearDocBtn").addEventListener("click", () => {
    resetFile();
    dropZone.focus();
  });
  $("copyCleanDocBtn").addEventListener("click", () => copyMaskedText($("pdfSanitizedOutput"), "fileOutputStatus"));
  $("downloadCleanDocBtn").addEventListener("click", () => downloadMaskedText($("pdfSanitizedOutput").value, "visionvault-masked-document.txt", "fileOutputStatus"));

  async function activeChat() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const url = new URL(tab.url);
    const providers = { "chatgpt.com": "ChatGPT", "chat.openai.com": "ChatGPT", "claude.ai": "Claude", "gemini.google.com": "Gemini" };
    const provider = url.protocol === "https:" && Object.hasOwn(providers, url.hostname) && providers[url.hostname];
    return provider ? { id: tab.id, provider, url: tab.url } : null;
  }

  async function refreshChat() {
    const revision = ++chatRevision;
    const chat = await activeChat().catch(() => null);
    if (revision !== chatRevision) return;
    $("chatDetectedCard").hidden = !chat;
    $("sendDocToChatBtn").hidden = !chat;
    $("activeChatBadge").textContent = chat?.provider || "";
    const target = chat ? `${chat.id}:${chat.url}` : "";
    if (target !== chatTarget) {
      chatTarget = target;
      chatJob++;
      hideStatus("chatScrubStatus");
    }
  }

  async function updateChat(button, message, status) {
    const job = chatJob;
    button.disabled = true;
    hideStatus(status);
    try {
      const chat = await activeChat();
      if (job !== chatJob) return null;
      if (!chat) throw new Error("Open a supported chat and focus its draft.");
      const response = await chrome.tabs.sendMessage(chat.id, message, { frameId: 0 });
      if (job !== chatJob) return null;
      if (!response?.ok) throw new Error(response?.error || "The chat draft could not be updated.");
      return response;
    } catch (error) {
      if (job === chatJob) showStatus(status, "error", error.message || "The chat draft could not be updated.");
      return null;
    } finally {
      button.disabled = false;
    }
  }

  $("tab-shield").addEventListener("click", refreshChat);
  chrome.tabs.onActivated.addListener(refreshChat);
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.active && (change.url || change.status === "complete")) refreshChat();
  });
  $("scrubActiveChatBtn").addEventListener("click", async (event) => {
    const response = await updateChat(event.currentTarget, { type: "SCRUB_CHAT_INPUT" }, "chatScrubStatus");
    if (!response) return;
    if (response.stats.total) setSource("chat", "Masked chat draft", response.tokenMap);
    showStatus("chatScrubStatus", "success", response.stats.total
      ? `Masked ${response.stats.total} match${response.stats.total === 1 ? "" : "es"} in the chat draft.`
      : "No matching sensitive patterns in the draft.");
  });
  $("sendDocToChatBtn").addEventListener("click", async (event) => {
    const text = withPermanentMasks($("pdfSanitizedOutput").value, documentTokens);
    if (!text) return;
    const response = await updateChat(event.currentTarget, { type: "INSERT_TEXT_TO_INPUT", text }, "fileOutputStatus");
    if (response) showStatus("fileOutputStatus", "success", "Masked text appended to the draft.");
  });

  $("restoreSource").addEventListener("change", refreshRestore);
  reply.addEventListener("input", refreshRestore);
  $("unmaskBtn").addEventListener("click", () => {
    const tokens = sources.get($("restoreSource").value)?.tokenMap;
    if (!tokens || !reply.value.trim()) return;
    const restored = PromptScrubber.unmask(reply.value, tokens);
    if (restored === reply.value) {
      showStatus("restoreStatus", "warn", "No placeholders from the selected source were found.");
      return;
    }
    $("unmaskedOutput").value = restored;
    $("unmaskedWrap").hidden = false;
  });
  $("clearShieldSession").addEventListener("click", () => {
    chatJob++;
    sources.clear();
    prompt.value = "";
    reply.value = "";
    $("permanentMasks").checked = false;
    updateTextState();
    resetFile();
    hideStatus("chatScrubStatus");
    showStatus("restoreStatus", "success", "Shield inputs and token mappings cleared.");
  });

  refreshRestore();
  refreshChat();
})();

const scanReview = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const detectors = {
    dom: { label: "Page elements", color: "var(--src-dom)" },
    vision_face: { label: "Face detection", color: "var(--src-face)" },
    vision_ocr: { label: "Image text (OCR)", color: "var(--src-ocr)" },
    other: { label: "Other detector", color: "var(--text-muted)" },
  };
  const reasons = {
    sensitive_input: "Sensitive form field",
    nearby_label_pii: "Field near a sensitive label",
    pii_text_match: "Sensitive text pattern",
    face_detection: "Face",
    ocr_pii_match: "Sensitive text in an image",
  };
  const filter = $("regionSource");
  const list = $("reviewRegionList");
  const outlineToggle = $("overlayToggle");
  const originalToggle = $("xrayToggle");
  const modal = $("previewZoomDialog");
  const zoomViewport = $("previewViewport");
  const zoomStage = $("zoomStage");
  const zoomImage = $("zoomPreview");
  const zoom = $("previewZoomLevel");
  const overlays = [$("regionOverlay"), $("zoomOverlay")];
  let rows = [];
  let selected = null;
  let viewport = null;
  let image = "";

  function shownRows() {
    return rows.filter(({ sources }) => filter.value === "all" || sources.includes(filter.value));
  }

  function drawRegions(visible) {
    for (const overlay of overlays) {
      overlay.replaceChildren();
      if (!image || !viewport?.w || !viewport?.h || outlineToggle.getAttribute("aria-pressed") !== "true") continue;
      overlay.setAttribute("viewBox", `0 0 ${viewport.w} ${viewport.h}`);
      for (const row of visible) {
        const { x, y, w, h, sources } = row;
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
        const rectangle = document.createElementNS(SVG_NS, "rect");
        rectangle.setAttribute("x", x);
        rectangle.setAttribute("y", y);
        rectangle.setAttribute("width", w);
        rectangle.setAttribute("height", h);
        rectangle.setAttribute("rx", "2");
        rectangle.setAttribute("vector-effect", "non-scaling-stroke");
        rectangle.dataset.region = row.id;
        rectangle.classList.toggle("is-selected", row === selected);
        rectangle.style.setProperty("--outline-color", detectors[sources[0]].color);
        overlay.append(rectangle);
      }
    }
  }

  function renderList() {
    const visible = shownRows();
    $("regionCount").textContent = visible.length === rows.length
      ? `${rows.length} ${rows.length === 1 ? "region" : "regions"}`
      : `${visible.length} of ${rows.length}`;
    $("regionHint").textContent = rows.length
      ? (image ? "Select a region to highlight it on the masked image." : "This scan has detector results and no screenshot.")
      : "No matching regions were detected on this page.";
    list.hidden = !visible.length;
    list.replaceChildren();
    for (const row of visible) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "review-region";
      button.dataset.reviewRegion = row.id;
      button.disabled = !image;
      button.setAttribute("aria-pressed", String(row === selected));
      const marker = document.createElement("span");
      marker.className = "region-index";
      marker.textContent = row.id;
      marker.style.setProperty("--outline-color", detectors[row.sources[0]].color);
      const caption = document.createElement("span");
      const heading = document.createElement("strong");
      heading.textContent = Object.hasOwn(reasons, row.reason) ? reasons[row.reason] : "Detected region";
      const source = document.createElement("span");
      source.className = "region-provenance";
      source.textContent = row.sources.map((key) => detectors[key].label).join(" · ");
      caption.append(heading, source);
      button.append(marker, caption);
      item.append(button);
      list.append(item);
    }
    drawRegions(visible);
  }

  function update(data) {
    viewport = data.viewport;
    // Only accept local raster previews from the masking pipeline. Raw comparison is separate.
    image = /^data:image\/(png|jpeg|webp);base64,/i.test(data.preview || "") ? data.preview : "";
    const previousFilter = filter.value;
    rows = (data.regions || []).map((region, index) => {
      const sources = Array.isArray(region.sources) && region.sources.length ? region.sources : [region.source];
      const uniqueSources = [...new Set(sources.map((key) => Object.hasOwn(detectors, key) ? key : "other"))];
      return { ...region, sources: uniqueSources, id: index + 1 };
    });
    selected = null;
    filter.replaceChildren(new Option("All detectors", "all"));
    for (const [key, { label }] of Object.entries(detectors)) {
      const count = rows.filter((row) => row.sources.includes(key)).length;
      if (count) filter.add(new Option(`${label} (${count})`, key));
    }
    filter.value = [...filter.options].some((option) => option.value === previousFilter) ? previousFilter : "all";
    filter.disabled = filter.options.length < 2;
    $("previewStage").parentElement.hidden = !image;
    $("openPreviewZoom").disabled = !image;
    $("saveMaskedPreview").disabled = !image;
    outlineToggle.disabled = !image || !rows.length;
    if (modal.open) {
      if (image) zoomImage.src = image;
      else modal.close();
    }
    hideStatus("reviewExportStatus");
    renderList();
  }

  filter.addEventListener("change", () => {
    selected = null;
    renderList();
  });
  outlineToggle.addEventListener("click", () => {
    const next = outlineToggle.getAttribute("aria-pressed") !== "true";
    outlineToggle.setAttribute("aria-pressed", String(next));
    drawRegions(shownRows());
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-review-region]");
    if (!button) return;
    if (originalToggle.getAttribute("aria-pressed") === "true") originalToggle.click();
    if (outlineToggle.getAttribute("aria-pressed") !== "true") outlineToggle.click();
    const region = rows[Number(button.dataset.reviewRegion) - 1];
    selected = region === selected ? null : region;
    for (const rowButton of list.querySelectorAll("button")) {
      rowButton.setAttribute("aria-pressed", String(Number(rowButton.dataset.reviewRegion) === selected?.id));
    }
    drawRegions(shownRows());
  });

  function centerSelectedRegion() {
    if (!modal.open || !selected || !viewport?.w || !viewport?.h) return;
    zoomViewport.scrollTo({
      left: (selected.x + selected.w / 2) / viewport.w * zoomStage.offsetWidth - zoomViewport.clientWidth / 2,
      top: (selected.y + selected.h / 2) / viewport.h * zoomStage.offsetHeight - zoomViewport.clientHeight / 2,
    });
  }

  zoomImage.addEventListener("load", centerSelectedRegion);
  zoom.addEventListener("change", () => {
    zoomStage.style.width = zoom.value + "%";
    centerSelectedRegion();
  });
  $("openPreviewZoom").addEventListener("click", () => {
    if (!image) return;
    zoomImage.src = image;
    zoom.value = "100";
    zoomStage.style.width = "100%";
    modal.showModal();
    zoomViewport.scrollTo(0, 0);
    centerSelectedRegion();
  });
  $("closePreviewZoom").addEventListener("click", () => modal.close());
  modal.addEventListener("close", () => zoomImage.removeAttribute("src"));

  $("saveMaskedPreview").addEventListener("click", async () => {
    const dataUrl = image;
    if (!dataUrl) return;
    const button = $("saveMaskedPreview");
    button.disabled = true;
    let url;
    try {
      const raster = await (await fetch(dataUrl)).blob();
      const extension = raster.type === "image/jpeg" ? "jpg" : raster.type.slice("image/".length);
      url = URL.createObjectURL(raster);
      await chrome.downloads.download({ url, filename: `visionvault-masked-page.${extension}` });
      showStatus("reviewExportStatus", "success", "Masked image download started.");
    } catch (_) {
      showStatus("reviewExportStatus", "error", "The masked image could not be downloaded.");
    } finally {
      button.disabled = !image;
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });

  return { update };
})();

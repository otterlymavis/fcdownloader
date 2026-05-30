// Popup - show one prominent media item, hide the rest behind a collapsed
// "Show other media" section. Matches the simpler "one obvious action"
// UX of the web app.

const $ = (id) => document.getElementById(id);
const settingsBtn = $("settings-btn");
const pageInfo    = $("page-info");
const helperEl    = $("helper-status");
const helperText  = $("helper-text");
const helperOpen  = $("helper-open");
const helperTools = $("helper-tools");
const primaryEl   = $("primary");
const primaryTitle= $("primary-title");
const primaryMeta = $("primary-meta");
const primaryBtn  = $("primary-download");
const primaryAudioBtn = $("primary-audio-download");
const emptyEl     = $("empty");
const extractBtn  = $("extract-btn");
const statusEl    = $("status");
const moreEl      = $("more");
const moreList    = $("more-list");
const bulkActions = $("bulk-actions");
const selectAllBtn = $("select-all");
const downloadSelectedBtn = $("download-selected");
const EXPECTED_HELPER_VERSION = "0.3.0-go";

let currentTabId   = null;
let currentPageUrl = "";
let helperTimer = null;
let helperIsReady = false;
let helperNeedsSetup = false;
let preferCapturedMedia = false;
let waitingForCapturedMedia = false;
let currentVisibleItems = [];
let selectedItemKeys = new Set();
let pinnedExtractResult = false;
let currentGalleryInfo = null;

// ---------------------------------------------------------------------------
// Helpers

function sendMessage(message, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "Background service is not responding. Reload the extension at chrome://extensions and try again." });
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(text, kind = "info") {
  if (!text) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.classList.remove("error", "success");
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.remove("error", "success");
  if (kind === "error")   statusEl.classList.add("error");
  if (kind === "success") statusEl.classList.add("success");
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

function describeItem(item) {
  // Friendly human label: prefer a quality/format hint, else the host.
  if (item.label) return item.label;
  if (item.kind === "image") return `Image${hostname(item.url) ? ` - ${hostname(item.url)}` : ""}`;
  if (item.kind === "audio") return `Audio${hostname(item.url) ? ` - ${hostname(item.url)}` : ""}`;
  if (item.kind === "embed" || item.source === "iframe") return "Embedded video";
  const h = hostname(item.url);
  if (item.kind === "hls")  return `HLS stream${h ? ` - ${h}` : ""}`;
  if (item.kind === "dash") return `DASH stream${h ? ` - ${h}` : ""}`;
  return h || "Media";
}

function formatDimensions(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return `${w} x ${h}`;
  if (Number.isFinite(h) && h > 0) return `${h}p`;
  return "";
}

function mediaResolution(item = {}) {
  const direct = formatDimensions(item.width, item.height);
  if (direct) return direct;

  if (typeof item.resolution === "string" && item.resolution && item.resolution !== "audio only") {
    return item.resolution;
  }

  const selectedFormat = Array.isArray(item.formats)
    ? item.formats.find((format) => String(format.id || format.formatId || "") === String(item.formatId || ""))
    : null;
  const selected = formatDimensions(selectedFormat?.width, selectedFormat?.height);
  if (selected) return selected;

  const bestFormat = Array.isArray(item.formats)
    ? item.formats
        .filter((format) => format?.width || format?.height)
        .sort((a, b) => (Number(b.height || 0) - Number(a.height || 0)) || (Number(b.width || 0) - Number(a.width || 0)))[0]
    : null;
  const best = formatDimensions(bestFormat?.width, bestFormat?.height);
  if (best) return best;

  const label = String(item.label || "");
  if (/(?:\d{3,4}p|4k|8k)/i.test(label)) return label.match(/(?:\d{3,4}p|4k|8k)/i)[0];

  const url = String(item.url || item.videoUrl || "");
  const ytHeight = url.match(/[?&]height=(\d+)/i);
  if (ytHeight) return `${ytHeight[1]}p`;
  if (/[?&]itag=18(?:&|$)/i.test(url)) return "360p";
  const pathHeight = url.match(/(?:^|[\/_.-])(?:h|height)?([1-9]\d{2,3})p(?:[\/_.-]|$)/i);
  if (pathHeight) return `${pathHeight[1]}p`;
  const urlDimensions = url.match(/(?:^|[\/_-])(\d{3,5})x(\d{3,5})(?:[\/_.-]|$)/i);
  if (urlDimensions) return `${urlDimensions[1]} x ${urlDimensions[2]}`;
  try {
    const params = new URL(url).searchParams;
    const fromParams = formatDimensions(
      params.get("width") || params.get("w"),
      params.get("height") || params.get("h"),
    );
    if (fromParams) return fromParams;
  } catch {}

  return item.kind === "audio" ? "Audio only" : "";
}

function itemMeta(item) {
  return [describeItem(item), mediaResolution(item)]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(" - ");
}

function titleOf(item, fallback) {
  return item.title || fallback || describeItem(item) || "Media";
}

function itemKey(item) {
  return item?.url || "";
}

function canDownloadAudio(item) {
  return Boolean(item && item.kind !== "image" && !item.audioOnly);
}

function isCapturedVideo(item) {
  if (!item || item.kind === "image" || item.kind === "audio" || item.kind === "embed") return false;
  return item.source === "network" ||
    item.source === "video-tag" ||
    item.kind === "hls" ||
    item.kind === "dash";
}

function capturedVideoScore(item) {
  if (!isCapturedVideo(item)) return -1;
  if (item.source === "video-tag" && item.kind === "direct") return 50;
  if (item.kind === "direct" && /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(item.url || "")) return 45;
  if (item.kind === "hls" || item.kind === "dash") return 40;
  return 30;
}

function isCompanionHdItem(item) {
  return item?.source === "youtube-hd-local";
}

function companionReadyOrder(items) {
  const companionItems = items.filter(isCompanionHdItem);
  if (!companionItems.length) return items;
  return [...companionItems, ...items.filter((item) => !isCompanionHdItem(item))];
}

function standaloneOrder(items) {
  const standaloneItems = items.filter((item) => !isCompanionHdItem(item));
  const companionItems = items.filter(isCompanionHdItem);
  return standaloneItems.length ? [...standaloneItems, ...companionItems] : items;
}

function capturedOrder(items) {
  const preferred = items
    .filter(isCapturedVideo)
    .sort((a, b) => capturedVideoScore(b) - capturedVideoScore(a));
  if (!preferred.length) return items;
  const primary = preferred[0];
  return [primary, ...items.filter((item) => item.url !== primary.url)];
}

function displayedItems(items) {
  if (helperIsReady) return companionReadyOrder(items);
  const visibleItems = standaloneOrder(items);
  return preferCapturedMedia ? capturedOrder(visibleItems) : visibleItems;
}

function isRuntimeOnlyExtractFailure(error) {
  return /(No extractor found for this URL and the page HTML contained no detectable media|browser runtime is client-side only|server'?s IP is blocked|HTTP 403|Forbidden|geo-restricted|geo restricted|requires you to be signed in|requires a browser session|DRM|region)/i.test(String(error || ""));
}

function needsCompanion(url, items = []) {
  if (/youtube\.com\/(?:watch|shorts)|youtu\.be\//i.test(url || "")) return true;
  return items.some((item) => item.source === "youtube-hd-local");
}

async function renderHelperStatus(show) {
  if (!helperEl) return;
  if (!show) {
    helperEl.hidden = true;
    if (helperTimer) {
      clearInterval(helperTimer);
      helperTimer = null;
    }
    return;
  }
  helperEl.hidden = false;
  const resp = await sendMessage({ type: "fcdl:helper_status" }, 2500);
  const ready = Boolean(resp?.ok && resp.ready);
  const health = resp?.health || null;
  const needsSetup = Boolean(health?.needsSetup);
  const changed = helperIsReady !== ready;
  helperIsReady = ready;
  helperNeedsSetup = ready && needsSetup;
  helperEl.classList.toggle("ready", ready);
  helperEl.classList.toggle("missing", !ready);
  helperText.textContent = helperStatusText(ready, health);
  helperOpen.hidden = ready;
  if (helperTools) helperTools.hidden = !helperNeedsSetup;
  if (changed && currentTabId != null) {
    lastItemsKey = "";
    refresh();
  }
}

function helperStatusText(ready, health) {
  if (!ready) return "Companion optional: 360p works";
  if (health?.version && health.version !== EXPECTED_HELPER_VERSION) return "Companion outdated: update recommended";
  if (health?.needsSetup) return "Companion ready: install tools for HD";
  const toolBits = Array.isArray(health?.tools)
    ? health.tools.filter((tool) => tool.installed).length + "/" + health.tools.length
    : "";
  return toolBits ? `Companion ready: HD enabled (${toolBits} tools)` : "Companion ready: HD enabled";
}

// ---------------------------------------------------------------------------
// Rendering

let lastItemsKey = "";

function render(items) {
  currentGalleryInfo = null;
  currentVisibleItems = items || [];
  if (!items || !items.length) {
    primaryEl.hidden = true;
    if (primaryAudioBtn) primaryAudioBtn.hidden = true;
    emptyEl.hidden   = false;
    moreEl.hidden    = true;
    if (bulkActions) bulkActions.hidden = true;
    selectedItemKeys = new Set();
    return;
  }

  const [first, ...rest] = items;

  // Primary card
  primaryTitle.textContent = titleOf(first, hostname(currentPageUrl));
  primaryMeta.textContent  = itemMeta(first);
  primaryBtn.textContent   = "Download";
  primaryBtn.disabled      = false;
  primaryBtn.onclick       = () => downloadItem(first);
  if (primaryAudioBtn) {
    primaryAudioBtn.hidden = !canDownloadAudio(first);
    primaryAudioBtn.onclick = canDownloadAudio(first) ? () => downloadAudioItem(first) : null;
  }
  primaryEl.hidden = false;
  emptyEl.hidden   = true;

  // Optional "more media" section: only when there's >1, and only show
  // up to 5 extras so it never feels like a developer list.
  if (rest.length === 0) {
    moreEl.hidden = true;
    if (bulkActions) bulkActions.hidden = true;
    return;
  }
  moreEl.hidden = false;
  const summary = moreEl.querySelector("summary");
  if (summary) summary.textContent = `Select media (${items.length})`;
  reconcileSelection(items);
  if (bulkActions) bulkActions.hidden = false;
  moreList.innerHTML = "";
  items.forEach((item, idx) => {
    const key = itemKey(item);
    const li = document.createElement("li");
    li.className = idx === 0 ? "best-media-row" : "";
    li.innerHTML = `
      <label class="media-select">
        <input type="checkbox" ${selectedItemKeys.has(key) ? "checked" : ""}>
      </label>
      <div class="row-meta">
        <div class="row-title">${escapeHtml(titleOf(item, hostname(item.url)))}${idx === 0 ? ' <span class="best-badge">Best</span>' : ""}</div>
        <div class="row-sub">${escapeHtml(itemMeta(item))}</div>
      </div>
      ${canDownloadAudio(item) ? '<button class="audio-btn" type="button">Audio</button>' : ""}
      <button type="button">Save</button>
    `;
    const checkbox = li.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedItemKeys.add(key);
      else selectedItemKeys.delete(key);
      updateBulkControls();
    });
    const audioButton = li.querySelector(".audio-btn");
    if (audioButton) audioButton.addEventListener("click", () => downloadAudioItem(item));
    li.querySelector("button:last-child").addEventListener("click", () => downloadItem(item));
    moreList.appendChild(li);
  });
  updateBulkControls();
}

function reconcileSelection(items) {
  const validKeys = new Set(items.map(itemKey).filter(Boolean));
  selectedItemKeys = new Set([...selectedItemKeys].filter((key) => validKeys.has(key)));
  if (!selectedItemKeys.size && items[0]) selectedItemKeys.add(itemKey(items[0]));
}

function updateBulkControls() {
  if (!downloadSelectedBtn || !selectAllBtn) return;
  const selectedCount = currentVisibleItems.filter((item) => selectedItemKeys.has(itemKey(item))).length;
  downloadSelectedBtn.disabled = selectedCount === 0;
  downloadSelectedBtn.textContent = selectedCount <= 1 ? "Download selected" : `Download ${selectedCount} selected`;
  selectAllBtn.textContent = selectedCount === currentVisibleItems.length ? "Clear" : "Select all";
}

function refreshSelectionUI() {
  moreList.querySelectorAll("li").forEach((li, idx) => {
    const checkbox = li.querySelector('input[type="checkbox"]');
    const item = currentVisibleItems[idx];
    if (checkbox && item) checkbox.checked = selectedItemKeys.has(itemKey(item));
  });
  updateBulkControls();
}

function refresh() {
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ type: "fcdl:list", tabId: currentTabId }, (resp) => {
    if (!resp) return;
    const items = resp.items || [];
    renderHelperStatus(needsCompanion(currentPageUrl, items));
    if (pinnedExtractResult) return;
    if (waitingForCapturedMedia && items.some(isCapturedVideo)) {
      waitingForCapturedMedia = false;
      preferCapturedMedia = true;
      setStatus("Media found from page playback.", "success");
    }
    const visibleItems = displayedItems(items);
    const key = `${helperIsReady ? "helper:" : "standalone:"}${preferCapturedMedia ? "capture:" : ""}${visibleItems.map((i) => i.url).join("|")}`;
    if (key !== lastItemsKey) {
      lastItemsKey = key;
      render(visibleItems);
    }
  });
}

// ---------------------------------------------------------------------------
// Init

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("No active tab.", "error");
    return;
  }
  currentTabId   = tab.id;
  currentPageUrl = tab.url || "";
  pageInfo.textContent = hostname(currentPageUrl) || currentPageUrl;
  renderHelperStatus(needsCompanion(currentPageUrl));

  const pong = await sendMessage({ type: "fcdl:ping" }, 3000);
  if (!pong?.ok) {
    emptyEl.hidden = true;
    setStatus(
      "Background service isn't running. Open chrome://extensions and click Reload on FCDownloader.",
      "error",
    );
    return;
  }

  // First-run gate: only triggers when neither storage NOR the build-time
  // default has a backend URL (i.e. someone built from source without
  // setting EXTENSION_DEFAULT_BACKEND). Public-distribution builds bake in
  // the URL and never hit this branch.
  try {
    const { settings } = (await sendMessage({ type: "fcdl:list", tabId: currentTabId }, 3000)) || {};
    if (!settings?.backend?.trim()) {
      primaryEl.hidden = true;
      moreEl.hidden = true;
      emptyEl.hidden = false;
      const text = emptyEl.querySelector(".empty-text");
      if (text) text.textContent = "Backend URL isn't set yet.";
      if (extractBtn) {
        extractBtn.textContent = "Open settings";
        extractBtn.onclick = (e) => {
          e.preventDefault();
          if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
        };
      }
      return;  // skip the refresh loop: nothing to fetch
    }
  } catch {}

  refresh();
  setInterval(refresh, 1500);
})();

if (helperOpen) {
  helperOpen.addEventListener("click", async () => {
    helperOpen.disabled = true;
    helperText.textContent = "Opening companion...";
    const resp = await sendMessage({ type: "fcdl:helper_start" }, 12000);
    helperOpen.disabled = false;
    renderHelperStatus(true);
    if (!resp?.ready) {
      setStatus("Install or start FCDownloader Companion, then try again.", "error");
    }
  });
}

if (helperTools) {
  helperTools.addEventListener("click", async () => {
    helperTools.disabled = true;
    helperText.textContent = "Installing video tools...";
    const resp = await sendMessage({ type: "fcdl:helper_ensure_tools" }, 10 * 60 * 1000);
    helperTools.disabled = false;
    await renderHelperStatus(true);
    if (!resp?.ok) {
      setStatus(resp?.error || "Could not install Companion video tools.", "error");
      return;
    }
    setStatus("Companion video tools are ready.", "success");
  });
}

// ---------------------------------------------------------------------------
// "Find media" fallback: only shown in empty state

if (selectAllBtn) {
  selectAllBtn.addEventListener("click", () => {
    const selectable = currentVisibleItems.map(itemKey).filter(Boolean);
    if (selectedItemKeys.size === selectable.length) {
      selectedItemKeys = new Set();
    } else {
      selectedItemKeys = new Set(selectable);
    }
    refreshSelectionUI();
  });
}

if (downloadSelectedBtn) {
  downloadSelectedBtn.addEventListener("click", downloadSelectedItems);
}

extractBtn.addEventListener("click", async () => {
  extractBtn.disabled = true;
  pinnedExtractResult = false;
  setStatus("Looking for media...");
  try {
    const resp = await sendMessage({
      type: "fcdl:extract",
      tabId: currentTabId,
      pageUrl: currentPageUrl,
    }, 35000);
    if (!resp?.ok) {
      if (isRuntimeOnlyExtractFailure(resp?.error)) {
        preferCapturedMedia = true;
        waitingForCapturedMedia = true;
        setStatus("The server cannot read this player. Start playback and captured media will appear here.");
        refresh();
        return;
      }
      setStatus(resp?.error || "Couldn't find media on this page.", "error");
      return;
    }
    setStatus("", "info");
    const info = resp.info;

    // Gallery (Instagram carousel / Reddit gallery / Threads carousel): render
    // a single "Save all (N)" card. Per-item rows live in the collapsed
    // <details> below it.
    if (info.kind === "gallery" && Array.isArray(info.items)) {
      renderGallery(info);
      return;
    }

    // When the server returns a /ytdl-stream proxy URL it means yt-dlp couldn't
    // resolve a direct CDN URL (SABR / datacenter IP challenge). The proxy runs
    // yt-dlp in actual download mode on the server and streams back a real MP4.
    // Tag the item so background.js can download it directly without re-routing
    // through /download (which would throw the URL away and double-extract).
    const isYtdlStream = typeof info.url === "string" && info.url.includes("/ytdl-stream?");
    if (isYtdlStream && !helperIsReady) {
      const helperResp = await sendMessage({ type: "fcdl:helper_status" }, 2500);
      helperIsReady = Boolean(helperResp?.ok && helperResp.ready);
      if (!helperIsReady) {
        setStatus("Companion is optional: play this video for a detected 360p download, or open Companion for HD.");
        refresh();
        return;
      }
    }
    const item = {
      url: isYtdlStream ? currentPageUrl : (info.kind === "paired" ? info.videoUrl : info.url),
      title: info.title,
      label: isYtdlStream ? "HD (local helper)" : info.label,
      width: info.width,
      height: info.height,
      ext: "mp4",
      kind: isYtdlStream ? "embed" : info.kind,
      source: isYtdlStream ? "youtube-hd-local" : "backend",
      backendRouted: !isYtdlStream,
      pageUrl: currentPageUrl,
      formatId: info.formatId,
      formats: info.formats,
    };
    await sendMessage({
      type: "fcdl:detected",
      tabId: currentTabId,
      pageUrl: currentPageUrl,
      items: [item],
    }, 5000);
    refresh();
  } catch (e) {
    setStatus(String(e), "error");
  } finally {
    extractBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Gallery rendering
//
// Carousels (Instagram, Reddit, Threads) come back from /extract as
// { kind: "gallery", items: [{ url, kind: "image"|"direct"|..., ext, title }] }.
// We show ONE prominent "Save all" card and tuck individual items into the
// same <details> we already use for "other media", so the popup stays
// single-action-focused.

function describeGallery(items) {
  let photos = 0, videos = 0;
  for (const it of items) {
    if (it.kind === "image") photos++; else videos++;
  }
  const parts = [];
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (videos) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  return parts.join(" - ") || `${items.length} items`;
}

function renderGallery(info) {
  const items = info.items;
  pinnedExtractResult = true;
  currentGalleryInfo = info;
  currentVisibleItems = items;
  lastItemsKey = `gallery:${items.map((item) => item.url || item.videoUrl || "").join("|")}`;
  primaryTitle.textContent = info.title || `${items.length} items`;
  primaryMeta.textContent  = describeGallery(items);
  primaryBtn.textContent   = `Save all ${items.length}`;
  if (primaryAudioBtn) primaryAudioBtn.hidden = true;
  primaryBtn.onclick = async () => {
    primaryBtn.disabled = true;
    setStatus(`Downloading 0 of ${items.length}...`);
    const resp = await sendMessage({
      type: "fcdl:download_gallery",
      tabId: currentTabId,
      pageUrl: currentPageUrl,
      title: info.title,
      items,
    }, 120_000);
    primaryBtn.disabled = false;
    primaryBtn.textContent = `Save all ${items.length}`;
    if (!resp?.ok) {
      setStatus(resp?.error || "Some downloads failed.", "error");
      return;
    }
    const { started = 0, failed = 0 } = resp;
    if (failed === 0) {
      setStatus(`Saved ${started} files. Check your browser's Downloads.`, "success");
    } else {
      setStatus(`Saved ${started}, ${failed} failed. Check the SW console for details.`, "error");
    }
  };
  primaryEl.hidden = false;
  emptyEl.hidden   = true;

  // Per-item list: collapsed by default
  moreEl.hidden = false;
  if (bulkActions) bulkActions.hidden = false;
  selectedItemKeys = new Set(items.map(itemKey).filter(Boolean));
  moreEl.querySelector("summary").textContent = `Select items (${items.length})`;
  moreList.innerHTML = "";
  items.forEach((it, idx) => {
    const key = itemKey(it);
    const li = document.createElement("li");
    const label = it.kind === "image" ? "Photo" : "Video";
    li.innerHTML = `
      <label class="media-select">
        <input type="checkbox" ${selectedItemKeys.has(key) ? "checked" : ""}>
      </label>
      <div class="row-meta">
        <div class="row-title">${escapeHtml(label)} ${idx + 1}</div>
        <div class="row-sub">${escapeHtml([(it.ext || "").toUpperCase() || it.kind, mediaResolution(it)].filter(Boolean).join(" - "))}</div>
      </div>
      <button type="button">Save</button>
    `;
    const checkbox = li.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedItemKeys.add(key);
      else selectedItemKeys.delete(key);
      updateBulkControls();
    });
    li.querySelector("button").addEventListener("click", async () => {
      const r = await sendMessage({
        type: "fcdl:download_gallery_item",
        tabId: currentTabId,
        pageUrl: currentPageUrl,
        title: info.title,
        index: idx,
        item: it,
      }, 60_000);
      if (!r?.ok) setStatus(r?.error || "Failed.", "error");
    });
    moreList.appendChild(li);
  });
  updateBulkControls();
}

// ---------------------------------------------------------------------------
// Per-item Download

async function downloadItem(item) {
  const itemWithDefaults = { pageUrl: currentPageUrl, ...item };
  setStatus("Starting download...");
  const resp = await sendMessage(
    { type: "fcdl:download", tabId: currentTabId, item: itemWithDefaults },
    25000,
  );
  if (!resp?.ok) {
    setStatus(resp?.error || "Download failed.", "error");
    return;
  }
  setStatus("Download started. Check your browser's Downloads.", "success");
}

async function downloadAudioItem(item) {
  await downloadItem({
    ...item,
    audioOnly: true,
    kind: "audio",
    ext: "m4a",
    label: "Audio only",
    backendRouted: true,
    pageUrl: item.pageUrl || currentPageUrl || item.url,
  });
}

// ---------------------------------------------------------------------------
// Settings

async function downloadSelectedItems() {
  if (currentGalleryInfo) {
    await downloadSelectedGalleryItems();
    return;
  }

  const items = currentVisibleItems
    .filter((item) => selectedItemKeys.has(itemKey(item)))
    .map((item) => ({ pageUrl: currentPageUrl, ...item }));
  if (!items.length) {
    setStatus("Select at least one media item.", "error");
    return;
  }

  downloadSelectedBtn.disabled = true;
  setStatus(`Starting ${items.length} download${items.length === 1 ? "" : "s"}...`);
  const resp = await sendMessage(
    { type: "fcdl:download_many", tabId: currentTabId, items },
    Math.max(60_000, items.length * 35_000),
  );
  downloadSelectedBtn.disabled = false;
  updateBulkControls();
  if (!resp?.ok) {
    setStatus(resp?.error || "Selected downloads failed.", "error");
    return;
  }
  const { started = 0, failed = 0 } = resp;
  if (failed === 0) {
    setStatus(`Started ${started} download${started === 1 ? "" : "s"}. Check your browser's Downloads.`, "success");
  } else {
    setStatus(`Started ${started}, ${failed} failed. Check the extension console for details.`, "error");
  }
}

async function downloadSelectedGalleryItems() {
  const items = currentVisibleItems.filter((item) => selectedItemKeys.has(itemKey(item)));
  if (!items.length) {
    setStatus("Select at least one media item.", "error");
    return;
  }

  downloadSelectedBtn.disabled = true;
  setStatus(`Starting ${items.length} gallery download${items.length === 1 ? "" : "s"}...`);
  const resp = await sendMessage({
    type: "fcdl:download_gallery",
    tabId: currentTabId,
    pageUrl: currentPageUrl,
    title: currentGalleryInfo.title,
    items,
  }, Math.max(60_000, items.length * 35_000));
  downloadSelectedBtn.disabled = false;
  updateBulkControls();
  if (!resp?.ok) {
    setStatus(resp?.error || "Selected downloads failed.", "error");
    return;
  }
  const { started = 0, failed = 0 } = resp;
  if (failed === 0) {
    setStatus(`Started ${started} download${started === 1 ? "" : "s"}. Check your browser's Downloads.`, "success");
  } else {
    setStatus(`Started ${started}, ${failed} failed. Check the extension console for details.`, "error");
  }
}

settingsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
});

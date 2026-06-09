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
const statusTextEl = $("status-text");
const statusProgressContainer = $("status-progress-container");
const statusProgressFill = $("status-progress-fill");
const moreEl      = $("more");
const moreList    = $("more-list");
const bulkActions = $("bulk-actions");
const selectAllBtn = $("select-all");
const downloadSelectedBtn = $("download-selected");
const MIN_HELPER_VERSION = "0.3.0-go";
const HELPER_STATUS_TIMEOUT_MS = 2500;
const HELPER_START_TIMEOUT_MS = 26000;
const HELPER_READY_GRACE_MS = 10000;

let currentTabId   = null;
let currentPageUrl = "";
let helperTimer = null;
let helperIsReady = false;
let helperLastReadyAt = 0;
let helperNeedsSetup = false;
let preferCapturedMedia = false;
let waitingForCapturedMedia = false;
let currentVisibleItems = [];
let selectedItemKeys = new Set();
let pinnedExtractResult = false;
let currentGalleryInfo = null;
let progressPollInterval = null;
let toolProgressPollInterval = null;

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

function setStatus(text, kind = "info", detail = "") {
  if (statusProgressFill) statusProgressFill.classList.remove("indeterminate");
  if (!text) {
    statusEl.hidden = true;
    if (statusTextEl) statusTextEl.textContent = "";
    statusEl.title = "";
    statusEl.classList.remove("error", "success");
    if (statusProgressContainer) statusProgressContainer.style.display = "none";
    return;
  }
  statusEl.hidden = false;
  if (statusTextEl) {
    statusTextEl.textContent = text;
  } else {
    statusEl.textContent = text;
  }
  statusEl.title = detail || "";
  statusEl.classList.remove("error", "success");
  if (kind === "error") {
    statusEl.classList.add("error");
    if (statusProgressContainer) statusProgressContainer.style.display = "none";
  } else if (kind === "success") {
    statusEl.classList.add("success");
    if (statusProgressContainer) statusProgressContainer.style.display = "none";
  }
}

function setProgress(pct, text = "") {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  if (statusProgressFill) statusProgressFill.classList.remove("indeterminate");
  statusEl.hidden = false;
  if (statusProgressContainer) statusProgressContainer.style.display = "block";
  if (statusProgressFill) statusProgressFill.style.width = `${safePct}%`;
  if (text && statusTextEl) statusTextEl.textContent = text;
}

function setProgressIndeterminate(text = "") {
  statusEl.hidden = false;
  if (statusProgressContainer) statusProgressContainer.style.display = "block";
  if (statusProgressFill) {
    statusProgressFill.style.width = "100%";
    statusProgressFill.classList.add("indeterminate");
  }
  if (text && statusTextEl) statusTextEl.textContent = text;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function stopToolProgressPolling() {
  if (toolProgressPollInterval) {
    clearInterval(toolProgressPollInterval);
    toolProgressPollInterval = null;
  }
}

function toolProgressLabel(progress) {
  const name = progress?.tool ? String(progress.tool).replace(/^yt-dlp/, "YouTube downloader") : "video tools";
  const attempt = progress?.attempt > 1 ? `, retry ${progress.attempt}` : "";
  const downloaded = Number(progress?.downloaded || 0);
  const total = Number(progress?.total || 0);
  if (progress?.message === "complete") return `Installed ${name}`;
  if (total > 0 && downloaded > 0) {
    return `Installing ${name}${attempt}: ${formatBytes(downloaded)} / ${formatBytes(total)}`;
  }
  if (downloaded > 0) return `Installing ${name}${attempt}: ${formatBytes(downloaded)}`;
  return `Installing ${name}${attempt}...`;
}

async function updateToolProgressDisplay() {
  const r = await fetch("http://127.0.0.1:8765/tools/progress");
  if (!r.ok) return false;
  const data = await r.json();
  const progress = data?.progress;
  if (!progress?.tool) return false;
  const downloaded = Number(progress.downloaded || 0);
  const total = Number(progress.total || 0);
  if (total > 0 && downloaded >= 0 && progress.message !== "complete") {
    setProgress(Math.min(99, (downloaded / total) * 100), toolProgressLabel(progress));
  } else {
    setProgressIndeterminate(toolProgressLabel(progress));
  }
  return true;
}

function startToolProgressPolling() {
  stopToolProgressPolling();
  setProgressIndeterminate("Installing video tools...");
  toolProgressPollInterval = setInterval(async () => {
    try {
      await updateToolProgressDisplay();
    } catch {
      // Helper may still be starting or the popup may be closing.
    }
  }, 700);
}

function startProgressPolling(mediaUrl) {
  if (progressPollInterval) {
    clearInterval(progressPollInterval);
  }
  let progressFloor = 0;

  setProgress(0, "Connecting to companion...");

  progressPollInterval = setInterval(async () => {
    try {
      const checkUrl = `http://127.0.0.1:8765/download/progress?${new URLSearchParams({ url: mediaUrl }).toString()}`;
      const r = await fetch(checkUrl);
      if (!r.ok) {
        await updateToolProgressDisplay();
        return;
      }
      const data = await r.json();
      if (data.status === "extracting") {
        progressFloor = Math.max(progressFloor, Math.min(Number(data.percent) || 5, 20));
        setProgress(progressFloor, "Companion is checking video formats...");
      } else if (data.status === "extracted") {
        progressFloor = Math.max(progressFloor, 12);
        setProgress(progressFloor, "Companion found video formats...");
      } else if (data.status === "downloading") {
        const rawPercent = Number(data.percent) || 0;
        progressFloor = Math.max(progressFloor, Math.min(rawPercent, 95));
        let label = `Downloading: ${progressFloor.toFixed(1)}%`;
        if (data.speed) label += ` at ${data.speed}`;
        if (data.eta) label += `, ETA: ${data.eta}`;
        setProgress(progressFloor, label);
      } else if (data.status === "merging") {
        progressFloor = Math.max(progressFloor, 98);
        setProgress(progressFloor, "Companion is merging formats...");
      } else if (data.status === "retrying") {
        progressFloor = Math.max(progressFloor, Math.min(Number(data.percent) || progressFloor, 95));
        setProgress(progressFloor, "Companion is retrying with updated YouTube support...");
      } else if (data.status === "ready") {
        progressFloor = Math.max(progressFloor, 98);
        setProgress(progressFloor, "Preparing browser download...");
      } else if (data.status === "serving") {
        progressFloor = Math.max(progressFloor, 99);
        setProgress(progressFloor, "Sending video to browser...");
      } else if (data.status === "complete") {
        progressFloor = 100;
        setProgress(100, "Download complete!");
        setTimeout(() => {
          setStatus("Download finished. Saved to your browser's Downloads.", "success");
        }, 1500);
        clearInterval(progressPollInterval);
        progressPollInterval = null;
      } else if (data.status === "error") {
        setStatus("Companion download failed. Check companion logs.", "error");
        clearInterval(progressPollInterval);
        progressPollInterval = null;
      }
    } catch (e) {
      try {
        await updateToolProgressDisplay();
      } catch {
        // Ignore network errors while polling
      }
    }
  }, 1000);
}

// Track a chrome.downloads download by ID — used for server and direct downloads.
function startDownloadTracking(downloadId) {
  if (!downloadId || !chrome.downloads?.search) return;
  if (progressPollInterval) clearInterval(progressPollInterval);
  setProgressIndeterminate("Downloading...");

  progressPollInterval = setInterval(async () => {
    try {
      const [dl] = await new Promise((res) => chrome.downloads.search({ id: downloadId }, res));
      if (!dl) {
        clearInterval(progressPollInterval);
        progressPollInterval = null;
        return;
      }
      if (dl.state === "complete") {
        setProgress(100, "Download complete!");
        setTimeout(() => setStatus("Saved to your browser's Downloads.", "success"), 1500);
        clearInterval(progressPollInterval);
        progressPollInterval = null;
        return;
      }
      if (dl.state === "interrupted") {
        setStatus(`Download failed: ${dl.error || "interrupted"}.`, "error");
        clearInterval(progressPollInterval);
        progressPollInterval = null;
        return;
      }
      // in_progress
      if (dl.totalBytes > 0) {
        const pct = Math.round((dl.bytesReceived / dl.totalBytes) * 100);
        setProgress(pct,
          `Downloading: ${pct}%  (${formatBytes(dl.bytesReceived)} / ${formatBytes(dl.totalBytes)})`);
      } else if (dl.bytesReceived > 0) {
        setProgressIndeterminate(`Downloading: ${formatBytes(dl.bytesReceived)}`);
      }
    } catch {
      // popup closing or extension reloading
    }
  }, 600);
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

function helperVersionAtLeast(version, minimum = MIN_HELPER_VERSION) {
  const got = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const min = String(minimum || "").match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!got || !min) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i] > min[i]) return true;
    if (got[i] < min[i]) return false;
  }
  return true;
}

function helperReadyForOrdering() {
  return helperIsReady || (helperLastReadyAt && Date.now() - helperLastReadyAt < HELPER_READY_GRACE_MS);
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
  if (helperReadyForOrdering()) return companionReadyOrder(items);
  const visibleItems = standaloneOrder(items);
  return preferCapturedMedia ? capturedOrder(visibleItems) : visibleItems;
}

function isRuntimeOnlyExtractFailure(error) {
  return /(No extractor found for this URL and the page HTML contained no detectable media|browser runtime is client-side only|server'?s IP is blocked|HTTP 403|Forbidden|geo-restricted|geo restricted|requires you to be signed in|requires a browser session|DRM|region)/i.test(String(error || ""));
}

function friendlyErrorMessage(error, fallback = "Something went wrong.") {
  const raw = String(error || "").trim();
  if (!raw) return fallback;
  const pageHost = hostname(currentPageUrl);
  const sitePrefix = pageHost ? `${pageHost}: ` : "";

  if (/Background service is not responding|Extension context invalidated|Receiving end does not exist/i.test(raw)) {
    return "The extension background service stopped. Reload FCDownloader at chrome://extensions and try again.";
  }
  if (/Backend URL is not configured|Backend URL isn't set/i.test(raw)) {
    return "Backend URL is not set. Open settings and add the FCDownloader backend URL.";
  }
  if (/Companion is not running|Install or start FCDownloader Companion/i.test(raw)) {
    return "Companion is not running. Open FCDownloader Companion for HD or protected server downloads.";
  }
  if (/Companion video tools are not ready|install tools/i.test(raw)) {
    return "Companion needs its video tools. Click Tools, wait for setup to finish, then try again.";
  }
  if (/DRM|encrypted|protected/i.test(raw)) {
    return `${sitePrefix}this player appears DRM protected. FCDownloader can only save media the browser or server can access as normal files or streams.`;
  }
  if (/geo-restricted|geo restricted|region|country|not available in your location/i.test(raw)) {
    return `${sitePrefix}this media looks region locked. Open the page with the right region/VPN, start playback, then click Find media again.`;
  }
  if (/requires you to be signed in|requires a browser session|authentication required|login required|sign in|server'?s IP is blocked|HTTP 403|Forbidden/i.test(raw)) {
    return `${sitePrefix}the site is blocking server access. Sign in on the page, refresh it, then click Find media so the extension can use your browser session.`;
  }
  if (/Backend timed out|timed out|timeout/i.test(raw)) {
    return `${sitePrefix}the site did not answer the server in time. Start playback in the tab, then click Find media again.`;
  }
  if (/No extractor found|page HTML contained no detectable media|no detectable media|No usable download method/i.test(raw)) {
    return `${sitePrefix}I could not see a downloadable file yet. Start playback for a few seconds, then click Find media again.`;
  }
  if (/DNS|could not resolve|Name or service not known|ERR_NAME/i.test(raw)) {
    return `${sitePrefix}the domain could not be reached from this environment. Try again later or use the extension while the page is open in your browser.`;
  }
  if (/All download methods failed/i.test(raw)) {
    return `${sitePrefix}all download routes failed. Try signing in, starting playback, or opening Companion for the browser-session route.`;
  }
  return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
}

function setErrorStatus(error, fallback = "Something went wrong.") {
  const raw = String(error || "").trim();
  const friendly = friendlyErrorMessage(raw, fallback);
  setStatus(friendly, "error", raw && raw !== friendly ? raw : "");
}

function sourceAuditDetail(audit) {
  if (!Array.isArray(audit) || !audit.length) return "";
  const lines = audit.slice(0, 25).map((item, idx) => {
    const status = item.status ? ` ${item.status}` : "";
    const selected = item.selected ? " selected" : "";
    const reason = item.rejectedReason ? ` rejected=${item.rejectedReason}` : "";
    return `${idx + 1}. ${item.strategy || "source"}:${item.source || "unknown"}${status}${selected}${reason} ${item.url || item.fieldPath || ""}`;
  });
  return `Source audit (${audit.length} candidate${audit.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}

function needsCompanion(url, items = []) {
  // Always show the helper bar so users can install/start the companion or
  // update its bundled tools without first navigating to a YouTube video.
  // The bar itself shows current readiness (Open / Update Tools / ready).
  return true;
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
  const wasReadyForOrdering = helperReadyForOrdering();
  const resp = await sendMessage({ type: "fcdl:helper_status" }, HELPER_STATUS_TIMEOUT_MS);
  const ready = Boolean(resp?.ok && resp.ready);
  const health = resp?.health || null;
  const needsSetup = Boolean(health?.needsSetup);
  if (ready) helperLastReadyAt = Date.now();
  else if (health?.ok && !helperVersionAtLeast(health.version)) helperLastReadyAt = 0;
  const effectiveReady = helperReadyForOrdering();
  const changed = wasReadyForOrdering !== effectiveReady;
  helperIsReady = ready;
  helperNeedsSetup = effectiveReady && needsSetup;
  helperEl.classList.toggle("ready", effectiveReady);
  helperEl.classList.toggle("missing", !effectiveReady);
  helperText.textContent = helperStatusText(effectiveReady, health);
  helperOpen.hidden = effectiveReady;
  if (helperTools) helperTools.hidden = false;
  if (changed && currentTabId != null) {
    lastItemsKey = "";
    refresh();
  }
}

function helperStatusText(ready, health) {
  if (health?.ok && !helperVersionAtLeast(health.version)) return "Companion outdated: update required";
  if (!ready) return "Companion optional: 360p works";
  if (health?.needsSetup) return "Companion ready: install tools for HD";
  const toolBits = Array.isArray(health?.tools)
    ? health.tools.filter((tool) => tool.installed).length + "/" + health.tools.length
    : "";
  return toolBits ? `Companion ready: HD enabled (${toolBits} tools)` : "Companion ready: HD enabled";
}

async function launchCompanionFromPopup() {
  try {
    await chrome.tabs.create({
      url: "fcdownloader-companion://start",
      active: false,
    });
  } catch {}
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
  primaryBtn.title         = "Download";
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
      ${canDownloadAudio(item) ? '<button class="audio-btn" type="button" title="Audio" aria-label="Audio"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg></button>' : ""}
      <button type="button" title="Save" aria-label="Save"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></button>
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
  downloadSelectedBtn.title = selectedCount <= 1 ? "Download selected" : `Download ${selectedCount} selected`;
  selectAllBtn.title = selectedCount === currentVisibleItems.length ? "Clear" : "Select all";
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
    const key = `${helperReadyForOrdering() ? "helper:" : "standalone:"}${preferCapturedMedia ? "capture:" : ""}${visibleItems.map((i) => i.url).join("|")}`;
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

  // A backend is optional when the local companion or direct browser captures
  // can handle the page. Keep the popup usable for companion-only installs.
  try {
    const { settings } = (await sendMessage({ type: "fcdl:list", tabId: currentTabId }, 3000)) || {};
    if (!settings?.backend?.trim()) {
      setStatus("Backend not set; Companion and direct downloads still work.");
    }
  } catch {}

  refresh();
  setInterval(refresh, 1500);
})();

if (helperOpen) {
  helperOpen.addEventListener("click", async () => {
    helperOpen.disabled = true;
    helperText.textContent = "Opening companion...";
    await launchCompanionFromPopup();
    const resp = await sendMessage({ type: "fcdl:helper_start" }, HELPER_START_TIMEOUT_MS);
    helperOpen.disabled = false;
    renderHelperStatus(true);
    if (!resp?.ready) {
      setErrorStatus("Install or start FCDownloader Companion, then try again.");
    }
  });
}

if (helperTools) {
  helperTools.addEventListener("click", async () => {
    helperTools.disabled = true;
    helperText.textContent = "Installing video tools...";
    startToolProgressPolling();
    try {
      const resp = await sendMessage({ type: "fcdl:helper_ensure_tools" }, 10 * 60 * 1000);
      if (!resp?.ok) {
        setErrorStatus(resp?.error, "Could not install Companion video tools.");
        return;
      }
      setProgress(100, "Companion video tools are ready.");
      setTimeout(() => setStatus("Companion video tools are ready.", "success"), 1200);
    } finally {
      stopToolProgressPolling();
      helperTools.disabled = false;
      await renderHelperStatus(true);
    }
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
  setProgressIndeterminate("Looking for media...");
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
      setErrorStatus(resp?.error, "Couldn't find media on this page.");
      const auditDetail = sourceAuditDetail(resp?.sourceAudit);
      if (auditDetail) statusEl.title = statusEl.title ? `${statusEl.title}\n\n${auditDetail}` : auditDetail;
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
      const helperResp = await sendMessage({ type: "fcdl:helper_status" }, HELPER_STATUS_TIMEOUT_MS);
      helperIsReady = Boolean(helperResp?.ok && helperResp.ready);
      if (helperIsReady) helperLastReadyAt = Date.now();
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
    setErrorStatus(e, "Couldn't find media on this page.");
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
  primaryBtn.title         = `Save all ${items.length}`;
  if (primaryAudioBtn) primaryAudioBtn.hidden = true;
  primaryBtn.onclick = async () => {
    primaryBtn.disabled = true;
    setProgressIndeterminate(`Downloading 0 of ${items.length}...`);
    const resp = await sendMessage({
      type: "fcdl:download_gallery",
      tabId: currentTabId,
      pageUrl: currentPageUrl,
      title: info.title,
      items,
    }, 120_000);
    primaryBtn.disabled = false;
    primaryBtn.title = `Save all ${items.length}`;
    if (!resp?.ok) {
      setErrorStatus(resp?.error, "Some downloads failed.");
      return;
    }
    const { started = 0, failed = 0 } = resp;
    if (failed === 0) {
      setProgress(100, `Saved ${started} files.`);
      setTimeout(() => setStatus(`Saved ${started} files. Check your browser's Downloads.`, "success"), 1200);
    } else {
      setErrorStatus(`Saved ${started}, ${failed} failed. Check the extension console for details.`);
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
      <button type="button" title="Save" aria-label="Save"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></button>
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
      if (!r?.ok) setErrorStatus(r?.error, "Failed.");
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
  
  const isCompanion = isCompanionHdItem(item);
  const helperLikelyReady = helperReadyForOrdering();
  if (isCompanion && helperLikelyReady) {
    startProgressPolling(item.url || currentPageUrl);
  }

  const resp = await sendMessage(
    { type: "fcdl:download", tabId: currentTabId, item: itemWithDefaults },
    isCompanion && helperLikelyReady ? 10 * 60 * 1000 : 90000,
  );
  if (!resp?.ok) {
    if (progressPollInterval) {
      clearInterval(progressPollInterval);
      progressPollInterval = null;
    }
    setErrorStatus(resp?.error, "Download failed.");
    return;
  }
  
  if (!isCompanion || !helperLikelyReady) {
    if (resp.downloadId) {
      startDownloadTracking(resp.downloadId);
    } else {
      setStatus("Download started. Check your browser's Downloads.", "success");
    }
  }
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
    setErrorStatus(resp?.error, "Selected downloads failed.");
    return;
  }
  const { started = 0, failed = 0 } = resp;
  if (failed === 0) {
    setStatus(`Started ${started} download${started === 1 ? "" : "s"}. Check your browser's Downloads.`, "success");
  } else {
    setErrorStatus(`Started ${started}, ${failed} failed. Check the extension console for details.`);
  }
}

async function downloadSelectedGalleryItems() {
  const items = currentVisibleItems.filter((item) => selectedItemKeys.has(itemKey(item)));
  if (!items.length) {
    setStatus("Select at least one media item.", "error");
    return;
  }

  downloadSelectedBtn.disabled = true;
  setProgressIndeterminate(`Downloading ${items.length} item${items.length === 1 ? "" : "s"}...`);
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
    setErrorStatus(resp?.error, "Selected downloads failed.");
    return;
  }
  const { started = 0, failed = 0 } = resp;
  if (failed === 0) {
    setProgress(100, `Saved ${started} item${started === 1 ? "" : "s"}.`);
    setTimeout(() => setStatus(`Saved ${started} item${started === 1 ? "" : "s"}. Check your browser's Downloads.`, "success"), 1200);
  } else {
    setErrorStatus(`Saved ${started}, ${failed} failed. Check the extension console for details.`);
  }
}

settingsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
});

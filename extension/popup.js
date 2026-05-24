// Popup logic — lists detected videos for the active tab and handles
// per-item Download clicks. Also drives the "Find videos on this page"
// button which calls the backend /extract for an HD/title preview.

const $ = (id) => document.getElementById(id);
const list = $("items");
const status = $("status");
const extractBtn = $("extract-btn");
const pageInfo = $("page-info");
const settingsBtn = $("settings-btn");

let currentTabId = null;
let currentPageUrl = "";

function sendMessage(message, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "Timed out waiting for the extension. Reload the page and try again." });
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

function setStatus(text, isError = false) {
  if (!text) { status.hidden = true; status.textContent = ""; status.classList.remove("error"); return; }
  status.hidden = false;
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function shortLabel(item) {
  return item.label || item.kind || "video";
}

function describe(item) {
  const bits = [];
  const h = hostname(item.url);
  if (h) bits.push(h);
  if (item.source) bits.push(item.source);
  return bits.join(" · ");
}

function render(items) {
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<li><div class="meta"><div class="title">No videos detected yet.</div><div class="sub">Press the button above, or wait while the page loads.</div></div></li>`;
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const titleText = item.title || shortLabel(item);
    li.innerHTML = `
      <div class="meta">
        <div class="title">${escapeHtml(titleText)}</div>
        <div class="sub">${escapeHtml(describe(item))}</div>
      </div>
      <button class="row" type="button">Download</button>
    `;
    li.querySelector("button").addEventListener("click", () => downloadItem(item));
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

// ── Initial load + auto-refresh ─────────────────────────────────────────

let lastItemsKey = "";

function refresh() {
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ type: "fcdl:list", tabId: currentTabId }, (resp) => {
    if (!resp) return;
    const items = resp.items || [];
    // Only re-render when something changed — avoids flashing the list on every poll.
    const key = items.map((i) => i.url).join("|");
    if (key !== lastItemsKey) {
      lastItemsKey = key;
      render(items);
    }
  });
}

async function scanVisibleFrames() {
  if (currentTabId == null || !chrome.scripting?.executeScript) return [];

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTabId, allFrames: true },
    func: () => {
      const found = [];
      const embedRe = /https?:\/\/(?:player\.vimeo\.com\/video\/\d+|www\.youtube\.com\/embed\/[\w-]+|youtube\.com\/embed\/[\w-]+|player\.twitch\.tv\/[^\s"']+|(?:www\.)?dailymotion\.com\/embed\/[\w-]+|fast\.wistia\.net\/embed\/[^\s"']+)/;
      document.querySelectorAll("iframe").forEach((el) => {
        const src = el.src || el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || "";
        const match = src.match(embedRe);
        if (match) found.push({ url: match[0], kind: "embed", source: "iframe" });
      });
      document.querySelectorAll("video[src], video source[src]").forEach((el) => {
        const src = el.currentSrc || el.src || el.getAttribute("src") || "";
        if (src && !src.startsWith("blob:") && !src.startsWith("data:")) {
          found.push({
            url: src,
            kind: src.includes(".m3u8") ? "hls" : src.includes(".mpd") ? "dash" : "direct",
            source: "video-tag",
          });
        }
      });
      const html = document.documentElement?.outerHTML || "";
      const match = html.match(embedRe);
      if (match) found.push({ url: match[0], kind: "embed", source: "page-html" });
      return found;
    },
  }).catch(() => []);

  const seen = new Set();
  return results
    .flatMap((r) => r.result || [])
    .filter((item) => {
      if (!item?.url || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("No active tab.", true);
    return;
  }
  currentTabId = tab.id;
  currentPageUrl = tab.url || "";
  pageInfo.textContent = hostname(currentPageUrl) || currentPageUrl;
  refresh();
  // Content script scans at 0s / 2s / 5s + reactively. Poll while the popup
  // is open so new detections appear without manual reload.
  setInterval(refresh, 1500);
})();

// ── "Find videos on this page" — sends pageUrl + cookies to /extract ────

extractBtn.addEventListener("click", async () => {
  extractBtn.disabled = true;
  extractBtn.textContent = "Finding videos...";

  // Prefer an already-detected embed iframe URL over the parent page URL.
  // yt-dlp can extract https://player.vimeo.com/... directly with the parent
  // as Referer, but it can't handle https://amuseplus.jp/... (no extractor).
  // This is the AmusePlus / Patreon / paywalled-fanclub flow.
  setStatus("Scanning this page...");

  const scannedItems = await scanVisibleFrames();
  if (scannedItems.length) {
    await sendMessage({
      type: "fcdl:detected",
      tabId: currentTabId,
      pageUrl: currentPageUrl,
      items: scannedItems,
    }, 5000);
  }

  const listResponse = await sendMessage({ type: "fcdl:list", tabId: currentTabId }, 5000);
  const currentItems = [...(listResponse?.items || []), ...scannedItems];
  const knownEmbed = currentItems.find((it) =>
    /(?:player\.vimeo\.com\/video\/|youtube\.com\/embed\/|player\.twitch\.tv|dailymotion\.com\/embed)/.test(it.url)
  );
  const targetUrl = knownEmbed ? knownEmbed.url : currentPageUrl;
  const referer   = knownEmbed ? currentPageUrl : null;

  if (knownEmbed) {
    const item = {
      url: knownEmbed.url,
      title: "Detected embedded video",
      label: hostname(knownEmbed.url) || "embedded video",
      kind: knownEmbed.kind || "embed",
      source: knownEmbed.source || "page",
      backendRouted: true,
      pageUrl: targetUrl,
      referer,
    };
    await sendMessage({
      type: "fcdl:detected",
      tabId: currentTabId,
      pageUrl: currentPageUrl,
      items: [item],
    }, 5000);
    const updated = await sendMessage({ type: "fcdl:list", tabId: currentTabId }, 5000);
    render(updated?.items || [item]);
    setStatus("Video found. Click Download to save it.");
    extractBtn.disabled = false;
    extractBtn.textContent = "Find videos on this page";
    return;
  }

  setStatus(knownEmbed
    ? `Resolving ${hostname(knownEmbed.url)} (referer: ${hostname(currentPageUrl)})…`
    : "Resolving stream URLs via backend…"
  );
  try {
    const resp = await sendMessage({ type: "fcdl:extract", pageUrl: targetUrl, referer }, 35000);
    if (!resp?.ok) {
      setStatus(resp?.error || "Backend returned an error.", true);
      return;
    }
    setStatus("");
    const info = resp.info;
    // Surface the extracted media as a clickable item. The Download button
    // routes back through /download with the same (targetUrl + referer) pair,
    // so the backend doesn't have to re-figure-out which URL is the actual
    // video and which is the embedding page.
    const item = {
      url: info.kind === "paired" ? info.videoUrl : info.url,
      title: info.title,
      label: info.label,
      kind: info.kind,
      source: "backend",
      backendRouted: true,
      pageUrl: targetUrl,      // ← the URL we sent (could be a player.vimeo URL)
      referer:  referer,       // ← the page that embeds it (Vimeo's domain check)
    };
    await sendMessage({
      type: "fcdl:detected",
      tabId: currentTabId,
      pageUrl: currentPageUrl,
      items: [item],
    }, 5000);
    const updated = await sendMessage({ type: "fcdl:list", tabId: currentTabId }, 5000);
    render(updated?.items || [item]);
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    extractBtn.disabled = false;
    extractBtn.textContent = "Find videos on this page";
  }
});

// ── Per-item Download ──────────────────────────────────────────────────

async function downloadItem(item) {
  // Don't overwrite item.pageUrl — popup-resolved Vimeo items have it set to
  // the player URL (with referer = embedding page). Falling back to
  // currentPageUrl only when the item doesn't already carry one.
  const itemWithDefaults = { pageUrl: currentPageUrl, ...item };
  setStatus("Starting download…");
  const resp = await sendMessage(
    { type: "fcdl:download", tabId: currentTabId, item: itemWithDefaults },
    20000,
  );
  if (!resp?.ok) {
    setStatus(resp?.error || "Download failed. Check the service-worker console for details.", true);
    return;
  }
  setStatus(`Download started. Check your browser's downloads.`);
}

// ── Settings ──────────────────────────────────────────────────────────

settingsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
});

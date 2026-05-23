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

  // Prefer an already-detected embed iframe URL over the parent page URL.
  // yt-dlp can extract https://player.vimeo.com/... directly with the parent
  // as Referer, but it can't handle https://amuseplus.jp/... (no extractor).
  // This is the AmusePlus / Patreon / paywalled-fanclub flow.
  const currentItems = await new Promise((res) =>
    chrome.runtime.sendMessage({ type: "fcdl:list", tabId: currentTabId }, (r) => res(r?.items || []))
  );
  const knownEmbed = currentItems.find((it) =>
    /(?:player\.vimeo\.com\/video\/|youtube\.com\/embed\/|player\.twitch\.tv|dailymotion\.com\/embed)/.test(it.url)
  );
  const targetUrl = knownEmbed ? knownEmbed.url : currentPageUrl;
  const referer   = knownEmbed ? currentPageUrl : null;

  setStatus(knownEmbed
    ? `Resolving ${hostname(knownEmbed.url)} (referer: ${hostname(currentPageUrl)})…`
    : "Resolving stream URLs via backend…"
  );
  try {
    const resp = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "fcdl:extract", pageUrl: targetUrl, referer }, resolve)
    );
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
    chrome.runtime.sendMessage(
      { type: "fcdl:detected", items: [item] },
      () => {
        // Re-fetch the canonical list from the SW.
        chrome.runtime.sendMessage({ type: "fcdl:list", tabId: currentTabId }, (r) => {
          if (r) render(r.items || []);
        });
      }
    );
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    extractBtn.disabled = false;
  }
});

// ── Per-item Download ──────────────────────────────────────────────────

function downloadItem(item) {
  setStatus(`Starting download…`);
  chrome.runtime.sendMessage(
    { type: "fcdl:download", tabId: currentTabId, item: { ...item, pageUrl: currentPageUrl } },
    (resp) => {
      if (!resp?.ok) {
        setStatus(resp?.error || "Download failed.", true);
        return;
      }
      setStatus(`Download started (#${resp.downloadId}). Check your browser's downloads.`);
    }
  );
}

// ── Settings ──────────────────────────────────────────────────────────

settingsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
});

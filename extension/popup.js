// Popup — show one prominent video, hide the rest behind a collapsed
// "Show other videos" section. Matches the simpler "one obvious action"
// UX of the web app.

const $ = (id) => document.getElementById(id);
const settingsBtn = $("settings-btn");
const pageInfo    = $("page-info");
const primaryEl   = $("primary");
const primaryTitle= $("primary-title");
const primaryMeta = $("primary-meta");
const primaryBtn  = $("primary-download");
const emptyEl     = $("empty");
const extractBtn  = $("extract-btn");
const statusEl    = $("status");
const moreEl      = $("more");
const moreList    = $("more-list");

let currentTabId   = null;
let currentPageUrl = "";

// ── Helpers ────────────────────────────────────────────────────────────

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
  if (item.kind === "embed" || item.source === "iframe") return "Embedded video";
  const h = hostname(item.url);
  if (item.kind === "hls")  return `HLS stream${h ? ` · ${h}` : ""}`;
  if (item.kind === "dash") return `DASH stream${h ? ` · ${h}` : ""}`;
  return h || "Video";
}

function titleOf(item, fallback) {
  return item.title || fallback || describeItem(item) || "Video";
}

// ── Rendering ──────────────────────────────────────────────────────────

let lastItemsKey = "";

function render(items) {
  if (!items || !items.length) {
    primaryEl.hidden = true;
    emptyEl.hidden   = false;
    moreEl.hidden    = true;
    return;
  }

  const [first, ...rest] = items;

  // Primary card
  primaryTitle.textContent = titleOf(first, hostname(currentPageUrl));
  primaryMeta.textContent  = describeItem(first);
  primaryBtn.onclick       = () => downloadItem(first);
  primaryEl.hidden = false;
  emptyEl.hidden   = true;

  // Optional "more videos" section — only when there's >1, and only show
  // up to 5 extras so it never feels like a developer list.
  if (rest.length === 0) {
    moreEl.hidden = true;
    return;
  }
  moreEl.hidden = false;
  moreList.innerHTML = "";
  for (const item of rest.slice(0, 5)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="row-meta">
        <div class="row-title">${escapeHtml(titleOf(item, hostname(item.url)))}</div>
        <div class="row-sub">${escapeHtml(describeItem(item))}</div>
      </div>
      <button type="button">Save</button>
    `;
    li.querySelector("button").addEventListener("click", () => downloadItem(item));
    moreList.appendChild(li);
  }
}

function refresh() {
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ type: "fcdl:list", tabId: currentTabId }, (resp) => {
    if (!resp) return;
    const items = resp.items || [];
    const key = items.map((i) => i.url).join("|");
    if (key !== lastItemsKey) {
      lastItemsKey = key;
      render(items);
    }
  });
}

// ── Init ───────────────────────────────────────────────────────────────

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("No active tab.", "error");
    return;
  }
  currentTabId   = tab.id;
  currentPageUrl = tab.url || "";
  pageInfo.textContent = hostname(currentPageUrl) || currentPageUrl;

  const pong = await sendMessage({ type: "fcdl:ping" }, 3000);
  if (!pong?.ok) {
    emptyEl.hidden = true;
    setStatus(
      "Background service isn't running. Open chrome://extensions and click Reload on FCDownloader.",
      "error",
    );
    return;
  }

  refresh();
  setInterval(refresh, 1500);
})();

// ── "Find videos" fallback — only shown in empty state ─────────────────

extractBtn.addEventListener("click", async () => {
  extractBtn.disabled = true;
  setStatus("Looking for videos…");
  try {
    const resp = await sendMessage({
      type: "fcdl:extract",
      pageUrl: currentPageUrl,
    }, 35000);
    if (!resp?.ok) {
      setStatus(resp?.error || "Couldn't find a video on this page.", "error");
      return;
    }
    setStatus("", "info");
    const info = resp.info;
    const item = {
      url: info.kind === "paired" ? info.videoUrl : info.url,
      title: info.title,
      label: info.label,
      kind: info.kind,
      source: "backend",
      backendRouted: true,
      pageUrl: currentPageUrl,
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

// ── Per-item Download ──────────────────────────────────────────────────

async function downloadItem(item) {
  const itemWithDefaults = { pageUrl: currentPageUrl, ...item };
  setStatus("Starting download…");
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

// ── Settings ───────────────────────────────────────────────────────────

settingsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
});

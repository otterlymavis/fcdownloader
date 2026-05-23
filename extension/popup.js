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

// ── Initial load ────────────────────────────────────────────────────────

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("No active tab.", true);
    return;
  }
  currentTabId = tab.id;
  currentPageUrl = tab.url || "";
  pageInfo.textContent = hostname(currentPageUrl) || currentPageUrl;

  // Ask the service worker for the items the content script has already detected.
  chrome.runtime.sendMessage({ type: "fcdl:list", tabId: tab.id }, (resp) => {
    if (!resp) return;
    render(resp.items || []);
  });
})();

// ── "Find videos on this page" — sends pageUrl + cookies to /extract ────

extractBtn.addEventListener("click", async () => {
  extractBtn.disabled = true;
  setStatus("Resolving stream URLs via backend…");
  try {
    const resp = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "fcdl:extract", pageUrl: currentPageUrl }, resolve)
    );
    if (!resp?.ok) {
      setStatus(resp?.error || "Backend returned an error.", true);
      return;
    }
    setStatus("");
    const info = resp.info;
    // Surface the extracted media as a clickable item alongside content-script items.
    const item = {
      url: info.kind === "paired" ? info.videoUrl : info.url,
      title: info.title,
      label: info.label,
      kind: info.kind,
      source: "backend",
      // Backend result implies we should re-route through /download so muxing happens server-side.
      backendRouted: true,
      pageUrl: currentPageUrl,
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

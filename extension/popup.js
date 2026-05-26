// Popup — show one prominent media item, hide the rest behind a collapsed
// "Show other media" section. Matches the simpler "one obvious action"
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
  if (item.kind === "image") return `Image${hostname(item.url) ? ` ·${hostname(item.url)}` : ""}`;
  if (item.kind === "audio") return `Audio${hostname(item.url) ? ` ·${hostname(item.url)}` : ""}`;
  if (item.kind === "embed" || item.source === "iframe") return "Embedded video";
  const h = hostname(item.url);
  if (item.kind === "hls")  return `HLS stream${h ? ` · ${h}` : ""}`;
  if (item.kind === "dash") return `DASH stream${h ? ` · ${h}` : ""}`;
  return h || "Media";
}

function titleOf(item, fallback) {
  return item.title || fallback || describeItem(item) || "Media";
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

  // Optional "more media" section — only when there's >1, and only show
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

  // First-run gate — only triggers when neither storage NOR the build-time
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
      return;  // skip the refresh loop — nothing to fetch
    }
  } catch {}

  refresh();
  setInterval(refresh, 1500);
})();

// ── "Find media" fallback — only shown in empty state ─────────────────

extractBtn.addEventListener("click", async () => {
  extractBtn.disabled = true;
  setStatus("Looking for media...��");
  try {
    const resp = await sendMessage({
      type: "fcdl:extract",
      pageUrl: currentPageUrl,
    }, 35000);
    if (!resp?.ok) {
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

// ── Gallery rendering ──────────────────────────────────────────────────
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
  return parts.join(" · ") || `${items.length} items`;
}

function renderGallery(info) {
  const items = info.items;
  primaryTitle.textContent = info.title || `${items.length} items`;
  primaryMeta.textContent  = describeGallery(items);
  primaryBtn.textContent   = `Save all ${items.length}`;
  primaryBtn.onclick = async () => {
    primaryBtn.disabled = true;
    setStatus(`Downloading 0 of ${items.length}…`);
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

  // Per-item list — collapsed by default
  moreEl.hidden = false;
  moreEl.querySelector("summary").textContent = `Show individual items (${items.length})`;
  moreList.innerHTML = "";
  items.forEach((it, idx) => {
    const li = document.createElement("li");
    const label = it.kind === "image" ? "Photo" : "Video";
    li.innerHTML = `
      <div class="row-meta">
        <div class="row-title">${escapeHtml(label)} ${idx + 1}</div>
        <div class="row-sub">${escapeHtml((it.ext || "").toUpperCase() || it.kind)}</div>
      </div>
      <button type="button">Save</button>
    `;
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
}

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

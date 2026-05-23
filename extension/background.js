/**
 * Service worker — central state, talks to the Fly backend, drives chrome.downloads.
 *
 * Responsibilities:
 *  - Maintain a per-tab list of detected media URLs (from content scripts +
 *    webRequest interception of m3u8/mpd/mp4).
 *  - Read cookies for the current page domain via chrome.cookies (HttpOnly
 *    cookies that a bookmarklet can't see). Forward to the backend.
 *  - Route to chrome.downloads.download() for direct mp4 URLs (no server
 *    bandwidth) OR to the backend /download endpoint for HLS / paired
 *    YouTube HD streams.
 */

const DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev";

// ── Detected videos per tab ───────────────────────────────────────────────

const tabState = new Map(); // tabId -> { url, pageUrl, items: [{url, kind, source, ...}] }

function ensureTab(tabId, pageUrl) {
  let s = tabState.get(tabId);
  if (!s || s.pageUrl !== pageUrl) {
    s = { tabId, pageUrl, items: [], updatedAt: Date.now() };
    tabState.set(tabId, s);
  }
  return s;
}

function addItem(tabId, pageUrl, item) {
  const s = ensureTab(tabId, pageUrl);
  if (!item || !item.url) return;
  // De-dupe by URL (strip query for HLS segments so the master m3u8 wins)
  const baseUrl = item.url.replace(/[?&]range=[^&]*/g, "");
  if (s.items.find((i) => i.url === baseUrl || i.url === item.url)) return;
  s.items.unshift({ ...item, url: baseUrl, capturedAt: Date.now() });
  s.items = s.items.slice(0, 30);
  s.updatedAt = Date.now();
  updateBadge(tabId, s.items.length);
}

function updateBadge(tabId, count) {
  try {
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#222222" });
  } catch {}
}

// ── webRequest interception — catches segment URLs the DOM doesn't show ───

// MV3 forbids blocking webRequest in production, but onCompleted (non-blocking
// observation) is allowed and gives us exactly what we need.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.tabId || details.tabId < 0) return;
    const u = details.url;
    if (!u || u.length < 12) return;

    // Filter to known video patterns. Captures HLS / DASH / mp4 from common
    // CDNs without spamming the list with every CSS / JS / image request.
    if (!isLikelyMedia(u)) return;

    chrome.tabs.get(details.tabId).then((tab) => {
      if (!tab?.url) return;
      addItem(details.tabId, tab.url, {
        url: u,
        kind: u.includes(".m3u8") ? "hls" :
              u.includes(".mpd")  ? "dash" : "direct",
        source: "network",
        mime: details.responseHeaders?.find((h) => /content-type/i.test(h.name))?.value || "",
      });
    }).catch(() => {});
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

function isLikelyMedia(url) {
  const u = url.toLowerCase().split("?")[0];
  if (u.endsWith(".m3u8") || u.endsWith(".mpd")) return true;
  if (u.endsWith(".mp4") || u.endsWith(".webm") || u.endsWith(".mov")) return true;
  // Known video CDNs (no extension)
  if (/(?:googlevideo\.com\/videoplayback|video\.twimg\.com|cdninstagram\.com|fbcdn\.net|threadscdn\.com|v\.redd\.it|tiktokcdn\.com|v\d+-webapp\.tiktok\.com|bilivideo\.com|dmcdn\.net|pinimg\.com\/videos|vimeocdn\.com)/.test(url)) {
    // Skip byte-range YouTube segments (will dedupe to the parent URL)
    if (/googlevideo\.com\/videoplayback/.test(url) && /[?&]range=/.test(url)) return false;
    return true;
  }
  return false;
}

// ── Cookies forwarding ────────────────────────────────────────────────────

async function cookieHeaderFor(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    // Format as Cookie: name=value; name=value
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

// ── Settings ──────────────────────────────────────────────────────────────

async function getSettings() {
  const stored = await chrome.storage.sync.get({ backend: "", muxRemote: true });
  return {
    backend: (stored.backend || DEFAULT_BACKEND).trim().replace(/\/+$/, ""),
    muxRemote: stored.muxRemote !== false,
  };
}

// ── Backend extract ───────────────────────────────────────────────────────

async function callExtract(pageUrl, referer, cookies) {
  const { backend } = await getSettings();
  const body = { pageUrl };
  if (referer) body.referer = referer;
  if (cookies) body.cookies = cookies;
  const r = await fetch(`${backend}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

function backendDownloadUrl(backend, pageUrl, referer, cookies) {
  const p = new URLSearchParams({ url: pageUrl });
  if (referer) p.set("referer", referer);
  if (cookies) p.set("cookies", cookies);
  return `${backend}/download?${p.toString()}`;
}

// ── Download orchestration ────────────────────────────────────────────────

async function downloadItem(tabId, item) {
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = tab?.url || item.pageUrl;
  const cookies = await cookieHeaderFor(pageUrl);

  // For HLS / DASH / known-server-only sites, always route through the
  // backend so ffmpeg can mux / convert to a single mp4.
  const needsMux = item.kind === "hls" || item.kind === "dash" ||
                   /youtube\.com|youtu\.be|googlevideo\.com|vimeo\.com|player\.vimeo\.com/.test(item.url || pageUrl);

  if (needsMux) {
    const { backend } = await getSettings();
    const dlUrl = backendDownloadUrl(backend, item.pageUrl || pageUrl, pageUrl, cookies);
    return chromeDownload(dlUrl, suggestedFilename(item, pageUrl));
  }

  // Direct browser download for plain mp4/webm URLs that allow cross-origin
  // fetch with their CDN's CORS. chrome.downloads.download() doesn't need
  // CORS but does need the URL to be reachable; we let the CDN reject if it
  // can't serve to the browser. Falls back to backend on failure.
  try {
    return await chromeDownload(item.url, suggestedFilename(item, pageUrl));
  } catch (e) {
    console.warn("[fcdl] direct download failed, falling back to backend:", e);
    const { backend } = await getSettings();
    const dlUrl = backendDownloadUrl(backend, item.url, pageUrl, cookies);
    return chromeDownload(dlUrl, suggestedFilename(item, pageUrl));
  }
}

function chromeDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: filename || undefined,
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(downloadId);
    });
  });
}

function suggestedFilename(item, pageUrl) {
  const title = item.title || hostname(pageUrl) || "video";
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "").slice(0, 80);
  return `${safe}.mp4`;
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// ── Message handler — popup ↔ service worker ──────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "fcdl:list") {
      const tabId = msg.tabId ?? sender.tab?.id;
      const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const s = tabId != null ? tabState.get(tabId) : null;
      sendResponse({ pageUrl: tab?.url || "", items: s?.items || [], settings: await getSettings() });
      return;
    }
    if (msg.type === "fcdl:detected") {
      // From content script: items it found in the DOM
      const tabId = sender.tab?.id;
      const pageUrl = sender.tab?.url;
      if (tabId != null && pageUrl && Array.isArray(msg.items)) {
        for (const it of msg.items) addItem(tabId, pageUrl, { ...it, source: it.source || "dom" });
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "fcdl:extract") {
      // Popup-initiated: hit backend /extract with pageUrl + cookies
      try {
        const cookies = await cookieHeaderFor(msg.pageUrl);
        const info = await callExtract(msg.pageUrl, msg.referer || null, cookies || null);
        sendResponse({ ok: true, info });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }
    if (msg.type === "fcdl:download") {
      try {
        const id = await downloadItem(msg.tabId, msg.item);
        sendResponse({ ok: true, downloadId: id });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }
    if (msg.type === "fcdl:clear") {
      const tabId = msg.tabId ?? sender.tab?.id;
      tabState.delete(tabId);
      updateBadge(tabId, 0);
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // async
});

// Clean up state when tab is closed / navigated
chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) {
    // navigation — start fresh
    tabState.delete(tabId);
    updateBadge(tabId, 0);
  }
});

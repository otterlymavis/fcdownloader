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

// Higher = more likely to be "the" video the user wants. Pages that scoop
// up every video_url JSON field (Threads feeds, AmusePlus news pages with
// comments) would otherwise drown the actual embed in noise.
function itemPriority(item) {
  if (item.source === "iframe" || item.kind === "embed") return 100;
  if (item.source === "video-tag") return 80;
  if (item.kind === "hls" || item.kind === "dash") return 60;
  if (item.source === "yt-player-response") return 90;
  if (item.source === "bili-playinfo") return 90;
  if (item.source === "backend") return 95;
  if (item.source === "network") return 40;
  if (item.source === "meta-json") return 30;  // common on Meta feeds; usually noise
  if (item.source === "og:video") return 70;
  return 50;
}

function addItem(tabId, pageUrl, item) {
  const s = ensureTab(tabId, pageUrl);
  if (!item || !item.url) return;
  // De-dupe by URL (strip range / rn so byte-segment requests collapse onto
  // their master URL).
  const baseUrl = item.url.replace(/[?&]range=[^&]*/g, "").replace(/[?&]rn=[^&]*/g, "");
  if (s.items.find((i) => i.url === baseUrl || i.url === item.url)) return;
  const enriched = { ...item, url: baseUrl, capturedAt: Date.now(), priority: itemPriority(item) };
  s.items.push(enriched);
  // Sort by priority desc, then by recency desc. Cap so feed-noise sites
  // don't fill the popup with dozens of low-relevance URLs.
  s.items.sort((a, b) => (b.priority - a.priority) || (b.capturedAt - a.capturedAt));
  s.items = s.items.slice(0, 10);
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
//
// MV3 forbids blocking webRequest in production, but onCompleted (non-blocking
// observation) is allowed and gives us exactly what we need. Guarded by a
// try/catch + null check because the API may be missing if the webRequest
// permission isn't granted (or the user is on a fork that strips it).
try {
  if (chrome.webRequest?.onCompleted) {
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (!details.tabId || details.tabId < 0) return;
        const u = details.url;
        if (!u || u.length < 12) return;
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
    console.log("[fcdl] webRequest listener registered");
  } else {
    console.warn("[fcdl] chrome.webRequest unavailable — install permission missing?");
  }
} catch (e) {
  console.warn("[fcdl] webRequest setup failed:", e);
}

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

  // Hard-cap the request. yt-dlp retries + generic-extractor fallback take
  // up to ~20s on hard sites; anything longer is almost certainly a hang.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);

  try {
    const r = await fetch(`${backend}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} — ${text.slice(0, 240)}`);
    }
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Backend timed out after 25s. The site probably blocked the server, or yt-dlp can't extract it. Check fly logs for the real reason.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function backendDownloadUrl(backend, pageUrl, referer, cookies) {
  const p = new URLSearchParams({ url: pageUrl });
  if (referer) p.set("referer", referer);
  if (cookies) p.set("cookies", cookies);
  return `${backend}/download?${p.toString()}`;
}

// ── Download orchestration ────────────────────────────────────────────────

// Preflight a backend /download URL: fetch the headers, abort the body. If
// the server is going to respond with JSON (its error format), we return the
// error text instead of saving garbage as a .mp4.
async function preflightBackendUrl(url) {
  const ac = new AbortController();
  try {
    const r = await fetch(url, { method: "GET", signal: ac.signal });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      ac.abort();
      return { ok: false, error: `${r.status}: ${body.slice(0, 240)}` };
    }
    if (ct.startsWith("video/") || ct.startsWith("application/x-mpegURL") || ct.startsWith("application/octet-stream")) {
      ac.abort();  // abort the body; chrome.downloads will fetch fresh
      return { ok: true };
    }
    // It's some other content-type — almost certainly the error JSON FastAPI
    // returns when yt-dlp fails. Read it so we can show the message.
    const body = await r.text().catch(() => "");
    return { ok: false, error: body.slice(0, 240) };
  } catch (e) {
    if (e.name === "AbortError") return { ok: true };  // we aborted on success
    return { ok: false, error: String(e.message || e) };
  }
}

async function downloadItem(tabId, item) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const tabPageUrl = tab?.url || "";

  // For backendRouted items (popup-resolved /extract results), item.pageUrl
  // is the actual URL we sent to /extract (e.g. https://player.vimeo.com/...),
  // and we MUST send the same URL to /download for the cache to hit and for
  // yt-dlp to take the same path.
  //
  // For content-script-detected items (iframe / video tag), the *video* URL
  // is item.url — that's what yt-dlp can extract. The TAB url (e.g.
  // https://amuseplus.jp/...) is just the embedding page; yt-dlp has no
  // extractor for it. Sending the tab URL to backend was the bug.
  const urlForBackend = item.backendRouted
    ? item.pageUrl
    : (item.url || item.pageUrl || tabPageUrl);
  const referer = item.referer || item.pageUrl || tabPageUrl || null;
  const cookieSourceUrl = referer || urlForBackend;
  const cookies = await cookieHeaderFor(cookieSourceUrl);
  const { backend } = await getSettings();

  console.log("[fcdl] download", {
    item_url: (item.url || "").slice(0, 80),
    sent_url: (urlForBackend || "").slice(0, 80),
    referer: (referer || "").slice(0, 80),
    cookies_chars: cookies.length,
    backendRouted: !!item.backendRouted,
    kind: item.kind,
  });

  async function viaBackend(pageForBackend) {
    const dlUrl = backendDownloadUrl(backend, pageForBackend, referer, cookies);
    console.log("[fcdl] → backend", dlUrl.slice(0, 120));
    const check = await preflightBackendUrl(dlUrl);
    if (!check.ok) {
      throw new Error(`Backend: ${check.error}`);
    }
    return chromeDownload(dlUrl, suggestedFilename(item, urlForBackend));
  }

  if (item.backendRouted) {
    return viaBackend(urlForBackend);
  }

  // HLS / DASH / paired adaptive / known-server-only sites need backend muxing.
  const needsMux =
    item.kind === "hls" || item.kind === "dash" || item.kind === "paired" || item.kind === "embed" ||
    /youtube\.com|youtu\.be|googlevideo\.com|(?:player\.)?vimeo\.com|vimeocdn\.com/.test(item.url || urlForBackend);

  if (needsMux) {
    return viaBackend(urlForBackend);
  }

  // Plain mp4/webm CDN URLs that don't require auth — direct download.
  console.log("[fcdl] → direct CDN");
  try {
    return await chromeDownload(item.url, suggestedFilename(item, downloadPageUrl));
  } catch (e) {
    console.warn("[fcdl] direct failed, falling back to backend:", e);
    const dlUrl = backendDownloadUrl(backend, item.url, referer, cookies);
    return chromeDownload(dlUrl, suggestedFilename(item, downloadPageUrl));
  }
}

// Surface download failures (the chrome.downloads.download callback gives us
// a downloadId immediately but the actual file fetch can fail later). Log
// any interrupted downloads so we can see them in the service-worker console.
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "interrupted") {
    console.warn("[fcdl] download interrupted:", delta);
  } else if (delta.state?.current === "complete") {
    console.log("[fcdl] download complete:", delta.id);
  }
});

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
    if (msg.type === "fcdl:ping") {
      sendResponse({ ok: true, ts: Date.now() });
      return;
    }
    if (msg.type === "fcdl:list") {
      const tabId = msg.tabId ?? sender.tab?.id;
      const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const s = tabId != null ? tabState.get(tabId) : null;
      sendResponse({ pageUrl: tab?.url || "", items: s?.items || [], settings: await getSettings() });
      return;
    }
    if (msg.type === "fcdl:detected") {
      // From content script: items it found in the DOM
      const tabId = msg.tabId ?? sender.tab?.id;
      const pageUrl = msg.pageUrl ?? sender.tab?.url;
      if (tabId != null && pageUrl && Array.isArray(msg.items)) {
        for (const it of msg.items) addItem(tabId, pageUrl, { ...it, source: it.source || "dom" });
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "fcdl:extract") {
      // Popup-initiated: hit backend /extract with pageUrl + cookies
      const t0 = Date.now();
      try {
        const cookies = await cookieHeaderFor(msg.referer || msg.pageUrl);
        console.log("[fcdl] extract →", msg.pageUrl, "cookies:", cookies.length, "chars");
        const info = await callExtract(msg.pageUrl, msg.referer || null, cookies || null);
        console.log("[fcdl] extract ←", Date.now() - t0, "ms, kind=", info?.kind);
        sendResponse({ ok: true, info });
      } catch (e) {
        const elapsed = Date.now() - t0;
        console.warn("[fcdl] extract failed in", elapsed, "ms:", e);
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

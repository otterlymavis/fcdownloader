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

// Default backend URL baked into THIS build at packaging time. The OSS
// source has FCDL_DEFAULT_BACKEND = "" in config.js so forks don't inherit
// anyone's infrastructure; a distribution build replaces that value at
// packaging time so end users never have to enter the URL manually.
import { FCDL_DEFAULT_BACKEND } from "./config.js";
const DEFAULT_BACKEND = (FCDL_DEFAULT_BACKEND || "").trim().replace(/\/+$/, "");

// On install: seed the storage.sync backend from DEFAULT_BACKEND so the
// user never sees the "configure backend" screen on a public-distribution
// build. Existing user overrides are preserved.
//
// On update or fresh install with NO default baked in (i.e. someone built
// from source without setting the env var), open the options page so the
// configuration step is at least obvious.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install" && details.reason !== "update") return;
  try {
    const stored = await chrome.storage.sync.get({ backend: "" });
    if (!stored.backend?.trim()) {
      if (DEFAULT_BACKEND) {
        await chrome.storage.sync.set({ backend: DEFAULT_BACKEND });
        console.log("[fcdl] seeded backend from build default:", DEFAULT_BACKEND);
      } else {
        chrome.runtime.openOptionsPage();
      }
    }
  } catch (e) {
    console.warn("[fcdl] onInstalled setup failed:", e);
  }
});

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
  // Images always rank below any video signal — defensive backstop in case
  // the host-scoped image scanners in content.js still capture something
  // unwanted. On image-host pages (IG/Pinterest/Reddit) the primary item
  // is usually the iframe/video at priority 100; images sit below it.
  if (item.kind === "image") return 25;
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
                  u.includes(".mpd")  ? "dash" :
                  /\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(u) ? "image" :
                  /\.(mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(u) ? "audio" : "direct",
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
  if (/\.(jpe?g|png|webp|gif|avif|heic|mp3|m4a|aac|wav|ogg|opus|flac)$/.test(u)) return true;
  // Known video CDNs (no extension)
  if (/(?:googlevideo\.com\/videoplayback|video\.twimg\.com|cdninstagram\.com|scontent[-\w]*\.cdninstagram\.com|fbcdn\.net|threadscdn\.com|v\.redd\.it|tiktokcdn\.com|v\d+-webapp\.tiktok\.com|bilivideo\.com|dmcdn\.net|pinimg\.com\/(?:videos|originals|736x|1200x|564x)|vimeocdn\.com)/.test(url)) {
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
  if (!backend) {
    throw new Error(
      "Backend URL is not configured. Open the extension options and set one (e.g. https://your-instance.fly.dev)."
    );
  }
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
    if (ct.startsWith("video/") || ct.startsWith("image/") || ct.startsWith("audio/") || ct.startsWith("application/x-mpegURL") || ct.startsWith("application/octet-stream")) {
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
  const downloadPageUrl = item.pageUrl || referer || urlForBackend || tabPageUrl;
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
    /youtube\.com|youtu\.be|googlevideo\.com|(?:player\.)?vimeo\.com|vimeocdn\.com|bilivideo\.com|bilibili\.com/.test(item.url || urlForBackend);

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
  const title = item.title || hostname(pageUrl) || "media";
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "").slice(0, 80);
  const ext = (item.ext || extFromUrl(item.url) || (item.kind === "image" ? "jpg" : item.kind === "audio" ? "mp3" : "mp4")).toLowerCase();
  return `${safe}.${ext.replace(/[^a-z0-9]/g, "") || "bin"}`;
}

function extFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "";
  } catch {
    return String(url || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || "";
  }
}

// ── Gallery downloads — Instagram carousel, Reddit gallery, Threads ───────

function sanitizeForFile(s) {
  return String(s || "").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "").trim().slice(0, 60);
}

function galleryFilename(title, index, item) {
  const base = sanitizeForFile(title) || "gallery";
  // 1-based index, zero-padded so files sort naturally in Downloads.
  const n = String(index + 1).padStart(2, "0");
  const ext = (item.ext || (item.kind === "image" ? "jpg" : "mp4"))
    .toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  return `${base}/${base}-${n}.${ext}`;
}

// Route gallery items through the server's /proxy endpoint so it can attach
// the Referer / Cookie / User-Agent that the CDN expects. chrome.downloads
// itself can't set those headers, which is why direct downloads from
// cdninstagram.com / fbcdn.net silently land as 0-byte or HTML files.
async function buildProxiedUrl(item, ctx) {
  const { backend } = await getSettings();
  const params = new URLSearchParams({ url: item.url });
  if (ctx?.referer) params.set("referer", ctx.referer);
  if (ctx?.cookies) params.set("cookies", ctx.cookies);
  // Pass an ext-aware suggested filename so the proxy can set
  // Content-Disposition. The path-folder part of galleryFilename has to be
  // dropped here because Content-Disposition can't contain a directory.
  params.set("filename", (ctx?.filename || "").split("/").pop() || "");
  return `${backend}/proxy?${params.toString()}`;
}

async function downloadGalleryItem(title, index, item, ctx) {
  const filename = galleryFilename(title, index, item);
  const sourceUrl = item.kind === "paired" ? (item.videoUrl || item.url) : item.url;
  if (!sourceUrl) throw new Error(`gallery item ${index} has no URL`);

  const proxied = await buildProxiedUrl(
    { ...item, url: sourceUrl },
    { ...(ctx || {}), filename },
  );
  return chromeDownload(proxied, filename);
}

async function downloadGallery(tabId, pageUrl, title, items) {
  // Build referer + cookies once for the whole batch; every item in a carousel
  // shares the same auth context (same Instagram/Reddit/Threads post).
  const cookies = await cookieHeaderFor(pageUrl || "");
  const ctx = { referer: pageUrl || "", cookies };

  let started = 0;
  let failed  = 0;
  for (let i = 0; i < items.length; i++) {
    try {
      await downloadGalleryItem(title, i, items[i], ctx);
      started++;
    } catch (e) {
      failed++;
      console.warn(`[fcdl] gallery item ${i} failed:`, e);
    }
    // Tiny gap so chrome.downloads doesn't queue them as one batch and so
    // the user's Downloads UI doesn't look like a single concurrent storm.
    await new Promise((r) => setTimeout(r, 120));
  }
  return { started, failed };
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
    if (msg.type === "fcdl:download_gallery") {
      const r = await downloadGallery(msg.tabId, msg.pageUrl, msg.title, msg.items);
      sendResponse({ ok: true, ...r });
      return;
    }
    if (msg.type === "fcdl:download_gallery_item") {
      try {
        const tabId = msg.tabId ?? sender.tab?.id;
        const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
        const pageUrl = msg.pageUrl || tab?.url || "";
        const cookies = await cookieHeaderFor(pageUrl);
        const id = await downloadGalleryItem(msg.title, msg.index, msg.item, { referer: pageUrl, cookies });
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

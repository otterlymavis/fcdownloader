/**
 * Content script — injected into every page (and every frame).
 *
 * Scans the rendered DOM for embed iframes, <video>/<source>, og:video meta,
 * and known site-specific data globals (ytInitialPlayerResponse, Bilibili's
 * window.__playinfo__, Threads/Instagram's video_url JSON fields). Reports
 * findings back to the service worker which de-dupes and exposes them via
 * the popup.
 */

(() => {
  if (window.__fcdl_content_injected) return;
  window.__fcdl_content_injected = true;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function post(items) {
    if (!items || !items.length) return;
    chrome.runtime.sendMessage({ type: "fcdl:detected", items });
  }

  function decode(u) {
    return String(u || "")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\")
      .trim();
  }

  const EMBED_HOSTS = [
    "player.vimeo.com",
    "www.youtube.com/embed",
    "youtube.com/embed",
    "player.twitch.tv",
    "www.dailymotion.com/embed",
    "dailymotion.com/embed",
    "fast.wistia.net/embed",
    "vk.com/video_ext.php",
    "ok.ru/videoembed",
  ];

  function isEmbed(src) {
    if (!src) return false;
    return EMBED_HOSTS.some((h) => src.indexOf(h) !== -1);
  }

  // ── Scanners ─────────────────────────────────────────────────────────────

  function scanIframes() {
    const found = [];
    document.querySelectorAll("iframe").forEach((el) => {
      const src = el.src || el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || "";
      if (isEmbed(src)) {
        found.push({ url: src, kind: "embed", source: "iframe" });
      }
    });
    return found;
  }

  function scanVideoTags() {
    const found = [];
    document.querySelectorAll("video, video source").forEach((el) => {
      const src = el.currentSrc || el.src || el.getAttribute("src") || "";
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
      found.push({
        url: src,
        kind: src.includes(".m3u8") ? "hls" : src.includes(".mpd") ? "dash" : "direct",
        source: "video-tag",
      });
    });
    return found;
  }

  function scanMetaTags() {
    const found = [];
    document
      .querySelectorAll(
        'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]'
      )
      .forEach((m) => {
        const u = decode(m.getAttribute("content"));
        if (u && u.startsWith("http")) {
          found.push({ url: u, kind: "direct", source: "og:video" });
        }
      });
    return found;
  }

  // Meta/Threads/Instagram — JSON-encoded fields in the page HTML
  function scanMetaJson(html) {
    const found = [];
    const patterns = [
      [/"video_url":"(https?:[^"]+)"/g, "direct"],
      [/"playable_url(?:_quality_hd)?":"(https?:[^"]+)"/g, "direct"],
      [/"browser_native_(?:hd|sd)_url":"(https?:[^"]+)"/g, "direct"],
      [/"hd_src":"(https?:[^"]+)"/g, "direct"],
      [/"sd_src":"(https?:[^"]+)"/g, "direct"],
    ];
    for (const [re, kind] of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        found.push({ url: decode(m[1]), kind, source: "meta-json" });
      }
    }
    return found;
  }

  // YouTube — pull HLS / direct URLs from ytInitialPlayerResponse if present.
  // (For HD on YouTube the backend path is required anyway, but this catches
  // the muxed itag-18 URL for instant direct download.)
  function scanYouTube() {
    const found = [];
    if (!/youtube\.com\/watch|youtu\.be\//.test(location.href)) return found;
    try {
      const ipr = window.ytInitialPlayerResponse;
      const sd = ipr?.streamingData;
      if (sd?.hlsManifestUrl) {
        found.push({ url: sd.hlsManifestUrl, kind: "hls", source: "yt-player-response", label: "HLS" });
      }
      if (Array.isArray(sd?.formats)) {
        for (const f of sd.formats) {
          if (f?.url) {
            found.push({
              url: f.url,
              kind: "direct",
              source: "yt-player-response",
              label: f.qualityLabel || (f.height ? `${f.height}p` : ""),
            });
            break; // only one muxed format exists
          }
        }
      }
    } catch {}
    return found;
  }

  // Bilibili — window.__playinfo__ exposes the actual stream URLs
  function scanBilibili() {
    const found = [];
    if (!/bilibili\.com\//.test(location.href)) return found;
    try {
      const pi = window.__playinfo__;
      const data = pi?.data;
      if (Array.isArray(data?.durl) && data.durl.length) {
        const u = decode(data.durl[0].url || "");
        if (u) found.push({ url: u, kind: "direct", source: "bili-playinfo", label: "Bilibili" });
      }
    } catch {}
    return found;
  }

  // ── Run all scans ────────────────────────────────────────────────────────

  function scanAll() {
    const out = [];
    out.push(...scanIframes());
    out.push(...scanVideoTags());
    out.push(...scanMetaTags());
    out.push(...scanYouTube());
    out.push(...scanBilibili());
    // Whole-page-HTML regex pass — cheap, catches lots of Meta JSON
    try {
      const html = document.documentElement.outerHTML;
      // Cap to first 1 MB — bigger pages have nothing relevant past that
      out.push(...scanMetaJson(html.length > 1_000_000 ? html.slice(0, 1_000_000) : html));
    } catch {}
    return out;
  }

  // Initial scan + delayed re-scan (JS players hydrate after document_idle).
  function fullScan() {
    const items = scanAll();
    if (items.length) post(items);
  }

  fullScan();
  setTimeout(fullScan, 2000);
  setTimeout(fullScan, 5000);

  // Reactive scan when new <video>/<iframe> appears (SPA navigation, lazy-load).
  let pending = null;
  const obs = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; fullScan(); }, 800);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();

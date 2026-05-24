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
    document.querySelectorAll("video, audio, video source, audio source").forEach((el) => {
      const src = el.currentSrc || el.src || el.getAttribute("src") || "";
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
      found.push({
        url: src,
        kind: src.includes(".m3u8") ? "hls" : src.includes(".mpd") ? "dash" : el.tagName === "AUDIO" ? "audio" : "direct",
        source: "video-tag",
      });
    });
    return found;
  }

  function scanImageTags() {
    const found = [];
    document.querySelectorAll("img, picture source").forEach((el) => {
      if (el.tagName === "IMG" && Math.max(el.naturalWidth || 0, el.naturalHeight || 0) < 160) return;
      const src = el.currentSrc || el.src || el.getAttribute("src") || el.getAttribute("srcset")?.split(/\s+/)[0] || "";
      if (!src || src.startsWith("data:") || src.startsWith("blob:")) return;
      if (!/^https?:\/\//i.test(src)) return;
      if (/(?:favicon|apple-touch-icon|sprite|logo|placeholder|blank|pixel|tracking)/i.test(src)) return;
      found.push({ url: src, kind: "image", source: "image-tag" });
    });
    return found;
  }

  function scanMetaTags() {
    const found = [];
    // Always look for og:video / twitter:player. Only look for og:image
    // when we're on a known image-host page — otherwise every YouTube /
    // Bilibili / news page would surface a thumbnail as a "media item".
    const selector = shouldScanImages()
      ? 'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"], meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]'
      : 'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]';
    document.querySelectorAll(selector).forEach((m) => {
      const u = decode(m.getAttribute("content"));
      if (u && u.startsWith("http")) {
        found.push({ url: u, kind: /\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(u) ? "image" : "direct", source: "meta" });
      }
    });
    return found;
  }

  // Meta/Threads/Instagram — JSON-encoded fields in the page HTML
  function scanMetaJson(html) {
    const found = [];
    const patterns = [
      [/"video_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, "direct"],
      [/"playable_url(?:_quality_hd)?"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, "direct"],
      [/"browser_native_(?:hd|sd)_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, "direct"],
      [/"hd_src"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, "direct"],
      [/"sd_src"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, "direct"],
      [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:cdninstagram\.com|fbcdn\.net|threadscdn\.com)[^"'\\<>\s]*\.(?:mp4|m3u8)[^"'\\<>\s]*)/g, "direct"],
      [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:cdninstagram\.com|fbcdn\.net|threadscdn\.com|pinimg\.com|weibocdn\.com|sinaimg\.cn|xhscdn\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp|gif|avif|heic)[^"'\\<>\s]*)/g, "image"],
      [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:weibocdn\.com|xhscdn\.com)[^"'\\<>\s]*\.(?:mp4|m3u8|mov)[^"'\\<>\s]*)/g, "direct"],
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
      let pi = window.__playinfo__;
      if (!pi) {
        const html = document.documentElement.outerHTML;
        const match = html.match(/window\.__playinfo__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
        if (match) pi = JSON.parse(match[1]);
      }
      const data = pi?.data;
      if (Array.isArray(data?.durl) || data?.dash) {
        found.push({
          url: location.href,
          pageUrl: location.href,
          kind: "embed",
          source: "bili-playinfo",
          label: "Bilibili",
          backendRouted: true,
        });
      }
    } catch {}
    return found;
  }

  // Weibo follower-only posts need the user's authenticated cookies, so route
  // the page itself to the backend instead of surfacing page thumbnails/assets.
  function scanWeibo() {
    const found = [];
    if (!/(?:^|\.)weibo\.(?:com|cn)$/i.test(location.hostname)) return found;
    if (!/(?:\/(?:status|detail)\/[A-Za-z0-9]+|\/(?:\d+|0)\/[A-Za-z0-9]+|\/tv\/show\/|video\.weibo\.com\/show)/i.test(location.href)) return found;
    found.push({
      url: location.href,
      pageUrl: location.href,
      kind: "embed",
      source: "weibo-page",
      label: "Weibo",
      backendRouted: true,
    });
    return found;
  }

  // ── Run all scans ────────────────────────────────────────────────────────

  // Image scanning is only useful on hosts where photo downloads are the
  // user's likely intent (Meta carousels, Pinterest pins, Reddit galleries,
  // X/Twitter image posts). On every OTHER site — especially YouTube,
  // Bilibili, news sites — running it pollutes the popup with thumbnails of
  // recommended videos, channel avatars, og:image cards, and ad creatives.
  const IMAGE_HOSTS = /(?:^|\.)(instagram\.com|threads\.com|threads\.net|pinterest\.|reddit\.com|redd\.it|twitter\.com|x\.com|facebook\.com|tumblr\.com|xiaohongshu\.com)$/i;
  function shouldScanImages() {
    try { return IMAGE_HOSTS.test(location.hostname); } catch { return false; }
  }

  function scanAll() {
    const out = [];
    out.push(...scanIframes());
    out.push(...scanVideoTags());
    if (shouldScanImages()) out.push(...scanImageTags());
    out.push(...scanMetaTags());
    out.push(...scanYouTube());
    out.push(...scanBilibili());
    out.push(...scanWeibo());

    // Page-wide JSON-field scan is noisy: news pages with comments / feeds
    // (AmusePlus, Threads feed pages) contain dozens of "video_url" matches
    // that aren't THE video the user wants. Only run this pass if no
    // higher-signal source already found something.
    if (out.length === 0) {
      try {
        const html = document.documentElement.outerHTML;
        out.push(...scanMetaJson(html.length > 1_000_000 ? html.slice(0, 1_000_000) : html));
      } catch {}
    }
    return out;
  }

  function fullScan() {
    const items = scanAll();
    if (items.length) post(items);
  }

  // Stop re-scanning once we've found embeds/video-tags — JS-loaded players
  // may take 5-10s to hydrate, but after they're in the DOM further scans
  // just produce duplicates (already de-duped in the SW, but wastes CPU).
  let scanCount = 0;
  let foundOnce = false;
  function maybeScan() {
    scanCount++;
    const items = scanAll();
    if (items.length) {
      foundOnce = true;
      post(items);
    }
    // Stop after 8 cycles (covers ~16s of page hydration) OR once we found
    // anything embed-like.
    return foundOnce || scanCount >= 8;
  }

  maybeScan();
  const earlyTimer = setInterval(() => {
    if (maybeScan()) clearInterval(earlyTimer);
  }, 2000);

  // Reactive scan when new <video>/<iframe> appears (SPA navigation,
  // lazy-load). Debounced + bounded so a chatty page doesn't spam events.
  let pending = null;
  let mutationScans = 0;
  const obs = new MutationObserver(() => {
    if (pending || mutationScans >= 5) return;
    pending = setTimeout(() => {
      pending = null;
      mutationScans++;
      maybeScan();
    }, 1200);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();

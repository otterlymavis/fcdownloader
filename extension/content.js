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

  const YOUTUBE_LOCALES = {
    en: { hl: "en", gl: "US" },
    es: { hl: "es", gl: "ES" },
    fr: { hl: "fr", gl: "FR" },
    de: { hl: "de", gl: "DE" },
    pt: { hl: "pt", gl: "BR" },
    it: { hl: "it", gl: "IT" },
    ja: { hl: "ja", gl: "JP" },
    ko: { hl: "ko", gl: "KR" },
    zh: { hl: "zh-CN", gl: "CN" },
    "zh-hant": { hl: "zh-TW", gl: "TW" },
    hi: { hl: "hi", gl: "IN" },
    ar: { hl: "ar", gl: "SA" },
    id: { hl: "id", gl: "ID" },
    ru: { hl: "ru", gl: "RU" },
    tr: { hl: "tr", gl: "TR" },
    vi: { hl: "vi", gl: "VN" },
    th: { hl: "th", gl: "TH" },
  };

  function normalizeLanguageTag(tag) {
    const normalized = String(tag || "").trim().replace(/_/g, "-").toLowerCase();
    if (!normalized) return "";
    if (/^zh-(tw|hk|mo|hant)/.test(normalized)) return "zh-hant";
    const primary = normalized.split("-")[0];
    return YOUTUBE_LOCALES[primary] ? primary : "";
  }

  function youtubeLocale() {
    const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
    for (const tag of [...languages, navigator.language]) {
      const code = normalizeLanguageTag(tag);
      if (code) return YOUTUBE_LOCALES[code];
    }
    return YOUTUBE_LOCALES.en;
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
    return [];
  }

  function youtubeVideoId() {
    return location.href.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/)?.[1] || "";
  }

  async function scanYouTubeInnertube() {
    const videoId = youtubeVideoId();
    if (!videoId) return;
    try {
      const clientVersion = "20.10.38";
      const locale = youtubeLocale();
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Youtube-Client-Name": "3",
          "X-Youtube-Client-Version": clientVersion,
        },
        referrer: `https://www.youtube.com/watch?v=${videoId}`,
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              hl: locale.hl,
              gl: locale.gl,
              clientName: "ANDROID",
              clientVersion,
              androidSdkVersion: 33,
              osName: "Android",
              osVersion: "13",
              platform: "MOBILE",
              utcOffsetMinutes: 0,
            },
          },
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const formats = data?.streamingData?.formats;
      if (!Array.isArray(formats)) return;
      const adaptive = data?.streamingData?.adaptiveFormats;
      const muxed360 =
        formats.find((f) => String(f?.itag) === "18" && f?.url) ||
        formats.find((f) => f?.url && f?.height <= 360 && f?.audioQuality);
      if (!muxed360?.url) return;
      const items = [{
        url: location.href,
        kind: "embed",
        source: "youtube-hd-local",
        label: "HD (local helper)",
        title: document.title,
        pageUrl: location.href,
      }, {
        url: muxed360.url,
        kind: "direct",
        source: "yt-innertube-android",
        label: muxed360.qualityLabel || "360p",
        title: document.title,
        pageUrl: location.href,
        referer: "https://www.youtube.com/",
      }];
      post(items);
    } catch {}
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

  const JAPANESE_BACKEND_PLATFORMS = [
    {
      label: "Niconico",
      host: /(?:^|\.)(?:nicovideo\.jp|nico\.ms|niconico\.com|nicochannel\.jp)$/i,
      path: /\/(?:watch|live|series|mylist|user|channel|channels|video|videos)\//i,
    },
    {
      label: "TVer",
      host: /(?:^|\.)(?:tver\.jp|tver\.co\.jp)$/i,
      path: /\/(?:episodes|series|lp|corner|live)\//i,
    },
    {
      label: "ABEMA",
      host: /(?:^|\.)(?:abema\.tv|abema\.io)$/i,
      path: /\/(?:video|now-on-air|channels)\//i,
    },
    {
      label: "NHK",
      host: /(?:^|\.)(?:nhk\.or\.jp|nhk\.jp)$/i,
      path: /\/(?:video|vod|ondemand|radio|school|archives|news\/html)\//i,
    },
    {
      label: "TwitCasting",
      host: /(?:^|\.)twitcasting\.tv$/i,
      path: /\/(?:[^/?#]+\/(?:movie|broadcaster|show|metastream)|[^/?#]+-[0-9]+|movie\/[0-9]+)/i,
    },
    {
      label: "FC2",
      host: /(?:^|\.)(?:video\.fc2\.com|live\.fc2\.com)$/i,
      path: /\/(?:content|a|en|ja|tw|cn|live|member|flv2)/i,
    },
    {
      label: "OpenREC",
      host: /(?:^|\.)openrec\.tv$/i,
      path: /\/(?:live|movie|capture)\//i,
    },
    {
      label: "TBS",
      host: /(?:^|\.)(?:cu\.tbs\.co\.jp|tbs\.co\.jp|tbs\.jp)$/i,
      path: /\/(?:episode|program|douga|tbs-free|free|movie|video)\//i,
    },
    {
      label: "FOD",
      host: /(?:^|\.)(?:fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|fujitv\.co\.jp)$/i,
      path: /\/(?:title|episode|video|ondemand|plus7)\//i,
    },
    {
      label: "Yahoo Japan",
      host: /(?:^|\.)(?:video\.yahoo\.co\.jp|news\.yahoo\.co\.jp)$/i,
      path: /\/(?:video|articles|pickup|feature)\//i,
    },
  ];

  function scanJapanesePlatforms() {
    const host = location.hostname;
    const path = location.pathname + "/";
    const match = JAPANESE_BACKEND_PLATFORMS.find((site) =>
      site.host.test(host) && site.path.test(path)
    );
    if (!match) return [];
    return [{
      url: location.href,
      pageUrl: location.href,
      kind: "embed",
      source: "japanese-page",
      label: match.label,
      backendRouted: true,
    }];
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
    out.push(...scanJapanesePlatforms());

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
  scanYouTubeInnertube();
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

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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "fcdl:get_page_html") return false;
    try {
      const html = document.documentElement?.outerHTML || "";
      sendResponse({ ok: true, pageHtml: html.slice(0, 1_500_000), url: location.href });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return false;
  });

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

  function cleanUrl(value) {
    const raw = decode(value);
    if (!raw || /^(?:data:|blob:|javascript:|mailto:|#)/i.test(raw)) return "";
    try {
      return new URL(raw, location.href).href;
    } catch {
      return "";
    }
  }

  function vimeoConfigUrlFromValue(value) {
    const cleaned = String(value || "").trim();
    if (!cleaned) return "";
    const raw = /^\d+$/.test(cleaned)
      ? `https://player.vimeo.com/video/${cleaned}`
      : cleanUrl(cleaned);
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      if (/^player\.vimeo\.com$/i.test(parsed.hostname)) {
        const match = parsed.pathname.match(/^\/video\/(\d+)(?:\/|$)/i);
        if (!match) return "";
        parsed.pathname = `/video/${match[1]}/config`;
        parsed.hash = "";
        return parsed.href;
      }
      if (!/^(?:www\.)?vimeo\.com$/i.test(parsed.hostname)) return "";
      const segments = parsed.pathname.split("/").filter(Boolean);
      let idIndex = -1;
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (/^\d+$/.test(segments[i])) {
          idIndex = i;
          break;
        }
      }
      if (idIndex < 0) return "";
      const config = new URL(`https://player.vimeo.com/video/${segments[idIndex]}/config`);
      parsed.searchParams.forEach((paramValue, key) => config.searchParams.append(key, paramValue));
      if (
        idIndex === 0 &&
        segments.length === 2 &&
        /^[a-z0-9]+$/i.test(segments[1]) &&
        !config.searchParams.has("h")
      ) {
        config.searchParams.set("h", segments[1]);
      }
      return config.href;
    } catch {
      return "";
    }
  }

  // ── Scanners ─────────────────────────────────────────────────────────────

  function scanIframes() {
    const found = [];
    document.querySelectorAll("iframe").forEach((el) => {
      const src = el.src ||
        el.getAttribute("data-src") ||
        el.getAttribute("data-lazy-src") ||
        el.getAttribute("data-consent-src") ||
        el.getAttribute("data-cmp-src") ||
        el.getAttribute("data-cookieconsent-src") ||
        el.getAttribute("data-delayed-src") ||
        "";
      if (isEmbed(src)) {
        found.push({ url: src, kind: "embed", source: "iframe" });
      }
    });
    return found;
  }

  function scanVimeoSdkEmbeds() {
    const found = [];
    const seen = new Set();
    const add = (value, source) => {
      const url = vimeoConfigUrlFromValue(value);
      if (!url || seen.has(url)) return;
      seen.add(url);
      found.push({
        url,
        kind: "direct",
        source,
        pageUrl: location.href,
        referer: location.href,
        label: "Vimeo player config",
      });
    };
    document.querySelectorAll("[data-vimeo-id], [data-vimeo-url]").forEach((el) => {
      add(el.getAttribute("data-vimeo-url") || el.getAttribute("data-vimeo-id"), "vimeo-data-attribute");
    });
    try {
      const html = document.documentElement.outerHTML.slice(0, 1_000_000)
        .replace(/\\u002F/gi, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\u003d/gi, "=")
        .replace(/\\\//g, "/");
      if (/Vimeo\.Player|player\.vimeo\.com|vimeo\.com\//i.test(html)) {
        const optionRe = /["']?(id|url)["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|(\d{4,}))/gi;
        let match;
        while ((match = optionRe.exec(html)) !== null && found.length < 20) {
          const key = match[1];
          const value = match[2] || match[3] || match[4] || "";
          if (key.toLowerCase() === "url" && !/vimeo\.com\//i.test(value)) continue;
          add(value, "vimeo-player-sdk");
        }
      }
    } catch {}
    return found;
  }

  function scanVideoTags() {
    const found = [];
    document.querySelectorAll("video, audio, video source, audio source").forEach((el) => {
      const src = el.currentSrc || el.src || el.getAttribute("src") || "";
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
      const mediaEl = el.closest?.("video,audio") || el;
      found.push({
        url: src,
        kind: src.includes(".m3u8") ? "hls" : src.includes(".mpd") ? "dash" : el.tagName === "AUDIO" ? "audio" : "direct",
        source: "video-tag",
        width: mediaEl.videoWidth || undefined,
        height: mediaEl.videoHeight || undefined,
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
      found.push({
        url: src,
        kind: "image",
        source: "image-tag",
        width: el.naturalWidth || undefined,
        height: el.naturalHeight || undefined,
      });
    });
    return found;
  }

  const XHS_GOOD_SCENES = ["WB_DFT", "WB_MK", "WB_PRV"];
  const XHS_MEDIA_MARKERS = [
    "sns-webpic",
    "sns-img-",
    "sns-video-",
    "ci.xiaohongshu.com",
    "xhscdn.com/spectrum/",
    "xhscdn.com/media/",
    "/notes_pre_post/",
    "/note_pre_post",
  ];

  function isXhsPage() {
    return /(?:^|\.)(?:xiaohongshu|rednote)\.com$/i.test(location.hostname);
  }

  function isXhsPostPage() {
    return isXhsPage() && /\/(?:explore|discovery\/item|item)\/[a-f0-9]{24}/i.test(location.pathname);
  }

  function isXhsMediaUrl(url) {
    const lower = decode(url).toLowerCase();
    if (!lower || /(?:sns-avatar|\/avatar\/|avatar|profile)/i.test(lower)) return false;
    return XHS_MEDIA_MARKERS.some((marker) => lower.includes(marker));
  }

  function xhsBestImageUrl(img) {
    const infoList = Array.isArray(img?.infoList) ? img.infoList : [];
    for (const scene of XHS_GOOD_SCENES) {
      const url = infoList.find((info) => info?.imageScene === scene)?.url;
      if (url && isXhsMediaUrl(url)) return decode(url);
    }
    for (const key of ["urlDefault", "url"]) {
      const url = img?.[key];
      if (url && isXhsMediaUrl(url)) return decode(url);
    }
    for (const info of infoList) {
      const url = info?.url;
      if (url && isXhsMediaUrl(url)) return decode(url);
    }
    return "";
  }

  function xhsStreamUrl(stream) {
    for (const codec of ["h264", "h265", "av1", "h264_hls"]) {
      const entries = Array.isArray(stream?.[codec]) ? stream[codec] : [stream?.[codec]];
      for (const entry of entries) {
        const url = entry?.masterUrl || entry?.master_url || entry?.backupUrls?.[0] || entry?.backup_urls?.[0];
        if (url && isXhsMediaUrl(url)) return decode(url);
      }
    }
    return "";
  }

  function scanXiaohongshu() {
    if (!isXhsPostPage()) return [];
    const found = [];
    const html = document.documentElement.outerHTML.slice(0, 1_500_000);
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*;?\s*<\/script>/);
    if (stateMatch) {
      try {
        const state = JSON.parse(stateMatch[1].replace(/undefined/g, "null"));
        const noteSection = state?.note || state?.noteDetail || state?.noteData || {};
        const noteDetailMap = noteSection.noteDetailMap || {};
        const noteId = location.pathname.match(/\/(?:explore|discovery\/item|item)\/([a-f0-9]{24})/i)?.[1]
          || noteSection.currentNoteId
          || Object.keys(noteDetailMap)[0];
        const entry = noteDetailMap[noteId] || {};
        const note = entry.note || entry;
        if (note?.video?.media?.stream) {
          const videoUrl = xhsStreamUrl(note.video.media.stream);
          if (videoUrl) {
            found.push({
              url: videoUrl,
              kind: videoUrl.includes(".m3u8") ? "hls" : "direct",
              source: "xhs-state",
              pageUrl: location.href,
              referer: location.href,
              label: "Xiaohongshu Video",
            });
          }
        }
        if (Array.isArray(note?.imageList)) {
          const seen = new Set(found.map((item) => item.url.replace(/\?.*$/, "")));
          for (const img of note.imageList) {
            const url = xhsBestImageUrl(img);
            const key = url.replace(/\?.*$/, "");
            if (!url || seen.has(key)) continue;
            seen.add(key);
            found.push({
              url,
              kind: "image",
              source: "xhs-state",
              pageUrl: location.href,
              referer: location.href,
              label: "Xiaohongshu Image",
            });
          }
        }
      } catch {}
    }
    if (found.length) return found;
    return [{
      url: location.href,
      pageUrl: location.href,
      kind: "embed",
      source: "xhs-page",
      label: "Xiaohongshu",
      backendRouted: true,
    }];
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
        if (isXhsPage() && !isXhsMediaUrl(u)) return;
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
      // General JSON image/media key names (note.com, trilltrill, API responses)
      [/"(?:article_photo_link|image_url|photo_url|src_url|original_url|cover_url|thumbnail_url|download_url|media_url|play_url|stream_url)"\s*:\s*"(https?:\\?\/\\?\/[^"]{10,})"/gi, "image"],
      [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|cdninstagram\.com|fbcdn\.net|threadscdn\.com|vod\.pstatic\.net)[^"'\\<>\s]*\.(?:mp4|m3u8)[^"'\\<>\s]*)/g, "direct"],
      [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:cdninstagram\.com|fbcdn\.net|threadscdn\.com|pinimg\.com|weibocdn\.com|sinaimg\.cn|xhscdn\.com|media\.trilltrill\.jp|obs\.line-scdn\.net|fashionsnap-assets\.com|i\.gyazo\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp|gif|avif|heic)[^"'\\<>\s]*)/g, "image"],
      [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|weibocdn\.com|xhscdn\.com)[^"'\\<>\s]*\.(?:mp4|m3u8|mov)[^"'\\<>\s]*)/g, "direct"],
    ];
    for (const [re, kind] of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        const url = decode(m[1]);
        if (isXhsPage() && !isXhsMediaUrl(url)) continue;
        found.push({ url, kind, source: "meta-json" });
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
        width: muxed360.width,
        height: muxed360.height,
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
    // mapp.api.weibo.cn is a mobile share/redirect URL — skip the post-path
    // check and hand it straight to the backend; yt-dlp follows the redirect.
    if (/mapp\.api\.weibo\.cn/i.test(location.hostname)) {
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
    if (!/(?:\/(?:status|detail)\/[A-Za-z0-9]+|\/(?:\d+|0)\/[A-Za-z0-9]+|\/tv\/show\/|video\.weibo\.com\/show)/i.test(location.href)) return found;
    try {
      const html = document.documentElement.outerHTML.slice(0, 1_500_000);
      const seen = new Set();
      const imageRe = /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:sinaimg\.cn|weibocdn\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp|gif|heic)[^"'\\<>\s]*)/gi;
      let m;
      while ((m = imageRe.exec(html)) !== null && found.length < 40) {
        let url = decode(m[1]).replace(/^http:\/\//i, "https://");
        url = url.replace(/\/\/([^/]+\.sinaimg\.cn)\/(?:thumb\d+|thumbnail|square|orj\d+|mw\d+|bmiddle|large)\//i, "//$1/original/");
        const lowered = url.toLowerCase();
        if (/(?:avatar|profile|icon|emoji|face|card)/i.test(lowered)) continue;
        const key = url.replace(/\?.*$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          url,
          kind: "image",
          source: "weibo-page",
          pageUrl: location.href,
          referer: location.href,
          label: "Weibo Image",
        });
      }
      if (found.length) return found;
    } catch {}
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

  function scanBilibiliDynamic() {
    if (!/(?:^|\.)(?:t\.bilibili\.com|bilibili\.com)$/i.test(location.hostname)) return [];
    if (!/(?:\/\d{10,}|\/opus\/\d+|\/read\/cv\d+)/i.test(location.pathname)) return [];
    const found = [{
      url: location.href,
      pageUrl: location.href,
      kind: "embed",
      source: "bilibili-dynamic-page",
      label: "Bilibili post",
      backendRouted: true,
    }];
    try {
      const html = document.documentElement.outerHTML.slice(0, 1_000_000);
      const patterns = [
        [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:bilivideo\.(?:com|cn)|hdslb\.com)[^"'\\<>\s]*\.(?:m4s|mp4|m3u8|mpd)[^"'\\<>\s]*)/g, "direct"],
        [/(https?:\\?\/\\?\/[^"'\\<>\s]*(?:i\d?\.hdslb\.com|biliimg\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp)[^"'\\<>\s]*)/g, "image"],
      ];
      for (const [re, kind] of patterns) {
        let m;
        while ((m = re.exec(html)) !== null && found.length < 8) {
          found.push({
            url: decode(m[1]),
            kind,
            source: "bilibili-dynamic-page",
            pageUrl: location.href,
            referer: location.href,
          });
        }
      }
    } catch {}
    return found;
  }

  // ── Reddit ────────────────────────────────────────────────────────────────
  // Fetch the Reddit JSON API directly from the browser context so the request
  // comes from the user's IP (not the server's datacenter IP, which Reddit
  // blocks). Handles videos, gallery posts, and single-image posts.
  async function scanRedditAsync() {
    if (!/(?:^|\.)reddit\.com$/i.test(location.hostname)) return;
    const postMatch = location.pathname.match(/\/r\/[^/]+\/comments\/([A-Za-z0-9]+)/i);
    if (!postMatch) return;
    try {
      const jsonUrl = `https://www.reddit.com/comments/${postMatch[1]}.json?limit=1&raw_json=1`;
      const res = await fetch(jsonUrl, { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = await res.json();
      const p = data[0]?.data?.children?.[0]?.data;
      if (!p) return;
      const items = [];

      if (p.secure_media?.reddit_video?.fallback_url) {
        items.push({
          url: p.secure_media.reddit_video.fallback_url,
          kind: p.secure_media.reddit_video.hls_url ? "hls" : "direct",
          source: "reddit-json",
          label: "Reddit Video",
          pageUrl: location.href,
          width: p.secure_media.reddit_video.width,
          height: p.secure_media.reddit_video.height,
        });
        if (p.secure_media.reddit_video.hls_url) {
          items[0].url = p.secure_media.reddit_video.hls_url;
        }
      }

      if (p.is_gallery && p.media_metadata) {
        const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
        const order = Array.isArray(p.gallery_data?.items)
          ? p.gallery_data.items
          : Object.keys(p.media_metadata).map((id) => ({ media_id: id }));
        for (const { media_id } of order) {
          const meta = p.media_metadata[media_id];
          if (!meta || meta.status !== "valid") continue;
          const ext = EXT[meta.m] || "jpg";
          items.push({
            url: `https://i.redd.it/${media_id}.${ext}`,
            kind: "image",
            source: "reddit-json",
            label: "Reddit Image",
            pageUrl: location.href,
            width: meta.s?.x,
            height: meta.s?.y,
          });
        }
      }

      if (!items.length && p.url) {
        const u = p.url;
        if (/(?:^|\.)i\.redd\.it\//i.test(u) || /\.(jpe?g|png|gif|webp)(?:[?#]|$)/i.test(u)) {
          items.push({ url: u, kind: "image", source: "reddit-json", label: "Reddit Image", pageUrl: location.href });
        }
      }

      if (items.length) post(items);
    } catch {}
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
    {
      label: "DMM/FANZA",
      host: /(?:^|\.)(?:dmm\.co\.jp|dmm\.com|fanza\.jp)$/i,
      path: /\/(?:mono|digital|monthly|video|age_check|-)(?:\/|$)/i,
    },
    {
      label: "Japanese SVOD",
      host: /(?:^|\.)(?:lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp)$/i,
      path: /\/(?:watch|video|vod|content|contents|title|program|episode|episodes|view|play|player|live|ondemand|anime|store)\//i,
    },
    {
      label: "Japanese catch-up",
      host: /(?:^|\.)(?:locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp)$/i,
      path: /\/(?:watch|video|vod|douga|mydo|catchup|content|contents|title|program|episode|episodes|view|play|player|live|movie)\//i,
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

  // Article / image gallery sites — creates a backendRouted item so the popup
  // always shows a download option even when the image URL isn't directly
  // detectable from HTML (the server extractor handles the full extraction).
  const ARTICLE_GALLERY_HOST_RE = /(?:^|\.)(?:trilltrill\.jp|note\.com|lineblog\.me|hatenablog\.(?:com|jp)|hatenadiary\.(?:com|jp)|hatena\.ne\.jp|blog\.fc2\.com|gyazo\.com|streamable\.com|redgifs\.com)$/i;
  const ARTICLE_GALLERY_PATH_RE = /\/(?:articles?|posts?|n\/[a-z0-9_-]+|[a-z0-9_-]{5,}\/archives?|watch\/|gifs?\/)|\d{5,}/i;

  function scanArticleGalleries() {
    const host = location.hostname;
    const path = location.pathname;
    if (!ARTICLE_GALLERY_HOST_RE.test(host)) return [];
    if (!ARTICLE_GALLERY_PATH_RE.test(path)) return [];
    return [{
      url: location.href,
      pageUrl: location.href,
      kind: "embed",
      source: "article-gallery",
      label: host.replace(/^(?:www|m)\./, ""),
      backendRouted: true,
    }];
  }

  function scanNaverFeedLinks() {
    if (!/(?:^|\.)(?:m\.entertain\.naver\.com|entertain\.naver\.com|m\.sports\.naver\.com|sports\.news\.naver\.com)$/i.test(location.hostname)) {
      return [];
    }
    const urls = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") || "";
      let url = "";
      try { url = new URL(href, location.href).href; } catch { continue; }
      if (!/(?:n\.news|m\.news|news|m\.entertain|entertain|m\.sports|sports\.news)\.naver\.com\/.*(?:article|mnews\/article|sports\/index|entertain\/article)/i.test(url)) {
        continue;
      }
      if (!urls.includes(url)) urls.push(url);
      if (urls.length >= 5) break;
    }
    return urls.map((url) => ({
      url,
      pageUrl: url,
      kind: "embed",
      source: "naver-feed-link",
      label: "Naver article",
      backendRouted: true,
    }));
  }

  // ── Run all scans ────────────────────────────────────────────────────────

  // Image scanning is only useful on hosts where photo downloads are the
  // user's likely intent (Meta carousels, Pinterest pins, Reddit galleries,
  // X/Twitter image posts). On every OTHER site — especially YouTube,
  // Bilibili, news sites — running it pollutes the popup with thumbnails of
  // recommended videos, channel avatars, og:image cards, and ad creatives.
  const IMAGE_HOSTS = /(?:^|\.)(instagram\.com|threads\.com|threads\.net|pinterest\.|reddit\.com|redd\.it|twitter\.com|x\.com|facebook\.com|tumblr\.com|xiaohongshu\.com|rednote\.com)$/i;
  function shouldScanImages() {
    try { return IMAGE_HOSTS.test(location.hostname); } catch { return false; }
  }

  function scanAll() {
    const out = [];
    // On XHS / rednote pages, trust ONLY the XHS-specific extractor. The
    // generic scanners (image tags, og:image meta) otherwise pick up
    // sidebar avatars and recommended-note thumbnails, especially when the
    // user is not logged in and the page falls back to a profile view.
    if (isXhsPage()) {
      return scanXiaohongshu();
    }
    out.push(...scanIframes());
    out.push(...scanVimeoSdkEmbeds());
    out.push(...scanVideoTags());
    if (shouldScanImages()) out.push(...scanImageTags());
    out.push(...scanMetaTags());
    out.push(...scanYouTube());
    out.push(...scanBilibili());
    out.push(...scanBilibiliDynamic());
    out.push(...scanWeibo());
    out.push(...scanJapanesePlatforms());
    out.push(...scanArticleGalleries());
    out.push(...scanNaverFeedLinks());

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
  scanRedditAsync();
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

/**
 * Injected into every frame (main + iframes) before page JS runs.
 *
 * Detection layers:
 *  1. BRIDGE_READY ping
 *  2. SPA navigation hooks (pushState / replaceState / popstate)
 *  3. PerformanceObserver — catches every resource including native <video>
 *  4. fetch hook — intercepts JS fetch + response body + blob lineage
 *  5. XHR hook  — intercepts XHR + response body
 *  6. HTMLMediaElement src / currentSrc setters (blob URL resolved via lineage)
 *  7. MediaSource / URL.createObjectURL (MSE_ACTIVE + blob lineage WeakMap)
 *  8. SourceBuffer.appendBuffer hook (active playback confirmation)
 *  9. hls.js / JW Player / Video.js / Shaka / Dash.js SDK hooks
 * 10. MutationObserver for dynamically added <video>/<source>
 * 11. Page-global data scan (__NEXT_DATA__, ytInitialData, TikTok, Bilibili, etc.)
 * 12. Periodic currentSrc poll
 * 13. window.__fcdownloader_scan() — deep on-demand scan
 */
export const INJECTED_SCRIPT = `
(function () {
  'use strict';
  if (window.__rn_fcd) return;
  window.__rn_fcd = true;

  var SEEN = new Set();

  // ── Bridge helper ─────────────────────────────────────────────
  function post(obj) {
    var msg = JSON.stringify(obj);
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(msg);
      } else if (window !== window.top) {
        window.parent.postMessage({ __fcd_relay: true, payload: msg }, '*');
      }
    } catch (_) {}
  }

  // Relay listener (main frame only)
  if (window === window.top) {
    window.addEventListener('message', function (e) {
      try {
        if (e.data && e.data.__fcd_relay && window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(e.data.payload);
        }
      } catch (_) {}
    });
  }

  post({ event: 'BRIDGE_READY', timestamp: Date.now() });

  // ── Blob URL lineage tracking ─────────────────────────────────
  // WeakMap: Response  → original fetch URL
  // WeakMap: Blob      → original fetch URL
  // Map:     blobUrl   → { url, mime }
  var _blobLineageResp = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var _blobLineageBlob = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var _blobUrlMap      = new Map();
  // Ring buffer of recently-fetched HLS/DASH manifest URLs.  Capped at 8 to
  // bound memory.  Populated by the fetch/XHR body scanners so that when
  // appendBuffer fires (confirming MSE playback) we can surface the manifest.
  var _recentManifests = [];

  // ── Type detection ────────────────────────────────────────────
  function detectType(url, mime) {
    if (!url) return null;
    var u = url.split('?')[0].toLowerCase();
    if (/vimeocdn\\.com.*\\/playlist\\.json$/i.test(u) || /player\\.vimeo\\.com\\/video\\/\\d+\\/config$/i.test(u)) return 'direct';
    if (/\\.m3u8?(?:$|[?#])/.test(u)) return 'hls';
    if (u.indexOf('.mpd')  !== -1) return 'dash';
    if (/\\.(ts|m4s|aac|m4a)$/.test(u)) return null;
    if (/\\.(vtt|webvtt|srt|sub|sbv|ttml|dfxp|ass|ssa)$/.test(u)) return 'direct';
    if (/\\.(mp4|webm|mov|avi|m4v|jpe?g|png|webp|gif|avif|heic|mp3|wav|ogg|opus|flac)$/.test(u)) return 'direct';
    if (mime) {
      var m = String(mime).toLowerCase();
      if (m.indexOf('mpegurl') !== -1 || m.indexOf('m3u8') !== -1) return 'hls';
      if (m.indexOf('dash') !== -1  || m.indexOf('mpd')  !== -1) return 'dash';
      if (m.indexOf('mp4')  !== -1  || m.indexOf('video/') !== -1 || m.indexOf('image/') !== -1 || m.indexOf('audio/') !== -1) return 'direct';
    }
    // Known video CDN domains that serve media without file extensions
    if (/\\bvideo\\.twimg\\.com\\//.test(url))                      return 'hls';
    if (/\\btiktokcdn\\.com\\//.test(url))                          return 'hls';
    if (/\\btiktokcdn-us\\.com\\//.test(url))                       return 'hls';
    if (/\\bv\\d+-webapp\\.tiktok\\.com\\//.test(url))             return 'hls';
    if (/\\btiktok\\.com\\/video\\//.test(url))                     return 'hls';
    if (/\\bcdninstagram\\.com\\//.test(url))                       return 'direct';
    if (/\\bscontent[-\\w]*\\.cdninstagram\\.com\\//.test(url))    return 'direct';
    if (/\\binstagram\\.com\\/.*\\bvideo\\b/.test(url))             return 'direct';
    if (/\\bv\\.redd\\.it\\//.test(url))                            return 'hls';
    if (/\\bfbcdn\\.net\\/.*\\bvideo/.test(url))                    return 'hls';
    if (/\\bvod\\.pstatic\\.net\\//.test(url))                      return 'hls';
    if (/\\bfbcdn\\.net\\/.*\\.mp4/.test(url))                      return 'direct';
    if (/\\bdailymotion\\.com\\/cdn/.test(url))                     return 'hls';
    if (/\\bdmcdn\\.net\\//.test(url))                              return 'hls';
    if (/\\bgooglevideo\\.com\\/videoplayback/.test(url))           return 'hls';
    if (/\\bmanifest\\.googlevideo\\.com\\/api\\/manifest\\/dash/.test(url)) return 'dash';
    if (/\\bpinimg\\.com\\/videos\\//.test(url))                    return 'hls';
    if (/\\busher\\.twitch\\.tv\\//.test(url))                      return 'hls';
    if (/\\bbilivideo\\.com\\//.test(url))                          return 'direct';
    if (/\\bweibocdn\\.com\\//.test(url))                            return 'direct';
    if (/\\bxhscdn\\.com\\//.test(url))                              return 'direct';
    // Generic path heuristics
    if (/\\/(master|playlist|manifest|stream|hls|dash)(\\.|\\?|\\/|$)/i.test(url) &&
        !/\\.(html?|js|css|woff|png|jpe?g|gif|svg)(\\?|$)/i.test(url)) return 'hls';
    return null;
  }

  function detectKind(url, mime) {
    var u = String(url || '').split('?')[0].toLowerCase();
    var m = String(mime || '').toLowerCase();
    if (m.indexOf('image/') === 0 || /\\.(jpe?g|png|webp|gif|avif|heic)$/.test(u)) return 'image';
    if (m.indexOf('audio/') === 0 || /\\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(u)) return 'audio';
    if (m.indexOf('text/vtt') !== -1 || (m.indexOf('text/plain') !== -1 && m.indexOf('vtt') !== -1) ||
        m.indexOf('application/x-subrip') !== -1 || m.indexOf('text/x-ssa') !== -1 ||
        /\\.(vtt|webvtt|srt|sub|sbv|ttml|dfxp|ass|ssa)$/.test(u)) return 'subtitle';
    return 'video';
  }

  // Post a subtitle URL directly (bypasses emit's detectType() null-filter).
  var SUBTITLE_SEEN = new Set();
  function emitSubtitle(url, mime, provenance) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!url.startsWith('http') || SUBTITLE_SEEN.has(url)) return;
    SUBTITLE_SEEN.add(url);
    post({
      event: 'MEDIA_DETECTED', url: url, pageUrl: location.href,
      userAgent: navigator.userAgent, mimeType: mime || null,
      mediaType: 'direct', mediaKind: 'subtitle', timestamp: Date.now(),
      provenance: provenance || 'fetch-hook', confidence: 0.82,
    });
  }

  function isSkippableImage(url) {
    var u = String(url || '').toLowerCase();
    return /(?:favicon|apple-touch-icon|sprite|logo|placeholder|blank|pixel|tracking|tracker|beacon|counter|spacer|button|banner|ads?)/.test(u) ||
      /\\/(?:icons?|assets?)\\//.test(u) && !/(?:cdninstagram|fbcdn|threadscdn|pinimg|sinaimg|xhscdn|pstatic)/.test(u);
  }

  function srcsetUrls(value) {
    if (!value || typeof value !== 'string') return [];
    return value.split(',').map(function (part) {
      return part.trim().split(/\\s+/)[0];
    }).filter(Boolean);
  }

  // Recursively collects matches through open shadow roots, since
  // root.querySelectorAll() never pierces shadow DOM boundaries — needed for
  // shadow roots that already existed before this script ran (the attachShadow
  // hook below only observes shadow roots created after injection).
  function deepQuerySelectorAll(root, selector) {
    var results = [];
    try {
      root.querySelectorAll(selector).forEach(function (el) { results.push(el); });
    } catch (_) {}
    try {
      root.querySelectorAll('*').forEach(function (el) {
        if (el.shadowRoot) results = results.concat(deepQuerySelectorAll(el.shadowRoot, selector));
      });
    } catch (_) {}
    return results;
  }

  function enableInlinePlayback(el) {
    try {
      if (!el || String(el.tagName || '').toUpperCase() !== 'VIDEO') return;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.playsInline = true;
      el.webkitPlaysInline = true;
    } catch (_) {}
  }

  try {
    var _origCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function (name, options) {
      var el = arguments.length > 1
        ? _origCreateElement.call(this, name, options)
        : _origCreateElement.call(this, name);
      if (String(name || '').toLowerCase() === 'video') enableInlinePlayback(el);
      return el;
    };
  } catch (_) {}

  function emitElementMedia(el) {
    if (!el) return;
    var tag = String(el.tagName || '').toUpperCase();
    enableInlinePlayback(el);
    if (tag === 'TRACK') {
      var trackKind = String((el.getAttribute && el.getAttribute('kind')) || el.kind || '').toLowerCase();
      if (/^(?:subtitles|captions|descriptions?)$/.test(trackKind)) {
        var trackSrc = (el.getAttribute && el.getAttribute('src')) || el.src || '';
        if (trackSrc) emitSubtitle(trackSrc, null, 'media-element');
      }
      return;
    }
    if (tag === 'IMG' && Math.max(el.naturalWidth || 0, el.naturalHeight || 0) < 160) return;
    var type = el.type || null;
    var urls = [
      el.currentSrc,
      el.src,
      el.getAttribute && el.getAttribute('src'),
      el.getAttribute && el.getAttribute('data-src'),
      el.getAttribute && el.getAttribute('data-original'),
      el.getAttribute && el.getAttribute('data-lazy-src'),
      el.getAttribute && el.getAttribute('data-url'),
      el.getAttribute && el.getAttribute('data-image'),
      el.getAttribute && el.getAttribute('data-img'),
    ].filter(Boolean);
    if (el.srcset) urls = urls.concat(srcsetUrls(el.srcset));
    if (el.getAttribute) {
      urls = urls.concat(srcsetUrls(el.getAttribute('srcset')));
      urls = urls.concat(srcsetUrls(el.getAttribute('data-srcset')));
    }
    urls.forEach(function (url) { emit(url, type); log(url); });
  }

  function scanBackgroundImages(root) {
    try {
      (root || document).querySelectorAll('[style]').forEach(function (el) {
        var style = el.getAttribute('style') || '';
        var re = /url\\((['"]?)(https?:\\/\\/[^'")]+)\\1\\)/gi;
        var m;
        while ((m = re.exec(style))) {
          emit(m[2], null, 'mutation-observer', 0.45);
          log(m[2]);
        }
      });
    } catch (_) {}
  }

  function isNonContentUrl(url, mime) {
    var u = String(url || '').toLowerCase();
    var m = String(mime || '').toLowerCase();
    if (/(?:vimeocdn\.com.*\/playlist\.json|player\.vimeo\.com\/video\/\d+\/config)(?:[?#]|$)/i.test(u)) return false;
    if (/\\.(?:html?|php|aspx?)(?:[?#]|$)/i.test(u)) return true;
    if (m.indexOf('text/html') !== -1 || m.indexOf('application/xhtml') !== -1 || m.indexOf('application/json') !== -1) return true;
    if (/(?:doubleclick|googlesyndication|google-analytics|analytics|adservice|scorecardresearch|outbrain|taboola|treasuredata|bidswitch)/i.test(u)) return true;
    if (/(?:^|[\\/_.-])(?:ad|ads|banner|beacon|tracking|tracker|counter|spacer|sprite|logo|icon|button|common|header|footer|gnb|nav|placeholder|blank|pixel)(?:[\\/_.-]|$)/i.test(u)) return true;
    if (/\\.gif(?:[?#]|$)/i.test(u) && !/(?:article|photo|gallery|image|upimg|contents|media|original|large)/i.test(u)) return true;
    return false;
  }

  var LOG_SEEN = new Set();
  var LOG_META_SEEN = new Set();
  var SKIP_EXT = /\\.(svg|ico|woff2?|ttf|eot|otf|css|js|map)(\\?|$)/i;

  // Assign a confidence score based on URL/mime heuristics
  function confForUrl(url, mime, base) {
    if (!base) base = 0.5;
    if (!url) return base;
    var u = url.toLowerCase();
    if (/\\.m3u8?(?:\\?|$)/.test(u) || /mpegurl/i.test(mime || '')) return Math.max(base, 0.85);
    if (/\\.mpd(\\?|$)/.test(u) || /dash\\+xml/i.test(mime || '')) return Math.max(base, 0.85);
    if (/\\.mp4(\\?|$)/.test(u)) return Math.max(base, 0.75);
    if (/vimeocdn\\.com.*playlist\\.json/.test(u) || /player\\.vimeo\\.com\\/video\\/\\d+\\/config/.test(u)) return Math.max(base, 0.88);
    if (/googlevideo\\.com\\/videoplayback/.test(u)) return Math.max(base, 0.9);
    if (/bilivideo\\.com\\//.test(u)) return Math.max(base, 0.88);
    if (/manifest\\.googlevideo\\.com/.test(u)) return Math.max(base, 0.95);
    return base;
  }

  function emit(url, mime, provenance, confidence) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.length < 8) return;
    try { url = new URL(url, location.href).href; } catch (_) {}
    if (isNonContentUrl(url, mime)) return;
    var type = detectType(url, mime);
    if (!type) return;
    if (detectKind(url, mime) === 'image' && isSkippableImage(url)) return;
    // Allow re-emit when a concrete mime type arrives for an already-seen URL:
    // the first emit uses URL heuristics (may be wrong); the body-read emit
    // has the real Content-Type and should correct the mediaType on the app side.
    if (SEEN.has(url) && !mime) return;
    SEEN.add(url);
    var conf = confForUrl(url, mime, typeof confidence === 'number' ? confidence : 0.5);
    post({ event: 'MEDIA_DETECTED', url: url, pageUrl: location.href,
           userAgent: navigator.userAgent, mimeType: mime || null,
           mediaType: type, mediaKind: detectKind(url, mime), timestamp: Date.now(),
           provenance: provenance || 'perf-observer',
           confidence: conf });
  }

  function log(url, meta) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.length < 12) return;
    try { url = new URL(url, location.href).href; } catch (_) {}
    if (SKIP_EXT.test(url.split('?')[0]) && !/\\.(jpe?g|png|webp|gif|avif|heic)(\\?|$)/i.test(url)) return;
    meta = meta || {};
    var hasMeta = !!(meta.mimeType || meta.status || meta.contentLength || meta.transferSize || meta.encodedBodySize || meta.provenance || meta.initiatorType);
    if (hasMeta) {
      if (LOG_META_SEEN.has(url)) return;
      LOG_META_SEEN.add(url);
    } else {
      if (LOG_SEEN.has(url)) return;
      LOG_SEEN.add(url);
    }
    post({
      event: 'URL_CAPTURED',
      url: url,
      pageUrl: location.href,
      timestamp: Date.now(),
      method: meta.method || undefined,
      status: typeof meta.status === 'number' ? meta.status : undefined,
      mimeType: meta.mimeType || undefined,
      contentLength: typeof meta.contentLength === 'number' ? meta.contentLength : undefined,
      transferSize: typeof meta.transferSize === 'number' ? meta.transferSize : undefined,
      encodedBodySize: typeof meta.encodedBodySize === 'number' ? meta.encodedBodySize : undefined,
      provenance: meta.provenance || undefined,
      initiatorType: meta.initiatorType || undefined
    });
  }

  function logPerformanceEntry(e) {
    if (!e || !e.name) return;
    log(e.name, {
      provenance: 'perf-observer',
      initiatorType: e.initiatorType || undefined,
      transferSize: typeof e.transferSize === 'number' ? e.transferSize : undefined,
      encodedBodySize: typeof e.encodedBodySize === 'number' ? e.encodedBodySize : undefined
    });
  }

  // ── Text scanning (JSON response bodies, page globals) ────────
  function scanText(text) {
    if (!text || typeof text !== 'string' || text.length < 10) return;
    var variants = [
      text,
      text.replace(/\\\\/g, '/').replace(/\\\\u0026/g, '&').replace(/\\\\u003d/g, '=')
           .replace(/\\\\u002F/gi, '/'),
    ];
    var extRe = /https?:\\/\\/[^"'\\\\\\s<>]{4,}?\\.(m3u8?|mpd|mp4|webm|mov|m4v|jpe?g|png|webp|gif|avif|heic|mp3|m4a|aac|wav|ogg|opus|flac)[^"'\\\\\\s<>]*/gi;
    var cdnRe = /https?:\\/\\/[^"'\\\\\\s<>]*(?:(?:[a-z0-9-]+\\.)*streaks\\.jp|i\\.fod\\.fujitv\\.co\\.jp|fod-sp\\.fujitv\\.co\\.jp|free\\.tbs\\.co\\.jp|dmm\\.co\\.jp|dmm\\.com|fanza\\.jp|lemino\\.docomo\\.ne\\.jp|animestore\\.docomo\\.ne\\.jp|video\\.dmkt-sp\\.jp|unext\\.jp|video\\.unext\\.jp|hulu\\.jp|telasa\\.jp|plus\\.nhk\\.jp|nhk-ondemand\\.jp|wowow\\.co\\.jp|wod\\.wowow\\.co\\.jp|b-ch\\.com|bandainamcoid\\.com|tv\\.rakuten\\.co\\.jp|jod\\.jsports\\.co\\.jp|jsports\\.co\\.jp|spoox\\.skyperfectv\\.co\\.jp|skyperfectv\\.co\\.jp|locipo\\.jp|dougaizm\\.mbs\\.jp|mbs\\.jp|ytv\\.co\\.jp|video\\.tv-tokyo\\.co\\.jp|douga\\.tv-asahi\\.co\\.jp|ktv-smart\\.jp|ktv\\.jp|vod\\.ntv\\.co\\.jp|cu\\.ntv\\.co\\.jp|video\\.twimg\\.com|tiktokcdn\\.com|tiktokcdn-us\\.com|v\\d+-webapp\\.tiktok\\.com|cdninstagram\\.com|scontent[-\\w]*\\.cdninstagram\\.com|v\\.redd\\.it|fbcdn\\.net|threadscdn\\.com|vimeocdn\\.com\\/video|googlevideo\\.com\\/videoplayback|pinimg\\.com\\/(?:videos|originals|736x|1200x|564x)|dmcdn\\.net|usher\\.twitch\\.tv|bilivideo\\.com|weibocdn\\.com|xhscdn\\.com|vod\\.pstatic\\.net)[^"'\\\\\\s<>]{4,}/gi;
    variants.forEach(function (body) {
      var m;
      extRe.lastIndex = 0;
      while ((m = extRe.exec(body))) {
        var u = m[0].replace(/&amp;/g, '&');
        try { u = decodeURIComponent(u); } catch (_) {}
        emit(u, null); log(u);
      }
      cdnRe.lastIndex = 0;
      while ((m = cdnRe.exec(body))) {
        var u2 = m[0].replace(/&amp;/g, '&');
        try { u2 = decodeURIComponent(u2); } catch (_) {}
        emit(u2, null); log(u2);
      }
    });
  }

  // ── SPA navigation hooks ──────────────────────────────────────
  // Intercept pushState / replaceState so we know when a SPA navigates
  // without a full page reload (YouTube, TikTok, Twitter, etc.)
  (function () {
    function wrapHistory(method) {
      var orig = history[method];
      if (!orig) return;
      history[method] = function () {
        var ret = orig.apply(this, arguments);
        try {
          var newUrl = String(arguments[2] || location.href);
          if (newUrl && newUrl !== location.href) {
            // Clear the manifest ring buffer so MSE events from the previous
            // route don't leak into the new one in SPA navigation flows.
            _recentManifests.length = 0;
            post({ event: 'PAGE_NAVIGATE', url: newUrl, timestamp: Date.now() });
          }
        } catch (_) {}
        return ret;
      };
    }
    try { wrapHistory('pushState'); } catch (_) {}
    try { wrapHistory('replaceState'); } catch (_) {}
    window.addEventListener('popstate', function () {
      try {
        _recentManifests.length = 0;
        post({ event: 'PAGE_NAVIGATE', url: location.href, timestamp: Date.now() });
      } catch (_) {}
    });
  })();

  // ── Page-global data scan ─────────────────────────────────────
  function scanGlobals() {
    [
      '__NEXT_DATA__',
      'ytInitialData',
      'ytInitialPlayerResponse',
      '__INIT_PROPS__',
      'PAGE_CONTEXT_DATA',
      '__universal_data__',
      '__DEFAULT_SCOPE__',
      '__NUXT__',
      '__staticRouterHydrationData',
      '__INITIAL_STATE__',
      '__APP_INITIAL_STATE__',
      '__PRELOADED_STATE__',
      '__SERVER_DATA__',
      '__APP_STATE__',
      '__STORE__',
      'videoPlayerData',
      'playerConfig',
      'pageData',
      'videoData',
      'appConfig',
      'siteConfig',
      'pageConfig',
      'initialProps',
      '__APP_CONFIG__',
      '__SITE_CONFIG__',
      '__PAGE_CONFIG__',
      '__PAGE_DATA__',
      '__INITIAL_PROPS__',
      '__BC_PLAYER_CONFIG__',
      'wp_playlist',
      'BCL',
      'PLAYER_CONFIG',
      'VIDEO_CONFIG',
      'MEDIA_CONFIG',
      'STREAM_CONFIG',
      '__MEDIA_DATA__',
      '__VIDEO_DATA__',
      '__STREAM_DATA__',
      '__PLAYER_CONFIG__',
      'playerSetup',
      'videoSetup',
      'mediaPlayerConfig',
      'jwConfig',
      'jwDefaults',
      'WP_VIDEO_DATA',
    ].forEach(function (key) {
      try {
        if (window[key]) scanText(JSON.stringify(window[key]));
      } catch (_) {}
    });

    // Google Tag Manager dataLayer — many sites push video events here with URLs
    try {
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.forEach(function (item) {
          if (!item || typeof item !== 'object') return;
          try { scanText(JSON.stringify(item)); } catch (_) {}
        });
      }
    } catch (_) {}

    // Facebook video data
    try {
      if (window.require && window.require.entries) {
        scanText(JSON.stringify(window.require.entries));
      }
    } catch (_) {}

    // YouTube — extract all usable stream sources from ytInitialPlayerResponse.
    // Priority:
    //  1. Muxed progressive MP4 with direct URL (audio+video, no DRM, direct download)
    //  2. DASH manifest (separate video+audio tracks, routes to dashDownloader)
    //  3. HLS manifest — skip on iOS because YouTube serves FairPlay HLS to Safari UAs;
    //     on desktop/Android UAs the HLS uses standard AES-128 (handled by hlsDownloader)
    try {
      var ytpr = window.ytInitialPlayerResponse;
      if (!ytpr && window.ytplayer && window.ytplayer.config) {
        var raw = window.ytplayer.config.args && window.ytplayer.config.args.player_response;
        if (typeof raw === 'string') try { ytpr = JSON.parse(raw); } catch(_2) {}
      }
      if (ytpr && ytpr.streamingData) {
        var sd2 = ytpr.streamingData;
        var isIOSua = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        var ytEmitted = false;

        // 1. Muxed progressive — only if URL is directly available (no signatureCipher)
        var fmts2 = (sd2.formats || []).filter(function(f) {
          return f && f.url && f.mimeType && f.mimeType.indexOf('video/') === 0;
        }).sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
        if (fmts2.length > 0) {
          emit(fmts2[0].url, fmts2[0].mimeType, 'yt-player-response', 0.95);
          ytEmitted = true;
        }

        // 2. DASH manifest (video+audio separate tracks — dashDownloader handles it)
        if (sd2.dashManifestUrl) {
          emit(sd2.dashManifestUrl, 'application/dash+xml', 'yt-player-response', ytEmitted ? 0.72 : 0.88);
          ytEmitted = true;
        }

        // 3. HLS manifest — skip on iOS (FairPlay); on other UAs uses AES-128
        if (sd2.hlsManifestUrl && !isIOSua) {
          emit(sd2.hlsManifestUrl, 'application/x-mpegurl', 'yt-player-response', ytEmitted ? 0.65 : 0.82);
        }

        // Telemetry — helps debug what was found / rejected
        post({
          event: 'YT_DETECTED',
          videoId: (ytpr.videoDetails && ytpr.videoDetails.videoId) || '',
          formatsCount:  (sd2.formats || []).length,
          adaptiveCount: (sd2.adaptiveFormats || []).length,
          hasDirect:     fmts2.length > 0,
          hasDash:       !!sd2.dashManifestUrl,
          hasHls:        !!sd2.hlsManifestUrl,
          isIOS:         isIOSua,
          emitted:       ytEmitted,
          timestamp:     Date.now(),
        });
      }
    } catch (_) {}

    // Bilibili — prefer progressive MP4 (durl) to avoid requiring FFmpeg mux
    try {
      var biliPi = window.__playinfo__;
      if (biliPi && biliPi.data) {
        var bdata = biliPi.data;
        if (bdata.durl && bdata.durl.length > 0) {
          var bUrl = (bdata.durl[0].url || '').replace(/\\\\u0026/g, '&');
          if (bUrl) emit(bUrl, 'video/mp4', 'page-global', 0.88);
        } else if (bdata.dash) {
          // Fallback: best video track only (no FFmpeg for audio mux)
          var bvids = (bdata.dash.video || []).slice().sort(function(a, b) {
            return (b.bandwidth || 0) - (a.bandwidth || 0);
          });
          if (bvids.length > 0) {
            var bvUrl = (bvids[0].baseUrl || bvids[0].base_url || '').replace(/\\\\u0026/g, '&');
            if (bvUrl && !SEEN.has(bvUrl)) {
              SEEN.add(bvUrl);
              var bLabel = bvids[0].height ? (bvids[0].height + 'p') : 'Bilibili';
              emit(bvUrl, 'video/mp4', 'page-global', 0.75);
            }
          }
        }
      }
    } catch (_) {}

    // Instagram
    try {
      ['__additionalDataLoaded', 'instagram_data', '_sharedData', '__initialData'].forEach(function(k) {
        try { if (window[k]) scanText(JSON.stringify(window[k])); } catch(_) {}
      });
    } catch (_) {}

    // Twitter/X
    try {
      ['__initialData__', '__featureFlags', 'initialTimeline'].forEach(function(k) {
        try { if (window[k]) scanText(JSON.stringify(window[k])); } catch(_) {}
      });
      try {
        if (window.__TIMELINE_DATA__) scanText(JSON.stringify(window.__TIMELINE_DATA__));
        if (window._data)             scanText(JSON.stringify(window._data));
      } catch(_) {}
    } catch (_) {}

    // Threads
    try {
      ['__bbox', '__relay_store__', 'instagramData'].forEach(function(k) {
        try { if (window[k]) scanText(JSON.stringify(window[k])); } catch(_) {}
      });
    } catch (_) {}

    // Dailymotion
    try {
      if (window.DM && window.DM.player) scanText(JSON.stringify(window.DM.player));
      if (window.dmGlobal) scanText(JSON.stringify(window.dmGlobal));
    } catch (_) {}

    // Pinterest
    try {
      if (window.__PWS_DATA__) scanText(JSON.stringify(window.__PWS_DATA__));
    } catch (_) {}

    // Video.js global players
    try {
      if (window.videojs && window.videojs.getPlayers) {
        Object.values(window.videojs.getPlayers()).forEach(function(p) {
          try { if (p && p.currentSrc) emit(p.currentSrc(), null); } catch(_) {}
        });
      }
    } catch (_) {}

    // Flowplayer live instances (v6: flowplayer.find('*'); v7: window.flowplayer.players)
    try {
      if (window.flowplayer) {
        var _fpPlayers = [];
        try {
          if (typeof window.flowplayer.find === 'function') _fpPlayers = window.flowplayer.find('*');
        } catch (_) {}
        try {
          if (!_fpPlayers.length && Array.isArray(window.flowplayer.players)) _fpPlayers = window.flowplayer.players;
        } catch (_) {}
        _fpPlayers.forEach(function(p) {
          try {
            var clip = p && (p.clip || (p.conf && p.conf.clip) || {});
            var srcs = clip.sources || (p.conf && p.conf.sources) || [];
            if (!srcs.length && clip.src) srcs = [{ src: clip.src, type: clip.type || '' }];
            srcs.forEach(function(s) {
              var u = s && (s.src || s.file || s.url || '');
              if (u) emit(u, s.type || null, 'page-global', 0.82);
            });
          } catch (_) {}
        });
      }
    } catch (_) {}

    // JW Player live instances
    try {
      if (window.jwplayer) {
        // jwplayer() with no args returns the most recently created instance
        var _jw = window.jwplayer();
        if (_jw && _jw.getPlaylistItem) {
          try {
            var _jwItem = _jw.getPlaylistItem();
            if (_jwItem) {
              if (_jwItem.file) emit(_jwItem.file, null, 'page-global', 0.82);
              (_jwItem.sources || []).forEach(function(s) { if (s && s.file) emit(s.file, s.type || null, 'page-global', 0.82); });
            }
          } catch (_) {}
        }
        // Also scan all registered players by ID
        var _jwAll = typeof window.jwplayer.utils === 'object' && window.jwplayer.utils && window.jwplayer.utils.getId
          ? [] : [];
        try {
          document.querySelectorAll('[id]').forEach(function(el) {
            try {
              var _p = window.jwplayer(el.id);
              if (!_p || !_p.getPlaylistItem || _p === _jw) return;
              var _it = _p.getPlaylistItem();
              if (_it && _it.file) emit(_it.file, null, 'page-global', 0.82);
              (_it && _it.sources || []).forEach(function(s) { if (s && s.file) emit(s.file, s.type || null, 'page-global', 0.82); });
            } catch (_) {}
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── 2. PerformanceObserver ────────────────────────────────────
  // Pre-filter: only emit URLs that look like media to reduce noise from CSS/fonts/scripts.
  var _PERF_MEDIA_RE = /\\.(?:m3u8?|mpd|mp4|m4v|m4s|m4a|webm|mov|ts|aac|mp3|ogg|opus|flac|wav|vtt|webvtt|srt|sub|sbv|ass|ssa|ttml|dfxp)(?:[?#]|$)/i;
  function _isMediaEntry(e) {
    var n = e.name || '';
    if (_PERF_MEDIA_RE.test(n)) return true;
    if (/(?:vimeocdn\\.com.*\\/playlist\\.json|player\\.vimeo\\.com\\/video\\/\\d+\\/config)(?:[?#]|$)/i.test(n)) return true;
    // PerformanceResourceTiming.initiatorType is 'video' or 'audio' for native elements
    if (e.initiatorType === 'video' || e.initiatorType === 'audio') return true;
    // Large responses from xmlhttprequest / fetch are worth checking (may be DASH segments or media files)
    if ((e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch') && e.transferSize > 50000) return true;
    return false;
  }
  try {
    var _po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) { if (_isMediaEntry(e)) { emit(e.name, null); } logPerformanceEntry(e); });
    });
    _po.observe({ type: 'resource', buffered: true });
  } catch (_) {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) { if (_isMediaEntry(e)) { emit(e.name, null); } logPerformanceEntry(e); });
      }).observe({ entryTypes: ['resource'] });
    } catch (_2) {}
  }
  try { performance.getEntriesByType('resource').forEach(function (e) { if (_isMediaEntry(e)) { emit(e.name, null); } logPerformanceEntry(e); }); }
  catch (_) {}

  // ── 3. fetch ──────────────────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function (resource, init) {
    var url = resource instanceof Request ? resource.url : String(resource);
    var method = (init && init.method) || (resource instanceof Request && resource.method) || 'GET';
    emit(url, null, 'fetch-hook', 0.6); log(url, { method: method, provenance: 'fetch-hook' });
    var p = _fetch.apply(this, arguments);
    p.then(function (res) {
      try {
        var ct = res.headers && res.headers.get('Content-Type');
        var len = res.headers && Number(res.headers.get('Content-Length') || 0);
        log(url, {
          method: method,
          status: res.status,
          mimeType: ct || undefined,
          contentLength: Number.isFinite(len) && len > 0 ? len : undefined,
          provenance: 'fetch-hook'
        });
        if (ct) emit(url, ct, 'fetch-hook', 0.7);
        var base = url.split('?')[0];
        var isSegment = /\\.(ts|m4s|aac|m4a)$/i.test(base.split('/').pop() || '');
        if (!isSegment) {
          // Track Response→URL for blob lineage
          if (_blobLineageResp) {
            try { _blobLineageResp.set(res, url); } catch(_) {}
          }
          res.clone().text().then(function (text) {
            if (!text || text.length > 1048576) return; // skip >1 MB
            var head = (text || '').trimStart().slice(0, 40);
            if (head.indexOf('#EXTM3U') === 0) {
              emit(url, 'application/x-mpegurl', 'manifest-parser', 0.92);
              if (_recentManifests.length >= 8) _recentManifests.shift();
              _recentManifests.push({url: url, mimeType: 'application/x-mpegurl'});
            } else if (head.indexOf('<?xml') === 0 && text.indexOf('<MPD ') !== -1) {
              emit(url, 'application/dash+xml', 'manifest-parser', 0.92);
              if (_recentManifests.length >= 8) _recentManifests.shift();
              _recentManifests.push({url: url, mimeType: 'application/dash+xml'});
            } else if (head.indexOf('WEBVTT') === 0 || head.indexOf('﻿WEBVTT') === 0) {
              emitSubtitle(url, 'text/vtt', 'manifest-parser');
            } else if (/^\\d+\\r?\\n\\d{2}:\\d{2}:\\d{2}[,.]\\d{3}/.test(head)) {
              emitSubtitle(url, 'application/x-subrip', 'manifest-parser');
            }
            scanText(text);
            // JSON API body parsing — catch image_url / video_url fields
            // that scanText's URL regex misses (e.g. extensionless CDN paths)
            var ct = res.headers && res.headers.get('Content-Type');
            var apiPath = url.split('?')[0];
            var isApi = (ct && ct.indexOf('application/json') !== -1) ||
                        apiPath.indexOf('/api/') !== -1 || apiPath.indexOf('/v1/') !== -1 ||
                        apiPath.indexOf('/v2/') !== -1 || apiPath.indexOf('/v3/') !== -1;
            if (isApi && (head.startsWith('{') || head.startsWith('['))) {
              var jsonRe = /"(?:video_url|playable_url|browser_native_hd_url|hd_src|sd_src|download_url|play_url|stream_url|media_url|image_url|photo_url|thumbnail_url|cover_url|src_url|original_url|article_photo_link|subtitle_url|caption_url|track_url|vtt_url|srt_url|transcript_url|audio_url|hls_url|dash_url|m3u8_url|mpd_url|manifest_url|master_url|content_url|contentUrl|playback_url|playbackUrl|mediaUrl|videoUrl|audioUrl|streamUrl|downloadUrl)"\\s*:\\s*"(https?:[^"]{10,})"/gi;
              var jm;
              while ((jm = jsonRe.exec(text))) {
                var jurl = jm[1].replace(/\\u002F/gi, '/').replace(/\\\\/g, '');
                if (jurl.startsWith('http')) { emit(jurl, null, 'json-api', 0.75); }
              }
            }
          }).catch(function () {});
        }
      } catch (_) {}
    }).catch(function () {});
    return p;
  };

  // Hook Response.prototype.blob to track blob lineage
  if (typeof Response !== 'undefined' && Response.prototype && Response.prototype.blob) {
    var _respBlob = Response.prototype.blob;
    Response.prototype.blob = function () {
      var self = this;
      var srcUrl = _blobLineageResp ? (_blobLineageResp.get(self) || '') : '';
      return _respBlob.call(self).then(function (blob) {
        try {
          if (srcUrl && _blobLineageBlob) _blobLineageBlob.set(blob, srcUrl);
        } catch(_) {}
        return blob;
      });
    };
  }

  // ── 4. XHR ────────────────────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var xurl = String(url);
    var xhrMethod = method || 'GET';
    emit(xurl, null, 'xhr-hook', 0.6); log(xurl, { method: xhrMethod, provenance: 'xhr-hook' });
    this.addEventListener('load', function () {
      try {
        var ct = this.getResponseHeader('Content-Type');
        var len = Number(this.getResponseHeader('Content-Length') || 0);
        log(xurl, {
          method: xhrMethod,
          status: this.status,
          mimeType: ct || undefined,
          contentLength: Number.isFinite(len) && len > 0 ? len : undefined,
          provenance: 'xhr-hook'
        });
        if (ct) emit(xurl, ct, 'xhr-hook', 0.7);
        var base = xurl.split('?')[0];
        var isSegment = /\\.(ts|m4s|aac|m4a)$/i.test(base.split('/').pop() || '');
        if (!isSegment && (this.responseType === '' || this.responseType === 'text')) {
          var text = this.responseText || '';
          if (text.length > 1048576) return;
          var head = text.trimStart().slice(0, 40);
          if (head.indexOf('#EXTM3U') === 0) {
            emit(xurl, 'application/x-mpegurl', 'manifest-parser', 0.92);
            if (_recentManifests.length >= 8) _recentManifests.shift();
            _recentManifests.push({url: xurl, mimeType: 'application/x-mpegurl'});
          } else if (head.indexOf('<?xml') === 0 && text.indexOf('<MPD ') !== -1) {
            emit(xurl, 'application/dash+xml', 'manifest-parser', 0.92);
            if (_recentManifests.length >= 8) _recentManifests.shift();
            _recentManifests.push({url: xurl, mimeType: 'application/dash+xml'});
          } else if (head.indexOf('WEBVTT') === 0 || head.indexOf('﻿WEBVTT') === 0) {
            emitSubtitle(xurl, 'text/vtt', 'xhr-hook');
          } else if (/^\\d+\\r?\\n\\d{2}:\\d{2}:\\d{2}[,.]\\d{3}/.test(head)) {
            emitSubtitle(xurl, 'application/x-subrip', 'xhr-hook');
          }
          scanText(text);
          var xct = this.getResponseHeader('Content-Type') || '';
          var xApiPath = base.split('?')[0];
          var xIsApi = (xct.indexOf('application/json') !== -1) ||
                       xApiPath.indexOf('/api/') !== -1 || xApiPath.indexOf('/v1/') !== -1 ||
                       xApiPath.indexOf('/v2/') !== -1 || xApiPath.indexOf('/v3/') !== -1;
          if (xIsApi && (head.startsWith('{') || head.startsWith('['))) {
            var xjsonRe = /"(?:video_url|playable_url|browser_native_hd_url|hd_src|sd_src|download_url|play_url|stream_url|media_url|image_url|photo_url|thumbnail_url|cover_url|src_url|original_url|article_photo_link|subtitle_url|caption_url|track_url|vtt_url|srt_url|transcript_url|audio_url|hls_url|dash_url|m3u8_url|mpd_url|manifest_url|master_url|content_url|contentUrl|playback_url|playbackUrl|mediaUrl|videoUrl|audioUrl|streamUrl|downloadUrl)"\\s*:\\s*"(https?:[^"]{10,})"/gi;
            var xjm;
            while ((xjm = xjsonRe.exec(text))) {
              var xjurl = xjm[1].replace(/\\u002F/gi, '/').replace(/\\\\/g, '');
              if (xjurl.startsWith('http')) { emit(xjurl, null, 'json-api', 0.75); }
            }
          }
        }
      } catch (_) {}
    });
    return _xhrOpen.apply(this, arguments);
  };

  // ── 5. HTMLMediaElement src ───────────────────────────────────
  ['HTMLMediaElement', 'HTMLSourceElement'].forEach(function (name) {
    var proto = window[name] && window[name].prototype;
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, 'src', {
      get: desc.get,
      set: function (v) {
        try {
          var sv = String(v || '');
          if (sv.startsWith('blob:')) {
            // Resolve blob → original URL via lineage map
            var entry = _blobUrlMap.get(sv);
            if (entry && entry.url) {
              emit(entry.url, entry.mime || this.type || null, 'media-element', 0.85);
            } else {
              // Unknown blob — just signal MSE
              post({ event: 'MSE_ACTIVE', pageUrl: location.href, timestamp: Date.now() });
            }
          } else {
            emit(sv, this.type || null, 'media-element', 0.85);
          }
        } catch (_) {}
        return desc.set.call(this, v);
      },
      configurable: true,
    });
  });

  // ── 6. URL.createObjectURL / MediaSource ──────────────────────
  var _cou = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var blobUrl = _cou(obj);
    try {
      if (obj instanceof Blob && !(window.MediaSource && obj instanceof MediaSource)) {
        // Network blob (not MSE) — look up lineage
        var srcUrl = _blobLineageBlob ? _blobLineageBlob.get(obj) : '';
        var mime   = obj.type || '';
        if (srcUrl) {
          _blobUrlMap.set(blobUrl, { url: srcUrl, mime: mime });
          emit(srcUrl, mime || null, 'media-element', 0.82);
        } else {
          // No lineage — just record the mime type for later
          if (mime && /video|audio|mpegurl|dash/i.test(mime)) {
            _blobUrlMap.set(blobUrl, { url: '', mime: mime });
          }
          post({ event: 'MSE_ACTIVE', pageUrl: location.href, timestamp: Date.now() });
        }
      } else {
        // MediaSource blob
        post({ event: 'MSE_ACTIVE', pageUrl: location.href, timestamp: Date.now() });
      }
    } catch (_) {
      post({ event: 'MSE_ACTIVE', pageUrl: location.href, timestamp: Date.now() });
    }
    return blobUrl;
  };

  if (window.MediaSource) {
    var _addSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      post({ event: 'MSE_TRACK', mimeType: mime, pageUrl: location.href, timestamp: Date.now() });
      var sb = _addSB.call(this, mime);
      // Hook appendBuffer to confirm active playback
      if (sb && sb.appendBuffer) {
        var _origAB = sb.appendBuffer.bind(sb);
        sb.appendBuffer = function (data) {
          // Emit MSE_MANIFEST so the native side can correlate the manifest URL
          // that was fetched before MSE was activated.  Falls back to MSE_ACTIVE
          // semantics (sets mseActive flag) when no manifests are buffered.
          post({
            event: _recentManifests.length > 0 ? 'MSE_MANIFEST' : 'MSE_ACTIVE',
            manifests: _recentManifests.slice(),
            pageUrl: location.href,
            timestamp: Date.now()
          });
          sb.appendBuffer = _origAB; // only report once per SourceBuffer
          return _origAB(data);
        };
      }
      return sb;
    };
  }

  // ── 7. hls.js ─────────────────────────────────────────────────
  function patchHlsJs(Hls) {
    if (!Hls || !Hls.prototype || !Hls.prototype.loadSource) return;
    var orig = Hls.prototype.loadSource;
    Hls.prototype.loadSource = function (src) {
      emit(src, 'application/x-mpegurl', 'player-sdk-hook', 0.9);
      return orig.call(this, src);
    };
  }
  var _hlsV = window.Hls;
  try {
    Object.defineProperty(window, 'Hls', { configurable: true,
      get: function () { return _hlsV; },
      set: function (v) { _hlsV = v; patchHlsJs(v); },
    });
  } catch (_) {}
  patchHlsJs(_hlsV);

  // ── 8. Shaka Player ───────────────────────────────────────────
  function patchShaka(shaka) {
    try {
      if (!shaka || !shaka.Player || !shaka.Player.prototype) return;
      var orig = shaka.Player.prototype.load;
      if (!orig) return;
      shaka.Player.prototype.load = function (url) {
        emit(url, null, 'player-sdk-hook', 0.9);
        return orig.apply(this, arguments);
      };
    } catch (_) {}
  }
  var _shakaV = window.shaka;
  try {
    Object.defineProperty(window, 'shaka', { configurable: true,
      get: function () { return _shakaV; },
      set: function (v) { _shakaV = v; patchShaka(v); },
    });
  } catch (_) {}
  patchShaka(_shakaV);

  // ── 9. JW Player ──────────────────────────────────────────────
  function patchJw(jw) {
    if (!jw || !jw.prototype) return;
    ['setup', 'load'].forEach(function (m) {
      var orig = jw.prototype[m]; if (!orig) return;
      jw.prototype[m] = function (cfg) {
        try {
          var srcs = cfg && (cfg.sources ||
            (cfg.playlist && cfg.playlist[0] && cfg.playlist[0].sources) || []);
          (Array.isArray(srcs) ? srcs : []).forEach(function (s) {
            if (s && s.file) emit(s.file, s.type || null, 'player-sdk-hook', 0.9);
          });
          if (cfg && cfg.file) emit(cfg.file, null, 'player-sdk-hook', 0.9);
        } catch (_) {}
        return orig.apply(this, arguments);
      };
    });
  }
  var _jwV = window.jwplayer;
  try {
    Object.defineProperty(window, 'jwplayer', { configurable: true,
      get: function () { return _jwV; },
      set: function (v) { _jwV = v; patchJw(v); },
    });
  } catch (_) {}
  patchJw(_jwV);

  // ── 10. Video.js / Dash.js ────────────────────────────────────
  function patchVjs(v) {
    if (!v || !v.prototype || !v.prototype.src) return;
    var orig = v.prototype.src;
    v.prototype.src = function (s) {
      try {
        if (typeof s === 'string') emit(s, null, 'player-sdk-hook', 0.85);
        else if (s && s.src) emit(s.src, s.type || null, 'player-sdk-hook', 0.85);
        else if (Array.isArray(s)) s.forEach(function (x) { if (x && x.src) emit(x.src, x.type || null, 'player-sdk-hook', 0.85); });
      } catch (_) {}
      return orig.apply(this, arguments);
    };
  }
  var _vjsV = window.videojs;
  try {
    Object.defineProperty(window, 'videojs', { configurable: true,
      get: function () { return _vjsV; },
      set: function (v) { _vjsV = v; patchVjs(v); },
    });
  } catch (_) {}
  patchVjs(_vjsV);

  // ── 10b. WebSocket — scan text frames for embedded media URLs ──
  // Many live-streaming and sports sites deliver HLS URLs or signed CDN URLs
  // through a WebSocket control channel.  We intercept the constructor so we
  // can listen for message events without breaking the WS object's identity.
  if (typeof WebSocket !== 'undefined') {
    var _OrigWS = WebSocket;
    function _FCDWebSocket(url, protocols) {
      var ws = protocols !== undefined ? new _OrigWS(url, protocols) : new _OrigWS(url);
      try {
        ws.addEventListener('message', function (e) {
          try {
            if (typeof e.data !== 'string' || e.data.length > 131072) return;
            var text = e.data;
            var wsHead = text.trimStart().slice(0, 40);
            if (wsHead.indexOf('#EXTM3U') === 0) {
              // Full HLS manifest pushed over WebSocket — record it for MSE correlation
              var wsUrl = String(url || '');
              emit(wsUrl, 'application/x-mpegurl', 'websocket-message', 0.88);
              if (_recentManifests.length >= 8) _recentManifests.shift();
              _recentManifests.push({url: wsUrl, mimeType: 'application/x-mpegurl'});
            } else {
              // Scan JSON/text messages for embedded HTTP(S) media URLs
              var wsRe = /https?:\\/\\/[^\\s"'<>{}\\[\\]\\\\]{20,}/g;
              var wsM;
              while ((wsM = wsRe.exec(text))) emit(wsM[0], null, 'websocket-message', 0.65);
            }
          } catch (_) {}
        });
      } catch (_) {}
      return ws;
    }
    _FCDWebSocket.prototype = _OrigWS.prototype;
    _FCDWebSocket.CONNECTING = _OrigWS.CONNECTING;
    _FCDWebSocket.OPEN       = _OrigWS.OPEN;
    _FCDWebSocket.CLOSING    = _OrigWS.CLOSING;
    _FCDWebSocket.CLOSED     = _OrigWS.CLOSED;
    try { window.WebSocket = _FCDWebSocket; } catch (_) {}
  }

  // ── 10c. EventSource — SSE streams sometimes deliver manifest URLs ─
  if (typeof EventSource !== 'undefined') {
    var _OrigES = EventSource;
    function _FCDEventSource(url, init) {
      var es = init !== undefined ? new _OrigES(url, init) : new _OrigES(url);
      try {
        es.addEventListener('message', function (e) {
          try {
            if (typeof e.data !== 'string' || e.data.length > 65536) return;
            var esRe = /https?:\\/\\/[^\\s"'<>{}\\[\\]\\\\]{20,}/g;
            var esM;
            while ((esM = esRe.exec(e.data))) emit(esM[0], null, 'eventsource-message', 0.65);
          } catch (_) {}
        });
      } catch (_) {}
      return es;
    }
    _FCDEventSource.prototype = _OrigES.prototype;
    try { window.EventSource = _FCDEventSource; } catch (_) {}
  }

  // ── 10d. navigator.mediaSession — capture title + artwork metadata ─────────
  try {
    var _msProto = navigator.mediaSession
      && Object.getPrototypeOf(navigator.mediaSession);
    var _msMetaDesc = _msProto
      && Object.getOwnPropertyDescriptor(_msProto, 'metadata');
    if (_msMetaDesc && _msMetaDesc.set) {
      Object.defineProperty(_msProto, 'metadata', {
        get: _msMetaDesc.get,
        set: function (meta) {
          try {
            if (meta) {
              // Emit highest-res artwork as a potential thumbnail / image candidate
              var art = meta.artwork;
              if (art && art.length) {
                var best = art[art.length - 1]; // last entry is typically largest
                if (best && best.src) emit(best.src, best.type || null, 'media-element', 0.55);
              }
              post({
                event: 'MEDIA_SESSION_META',
                title: meta.title || '',
                artist: meta.artist || '',
                album: meta.album || '',
                pageUrl: location.href,
                timestamp: Date.now(),
              });
            }
          } catch (_) {}
          return _msMetaDesc.set.call(this, meta);
        },
        configurable: true,
        enumerable: _msMetaDesc.enumerable,
      });
    }
  } catch (_) {}

  // ── 10e. window.message events & Service Worker messages ─────────────────
  // Player SDKs (Brightcove, JW Player, custom) use postMessage to communicate
  // media URLs from embedded iframes to the parent page.  SWs sometimes push
  // cached media URLs to the page via navigator.serviceWorker.postMessage().
  // Both channels are invisible to our fetch/XHR hooks, so we add listeners here.
  try {
    var _pmRe = /https?:\\/\\/[^\\s"'<>{}\\[\\]\\\\]{20,}/g;
    var _pmJsonRe = /"(?:url|src|file|stream|hls_url|dash_url|video_url|audio_url|playback_url|manifest_url|master_url|playlist_url|content_url)"\\s*:\\s*"(https?:[^"]{10,})"/gi;
    function _scanMessageData(data, confidence) {
      try {
        if (typeof data === 'string') {
          if (data.length > 65536) return;
          _pmRe.lastIndex = 0;
          var m;
          while ((m = _pmRe.exec(data))) emit(m[0], null, 'message-event', confidence);
        } else if (data && typeof data === 'object') {
          var str;
          try { str = JSON.stringify(data); } catch (_) { return; }
          if (!str || str.length > 65536) return;
          _pmJsonRe.lastIndex = 0;
          var jm;
          while ((jm = _pmJsonRe.exec(str)))
            emit(jm[1].replace(/\\\//g, '/'), null, 'message-event', confidence + 0.05);
        }
      } catch (_) {}
    }
    // Capture mode so we see messages even if the app handler calls stopPropagation
    window.addEventListener('message', function (e) {
      _scanMessageData(e && e.data, 0.62);
    }, true);
  } catch (_) {}
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        _scanMessageData(e && e.data, 0.65);
      });
    }
  } catch (_) {}

  // ── 10f. Clappr player ────────────────────────────────────────
  // Clappr is an open-source player used by several Brazilian streaming sites
  // and others. new Clappr.Player({ source: "..." }) or { sources: [...] }.
  function patchClappr(Clappr) {
    try {
      if (!Clappr || !Clappr.Player) return;
      var _OrigClappr = Clappr.Player;
      Clappr.Player = function (opts) {
        try {
          if (opts) {
            var src = opts.source || (opts.sources && opts.sources[0]);
            if (typeof src === 'string') emit(src, null, 'player-sdk-hook', 0.87);
            else if (src && src.source) emit(src.source, src.mimeType || null, 'player-sdk-hook', 0.87);
            if (Array.isArray(opts.sources)) {
              opts.sources.forEach(function (s) {
                if (typeof s === 'string') emit(s, null, 'player-sdk-hook', 0.87);
                else if (s && s.source) emit(s.source, s.mimeType || null, 'player-sdk-hook', 0.87);
              });
            }
          }
        } catch (_) {}
        return new _OrigClappr(opts);
      };
      for (var k in _OrigClappr) { try { Clappr.Player[k] = _OrigClappr[k]; } catch (_) {} }
      Clappr.Player.prototype = _OrigClappr.prototype;
    } catch (_) {}
  }
  var _clapprV = window.Clappr;
  try {
    Object.defineProperty(window, 'Clappr', { configurable: true,
      get: function () { return _clapprV; },
      set: function (v) { _clapprV = v; patchClappr(v); },
    });
  } catch (_) {}
  patchClappr(_clapprV);

  // ── 10g. Bitmovin Player ──────────────────────────────────────
  // Bitmovin is used by Sky, ESPN, and other broadcasters.
  // API: new bitmovin.player.Player(container, { source: { hls: "...", dash: "..." } })
  // or: player.load({ hls: "...", dash: "..." })
  function patchBitmovin(bitmovin) {
    try {
      if (!bitmovin || !bitmovin.player || !bitmovin.player.Player) return;
      var _OrigBV = bitmovin.player.Player;
      function _emitBitmovinSource(source) {
        try {
          if (!source) return;
          if (source.hls) emit(source.hls, 'application/x-mpegurl', 'player-sdk-hook', 0.9);
          if (source.dash) emit(source.dash, 'application/dash+xml', 'player-sdk-hook', 0.9);
          if (source.progressive) {
            var prog = source.progressive;
            (Array.isArray(prog) ? prog : [prog]).forEach(function (p) {
              var u = typeof p === 'string' ? p : (p && p.url);
              if (u) emit(u, (p && p.mimetype) || null, 'player-sdk-hook', 0.87);
            });
          }
        } catch (_) {}
      }
      bitmovin.player.Player = function (container, config) {
        try { if (config && config.source) _emitBitmovinSource(config.source); } catch (_) {}
        var inst = new _OrigBV(container, config);
        try {
          var origLoad = inst.load;
          inst.load = function (source) {
            try { _emitBitmovinSource(source); } catch (_) {}
            return origLoad.apply(this, arguments);
          };
        } catch (_) {}
        return inst;
      };
      bitmovin.player.Player.prototype = _OrigBV.prototype;
    } catch (_) {}
  }
  var _bitmovinV = window.bitmovin;
  try {
    Object.defineProperty(window, 'bitmovin', { configurable: true,
      get: function () { return _bitmovinV; },
      set: function (v) { _bitmovinV = v; patchBitmovin(v); },
    });
  } catch (_) {}
  patchBitmovin(_bitmovinV);

  // ── 10h. Flowplayer ──────────────────────────────────────────
  // Flowplayer 7+: flowplayer(container, { clip: { sources: [{type, src}] } })
  // or: flowplayer.boot(el, { src: '...', type: '...' })
  function patchFlowplayer(fp) {
    try {
      if (!fp || typeof fp !== 'function') return;
      function _emitFpSource(clip) {
        try {
          if (!clip) return;
          var srcs = clip.sources || (clip.src ? [clip] : []);
          srcs.forEach(function (s) {
            if (s && s.src) emit(s.src, s.type || null, 'player-sdk-hook', 0.87);
          });
          if (clip.url) emit(clip.url, null, 'player-sdk-hook', 0.87);
        } catch (_) {}
      }
      var _OrigFp = fp;
      var _patchedFp = function (container, opts) {
        try {
          if (opts && opts.clip) _emitFpSource(opts.clip);
          if (opts && opts.src) emit(opts.src, opts.type || null, 'player-sdk-hook', 0.87);
        } catch (_) {}
        return _OrigFp.apply(this, arguments);
      };
      for (var k in _OrigFp) { try { _patchedFp[k] = _OrigFp[k]; } catch (_) {} }
      if (_OrigFp.boot) {
        _patchedFp.boot = function (el, config) {
          try { if (config) { if (config.src) emit(config.src, config.type || null, 'player-sdk-hook', 0.87); if (config.clip) _emitFpSource(config.clip); } } catch (_) {}
          return _OrigFp.boot.apply(this, arguments);
        };
      }
      window.flowplayer = _patchedFp;
    } catch (_) {}
  }
  var _fpV = window.flowplayer;
  try {
    Object.defineProperty(window, 'flowplayer', { configurable: true,
      get: function () { return _fpV; },
      set: function (v) { _fpV = v; patchFlowplayer(v); },
    });
  } catch (_) {}
  patchFlowplayer(_fpV);

  // ── 10i. Plyr ────────────────────────────────────────────────
  // Plyr: new Plyr(element, { source: { sources: [{src, type}] } })
  // or:   player.source = { sources: [{src, type}] }
  function patchPlyr(Plyr) {
    try {
      if (!Plyr || !Plyr.prototype) return;
      function _emitPlyrSource(src) {
        try {
          if (!src) return;
          var srcs = src.sources || (src.src ? [src] : []);
          srcs.forEach(function (s) {
            if (s && s.src) emit(s.src, s.type || null, 'player-sdk-hook', 0.87);
          });
        } catch (_) {}
      }
      var _OrigPlyrSrc = Object.getOwnPropertyDescriptor(Plyr.prototype, 'source');
      var _OrigPlyrInit = Plyr;
      window.Plyr = function (target, opts) {
        try { if (opts && opts.source) _emitPlyrSource(opts.source); } catch (_) {}
        var inst = new _OrigPlyrInit(target, opts);
        try {
          Object.defineProperty(inst, 'source', {
            set: function (v) {
              try { _emitPlyrSource(v); } catch (_) {}
              if (_OrigPlyrSrc && _OrigPlyrSrc.set) _OrigPlyrSrc.set.call(this, v);
            },
            get: function () { return _OrigPlyrSrc && _OrigPlyrSrc.get ? _OrigPlyrSrc.get.call(this) : undefined; },
            configurable: true,
          });
        } catch (_) {}
        return inst;
      };
      window.Plyr.prototype = Plyr.prototype;
      for (var k in Plyr) { try { window.Plyr[k] = Plyr[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _plyrV = window.Plyr;
  try {
    Object.defineProperty(window, 'Plyr', { configurable: true,
      get: function () { return _plyrV; },
      set: function (v) { _plyrV = v; patchPlyr(v); },
    });
  } catch (_) {}
  patchPlyr(_plyrV);

  // ── 10j. DPlayer ─────────────────────────────────────────────
  // DPlayer: new DPlayer({ video: { url, type: 'hls'|'dash'|'normal', pic } })
  // Widely used on Chinese video sites and indie blogs.
  function patchDPlayer(DP) {
    try {
      if (!DP || !DP.prototype) return;
      var _OrigDP = DP;
      window.DPlayer = function (opts) {
        try {
          if (opts && opts.video) {
            var v = opts.video;
            if (v.url) emit(v.url, null, 'player-sdk-hook', 0.87);
            if (v.pic) emit(v.pic, 'image/jpeg', 'player-sdk-hook', 0.7);
            if (v.thumbnailUrl) emit(v.thumbnailUrl, 'image/jpeg', 'player-sdk-hook', 0.7);
          }
        } catch (_) {}
        return new _OrigDP(opts);
      };
      window.DPlayer.prototype = DP.prototype;
      for (var k in DP) { try { window.DPlayer[k] = DP[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _dpV = window.DPlayer;
  try {
    Object.defineProperty(window, 'DPlayer', { configurable: true,
      get: function () { return _dpV; },
      set: function (v) { _dpV = v; patchDPlayer(v); },
    });
  } catch (_) {}
  patchDPlayer(_dpV);

  // ── 10k. YouTube IFrame API ───────────────────────────────────
  // Many sites use new YT.Player(container, { videoId: '...', ... }).
  // We emit the watch URL; the server/platform extractor handles extraction.
  function patchYTPlayer(YT) {
    try {
      if (!YT || !YT.Player) return;
      var _OrigYTP = YT.Player;
      YT.Player = function (el, config) {
        try {
          var videoId = config && (config.videoId || (config.playerVars && config.playerVars.list));
          if (videoId) emit('https://www.youtube.com/watch?v=' + videoId, null, 'player-sdk-hook', 0.85);
        } catch (_) {}
        return new _OrigYTP(el, config);
      };
      YT.Player.prototype = _OrigYTP.prototype;
      for (var k in _OrigYTP) { try { YT.Player[k] = _OrigYTP[k]; } catch (_) {} }
    } catch (_) {}
  }
  // Also intercept onYouTubeIframeAPIReady, which is the callback some sites set
  // before the YT script loads.
  try {
    var _ytV = window.YT;
    Object.defineProperty(window, 'YT', { configurable: true,
      get: function () { return _ytV; },
      set: function (v) { _ytV = v; patchYTPlayer(v); },
    });
    patchYTPlayer(_ytV);
  } catch (_) {}
  try {
    var _origYTReady = window.onYouTubeIframeAPIReady;
    Object.defineProperty(window, 'onYouTubeIframeAPIReady', { configurable: true,
      get: function () { return _origYTReady; },
      set: function (fn) {
        _origYTReady = function () {
          try { patchYTPlayer(window.YT); } catch (_) {}
          if (typeof fn === 'function') fn.apply(this, arguments);
        };
      },
    });
  } catch (_) {}

  // ── 10l. Vimeo Player SDK ─────────────────────────────────────
  // Sites may call new Vimeo.Player(container, { id: 123 }) or { url: '...' }
  // without any pre-existing <iframe src="player.vimeo.com/..."> in the DOM.
  function vimeoConfigUrl(id, sourceUrl) {
    try {
      var suffix = '';
      if (sourceUrl) {
        var parsed = new URL(sourceUrl, location.href);
        suffix = parsed.search || '';
      }
      return 'https://player.vimeo.com/video/' + id + '/config' + suffix;
    } catch (_) {
      return 'https://player.vimeo.com/video/' + id + '/config';
    }
  }
  function patchVimeoSDK(Vimeo) {
    try {
      if (!Vimeo || !Vimeo.Player) return;
      var _OrigVP = Vimeo.Player;
      Vimeo.Player = function (el, opts) {
        try {
          if (opts) {
            if (opts.id) {
              emit(vimeoConfigUrl(opts.id), 'application/json', 'player-sdk-hook', 0.9);
            } else if (typeof opts.url === 'string' && opts.url) {
              var _vm = opts.url.match(new RegExp('vimeo.com/(?:video/)?([0-9]+)'));
              if (_vm) emit(vimeoConfigUrl(_vm[1], opts.url), 'application/json', 'player-sdk-hook', 0.9);
              else emit(opts.url, null, 'player-sdk-hook', 0.82);
            }
          }
        } catch (_) {}
        return new _OrigVP(el, opts);
      };
      Vimeo.Player.prototype = _OrigVP.prototype;
      for (var k in _OrigVP) { try { Vimeo.Player[k] = _OrigVP[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _vimeoV = window.Vimeo;
  try {
    Object.defineProperty(window, 'Vimeo', { configurable: true,
      get: function () { return _vimeoV; },
      set: function (v) { _vimeoV = v; patchVimeoSDK(v); },
    });
  } catch (_) {}
  patchVimeoSDK(_vimeoV);

  // ── 10m. Dash.js ──────────────────────────────────────────────
  // API: dashjs.MediaPlayer().create().initialize(videoEl, url, autoPlay)
  //  or: player.attachSource(url)  (source switching)
  function _patchDashjsInst(inst) {
    if (!inst || inst.__fcd_patched_djs) return inst;
    inst.__fcd_patched_djs = true;
    ['initialize', 'attachSource', 'load'].forEach(function (m) {
      var orig = inst[m];
      if (typeof orig !== 'function') return;
      inst[m] = function (elOrUrl, url) {
        try {
          var src = typeof elOrUrl === 'string' ? elOrUrl : (typeof url === 'string' ? url : null);
          if (src && src.indexOf('http') === 0) emit(src, 'application/dash+xml', 'player-sdk-hook', 0.9);
        } catch (_) {}
        return orig.apply(this, arguments);
      };
    });
    return inst;
  }
  function patchDashJs(dashjs) {
    try {
      if (!dashjs || !dashjs.MediaPlayer) return;
      var _origMpF = dashjs.MediaPlayer;
      dashjs.MediaPlayer = function () {
        var mp = _origMpF.apply(this, arguments);
        if (!mp) return mp;
        var _origCreate = mp.create;
        if (typeof _origCreate === 'function') {
          mp.create = function () { return _patchDashjsInst(_origCreate.apply(this, arguments)); };
        }
        _patchDashjsInst(mp);
        return mp;
      };
      for (var k in _origMpF) { try { dashjs.MediaPlayer[k] = _origMpF[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _dashjsV = window.dashjs;
  try {
    Object.defineProperty(window, 'dashjs', { configurable: true,
      get: function () { return _dashjsV; },
      set: function (v) { _dashjsV = v; patchDashJs(v); },
    });
  } catch (_) {}
  patchDashJs(_dashjsV);

  // ── 10n. THEOplayer ───────────────────────────────────────────
  // Used by sports broadcasters (Eleven Sports, Canal+, DAZN affiliates, etc.)
  // API: new THEOplayer.Player(container, { source: { sources: [{src, type}] } })
  //  or: player.source = { sources: [...] }
  function patchTHEO(THEOplayer) {
    try {
      if (!THEOplayer || !THEOplayer.Player) return;
      var _OrigTP = THEOplayer.Player;
      function _emitTheoSource(src) {
        try {
          if (!src) return;
          var sources = src.sources || (src.src ? [src] : []);
          (Array.isArray(sources) ? sources : [sources]).forEach(function (s) {
            if (s && s.src) emit(s.src, s.type || null, 'player-sdk-hook', 0.9);
          });
        } catch (_) {}
      }
      THEOplayer.Player = function (el, config) {
        try { if (config && config.source) _emitTheoSource(config.source); } catch (_) {}
        var inst = new _OrigTP(el, config);
        try {
          var _srcDesc = Object.getOwnPropertyDescriptor(_OrigTP.prototype, 'source');
          Object.defineProperty(inst, 'source', {
            set: function (v) {
              try { _emitTheoSource(v); } catch (_) {}
              if (_srcDesc && _srcDesc.set) _srcDesc.set.call(inst, v);
            },
            get: function () { return _srcDesc && _srcDesc.get ? _srcDesc.get.call(inst) : undefined; },
            configurable: true,
          });
        } catch (_) {}
        return inst;
      };
      THEOplayer.Player.prototype = _OrigTP.prototype;
      for (var k in _OrigTP) { try { THEOplayer.Player[k] = _OrigTP[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _theoV = window.THEOplayer;
  try {
    Object.defineProperty(window, 'THEOplayer', { configurable: true,
      get: function () { return _theoV; },
      set: function (v) { _theoV = v; patchTHEO(v); },
    });
  } catch (_) {}
  patchTHEO(_theoV);

  // ── 10o. FLV.js ───────────────────────────────────────────────
  // Used on Bilibili live streams, AcFun, and many Chinese video sites.
  // API: flvjs.createPlayer({ type: 'flv'|'mp4'|'mse', url: '...' })
  //  then: player.attachMediaElement(videoElement); player.load();
  function patchFlvJs(flvjs) {
    try {
      if (!flvjs || typeof flvjs.createPlayer !== 'function') return;
      var _origCreate = flvjs.createPlayer;
      flvjs.createPlayer = function (mediaDataSource, config) {
        try {
          var url = mediaDataSource && mediaDataSource.url;
          var type = (mediaDataSource && mediaDataSource.type) || '';
          if (url && url.indexOf('http') === 0) {
            var mime = /flv/i.test(type) ? 'video/x-flv' : null;
            emit(url, mime, 'player-sdk-hook', 0.9);
          }
        } catch (_) {}
        return _origCreate.apply(this, arguments);
      };
      for (var k in _origCreate) { try { flvjs.createPlayer[k] = _origCreate[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _flvjsV = window.flvjs;
  try {
    Object.defineProperty(window, 'flvjs', { configurable: true,
      get: function () { return _flvjsV; },
      set: function (v) { _flvjsV = v; patchFlvJs(v); },
    });
  } catch (_) {}
  patchFlvJs(_flvjsV);

  // ── 10p. Azure Media Player (amp) ────────────────────────────
  // Used on Bloomberg, NFL.com, Microsoft, and Azure Media Services sites.
  // API: var p = amp(el, config); p.src([{src:'url', type:'mime'}])
  function _ampEmitSources(sources) {
    try {
      if (!Array.isArray(sources)) return;
      sources.forEach(function (s) {
        if (s && s.src && s.src.indexOf('http') === 0) {
          emit(s.src, s.type || null, 'player-sdk-hook', 0.9);
        }
      });
    } catch (_) {}
  }
  function _ampPatchPlayer(player) {
    if (!player || typeof player.src !== 'function') return player;
    var _origSrc = player.src;
    player.src = function (sources) {
      try { _ampEmitSources(sources); } catch (_) {}
      return _origSrc.apply(this, arguments);
    };
    return player;
  }
  function _wrapAmp(ampFn) {
    if (typeof ampFn !== 'function') return ampFn;
    function wrappedAmp(el, options, readyCb) {
      try {
        if (options) {
          _ampEmitSources(options.sourceList || options.src || options.sources);
        }
      } catch (_) {}
      var player;
      try { player = ampFn.apply(this, arguments); } catch (e) { throw e; }
      try { _ampPatchPlayer(player); } catch (_) {}
      return player;
    }
    try { for (var k in ampFn) { try { wrappedAmp[k] = ampFn[k]; } catch (_) {} } } catch (_) {}
    return wrappedAmp;
  }
  var _ampV = window.amp;
  try {
    Object.defineProperty(window, 'amp', { configurable: true,
      get: function () { return _ampV; },
      set: function (v) { _ampV = _wrapAmp(v); },
    });
  } catch (_) {}
  if (typeof _ampV === 'function') { _ampV = _wrapAmp(_ampV); }

  // ── 10q. Wistia _wq command queue ────────────────────────────
  // Wistia initializes via window._wq array: _wq.push({id:'abc123', onReady:fn})
  // We intercept push() to capture video IDs before the player loads.
  (function () {
    function _wqProcess(cmd) {
      try {
        if (!cmd || typeof cmd !== 'object') return;
        var id = cmd.id || cmd.hashedId;
        if (!id || typeof id !== 'string' || id === '_all' || id === 'all') return;
        emit('https://fast.wistia.com/embed/iframe/' + id, null, 'player-sdk-hook', 0.82);
      } catch (_) {}
    }
    function _wqPatch(arr) {
      if (!Array.isArray(arr)) return arr;
      arr.forEach(_wqProcess);
      var _origPush = arr.push;
      arr.push = function () {
        for (var i = 0; i < arguments.length; i++) _wqProcess(arguments[i]);
        return _origPush.apply(this, arguments);
      };
      return arr;
    }
    try {
      var _wqArr = _wqPatch(Array.isArray(window._wq) ? window._wq : []);
      Object.defineProperty(window, '_wq', { configurable: true,
        get: function () { return _wqArr; },
        set: function (v) { _wqArr = _wqPatch(Array.isArray(v) ? v : []); },
      });
    } catch (_) {}
  })();

  // ── 10r. Dailymotion Player SDK (DM.player) ───────────────────
  // Used on Dailymotion.com and partner sites that embed via the DM Player SDK.
  // API: DM.player(container, {video: 'xID', width:..., height:...})
  function _dmPatch(DM) {
    try {
      if (!DM || typeof DM.player !== 'function') return;
      var _origDmPlayer = DM.player;
      DM.player = function (container, config) {
        try {
          var videoId = config && (config.video || config.id || config.videoId);
          if (videoId && typeof videoId === 'string') {
            emit('https://www.dailymotion.com/embed/video/' + videoId, null, 'player-sdk-hook', 0.88);
          }
        } catch (_) {}
        return _origDmPlayer.apply(this, arguments);
      };
      for (var k in _origDmPlayer) { try { DM.player[k] = _origDmPlayer[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _dmV = window.DM;
  try {
    Object.defineProperty(window, 'DM', { configurable: true,
      get: function () { return _dmV; },
      set: function (v) { _dmV = v; _dmPatch(v); },
    });
  } catch (_) {}
  _dmPatch(_dmV);

  // ── 10s. Kaltura Player SDK (kWidget.embed / KalturaPlayer) ─────
  // Widely used in education, news, and enterprise video portals.
  // kWidget.embed({ wid: "_PARTNERID", uiconf_id: UICONFID, entry_id: "1_xxx" })
  // KalturaPlayer.setup({targetId, provider:{partnerId, uiConfId}}).loadMedia({entryId})
  (function () {
    var KALTURA_CDN = 'https://cdnapisec.kaltura.com';
    function _kalturaEmit(partnerId, entryId, targetId) {
      try {
        var pid = String(partnerId).replace(/^_/, '');
        if (!pid || !entryId) return;
        var hlsUrl = KALTURA_CDN + '/p/' + pid + '/sp/' + pid + '00/playManifest/entryId/' + entryId + '/format/applehttp/protocol/https/manifest.m3u8';
        emit(hlsUrl, null, 'player-sdk-hook', 0.87);
      } catch (_) {}
    }
    // kWidget
    function _patchKWidget(kw) {
      try {
        if (!kw || typeof kw.embed !== 'function') return;
        var _origEmbed = kw.embed;
        kw.embed = function (config) {
          try {
            var cfg = config || {};
            var wid = cfg.wid || cfg.partnerId || cfg.partner_id || '';
            var entryId = cfg.entry_id || cfg.entryId || '';
            if (wid && entryId) _kalturaEmit(wid, entryId, cfg.targetId || cfg.widgetId);
          } catch (_) {}
          return _origEmbed.apply(this, arguments);
        };
        for (var k in _origEmbed) { try { kw.embed[k] = _origEmbed[k]; } catch (_) {} }
      } catch (_) {}
    }
    var _kwV = window.kWidget;
    try {
      Object.defineProperty(window, 'kWidget', { configurable: true,
        get: function () { return _kwV; },
        set: function (v) { _kwV = v; _patchKWidget(v); },
      });
    } catch (_) {}
    _patchKWidget(_kwV);
    // KalturaPlayer — setup() returns a player; loadMedia({entryId}) is called later
    function _patchKalturaPlayer(KP) {
      try {
        if (!KP || typeof KP.setup !== 'function') return;
        var _origSetup = KP.setup;
        KP.setup = function (config) {
          var player = _origSetup.apply(this, arguments);
          try {
            var cfg = config || {};
            var provider = cfg.provider || {};
            var partnerId = provider.partnerId || provider.partner_id || '';
            if (player && partnerId && typeof player.loadMedia === 'function') {
              var _origLoad = player.loadMedia;
              player.loadMedia = function (mediaInfo) {
                try {
                  var entryId = mediaInfo && (mediaInfo.entryId || mediaInfo.entry_id || '');
                  if (entryId) _kalturaEmit(partnerId, entryId, cfg.targetId);
                } catch (_) {}
                return _origLoad.apply(this, arguments);
              };
            }
          } catch (_) {}
          return player;
        };
      } catch (_) {}
    }
    var _kpV = window.KalturaPlayer;
    try {
      Object.defineProperty(window, 'KalturaPlayer', { configurable: true,
        get: function () { return _kpV; },
        set: function (v) { _kpV = v; _patchKalturaPlayer(v); },
      });
    } catch (_) {}
    _patchKalturaPlayer(_kpV);
  })();

  // ── 10t. Flowplayer runtime hook ──────────────────────────────
  // Common in European news/media sites. API: flowplayer(container, {clip:{sources:[{src,type}]}})
  // Also: flowplayer(container, {src:"URL"}) and flowplayer(container, {playlist:[{src}]})
  (function () {
    function _fpPatch(fp) {
      try {
        if (typeof fp !== 'function') return;
        var _origFp = fp;
        var _wrapped = function (container, config) {
          try {
            var cfg = config || {};
            var srcs = [];
            var clip = cfg.clip || cfg;
            if (clip.sources) srcs = clip.sources;
            else if (cfg.playlist && cfg.playlist.length) srcs = cfg.playlist[0].sources || [cfg.playlist[0]];
            else if (cfg.src) srcs = [{ src: cfg.src, type: cfg.type || '' }];
            srcs.forEach(function (s) {
              var url = s && (s.src || s.file || s.url || '');
              if (url && typeof url === 'string') emit(url, s.type || null, 'player-sdk-hook', 0.86);
            });
          } catch (_) {}
          return _origFp.apply(this, arguments);
        };
        for (var k in _origFp) { try { _wrapped[k] = _origFp[k]; } catch (_) {} }
        window.flowplayer = _wrapped;
      } catch (_) {}
    }
    var _fpV = window.flowplayer;
    try {
      Object.defineProperty(window, 'flowplayer', { configurable: true,
        get: function () { return _fpV; },
        set: function (v) { _fpV = v; _fpPatch(v); },
      });
    } catch (_) {}
    _fpPatch(_fpV);
  })();

  // ── 10u. Brightcove Player SDK (bc) ──────────────────────────
  // Brightcove wraps Video.js. bc(el) / bc('player-id') returns a player instance.
  // We hook the player's 'loadstart' event to capture CDN URLs after they're resolved.
  function _patchBc(bcFn) {
    try {
      if (typeof bcFn !== 'function') return;
      var _origBc = bcFn;
      function _wrappedBc(elOrId, options) {
        var player;
        try { player = _origBc.apply(this, arguments); } catch (e) { throw e; }
        try {
          if (player && typeof player.ready === 'function') {
            player.ready(function () {
              try {
                // Capture current source immediately if available
                if (player.currentSrc && typeof player.currentSrc === 'function') {
                  var s = player.currentSrc();
                  if (s && s.indexOf('http') === 0) emit(s, null, 'player-sdk-hook', 0.88);
                }
                if (typeof player.on === 'function') {
                  player.on('loadstart', function () {
                    try {
                      var src = player.currentSrc && player.currentSrc();
                      if (src && src.indexOf('http') === 0) emit(src, null, 'player-sdk-hook', 0.88);
                    } catch (_) {}
                  });
                }
              } catch (_) {}
            });
          }
        } catch (_) {}
        return player;
      }
      try { for (var _bck in _origBc) { try { _wrappedBc[_bck] = _origBc[_bck]; } catch (_) {} } } catch (_) {}
      window.bc = _wrappedBc;
    } catch (_) {}
  }
  var _bcV = window.bc;
  try {
    Object.defineProperty(window, 'bc', { configurable: true,
      get: function () { return _bcV; },
      set: function (v) { _bcV = v; _patchBc(v); },
    });
  } catch (_) {}
  _patchBc(_bcV);

  // ── 10v. Wistia.embed() direct API ───────────────────────────
  // Wistia has two init patterns: _wq command queue (§10q) and Wistia.embed(id, opts).
  // Some newer Wistia integrations use Wistia.embed() directly.
  function _patchWistiaEmbed(Wistia) {
    try {
      if (!Wistia || typeof Wistia.embed !== 'function') return;
      var _origWEmbed = Wistia.embed;
      Wistia.embed = function (videoId, opts) {
        try {
          if (videoId && typeof videoId === 'string') {
            emit('https://fast.wistia.com/embed/iframe/' + videoId, null, 'player-sdk-hook', 0.86);
          }
        } catch (_) {}
        return _origWEmbed.apply(this, arguments);
      };
      for (var k in _origWEmbed) { try { Wistia.embed[k] = _origWEmbed[k]; } catch (_) {} }
    } catch (_) {}
  }
  var _wistiaEmbedV = window.Wistia;
  try {
    Object.defineProperty(window, 'Wistia', { configurable: true,
      get: function () { return _wistiaEmbedV; },
      set: function (v) { _wistiaEmbedV = v; _patchWistiaEmbed(v); },
    });
  } catch (_) {}
  _patchWistiaEmbed(_wistiaEmbedV);

  // ── 10w. SoundCloud SC.Widget API ────────────────────────────
  // SC.Widget(iframe) exposes an event bus. On READY we call getCurrentSound()
  // to get the track permalink, which the server can resolve via yt-dlp.
  try {
    function _patchSCWidget(SC) {
      if (!SC || typeof SC.Widget !== 'function') return;
      var _origWidget = SC.Widget;
      SC.Widget = function (iframeOrId) {
        var widget = _origWidget.call(this, iframeOrId);
        try {
          widget.bind(SC.Widget.Events.READY, function () {
            try {
              widget.getCurrentSound(function (sound) {
                try {
                  var url = sound && (sound.permalink_url || sound.stream_url);
                  if (url && url.indexOf('http') === 0) emit(url, null, 'player-sdk-hook', 0.84);
                } catch (_) {}
              });
            } catch (_) {}
          });
        } catch (_) {}
        return widget;
      };
      for (var _k in _origWidget) { try { SC.Widget[_k] = _origWidget[_k]; } catch (_) {} }
    }
    var _scV = window.SC;
    Object.defineProperty(window, 'SC', {
      configurable: true,
      get: function () { return _scV; },
      set: function (v) { _scV = v; _patchSCWidget(v); },
    });
    _patchSCWidget(_scV);
  } catch (_) {}

  // ── 10x. Twitch Embed / Player SDK ───────────────────────────
  // Twitch.Embed(el, {channel:'name'}) and Twitch.Player(el, {video:'v123'})
  // expose the page's Twitch target; reconstruct the canonical URL.
  try {
    function _patchTwitch(Twitch) {
      if (!Twitch) return;
      function _interceptOpts(opts) {
        try {
          var channel = opts && (opts.channel || opts.Channel);
          var video   = opts && (opts.video   || opts.Video);
          var collection = opts && opts.collection;
          if (channel)    emit('https://www.twitch.tv/' + channel, null, 'player-sdk-hook', 0.85);
          if (video)      emit('https://www.twitch.tv/videos/' + String(video).replace(/^v/i, ''), null, 'player-sdk-hook', 0.85);
          if (collection) emit('https://www.twitch.tv/collections/' + collection, null, 'player-sdk-hook', 0.82);
        } catch (_) {}
      }
      if (typeof Twitch.Embed === 'function') {
        var _origEmbed = Twitch.Embed;
        Twitch.Embed = function (el, opts) {
          _interceptOpts(opts);
          return _origEmbed.call(this, el, opts);
        };
        for (var _ke in _origEmbed) { try { Twitch.Embed[_ke] = _origEmbed[_ke]; } catch (_) {} }
      }
      if (typeof Twitch.Player === 'function') {
        var _origPlayer = Twitch.Player;
        Twitch.Player = function (el, opts) {
          _interceptOpts(opts);
          return _origPlayer.call(this, el, opts);
        };
        for (var _kp in _origPlayer) { try { Twitch.Player[_kp] = _origPlayer[_kp]; } catch (_) {} }
      }
    }
    var _twitchV = window.Twitch;
    Object.defineProperty(window, 'Twitch', {
      configurable: true,
      get: function () { return _twitchV; },
      set: function (v) { _twitchV = v; _patchTwitch(v); },
    });
    _patchTwitch(_twitchV);
  } catch (_) {}

  // ── 11. MutationObserver ──────────────────────────────────────
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (/^(VIDEO|AUDIO|SOURCE|IMG|PICTURE|TRACK)$/.test(node.tagName)) {
            emitElementMedia(node);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('video,audio,source,track,img,picture source').forEach(function (el) {
              emitElementMedia(el);
            });
            scanBackgroundImages(node);
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // ── 11b. Shadow DOM — observe media inside web component shadow roots ──
  try {
    var _origAttachShadow = HTMLElement.prototype.attachShadow;
    HTMLElement.prototype.attachShadow = function (init) {
      var shadow = _origAttachShadow.call(this, init);
      try {
        new MutationObserver(function (muts) {
          muts.forEach(function (m) {
            m.addedNodes.forEach(function (node) {
              if (node.nodeType !== 1) return;
              if (/^(VIDEO|AUDIO|SOURCE|IMG|PICTURE|TRACK)$/.test(node.tagName)) {
                emitElementMedia(node);
              }
              if (node.querySelectorAll) {
                node.querySelectorAll('video,audio,source,track,img,picture source').forEach(function (el) {
                  emitElementMedia(el);
                });
              }
            });
          });
        }).observe(shadow, { childList: true, subtree: true });
      } catch (_) {}
      return shadow;
    };
  } catch (_) {}

  // ── 12. Periodic poll ─────────────────────────────────────────
  var _ticks = 0;
  var _timer = setInterval(function () {
    if (++_ticks > 60) { clearInterval(_timer); return; }
    try {
      deepQuerySelectorAll(document, 'video,audio,img').forEach(function (el) {
        emitElementMedia(el);
      });
      performance.getEntriesByType('resource').forEach(function (e) { if (_isMediaEntry(e)) { emit(e.name, null); } });
    } catch (_) {}
    if (_ticks === 2 || _ticks === 6 || _ticks === 12 || _ticks === 20) {
      try { scanGlobals(); } catch(_) {}
    }
  }, 500);

  // ── 13. On-demand deep scan ───────────────────────────────────
  window.__fcdownloader_scan = function () {
    deepQuerySelectorAll(document, 'video,audio,source,track,img,picture source').forEach(function (el) {
      emitElementMedia(el);
    });
    try { performance.getEntriesByType('resource').forEach(function (e) { if (_isMediaEntry(e)) { emit(e.name, null); } }); }
    catch (_) {}
    scanBackgroundImages(document);
    // Inline scripts
    document.querySelectorAll('script').forEach(function (s) {
      var text = s.textContent || '';
      var re = /["'](https?:\\/\\/[^"'\\s]{8,}\\.(m3u8?|mpd|mp4|webm|jpe?g|png|webp|gif|avif|heic|mp3|m4a|aac|wav|ogg|opus|flac)[^"'\\s]*)/gi;
      var re2 = /"(?:src|file|url|source|stream|manifest|playAddr|play_addr|videoUrl|video_url|image|image_url|display_url|thumbnail|hls_url|dash_url)"\\s*:\\s*"(https?:\\/\\/[^"]{8,})"/gi;
      [re, re2].forEach(function (r) { var m; while ((m = r.exec(text))) emit(m[1], null); });
    });
    // data-* attributes
    document.querySelectorAll(
      '[data-src],[data-url],[data-video],[data-image],[data-img],[data-hls],[data-stream],[data-manifest],[data-play-url]'
    ).forEach(function (el) {
      ['data-src','data-url','data-video','data-image','data-img','data-hls','data-stream','data-manifest','data-play-url'].forEach(function (a) {
        var v = el.getAttribute(a);
        if (v && v.startsWith('http')) emit(v, null);
      });
    });
    // Globals
    scanGlobals();
    // Live JW Player
    try {
      if (window.jwplayer) {
        deepQuerySelectorAll(document, '[id]').forEach(function (el) {
          try {
            var p = jwplayer(el.id);
            if (!p || !p.getPlaylistItem) return;
            var item = p.getPlaylistItem();
            if (item && item.file) emit(item.file, null);
            (item && item.sources || []).forEach(function (s) { if (s.file) emit(s.file, s.type || null); });
          } catch (_) {}
        });
      }
    } catch (_) {}
    // Live Video.js (v6+: getPlayers(); v5 and earlier: videojs.players object).
    // If currentSrc() is empty (player constructed but not yet loaded/played),
    // fall back to internal source caches that are populated at setup time.
    try {
      if (window.videojs) {
        var _vjsInstances = [];
        try { if (videojs.getPlayers) _vjsInstances = Object.values(videojs.getPlayers()); } catch (_) {}
        try { if (!_vjsInstances.length && videojs.players) _vjsInstances = Object.values(videojs.players).filter(Boolean); } catch (_) {}
        _vjsInstances.forEach(function (p) {
          try {
            var _vjsSrc = p && p.currentSrc && p.currentSrc();
            if (_vjsSrc) { emit(_vjsSrc, null, 'page-global', 0.82); return; }
            try { if (p.cache_ && p.cache_.src) { emit(p.cache_.src, null, 'page-global', 0.78); return; } } catch (_) {}
            try {
              var _vjsSources = (p.options_ && p.options_.sources) || (p.tech_ && p.tech_.options_ && p.tech_.options_.source && [p.tech_.options_.source]) || [];
              _vjsSources.forEach(function (s) { if (s && s.src) emit(s.src, s.type || null, 'page-global', 0.78); });
            } catch (_) {}
          } catch (_) {}
        });
      }
    } catch (_) {}
    // Live HLS.js instances — Hls.instances exposes all active players for debugging
    // since v1.x. Catches manifests loaded before the constructor hook attached
    // (e.g. SSR-hydrated players that called loadSource() during module init).
    try {
      if (window.Hls && Hls.instances) {
        (Array.isArray(Hls.instances) ? Hls.instances : Array.from(Hls.instances)).forEach(function (h) {
          try { if (h && h.url) emit(h.url, 'application/vnd.apple.mpegurl', 'page-global', 0.85); } catch (_) {}
        });
      }
    } catch (_) {}
    post({ event: 'SCAN_DONE', pageUrl: location.href });
  };

  // ── 14. Initial DOM scan ──────────────────────────────────────
  function initialScan() {
    try {
      deepQuerySelectorAll(document, 'video,audio,source,track,img,picture source').forEach(function (el) {
        emitElementMedia(el);
      });
      performance.getEntriesByType('resource').forEach(function (e) { if (_isMediaEntry(e)) { emit(e.name, null); } });
      scanBackgroundImages(document);
    } catch (_) {}
    scanGlobals();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialScan);
  else initialScan();

  true;
})();
`;

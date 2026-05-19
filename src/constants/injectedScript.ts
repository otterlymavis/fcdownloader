/**
 * Injected into every frame (main + iframes) before page JS runs.
 *
 * Detection layers:
 *  1. BRIDGE_READY ping
 *  2. PerformanceObserver — catches every resource including native <video>
 *  3. fetch hook — intercepts JS fetch + response body
 *  4. XHR hook  — intercepts XHR + response body
 *  5. HTMLMediaElement src / currentSrc setters
 *  6. MediaSource / URL.createObjectURL
 *  7. hls.js / JW Player / Video.js / Shaka / Dash.js SDK hooks
 *  8. MutationObserver for dynamically added <video>/<source>
 *  9. Page-global data scan (__NEXT_DATA__, ytInitialData, TikTok, etc.)
 * 10. Periodic currentSrc poll
 * 11. window.__fcdownloader_scan() — deep on-demand scan
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

  // ── Type detection ────────────────────────────────────────────
  function detectType(url, mime) {
    if (!url) return null;
    var u = url.split('?')[0].toLowerCase();
    if (u.indexOf('.m3u8') !== -1) return 'hls';
    if (u.indexOf('.mpd')  !== -1) return 'dash';
    if (/\\.(ts|m4s|aac|m4a)$/.test(u)) return null;
    if (/\\.(mp4|webm|mov|avi|m4v)$/.test(u)) return 'hls';
    if (mime) {
      var m = String(mime).toLowerCase();
      if (m.indexOf('mpegurl') !== -1 || m.indexOf('m3u8') !== -1) return 'hls';
      if (m.indexOf('dash') !== -1  || m.indexOf('mpd')  !== -1) return 'dash';
      if (m.indexOf('mp4')  !== -1  || m.indexOf('video/') !== -1) return 'hls';
    }
    // Known video CDN domains that serve media without file extensions
    if (/\\bvideo\\.twimg\\.com\\//.test(url))                      return 'hls';
    if (/\\btiktokcdn\\.com\\//.test(url))                          return 'hls';
    if (/\\btiktokcdn-us\\.com\\//.test(url))                       return 'hls';
    if (/\\bv\\d+-webapp\\.tiktok\\.com\\//.test(url))             return 'hls'; // TikTok v19/v39
    if (/\\btiktok\\.com\\/video\\//.test(url))                     return 'hls';
    if (/\\bcdninstagram\\.com\\//.test(url))                       return 'hls';
    if (/\\bscontent[-\\w]*\\.cdninstagram\\.com\\//.test(url))    return 'hls'; // Instagram scontent
    if (/\\binstagram\\.com\\/.*\\bvideo\\b/.test(url))             return 'hls';
    if (/\\bv\\.redd\\.it\\//.test(url))                            return 'hls';
    if (/\\bfbcdn\\.net\\/.*\\bvideo/.test(url))                    return 'hls';
    if (/\\bfbcdn\\.net\\/.*\\.mp4/.test(url))                      return 'hls';
    if (/\\bdailymotion\\.com\\/cdn/.test(url))                     return 'hls';
    if (/\\bdmcdn\\.net\\//.test(url))                              return 'hls'; // Dailymotion CDN
    if (/\\bgooglevideo\\.com\\/videoplayback/.test(url))           return 'hls'; // YouTube
    if (/\\bpinimg\\.com\\/videos\\//.test(url))                    return 'hls'; // Pinterest
    if (/\\busher\\.twitch\\.tv\\//.test(url))                      return 'hls'; // Twitch
    // Generic path heuristics
    if (/\\/(master|playlist|manifest|stream|hls|dash)(\\.|\\?|\\/|$)/i.test(url) &&
        !/\\.(html?|js|css|woff|png|jpe?g|gif|svg)(\\?|$)/i.test(url)) return 'hls';
    return null;
  }

  var LOG_SEEN = new Set();
  var SKIP_EXT = /\\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf|css|js|map)(\\?|$)/i;

  function emit(url, mime) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.length < 8) return;
    var type = detectType(url, mime);
    if (!type || SEEN.has(url)) return;
    SEEN.add(url);
    post({ event: 'MEDIA_DETECTED', url: url, pageUrl: location.href,
           userAgent: navigator.userAgent, mimeType: mime || null,
           mediaType: type, timestamp: Date.now() });
  }

  function log(url) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.length < 12) return;
    if (SKIP_EXT.test(url.split('?')[0])) return;
    if (LOG_SEEN.has(url)) return;
    LOG_SEEN.add(url);
    post({ event: 'URL_CAPTURED', url: url, timestamp: Date.now() });
  }

  // ── Text scanning (JSON response bodies, page globals) ────────
  // Finds video URLs inside JSON/text blobs — critical for Twitter,
  // Reddit, TikTok, Next.js apps, and player config objects.
  function scanText(text) {
    if (!text || typeof text !== 'string' || text.length < 10) return;
    // Unescape common JSON encodings
    var variants = [
      text,
      text.replace(/\\\\\\/g, '/').replace(/\\\\u0026/g, '&').replace(/\\\\u003d/g, '=')
           .replace(/\\\\u002F/gi, '/'),
    ];
    // Extension-based URLs
    var extRe = /https?:\\/\\/[^"'\\\\\\s<>]{4,}?\\.(m3u8|mpd|mp4|webm|mov|m4v)[^"'\\\\\\s<>]*/gi;
    // Known video CDN domains (no extension needed)
    var cdnRe = /https?:\\/\\/[^"'\\\\\\s<>]*(?:video\\.twimg\\.com|tiktokcdn\\.com|tiktokcdn-us\\.com|v\\d+-webapp\\.tiktok\\.com|cdninstagram\\.com|scontent[-\\w]*\\.cdninstagram\\.com|v\\.redd\\.it|fbcdn\\.net\\/videos|vimeocdn\\.com\\/video|googlevideo\\.com\\/videoplayback|pinimg\\.com\\/videos|dmcdn\\.net|usher\\.twitch\\.tv)[^"'\\\\\\s<>]{4,}/gi;
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

  // Scan well-known page-global objects injected by React/Next.js apps,
  // TikTok, YouTube, etc. — these often contain the raw video URL.
  function scanGlobals() {
    [
      '__NEXT_DATA__',          // Twitter/X, Reddit, many Next.js apps
      'ytInitialData',          // YouTube initial page data
      'ytInitialPlayerResponse',// YouTube player response (contains stream URLs)
      '__INIT_PROPS__',         // TikTok
      'PAGE_CONTEXT_DATA',      // TikTok
      '__universal_data__',     // TikTok
      '__DEFAULT_SCOPE__',      // TikTok (newer — contains playAddr)
      '__NUXT__',               // Nuxt.js apps (Dailymotion, etc.)
      '__staticRouterHydrationData', // React Router v6 apps
    ].forEach(function (key) {
      try {
        if (window[key]) scanText(JSON.stringify(window[key]));
      } catch (_) {}
    });
    // Facebook video data injected via require()
    try {
      if (window.require && window.require.entries) {
        scanText(JSON.stringify(window.require.entries));
      }
    } catch (_) {}

    // YouTube — extract muxed video streams from ytInitialPlayerResponse directly.
    // These are the unencrypted MP4/WebM formats (usually ≤360p muxed or ≤1080p adaptive).
    // Higher-quality adaptive formats use signatureCipher which we cannot decode here.
    try {
      var ytpr = window.ytInitialPlayerResponse;
      if (!ytpr && window.ytplayer && window.ytplayer.config) {
        var raw = window.ytplayer.config.args && window.ytplayer.config.args.player_response;
        if (typeof raw === 'string') try { ytpr = JSON.parse(raw); } catch(_2) {}
      }
      if (ytpr && ytpr.streamingData) {
        var allFmts = [].concat(ytpr.streamingData.formats || [], ytpr.streamingData.adaptiveFormats || []);
        allFmts.forEach(function(f) {
          if (f && f.url && f.mimeType && f.mimeType.indexOf('video/') === 0) {
            emit(f.url, f.mimeType);
          }
        });
      }
    } catch (_) {}

    // Instagram — scan window.__additionalDataLoaded cache and bootstrap data
    try {
      ['__additionalDataLoaded', 'instagram_data', '_sharedData', '__initialData'].forEach(function(k) {
        try { if (window[k]) scanText(JSON.stringify(window[k])); } catch(_) {}
      });
    } catch (_) {}

    // Twitter/X — scan their server-side data stores
    try {
      // Twitter injects tweet data in __NEXT_DATA__ (already covered above), but also via
      // window.__initialData__ and window.FEATURE_FLAGS
      ['__initialData__', '__featureFlags', 'initialTimeline'].forEach(function(k) {
        try { if (window[k]) scanText(JSON.stringify(window[k])); } catch(_) {}
      });
      // In-memory tweet cache that Twitter's React app populates
      try {
        if (window.__TIMELINE_DATA__) scanText(JSON.stringify(window.__TIMELINE_DATA__));
        if (window._data)             scanText(JSON.stringify(window._data));
      } catch(_) {}
    } catch (_) {}

    // Threads — Meta platform sharing Instagram's CDN
    try {
      ['__bbox', '__relay_store__', 'instagramData'].forEach(function(k) {
        try { if (window[k]) scanText(JSON.stringify(window[k])); } catch(_) {}
      });
    } catch (_) {}

    // Dailymotion — player API object
    try {
      if (window.DM && window.DM.player) scanText(JSON.stringify(window.DM.player));
      if (window.dmGlobal) scanText(JSON.stringify(window.dmGlobal));
    } catch (_) {}

    // Pinterest
    try {
      if (window.__PWS_DATA__) scanText(JSON.stringify(window.__PWS_DATA__));
    } catch (_) {}

    // Modelpress / generic Japanese/Korean news embeds
    try {
      if (window.videojs && window.videojs.getPlayers) {
        Object.values(window.videojs.getPlayers()).forEach(function(p) {
          try { if (p && p.currentSrc) emit(p.currentSrc(), null); } catch(_) {}
        });
      }
    } catch (_) {}
  }

  // ── 2. PerformanceObserver ────────────────────────────────────
  try {
    var _po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) { emit(e.name, null); log(e.name); });
    });
    _po.observe({ type: 'resource', buffered: true });
  } catch (_) {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) { emit(e.name, null); log(e.name); });
      }).observe({ entryTypes: ['resource'] });
    } catch (_2) {}
  }
  try { performance.getEntriesByType('resource').forEach(function (e) { emit(e.name, null); log(e.name); }); }
  catch (_) {}

  // ── 3. fetch ──────────────────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function (resource, init) {
    var url = resource instanceof Request ? resource.url : String(resource);
    emit(url, null); log(url);
    var p = _fetch.apply(this, arguments);
    p.then(function (res) {
      try {
        var ct = res.headers && res.headers.get('Content-Type');
        if (ct) emit(url, ct);
        var base = url.split('?')[0];
        var isSegment = /\\.(ts|m4s|aac|m4a)$/i.test(base.split('/').pop() || '');
        if (!isSegment) {
          res.clone().text().then(function (text) {
            var head = (text || '').trimStart().slice(0, 40);
            if (head.indexOf('#EXTM3U') === 0) emit(url, 'application/x-mpegurl');
            else if (head.indexOf('<?xml') === 0 && text.indexOf('<MPD ') !== -1) emit(url, 'application/dash+xml');
            scanText(text);
          }).catch(function () {});
        }
      } catch (_) {}
    }).catch(function () {});
    return p;
  };

  // ── 4. XHR ────────────────────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var xurl = String(url);
    emit(xurl, null); log(xurl);
    this.addEventListener('load', function () {
      try {
        var ct = this.getResponseHeader('Content-Type');
        if (ct) emit(xurl, ct);
        var base = xurl.split('?')[0];
        var isSegment = /\\.(ts|m4s|aac|m4a)$/i.test(base.split('/').pop() || '');
        if (!isSegment && (this.responseType === '' || this.responseType === 'text')) {
          var text = this.responseText || '';
          var head = text.trimStart().slice(0, 40);
          if (head.indexOf('#EXTM3U') === 0) emit(xurl, 'application/x-mpegurl');
          else if (head.indexOf('<?xml') === 0 && text.indexOf('<MPD ') !== -1) emit(xurl, 'application/dash+xml');
          scanText(text);
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
        try { emit(String(v || ''), this.type || null); } catch (_) {}
        return desc.set.call(this, v);
      },
      configurable: true,
    });
  });

  // ── 6. URL.createObjectURL / MediaSource ──────────────────────
  var _cou = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var blobUrl = _cou(obj);
    post({ event: 'MSE_STREAM', pageUrl: location.href, timestamp: Date.now() });
    return blobUrl;
  };
  if (window.MediaSource) {
    var _addSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      post({ event: 'MSE_STREAM', mimeType: mime, pageUrl: location.href, timestamp: Date.now() });
      return _addSB.call(this, mime);
    };
  }

  // ── 7. hls.js ─────────────────────────────────────────────────
  function patchHlsJs(Hls) {
    if (!Hls || !Hls.prototype || !Hls.prototype.loadSource) return;
    var orig = Hls.prototype.loadSource;
    Hls.prototype.loadSource = function (src) {
      emit(src, 'application/x-mpegurl');
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
        emit(url, null);
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
            if (s && s.file) emit(s.file, s.type || null);
          });
          if (cfg && cfg.file) emit(cfg.file, null);
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

  // ── 10. Video.js / Dash.js ─────────────────────────────────────
  function patchVjs(v) {
    if (!v || !v.prototype || !v.prototype.src) return;
    var orig = v.prototype.src;
    v.prototype.src = function (s) {
      try {
        if (typeof s === 'string') emit(s, null);
        else if (s && s.src) emit(s.src, s.type || null);
        else if (Array.isArray(s)) s.forEach(function (x) { if (x && x.src) emit(x.src, x.type || null); });
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

  // ── 11. MutationObserver ──────────────────────────────────────
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (/^(VIDEO|AUDIO|SOURCE)$/.test(node.tagName)) {
            emit(node.src || node.currentSrc || node.getAttribute('src'), node.type || null);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('video,audio,source').forEach(function (el) {
              emit(el.src || el.currentSrc || el.getAttribute('src'), el.type || null);
            });
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // ── 12. Periodic poll ─────────────────────────────────────────
  var _ticks = 0;
  var _timer = setInterval(function () {
    if (++_ticks > 60) { clearInterval(_timer); return; }
    try {
      document.querySelectorAll('video,audio').forEach(function (el) {
        if (el.currentSrc) emit(el.currentSrc, null);
      });
      performance.getEntriesByType('resource').forEach(function (e) { emit(e.name, null); });
    } catch (_) {}
    // Scan globals on ticks 2, 6, 12, 20 (1s, 3s, 6s, 10s after load)
    if (_ticks === 2 || _ticks === 6 || _ticks === 12 || _ticks === 20) {
      try { scanGlobals(); } catch(_) {}
    }
  }, 500);

  // ── 13. On-demand deep scan ────────────────────────────────────
  window.__fcdownloader_scan = function () {
    document.querySelectorAll('video,audio,source').forEach(function (el) {
      emit(el.src || el.currentSrc || el.getAttribute('src'), el.type || null);
    });
    try { performance.getEntriesByType('resource').forEach(function (e) { emit(e.name, null); }); }
    catch (_) {}
    // Inline scripts
    document.querySelectorAll('script').forEach(function (s) {
      var text = s.textContent || '';
      var re = /["'](https?:\\/\\/[^"'\\s]{8,}\\.(m3u8|mpd|mp4|webm)[^"'\\s]*)/gi;
      var re2 = /"(?:src|file|url|source|stream|manifest|playAddr|play_addr|videoUrl|video_url|hls_url|dash_url)"\s*:\s*"(https?:\\/\\/[^"]{8,})"/gi;
      [re, re2].forEach(function (r) { var m; while ((m = r.exec(text))) emit(m[1], null); });
    });
    // data-* attributes
    document.querySelectorAll(
      '[data-src],[data-url],[data-video],[data-hls],[data-stream],[data-manifest],[data-play-url]'
    ).forEach(function (el) {
      ['data-src','data-url','data-video','data-hls','data-stream','data-manifest','data-play-url'].forEach(function (a) {
        var v = el.getAttribute(a);
        if (v && v.startsWith('http')) emit(v, null);
      });
    });
    // Globals
    scanGlobals();
    // Live JW Player
    try {
      if (window.jwplayer) {
        document.querySelectorAll('[id]').forEach(function (el) {
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
    // Live Video.js
    try {
      if (window.videojs && videojs.getPlayers) {
        Object.values(videojs.getPlayers()).forEach(function (p) {
          if (p && p.currentSrc) emit(p.currentSrc(), null);
        });
      }
    } catch (_) {}
    post({ event: 'SCAN_DONE', pageUrl: location.href });
  };

  // ── 14. Initial DOM scan ──────────────────────────────────────
  function initialScan() {
    try {
      document.querySelectorAll('video,audio,source').forEach(function (el) {
        emit(el.src || el.currentSrc || el.getAttribute('src'), el.type || null);
      });
      performance.getEntriesByType('resource').forEach(function (e) { emit(e.name, null); });
    } catch (_) {}
    scanGlobals();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialScan);
  else initialScan();

  true;
})();
`;

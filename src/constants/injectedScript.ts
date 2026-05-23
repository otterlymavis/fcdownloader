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
    if (/\\bv\\d+-webapp\\.tiktok\\.com\\//.test(url))             return 'hls';
    if (/\\btiktok\\.com\\/video\\//.test(url))                     return 'hls';
    if (/\\bcdninstagram\\.com\\//.test(url))                       return 'hls';
    if (/\\bscontent[-\\w]*\\.cdninstagram\\.com\\//.test(url))    return 'hls';
    if (/\\binstagram\\.com\\/.*\\bvideo\\b/.test(url))             return 'hls';
    if (/\\bv\\.redd\\.it\\//.test(url))                            return 'hls';
    if (/\\bfbcdn\\.net\\/.*\\bvideo/.test(url))                    return 'hls';
    if (/\\bfbcdn\\.net\\/.*\\.mp4/.test(url))                      return 'hls';
    if (/\\bdailymotion\\.com\\/cdn/.test(url))                     return 'hls';
    if (/\\bdmcdn\\.net\\//.test(url))                              return 'hls';
    if (/\\bgooglevideo\\.com\\/videoplayback/.test(url))           return 'hls';
    if (/\\bmanifest\\.googlevideo\\.com\\/api\\/manifest\\/dash/.test(url)) return 'dash';
    if (/\\bpinimg\\.com\\/videos\\//.test(url))                    return 'hls';
    if (/\\busher\\.twitch\\.tv\\//.test(url))                      return 'hls';
    if (/\\bbilivideo\\.com\\//.test(url))                          return 'hls';
    // Generic path heuristics
    if (/\\/(master|playlist|manifest|stream|hls|dash)(\\.|\\?|\\/|$)/i.test(url) &&
        !/\\.(html?|js|css|woff|png|jpe?g|gif|svg)(\\?|$)/i.test(url)) return 'hls';
    return null;
  }

  var LOG_SEEN = new Set();
  var SKIP_EXT = /\\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf|css|js|map)(\\?|$)/i;

  // Assign a confidence score based on URL/mime heuristics
  function confForUrl(url, mime, base) {
    if (!base) base = 0.5;
    if (!url) return base;
    var u = url.toLowerCase();
    if (/\\.m3u8(\\?|$)/.test(u) || /mpegurl/i.test(mime || '')) return Math.max(base, 0.85);
    if (/\\.mpd(\\?|$)/.test(u) || /dash\\+xml/i.test(mime || '')) return Math.max(base, 0.85);
    if (/\\.mp4(\\?|$)/.test(u)) return Math.max(base, 0.75);
    if (/vimeocdn\\.com.*playlist\\.json/.test(u)) return Math.max(base, 0.88);
    if (/googlevideo\\.com\\/videoplayback/.test(u)) return Math.max(base, 0.9);
    if (/bilivideo\\.com\\//.test(u)) return Math.max(base, 0.88);
    if (/manifest\\.googlevideo\\.com/.test(u)) return Math.max(base, 0.95);
    return base;
  }

  function emit(url, mime, provenance, confidence) {
    if (!url || typeof url !== 'string') return;
    url = url.trim();
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.length < 8) return;
    var type = detectType(url, mime);
    if (!type) return;
    // Allow re-emit when a concrete mime type arrives for an already-seen URL:
    // the first emit uses URL heuristics (may be wrong); the body-read emit
    // has the real Content-Type and should correct the mediaType on the app side.
    if (SEEN.has(url) && !mime) return;
    SEEN.add(url);
    var conf = confForUrl(url, mime, typeof confidence === 'number' ? confidence : 0.5);
    post({ event: 'MEDIA_DETECTED', url: url, pageUrl: location.href,
           userAgent: navigator.userAgent, mimeType: mime || null,
           mediaType: type, timestamp: Date.now(),
           provenance: provenance || 'perf-observer',
           confidence: conf });
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
  function scanText(text) {
    if (!text || typeof text !== 'string' || text.length < 10) return;
    var variants = [
      text,
      text.replace(/\\\\\\/g, '/').replace(/\\\\u0026/g, '&').replace(/\\\\u003d/g, '=')
           .replace(/\\\\u002F/gi, '/'),
    ];
    var extRe = /https?:\\/\\/[^"'\\\\\\s<>]{4,}?\\.(m3u8|mpd|mp4|webm|mov|m4v)[^"'\\\\\\s<>]*/gi;
    var cdnRe = /https?:\\/\\/[^"'\\\\\\s<>]*(?:video\\.twimg\\.com|tiktokcdn\\.com|tiktokcdn-us\\.com|v\\d+-webapp\\.tiktok\\.com|cdninstagram\\.com|scontent[-\\w]*\\.cdninstagram\\.com|v\\.redd\\.it|fbcdn\\.net\\/videos|vimeocdn\\.com\\/video|googlevideo\\.com\\/videoplayback|pinimg\\.com\\/videos|dmcdn\\.net|usher\\.twitch\\.tv|bilivideo\\.com)[^"'\\\\\\s<>]{4,}/gi;
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
            post({ event: 'PAGE_NAVIGATE', url: newUrl, timestamp: Date.now() });
          }
        } catch (_) {}
        return ret;
      };
    }
    try { wrapHistory('pushState'); } catch (_) {}
    try { wrapHistory('replaceState'); } catch (_) {}
    window.addEventListener('popstate', function () {
      try { post({ event: 'PAGE_NAVIGATE', url: location.href, timestamp: Date.now() }); } catch (_) {}
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
    ].forEach(function (key) {
      try {
        if (window[key]) scanText(JSON.stringify(window[key]));
      } catch (_) {}
    });

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
    emit(url, null, 'fetch-hook', 0.6); log(url);
    var p = _fetch.apply(this, arguments);
    p.then(function (res) {
      try {
        var ct = res.headers && res.headers.get('Content-Type');
        if (ct) emit(url, ct, 'fetch-hook', 0.7);
        var base = url.split('?')[0];
        var isSegment = /\\.(ts|m4s|aac|m4a)$/i.test(base.split('/').pop() || '');
        if (!isSegment) {
          // Track Response→URL for blob lineage
          if (_blobLineageResp) {
            try { _blobLineageResp.set(res, url); } catch(_) {}
          }
          res.clone().text().then(function (text) {
            var head = (text || '').trimStart().slice(0, 40);
            if (head.indexOf('#EXTM3U') === 0) emit(url, 'application/x-mpegurl', 'manifest-parser', 0.92);
            else if (head.indexOf('<?xml') === 0 && text.indexOf('<MPD ') !== -1) emit(url, 'application/dash+xml', 'manifest-parser', 0.92);
            scanText(text);
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
    emit(xurl, null, 'xhr-hook', 0.6); log(xurl);
    this.addEventListener('load', function () {
      try {
        var ct = this.getResponseHeader('Content-Type');
        if (ct) emit(xurl, ct, 'xhr-hook', 0.7);
        var base = xurl.split('?')[0];
        var isSegment = /\\.(ts|m4s|aac|m4a)$/i.test(base.split('/').pop() || '');
        if (!isSegment && (this.responseType === '' || this.responseType === 'text')) {
          var text = this.responseText || '';
          var head = text.trimStart().slice(0, 40);
          if (head.indexOf('#EXTM3U') === 0) emit(xurl, 'application/x-mpegurl', 'manifest-parser', 0.92);
          else if (head.indexOf('<?xml') === 0 && text.indexOf('<MPD ') !== -1) emit(xurl, 'application/dash+xml', 'manifest-parser', 0.92);
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
          post({ event: 'MSE_ACTIVE', pageUrl: location.href, timestamp: Date.now() });
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

  // ── 11. MutationObserver ──────────────────────────────────────
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (/^(VIDEO|AUDIO|SOURCE)$/.test(node.tagName)) {
            emit(node.src || node.currentSrc || node.getAttribute('src'), node.type || null, 'mutation-observer', 0.75);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('video,audio,source').forEach(function (el) {
              emit(el.src || el.currentSrc || el.getAttribute('src'), el.type || null, 'mutation-observer', 0.75);
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
    if (_ticks === 2 || _ticks === 6 || _ticks === 12 || _ticks === 20) {
      try { scanGlobals(); } catch(_) {}
    }
  }, 500);

  // ── 13. On-demand deep scan ───────────────────────────────────
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

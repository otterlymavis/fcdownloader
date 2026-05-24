/**
 * Platform-specific video URL extraction for pasted social-media page URLs.
 * Called when the user pastes a site URL (not a direct CDN URL) into the
 * manual-add field. Works best for public / unauthenticated content.
 */
import { DetectedMedia, Provenance } from '../types';
import { extractYouTubeStreams } from './ytExtractor';
import { extractViaServer } from './serverExtractor';

let _seq = 0;
const genId = () => `ext_${Date.now()}_${_seq++}`;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchHtml(url: string, ua = DESKTOP_UA): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return res.text();
}

function makeItem(url: string, pageUrl: string, label?: string, provenance: Provenance = 'social-extractor', confidence = 0.85): DetectedMedia {
  const clean = url
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .trim();
  const lower = clean.toLowerCase();
  const mediaKind = /\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(clean)
    ? 'image'
    : /\.(mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(clean)
      ? 'audio'
      : 'video';
  return {
    id: genId(),
    url: clean,
    pageUrl,
    userAgent: '',
    timestamp: Date.now(),
    mediaType: lower.includes('.mpd') ? 'dash' : lower.includes('.m3u8') ? 'hls' : 'direct',
    mediaKind,
    label,
    confidence,
    provenance,
  };
}

function extractUrls(text: string, re: RegExp): string[] {
  const results: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? m[0])
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\/g, '')
      .trim();
    if (raw.startsWith('http') && !results.includes(raw)) results.push(raw);
  }
  return results;
}

// ── TikTok ────────────────────────────────────────────────────────
async function extractTikTok(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];

    // TikTok embeds rehydration data in a script tag
    const scriptMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (scriptMatch) {
      try {
        const json = JSON.stringify(JSON.parse(scriptMatch[1]));
        extractUrls(json, /"playAddr"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u =>
          results.push(makeItem(u, pageUrl)),
        );
        extractUrls(json, /"downloadAddr"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u => {
          if (!results.some(r => r.url === makeItem(u, pageUrl).url))
            results.push(makeItem(u, pageUrl));
        });
      } catch {}
    }

    // Fallback: scan page for TikTok CDN URLs directly
    if (results.length === 0) {
      extractUrls(html, /https?:\/\/v\d+-webapp\.tiktok\.com\/[^\s"'<>]{8,}/g).forEach(u =>
        results.push(makeItem(u, pageUrl)),
      );
    }

    return results;
  } catch { return []; }
}

// ── Twitter / X ───────────────────────────────────────────────────
async function extractTwitter(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    const results: DetectedMedia[] = [];

    const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (scriptMatch) {
      extractUrls(
        scriptMatch[1],
        /https?:\\\/\\\/video\.twimg\.com\\\/[^"\\]+?\.mp4[^"\\]*/g,
      ).forEach(u => results.push(makeItem(u, pageUrl)));
    }

    // OG / Twitter card meta-tags as fallback
    extractUrls(
      html,
      /<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream|og:image(?::secure_url)?|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
    )
      .filter(u => u.startsWith('http'))
      .forEach(u => { if (!results.some(r => r.url === u)) results.push(makeItem(u, pageUrl)); });

    return results;
  } catch { return []; }
}

// ── Instagram / Threads ───────────────────────────────────────────
async function extractInstagram(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const serverItems = await extractViaServer(pageUrl);
    if (serverItems.length > 0) return serverItems;

    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];

    extractUrls(html, /"video_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g).forEach(u =>
      results.push(makeItem(u, pageUrl)),
    );

    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:cdninstagram\.com|fbcdn\.net|threadscdn\.com)[^"'\\<>\s]*\.(?:mp4|m3u8)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      const item = makeItem(u, pageUrl);
      if (!results.some(r => r.url === item.url)) results.push(item);
    });

    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:cdninstagram\.com|fbcdn\.net|threadscdn\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp|gif|avif|heic)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      const item = makeItem(u, pageUrl);
      if (!results.some(r => r.url === item.url)) results.push(item);
    });

    if (results.length === 0) {
      extractUrls(
        html,
        /<meta\s+property\s*=\s*["']og:video["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
      ).forEach(u => results.push(makeItem(u, pageUrl)));
    }

    if (results.length === 0) {
      extractUrls(
        html,
        /<meta\s+property\s*=\s*["']og:image(?::secure_url)?["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
      ).forEach(u => results.push(makeItem(u, pageUrl, 'Image')));
    }

    return results;
  } catch { return []; }
}

// ── Dailymotion ───────────────────────────────────────────────────
async function extractDailymotion(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const match = pageUrl.match(/dailymotion\.com\/video\/([A-Za-z0-9]+)/);
    if (!match) return [];
    const videoId = match[1];

    const res = await fetch(
      `https://www.dailymotion.com/player/metadata/video/${videoId}`,
      { headers: { 'User-Agent': DESKTOP_UA, 'Referer': 'https://www.dailymotion.com/' } },
    );
    const data = await res.json() as Record<string, unknown>;
    const results: DetectedMedia[] = [];

    const qualities = data.qualities as Record<string, Array<{ type?: string; url?: string }>> | undefined;
    if (qualities) {
      for (const list of Object.values(qualities)) {
        for (const q of list) {
          if (q.type === 'application/x-mpegURL' && q.url) {
            results.push(makeItem(q.url, pageUrl));
          }
        }
      }
    }

    return results;
  } catch { return []; }
}

// ── YouTube ───────────────────────────────────────────────────────

/**
 * YouTube extraction. Two on-device tiers + one optional off-device tier:
 *
 *   1. Server extractor — when the user has configured a backend running real
 *      yt-dlp (Settings → HD extractor URL). Returns whatever the server gives
 *      us, typically HD paired streams or an HLS manifest.
 *   2. InnerTube IOS / ANDROID — HLS HD when YouTube serves hlsManifestUrl
 *      (opportunistic), 360p muxed itag-18 as the guaranteed fallback.
 *
 * Page-scrape (`split("")…join("")` decipher), headless-WebView capture, and
 * the yt-dlp binary path are intentionally gone — none of them survive
 * current YouTube anti-bot / Service Worker layers in a way we can rely on.
 */
async function extractYouTube(pageUrl: string): Promise<DetectedMedia[]> {
  // Tier 1: server-assisted HD (only if user configured a backend).
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items;
  } catch (e) {
    console.warn('[extractYouTube] server extractor errored:', String(e).slice(0, 200));
  }

  // Tier 2: on-device InnerTube. Returns HLS HD when available, otherwise the
  // 360p muxed mp4. Always returns at least the 360p item if InnerTube responds.
  return extractYouTubeStreams(pageUrl);
}

// ── TVer ──────────────────────────────────────────────────────────
async function extractTVer(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const episodeMatch = pageUrl.match(/tver\.jp\/episodes\/(ep[A-Za-z0-9]+)/);
    if (!episodeMatch) return [];
    const episodeId = episodeMatch[1];

    const res = await fetch(
      `https://platform-api.tver.jp/service/api/v1/callEpisode/${episodeId}`,
      {
        headers: {
          'x-tver-platform-type': 'web',
          'Origin': 'https://tver.jp',
          'Referer': 'https://tver.jp/',
          'User-Agent': DESKTOP_UA,
        },
      },
    );
    if (!res.ok) return [];

    const json = JSON.stringify(await res.json());
    const results: DetectedMedia[] = [];

    extractUrls(json, /(https?:\/\/[^"\\]+\.m3u8[^"\\]*)/g)
      .forEach(u => results.push(makeItem(u, pageUrl)));

    if (results.length === 0) {
      extractUrls(json, /(https?:\/\/[^"\\]+\.mp4[^"\\]*)/g)
        .forEach(u => results.push(makeItem(u, pageUrl)));
    }

    return results;
  } catch { return []; }
}

// ── Facebook ──────────────────────────────────────────────────────
async function extractFacebook(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];

    for (const re of [
      /"hd_src"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /"sd_src"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /"browser_native_hd_url"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /"browser_native_sd_url"\s*:\s*"(https?:\/\/[^"]+)"/g,
    ]) {
      extractUrls(html, re).forEach(u => {
        if (!results.some(r => r.url === u)) results.push(makeItem(u, pageUrl));
      });
    }

    return results;
  } catch { return []; }
}

// ── Pinterest ─────────────────────────────────────────────────────
async function extractPinterest(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    const results: DetectedMedia[] = [];

    extractUrls(html, /"v_hlsUrl"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u =>
      results.push(makeItem(u, pageUrl)),
    );
    if (results.length === 0) {
      extractUrls(html, /"v_url"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/g).forEach(u =>
        results.push(makeItem(u, pageUrl)),
      );
    }

    return results;
  } catch { return []; }
}

// ── Bilibili ──────────────────────────────────────────────────
async function extractBilibili(pageUrl: string): Promise<DetectedMedia[]> {
  // Tier 1: server-assisted HD. Bilibili's public window.__playinfo__ for
  // logged-out users only ships the 480p `durl` track — DASH HD tracks
  // require login. The Fly backend's yt-dlp can use the server-side cookie
  // to get the real HD DASH set + auto-mux via ffmpeg, so prefer it.
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items;
  } catch (e) {
    console.warn('[extractBilibili] server extractor errored:', String(e).slice(0, 200));
  }
  // Tier 2: on-page __playinfo__. Falls back to 480p durl when DASH not given.
  return extractBilibiliLocal(pageUrl);
}

async function extractBilibiliLocal(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const serverItems = await extractViaServer(pageUrl);
    if (serverItems.length > 0) return serverItems;

    const html = await fetchHtml(pageUrl, DESKTOP_UA);
    const results: DetectedMedia[] = [];

    // Bilibili's CDN (upos-*.bilivideo.com / .biliapi.net) returns HTTP 403
    // when the request is missing `Referer: https://www.bilibili.com/` AND a
    // browser-class User-Agent. Pin both so directDownloader replays them
    // verbatim regardless of the default mobile UA.
    const bilibiliHeaders = {
      'User-Agent': DESKTOP_UA,
      'Referer':    'https://www.bilibili.com/',
      'Origin':     'https://www.bilibili.com',
      'Accept':     '*/*',
    };
    const withHeaders = (item: DetectedMedia): DetectedMedia => ({ ...item, httpHeaders: bilibiliHeaders });

    const piMatch = html.match(/window\.__playinfo__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
    if (piMatch) {
      try {
        const pi = JSON.parse(piMatch[1]);
        const data = pi?.data;
        // Prefer progressive MP4 (durl) — single file, no muxing required
        if (data?.durl?.length > 0) {
          const url = (data.durl[0].url || '').replace(/\\u0026/g, '&');
          if (url) results.push(withHeaders(makeItem(url, pageUrl, 'Bilibili MP4', 'social-extractor', 0.80)));
        } else if (data?.dash) {
          // Fallback: best video-only DASH track
          const vids = (data.dash.video || []).sort((a: any, b: any) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
          if (vids.length > 0) {
            const vUrl = (vids[0].baseUrl || vids[0].base_url || '').replace(/\\u0026/g, '&');
            if (vUrl) {
              const label = vids[0].height ? `${vids[0].height}p` : 'Bilibili';
              results.push(withHeaders(makeItem(vUrl, pageUrl, label, 'social-extractor', 0.75)));
            }
          }
        }
      } catch {}
    }

    return results;
  } catch { return []; }
}

// ── Generic OG / meta-tag fallback ────────────────────────────────
async function extractWeibo(pageUrl: string): Promise<DetectedMedia[]> {
  // Server-first because follower-only posts need the user's logged-in Weibo
  // cookies, which extractViaServer forwards from the in-app WebView to yt-dlp.
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) {
      return items.map(item => ({ ...item, label: item.label ?? 'Weibo' }));
    }
  } catch (e) {
    console.warn('[extractWeibo] server extractor errored:', String(e).slice(0, 200));
  }

  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA);
    const results: DetectedMedia[] = [];
    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:weibocdn\.com|sinaimg\.cn)[^"'\\<>\s]*\.(?:mp4|m3u8|mov|jpe?g|png|webp|gif|heic)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      const item = makeItem(u, pageUrl, 'Weibo', 'social-extractor', 0.70);
      if (!results.some(r => r.url === item.url)) results.push(item);
    });
    return results;
  } catch { return []; }
}

async function extractXiaohongshu(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) {
      return items.map(item => ({ ...item, label: item.label ?? 'Xiaohongshu' }));
    }
  } catch (e) {
    console.warn('[extractXiaohongshu] server extractor errored:', String(e).slice(0, 200));
  }

  try {
    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];
    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:xhscdn\.com|xhslink\.com)[^"'\\<>\s]*\.(?:mp4|m3u8|mov|jpe?g|png|webp|gif|heic)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      const item = makeItem(u, pageUrl, 'Xiaohongshu', 'social-extractor', 0.70);
      if (!results.some(r => r.url === item.url)) results.push(item);
    });
    return results;
  } catch { return []; }
}

async function extractOgVideo(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    return extractUrls(
      html,
      /<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
    )
      .filter(u => u.startsWith('http'))
      .map(u => makeItem(u, pageUrl));
  } catch { return []; }
}

// ── Platform registry ─────────────────────────────────────────────
const PLATFORMS: Array<{ re: RegExp; fn: (url: string) => Promise<DetectedMedia[]> }> = [
  { re: /tiktok\.com\/@[^/]+\/video\/\d+|tiktok\.com\/t\/[A-Za-z0-9]+/,          fn: extractTikTok      },
  { re: /(?:twitter|x)\.com\/[^/]+\/status\/\d+/,                                  fn: extractTwitter     },
  { re: /instagram\.com\/(?:(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+|share\/(?:p|reel)\/[A-Za-z0-9_-]+)/, fn: extractInstagram   },
  { re: /threads\.net\/@[^/]+\/post\/[A-Za-z0-9_-]+/,                              fn: extractInstagram   },
  { re: /dailymotion\.com\/video\/[A-Za-z0-9]+/,                                    fn: extractDailymotion },
  { re: /(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)[?/]?[A-Za-z0-9_-]{11}/,   fn: extractYouTube     },
  { re: /facebook\.com\/(?:watch|reel|video)|fb\.watch/,                            fn: extractFacebook    },
  { re: /pinterest\.(?:com|[a-z]{2,3})\/pin\/\d+/,                                 fn: extractPinterest   },
  { re: /tver\.jp\/episodes\/ep[A-Za-z0-9]+/,                                       fn: extractTVer        },
  { re: /(?:bilibili\.com\/video\/[ABab][Vv][A-Za-z0-9]+|m\.bilibili\.com\/video\/[ABab][Vv][A-Za-z0-9]+|b23\.tv\/[A-Za-z0-9]+|bilibili\.tv\/(?:[a-z]{2}\/)?video\/\d+)/, fn: extractBilibili    },
  { re: /(?:weibo\.com\/(?:tv\/show\/|u\/\d+|(?:\d+|0)\/[A-Za-z0-9]+)|m\.weibo\.cn\/(?:status|detail)\/[A-Za-z0-9]+|video\.weibo\.com\/show\?)/, fn: extractWeibo },
  { re: /(?:xiaohongshu\.com\/(?:explore|discovery\/item)\/[\da-f]+|xhslink\.com\/[A-Za-z0-9/?=&._-]+)/i, fn: extractXiaohongshu },
];

/** Returns true if the URL looks like a social-media post page (not a CDN media URL). */
export function isSocialPageUrl(url: string): boolean {
  return PLATFORMS.some(p => p.re.test(url));
}

/**
 * Attempts to extract video URLs from a social-media post page URL.
 * Falls back to scanning OG meta tags if the platform extractor finds nothing.
 */
export async function extractFromSocialUrl(pageUrl: string): Promise<DetectedMedia[]> {
  for (const platform of PLATFORMS) {
    if (platform.re.test(pageUrl)) {
      const items = await platform.fn(pageUrl);
      if (items.length > 0) return items;
      break;
    }
  }
  return extractOgVideo(pageUrl);
}

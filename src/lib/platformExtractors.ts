/**
 * Platform-specific video URL extraction for pasted social-media page URLs.
 * Called when the user pastes a site URL (not a direct CDN URL) into the
 * manual-add field. Works best for public / unauthenticated content.
 */
import { DetectedMedia, Provenance } from '../types';
import { extractYouTubeStreams } from './ytExtractor';
import { extractViaServer } from './serverExtractor';
import { getAcceptLanguage } from './siteRegistry';
import { debugLog, debugWarn } from './releaseLogger';

let _seq = 0;
const genId = () => `ext_${Date.now()}_${_seq++}`;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * Returns true for URLs whose hostname is a known Japanese site or ends in .jp.
 * Used to set appropriate Accept-Language + User-Agent for locale-sensitive sites.
 */
export function isJapaneseDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.jp')) return true;
    const JAPANESE_DOMAINS = [
      'nicovideo.jp', 'nico.ms', 'n.nicovideo.jp',
      'abema.tv', 'ameba.jp', 'ameblo.jp',
      'mdpr.jp', 'modelpress.jp',
      'wwd.co.jp', 'wwdjapan.com', 'natalie.mu', 'oricon.co.jp', 'kstyle.com',
      'blog.livedoor.jp', 'livedoor.blog', 'bunshun.jp', 'dailyshincho.jp',
      'news-postseven.com', 'josei7.com', 'gendai.media', 'vivi.tv',
      'cancam.jp', 'withonline.jp', 'fashion-press.net', 'fashionsnap.com',
      'thetv.jp', 'mantan-web.jp', 'crank-in.net', 'cinematoday.jp',
      'eiga.com', 'realsound.jp', 'jprime.jp', 'smart-flash.jp',
      'pixiv.net', 'fanbox.cc',
      'gyao.jp', 'hulu.jp', 'openrec.tv', 'mildom.com',
    ];
    return JAPANESE_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * Fetch HTML with locale-aware Accept-Language.
 * Locale-sensitive sites return better markup/manifests when the request
 * matches their common regional language instead of always asking for English.
 */
async function fetchHtml(url: string, ua = DESKTOP_UA, acceptLanguage?: string): Promise<string> {
  const lang = acceptLanguage ?? getAcceptLanguage(url);
  const res = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': lang,
    },
  });
  return res.text();
}

function mediaKindFromUrl(url: string): NonNullable<DetectedMedia['mediaKind']> {
  if (/\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(url)) return 'image';
  if (/\.(mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(url)) return 'audio';
  return 'video';
}

function makeItem(url: string, pageUrl: string, label?: string, provenance: Provenance = 'social-extractor', confidence = 0.85): DetectedMedia {
  const clean = url
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .trim();
  const lower = clean.toLowerCase();
  return {
    id: genId(),
    url: clean,
    pageUrl,
    userAgent: '',
    timestamp: Date.now(),
    mediaType: lower.includes('.mpd') ? 'dash' : lower.includes('.m3u8') ? 'hls' : 'direct',
    mediaKind: mediaKindFromUrl(clean),
    label,
    confidence,
    provenance,
  };
}

function pushUnique(results: DetectedMedia[], item: DetectedMedia): void {
  if (!results.some(r => r.url === item.url)) results.push(item);
}

type ExtractorResult = {
  success: boolean;
  fatal: boolean;
  reason?: string;
  media?: DetectedMedia[];
};

async function runExtractor(
  name: string,
  fn: () => Promise<DetectedMedia[]>,
): Promise<ExtractorResult> {
  debugLog(`[extract] ${name} start`);
  try {
    const media = await fn();
    if (media.length > 0) {
      debugLog(`[extract] ${name} success`);
      return { success: true, fatal: false, media };
    }
    debugLog(`[extract] ${name} failed: no media`);
    return { success: false, fatal: false, reason: 'no media' };
  } catch (e) {
    const reason = String((e as Error)?.message || e).slice(0, 240);
    debugWarn(`[extract] ${name} failed:`, reason);
    return { success: false, fatal: false, reason };
  }
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

async function extractHtmlMedia(pageUrl: string, mode: 'hls' | 'dash' | 'generic'): Promise<DetectedMedia[]> {
  const html = await fetchHtml(pageUrl);
  const results: DetectedMedia[] = [];
  const patterns =
    mode === 'hls' ? [/(https?:\/\/[^"'\\<>\s]+?\.m3u8[^"'\\<>\s]*)/gi]
    : mode === 'dash' ? [/(https?:\/\/[^"'\\<>\s]+?\.mpd[^"'\\<>\s]*)/gi]
    : [
        /(https?:\/\/[^"'\\<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov|jpe?g|png|webp|gif|avif)[^"'\\<>\s]*)/gi,
        /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:googlevideo\.com\/videoplayback|video\.twimg\.com|cdninstagram\.com|threadscdn\.com|bilivideo\.com|weibocdn\.com|xhscdn\.com|biliimg\.com|hdslb\.com|pximg\.net|yimg\.jp|kakaocdn\.net)[^"'\\<>\s]*)/gi,
      ];
  patterns.forEach((re) => {
    extractUrls(html, re)
      .filter((u) => !isLikelyNonContentMediaUrl(u))
      .forEach((u) => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.65)));
  });
  return results;
}

function isLikelyNonContentMediaUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (/\.(?:html?|php|aspx?)(?:[?#]|$)/i.test(u)) return true;
  if (/(?:doubleclick|googlesyndication|google-analytics|analytics|adservice|scorecardresearch|outbrain|taboola|treasuredata|bidswitch)/i.test(u)) return true;
  if (/(?:^|[\/_.-])(?:ad|ads|banner|beacon|tracking|tracker|counter|spacer|sprite|logo|icon|button|common|header|footer|gnb|nav|placeholder|blank|pixel)(?:[\/_.-]|$)/i.test(u)) return true;
  if (/\.gif(?:[?#]|$)/i.test(u) && !/(?:article|photo|gallery|image|upimg|contents|media|original|large)/i.test(u)) return true;
  return false;
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
          pushUnique(results, makeItem(u, pageUrl));
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
      .forEach(u => pushUnique(results, makeItem(u, pageUrl)));

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
      pushUnique(results, makeItem(u, pageUrl));
    });

    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:cdninstagram\.com|fbcdn\.net|threadscdn\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp|gif|avif|heic)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      pushUnique(results, makeItem(u, pageUrl));
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
    debugWarn('[extractYouTube] server extractor errored:', String(e).slice(0, 200));
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
      extractUrls(html, re).forEach(u => pushUnique(results, makeItem(u, pageUrl)));
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
    debugWarn('[extractBilibili] server extractor errored:', String(e).slice(0, 200));
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
    debugWarn('[extractWeibo] server extractor errored:', String(e).slice(0, 200));
  }

  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA);
    const results: DetectedMedia[] = [];
    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:weibocdn\.com|sinaimg\.cn)[^"'\\<>\s]*\.(?:mp4|m3u8|mov|jpe?g|png|webp|gif|heic)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      pushUnique(results, makeItem(u, pageUrl, 'Weibo', 'social-extractor', 0.70));
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
    debugWarn('[extractXiaohongshu] server extractor errored:', String(e).slice(0, 200));
  }

  try {
    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];
    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:xhscdn\.com|xhslink\.com)[^"'\\<>\s]*\.(?:mp4|m3u8|mov|jpe?g|png|webp|gif|heic)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      pushUnique(results, makeItem(u, pageUrl, 'Xiaohongshu', 'social-extractor', 0.70));
    });
    return results;
  } catch { return []; }
}

// ── NicoNico ──────────────────────────────────────────────────────────────────
async function extractNicoNico(pageUrl: string): Promise<DetectedMedia[]> {
  // Tier 1: server-assisted (yt-dlp knows NicoNico's API well)
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items.map(item => ({ ...item, label: item.label ?? 'NicoNico' }));
  } catch (e) {
    debugWarn('[extractNicoNico] server extractor errored:', String(e).slice(0, 200));
  }

  // Tier 2: on-page JSON. NicoNico embeds video info in window.__INITIAL_WATCH_DATA__
  // or a <script type="application/ld+json"> block.
  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA, getAcceptLanguage(pageUrl));
    const results: DetectedMedia[] = [];

    // Try window.__INITIAL_WATCH_DATA__ (newer layout)
    const dataMatch = html.match(/window\.__INITIAL_WATCH_DATA__\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/);
    if (dataMatch) {
      try {
        const json = JSON.stringify(JSON.parse(dataMatch[1]));
        extractUrls(json, /(https?:\/\/[^"\\]+\.m3u8[^"\\]*)/g)
          .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'NicoNico')));
        extractUrls(json, /"contentUrl"\s*:\s*"(https?:\/\/[^"]+)"/g)
          .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'NicoNico')));
      } catch {}
    }

    // Fallback: scan for any HLS/MP4 CDN URLs in page
    if (results.length === 0) {
      extractUrls(html, /(https?:\/\/[^"'\\<>\s]*nicovideo\.cdn[^"'\\<>\s]*\.m3u8[^"'\\<>\s]*)/g)
        .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'NicoNico')));
    }

    return results;
  } catch { return []; }
}

// ── Abema ─────────────────────────────────────────────────────────────────────
async function extractAbema(pageUrl: string): Promise<DetectedMedia[]> {
  // Server-first: yt-dlp has an Abema extractor and can handle auth
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items.map(item => ({ ...item, label: item.label ?? 'Abema' }));
  } catch (e) {
    debugWarn('[extractAbema] server extractor errored:', String(e).slice(0, 200));
  }

  // On-page HLS scan with locale-aware headers
  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA, getAcceptLanguage(pageUrl));
    const results: DetectedMedia[] = [];

    // Abema embeds media URLs in JSON-like structures within script tags
    extractUrls(html, /(https?:\/\/[^"'\\<>\s]*(?:abema(?:video)?\.com|edge\.api\.abema\.io)[^"'\\<>\s]*\.m3u8[^"'\\<>\s]*)/gi)
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'Abema')));

    extractUrls(html, /<meta\s+property\s*=\s*["']og:video["'][^>]+content\s*=\s*["']([^"']+)["']/gi)
      .filter(u => u.startsWith('http'))
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'Abema')));

    return results;
  } catch { return []; }
}

// ── Ameba ─────────────────────────────────────────────────────────────────────
async function extractNaver(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items.map(item => ({ ...item, label: item.label ?? 'Naver' }));
  } catch (e) {
    debugWarn('[extractNaver] server extractor errored:', String(e).slice(0, 200));
  }

  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA, getAcceptLanguage(pageUrl));
    const results: DetectedMedia[] = [];
    extractUrls(
      html,
      /(https?:\/\/[^"'\\<>\s]*(?:pstatic\.net|naver\.com)[^"'\\<>\s]*\.(?:m3u8|mp4)[^"'\\<>\s]*)/gi,
    ).forEach(u => pushUnique(results, makeItem(u, pageUrl, 'Naver', 'social-extractor', 0.65)));
    return results;
  } catch { return []; }
}

async function extractModelpress(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items.map(item => ({ ...item, label: item.label ?? 'Modelpress' }));
  } catch (e) {
    debugWarn('[extractModelpress] server extractor errored:', String(e).slice(0, 200));
  }

  const items = await extractJapaneseGeneric(pageUrl);
  return items.map(item => ({ ...item, label: item.label ?? 'Modelpress' }));
}

async function extractAmeba(pageUrl: string): Promise<DetectedMedia[]> {
  // Server-first
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items.map(item => ({ ...item, label: item.label ?? 'Ameba' }));
  } catch (e) {
    debugWarn('[extractAmeba] server extractor errored:', String(e).slice(0, 200));
  }

  // On-page scan with locale-aware headers
  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA, getAcceptLanguage(pageUrl));
    const results: DetectedMedia[] = [];

    extractUrls(html, /(https?:\/\/[^"'\\<>\s]*ameba(?:cdn|video)?[^"'\\<>\s]*\.(?:m3u8|mp4)[^"'\\<>\s]*)/gi)
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'Ameba')));

    // OG video fallback
    extractUrls(html, /<meta\s+property\s*=\s*["']og:video(?::url)?["'][^>]+content\s*=\s*["']([^"']+)["']/gi)
      .filter(u => u.startsWith('http'))
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'Ameba')));

    return results;
  } catch { return []; }
}

// ── Generic Japanese site ─────────────────────────────────────────────────────
/**
 * Generic fallback for Japanese streaming sites not covered by a dedicated
 * extractor. Fetches with locale-aware headers and scans for HLS/MP4/DASH URLs.
 */
async function extractCuratedArticle(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items;
  } catch (e) {
    debugWarn('[extractCuratedArticle] server extractor errored:', String(e).slice(0, 200));
  }
  return extractHtmlMedia(pageUrl, 'generic');
}

async function extractJapaneseGeneric(pageUrl: string): Promise<DetectedMedia[]> {
  // Server-first
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items;
  } catch {}

  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA, getAcceptLanguage(pageUrl));
    const results: DetectedMedia[] = [];

    const patterns: RegExp[] = [
      /(https?:\/\/[^"'\\<>\s]+?\.m3u8[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.mpd[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.mp4[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.(?:jpe?g|png|webp|gif|avif|heic)[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]*(?:contents\.oricon\.co\.jp|img-mdpr\.freetls\.fastly\.net|mdpr\.jp\/photo|ogre\.natalie\.mu|img\.thetv\.jp|img\.mantan-web\.jp|img\.cinematoday\.jp)[^"'\\<>\s]*)/gi,
    ];
    patterns.forEach(re => {
      extractUrls(html, re)
        .filter((u) => !isLikelyNonContentMediaUrl(u))
        .forEach(u => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.6)));
    });

    // OG/twitter card, including article lead images.
    extractUrls(
      html,
      /<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream|og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
    )
      .filter(u => u.startsWith('http'))
      .filter((u) => !isLikelyNonContentMediaUrl(u))
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.55)));

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
  // ── Japanese sites ──────────────────────────────────────────────────────────
  { re: /(?:nicovideo\.jp\/watch\/|nico\.ms\/)[a-zA-Z0-9]+/,                       fn: extractNicoNico    },
  { re: /abema\.tv\/video\/(?:episode|series)\/[A-Za-z0-9_-]+/,                    fn: extractAbema       },
  { re: /(?:tv\.naver\.com\/v\/\d+|now\.naver\.com\/|blog\.naver\.com\/|m\.blog\.naver\.com\/|news\.naver\.com\/|n\.news\.naver\.com\/|m\.news\.naver\.com\/|entertain\.naver\.com\/|m\.entertain\.naver\.com\/|sports\.news\.naver\.com\/|m\.sports\.naver\.com\/|naver\.me\/[A-Za-z0-9]+)/, fn: extractNaver },
  { re: /(?:mdpr\.jp\/|modelpress\.jp\/)/,                                         fn: extractModelpress  },
  { re: /(?:ameba\.jp\/[^/]+\/entry\/\d+|ameblo\.jp\/[^/]+\/entry-\d+)/,           fn: extractAmeba       },
  { re: /(?:natalie\.mu|oricon\.co\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|pixiv\.net|fanbox\.cc|t\.bilibili\.com|bilibili\.com\/(?:opus|read)|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net)/i, fn: extractCuratedArticle },
];

/** Returns true if the URL looks like a social-media post page (not a CDN media URL). */
export function isSocialPageUrl(url: string): boolean {
  return PLATFORMS.some(p => p.re.test(url));
}

/**
 * Attempts to extract video URLs from a social-media post page URL.
 * Every extractor failure is non-fatal; unsupported is only reported by the
 * caller after this full chain returns no media.
 */
export async function extractFromSocialUrl(pageUrl: string): Promise<DetectedMedia[]> {
  if (!/^https?:\/\//i.test(pageUrl)) {
    debugWarn('[extract] invalid URL or unsupported protocol:', pageUrl);
    return [];
  }
  const platform = PLATFORMS.find(p => p.re.test(pageUrl));
  const japaneseUrl = isJapaneseDomain(pageUrl);
  const strategies: Array<[string, () => Promise<DetectedMedia[]>]> = [
    ['yt-dlp extraction', () => extractViaServer(pageUrl)],
    ['platform-specific extractor', () => platform ? platform.fn(pageUrl) : Promise.resolve([])],
    // For Japanese URLs without a specific extractor, try the generic locale-aware
    // scraper before the generic English paths.
    ...(japaneseUrl && !platform
      ? [['Japanese generic extractor', () => extractJapaneseGeneric(pageUrl)] as [string, () => Promise<DetectedMedia[]>]]
      : []),
    ['WebView/runtime interception', () => Promise.resolve([])],
    ['HLS manifest detection', () => extractHtmlMedia(pageUrl, 'hls')],
    ['DASH manifest detection', () => extractHtmlMedia(pageUrl, 'dash')],
    ['OG/meta tag extraction', () => extractOgVideo(pageUrl)],
    ['generic media detection', () => extractHtmlMedia(pageUrl, 'generic')],
    ['browser playback fallback', () => Promise.resolve([])],
  ];

  const diagnostics: string[] = [];
  for (let i = 0; i < strategies.length; i += 1) {
    const [name, fn] = strategies[i];
    const result = await runExtractor(name, fn);
    if (result.success && result.media?.length) {
      debugLog(`[extract] extraction success via ${name}`);
      return result.media;
    }
    diagnostics.push(`${name}: ${result.reason ?? 'failed'}`);
    if (i < strategies.length - 1) {
      debugLog(`[extract] falling back to ${strategies[i + 1][0]}`);
    }
  }
  debugWarn('[extract] all strategies failed:', diagnostics.slice(-6).join('; '));
  return [];
}

export async function extractFromSocialUrlLegacy(pageUrl: string): Promise<DetectedMedia[]> {
  for (const platform of PLATFORMS) {
    if (platform.re.test(pageUrl)) {
      const items = await platform.fn(pageUrl);
      if (items.length > 0) return items;
      break;
    }
  }
  return extractOgVideo(pageUrl);
}

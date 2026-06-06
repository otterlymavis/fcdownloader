/**
 * Platform-specific video URL extraction for pasted social-media page URLs.
 * Called when the user pastes a site URL (not a direct CDN URL) into the
 * manual-add field. Works best for public / unauthenticated content.
 */
import { DetectedMedia, Provenance } from '../types';
import { extractYouTubeStreams } from './ytExtractor';
import { extractViaServer } from './serverExtractor';
import { getAcceptLanguage, getSiteCapabilities } from './siteRegistry';
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

function _scanHtml(html: string, pageUrl: string, mode: 'hls' | 'dash' | 'generic'): DetectedMedia[] {
  const results: DetectedMedia[] = [];
  const patterns =
    mode === 'hls' ? [/(https?:\/\/[^"'\\<>\s]+?\.m3u8[^"'\\<>\s]*)/gi]
    : mode === 'dash' ? [/(https?:\/\/[^"'\\<>\s]+?\.mpd[^"'\\<>\s]*)/gi]
    : [
        /(https?:\/\/[^"'\\<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov|mp3|m4a|ogg|opus|aac|flac|wav|jpe?g|png|webp|gif|avif)[^"'\\<>\s]*)/gi,
        /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:googlevideo\.com\/videoplayback|video\.twimg\.com|cdninstagram\.com|threadscdn\.com|bilivideo\.(?:com|cn)|weibocdn\.com|xhscdn\.com|ci\.xiaohongshu\.com|biliimg\.com|hdslb\.com|pximg\.net|yimg\.jp|kakaocdn\.net)[^"'\\<>\s]*)/gi,
      ];
  patterns.forEach((re) => {
    extractUrls(html, re)
      .filter((u) => !isLikelyNonContentMediaUrl(u))
      .forEach((u) => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.65)));
  });
  return results;
}

async function extractHtmlMedia(pageUrl: string, mode: 'hls' | 'dash' | 'generic'): Promise<DetectedMedia[]> {
  const html = await fetchHtml(pageUrl);
  return _scanHtml(html, pageUrl, mode);
}

function _scanOg(html: string, pageUrl: string): DetectedMedia[] {
  return extractUrls(
    html,
    /<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
  )
    .filter(u => u.startsWith('http'))
    .map(u => makeItem(u, pageUrl));
}

function _scanOgImage(html: string, pageUrl: string): DetectedMedia[] {
  return extractUrls(
    html,
    /<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
  )
    .filter(u => u.startsWith('http'))
    .map(u => makeItem(u, pageUrl, 'Image', 'social-extractor', 0.6));
}

// Fetch the page once and scan in HLS→DASH→OG video→generic video→OG image priority order.
// OG image is a last resort — almost all article pages have one, so we only use it
// when no video content was found.
async function extractHtmlMediaAll(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    for (const mode of ['hls', 'dash'] as const) {
      const found = _scanHtml(html, pageUrl, mode);
      if (found.length > 0) return found;
    }
    const og = _scanOg(html, pageUrl);
    if (og.length > 0) return og;
    const generic = _scanHtml(html, pageUrl, 'generic');
    if (generic.length > 0) return generic;
    return _scanOgImage(html, pageUrl);
  } catch { return []; }
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
    let targetUrl = pageUrl;
    if (targetUrl.includes('vm.tiktok.com') || targetUrl.includes('vt.tiktok.com')) {
      const res = await fetch(targetUrl, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      targetUrl = res.url;
    }
    
    const results: DetectedMedia[] = [];

    // Attempt direct API resolution if we can parse the ID
    const idMatch = targetUrl.match(/(?:video|photo|v|item)\/(\d+)/);
    if (idMatch) {
      try {
        const videoId = idMatch[1];
        const res = await fetch(`https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}`, {
          headers: { 'User-Agent': MOBILE_UA }
        });
        if (res.ok) {
          const data = await res.json();
          const aweme = data.aweme_list?.[0];
          if (aweme?.video?.play_addr?.url_list?.length > 0) {
            results.push(makeItem(aweme.video.play_addr.url_list[0], pageUrl, 'TikTok Video', 'social-extractor', 0.95));
          } else if (aweme?.image_post_info?.images) {
            aweme.image_post_info.images.forEach((img: any) => {
              const url = img?.display_image?.url_list?.[0];
              if (url) results.push(makeItem(url, pageUrl, 'TikTok Photo', 'social-extractor', 0.95));
            });
          }
          if (results.length > 0) return results;
        }
      } catch (e) {
        debugWarn('[extractTikTok] API fallback failed:', String(e).slice(0, 100));
      }
    }

    const html = await fetchHtml(targetUrl, MOBILE_UA);

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

// ── Reddit ────────────────────────────────────────────────────────
async function extractReddit(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    let targetUrl = pageUrl;
    if (targetUrl.includes('/s/')) {
      const res = await fetch(targetUrl, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      targetUrl = res.url;
    }

    const jsonUrl = targetUrl.split('?')[0].replace(/\/$/, '') + '/.json';
    const res = await fetch(jsonUrl, { headers: { 'User-Agent': DESKTOP_UA } });
    if (!res.ok) return [];

    const data = await res.json();
    const post = data[0]?.data?.children?.[0]?.data;
    const results: DetectedMedia[] = [];

    const rv = post?.secure_media?.reddit_video || post?.media?.reddit_video;
    if (rv) {
      // HLS (hls_url) carries both audio and video in one stream; fallback_url is video-only.
      const videoUrl = rv.hls_url || rv.fallback_url;
      if (videoUrl) results.push(makeItem(videoUrl, pageUrl, 'Reddit Video', 'social-extractor', 0.9));
    } else if (post?.is_gallery && post?.media_metadata) {
      // Gallery post: ordered by gallery_data.items when available
      const items: Array<{ media_id: string }> =
        Array.isArray(post.gallery_data?.items)
          ? post.gallery_data.items
          : Object.keys(post.media_metadata).map((id) => ({ media_id: id }));
      for (const { media_id } of items) {
        const meta = post.media_metadata[media_id];
        if (!meta || meta.status !== 'valid') continue;
        const srcUrl: string = (meta.s?.u || meta.s?.gif || '').replace(/&amp;/g, '&');
        if (srcUrl) pushUnique(results, makeItem(srcUrl, pageUrl, 'Reddit Image', 'social-extractor', 0.9));
      }
    } else if (post?.url && /\.(jpe?g|png|gif|webp|avif)(?:[?#]|$)/i.test(post.url)) {
      results.push(makeItem(post.url, pageUrl, 'Reddit Image', 'social-extractor', 0.9));
    }

    return results;
  } catch { return []; }
}

// ── Twitter / X ───────────────────────────────────────────────────
async function extractTwitter(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const m = pageUrl.match(/\/status\/(\d+)/);
    if (m) {
      // vxtwitter community API — returns JSON with direct media URLs, no auth needed
      const apiUrl = `https://api.vxtwitter.com/twitter/status/${m[1]}`;
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json() as {
          media_extended?: Array<{ url: string; type: string; thumbnail_url?: string; size?: { width: number; height: number } }>;
          mediaURLs?: string[];
          user_name?: string;
          text?: string;
        };
        if (data.media_extended && data.media_extended.length > 0) {
          const results: DetectedMedia[] = [];
          data.media_extended.forEach(item => {
            const entry = makeItem(item.url, pageUrl, item.type === 'photo' ? 'Image' : undefined, undefined, 0.9);
            if (item.thumbnail_url) entry.thumbnailUrl = item.thumbnail_url;
            if (item.size) { entry.width = item.size.width; entry.height = item.size.height; }
            results.push(entry);
          });
          return results;
        }
      }
    }

    // Fallback: scan SSR HTML for escaped video.twimg.com CDN URLs
    const html = await fetchHtml(pageUrl);
    const results: DetectedMedia[] = [];
    extractUrls(html, /https?:\\\/\\\/video\.twimg\.com\\\/[^"\\]+?\.(?:mp4|m3u8)[^"\\]*/g)
      .forEach(u => pushUnique(results, makeItem(u, pageUrl)));
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
      /"playable_url_quality_hd"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /"playable_url"\s*:\s*"(https?:\/\/[^"]+)"/g,
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

    // Video: HLS manifest or direct MP4
    extractUrls(html, /"v_hlsUrl"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u =>
      results.push(makeItem(u, pageUrl)),
    );
    if (results.length === 0) {
      extractUrls(html, /"v_url"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/g).forEach(u =>
        results.push(makeItem(u, pageUrl)),
      );
    }

    // Image pin: original full-res image from i.pinimg.com/originals/
    if (results.length === 0) {
      const seen = new Set<string>();
      extractUrls(html, /"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/g)
        .forEach(u => {
          if (!seen.has(u)) { seen.add(u); results.push(makeItem(u, pageUrl, 'Image', 'social-extractor', 0.85)); }
        });
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
    let targetUrl = pageUrl;
    if (targetUrl.includes('mapp.api.weibo.cn')) {
      const res = await fetch(targetUrl, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      targetUrl = res.url;
    }
    const html = await fetchHtml(targetUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];

    // Extract JSON data embedded in mobile page
    const renderDataMatch = html.match(/window\.\$render_data\s*=\s*(\[[\s\S]+?\])\[0\]/);
    if (renderDataMatch) {
      try {
        const data = JSON.parse(renderDataMatch[1])[0];
        const pics = data?.status?.pics || data?.pics;
        if (Array.isArray(pics)) {
          pics.forEach((pic: any) => {
            const url = pic?.large?.url || pic?.url;
            if (url) pushUnique(results, makeItem(url, pageUrl, 'Weibo Image', 'social-extractor', 0.85));
          });
        }
      } catch {}
    }

    extractUrls(
      html,
      /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:weibocdn\.com|sinaimg\.cn)[^"'\\<>\s]*\.(?:mp4|m3u8|mov|jpe?g|png|webp|gif|heic)[^"'\\<>\s]*)/g,
    ).forEach(u => {
      pushUnique(results, makeItem(u, pageUrl, 'Weibo', 'social-extractor', 0.70));
    });
    return results;
  } catch { return []; }
}

const XHS_GOOD_SCENES = ['WB_DFT', 'WB_MK', 'WB_PRV'];
const XHS_MEDIA_MARKERS = [
  'sns-webpic',
  'sns-img-',
  'sns-video-',
  'ci.xiaohongshu.com',
  'xhscdn.com/spectrum/',
  'xhscdn.com/media/',
  '/notes_pre_post/',
  '/note_pre_post',
];

function isXhsMediaUrl(url: string): boolean {
  const lower = String(url || '').replace(/\\\//g, '/').toLowerCase();
  if (!lower || /(?:sns-avatar|\/avatar\/|avatar|profile)/i.test(lower)) return false;
  return XHS_MEDIA_MARKERS.some(marker => lower.includes(marker));
}

function xhsBestImageUrl(img: any): string {
  const infoList = Array.isArray(img?.infoList) ? img.infoList : [];
  for (const scene of XHS_GOOD_SCENES) {
    const url = infoList.find((info: any) => info?.imageScene === scene)?.url;
    if (url && isXhsMediaUrl(url)) return url;
  }
  for (const key of ['urlDefault', 'url']) {
    const url = img?.[key];
    if (url && isXhsMediaUrl(url)) return url;
  }
  for (const info of infoList) {
    const url = info?.url;
    if (url && isXhsMediaUrl(url)) return url;
  }
  return '';
}

function xhsStreamUrl(stream: any): string {
  for (const codec of ['h264', 'h265', 'av1', 'h264_hls']) {
    const entries = Array.isArray(stream?.[codec]) ? stream[codec] : [stream?.[codec]];
    for (const entry of entries) {
      const url = entry?.masterUrl || entry?.master_url || entry?.backupUrls?.[0] || entry?.backup_urls?.[0];
      if (url && isXhsMediaUrl(url)) return url;
    }
  }
  return '';
}

// XHS CDN (xhscdn.com) rejects requests whose Referer isn't xiaohongshu.com with
// HTTP 403. The page URL we extracted from is usually an xhslink.com short link,
// so makeItem's default `Referer: pageUrl` gets blocked. Pin the Referer to the
// XHS homepage (matching the server-side extractor) and set mediaKind explicitly
// — the CDN URLs are extension-less and would otherwise be mis-typed as video.
function xhsMakeItem(
  url: string,
  pageUrl: string,
  label: string,
  kind: 'image' | 'video',
  confidence: number,
): DetectedMedia {
  return {
    ...makeItem(url, pageUrl, label, 'social-extractor', confidence),
    mediaKind: kind,
    httpHeaders: { Referer: 'https://www.xiaohongshu.com/', 'User-Agent': MOBILE_UA },
  };
}

// On-device only: scrape __INITIAL_STATE__ from the note page. Server-assisted
// extraction is handled by the caller (extractFromSocialUrl / extractionManager),
// which for XHS runs this first since the server path is gated and slow.
async function extractXiaohongshu(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    let targetUrl = pageUrl;
    if (targetUrl.includes('xhslink.com')) {
      const res = await fetch(targetUrl, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      targetUrl = res.url;
    }
    const html = await fetchHtml(targetUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];
    
    // Parse window.__INITIAL_STATE__
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?})\s*;?\s*<\/script>/);
    if (stateMatch) {
      try {
        const state = JSON.parse(stateMatch[1].replace(/undefined/g, 'null'));
        const noteDetailMap = state?.note?.noteDetailMap || {};
        for (const key of Object.keys(noteDetailMap)) {
          const note = noteDetailMap[key]?.note;
          if (!note) continue;
          
          if (Array.isArray(note.imageList)) {
            note.imageList.forEach((img: any) => {
              const url = xhsBestImageUrl(img);
              if (url && url.startsWith('http')) {
                pushUnique(results, xhsMakeItem(url, pageUrl, 'Xiaohongshu Image', 'image', 0.85));
              }
            });
          }

          const videoMasterUrl = xhsStreamUrl(note.video?.media?.stream);
          if (videoMasterUrl && videoMasterUrl.startsWith('http')) {
             pushUnique(results, xhsMakeItem(videoMasterUrl, pageUrl, 'Xiaohongshu Video', 'video', 0.90));
          }
        }
      } catch {}
    }

    if (results.length === 0) {
      // Fallback regex if __INITIAL_STATE__ parsing fails
      extractUrls(
        html,
        /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:xhscdn\.com|xiaohongshu\.com)[^"'\\<>\s]*)/g,
      ).forEach(u => {
        if (isXhsMediaUrl(u)) {
          pushUnique(results, xhsMakeItem(u, pageUrl, 'Xiaohongshu', 'image', 0.60));
        }
      });
    }

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

    // Fallback: scan for HLS CDN URLs (dmc.nico / nicovideo CDN)
    if (results.length === 0) {
      extractUrls(html, /(https?:\/\/[^"'\\<>\s]*(?:nicovideo\.cdn|dmc\.nico)[^"'\\<>\s]*\.m3u8[^"'\\<>\s]*)/g)
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

// ── Pixiv ─────────────────────────────────────────────────────────────────────
async function extractPixiv(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const m = pageUrl.match(/\/artworks?\/(\d+)/) ?? pageUrl.match(/illust_id=(\d+)/);
    if (!m) return [];
    const illustId = m[1];

    const itemHeaders = { 'User-Agent': DESKTOP_UA, Referer: 'https://www.pixiv.net/' };
    const ajaxHeaders = { ...itemHeaders, Accept: 'application/json' };

    // Fetch all page URLs
    const pagesRes = await fetch(`https://www.pixiv.net/ajax/illust/${illustId}/pages`, { headers: ajaxHeaders });
    if (!pagesRes.ok) return [];
    const pagesData = await pagesRes.json() as { body?: Array<{ urls?: { original?: string; regular?: string } }> };
    const pages = pagesData.body ?? [];
    if (!pages.length) return [];

    // Fetch illustration title (best-effort)
    let title = `Pixiv ${illustId}`;
    try {
      const metaRes = await fetch(`https://www.pixiv.net/ajax/illust/${illustId}`, { headers: ajaxHeaders });
      if (metaRes.ok) {
        const metaData = await metaRes.json() as { body?: { illustTitle?: string } };
        title = metaData.body?.illustTitle || title;
      }
    } catch {}

    const results: DetectedMedia[] = [];
    for (const page of pages) {
      const url = page.urls?.original ?? page.urls?.regular ?? '';
      if (!url.startsWith('http')) continue;
      const entry = makeItem(url, pageUrl, 'Image', 'social-extractor', 0.92);
      if (!entry.httpHeaders) entry.httpHeaders = {};
      Object.assign(entry.httpHeaders, itemHeaders);
      results.push(entry);
    }
    return results;
  } catch { return []; }
}

// ── Generic Japanese site ─────────────────────────────────────────────────────
/**
 * Generic fallback for Japanese streaming sites not covered by a dedicated
 * extractor. Fetches with locale-aware headers and scans for HLS/MP4/DASH URLs.
 */
async function extractCuratedArticle(pageUrl: string): Promise<DetectedMedia[]> {
  return extractHtmlMediaAll(pageUrl);
}

async function extractJapaneseGeneric(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA, getAcceptLanguage(pageUrl));
    const results: DetectedMedia[] = [];

    const patterns: RegExp[] = [
      /(https?:\/\/[^"'\\<>\s]+?\.m3u8[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.mpd[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.(?:mp4|m4v|webm|mov)[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.(?:mp3|m4a|ogg|opus|aac)[^"'\\<>\s]*)/gi,
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

// ── Redgifs ───────────────────────────────────────────────────────────────────
async function extractRedgifs(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const m = pageUrl.match(/\/(?:watch|ifr|gif)\/([A-Za-z0-9]+)/i);
    if (!m) return [];
    const gifId = m[1].toLowerCase();

    // Fetch temporary auth token (bound to device IP + UA)
    const tokenRes = await fetch('https://api.redgifs.com/v2/auth/temporary', {
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json' },
    });
    if (!tokenRes.ok) return [];
    const { token } = await tokenRes.json() as { token?: string };
    if (!token) return [];

    const gifRes = await fetch(`https://api.redgifs.com/v2/gifs/${gifId}`, {
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!gifRes.ok) return [];
    const data = await gifRes.json() as { gif?: { urls?: { hd?: string; sd?: string }; title?: string; thumbnail?: string } };
    const gif = data.gif;
    const url = gif?.urls?.hd ?? gif?.urls?.sd ?? '';
    if (!url.startsWith('http')) return [];

    const entry = makeItem(url, pageUrl, undefined, 'social-extractor', 0.92);
    if (gif?.thumbnail) entry.thumbnailUrl = gif.thumbnail;
    return [entry];
  } catch { return []; }
}

async function extractBluesky(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const m = pageUrl.match(/\/profile\/([^/?#]+)\/post\/([A-Za-z0-9]+)/);
    if (!m) return [];
    const actor = m[1];
    const rkey = m[2];

    const hdrs = { 'User-Agent': DESKTOP_UA, Accept: 'application/json' };

    // Resolve handle → DID (skip if actor is already a DID)
    let did = actor.startsWith('did:') ? actor : '';
    if (!did) {
      const resolveRes = await fetch(
        `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`,
        { headers: hdrs },
      );
      if (!resolveRes.ok) return [];
      const resolved = await resolveRes.json() as { did?: string };
      did = resolved.did ?? '';
      if (!did) return [];
    }

    const atUri = encodeURIComponent(`at://${did}/app.bsky.feed.post/${rkey}`);
    const threadRes = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${atUri}&depth=0&parentHeight=0`,
      { headers: hdrs },
    );
    if (!threadRes.ok) return [];

    const data = await threadRes.json() as {
      thread?: {
        post?: {
          record?: { text?: string };
          embed?: {
            $type?: string;
            playlist?: string;
            thumbnail?: string;
            aspectRatio?: { width: number; height: number };
            images?: Array<{
              fullsize?: string;
              thumb?: string;
              alt?: string;
              aspectRatio?: { width: number; height: number };
            }>;
          };
        };
      };
    };

    const post = data.thread?.post;
    if (!post) return [];
    const embed = post.embed;
    const embedType = embed?.['$type'] ?? '';
    const title = (post.record?.text ?? '').slice(0, 200) || `Bluesky post ${rkey}`;

    // Video
    if (embedType.includes('video') && embed?.playlist?.startsWith('http')) {
      const entry = makeItem(embed.playlist, pageUrl, undefined, 'social-extractor', 0.92);
      if (embed.thumbnail) entry.thumbnailUrl = embed.thumbnail;
      if (embed.aspectRatio) { entry.width = embed.aspectRatio.width; entry.height = embed.aspectRatio.height; }
      return [entry];
    }

    // Images
    if (embedType.includes('images') && embed?.images?.length) {
      const results: DetectedMedia[] = [];
      for (const img of embed.images) {
        const url = img.fullsize ?? '';
        if (!url.startsWith('http')) continue;
        const entry = makeItem(url, pageUrl, 'Image', 'social-extractor', 0.9);
        if (img.thumb) entry.thumbnailUrl = img.thumb;
        if (img.aspectRatio) { entry.width = img.aspectRatio.width; entry.height = img.aspectRatio.height; }
        results.push(entry);
      }
      return results;
    }

    return [];
  } catch { return []; }
}

async function extractTumblr(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const parsed = new URL(pageUrl);
    const m = parsed.pathname.match(/\/post\/(\d+)/);
    if (!m) return [];
    const postId = m[1];
    const host = parsed.host;

    const apiUrl = `https://${host}/api/read/json?id=${postId}`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json, text/javascript, */*', Referer: `https://${host}/` },
    });
    if (!res.ok) return [];

    // Response is JSONP: `var tumblr_api_read = {...};` — strip wrapper
    let text = await res.text();
    text = text.replace(/^var\s+tumblr_api_read\s*=\s*/, '').replace(/;\s*$/, '').trim();
    const data = JSON.parse(text) as {
      posts?: Array<{
        type?: string; slug?: string;
        'photo-url-1280'?: string; 'photo-url-500'?: string;
        photos?: Array<{ 'photo-url-1280'?: string; 'photo-url-500'?: string }>;
        'video-source'?: string; 'thumbnail-url'?: string;
      }>;
    };

    const posts = data.posts ?? [];
    if (!posts.length) return [];
    const post = posts[0];
    const postType = post.type ?? '';
    const title = post.slug || `Tumblr post ${postId}`;

    // Video
    if (postType === 'video') {
      const videoSrc = post['video-source'] ?? '';
      if (videoSrc.startsWith('http') && /\.(mp4|mov|webm)/i.test(videoSrc)) {
        const entry = makeItem(videoSrc, pageUrl, undefined, 'social-extractor', 0.9);
        const thumb = post['thumbnail-url'];
        if (thumb) entry.thumbnailUrl = thumb;
        return [entry];
      }
      return [];
    }

    // Photo / GIF / animated
    if (postType === 'photo' || postType === 'panorama') {
      const photos = post.photos ?? [];
      const urls: string[] = [];
      if (photos.length) {
        for (const p of photos) {
          const u = p['photo-url-1280'] ?? p['photo-url-500'] ?? '';
          if (u.startsWith('http')) urls.push(u);
        }
      } else {
        const u = post['photo-url-1280'] ?? post['photo-url-500'] ?? '';
        if (u.startsWith('http')) urls.push(u);
      }
      if (!urls.length) return [];
      return urls.map((u, i) =>
        makeItem(u, pageUrl, 'Image', 'social-extractor', 0.9),
      );
    }

    return [];
  } catch { return []; }
}

async function extractMastodon(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const parsed = new URL(pageUrl);
    // Mastodon status URL patterns:
    // /@{user}/{snowflake_id}       -- primary format
    // /users/{user}/statuses/{id}   -- older ActivityPub format
    const m = parsed.pathname.match(/\/(?:@[^/?#]+|users\/[^/?#]+\/statuses)\/(\d{17,20})(?:[/?#]|$)/);
    if (!m) return [];
    const statusId = m[1];
    const baseUrl = `${parsed.protocol}//${parsed.host}`;

    const res = await fetch(`${baseUrl}/api/v1/statuses/${statusId}`, {
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      content?: string;
      media_attachments?: Array<{
        id?: string; type?: string; url?: string; preview_url?: string;
        description?: string;
        meta?: { original?: { width?: number; height?: number } };
      }>;
    };

    const attachments = data.media_attachments ?? [];
    if (!attachments.length) return [];

    const title = (data.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200)
      || `Mastodon post ${statusId}`;
    const results: DetectedMedia[] = [];
    for (const att of attachments) {
      const url = att.url ?? '';
      if (!url.startsWith('http')) continue;
      const entry = makeItem(url, pageUrl, att.type === 'image' ? 'Image' : undefined, 'social-extractor', 0.92);
      if (att.preview_url) entry.thumbnailUrl = att.preview_url;
      const orig = att.meta?.original;
      if (orig?.width && orig?.height) { entry.width = orig.width; entry.height = orig.height; }
      results.push(entry);
    }
    return results;
  } catch { return []; }
}

// ── Platform registry ─────────────────────────────────────────────
const PLATFORMS: Array<{ re: RegExp; fn: (url: string) => Promise<DetectedMedia[]> }> = [
  { re: /tiktok\.com\/@[^/]+\/(?:video|photo|item)\/\d+|tiktok\.com\/(?:t|v)\/[A-Za-z0-9]+|vm\.tiktok\.com\/[A-Za-z0-9]+/, fn: extractTikTok },
  { re: /(?:twitter|x)\.com\/[^/]+\/status\/\d+/,                                  fn: extractTwitter     },
  { re: /redgifs\.com\/(?:watch|ifr|gif)\/[A-Za-z0-9]+/i,                          fn: extractRedgifs     },
  { re: /bsky\.app\/profile\/[^/?#]+\/post\/[A-Za-z0-9]+/,                         fn: extractBluesky     },
  { re: /\.tumblr\.com\/post\/\d+/,                                                fn: extractTumblr      },
  // Mastodon: detect by snowflake ID in path — works across all fediverse instances
  { re: /\/(?:@[^/?#]+|users\/[^/?#]+\/statuses)\/\d{17,20}(?:[/?#]|$)/,          fn: extractMastodon    },
  { re: /instagram\.com\/(?:(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+|share\/(?:p|reel)\/[A-Za-z0-9_-]+)/, fn: extractInstagram   },
  { re: /threads\.net\/@[^/]+\/post\/[A-Za-z0-9_-]+/,                              fn: extractInstagram   },
  { re: /dailymotion\.com\/video\/[A-Za-z0-9]+/,                                    fn: extractDailymotion },
  { re: /(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)[?/]?[A-Za-z0-9_-]{11}/,   fn: extractYouTube     },
  { re: /facebook\.com\/(?:watch|reel|video)|fb\.watch/,                            fn: extractFacebook    },
  { re: /pinterest\.(?:com|[a-z]{2,3})\/pin\/\d+/,                                 fn: extractPinterest   },
  { re: /reddit\.com\/(?:r\/[^/]+\/s\/[A-Za-z0-9]+|r\/[^/]+\/comments\/[A-Za-z0-9]+)/, fn: extractReddit  },
  { re: /tver\.jp\/episodes\/ep[A-Za-z0-9]+/,                                       fn: extractTVer        },
  { re: /(?:bilibili\.com\/video\/[ABab][Vv][A-Za-z0-9]+|m\.bilibili\.com\/video\/[ABab][Vv][A-Za-z0-9]+|b23\.tv\/[A-Za-z0-9]+|bilibili\.tv\/(?:[a-z]{2}\/)?video\/\d+|t\.bilibili\.com\/\d+|bilibili\.com\/(?:opus|read)\/\d+)/, fn: extractBilibili    },
  { re: /(?:weibo\.com\/(?:tv\/show\/|u\/\d+|(?:\d+|0)\/[A-Za-z0-9]+)|m\.weibo\.cn\/(?:status|detail)\/[A-Za-z0-9]+|video\.weibo\.com\/show\?|mapp\.api\.weibo\.cn\/)/, fn: extractWeibo },
  { re: /(?:(?:xiaohongshu|rednote)\.com\/(?:explore|discovery\/item)\/[\da-f]+|xhslink\.com\/[A-Za-z0-9/?=&._-]+)/i, fn: extractXiaohongshu },
  // ── Japanese sites ──────────────────────────────────────────────────────────
  { re: /(?:nicovideo\.jp\/watch\/|nico\.ms\/)[a-zA-Z0-9]+/,                       fn: extractNicoNico    },
  { re: /abema\.tv\/video\/(?:episode|series)\/[A-Za-z0-9_-]+/,                    fn: extractAbema       },
  { re: /(?:tv\.naver\.com\/v\/\d+|now\.naver\.com\/|blog\.naver\.com\/|m\.blog\.naver\.com\/|news\.naver\.com\/|n\.news\.naver\.com\/|m\.news\.naver\.com\/|entertain\.naver\.com\/|m\.entertain\.naver\.com\/|sports\.news\.naver\.com\/|m\.sports\.naver\.com\/|naver\.me\/[A-Za-z0-9]+)/, fn: extractNaver },
  { re: /(?:mdpr\.jp\/|modelpress\.jp\/)/,                                         fn: extractModelpress  },
  { re: /(?:ameba\.jp\/[^/]+\/entry\/\d+|ameblo\.jp\/[^/]+\/entry-\d+)/,           fn: extractAmeba       },
  { re: /pixiv\.net\/(?:en\/)?artworks?\/\d+|pixiv\.net\/.*illust_id=\d+/,         fn: extractPixiv       },
  { re: /(?:natalie\.mu|oricon\.co\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|fanbox\.cc|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net|trilltrill\.jp|note\.com|lineblog\.me|hatenablog\.(?:com|jp)|hatenadiary\.(?:com|jp)|hatena\.ne\.jp|blog\.fc2\.com|gyazo\.com|seiga\.nicovideo\.jp|story\.kakao\.com)/i, fn: extractCuratedArticle },
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
const _SHORT_URL_RE = /^https?:\/\/(?:t\.co|bit\.ly|tinyurl\.com|ow\.ly|buff\.ly|dlvr\.it|fb\.me|goo\.gl|j\.mp|ln\.is|ift\.tt|wp\.me|naver\.me|amzn\.to)\//i;

async function resolveShortUrl(url: string): Promise<string> {
  if (!_SHORT_URL_RE.test(url)) return url;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (res.url && res.url !== url) return res.url;
  } catch {}
  return url;
}

export async function extractFromSocialUrl(pageUrl: string): Promise<DetectedMedia[]> {
  if (!/^https?:\/\//i.test(pageUrl)) {
    debugWarn('[extract] invalid URL or unsupported protocol:', pageUrl);
    return [];
  }
  pageUrl = await resolveShortUrl(pageUrl);
  const platform = PLATFORMS.find(p => p.re.test(pageUrl));
  const japaneseUrl = isJapaneseDomain(pageUrl);
  // For sites the server can't extract without a session (Xiaohongshu), run the
  // on-device platform extractor before the gated, slow server round-trip.
  const serverFirst = !getSiteCapabilities(pageUrl)?.preferOnDevice;
  const serverStep: [string, () => Promise<DetectedMedia[]>] =
    ['yt-dlp extraction', () => extractViaServer(pageUrl)];
  const platformStep: [string, () => Promise<DetectedMedia[]>] =
    ['platform-specific extractor', () => platform ? platform.fn(pageUrl) : Promise.resolve([])];
  const strategies: Array<[string, () => Promise<DetectedMedia[]>]> = [
    ...(serverFirst ? [serverStep, platformStep] : [platformStep, serverStep]),
    // For Japanese URLs without a specific extractor, try the generic locale-aware
    // scraper before the generic English paths.
    ...(japaneseUrl && !platform
      ? [['Japanese generic extractor', () => extractJapaneseGeneric(pageUrl)] as [string, () => Promise<DetectedMedia[]>]]
      : []),
    ['WebView/runtime interception', () => Promise.resolve([])],
    // Single page fetch; scans HLS→DASH→OG→generic in priority order.
    ['HTML media scan', () => extractHtmlMediaAll(pageUrl)],
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

/**
 * Platform-specific video URL extraction for pasted social-media page URLs.
 * Called when the user pastes a site URL (not a direct CDN URL) into the
 * manual-add field. Works best for public / unauthenticated content.
 */
import { Platform } from 'react-native';
import { DetectedMedia, Provenance } from '../types';
import { extractYouTubeStreams } from './ytExtractor';
import { extractViaServer } from './serverExtractor';
import { getAcceptLanguage, getSiteCapabilities } from './siteRegistry';
import { debugLog, debugWarn } from './releaseLogger';
import { prewarmWeiboVisitorSession, fetchWeiboStatuses } from './weiboPrewarm';
import { extractSessionCookies } from './cookieManager';

let _seq = 0;
const genId = () => `ext_${Date.now()}_${_seq++}`;
const MAX_GENERIC_SCAN_RESULTS = 80;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const FACEBOOK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const REDDIT_DOWNLOAD_HEADERS = { Referer: 'https://www.reddit.com/' };
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
      'eiga.com', 'entamenext.com', 'realsound.jp', 'jprime.jp', 'smart-flash.jp',
      'pixiv.net', 'fanbox.cc',
      'gyao.jp', 'hulu.jp', 'openrec.tv', 'mildom.com',
      'lemino.docomo.ne.jp', 'animestore.docomo.ne.jp', 'video.dmkt-sp.jp',
      'unext.jp', 'video.unext.jp', 'telasa.jp', 'plus.nhk.jp',
      'nhk-ondemand.jp', 'wowow.co.jp', 'wod.wowow.co.jp', 'b-ch.com',
      'bandainamcoid.com', 'tv.rakuten.co.jp', 'jod.jsports.co.jp',
      'jsports.co.jp', 'spoox.skyperfectv.co.jp', 'skyperfectv.co.jp',
      'locipo.jp', 'dougaizm.mbs.jp', 'mbs.jp', 'ytv.co.jp',
      'video.tv-tokyo.co.jp', 'douga.tv-asahi.co.jp', 'ktv-smart.jp',
      'ktv.jp', 'vod.ntv.co.jp', 'cu.ntv.co.jp',
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
  // res.text() fails on React Native iOS for Shift-JIS encoded pages (iOS charset decode bug);
  // arrayBuffer + permissive UTF-8 decode preserves ASCII CDN URLs even on non-UTF-8 pages.
  const buf = await res.arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

function mediaKindFromUrl(url: string): NonNullable<DetectedMedia['mediaKind']> {
  if (/\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(url)) return 'image';
  if (/\.(mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(url)) return 'audio';
  return 'video';
}

function makeItem(url: string, pageUrl: string, label?: string, provenance: Provenance = 'social-extractor', confidence = 0.85, forcedKind?: DetectedMedia['mediaKind']): DetectedMedia {
  const raw = url
    .replace(/&#x([0-9a-fA-F]{1,4});/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#([0-9]{1,5});/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .replace(/&(?:quot|lt|gt|apos);.*/gi, '')  // strip HTML entity tail (from unescaped HTML context)
    .replace(/[);,\s"']+$/, '')                 // strip trailing delimiters
    .trim();
  let clean = raw;
  try {
    clean = new URL(raw, pageUrl).toString();
  } catch {}
  const lower = clean.toLowerCase();
  return {
    id: genId(),
    url: clean,
    pageUrl,
    userAgent: '',
    timestamp: Date.now(),
    mediaType: lower.includes('.mpd') ? 'dash' : /\.m3u8?(?:[?#]|$)/i.test(lower) ? 'hls' : 'direct',
    mediaKind: forcedKind ?? mediaKindFromUrl(clean),
    label,
    confidence,
    provenance,
  };
}

function pushUnique(results: DetectedMedia[], item: DetectedMedia): void {
  if (!results.some(r => r.url === item.url)) results.push(item);
}

function capGenericResults(items: DetectedMedia[]): DetectedMedia[] {
  return items.slice(0, MAX_GENERIC_SCAN_RESULTS);
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

function cleanExtractedUrl(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]{1,4});/g, (_, h) => String.fromCharCode(parseInt(h, 16))) // &#x3A; → :
    .replace(/&#([0-9]{1,5});/g, (_, d) => String.fromCharCode(parseInt(d, 10)))         // &#58; → :
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .replace(/&(?:quot|lt|gt|apos);.*/gi, '')  // strip HTML entities that mark end of URL
    .replace(/[);,\s"']+$/, '')                 // strip trailing delimiter characters
    .trim();
}

function extractUrls(text: string, re: RegExp): string[] {
  const results: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const raw = cleanExtractedUrl((m[1] ?? m[0]) as string);
    if (raw.startsWith('http') && !results.includes(raw)) results.push(raw);
  }
  return results;
}

function extractUrlCandidates(text: string, re: RegExp): string[] {
  const results: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const raw = cleanExtractedUrl(String(m[1] ?? m[0] ?? ''));
    if (!raw || /^(?:data:|blob:|javascript:|mailto:|#)/i.test(raw)) continue;
    if (!results.includes(raw)) results.push(raw);
  }
  return results;
}

function normalizeWordPressImageUrl(url: string): string {
  // Strip WordPress size/scaled suffix before the extension so on-device extraction
  // returns full-size originals rather than layout thumbnails.
  // Handles: image-300x200.jpg, image_1024x768.png, image-scaled.jpg
  return url.replace(/[-_](?:\d{2,4}x\d{2,4}|scaled)(?=\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$))/i, '');
}

function _scanHtml(html: string, pageUrl: string, mode: 'hls' | 'dash' | 'generic'): DetectedMedia[] {
  const results: DetectedMedia[] = [];
  type PatternSpec = { re: RegExp; kind?: DetectedMedia['mediaKind'] };
  const patternSpecs: PatternSpec[] =
    mode === 'hls' ? [{ re: /(https?:\/\/[^"'\\<>\s]+?\.m3u8?[^"'\\<>\s]*)/gi }]
    : mode === 'dash' ? [{ re: /(https?:\/\/[^"'\\<>\s]+?\.mpd[^"'\\<>\s]*)/gi }]
    : [
        { re: /(https?:\/\/[^"'\\<>\s]+?\.(?:m3u8|m3u|mpd|mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp|mp3|m4a|ogg|opus|aac|flac|wav|jpe?g|png|webp|gif|avif|heic)[^"'\\<>\s]*)/gi },
        { re: /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:googlevideo\.com\/videoplayback|video\.twimg\.com|cdninstagram\.com|threadscdn\.com|bilivideo\.(?:com|cn)|weibocdn\.com|xhscdn\.com|ci\.xiaohongshu\.com|biliimg\.com|hdslb\.com|pximg\.net|yimg\.jp|kakaocdn\.net|daumcdn\.net|akamaized\.net|cloudfront\.net|jwpcdn\.com|jwplatform\.com|kaltura\.com|mux\.com|mux\.dev)[^"'\\<>\s)]*)/gi },
        // Japanese publisher CDN domains — force image kind since these are editorial image CDNs
        // and their URLs may lack a file extension (CDN transform params like w=,h=,f=webp)
        { re: /(https?:\/\/[^"'\\<>\s]*(?:contents\.oricon\.co\.jp|img-mdpr\.freetls\.fastly\.net|mdpr\.jp\/photo|ogre\.natalie\.mu|img\.thetv\.jp|img\.mantan-web\.jp|storage\.mantan-web\.jp|img\.cinematoday\.jp|images\.microcms-assets\.io|cdn-ak\.f\.st-hatena\.com|imgix\.net|cdn\.clipkit\.co|i\.gzn\.jp|res\.cloudinary\.com|webaccel\.jp|ismcdn\.jp|img\.cf\.47news\.jp)[^"'\\<>\s)]*)/gi, kind: 'image' },
        // CSS background-image:url(...) — always an image
        { re: /background-image\s*:\s*url\(\s*['"]?(https?:\/\/[^'")\s]{10,})['"]?\s*\)/gi, kind: 'image' },
        { re: /<(?:video|audio|source)\b[^>]{0,400}?\bsrc=["']([^"'<>\\\s]{2,})["']/gi },
        // img tags — always image regardless of whether URL has a file extension
        { re: /<img\b[^>]{0,600}?\bsrc=["']([^"'<>\\\s]{4,})["']/gi, kind: 'image' },
        { re: /<img\b[^>]{0,600}?\bdata-(?:src|lazy|lazy-src|original|origin|url|img-src|image-src)=["']([^"'<>\\\s]{4,})["']/gi, kind: 'image' },
        { re: /<source\b[^>]{0,600}?\bsrcset=["']([^\s,'"<>]{4,})/gi, kind: 'image' },
        { re: /<(?:video|source)\b[^>]{0,400}?\bdata-src=["']([^"'<>\\\s]{2,})["']/gi },
        { re: /<[a-z][a-z0-9-]*\b[^>]{0,600}?\bdata-(?:video-url|stream-url|media-url|video-src|stream-src|hls-url|mp4-url|mp4|m3u8|hls|download-url|file)=["']([^"'<>\\\s]{2,})["']/gi },
      ];
  patternSpecs.forEach(({ re, kind }) => {
    extractUrlCandidates(html, re)
      .filter((u) => !/^(?:data:|blob:|javascript:|mailto:|#)/i.test(u))
      .filter((u) => !isLikelyNonContentMediaUrl(u))
      .map(normalizeWordPressImageUrl)
      .forEach((u) => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.65, kind)));
  });
  return results;
}

async function extractHtmlMedia(pageUrl: string, mode: 'hls' | 'dash' | 'generic'): Promise<DetectedMedia[]> {
  const html = await fetchHtml(pageUrl);
  return _scanHtml(html, pageUrl, mode);
}

function _scanOg(html: string, pageUrl: string): DetectedMedia[] {
  const seen = new Set<string>();
  const results: DetectedMedia[] = [];
  const add = (u: string) => {
    if (u.startsWith('http') && !seen.has(u)) { seen.add(u); results.push(makeItem(u, pageUrl)); }
  };
  extractUrls(html, /<meta\s[^>]*?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]*?content\s*=\s*["']([^"']+)["']/gi).forEach(add);
  extractUrls(html, /<meta\s[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream)["']/gi).forEach(add);
  return results;
}

function _scanOgImage(html: string, pageUrl: string): DetectedMedia[] {
  const seen = new Set<string>();
  const results: DetectedMedia[] = [];
  const add = (u: string) => {
    if (u.startsWith('http') && !seen.has(u)) {
      seen.add(u);
      results.push(makeItem(u, pageUrl, 'Image', 'social-extractor', 0.6, 'image'));
    }
  };
  // Handle both attribute orderings: property="og:image" content="..." and content="..." property="og:image"
  extractUrls(html,
    /<meta\s[^>]*?(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["'][^>]*?content\s*=\s*["']([^"']+)["']/gi,
  ).forEach(add);
  extractUrls(html,
    /<meta\s[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["']/gi,
  ).forEach(add);
  return results;
}

function _scanPageThumbnail(html: string, pageUrl: string): string | undefined {
  const patterns = [
    /<(?:video|audio)\b[^>]{0,600}?\bposter=["']([^"']+)["']/i,
    /<meta\s[^>]*?(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["'][^>]*?content\s*=\s*["']([^"']+)["']/i,
    /<meta\s[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["']/i,
  ];
  for (const re of patterns) {
    const raw = html.match(re)?.[1]?.replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/\\\//g, '/').trim();
    if (!raw || /^(?:data:|blob:|javascript:|mailto:|#)/i.test(raw)) continue;
    try { return new URL(raw, pageUrl).toString(); } catch {}
  }
  return undefined;
}

function _scanStructuredMediaData(html: string, pageUrl: string): DetectedMedia[] {
  const results: DetectedMedia[] = [];
  const thumbnails: string[] = [];
  const mediaUrlKey = /(?:video|audio|media|stream|play|file|download|hls|mp4|dash|manifest|content|source|src)(?:url|src|file|path|link)?$/i;
  const add = (url?: unknown) => {
    if (typeof url !== 'string') return;
    const raw = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/').trim();
    if (!raw || /^(?:data:|blob:|javascript:|mailto:|#)/i.test(raw)) return;
    if (/^[{[]/.test(raw)) return;
    let clean = raw;
    try { clean = new URL(raw, pageUrl).toString(); } catch {}
    if (/%7b|%7d|%5b|%5d/i.test(clean)) return;
    if (!clean.startsWith('http') || isLikelyNonContentMediaUrl(clean)) return;
    pushUnique(results, makeItem(clean, pageUrl, undefined, 'social-extractor', 0.72));
  };
  const walkSchema = (obj: unknown, mediaContext = false) => {
    if (Array.isArray(obj)) {
      obj.forEach(item => walkSchema(item, mediaContext));
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    const rawType = record['@type'] ?? record.type ?? '';
    const type = Array.isArray(rawType) ? rawType.join(' ').toLowerCase() : String(rawType).toLowerCase();
    const isMedia = mediaContext || /(?:videoobject|audioobject|mediaobject)/i.test(type);
    if (isMedia) {
      add(record.contentUrl ?? record.contentURL ?? record.url ?? record.downloadUrl ?? record.downloadURL);
      add(record.embedUrl ?? record.embedURL);
      const thumb = record.thumbnailUrl ?? record.thumbnailURL ?? record.thumbnail;
      const thumbValue = Array.isArray(thumb) ? thumb[0] : thumb;
      if (typeof thumbValue === 'string') {
        try { thumbnails.push(normalizeWordPressImageUrl(new URL(thumbValue, pageUrl).toString())); } catch {}
      } else if (thumbValue && typeof thumbValue === 'object') {
        const nested = (thumbValue as Record<string, unknown>).url ?? (thumbValue as Record<string, unknown>).contentUrl;
        if (typeof nested === 'string') {
          try { thumbnails.push(normalizeWordPressImageUrl(new URL(nested, pageUrl).toString())); } catch {}
        }
      }
    }
    ['associatedMedia', 'video', 'audio', 'media', 'encoding', 'encodings'].forEach((key) => {
      if (key in record) walkSchema(record[key], isMedia);
    });
  };
  const walkHydration = (obj: unknown, depth = 0, mediaContext = false) => {
    if (depth > 10) return;
    if (Array.isArray(obj)) {
      obj.forEach(item => walkHydration(item, depth + 1, mediaContext));
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    const rawType = record['@type'] ?? record.type ?? record.kind ?? '';
    const type = Array.isArray(rawType) ? rawType.join(' ').toLowerCase() : String(rawType).toLowerCase();
    const nextMediaContext = mediaContext || /(?:video|audio|media|stream|player|asset|source|track|file)/i.test(type);
    Object.entries(record).forEach(([key, value]) => {
      const keyIsMedia = mediaUrlKey.test(key);
      if (typeof value === 'string') {
        if (keyIsMedia || nextMediaContext || /\.(?:m3u8|m3u|mpd|mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp|mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(value)) {
          add(value);
        }
        if (/thumb|poster|image/i.test(key) && !isLikelyNonContentMediaUrl(value)) {
          try { thumbnails.push(normalizeWordPressImageUrl(new URL(value, pageUrl).toString())); } catch {}
        }
        return;
      }
      if (value && typeof value === 'object') walkHydration(value, depth + 1, nextMediaContext || keyIsMedia);
    });
  };

  const ldRe = /<script\b[^>]*?\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try { walkSchema(JSON.parse(ldMatch[1])); } catch {}
  }

  const hydrationRe = /<script\b(?=[^>]*(?:id=["'](?:__NEXT_DATA__|__NUXT_DATA__|__APOLLO_STATE__|__INITIAL_STATE__|__INITIAL_DATA__|app-data)["']|type=["']application\/json["']))[^>]*>([\s\S]*?)<\/script>/gi;
  let hydrationMatch: RegExpExecArray | null;
  while ((hydrationMatch = hydrationRe.exec(html)) !== null) {
    try { walkHydration(JSON.parse(hydrationMatch[1])); } catch {}
  }

  extractUrls(html, /<(?:enclosure|media:content)\b[^>]*?\burl=["']([^"']{10,})["']/gi).forEach(add);

  const keyRe = /"(?:video|audio|media|stream|play|file|download|hls|mp4|dash|manifest|content)(?:Url|_url|URL|Src|_src|File|_file|Path|_path|Link)?"\s*:\s*"(https?:\/\/[^"]{10,})"|"(?:source|src)(?:Url|_url|URL|Src|_src|File|_file|Path|_path|Link)+"\s*:\s*"(https?:\/\/[^"]{10,})"/gi;
  const imageish = /(?:\.(?:jpe?g|png|gif|webp|svg|avif|bmp|ico)(?:[?#][^"]*)?$|\/(?:thumbnails?|thumbs?|avatars?|photos?|images?|imgs?|icons?|logos?|banners?|posters?)\/)/i;
  let keyMatch: RegExpExecArray | null;
  while ((keyMatch = keyRe.exec(html.replace(/\\\//g, '/').replace(/\\u0026/g, '&'))) !== null) {
    const url = keyMatch[1] ?? keyMatch[2] ?? '';
    if (!imageish.test(url)) add(url);
  }

  const thumb = thumbnails[0] ?? _scanPageThumbnail(html, pageUrl);
  if (thumb) results.forEach((item) => {
    if (item.mediaKind === 'video' || item.mediaKind === 'audio') item.thumbnailUrl = thumb;
  });
  return results;
}

// Fetch the page once and scan in HLS→DASH→OG video→generic video→OG image priority order.
// OG image is a last resort — almost all article pages have one, so we only use it
// when no video content was found.
async function extractHtmlMediaAll(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    debugLog('[extractHtmlMediaAll] fetching', pageUrl);
    const html = await fetchHtml(pageUrl);
    debugLog('[extractHtmlMediaAll] fetched', pageUrl, 'len:', html.length);
    const all: DetectedMedia[] = [];

    // Video/audio manifests — high confidence (0.85 default), score 4 in pickBestMedia.
    // Run first but accumulate rather than short-circuit, so image fallbacks survive
    // when a found HLS/DASH URL turns out to be expired or auth-gated.
    for (const mode of ['hls', 'dash'] as const) {
      _scanHtml(html, pageUrl, mode).forEach(item => pushUnique(all, item));
    }
    _scanOg(html, pageUrl).forEach(item => pushUnique(all, item));
    _scanStructuredMediaData(html, pageUrl).forEach(item => pushUnique(all, item));

    // Generic scan: img/source tags, CDN domains — lower confidence (0.65), score 3.
    const generic = _scanHtml(html, pageUrl, 'generic');
    const thumb = _scanPageThumbnail(html, pageUrl);
    if (thumb) generic.forEach((item) => {
      if (item.mediaKind === 'video' || item.mediaKind === 'audio') item.thumbnailUrl = thumb;
    });
    generic.forEach(item => pushUnique(all, item));

    debugLog('[extractHtmlMediaAll]', pageUrl, 'found:', all.length, 'items, generic:', generic.length);
    if (all.length > 0) return capGenericResults(all);
    const ogImages = _scanOgImage(html, pageUrl);
    debugLog('[extractHtmlMediaAll]', pageUrl, 'ogImages:', ogImages.length);
    return ogImages;
  } catch (e) {
    debugLog('[extractHtmlMediaAll] CAUGHT ERROR for', pageUrl, ':', String(e));
    return [];
  }
}

function isLikelyNonContentMediaUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (/\.(?:html?|php|aspx?|jsx?|tsx?|css|woff2?|ttf|eot)(?:[?#]|$)/i.test(u)) return true;
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
      extractUrls(html, /https?:\/\/v\d+-webapp[^/]*\.tiktok\.com\/[^\s"'<>]{8,}/g).forEach(u =>
        results.push(makeItem(u, pageUrl)),
      );
    }

    return results;
  } catch { return []; }
}

// ── Reddit ────────────────────────────────────────────────────────
function decodeRedditEntities(value: string): string {
  let decoded = value;
  for (let i = 0; i < 3; i++) {
    const next = decoded
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

export function extractRedditRssMedia(rss: string, pageUrl: string, postId?: string): DetectedMedia[] {
  const entries = rss.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const postEntry = entries.find((entry) =>
    postId
      ? new RegExp(`<id>\\s*t3_${postId}\\s*<\\/id>`, 'i').test(entry)
      : /<id>\s*t3_[A-Za-z0-9]+\s*<\/id>/i.test(entry),
  );
  if (!postEntry) return [];

  const decoded = decodeRedditEntities(postEntry);
  const urls = extractUrls(decoded, /(https?:\/\/(?:v\.redd\.it|i\.redd\.it|preview\.redd\.it)\/[^"'<>\s]+)/gi);
  const results: DetectedMedia[] = [];

  for (const rawUrl of urls) {
    const clean = cleanExtractedUrl(rawUrl);
    try {
      const parsed = new URL(clean);
      if (parsed.hostname === 'v.redd.it') {
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        if (pathParts.length === 1) {
          const hlsUrl = `https://v.redd.it/${pathParts[0]}/HLSPlaylist.m3u8`;
          const item = makeItem(hlsUrl, pageUrl, 'Reddit Video', 'social-extractor', 0.88);
          item.httpHeaders = REDDIT_DOWNLOAD_HEADERS;
          // Reddit's master HLS keeps audio in a separate rendition group.
          // The backend remuxes both tracks; the on-device HLS assembler only
          // consumes the selected video variant and would produce a silent file.
          item.forceServerDownload = true;
          pushUnique(results, item);
        } else {
          const item = makeItem(clean, pageUrl, 'Reddit Video', 'social-extractor', 0.86);
          item.httpHeaders = REDDIT_DOWNLOAD_HEADERS;
          item.forceServerDownload = /\.m3u8?(?:[?#]|$)/i.test(clean);
          pushUnique(results, item);
        }
        continue;
      }

      // RSS may contain both a small external-preview thumbnail and the original
      // post image. Prefer real i.redd.it/preview.redd.it media and drop thumbnails.
      if (/\/(?:external-preview|b\.thumbs)\./i.test(parsed.hostname)) continue;
      const item = makeItem(clean, pageUrl, 'Reddit Image', 'social-extractor', 0.82, 'image');
      item.httpHeaders = REDDIT_DOWNLOAD_HEADERS;
      pushUnique(results, item);
    } catch {}
  }

  return results;
}

async function fetchReddit(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function extractReddit(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    let targetUrl = pageUrl;
    if (targetUrl.includes('/s/')) {
      const res = await fetchReddit(targetUrl, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      targetUrl = res.url;
    }

    const canonicalUrl = targetUrl.split(/[?#]/)[0].replace(/\/$/, '');
    const postId = canonicalUrl.match(/\/comments\/([A-Za-z0-9]+)/)?.[1];

    // Reddit's anonymous JSON endpoints increasingly return an HTML gate and
    // consume the very small anonymous request budget. Try the working Atom
    // feed first; it exposes the source v.redd.it/i.redd.it URL.
    const rssRes = await fetchReddit(`${canonicalUrl}/.rss`, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (rssRes.ok) {
      const rssResults = extractRedditRssMedia(await rssRes.text(), pageUrl, postId);
      if (rssResults.length > 0) return rssResults;
    }

    // Legacy fallback for sessions/IPs where Reddit still serves public JSON.
    const jsonUrl = `${canonicalUrl}/.json?limit=1&raw_json=1`;
    const res = await fetchReddit(jsonUrl, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    let post: any;
    if (res.ok && (res.headers.get('content-type') || '').toLowerCase().includes('json')) {
      const data = await res.json();
      post = data[0]?.data?.children?.[0]?.data;
    }
    const results: DetectedMedia[] = [];

    const rv = post?.secure_media?.reddit_video || post?.media?.reddit_video;
    if (rv) {
      // Prefer HLS because it exposes both video and audio renditions; fallback_url is video-only.
      const videoUrl = rv.hls_url || rv.fallback_url;
      if (videoUrl) {
        const item = makeItem(videoUrl, pageUrl, 'Reddit Video', 'social-extractor', 0.9);
        item.httpHeaders = REDDIT_DOWNLOAD_HEADERS;
        item.forceServerDownload = !!rv.hls_url;
        results.push(item);
      }
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
        if (srcUrl) {
          const item = makeItem(srcUrl, pageUrl, 'Reddit Image', 'social-extractor', 0.9);
          item.httpHeaders = REDDIT_DOWNLOAD_HEADERS;
          pushUnique(results, item);
        }
      }
    } else if (post?.url && /\.(jpe?g|png|gif|webp|avif)(?:[?#]|$)/i.test(post.url)) {
      const item = makeItem(post.url, pageUrl, 'Reddit Image', 'social-extractor', 0.9);
      item.httpHeaders = REDDIT_DOWNLOAD_HEADERS;
      results.push(item);
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
    try {
      const serverItems = await extractViaServer(pageUrl);
      if (serverItems.length > 0) return serverItems;
    } catch (e) {
      debugWarn('[extractInstagram] server extractor errored:', String(e).slice(0, 200));
    }

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

    // Instagram Reel pages expose alternate video encodings and poster images
    // alongside the actual clip. They are not carousel items: return one video
    // so a single Reel starts a single download. Keep the full result set for
    // /p/ posts because those can be real mixed-media carousels.
    if (/instagram\.com\/(?:reel|reels|tv)\//i.test(pageUrl)) {
      const video = results.find(item =>
        item.mediaKind === 'video' ||
        item.mediaType === 'hls' ||
        /\.(?:mp4|m3u8)(?:[?#]|$)/i.test(item.url),
      );
      if (video) return [video];
    }

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
          const url = q.url ?? '';
          const mime = (q.type ?? '').toLowerCase();
          if (url && (/\.m3u8?(?:[?#]|$)/i.test(url) || /mpegurl|m3u8?/.test(mime))) {
            const item = makeItem(url, pageUrl, 'Dailymotion HLS');
            item.httpHeaders = {
              'User-Agent': DESKTOP_UA,
              'Accept': '*/*',
              'Origin': 'https://www.dailymotion.com',
              'Referer': pageUrl,
            };
            results.push(item);
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
  // Tier 1: server-assisted HD when configured. extractViaServer is a no-op
  // when no backend is available, so the on-device path remains the fallback.
  try {
    const items = await extractViaServer(pageUrl);
    if (items.length > 0) return items;
  } catch (e) {
    debugWarn('[extractYouTube] server extractor errored:', String(e).slice(0, 200));
  }

  // Tier 2: on-device InnerTube avoids server-IP bot checks and provides the
  // progressive fallback when the server is unavailable or cannot extract.
  try {
    return await extractYouTubeStreams(pageUrl);
  } catch (e) {
    debugWarn('[extractYouTube] InnerTube errored:', String(e).slice(0, 200));
    return [];
  }
}

// ── TVer ──────────────────────────────────────────────────────────
type TVerEpisodeInfo = {
  title?: string;
  description?: string;
  duration?: number;
  streaks?: {
    videoRefID?: string;
    projectID?: string;
  };
};

type TVerStreaksInfo = Record<string, {
  api_key?: Record<string, string>;
}>;

type TVerPlayback = {
  name?: string;
  duration?: number;
  sources?: Array<{
    src?: string;
    type?: string;
    key_systems?: unknown;
  }>;
};

// 3-call pipeline: statics → streaks_info → playback. No TVer session needed.
async function extractTVerViaStreaks(pageUrl: string, episodeId: string): Promise<DetectedMedia[]> {
  const tverHeaders = {
    'User-Agent': DESKTOP_UA,
    'Origin': 'https://tver.jp',
    'Referer': 'https://tver.jp/',
  };

  const infoRes = await fetch(
    `https://statics.tver.jp/content/episode/${episodeId}.json`,
    { headers: { ...tverHeaders, 'Accept': 'application/json' } },
  );
  if (!infoRes.ok) return [];
  const episodeInfo = (await infoRes.json()) as TVerEpisodeInfo;
  const projectId = episodeInfo.streaks?.projectID;
  const videoRefId = episodeInfo.streaks?.videoRefID;
  if (!projectId || !videoRefId) return [];

  const streaksInfoRes = await fetch('https://player.tver.jp/player/streaks_info_v2.json', {
    headers: { 'User-Agent': DESKTOP_UA },
  });
  if (!streaksInfoRes.ok) return [];
  const streaksInfo = (await streaksInfoRes.json()) as TVerStreaksInfo;
  const apiKeys = streaksInfo[projectId]?.api_key ?? {};
  const jstMonth = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCMonth() + 1;
  const preferredKeyName = `key0${jstMonth % 6 || 6}`;
  const apiKeyEntries = [
    [preferredKeyName, apiKeys[preferredKeyName]],
    ...Object.entries(apiKeys).filter(([name]) => name !== preferredKeyName),
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);

  for (const [, apiKey] of apiKeyEntries) {
    const playbackRes = await fetch(
      `https://playback.api.streaks.jp/v1/projects/${encodeURIComponent(projectId)}/medias/ref:${encodeURIComponent(videoRefId)}`,
      {
        headers: {
          ...tverHeaders,
          'Accept': 'application/json',
          'X-Streaks-Api-Key': apiKey,
        },
      },
    );
    if (!playbackRes.ok) continue;
    const playback = (await playbackRes.json()) as TVerPlayback;
    const sources = playback.sources ?? [];
    const title = playback.name || episodeInfo.title || 'TVer';
    const items = sources
      .filter(source => source.src && !source.key_systems && /mpegurl|m3u8/i.test(`${source.type ?? ''} ${source.src}`))
      .map(source => ({
        ...makeItem(source.src!, pageUrl, 'TVer HLS', 'social-extractor', 0.92),
        httpHeaders: tverHeaders,
        sourceTitle: title,
        duration: playback.duration ?? episodeInfo.duration,
        thumbnailUrl: `https://statics.tver.jp/images/content/thumbnail/episode/xlarge/${episodeId}.jpg`,
      }));
    if (items.length > 0) return items;
  }

  return [];
}

async function extractTVer(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const episodeMatch = pageUrl.match(/tver\.jp\/episodes\/(ep[A-Za-z0-9]+)/);
    if (!episodeMatch) return [];
    return await extractTVerViaStreaks(pageUrl, episodeMatch[1]);
  } catch { return []; }
}

// ── Facebook ──────────────────────────────────────────────────────
export function extractFacebookMedia(html: string, pageUrl: string): DetectedMedia[] {
  const results: DetectedMedia[] = [];
  const add = (url: string, label: string, confidence: number) => {
    const item = makeItem(url, pageUrl, label, 'social-extractor', confidence);
    // Facebook rate-limits/403s CDN downloads made with a normal browser UA.
    // yt-dlp uses the crawler UA for the same reason.
    item.httpHeaders = {
      'User-Agent': 'facebookexternalhit/1.1',
      Referer: 'https://www.facebook.com/',
    };
    pushUnique(results, item);
  };

  const patterns: Array<{ re: RegExp; label: string; confidence: number }> = [
    { re: /"playable_url_quality_hd"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, label: 'Facebook HD', confidence: 0.94 },
    { re: /"browser_native_hd_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, label: 'Facebook HD', confidence: 0.94 },
    { re: /"playable_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, label: 'Facebook Video', confidence: 0.9 },
    { re: /"browser_native_sd_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, label: 'Facebook Video', confidence: 0.9 },
    { re: /"hd_src"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, label: 'Facebook HD', confidence: 0.88 },
    { re: /"sd_src"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, label: 'Facebook Video', confidence: 0.86 },
    { re: /"progressive_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g, label: 'Facebook Video', confidence: 0.88 },
  ];
  for (const { re, label, confidence } of patterns) {
    extractUrls(html, re).forEach((url) => add(url, label, confidence));
  }

  const preferred = results.find((item) => item.label === 'Facebook HD') ?? results[0];
  return preferred ? [preferred] : [];
}

export async function extractFacebook(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let res: Response;
    try {
      res = await fetch(pageUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': FACEBOOK_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-us,en;q=0.5',
          'Sec-Fetch-Mode': 'navigate',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return [];
    const html = await res.text();
    return extractFacebookMedia(html, pageUrl);
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

  // On iOS, the Sina Visitor System (which gates all Weibo pages from non-China
  // IPs) requires JS execution. Run a hidden WKWebView to load m.weibo.cn so the
  // visitor JS fires and sets the SUB cookie in the WKHTTPCookieStore. Then retry
  // the server extraction — extractViaServer reads those same WKWebView cookies
  // via extractSessionCookies() and forwards them to the Fly.io backend.
  if (Platform.OS === 'ios') {
    try {
      const ok = await prewarmWeiboVisitorSession();
      if (ok) {
        try {
          const retryItems = await extractViaServer(pageUrl);
          if (retryItems.length > 0) {
            return retryItems.map(i => ({ ...i, label: i.label ?? 'Weibo' }));
          }
        } catch (e) {
          debugWarn('[extractWeibo] retry after prewarm failed:', String(e).slice(0, 200));
        }
      }
    } catch {}
  }

  try {
    let targetUrl = pageUrl;
    if (targetUrl.includes('mapp.api.weibo.cn')) {
      const res = await fetch(targetUrl, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      targetUrl = res.url;
    }
    // If we ended up at the Weibo visitor/passport page, extract the embedded
    // target URL so we can try the statuses API directly.
    if (targetUrl.includes('passport.weibo') || targetUrl.includes('visitor.passport')) {
      try {
        const urlMatch = targetUrl.match(/[?&]url=([^&]+)/);
        if (urlMatch) targetUrl = decodeURIComponent(urlMatch[1]);
      } catch {}
    }

    // Try the Weibo statuses JSON API directly.
    // On iOS: inject fetch() into the still-live WKWebView (which holds the visitor
    // SUB cookie in WKHTTPCookieStore) to bypass NSURLSession's cookie isolation.
    // On Android/web: use native fetch with an explicit Cookie header.
    const weiboDeviceCookies = Platform.OS !== 'ios'
      ? await extractSessionCookies('https://m.weibo.cn/').catch(() => '')
      : '';
    const idMatch = targetUrl.match(/\/(?:status|detail)\/([A-Za-z0-9]+)/) ||
                    targetUrl.match(/[?&]id=([A-Za-z0-9]+)/);
    if (idMatch) {
      const wid = idMatch[1];
      for (const apiUrl of [
        `https://m.weibo.cn/statuses/show?id=${wid}`,
        `https://weibo.com/ajax/statuses/show?id=${wid}`,
      ]) {
        try {
          let meta: any;
          if (Platform.OS === 'ios') {
            meta = await fetchWeiboStatuses(apiUrl);
          } else {
            const reqHeaders: Record<string, string> = { 'User-Agent': MOBILE_UA, 'Referer': targetUrl, 'Accept': 'application/json' };
            if (weiboDeviceCookies) reqHeaders['Cookie'] = weiboDeviceCookies;
            const apiRes = await fetch(apiUrl, { headers: reqHeaders });
            if (!apiRes.ok) continue;
            meta = await apiRes.json();
          }
          if (!meta) continue;
          const post = meta?.data ?? meta;
          if (!post || post.ok === -100) continue;
          const results: DetectedMedia[] = [];
          // Images
          (post.pics ?? []).forEach((pic: any) => {
            const u = pic?.large?.url || pic?.url;
            if (u) pushUnique(results, makeItem(u, pageUrl, 'Weibo Image', 'social-extractor', 0.88));
          });
          // Video: check playback_list (newer format), urls.mp4_*, then stream_url fields
          const mediaInfo = post.page_info?.media_info ?? {};
          let videoUrl: string | undefined;
          for (const item of (Array.isArray(mediaInfo.playback_list) ? mediaInfo.playback_list : [])) {
            const u = item?.play_info?.url;
            if (typeof u === 'string' && u.startsWith('http')) { videoUrl = u; break; }
          }
          if (!videoUrl && mediaInfo.urls) {
            for (const key of ['mp4_uhd_mp4', 'mp4_hd_mp4', 'mp4_ld_mp4', 'mp4_hd', 'mp4_ld']) {
              const v = (mediaInfo.urls as any)[key];
              if (typeof v === 'string' && v.startsWith('http')) { videoUrl = v; break; }
            }
          }
          if (!videoUrl) videoUrl = mediaInfo.stream_url_hd || mediaInfo.stream_url || undefined;
          if (videoUrl) pushUnique(results, makeItem(videoUrl, pageUrl, 'Weibo Video', 'social-extractor', 0.88));
          if (results.length > 0) return results;
        } catch {}
      }
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
  // Reject bare-domain URLs like "https://sns-webpic.xhscdn.com/" — real CDN paths always have content after the first slash
  const schemeEnd = lower.indexOf('://');
  if (schemeEnd === -1) return false;
  const domainSlash = lower.indexOf('/', schemeEnd + 3);
  if (domainSlash === -1 || lower.length <= domainSlash + 1) return false;
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

  // Tier 2: NicoNico domand API (replaces the old window.__INITIAL_WATCH_DATA__ scrape).
  // Flow: V3 guest API → accessRightKey + track ID → POST access-rights/hls → HLS URL.
  try {
    const videoIdMatch = pageUrl.match(/\/watch\/((?:sm|nm|so|lv)\d+|\d+)/);
    if (!videoIdMatch) throw new Error('no video id');
    const videoId = videoIdMatch[1];

    // actionTrackId must survive the session: same value for all requests.
    const trackId = `NICONICOAPP_${Date.now()}`;
    // Accept must include */* — nicovideo.jp returns 406 for strict application/json.
    const nicoHeaders = {
      'User-Agent': DESKTOP_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ja',
      'X-Frontend-Id': '6',
      'X-Frontend-Version': '0',
      'Origin': 'https://www.nicovideo.jp',
      'Referer': `https://www.nicovideo.jp/watch/${videoId}`,
    };

    const v3Res = await fetch(
      `https://www.nicovideo.jp/api/watch/v3_guest/${videoId}?_frontendId=6&_frontendVersion=0&actionTrackId=${trackId}`,
      { headers: nicoHeaders },
    );
    if (!v3Res.ok) throw new Error(`v3_guest HTTP ${v3Res.status}`);
    const v3: any = await v3Res.json();

    const domand = v3?.data?.media?.domand;
    const accessKey: string | undefined = domand?.accessRightKey;
    if (!accessKey) throw new Error('no accessRightKey in domand response');

    const bestVideo = (domand.videos as any[]).find((v: any) => v.isAvailable)?.id;
    const bestAudio = (domand.audios as any[]).find((a: any) => a.isAvailable)?.id;
    if (!bestVideo || !bestAudio) throw new Error('no available domand streams');

    const postRes = await fetch(
      `https://nvapi.nicovideo.jp/v1/watch/${videoId}/access-rights/hls?actionTrackId=${trackId}`,
      {
        method: 'POST',
        headers: {
          ...nicoHeaders,
          'Content-Type': 'application/json',
          'X-Request-With': 'https://www.nicovideo.jp',
          'X-Access-Right-Key': accessKey,
        },
        body: JSON.stringify({ outputs: [[bestVideo, bestAudio]] }),
      },
    );
    if (!postRes.ok) throw new Error(`access-rights/hls HTTP ${postRes.status}`);

    // The CDN (delivery.domand.nicovideo.jp) gates the HLS master manifest behind
    // the domand_bid cookie set by this POST response. Capture and forward it.
    const setCookieHeader = postRes.headers.get('set-cookie') ?? '';
    const domandBidMatch = setCookieHeader.match(/domand_bid=([^;,\s]+)/);
    const domandBid: string | undefined = domandBidMatch?.[1];

    const postData: any = await postRes.json();
    const hlsUrl: string | undefined = postData?.data?.contentUrl;
    if (!hlsUrl) throw new Error('no contentUrl in access-rights response');

    const hlsHeaders: Record<string, string> = {
      'User-Agent': DESKTOP_UA,
      'Origin': 'https://www.nicovideo.jp',
      'Referer': `https://www.nicovideo.jp/watch/${videoId}`,
    };
    if (domandBid) hlsHeaders['Cookie'] = `domand_bid=${domandBid}`;

    debugLog('[extractNicoNico] domand HLS:', hlsUrl.slice(0, 80));
    return [{ ...makeItem(hlsUrl, pageUrl, 'NicoNico'), httpHeaders: hlsHeaders }];
  } catch (e) {
    debugWarn('[extractNicoNico] domand API failed:', String(e).slice(0, 200));
  }

  return [];
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
    const lang = getAcceptLanguage(pageUrl);
    let html = await fetchHtml(pageUrl, DESKTOP_UA, lang);

    // Naver Blog pages are framesets — the actual content lives in a PostView iframe.
    // Follow the iframe src (if present) or construct the PostView URL from path components.
    if (/blog\.naver\.com/i.test(pageUrl)) {
      const iframeMatch = html.match(/<iframe\b[^>]*\bid=["']mainFrame["'][^>]*\bsrc=["']([^"']+)["']/i)
        ?? html.match(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*\bid=["']mainFrame["']/i);
      let iframeUrl: string | null = null;
      if (iframeMatch) {
        try { iframeUrl = new URL(iframeMatch[1].replace(/&amp;/g, '&'), pageUrl).toString(); } catch {}
      } else {
        // Naver Blog sometimes dynamically sets the iframe src via JS; fall back to
        // constructing the PostView URL directly from the blog URL path components.
        try {
          const { pathname } = new URL(pageUrl);
          const parts = pathname.split('/').filter(Boolean);
          if (parts.length >= 2 && parts[0] !== 'PostView.naver') {
            const params = new URLSearchParams({ blogId: parts[0], logNo: parts[1], redirect: 'Dlog', widgetTypeCall: 'true', directAccess: 'false' });
            iframeUrl = `https://blog.naver.com/PostView.naver?${params}`;
          }
        } catch {}
      }
      if (iframeUrl) {
        try { html = await fetchHtml(iframeUrl, DESKTOP_UA, lang); } catch {}
      }
    }

    const results: DetectedMedia[] = [];
    // Scan for video streams and images from Naver/pstatic CDN
    extractUrls(
      html,
      /(https?:\/\/[^"'\\<>\s]*(?:pstatic\.net|naver\.com)[^"'\\<>\s]*\.(?:m3u8|mp4|jpe?g|png|webp|gif)[^"'\\<>\s]*)/gi,
    ).filter(u => !isLikelyNonContentMediaUrl(u))
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'Naver', 'social-extractor', 0.65)));
    // blogfiles/postfiles CDN serves post images without file extensions (base64-encoded filenames)
    extractUrls(
      html,
      /(https?:\/\/(?:blogfiles|postfiles)\.pstatic\.net\/[^"'\\<>\s]{10,})/gi,
    ).filter(u => !isLikelyNonContentMediaUrl(u))
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, 'Naver', 'social-extractor', 0.65, 'image')));
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
  // Article pages contain the intended gallery alongside optional embedded
  // blog videos. Prefer the page scan so an unrelated video embed does not
  // suppress the post's images.
  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA, getAcceptLanguage(pageUrl));
    const results = _scanHtml(html, pageUrl, 'generic');
    if (results.length > 0) return results.map(item => ({ ...item, label: item.label ?? 'Ameba' }));
  } catch {}

  try {
    const items = await extractViaServer(pageUrl);
    return items.map(item => ({ ...item, label: item.label ?? 'Ameba' }));
  } catch (e) {
    debugWarn('[extractAmeba] server extractor errored:', String(e).slice(0, 200));
    return [];
  }
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

    const mediaPatterns: RegExp[] = [
      /(https?:\/\/[^"'\\<>\s]+?\.m3u8[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.mpd[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.(?:mp4|m4v|webm|mov)[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.(?:mp3|m4a|ogg|opus|aac)[^"'\\<>\s]*)/gi,
      /(https?:\/\/[^"'\\<>\s]+?\.(?:jpe?g|png|webp|gif|avif|heic)[^"'\\<>\s]*)/gi,
    ];
    mediaPatterns.forEach(re => {
      extractUrls(html, re)
        .filter((u) => !isLikelyNonContentMediaUrl(u))
        .forEach(u => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.6)));
    });
    // CDN image domains — force image kind; URLs may lack a file extension (CDN transform params)
    extractUrls(html, /(https?:\/\/[^"'\\<>\s]*(?:contents\.oricon\.co\.jp|img-mdpr\.freetls\.fastly\.net|mdpr\.jp\/photo|ogre\.natalie\.mu|img\.thetv\.jp|img\.mantan-web\.jp|storage\.mantan-web\.jp|img\.cinematoday\.jp|res\.cloudinary\.com)[^"'\\<>\s)]*)/gi)
      .filter((u) => !isLikelyNonContentMediaUrl(u))
      .forEach(u => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.6, 'image')));

    // OG/twitter card, including article lead images — both attribute orderings.
    const ogPatterns = [
      /<meta\s[^>]*?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream|og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*?content\s*=\s*["']([^"']+)["']/gi,
      /<meta\s[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream|og:image(?::secure_url)?|twitter:image(?::src)?)["']/gi,
    ];
    ogPatterns.forEach(re =>
      extractUrls(html, re)
        .filter(u => u.startsWith('http'))
        .filter((u) => !isLikelyNonContentMediaUrl(u))
        .forEach(u => pushUnique(results, makeItem(u, pageUrl, undefined, 'social-extractor', 0.55))),
    );

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

export function tumblrApiUrl(pageUrl: string): string | undefined {
  try {
    const parsed = new URL(pageUrl);
    const legacy = parsed.pathname.match(/^\/post\/(\d+)(?:[/?#]|$)/);
    if (legacy && /\.tumblr\.com$/i.test(parsed.hostname)) {
      return `https://${parsed.hostname}/api/read/json?id=${legacy[1]}`;
    }

    // Modern canonical URLs use tumblr.com/<blog>/<post-id>.  The legacy read
    // endpoint still lives on the blog subdomain, not on www.tumblr.com.
    const modern = parsed.pathname.match(/^\/([^/?#]+)\/(\d+)(?:[/?#]|$)/);
    if (modern && /^(?:www\.)?tumblr\.com$/i.test(parsed.hostname)) {
      const blog = modern[1].toLowerCase();
      if (/^[a-z0-9-]+$/.test(blog)) {
        return `https://${blog}.tumblr.com/api/read/json?id=${modern[2]}`;
      }
    }
  } catch {}
  return undefined;
}

async function extractTumblr(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const apiUrl = tumblrApiUrl(pageUrl);
    if (!apiUrl) return [];
    const api = new URL(apiUrl);
    const postId = api.searchParams.get('id') ?? '';
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json, text/javascript, */*', Referer: `https://${api.host}/` },
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

// ── TwitCasting ───────────────────────────────────────────────────
async function extractTwitCasting(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl, DESKTOP_UA);
    const m = html.match(/https?:\/\/dl\d+\.twitcasting\.tv[^\s"'<>]*\.m3u8[^\s"'<>]*/);
    if (!m) return [];
    const item = makeItem(m[0], pageUrl, 'TwitCasting', 'social-extractor', 0.92);
    item.httpHeaders = {
      'User-Agent': DESKTOP_UA,
      'Accept': '*/*',
      'Origin': 'https://twitcasting.tv',
      'Referer': 'https://twitcasting.tv/',
    };
    // TwitCasting VOD manifests are signed and can reject a second device-side
    // request even moments after extraction. Let the server re-extract and
    // stream the current signed URL in one request instead of persisting a
    // brittle manifest token in the task queue.
    item.forceServerDownload = true;
    return [item];
  } catch { return []; }
}

// ── Platform registry ─────────────────────────────────────────────
const PLATFORMS: Array<{ re: RegExp; fn: (url: string) => Promise<DetectedMedia[]> }> = [
  { re: /tiktok\.com\/@[^/]+\/(?:video|photo|item)\/\d+|tiktok\.com\/(?:t|v)\/[A-Za-z0-9]+|vm\.tiktok\.com\/[A-Za-z0-9]+/, fn: extractTikTok },
  { re: /(?:twitter|x)\.com\/[^/]+\/status\/\d+/,                                  fn: extractTwitter     },
  { re: /redgifs\.com\/(?:watch|ifr|gif)\/[A-Za-z0-9]+/i,                          fn: extractRedgifs     },
  { re: /bsky\.app\/profile\/[^/?#]+\/post\/[A-Za-z0-9]+/,                         fn: extractBluesky     },
  { re: /(?:[a-z0-9-]+\.tumblr\.com\/post\/\d+|(?:www\.)?tumblr\.com\/[a-z0-9-]+\/\d+)/i, fn: extractTumblr },
  // Mastodon: detect by snowflake ID in path — works across all fediverse instances
  { re: /\/(?:@[^/?#]+|users\/[^/?#]+\/statuses)\/\d{17,20}(?:[/?#]|$)/,          fn: extractMastodon    },
  { re: /instagram\.com\/(?:(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+|share\/(?:p|reel)\/[A-Za-z0-9_-]+)/, fn: extractInstagram   },
  { re: /threads\.(?:net|com)\/@[^/]+\/post\/[A-Za-z0-9_-]+/,                      fn: extractInstagram   },
  { re: /dailymotion\.com\/video\/[A-Za-z0-9]+/,                                    fn: extractDailymotion },
  { re: /(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)[?/]?[A-Za-z0-9_-]{11}/,   fn: extractYouTube     },
  { re: /(?:facebook\.com\/(?:watch|reel|video|[^/?#]+\/videos|share\/[rv])|fb\.watch)/, fn: extractFacebook },
  { re: /pinterest\.(?:com|[a-z]{2,3})\/pin\/\d+/,                                 fn: extractPinterest   },
  { re: /reddit\.com\/(?:r\/[^/]+\/s\/[A-Za-z0-9]+|r\/[^/]+\/comments\/[A-Za-z0-9]+)/, fn: extractReddit  },
  { re: /tver\.jp\/episodes\/ep[A-Za-z0-9]+/,                                       fn: extractTVer        },
  { re: /(?:bilibili\.com\/video\/[ABab][Vv][A-Za-z0-9]+|m\.bilibili\.com\/video\/[ABab][Vv][A-Za-z0-9]+|b23\.tv\/[A-Za-z0-9]+|bilibili\.tv\/(?:[a-z]{2}\/)?video\/\d+|t\.bilibili\.com\/\d+|bilibili\.com\/(?:opus|read)\/\d+)/, fn: extractBilibili    },
  { re: /(?:weibo\.com\/(?:tv\/show\/|u\/\d+|(?:\d+|0)\/[A-Za-z0-9]+)|m\.weibo\.cn\/(?:status|detail)\/[A-Za-z0-9]+|video\.weibo\.com\/show\?|mapp\.api\.weibo\.cn\/)/, fn: extractWeibo },
  { re: /(?:(?:xiaohongshu|rednote)\.com\/(?:explore|discovery\/item)\/[\da-f]+|xhslink\.com\/[A-Za-z0-9/?=&._-]+)/i, fn: extractXiaohongshu },
  // ── Japanese sites ──────────────────────────────────────────────────────────
  { re: /twitcasting\.tv\/[^/]+\/movie\/\d+/,                                       fn: extractTwitCasting },
  { re: /(?:nicovideo\.jp\/watch\/|nico\.ms\/)[a-zA-Z0-9]+/,                       fn: extractNicoNico    },
  { re: /abema\.tv\/video\/(?:episode|series)\/[A-Za-z0-9_-]+/,                    fn: extractAbema       },
  { re: /(?:tv\.naver\.com\/v\/\d+|now\.naver\.com\/|blog\.naver\.com\/|m\.blog\.naver\.com\/|news\.naver\.com\/|n\.news\.naver\.com\/|m\.news\.naver\.com\/|entertain\.naver\.com\/|m\.entertain\.naver\.com\/|sports\.news\.naver\.com\/|m\.sports\.naver\.com\/|naver\.me\/[A-Za-z0-9]+)/, fn: extractNaver },
  { re: /(?:mdpr\.jp\/|modelpress\.jp\/)/,                                         fn: extractModelpress  },
  { re: /(?:ameba\.jp\/[^/]+\/entry\/\d+|ameblo\.jp\/[^/]+\/entry-\d+)/,           fn: extractAmeba       },
  { re: /pixiv\.net\/(?:en\/)?artworks?\/\d+|pixiv\.net\/.*illust_id=\d+/,         fn: extractPixiv       },
  { re: /(?:lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp\/douga|ytv\.co\.jp\/mydo|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp)/i, fn: extractJapaneseGeneric },
  { re: /(?:natalie\.mu|oricon\.co\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|fanbox\.cc|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|girlswalker\.com|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net|trilltrill\.jp|note\.com|lineblog\.me|hatenablog\.(?:com|jp)|hatenadiary\.(?:com|jp)|hatena\.ne\.jp|blog\.fc2\.com|gyazo\.com|seiga\.nicovideo\.jp|story\.kakao\.com|news\.yahoo\.co\.jp)/i, fn: extractCuratedArticle },
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

export async function extractFromSocialUrl(pageUrl: string, opts?: { skipServer?: boolean }): Promise<DetectedMedia[]> {
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
  // skipServer: caller (extractionManager Tier 2) already tried the server in Tier 1 and
  // got nothing — don't retry; go straight to on-device extractors to save the 45 s timeout.
  const skipServer = opts?.skipServer ?? false;
  const serverStep: [string, () => Promise<DetectedMedia[]>] =
    ['yt-dlp extraction', () => extractViaServer(pageUrl)];
  const platformStep: [string, () => Promise<DetectedMedia[]>] =
    ['platform-specific extractor', () => platform ? platform.fn(pageUrl) : Promise.resolve([])];
  const strategies: Array<[string, () => Promise<DetectedMedia[]>]> = [
    ...(skipServer ? [platformStep] : serverFirst ? [serverStep, platformStep] : [platformStep, serverStep]),
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
      return capGenericResults(result.media);
    }
    diagnostics.push(`${name}: ${result.reason ?? 'failed'}`);
    if (i < strategies.length - 1) {
      debugLog(`[extract] falling back to ${strategies[i + 1][0]}`);
    }
  }
  debugWarn('[extract] all strategies failed:', diagnostics.slice(-6).join('; '));
  return [];
}

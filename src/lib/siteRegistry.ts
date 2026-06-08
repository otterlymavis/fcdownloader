/**
 * Site capability registry.
 *
 * Maps domain patterns to per-site preferences used by the extraction pipeline:
 *  - preferredStrategies: ordered list of strategies to try first (fallback
 *    order is controlled by extractionManager.ts).
 *  - requiresAuth: true when the site always needs logged-in cookies to succeed.
 *  - acceptLanguage: Override Accept-Language for locale-sensitive sites.
 *  - notes: human-readable notes about the site's quirks.
 *
 * Nothing here blocks fallback — these are *hints* used to re-order the
 * strategy chain, not hard constraints. If every preferred strategy fails the
 * pipeline continues with its default order.
 */
import { DownloadStrategy } from '../types';
import { acceptLanguageForUrl } from './languageProfiles';

export interface SiteCapabilities {
  /** Preferred download strategy order (first = highest priority). */
  preferredStrategies: DownloadStrategy[];
  /** Site needs a logged-in session to serve any content. */
  requiresAuth?: boolean;
  /** Accept-Language value for HTTP fetches to this domain. */
  acceptLanguage?: string;
  /**
   * Run on-device extraction before the server for this site. Use for sites the
   * server can't extract without a logged-in session (so the server round-trip
   * is slow and usually fails) but whose page JSON the on-device scraper reads
   * directly — e.g. Xiaohongshu.
   */
  preferOnDevice?: boolean;
  /** Human-readable notes about extraction quirks. */
  notes?: string;
}

type SiteEntry = {
  /** RegExp tested against the full URL. */
  pattern: RegExp;
  caps: SiteCapabilities;
};

const REGISTRY: SiteEntry[] = [
  // ── YouTube ────────────────────────────────────────────────────────────────
  {
    pattern: /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/i,
    caps: {
      preferredStrategies: ['yt-dlp', 'server-download', 'hls-segments'],
      notes: 'Requires nsig transform; on-device extraction uses InnerTube iOS/Android clients',
    },
  },
  // ── Bilibili ───────────────────────────────────────────────────────────────
  {
    pattern: /(?:bilibili\.com\/video\/|b23\.tv\/|bilibili\.tv\/|m\.bilibili\.com\/video\/)/i,
    caps: {
      preferredStrategies: ['server-download', 'dash', 'direct'],
      requiresAuth: true,
      notes: 'Public requests cap at 480p; HD needs login cookies forwarded to yt-dlp',
    },
  },
  // ── Vimeo ──────────────────────────────────────────────────────────────────
  {
    pattern: /vimeo\.com\//i,
    caps: {
      preferredStrategies: ['vimeo-json', 'hls-segments', 'server-download'],
      notes: 'Domain-restricted embeds need Referer set to the embedding page',
    },
  },
  // ── TikTok ────────────────────────────────────────────────────────────────
  {
    pattern: /tiktok\.com\//i,
    caps: {
      preferredStrategies: ['server-download', 'direct', 'hls-segments'],
      notes: 'Signed CDN URLs expire quickly; server-side yt-dlp or direct CDN scan preferred',
    },
  },
  // ── Instagram / Threads ───────────────────────────────────────────────────
  {
    pattern: /(?:instagram\.com\/|threads\.net\/)/i,
    caps: {
      preferredStrategies: ['server-download', 'direct'],
      requiresAuth: true,
      notes: 'CDN URLs embedded in page JSON; carousel posts need gallery extraction',
    },
  },
  // ── Twitter / X ───────────────────────────────────────────────────────────
  {
    pattern: /(?:twitter\.com\/|x\.com\/).*\/status\//i,
    caps: {
      preferredStrategies: ['server-download', 'direct'],
      notes: 'video.twimg.com signed URLs; HLS manifest or direct mp4 depending on quality',
    },
  },
  // ── Weibo ─────────────────────────────────────────────────────────────────
  {
    pattern: /(?:weibo\.com|weibo\.cn|video\.weibo\.com)/i,
    caps: {
      preferredStrategies: ['server-download', 'direct'],
      notes: 'Follower-only posts need user session cookies forwarded',
    },
  },
  // ── Xiaohongshu ───────────────────────────────────────────────────────────
  {
    pattern: /(?:xiaohongshu\.com|rednote\.com|xhslink\.com)/i,
    caps: {
      preferredStrategies: ['server-download', 'direct'],
      requiresAuth: true,
      preferOnDevice: true,
      notes: 'Most content requires login; mobile UA required; on-device scrape of __INITIAL_STATE__ is fast, server extraction is gated',
    },
  },
  // ── TVer ──────────────────────────────────────────────────────────────────
  {
    pattern: /tver\.jp\/episodes\//i,
    caps: {
      preferredStrategies: ['hls-segments', 'server-download'],
      acceptLanguage: 'ja,en-US;q=0.9',
      preferOnDevice: true,
      notes: 'Japanese AVOD service; Streaks playback API returns HLS manifests and should use the device/VPN IP first',
    },
  },
  // ── NicoNico ──────────────────────────────────────────────────────────────
  {
    pattern: /(?:nicovideo\.jp\/watch\/|nico\.ms\/)/i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ja,en-US;q=0.9',
      requiresAuth: true,
      notes: 'Most content requires Japanese login session; HLS manifest after auth',
    },
  },
  // ── Abema ─────────────────────────────────────────────────────────────────
  {
    pattern: /abema\.tv\//i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ja,en-US;q=0.9',
      notes: 'DRM-free streams use HLS; yt-dlp with Japanese headers handles most content',
    },
  },
  // ── Japanese video portals ────────────────────────────────────────────────
  {
    pattern: /(?:cu\.tbs\.co\.jp|tbs\.co\.jp|tbs\.jp)\//i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      preferOnDevice: true,
      notes: 'TBS/TBS FREE pages are geo-sensitive and commonly require current episode URLs',
    },
  },
  {
    pattern: /(?:fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|fujitv\.co\.jp)\//i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      preferOnDevice: true,
      notes: 'FOD/Fuji TV pages are often auth, DRM, or current-episode restricted',
    },
  },
  {
    pattern: /(?:video\.yahoo\.co\.jp|news\.yahoo\.co\.jp|gyao\.yahoo\.co\.jp)\//i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments', 'direct'],
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      preferOnDevice: true,
      notes: 'Yahoo Japan video articles expire quickly; use current ranking/video URLs',
    },
  },
  {
    pattern: /(?:openrec\.tv|video\.fc2\.com|live\.fc2\.com|fc2\.com\/video|dmm\.co\.jp|dmm\.com|fanza\.jp)\//i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      preferOnDevice: true,
      notes: 'Japanese video sites with auth, age-gate, live/offline, or geo-sensitive availability',
    },
  },
  {
    pattern: /(?:lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp)\//i,
    caps: {
      preferredStrategies: ['hls-segments', 'server-download'],
      requiresAuth: true,
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      preferOnDevice: true,
      notes: 'Japanese SVOD/paid streaming services usually require a Japan IP plus browser session; DRM-protected titles cannot be downloaded',
    },
  },
  {
    pattern: /(?:locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp\/douga|ytv\.co\.jp\/mydo|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp)\//i,
    caps: {
      preferredStrategies: ['hls-segments', 'server-download', 'direct'],
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      preferOnDevice: true,
      notes: 'Japanese broadcaster catch-up portals are geo-sensitive and often expose playable HLS only after the browser player loads',
    },
  },
  // Naver
  {
    pattern: /(?:naver\.com\/|naver\.me\/)/i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5',
      notes: 'Naver video is supported by yt-dlp; some clips need page referer or logged-in cookies',
    },
  },
  // Modelpress
  {
    pattern: /(?:mdpr\.jp\/|modelpress\.jp\/)/i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments', 'direct'],
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      notes: 'Modelpress usually embeds third-party players; server extraction and runtime capture are preferred',
    },
  },
  // ── Pixiv ─────────────────────────────────────────────────────────────────
  {
    pattern: /pixiv\.net\/(?:en\/)?artworks?\/\d+|pixiv\.net\/.*illust_id=\d+/i,
    caps: {
      preferredStrategies: ['direct', 'server-download'],
      preferOnDevice: true,
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      notes: 'AJAX pages API (/ajax/illust/{id}/pages) returns all pages; pximg.net CDN requires Referer: pixiv.net',
    },
  },
  // ── NHK ───────────────────────────────────────────────────────────────────
  {
    pattern: /(?:ameblo\.jp|ameba\.jp|natalie\.mu|oricon\.co\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|pixiv\.net|fanbox\.cc|t\.bilibili\.com|bilibili\.com\/(?:opus|read)|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net|trilltrill\.jp|note\.com|lineblog\.me|hatenablog\.(?:com|jp)|hatenadiary\.(?:com|jp)|hatena\.ne\.jp|blog\.fc2\.com|gyazo\.com|seiga\.nicovideo\.jp|story\.kakao\.com)/i,
    caps: {
      preferredStrategies: ['server-download', 'direct'],
      acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
      notes: 'Article/gallery images often need Referer and proxy download handling',
    },
  },
  {
    pattern: /nhk\.(?:or\.jp|jp)\//i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ja,en-US;q=0.9',
      notes: 'Public broadcaster; HLS streams, geo-restricted',
    },
  },
  // ── Dailymotion ───────────────────────────────────────────────────────────
  {
    pattern: /dailymotion\.com\/video\//i,
    caps: {
      preferredStrategies: ['hls-segments', 'server-download'],
      notes: 'Public API endpoint at /player/metadata/video/{id} returns HLS URLs',
    },
  },
  // ── Facebook ──────────────────────────────────────────────────────────────
  {
    pattern: /facebook\.com\/(?:watch|reel|video)|fb\.watch/i,
    caps: {
      preferredStrategies: ['server-download', 'direct'],
      notes: 'hd_src / sd_src in page JSON; mobile UA needed',
    },
  },
];

/**
 * Look up site-specific capabilities for a given URL.
 * Returns undefined when the URL does not match any registry entry.
 */
export function getSiteCapabilities(url: string): SiteCapabilities | undefined {
  return REGISTRY.find(e => e.pattern.test(url))?.caps;
}

/**
 * Returns the preferred Accept-Language value for a URL. Site registry
 * overrides win first, then common regional profiles, then the fallback.
 */
export function getAcceptLanguage(url: string, fallback = 'en-US,en;q=0.9'): string {
  return getSiteCapabilities(url)?.acceptLanguage ?? acceptLanguageForUrl(url, fallback);
}

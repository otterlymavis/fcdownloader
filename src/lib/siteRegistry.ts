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
    pattern: /(?:bilibili\.com\/video\/|b23\.tv\/|bilibili\.tv\/)/i,
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
    pattern: /(?:xiaohongshu\.com|xhslink\.com)/i,
    caps: {
      preferredStrategies: ['server-download', 'direct'],
      requiresAuth: true,
      notes: 'Most content requires login; mobile UA required',
    },
  },
  // ── TVer ──────────────────────────────────────────────────────────────────
  {
    pattern: /tver\.jp\/episodes\//i,
    caps: {
      preferredStrategies: ['server-download', 'hls-segments'],
      acceptLanguage: 'ja,en-US;q=0.9',
      notes: 'Japanese AVOD service; platform API returns HLS manifests',
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
  // ── NHK ───────────────────────────────────────────────────────────────────
  {
    pattern: /(?:ameblo\.jp|ameba\.jp|natalie\.mu|oricon\.co\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|pixiv\.net|fanbox\.cc|t\.bilibili\.com|bilibili\.com\/(?:opus|read)|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net)/i,
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

/**
 * Returns the preferred strategy list for a URL, or empty array when the URL
 * is not in the registry (caller should use default ordering).
 */
export function getPreferredStrategies(url: string): DownloadStrategy[] {
  return getSiteCapabilities(url)?.preferredStrategies ?? [];
}

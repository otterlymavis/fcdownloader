/**
 * YouTube stream extraction via the InnerTube API.
 * Mirrors the approach used by yt-dlp: try multiple client configurations
 * (ANDROID → TV_EMBEDDED → WEB_EMBEDDED) to obtain direct playable URLs
 * without requiring a live browser session.
 *
 * Output is normalised to DetectedMedia and fed directly into the existing
 * downloader pipeline — the app still owns the queue, storage, and UI.
 *
 * Limitations:
 *  - signatureCipher formats are skipped (cipher decoding requires the
 *    live player JS; those videos fall back to WebView detection).
 *  - po_token: not required for ANDROID / TV_EMBEDDED on most public videos;
 *    session cookies from a prior WebView visit are forwarded automatically
 *    and usually satisfy any remaining auth requirement.
 */

import { DetectedMedia } from '../types';
import { extractSessionCookies } from './cookieManager';

const INNERTUBE_URL =
  'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

// ── Client configs ──────────────────────────────────────────────
// Ordered by likelihood of returning direct (non-cipher) URLs.
// ANDROID and TV_EMBEDDED clients historically do not enforce po_token
// on muxed progressive formats for public videos.
interface YTClient {
  name: string;
  version: string;
  id: string;
  ua: string;
  extra?: Record<string, unknown>;
}

// IOS first — only client that still returns a working hlsManifestUrl with
// signed segment URLs that don't need nsig/decipher transforms. Gives 720p+ HLS.
// ANDROID is the 360p muxed-mp4 fallback (single direct URL, no manifest).
// Older clients (TVHTML5_*, WEB_EMBEDDED_PLAYER) now return UNPLAYABLE or
// FAILED_PRECONDITION on most videos as of 2025+, so they're omitted.
const CLIENTS: YTClient[] = [
  {
    name: 'IOS',
    version: '20.10.4',
    id: '5',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extra: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      platform: 'MOBILE',
    },
  },
  {
    name: 'ANDROID',
    version: '20.10.38',
    id: '3',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 13) gzip',
    extra: {
      androidSdkVersion: 33,
      osName: 'Android',
      osVersion: '13',
      platform: 'MOBILE',
    },
  },
];

// ── Helpers ─────────────────────────────────────────────────────
let _seq = 0;
const genId = () => `yt_${Date.now()}_${_seq++}`;

export function extractYouTubeVideoId(url: string): string | null {
  const m = url.match(
    /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/v\/)([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

// ── Main extractor ──────────────────────────────────────────────

/**
 * Attempts to extract YouTube stream URLs for `pageUrl` using the
 * InnerTube API. Returns an empty array on failure — callers should
 * fall back to WebView-based detection.
 *
 * Schema returned:
 *   - Muxed progressive MP4  (hasAudio+hasVideo, directDownloader)
 *   - DASH manifest URL       (mediaType:'dash', dashDownloader)
 */
export async function extractYouTubeStreams(
  pageUrl: string,
): Promise<DetectedMedia[]> {
  const videoId = extractYouTubeVideoId(pageUrl);
  if (!videoId) return [];

  // Forward youtube.com cookies if the user has signed in via the in-app
  // browser. With a logged-in session, InnerTube returns hlsManifestUrl for
  // more videos (incl. some age-/region-gated content) and triggers the
  // bot-check less often. No cookies = anonymous request (works for most
  // public videos but unlocks fewer).
  let ytCookies = '';
  try { ytCookies = await extractSessionCookies('https://www.youtube.com/'); } catch {}

  // Collect results across both clients so HLS (IOS, up to 4K) and the muxed
  // 360p mp4 (ANDROID) are both available even if one client is rate-limited.
  // Returned items are ordered HLS → muxed → DASH; the caller picks the first
  // usable one.
  const collected: DetectedMedia[] = [];

  for (const client of CLIENTS) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': client.ua,
        'X-Youtube-Client-Name': client.id,
        'X-Youtube-Client-Version': client.version,
        'Origin': 'https://www.youtube.com',
        'Referer': `https://www.youtube.com/watch?v=${videoId}`,
      };
      if (ytCookies) headers['Cookie'] = ytCookies;

      const body = {
        videoId,
        context: {
          client: {
            hl: 'en',
            gl: 'US',
            clientName: client.name,
            clientVersion: client.version,
            utcOffsetMinutes: 0,
            ...(client.extra ?? {}),
          },
        },
      };

      const res = await fetch(INNERTUBE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;

      const data = await res.json() as Record<string, any>;

      const status = (data?.playabilityStatus?.status as string) ?? '';
      if (status === 'ERROR' || status === 'UNPLAYABLE') continue;

      const sd = data?.streamingData as Record<string, any> | undefined;
      if (!sd) continue;

      const items: DetectedMedia[] = [];

      // Headers that get attached to each item — the downloader replays the
      // same User-Agent + Origin that obtained the signed URL.
      const cdnHeaders: Record<string, string> = {
        'User-Agent': client.ua,
        'Origin':  'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
        'Accept':  '*/*',
      };

      // ── 1. HLS manifest (IOS client; best path — adaptive up to 1080p+) ──
      if (typeof sd.hlsManifestUrl === 'string' && sd.hlsManifestUrl) {
        items.push({
          id: genId(),
          url: sd.hlsManifestUrl,
          pageUrl,
          userAgent: client.ua,
          httpHeaders: cdnHeaders,
          timestamp: Date.now(),
          mimeType: 'application/x-mpegURL',
          mediaType: 'hls',
          confidence: 0.95,
          provenance: 'yt-player-response',
          label: 'HLS',
        });
      }

      // ── 2. Muxed progressive formats (audio+video, single downloadable file) ──
      // Only formats with a direct `.url` are usable here — signatureCipher
      // entries require the live player JS to decipher and are skipped.
      const muxed: any[] = (sd.formats ?? []).filter(
        (f: any) => f?.url && typeof f.url === 'string' && f?.mimeType,
      );
      if (muxed.length > 0) {
        muxed.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
        const f = muxed[0];
        items.push({
          id: genId(),
          url: f.url as string,
          pageUrl,
          userAgent: client.ua,
          httpHeaders: cdnHeaders,
          timestamp: Date.now(),
          mimeType: f.mimeType as string,
          // googlevideo.com URLs → pickStrategy routes to 'direct'
          mediaType: 'hls',
          confidence: 0.90,
          provenance: 'yt-player-response',
          bitrate: typeof f.bitrate === 'number' ? f.bitrate : undefined,
          width:   typeof f.width   === 'number' ? f.width   : undefined,
          height:  typeof f.height  === 'number' ? f.height  : undefined,
          hasAudio: true,
          hasVideo: true,
          label: typeof f.qualityLabel === 'string' ? f.qualityLabel : undefined,
        });
      }

      // ── 3. DASH manifest (rare on mobile clients; kept for completeness) ──
      if (typeof sd.dashManifestUrl === 'string' && sd.dashManifestUrl) {
        items.push({
          id: genId(),
          url: sd.dashManifestUrl,
          pageUrl,
          userAgent: client.ua,
          httpHeaders: cdnHeaders,
          timestamp: Date.now(),
          mimeType: 'application/dash+xml',
          mediaType: 'dash',
          confidence: 0.82,
          provenance: 'yt-player-response',
          hasAudio: false,
          hasVideo: true,
          label: 'DASH',
        });
      }

      // NOTE: adaptiveFormats from InnerTube (IOS/ANDROID) are NOT included
      // because as of 2024+ YouTube enforces a Proof-of-Origin token (`pot`
      // query param) on HD adaptive segment URLs — they return HTTP 403 without
      // it. Only the 360p muxed itag-18 URL (above) and the iOS hlsManifestUrl
      // (when present) bypass this restriction. Generating a `pot` requires
      // running YouTube's BotGuard JS challenge.

      collected.push(...items);
      // Stop once we've got the HD source (HLS manifest).
      if (collected.some((it) => it.label === 'HLS')) break;
    } catch {
      // Try next client
    }
  }

  // Return only the best item so the caller (which auto-enqueues every item)
  // does not start multiple parallel downloads of the same video.
  // Preference: HLS (HD adaptive) > muxed mp4 (360p direct) > DASH manifest
  //           > first available.
  const best =
    collected.find((it) => it.label === 'HLS') ??
    collected.find((it) => it.hasAudio && it.hasVideo) ??
    collected.find((it) => it.mediaType === 'dash') ??
    collected[0];
  return best ? [best] : [];
}

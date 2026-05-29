/**
 * Optional server-assisted extraction.
 *
 * The on-device YouTube paths are deliberately limited to what works reliably
 * without po_token / BotGuard: HLS HD when YouTube serves it, 360p muxed
 * otherwise. For HD on every video the architecture leaves a hook here for a
 * user-supplied backend that runs real yt-dlp.
 *
 * Contract (POST JSON, returns JSON):
 *
 *   POST {url}/extract
 *   Body:  { "pageUrl": "https://www.youtube.com/watch?v=..." }
 *   200:   {
 *     "kind":           "hls" | "paired" | "direct",
 *     "url":            string,             // for kind=hls or kind=direct
 *     "videoUrl":       string?,            // for kind=paired (downloaded → native mux)
 *     "audioUrl":       string?,            // for kind=paired
 *     "headers":        { [name]: string }, // headers to replay on download
 *     "label"?:         string,             // e.g. "1080p"
 *     "expire"?:        number,             // unix seconds, for caching hints
 *     "mimeType"?:      string,
 *     "audioMimeType"?: string,             // for kind=paired
 *   }
 *   any-other-status:  treated as failure; caller falls back to on-device paths
 *
 * The server runs whatever extraction stack it wants — `yt-dlp` is the obvious
 * choice. A minimal reference Cloudflare-Worker / Fly.io container should fit
 * in <100 lines and cost ~$0/mo at hobby traffic.
 *
 * Configuration: bundled at build time, with legacy AsyncStorage values still
 * honored as a development override. When unset, this module is a no-op.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { DetectedMedia, FormatOption } from '../types';
import { extractSessionCookies } from './cookieManager';
import { debugLog, debugWarn } from './releaseLogger';

const STORAGE_KEY = '@fcdownloader/server_extractor_url';
const TOKEN_STORAGE_KEY = '@fcdownloader/server_extractor_token';
// YouTube via ytdl-stream: server runs 1–2 yt-dlp calls (extract + metadata)
// before returning. Each call takes 5–15 s from a datacenter IP. Allow 45 s.
const REQUEST_TIMEOUT_MS = 45_000;

// Compile-time defaults from .env.local (EXPO_PUBLIC_EXTRACTOR_URL / TOKEN).
// AsyncStorage values, when present, override these — letting power users
// point at a different backend without rebuilding.
const _extra = (Constants.expoConfig?.extra ?? {}) as {
  bundledExtractorUrl?: string;
  bundledExtractorToken?: string;
};
const BUNDLED_URL   = (_extra.bundledExtractorUrl   ?? '').trim();
const BUNDLED_TOKEN = (_extra.bundledExtractorToken ?? '').trim();
const SERVER_CONFIDENCE = 0.97;

function normaliseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

let _seq = 0;
const genId = () => `srv_${Date.now()}_${_seq++}`;

export interface ServerExtractResponse {
  kind: 'hls' | 'paired' | 'direct' | 'image' | 'audio' | 'gallery';
  url?: string;
  videoUrl?: string;
  audioUrl?: string;
  items?: ServerExtractResponse[];
  headers?: Record<string, string>;
  label?: string;
  expire?: number;
  mimeType?: string;
  audioMimeType?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  extractor?: string;
  formatId?: string;
  formats?: FormatOption[];
}

export async function getServerExtractorUrl(): Promise<string | null> {
  // Bundled value (from .env.local at build time) wins when set. The Settings
  // UI for the URL is hidden, so any AsyncStorage value is stale state from
  // earlier development; the bundled URL is the authoritative one.
  if (BUNDLED_URL) return normaliseUrl(BUNDLED_URL);
  try {
    const v = await AsyncStorage.getItem(STORAGE_KEY);
    if (v && v.trim()) return normaliseUrl(v);
  } catch {}
  return null;
}

export async function getServerExtractorToken(): Promise<string | null> {
  // Same precedence as the URL — bundled wins.
  if (BUNDLED_TOKEN) return BUNDLED_TOKEN;
  try {
    const v = await AsyncStorage.getItem(TOKEN_STORAGE_KEY);
    if (v && v.trim()) return v.trim();
  } catch {}
  return null;
}

/**
 * Returns DetectedMedia items when a server is configured AND responds with a
 * usable extraction. Returns an empty array otherwise — caller must fall back
 * to on-device paths.
 */
export async function extractViaServer(pageUrl: string): Promise<DetectedMedia[]> {
  const base = await getServerExtractorUrl();
  if (!base) return [];
  const token = await getServerExtractorToken();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Forward the user's logged-in cookies from the in-app WebView. If they
    // logged into the source site (Bilibili, Instagram, the platform with
    // their paywall) in the Browse tab, those cookies travel here and become
    // the auth context yt-dlp uses on the server. The server writes them to
    // a per-request cookies.txt so the cookiejar — not just the Cookie
    // header — gets populated, and every internal yt-dlp call inherits the
    // session. Without this, Bilibili tops out at 480p, Instagram fails on
    // most posts, etc.
    let cookies = '';
    try {
      cookies = await extractSessionCookies(pageUrl);
    } catch (e) {
      debugWarn('[serverExtractor] cookie read failed:', String(e).slice(0, 120));
    }
    const body: Record<string, unknown> = { pageUrl };
    if (cookies) body.cookies = cookies;

    const fullUrl = `${base}/extract`;
    debugLog('[serverExtractor] POST', fullUrl, 'token?', !!token, 'cookies?', cookies.length, 'chars');
    const res = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      debugWarn('[serverExtractor] HTTP', res.status);
      return [];
    }
    const data = (await res.json()) as ServerExtractResponse;
    return toDetectedMedia(data, pageUrl);
  } catch (e) {
    debugWarn('[serverExtractor] request failed:', String(e).slice(0, 200));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function toDetectedMedia(r: ServerExtractResponse, pageUrl: string): DetectedMedia[] {
  if (r.kind === 'gallery' && Array.isArray(r.items)) {
    return r.items.flatMap((item) => toDetectedMedia(item, pageUrl));
  }

  if (r.kind === 'image' && r.url && isLikelyThumbnailUrl(r.url)) return [];

  const headers = r.headers ?? {};
  const ua = headers['User-Agent'] ?? headers['user-agent'] ?? '';
  const baseItem = {
    id: genId(),
    pageUrl,
    userAgent: ua,
    httpHeaders: headers,
    timestamp: Date.now(),
    confidence: SERVER_CONFIDENCE,
    provenance: 'social-extractor' as const,
    sourcePageUrl: pageUrl,
    sourceTitle: r.title,
    duration: r.duration,
    extractor: r.extractor,
    formatId: r.formatId,
    availableFormats: r.formats,
  };

  if (r.kind === 'hls' && r.url) {
    return [{
      ...baseItem,
      url: r.url,
      mimeType: r.mimeType ?? 'application/x-mpegURL',
      mediaType: 'hls',
      mediaKind: 'video',
      label: r.label ?? 'HLS',
    }];
  }

  if (r.kind === 'paired' && r.videoUrl && r.audioUrl) {
    return [{
      ...baseItem,
      url: r.videoUrl,
      audioTrackUrl: r.audioUrl,
      audioTrackCodecs: r.audioMimeType,
      mimeType: r.mimeType ?? 'video/mp4',
      // audioTrackUrl set → dashDownloader Case 1 (download both, native mux)
      mediaType: 'dash',
      mediaKind: 'video',
      hasAudio: true,
      hasVideo: true,
      label: r.label ?? 'HD',
    }];
  }

  if ((r.kind === 'direct' || r.kind === 'image' || r.kind === 'audio') && r.url) {
    // When the server's ytdl-stream strategy wins it returns a /ytdl-stream
    // proxy URL as the download URL. The mobile app must download that URL
    // directly — not re-route through /download (which ignores item.url and
    // re-extracts the page, throwing the proxy URL away).
    const isYtdlStream = r.url.includes('/ytdl-stream?');
    return [{
      ...baseItem,
      url: r.url,
      mimeType: r.mimeType ?? 'video/mp4',
      mediaType: 'direct',
      mediaKind: directMediaKind(r),
      hasAudio: true,
      hasVideo: true,
      label: r.label ?? (isYtdlStream ? 'Server download' : undefined),
      // forceServerDownload=true → pickStrategy returns 'server-download' →
      // downloadViaServer detects the ytdl-stream URL and downloads directly.
      forceServerDownload: isYtdlStream,
    }];
  }

  return [];
}

function directMediaKind(r: ServerExtractResponse): NonNullable<DetectedMedia['mediaKind']> {
  const mimeType = r.mimeType ?? '';
  if (r.kind === 'image' || mimeType.startsWith('image/')) return 'image';
  if (r.kind === 'audio' || mimeType.startsWith('audio/')) return 'audio';
  return 'video';
}

function isLikelyThumbnailUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (!/\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(u)) return false;
  if (/(?:^|[\/_.-])(?:thumb|thumbnail|avatar|profile(?:_pic)?|placeholder|blank|pixel)(?:[\/_.-]|$)/i.test(u)) return true;
  if (/[?&](?:thumb|thumbnail|preview|avatar)=/i.test(u)) return true;
  try {
    const parsed = new URL(url);
    const dimensions = ['width', 'w', 'height', 'h']
      .map((key) => Number(parsed.searchParams.get(key) || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (dimensions.length && Math.max(...dimensions) <= 512) return true;
  } catch {}
  if (/(?:^|[\/_-])(?:\d{1,3}x\d{1,3}|s\d{2,4}x\d{2,4})(?:[\/_.-]|$)/i.test(u)) return true;
  return false;
}

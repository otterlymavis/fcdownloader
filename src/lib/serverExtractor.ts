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
import { DetectedMedia } from '../types';
import { extractSessionCookies } from './cookieManager';

const STORAGE_KEY = '@fcdownloader/server_extractor_url';
const TOKEN_STORAGE_KEY = '@fcdownloader/server_extractor_token';
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

const YOUTUBE_PAGE_RE = /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/i;
export const YOUTUBE_SIGN_IN_MESSAGE =
  'YouTube needs sign-in. Open Browse, log in to YouTube, then try again.';

export class YouTubeSignInRequiredError extends Error {
  constructor(message = YOUTUBE_SIGN_IN_MESSAGE) {
    super(message);
    this.name = 'YouTubeSignInRequiredError';
  }
}

export function isYouTubeSignInRequiredError(error: unknown): boolean {
  return error instanceof YouTubeSignInRequiredError ||
    (error instanceof Error && error.name === 'YouTubeSignInRequiredError');
}

function normaliseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

function isYouTubeAuthFailure(pageUrl: string, message: string): boolean {
  if (!YOUTUBE_PAGE_RE.test(pageUrl)) return false;
  return /sign in|confirm you'?re not a bot|cookies-from-browser|--cookies|authentication|login required/i.test(message);
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
      console.warn('[serverExtractor] cookie read failed:', String(e).slice(0, 120));
    }
    const body: Record<string, unknown> = { pageUrl };
    if (cookies) body.cookies = cookies;

    const fullUrl = `${base}/extract`;
    console.log('[serverExtractor] POST', fullUrl, 'token?', !!token, 'cookies?', cookies.length, 'chars');
    const res = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[serverExtractor] HTTP', res.status, text.slice(0, 200));
      if (isYouTubeAuthFailure(pageUrl, text)) {
        throw new YouTubeSignInRequiredError();
      }
      return [];
    }
    const data = (await res.json()) as ServerExtractResponse;
    return toDetectedMedia(data, pageUrl);
  } catch (e) {
    if (isYouTubeSignInRequiredError(e)) throw e;
    console.warn('[serverExtractor] request failed:', String(e).slice(0, 200));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function toDetectedMedia(r: ServerExtractResponse, pageUrl: string): DetectedMedia[] {
  if (r.kind === 'gallery' && Array.isArray(r.items)) {
    return r.items.flatMap((item) => toDetectedMedia(item, pageUrl));
  }

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
    return [{
      ...baseItem,
      url: r.url,
      mimeType: r.mimeType ?? 'video/mp4',
      mediaType: 'direct',
      mediaKind: directMediaKind(r),
      hasAudio: true,
      hasVideo: true,
      label: r.label,
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

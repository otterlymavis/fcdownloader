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
 * Configuration: stored in AsyncStorage under @fcdownloader/server_extractor_url
 * (settable from the SettingsSheet). When unset, this module is a no-op.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { DetectedMedia } from '../types';
import { extractSessionCookies } from './cookieManager';

const STORAGE_KEY = '@fcdownloader/server_extractor_url';
const TOKEN_STORAGE_KEY = '@fcdownloader/server_extractor_token';
const REQUEST_TIMEOUT_MS = 15_000;

// Compile-time defaults from .env.local (EXPO_PUBLIC_EXTRACTOR_URL / TOKEN).
// AsyncStorage values, when present, override these — letting power users
// point at a different backend without rebuilding.
const _extra = (Constants.expoConfig?.extra ?? {}) as {
  bundledExtractorUrl?: string;
  bundledExtractorToken?: string;
};
const BUNDLED_URL   = (_extra.bundledExtractorUrl   ?? '').trim();
const BUNDLED_TOKEN = (_extra.bundledExtractorToken ?? '').trim();

/** Whether this build is server-backed (HD via backend) or local-only (360p + opportunistic HLS HD). */
export function isServerBacked(): boolean {
  return BUNDLED_URL.length > 0;
}

function normaliseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

let _seq = 0;
const genId = () => `srv_${Date.now()}_${_seq++}`;

export interface ServerExtractResponse {
  kind: 'hls' | 'paired' | 'direct';
  url?: string;
  videoUrl?: string;
  audioUrl?: string;
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

export async function setServerExtractorUrl(url: string | null): Promise<void> {
  if (!url) { await AsyncStorage.removeItem(STORAGE_KEY); return; }
  await AsyncStorage.setItem(STORAGE_KEY, normaliseUrl(url));
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

export async function setServerExtractorToken(token: string | null): Promise<void> {
  if (!token) { await AsyncStorage.removeItem(TOKEN_STORAGE_KEY); return; }
  await AsyncStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
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
      console.warn('[serverExtractor] HTTP', res.status);
      return [];
    }
    const data = (await res.json()) as ServerExtractResponse;
    return toDetectedMedia(data, pageUrl);
  } catch (e) {
    console.warn('[serverExtractor] request failed:', String(e).slice(0, 200));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function toDetectedMedia(r: ServerExtractResponse, pageUrl: string): DetectedMedia[] {
  const headers = r.headers ?? {};
  const ua = headers['User-Agent'] ?? headers['user-agent'] ?? '';

  if (r.kind === 'hls' && r.url) {
    return [{
      id: genId(),
      url: r.url,
      pageUrl,
      userAgent: ua,
      httpHeaders: headers,
      timestamp: Date.now(),
      mimeType: r.mimeType ?? 'application/x-mpegURL',
      mediaType: 'hls',
      mediaKind: 'video',
      confidence: 0.97,
      provenance: 'social-extractor',
      label: r.label ?? 'HLS',
    }];
  }

  if (r.kind === 'paired' && r.videoUrl && r.audioUrl) {
    return [{
      id: genId(),
      url: r.videoUrl,
      audioTrackUrl: r.audioUrl,
      audioTrackCodecs: r.audioMimeType,
      pageUrl,
      userAgent: ua,
      httpHeaders: headers,
      timestamp: Date.now(),
      mimeType: r.mimeType ?? 'video/mp4',
      // audioTrackUrl set → dashDownloader Case 1 (download both, native mux)
      mediaType: 'dash',
      mediaKind: 'video',
      confidence: 0.97,
      provenance: 'social-extractor',
      hasAudio: true,
      hasVideo: true,
      label: r.label ?? 'HD',
    }];
  }

  if (r.kind === 'direct' && r.url) {
    return [{
      id: genId(),
      url: r.url,
      pageUrl,
      userAgent: ua,
      httpHeaders: headers,
      timestamp: Date.now(),
      mimeType: r.mimeType ?? 'video/mp4',
      mediaType: 'direct',
      mediaKind: (r.mimeType || '').startsWith('image/') ? 'image' : (r.mimeType || '').startsWith('audio/') ? 'audio' : 'video',
      confidence: 0.97,
      provenance: 'social-extractor',
      hasAudio: true,
      hasVideo: true,
      label: r.label,
    }];
  }

  return [];
}

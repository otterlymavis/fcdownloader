import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { extractSessionCookies } from './cookieManager';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';

interface VimeoSegment { start?: number; end?: number; url: string; size?: number; }

interface VimeoTrack {
  id: string;
  base_url?: string;
  bitrate?: number;
  avg_bitrate?: number;
  width?: number;
  height?: number;
  init_segment?: string;
  segments: VimeoSegment[];
}

interface VimeoPlaylist { base_url?: string; video?: VimeoTrack[]; }

const DOWNLOAD_BATCH = 4;
const VIMEO_PLAYLIST_JSON_RE = /vimeocdn\.com\/.*\/playlist\.json(?:[?#]|$)/i;

function taskDir(taskId: string): string {
  return `${FileSystem.documentDirectory}downloads/${taskId}/`;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) headers[existing] = value;
  else headers[name] = value;
}

function makeHeaders(cookies: string, userAgent: string, referer: string, captured?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = captured ? { ...captured } : {};
  if (!hasHeader(h, 'Accept')) h.Accept = '*/*';
  if (!hasHeader(h, 'Referer')) h.Referer = referer;
  if (!hasHeader(h, 'User-Agent')) h['User-Agent'] = userAgent;
  if (cookies && !hasHeader(h, 'Cookie')) h.Cookie = cookies;
  return h;
}

function resolveUrl(part: string, playlistUrl: string, playlist: VimeoPlaylist, track: VimeoTrack): string {
  const playlistDir = playlistUrl.slice(0, playlistUrl.lastIndexOf('/') + 1);
  const base = new URL(`${playlist.base_url ?? ''}${track.base_url ?? ''}`, playlistDir).toString();
  return new URL(part.replace(/\\u0026/g, '&'), base).toString();
}

function pickBestVideo(tracks: VimeoTrack[]): VimeoTrack {
  return [...tracks].sort((a, b) =>
    (b.height ?? 0) - (a.height ?? 0) ||
    (b.avg_bitrate ?? b.bitrate ?? 0) - (a.avg_bitrate ?? a.bitrate ?? 0)
  )[0];
}

function normalizeVimeoJsonUrl(value: string, baseUrl: string): string | undefined {
  const clean = value
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
  if (!clean) return undefined;
  try {
    const url = new URL(clean.startsWith('//') ? `https:${clean}` : clean, baseUrl).toString();
    return VIMEO_PLAYLIST_JSON_RE.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function findVimeoPlaylistJsonUrl(value: unknown, baseUrl: string, depth = 0, seen = new Set<unknown>()): string | undefined {
  if (depth > 10 || value == null) return undefined;
  if (typeof value === 'string') return normalizeVimeoJsonUrl(value, baseUrl);
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVimeoPlaylistJsonUrl(item, baseUrl, depth + 1, seen);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ['avc_url', 'url', 'json_url', 'playlist_url', 'playlistUrl', 'source_url', 'sourceUrl'];
  for (const key of preferredKeys) {
    const found = findVimeoPlaylistJsonUrl(record[key], baseUrl, depth + 1, seen);
    if (found) return found;
  }
  for (const item of Object.values(record)) {
    const found = findVimeoPlaylistJsonUrl(item, baseUrl, depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}

async function writeInit(track: VimeoTrack, path: string): Promise<void> {
  if (!track.init_segment) return;
  await FileSystem.writeAsStringAsync(path, track.init_segment, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

async function downloadFragment(
  url: string, path: string, headers: Record<string, string>, signal?: AbortSignal,
): Promise<void> {
  const res = await expoFetch(url, { signal, headers });
  if (signal?.aborted) throw new Error('Cancelled');
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${url.split('?')[0].split('/').pop()}`);
  const bytes = await res.bytes();
  if (bytes.length === 0) throw new Error('Empty fragment');
  const file = new File(path);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
}

function appendFile(handle: ReturnType<File['open']>, path: string): void {
  const input = new File(path).open();
  try {
    while ((input.offset ?? 0) < (input.size ?? 0)) {
      const rem = (input.size ?? 0) - (input.offset ?? 0);
      handle.writeBytes(input.readBytes(Math.min(1024 * 1024, rem)));
    }
  } finally { input.close(); }
}

export async function downloadVimeoJson(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onProgress, onStatus } = opts;
  onStatus?.('fetching_manifest');

  const cookies = await extractSessionCookies(media.pageUrl);
  const ua = media.userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';
  const referer = media.sourcePageUrl || media.pageUrl || 'https://player.vimeo.com/';
  const headers = makeHeaders(cookies, ua, referer, media.httpHeaders);
  const fragmentHeaders = { ...headers };
  setHeader(fragmentHeaders, 'Accept', '*/*');

  let playlistUrl = media.url;
  let res = await expoFetch(playlistUrl, { signal, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching Vimeo playlist`);
  let playlist = await res.json() as VimeoPlaylist;

  if (!playlist.video?.length) {
    const discoveredPlaylistUrl = findVimeoPlaylistJsonUrl(playlist, playlistUrl);
    if (!discoveredPlaylistUrl) throw new Error('Vimeo config has no playlist JSON URL');
    playlistUrl = discoveredPlaylistUrl;
    res = await expoFetch(playlistUrl, { signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching Vimeo playlist`);
    playlist = await res.json() as VimeoPlaylist;
  }

  const video = playlist.video?.length ? pickBestVideo(playlist.video) : undefined;
  if (!video) throw new Error('Vimeo playlist has no video track');

  const dir = taskDir(taskId);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  const initPath = `${dir}init.mp4`;
  await writeInit(video, initPath);

  onStatus?.('downloading');
  onProgress?.(0, video.segments.length);

  const segPaths: string[] = new Array(video.segments.length);
  for (let i = 0; i < video.segments.length; i += DOWNLOAD_BATCH) {
    if (signal?.aborted) throw new Error('Cancelled');
    await Promise.all(video.segments.slice(i, i + DOWNLOAD_BATCH).map((seg, j) => {
      const idx = i + j;
      segPaths[idx] = `${dir}seg${String(idx).padStart(5, '0')}.m4s`;
      return downloadFragment(resolveUrl(seg.url, playlistUrl, playlist, video), segPaths[idx], fragmentHeaders, signal);
    }));
    onProgress?.(Math.min(i + DOWNLOAD_BATCH, video.segments.length), video.segments.length);
  }

  onStatus?.('assembling');
  const output = new File(Paths.document, 'downloads', taskId, 'video.mp4');
  output.create({ intermediates: true, overwrite: true });
  const handle = output.open();
  try {
    appendFile(handle, initPath);
    segPaths.forEach((p) => appendFile(handle, p));
  } finally { handle.close(); }

  if (output.size === 0) throw new Error('Output file is empty');
  return output.uri;
}

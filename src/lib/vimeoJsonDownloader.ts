import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { extractSessionCookies } from './cookieManager';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';
import { muxVideoAudio } from './ffmpegMux';
import { downloadDirect } from './directDownloader';

interface VimeoSegment { start?: number; end?: number; url: string; size?: number; }

export interface VimeoTrack {
  id: string;
  base_url?: string;
  bitrate?: number;
  avg_bitrate?: number;
  width?: number;
  height?: number;
  init_segment?: string;
  segments: VimeoSegment[];
}

export interface VimeoPlaylist {
  base_url?: string;
  video?: VimeoTrack[];
  audio?: VimeoTrack[];
}

export interface VimeoProgressiveFile {
  url: string;
  width?: number;
  height?: number;
  bitrate?: number;
  mime?: string;
  quality?: string;
}

const DOWNLOAD_BATCH = 4;
const FRAGMENT_ATTEMPTS = 3;
const VIMEO_PLAYLIST_JSON_RE = /vimeocdn\.com\/.*\/playlist\.json(?:[?#]|$)/i;

class VimeoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    context: string,
  ) {
    super(`HTTP ${status} ${context}`);
    this.name = 'VimeoHttpError';
  }
}

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

async function fetchVimeo(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof expoFetch>>> {
  try {
    return await expoFetch(url, { signal, headers });
  } catch (error) {
    if (signal?.aborted) throw new Error('Cancelled');
    throw error;
  }
}

async function readVimeoJson(
  response: Awaited<ReturnType<typeof expoFetch>>,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw new Error('Cancelled');
    throw error;
  }
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

function pickBestAudio(tracks: VimeoTrack[], video: VimeoTrack): VimeoTrack | undefined {
  const matching = tracks.filter((track) => track.id === video.id);
  const candidates = matching.length > 0 ? matching : tracks;
  return [...candidates].sort((a, b) =>
    (b.avg_bitrate ?? b.bitrate ?? 0) - (a.avg_bitrate ?? a.bitrate ?? 0)
  )[0];
}

export function selectVimeoTracks(playlist: VimeoPlaylist): {
  video?: VimeoTrack;
  audio?: VimeoTrack;
} {
  const video = playlist.video?.length ? pickBestVideo(playlist.video) : undefined;
  return {
    video,
    audio: video && playlist.audio?.length
      ? pickBestAudio(playlist.audio, video)
      : undefined,
  };
}

export function selectBestVimeoProgressive(value: unknown, baseUrl: string): VimeoProgressiveFile | undefined {
  const progressive = (value as any)?.request?.files?.progressive;
  if (!Array.isArray(progressive)) return undefined;
  const candidates = progressive.flatMap((item: any): VimeoProgressiveFile[] => {
    if (!item || typeof item.url !== 'string') return [];
    try {
      const url = new URL(item.url.replace(/\\u0026/g, '&').replace(/\\\//g, '/'), baseUrl).toString();
      if (!/^https?:/i.test(url)) return [];
      return [{
        url,
        width: Number(item.width) || undefined,
        height: Number(item.height) || undefined,
        bitrate: Number(item.bitrate) || undefined,
        mime: typeof item.mime === 'string' ? item.mime : undefined,
        quality: typeof item.quality === 'string' ? item.quality : undefined,
      }];
    } catch {
      return [];
    }
  });
  return candidates.sort((a, b) =>
    (b.height ?? 0) - (a.height ?? 0) ||
    (b.width ?? 0) - (a.width ?? 0) ||
    (b.bitrate ?? 0) - (a.bitrate ?? 0)
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

export function findVimeoPlaylistJsonUrl(
  value: unknown,
  baseUrl: string,
  depth = 0,
  seen = new Set<unknown>(),
): string | undefined {
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

type VimeoFetcher = typeof fetchVimeo;

export async function loadVimeoPlaylist(
  initialUrl: string,
  headers: Record<string, string>,
  opts: DownloadOptions,
  fetcher: VimeoFetcher = fetchVimeo,
): Promise<{ playlistUrl: string; playlist: VimeoPlaylist; progressive?: VimeoProgressiveFile }> {
  const { signal, onTokenExpired } = opts;
  let currentUrl = initialUrl;
  let refreshed = false;
  const visited = new Set<string>();

  // A config URL normally resolves in two requests: player config, then signed
  // playlist.json. One extra iteration is reserved for refreshing an expired
  // signed URL through the extraction manager.
  for (let step = 0; step < 4; step += 1) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (visited.has(currentUrl)) throw new Error('Vimeo JSON resolution loop');
    visited.add(currentUrl);

    const response = await fetcher(currentUrl, headers, signal);
    if (response.status === 403 && !refreshed && onTokenExpired) {
      const freshUrl = await onTokenExpired(currentUrl);
      if (signal?.aborted) throw new Error('Cancelled');
      if (freshUrl && freshUrl !== currentUrl) {
        currentUrl = freshUrl;
        refreshed = true;
        // A stable player config URL may have already been visited before it
        // produced the expired signed playlist. Refreshing must be allowed to
        // revisit that config once so it can issue a replacement playlist URL.
        visited.clear();
        continue;
      }
    }
    if (!response.ok) {
      throw new VimeoHttpError(response.status, currentUrl, 'fetching Vimeo playlist');
    }

    const value = await readVimeoJson(response, signal);
    const progressive = selectBestVimeoProgressive(value, currentUrl);
    if (progressive) return { playlistUrl: currentUrl, playlist: {}, progressive };
    const playlist = value as VimeoPlaylist;
    if (playlist.video?.length) return { playlistUrl: currentUrl, playlist };

    const discoveredUrl = findVimeoPlaylistJsonUrl(value, currentUrl);
    if (!discoveredUrl) throw new Error('Vimeo config has no playlist JSON URL');
    currentUrl = discoveredUrl;
  }

  throw new Error('Vimeo JSON resolution exceeded safe request limit');
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
  const donePath = `${path}.done`;
  const existing = await FileSystem.getInfoAsync(path);
  const done = await FileSystem.getInfoAsync(donePath);
  if (existing.exists && (existing.size ?? 0) > 0 && done.exists) {
    try {
      if (await FileSystem.readAsStringAsync(donePath) === url) return;
    } catch {}
  }
  if (existing.exists || done.exists) {
    try { await FileSystem.deleteAsync(path, { idempotent: true }); } catch {}
    try { await FileSystem.deleteAsync(donePath, { idempotent: true }); } catch {}
  }

  let lastErr: Error = new Error('Vimeo fragment download failed');
  for (let attempt = 0; attempt < FRAGMENT_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchVimeo(url, headers, signal);
      if (signal?.aborted) throw new Error('Cancelled');
      if (!res.ok) {
        throw new VimeoHttpError(
          res.status,
          url,
          `fetching ${url.split('?')[0].split('/').pop()}`,
        );
      }
      const bytes = await res.bytes();
      if (bytes.length === 0) throw new Error('Empty fragment');
      const file = new File(path);
      file.create({ intermediates: true, overwrite: true });
      file.write(bytes);
      await FileSystem.writeAsStringAsync(donePath, url);
      return;
    } catch (err) {
      lastErr = err as Error;
      if (signal?.aborted || lastErr.message === 'Cancelled') throw lastErr;
      if (lastErr instanceof VimeoHttpError && lastErr.status < 500) throw lastErr;
      try { await FileSystem.deleteAsync(path, { idempotent: true }); } catch {}
      try { await FileSystem.deleteAsync(donePath, { idempotent: true }); } catch {}
      if (attempt < FRAGMENT_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
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

async function downloadTrack(
  track: VimeoTrack,
  kind: 'video' | 'audio',
  dir: string,
  playlistUrl: string,
  playlist: VimeoPlaylist,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onFragment: () => void,
): Promise<string> {
  const trackDir = `${dir}${kind}/`;
  await FileSystem.makeDirectoryAsync(trackDir, { intermediates: true });

  const initPath = `${trackDir}init.mp4`;
  await writeInit(track, initPath);

  const segPaths: string[] = new Array(track.segments.length);
  for (let i = 0; i < track.segments.length; i += DOWNLOAD_BATCH) {
    if (signal?.aborted) throw new Error('Cancelled');
    const batch = await Promise.allSettled(
      track.segments.slice(i, i + DOWNLOAD_BATCH).map(async (seg, j) => {
        const idx = i + j;
        segPaths[idx] = `${trackDir}seg${String(idx).padStart(5, '0')}.m4s`;
        await downloadFragment(
          resolveUrl(seg.url, playlistUrl, playlist, track),
          segPaths[idx],
          headers,
          signal,
        );
        onFragment();
      }),
    );
    const failed = batch.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }

  const trackPath = `${dir}${kind}.track.${kind === 'video' ? 'mp4' : 'm4a'}`;
  const output = new File(trackPath);
  output.create({ intermediates: true, overwrite: true });
  const handle = output.open();
  try {
    appendFile(handle, initPath);
    segPaths.forEach((path) => appendFile(handle, path));
  } finally {
    handle.close();
  }
  if (output.size === 0) throw new Error(`Vimeo ${kind} track is empty`);
  return output.uri;
}

async function cleanupVimeoFiles(dir: string, includeOutput = false): Promise<void> {
  const paths = [
    `${dir}video/`,
    `${dir}audio/`,
    `${dir}video.track.mp4`,
    `${dir}audio.track.m4a`,
  ];
  if (includeOutput) paths.push(`${dir}video.mp4`);
  await Promise.all(paths.map(async (path) => {
    try {
      await FileSystem.deleteAsync(path, { idempotent: true });
    } catch {}
  }));
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

  const dir = taskDir(taskId);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  let sourceUrl = media.url;
  let refreshUsed = false;
  const refreshOnce = async (expiredUrl: string): Promise<string | null> => {
    if (refreshUsed || !opts.onTokenExpired) return null;
    refreshUsed = true;
    const freshUrl = await opts.onTokenExpired(expiredUrl);
    if (signal?.aborted) throw new Error('Cancelled');
    return freshUrl && freshUrl !== expiredUrl ? freshUrl : null;
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let completed = false;
    let resolvedPlaylistUrl = sourceUrl;
    try {
      const loaded = await loadVimeoPlaylist(
        sourceUrl,
        headers,
        { ...opts, onTokenExpired: refreshOnce },
      );
      const { playlistUrl, playlist } = loaded;
      resolvedPlaylistUrl = playlistUrl;
      if (loaded.progressive) {
        completed = true;
        return await downloadDirect({
          ...media,
          url: loaded.progressive.url,
          mimeType: loaded.progressive.mime || 'video/mp4',
          mediaType: 'direct',
          mediaKind: 'video',
          width: loaded.progressive.width,
          height: loaded.progressive.height,
          bitrate: loaded.progressive.bitrate,
          hasAudio: true,
          hasVideo: true,
          httpHeaders: fragmentHeaders,
        }, taskId, opts);
      }
      const { video, audio } = selectVimeoTracks(playlist);
      if (!video) throw new Error('Vimeo playlist has no video track');

      onStatus?.('downloading');
      const totalFragments = video.segments.length + (audio?.segments.length ?? 0);
      let downloadedFragments = 0;
      const onFragment = () => {
        downloadedFragments += 1;
        onProgress?.(downloadedFragments, totalFragments);
      };
      onProgress?.(0, totalFragments);

      const videoPath = await downloadTrack(
        video, 'video', dir, playlistUrl, playlist, fragmentHeaders, signal, onFragment,
      );

      const output = new File(Paths.document, 'downloads', taskId, 'video.mp4');
      if (audio) {
        const audioPath = await downloadTrack(
          audio, 'audio', dir, playlistUrl, playlist, fragmentHeaders, signal, onFragment,
        );
        if (signal?.aborted) throw new Error('Cancelled');
        onStatus?.('assembling');
        const stripFileScheme = (path: string) => path.replace(/^file:\/\//, '');
        await muxVideoAudio(
          stripFileScheme(videoPath),
          stripFileScheme(audioPath),
          stripFileScheme(output.uri),
        );
      } else {
        if (signal?.aborted) throw new Error('Cancelled');
        onStatus?.('assembling');
        await FileSystem.deleteAsync(output.uri, { idempotent: true });
        const input = new File(videoPath);
        input.copy(output);
      }

      if (signal?.aborted) throw new Error('Cancelled');
      if (output.size === 0) throw new Error('Output file is empty');
      completed = true;
      onProgress?.(1, 1);
      return output.uri;
    } catch (error) {
      await cleanupVimeoFiles(dir, true);
      if (error instanceof VimeoHttpError && error.status === 403) {
        // Re-extract against the canonical JSON candidate, not the individual
        // fragment URL. Excluding only a failed fragment can allow the picker
        // to return the same stale playlist.json again.
        const freshUrl = await refreshOnce(resolvedPlaylistUrl);
        if (freshUrl && attempt === 0) {
          sourceUrl = freshUrl;
          onStatus?.('fetching_manifest');
          continue;
        }
      }
      throw error;
    } finally {
      if (completed) await cleanupVimeoFiles(dir);
    }
  }

  throw new Error('Vimeo download retry limit exceeded');
}

import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { extractSessionCookies } from './cookieManager';
import { debugLog } from './releaseLogger';
import { DetectedMedia, DownloadStatus } from '../types';

export class DRMProtectedError extends Error {
  constructor(msg: string) { super(msg); this.name = 'DRMProtectedError'; }
}

export type ProgressCallback = (done: number, total: number) => void;
export type StatusCallback = (s: DownloadStatus, err?: string) => void;
export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  onStatus?: StatusCallback;
}

interface HLSKey { method: string; uri: string; iv?: string; }
interface ParsedPlaylist {
  segments: string[];
  byteRanges?: (string | null)[];
  extinf: string[];
  targetDuration: number;
  mediaSequence: number;
  key?: HLSKey;
  initSegmentUrl?: string;
  isFmp4: boolean;
}

const SEGMENT_BATCH = 12;
const MUX_READ_CHUNK_SIZE = 1024 * 1024;

function getTaskDir(taskId: string): string {
  return `${FileSystem.documentDirectory}downloads/${taskId}/`;
}

function resolveUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    const b = new URL(base);
    if (url.startsWith('//')) return `${b.protocol}${url}`;
    if (url.startsWith('/')) return `${b.protocol}//${b.host}${url}`;
    return base.slice(0, base.lastIndexOf('/') + 1) + url;
  } catch { return url; }
}

function parseMaster(content: string, baseUrl: string): string | null {
  if (!content.includes('#EXT-X-STREAM-INF')) return null;
  const lines = content.split('\n').map(l => l.trim());
  let bestBw = -1, bestUri: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] ?? '0', 10);
    const uri = lines[i + 1];
    if (uri && !uri.startsWith('#') && bw >= bestBw) {
      bestBw = bw; bestUri = resolveUrl(uri, baseUrl);
    }
  }
  return bestUri;
}

function parseMedia(content: string, baseUrl: string): ParsedPlaylist {
  const lines = content.split('\n').map(l => l.trim());
  const segments: string[] = [], extinf: string[] = [], byteRanges: (string | null)[] = [];
  let targetDuration = 10, mediaSequence = 0, isFmp4 = false;
  let key: HLSKey | undefined, initSegmentUrl: string | undefined;
  let pendingExtinf = '';
  let pendingByteRange: string | null = null;
  let currentOffset = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:'))
      targetDuration = parseInt(line.split(':')[1], 10);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
      mediaSequence = parseInt(line.split(':')[1], 10);
    else if (line.startsWith('#EXT-X-KEY:')) {
      const method = line.match(/METHOD=([^,\s]+)/)?.[1] ?? '';
      const rawUri = line.match(/URI="([^"]+)"/)?.[1] ?? '';
      const iv = line.match(/IV=([^\s,]+)/)?.[1];
      const kf = line.match(/KEYFORMAT="([^"]+)"/)?.[1];
      if (!method || method === 'NONE') {
        key = undefined;
        continue;
      }
      // Only DRM when KEYFORMAT explicitly names a DRM system.
      // SAMPLE-AES / SAMPLE-AES-CTR without a DRM KEYFORMAT is standard HLS
      // encryption (used by YouTube fMP4 streams); the key URI is public.
      if (kf === 'com.apple.streamingkeydelivery' || kf?.startsWith('urn:uuid:'))
        throw new DRMProtectedError('DRM-protected — stream uses platform DRM (FairPlay/Widevine).');
      key = { method, uri: resolveUrl(rawUri, baseUrl), iv };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const u = line.match(/URI="([^"]+)"/)?.[1];
      if (u) { initSegmentUrl = resolveUrl(u, baseUrl); isFmp4 = true; }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = line.split(':')[1].trim();
    } else if (line.startsWith('#EXTINF:')) {
      pendingExtinf = line;
    } else if (line && !line.startsWith('#')) {
      segments.push(resolveUrl(line, baseUrl));
      extinf.push(pendingExtinf || '#EXTINF:10.0,');
      pendingExtinf = '';

      if (pendingByteRange) {
        const parts = pendingByteRange.split('@');
        const length = parseInt(parts[0], 10);
        const offset = parts[1] ? parseInt(parts[1], 10) : currentOffset;
        byteRanges.push(`${length}@${offset}`);
        currentOffset = offset + length;
        pendingByteRange = null;
      } else {
        byteRanges.push(null);
      }

      if (line.includes('.m4s') || (line.includes('.mp4') && !line.includes('.m3u8'))) isFmp4 = true;
    }
  }
  return { segments, byteRanges, extinf, targetDuration, mediaSequence, key, initSegmentUrl, isFmp4 };
}

function makeHeaders(cookies: string, ua: string, referer: string): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': ua, 'Accept': '*/*', 'Referer': referer };
  if (cookies) h['Cookie'] = cookies;
  return h;
}

async function fetchText(
  url: string, headers: Record<string, string>, signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(url, { signal, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching manifest`);
  return (await res.text()) ?? '';
}

async function downloadSegment(
  url: string,
  destPath: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('Cancelled');
  debugLog('[downloadSegment] starting:', url.split('?')[0].split('/').pop(), 'range:', headers['Range']);
  let lastErr: Error = new Error('Segment download failed');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled');
    try {
      const result = await FileSystem.downloadAsync(url, destPath, { headers });
      if (signal?.aborted) {
        try { await FileSystem.deleteAsync(destPath, { idempotent: true }); } catch {}
        throw new Error('Cancelled');
      }
      if (!result || result.status < 200 || result.status >= 300) {
        throw new Error(`HTTP ${result?.status ?? 'unknown'} downloading segment`);
      }
      const info = await FileSystem.getInfoAsync(destPath);
      if (!info.exists || (info.size ?? 0) === 0) {
        throw new Error(`Empty segment - ${url.split('?')[0].split('/').pop()}`);
      }
      debugLog('[downloadSegment] success:', destPath.split('/').pop(), 'size:', info.size);
      return;
    } catch (err: any) {
      lastErr = err as Error;
      if (signal?.aborted || lastErr.message === 'Cancelled') throw lastErr;
      if (attempt < 2) {
        debugLog('[downloadSegment] retrying after error:', lastErr.message);
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  console.error('[downloadSegment] failed after 3 attempts:', lastErr.message);
  throw lastErr;
}

async function muxSegments(
  taskId: string,
  initPath: string | undefined,
  segPaths: string[],
  isFmp4: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const ext = isFmp4 ? 'mp4' : 'ts';
  const outFile = new File(Paths.document, 'downloads', taskId, `video.${ext}`);
  outFile.create({ intermediates: true, overwrite: true });

  debugLog(`[muxSegments] Started muxing ${segPaths.length} segments into video.${ext}`);

  if (initPath) {
    debugLog(`[muxSegments] Appending init segment: ${initPath}`);
    const initFile = new File(initPath);
    const bytes = await initFile.bytes();
    outFile.write(bytes, { append: true });
  }

  for (let i = 0; i < segPaths.length; i++) {
    if (i % 10 === 0 || i === segPaths.length - 1) {
      debugLog(`[muxSegments] Appending segment ${i + 1}/${segPaths.length}`);
    }
    const segFile = new File(segPaths[i]);
    const bytes = await segFile.bytes();
    outFile.write(bytes, { append: true });
    onProgress?.(i + 1, segPaths.length);
  }

  if (outFile.size === 0) throw new Error('Output file is empty - segments may be corrupted or the URL expired');
  debugLog(`[muxSegments] Completed. Output size: ${outFile.size}`);

  return outFile.uri;
}

async function writePlaylist(
  taskDir: string,
  segPaths: string[],
  extinf: string[],
  targetDuration: number,
  mediaSequence: number,
  key: HLSKey | undefined,
  localKeyPath: string | undefined,
  localInitPath: string | undefined,
): Promise<string> {
  const playlistPath = `${taskDir}playlist.m3u8`;
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
  ];
  if (key && localKeyPath) {
    lines.push(`#EXT-X-KEY:METHOD=${key.method},URI="${localKeyPath}"${key.iv ? `,IV=${key.iv}` : ''}`);
  }
  if (localInitPath) lines.push(`#EXT-X-MAP:URI="${localInitPath}"`);
  segPaths.forEach((p, i) => {
    lines.push(extinf[i] || '#EXTINF:10.0,');
    lines.push(p);
  });
  lines.push('#EXT-X-ENDLIST');
  await FileSystem.writeAsStringAsync(playlistPath, lines.join('\n'));
  return playlistPath;
}

export async function downloadHLS(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onProgress, onStatus } = opts;

  onStatus?.('fetching_manifest');

  const ua = media.userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

  const taskDir = getTaskDir(taskId);
  await FileSystem.makeDirectoryAsync(taskDir, { intermediates: true });

  // When the extractor stored headers (e.g. YouTube CDN context), use them verbatim.
  // Otherwise build from session cookies — skip cookies for googlevideo.com CDN URLs.
  const makeResolvedHeaders = async (url: string): Promise<Record<string, string>> => {
    const skipCookies = /googlevideo\.com\//i.test(url);
    if (media.httpHeaders) {
      const headers = { ...media.httpHeaders };
      const hasCookie = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
      if (!hasCookie && !skipCookies) {
        const cookies = await extractSessionCookies(media.pageUrl);
        if (cookies) headers['Cookie'] = cookies;
      }
      return headers;
    }
    return makeHeaders(skipCookies ? '' : await extractSessionCookies(media.pageUrl), ua, media.pageUrl);
  };
  const resolvedHeaders = await makeResolvedHeaders(media.url);

  let playlistUrl = media.url;
  let raw = await fetchText(playlistUrl, resolvedHeaders, signal);

  // Every HLS playlist MUST begin with #EXTM3U (RFC 8216 §4.1).
  // An HTML error page or CDN redirect page that leaks into media detection
  // would otherwise have every non-# line parsed as a segment URL — including
  // HTML tags with '<' characters — causing iOS NSURLRequest to reject the
  // "segment URL" with a native error rather than a clear HTTP status.
  if (!raw.trimStart().startsWith('#EXTM3U')) {
    throw new Error('Not a valid HLS manifest (missing #EXTM3U)');
  }

  if (raw.includes('#EXT-X-STREAM-INF')) {
    const variant = parseMaster(raw, playlistUrl);
    if (!variant) throw new Error('No variant streams in master playlist');
    playlistUrl = variant;
    raw = await fetchText(playlistUrl, resolvedHeaders, signal);
    if (!raw.trimStart().startsWith('#EXTM3U')) {
      throw new Error('Not a valid HLS media playlist (missing #EXTM3U)');
    }
  }

  if (signal?.aborted) throw new Error('Cancelled');

  const { segments, byteRanges, extinf, targetDuration, mediaSequence, key, initSegmentUrl, isFmp4 } =
    parseMedia(raw, playlistUrl);

  if (segments.length === 0) throw new Error('No segments found in playlist');

  let localKeyPath: string | undefined;
  if (key) {
    localKeyPath = `${taskDir}enc.key`;
    await downloadSegment(key.uri, localKeyPath, resolvedHeaders, signal);
  }

  let localInitPath: string | undefined;
  if (initSegmentUrl) {
    localInitPath = `${taskDir}init.mp4`;
    await downloadSegment(initSegmentUrl, localInitPath, resolvedHeaders, signal);
  }

  onStatus?.('downloading');
  onProgress?.(0, segments.length);

  const segExt = isFmp4 ? 'm4s' : 'ts';
  const segPaths: string[] = new Array(segments.length);

  for (let i = 0; i < segments.length; i += SEGMENT_BATCH) {
    if (signal?.aborted) throw new Error('Cancelled');
    const batch = segments.slice(i, i + SEGMENT_BATCH);
    debugLog(`[downloadHLS] starting batch ${i / SEGMENT_BATCH + 1}/${Math.ceil(segments.length / SEGMENT_BATCH)}`);
    await Promise.all(batch.map((url, j) => {
      const idx = i + j;
      const br = byteRanges?.[idx];
      segPaths[idx] = `${taskDir}seg${String(idx).padStart(6, '0')}.${segExt}`;

      let segmentHeaders = resolvedHeaders;
      if (br) {
        const parts = br.split('@');
        const length = parseInt(parts[0], 10);
        const offset = parseInt(parts[1], 10);
        segmentHeaders = {
          ...resolvedHeaders,
          'Range': `bytes=${offset}-${offset + length - 1}`,
        };
      }
      return downloadSegment(url, segPaths[idx], segmentHeaders, signal);
    }));
    debugLog(`[downloadHLS] finished batch ${i / SEGMENT_BATCH + 1}/${Math.ceil(segments.length / SEGMENT_BATCH)}`);
    onProgress?.(Math.min(i + SEGMENT_BATCH, segments.length), segments.length);
  }

  onStatus?.('assembling');

  if (key) {
    // Encrypted stream (AES-128, SAMPLE-AES, etc.) — write a local playlist
    // so the player decrypts during playback rather than us muxing raw ciphertext.
    return writePlaylist(
      taskDir,
      segPaths,
      extinf,
      targetDuration,
      mediaSequence,
      key,
      localKeyPath,
      localInitPath,
    );
  }

  return muxSegments(
    taskId, localInitPath, segPaths, isFmp4,
    (done, total) => onProgress?.(done, total),
  );
}

export async function deleteDownload(taskId: string): Promise<void> {
  try {
    const dir = getTaskDir(taskId);
    const info = await FileSystem.getInfoAsync(dir);
    if (info.exists) await FileSystem.deleteAsync(dir, { idempotent: true });
  } catch {}
}

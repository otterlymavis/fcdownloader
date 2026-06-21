import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';
import { extractSessionCookies } from './cookieManager';
import { getServerExtractorToken, getServerExtractorUrl, ServerExtractionError } from './serverExtractor';
import { debugWarn } from './releaseLogger';

function guessExt(media: DetectedMedia, contentType?: string | null): string {
  const mime = (contentType || media.mimeType || '').toLowerCase();
  const urlExt = media.url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (urlExt && !/m3u8|mpd/i.test(urlExt)) return urlExt.toLowerCase();
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('audio/mp4')) return 'm4a';
  if (mime.startsWith('audio/')) return mime.split('/')[1] || 'mp3';
  if (mime.includes('webm')) return 'webm';
  return media.mediaKind === 'audio' ? 'm4a' : 'mp4';
}

function fileStem(media: DetectedMedia): string {
  if (media.mediaKind === 'image') return 'image';
  if (media.mediaKind === 'audio') return 'audio';
  return 'video';
}

function contentRangeTotal(contentRange: string | null): number {
  const total = contentRange?.match(/\/(\d+)$/)?.[1];
  return total ? parseInt(total, 10) : 0;
}

function canStreamSelectedDirectUrl(media: DetectedMedia): boolean {
  if (media.audioOnly || media.audioTrackUrl) return false;
  if (!media.httpHeaders || Object.keys(media.httpHeaders).length === 0) return false;
  if (media.mediaType !== 'direct') return false;
  if (/\.(?:mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(media.url)) return true;
  return /(?:cdninstagram\.com|scontent[-\w]*\.cdninstagram\.com|fbcdn\.net|threadscdn\.com|video\.twimg\.com|tiktokcdn\.com|tiktokcdn-us\.com|v\d+-webapp[^/]*\.tiktok\.com|weibocdn\.com|xhscdn\.com|akamaized\.net|cloudfront\.net|jwpcdn\.com|jwplatform\.com|kaltura\.com|mux\.com|mux\.dev)/i.test(media.url);
}

export async function downloadViaServer(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;
  const base = await getServerExtractorUrl();
  if (!base) throw new Error('Server extractor URL is not configured');

  onStatus?.('fetching_manifest');

  // ytdl-stream proxy URL: the server already did the extraction and returned
  // a /ytdl-stream?page_url=... URL. Download it directly using
  // the streaming download path — do NOT re-route through /download, which
  // would discard this URL and re-extract (double download, wrong path).
  if (!media.audioOnly && media.url?.includes('/ytdl-stream?')) {
    return _downloadYtdlStream(media, taskId, opts);
  }

  const token = await getServerExtractorToken();
  const cookies = await extractSessionCookies(media.pageUrl).catch(() => '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const streamSelectedUrl = canStreamSelectedDirectUrl(media);
  const sourceUrl = streamSelectedUrl ? media.url : (media.sourcePageUrl || media.pageUrl || media.url);
  const body = JSON.stringify({
    pageUrl: sourceUrl,
    referer: streamSelectedUrl
      ? (media.sourcePageUrl || media.pageUrl || undefined)
      : media.pageUrl && media.pageUrl !== sourceUrl ? media.pageUrl : undefined,
    cookies: cookies || undefined,
    formatId: media.formatId || undefined,
    audioOnly: media.audioOnly || undefined,
    subtitles: media.subtitles || undefined,
    subLangs: media.subLangs || undefined,
    headers: streamSelectedUrl ? media.httpHeaders : undefined,
  });

  const dir = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  // Large proxied streams (e.g. a 60MB+ Bilibili video) occasionally drop with an
  // HTTP/2 stream reset / connection error part-way through. The proxy re-extracts
  // on every request (signed CDN URLs rotate), so byte-range resume isn't reliable
  // — instead restart the whole transfer a few times on transient errors. 4xx,
  // explicit cancellation and JSON error bodies are fatal and never retried.
  let lastError: Error = new Error('Server download failed');
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('Cancelled');
    try {
      return await _streamServerDownloadOnce(
        `${base}/download`, headers, body, media, dir, opts,
      );
    } catch (err) {
      const e = err as Error;
      lastError = e;
      if (signal?.aborted || e.message === 'Cancelled') throw e;
      if (attempt >= MAX_DOWNLOAD_ATTEMPTS || !isRetryableDownloadError(e)) throw e;
      debugWarn(`[serverDownloader] attempt ${attempt} failed (${e.message.slice(0, 80)}); retrying`);
      onStatus?.('fetching_manifest');
      await delay(800 * attempt);
    }
  }
  throw lastError;
}

const MAX_DOWNLOAD_ATTEMPTS = 3;
const READ_STALL_MS = 30_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  abort: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(new Error('Download stalled'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeAttemptSignal(signal: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void; abort: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort);
  return {
    signal: controller.signal,
    abort,
    cleanup: () => signal?.removeEventListener('abort', abort),
  };
}

/** Transient network/stream failures worth restarting the transfer for. */
function isRetryableDownloadError(err: Error): boolean {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('cancelled')) return false;
  // 5xx gateway hiccups (proxy cold start / upstream) are retryable; 4xx is not.
  if (/\((?:5\d\d)\)/.test(msg)) return true;
  // Twitter/X's guest-token API is flaky and intermittently makes yt-dlp report
  // "failed to instantiate extractor" / "no video formats" — a retry usually
  // succeeds on the next guest token.
  if (/instantiate|no video formats|unable to extract|guest token/.test(msg)) return true;
  return /reset|internal_error|econnreset|epipe|network request failed|stream|connection|socket|timeout|timed out|eof|terminated/.test(
    msg,
  );
}

/** One full attempt: request the proxy and stream the response to a fresh file. */
async function _streamServerDownloadOnce(
  url: string,
  headers: Record<string, string>,
  body: string,
  media: DetectedMedia,
  dir: string,
  opts: DownloadOptions,
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;
  const attemptSignal = makeAttemptSignal(signal);
  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(url, { method: 'POST', headers, body, signal: attemptSignal.signal });
  } catch (err) {
    attemptSignal.cleanup();
    throw err;
  }

  if (signal?.aborted) {
    attemptSignal.cleanup();
    throw new Error('Cancelled');
  }
  if (!res.ok) {
    let detail = `Server download failed (${res.status})`;
    let errorCode: string | undefined;
    if (res.status === 429) {
      errorCode = 'RATE_LIMITED';
      detail = 'Server rate limit reached — please wait a moment and try again';
    } else {
      try {
        const text = await res.text();
        const parsed = JSON.parse(text);
        const rawDetail = parsed?.detail;
        if (rawDetail && typeof rawDetail === 'object') {
          if (rawDetail.message) detail = String(rawDetail.message).slice(0, 400);
          errorCode = rawDetail.error_code;
        } else {
          const msg = rawDetail ?? parsed?.error ?? text;
          if (typeof msg === 'string' && msg.trim()) detail = msg.slice(0, 400);
        }
      } catch {}
    }
    // Preserve the status code in the message so isRetryableDownloadError can
    // see 5xx even when a JSON detail replaced the default text.
    const finalDetail = /\(\d{3}\)/.test(detail) ? detail : `${detail} (${res.status})`;
    attemptSignal.cleanup();
    if (errorCode) throw new ServerExtractionError(finalDetail, errorCode);
    throw new Error(finalDetail);
  }
  if (!res.body) {
    attemptSignal.cleanup();
    throw new Error('Server download returned an empty body');
  }

  // Guard: a real media stream is never JSON. Detect a JSON error body that
  // slipped through (wrong-status proxy response, CDN error, etc.).
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    let detail = `Server returned JSON instead of media (status ${res.status})`;
    try {
      const text = await res.text();
      const parsed = JSON.parse(text);
      const msg = parsed?.detail ?? parsed?.error ?? text;
      if (typeof msg === 'string' && msg.trim()) detail = msg.slice(0, 400);
    } catch {}
    attemptSignal.cleanup();
    throw new Error(detail);
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const ext = guessExt(media, contentType);
  const filePath = `${dir}${fileStem(media)}.${ext}`;

  onStatus?.('downloading');
  onProgress?.(0, contentLength || 1);

  const file = new File(filePath);
  file.create({ intermediates: true, overwrite: true });
  const handle = file.open();

  try {
    const reader = res.body.getReader();
    let written = 0;
    while (true) {
      const { done, value } = await readWithTimeout(reader, READ_STALL_MS, attemptSignal.abort);
      if (done) break;
      if (signal?.aborted) throw new Error('Cancelled');
      handle.writeBytes(value);
      written += value.byteLength;
      onProgress?.(written, contentLength || Math.max(written, 1));
    }
  } finally {
    handle.close();
    attemptSignal.cleanup();
  }

  if (file.size === 0) throw new Error('Server download produced an empty file');
  // A truncated transfer (stream reset before Content-Length) must not be saved
  // as a success — surface it as retryable so the loop restarts.
  if (contentLength > 0 && file.size < contentLength) {
    throw new Error(`Truncated download: ${file.size}/${contentLength} bytes (stream reset)`);
  }
  onStatus?.('assembling');
  onProgress?.(1, 1);
  return filePath;
}

// Download a /ytdl-stream?... URL directly. The server ran yt-dlp in download
// mode, blocks until the file is ready, then streams it back with Content-Length.
// Session cookies are sent in X-FCDL-Cookies so the URL stays short; the bearer
// token still goes in Authorization for endpoint protection.
async function _downloadYtdlStream(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions,
): Promise<string> {
  const { signal, onStatus } = opts;
  let lastError: Error = new Error('ytdl-stream failed');
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('Cancelled');
    try {
      return await _downloadYtdlStreamOnce(media, taskId, opts);
    } catch (err) {
      const e = err as Error;
      lastError = e;
      if (signal?.aborted || e.message === 'Cancelled') throw e;
      if (attempt >= MAX_DOWNLOAD_ATTEMPTS || !isRetryableDownloadError(e)) throw e;
      debugWarn(`[serverDownloader] ytdl-stream attempt ${attempt} failed (${e.message.slice(0, 80)}); retrying`);
      onStatus?.('fetching_manifest');
      await delay(800 * attempt);
    }
  }
  throw lastError;
}

async function _downloadYtdlStreamOnce(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions,
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;
  onStatus?.('downloading');

  const token = await getServerExtractorToken();
  const reqHeaders: Record<string, string> = {};
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  const cookies = await extractSessionCookies(media.pageUrl).catch(() => '');
  if (cookies) reqHeaders['X-FCDL-Cookies'] = cookies;

  const dir = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const filePath = `${dir}${fileStem(media)}.${guessExt(media)}`;
  const existing = await FileSystem.getInfoAsync(filePath);
  let written = existing.exists ? (existing.size ?? 0) : 0;
  let fileReady = written > 0;
  if (written > 0) reqHeaders.Range = `bytes=${written}-`;

  const attemptSignal = makeAttemptSignal(signal);
  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(media.url, { headers: reqHeaders, signal: attemptSignal.signal });
  } catch (err) {
    attemptSignal.cleanup();
    throw err;
  }

  if (signal?.aborted) {
    attemptSignal.cleanup();
    throw new Error('Cancelled');
  }
  if (!res.ok) {
    if (res.status === 416 && written > 0) {
      const total = contentRangeTotal(res.headers.get('content-range'));
      attemptSignal.cleanup();
      if (total > 0 && written >= total) {
        onStatus?.('assembling');
        onProgress?.(1, 1);
        return filePath;
      }
      try { await FileSystem.deleteAsync(filePath, { idempotent: true }); } catch {}
      throw new Error('ytdl stream range reset required');
    }
    let detail = `ytdl-stream failed (${res.status})`;
    let errorCode: string | undefined;
    if (res.status === 429) {
      errorCode = 'RATE_LIMITED';
      detail = 'Server rate limit reached — please wait a moment and try again';
    } else {
      try {
        const body = await res.text();
        const parsed = JSON.parse(body);
        const rawDetail = parsed?.detail;
        if (rawDetail && typeof rawDetail === 'object') {
          if (rawDetail.message) detail = String(rawDetail.message).slice(0, 400);
          errorCode = rawDetail.error_code;
        } else {
          const msg = rawDetail ?? parsed?.error ?? body;
          if (typeof msg === 'string' && msg.trim()) detail = msg.slice(0, 400);
        }
      } catch { /* ignore parse errors — fall through to generic message */ }
    }
    attemptSignal.cleanup();
    if (errorCode) throw new ServerExtractionError(detail, errorCode);
    throw new Error(detail);
  }

  // Guard: detect a JSON error body that slipped through (e.g. expoFetch
  // treating a non-2xx redirect as ok, or a CDN error page with wrong status).
  // A real video stream never has Content-Type: application/json.
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    let detail = `Server returned JSON instead of video (status ${res.status})`;
    try {
      const body = await res.text();
      const parsed = JSON.parse(body);
      const msg = parsed?.detail ?? parsed?.error ?? body;
      if (typeof msg === 'string' && msg.trim()) detail = msg.slice(0, 400);
    } catch {}
    attemptSignal.cleanup();
    throw new Error(detail);
  }

  if (!res.body) {
    attemptSignal.cleanup();
    throw new Error('ytdl-stream returned an empty body');
  }

  // A server without Range support may answer a resume request with 200.
  // Restart the local file in that case so bytes are not duplicated.
  if (written > 0 && res.status !== 206) {
    written = 0;
    fileReady = false;
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const expectedTotal = res.status === 206
    ? contentRangeTotal(res.headers.get('content-range')) || (written + contentLength)
    : contentLength;

  onProgress?.(written, expectedTotal || Math.max(written, 1));

  const file = new File(filePath);
  if (!fileReady) file.create({ intermediates: true, overwrite: true });
  const handle = file.open();

  try {
    handle.offset = written;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await readWithTimeout(reader, READ_STALL_MS, attemptSignal.abort);
      if (done) break;
      if (signal?.aborted) throw new Error('Cancelled');
      handle.writeBytes(value);
      written += value.byteLength;
      onProgress?.(written, expectedTotal || Math.max(written, 1));
    }
  } finally {
    handle.close();
    attemptSignal.cleanup();
  }

  if (file.size === 0) throw new Error('ytdl-stream produced an empty file');
  if (expectedTotal > 0 && file.size < expectedTotal) {
    throw new Error(`Truncated ytdl-stream download: ${file.size}/${expectedTotal} bytes`);
  }
  // A real video file is always larger than 1 KB. A JSON error body that was
  // accidentally written to disk (e.g. due to a network-layer quirk) is tiny.
  if (file.size < 1024) {
    throw new Error(`ytdl-stream produced a suspiciously small file (${file.size} bytes) — the download may have failed on the server`);
  }
  onStatus?.('assembling');
  onProgress?.(1, 1);
  return filePath;
}

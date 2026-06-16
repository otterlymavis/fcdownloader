import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { extractSessionCookies } from './cookieManager';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';

const MEDIA_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'mov',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac',
  // subtitle/caption formats
  'vtt', 'webvtt', 'srt', 'ttml', 'dfxp', 'ass', 'ssa',
]);

function guessExt(url: string, mimeType?: string | null, mediaKind?: DetectedMedia['mediaKind']): string {
  const path = url.split('?')[0].toLowerCase();
  const m = path.match(/\.([a-z0-9]{2,6})$/);
  if (m && MEDIA_EXTS.has(m[1])) return m[1];
  if (mimeType) {
    const mt = mimeType.toLowerCase();
    if (mt.includes('text/vtt') || mt.includes('x-webvtt') || mt.includes('webvtt')) return 'vtt';
    if (mt.includes('subrip') || mt.includes('x-srt')) return 'srt';
    if (mt.includes('ttml') || mt.includes('dfxp')) return 'ttml';
    if (mt.includes('jpeg')) return 'jpg';
    if (mt.includes('png')) return 'png';
    if (mt.includes('webp')) return 'webp';
    if (mt.includes('gif')) return 'gif';
    if (mt.includes('avif')) return 'avif';
    if (mt.includes('heic')) return 'heic';
    if (mt.includes('mpeg')) return 'mp3';
    if (mt.includes('audio/mp4') || mt.includes('m4a')) return 'm4a';
    if (mt.includes('wav')) return 'wav';
    if (mt.includes('ogg')) return 'ogg';
    if (mt.includes('mp4')) return 'mp4';
    if (mt.includes('webm')) return 'webm';
    if (mt.includes('mov') || mt.includes('quicktime')) return 'mov';
  }
  if (mediaKind === 'subtitle') return 'vtt';
  if (mediaKind === 'image' || mediaIsImage(url, mimeType)) return 'jpg';
  if (mediaIsAudio(url, mimeType)) return 'mp3';
  return 'mp4';
}

function mediaIsImage(url: string, mimeType?: string | null): boolean {
  return /^image\//i.test(mimeType || '') || /\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(url);
}

function mediaIsAudio(url: string, mimeType?: string | null): boolean {
  return /^audio\//i.test(mimeType || '') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(url);
}

function mediaIsSubtitle(url: string, mimeType?: string | null, mediaKind?: DetectedMedia['mediaKind']): boolean {
  if (mediaKind === 'subtitle') return true;
  const mt = (mimeType || '').toLowerCase();
  if (/text\/vtt|x-subrip|x-webvtt|ttml|dfxp/.test(mt)) return true;
  return /\.(vtt|webvtt|srt|ttml|dfxp|ass|ssa)(?:[?#]|$)/i.test(url);
}

function contentTypeLooksLikeMedia(contentType: string, media: DetectedMedia): boolean {
  const ct = contentType.toLowerCase();
  if (!ct) return true;
  if (
    ct.includes('text/html') ||
    ct.includes('text/xml') ||
    ct.includes('application/xhtml') ||
    ct.includes('application/json')
  ) {
    return false;
  }
  if (ct.includes('application/octet-stream') || ct.includes('binary/octet-stream')) return true;
  if (mediaIsSubtitle(media.url, media.mimeType, media.mediaKind)) {
    return ct.startsWith('text/vtt') || ct.startsWith('text/plain') || ct.startsWith('application/x-subrip') || ct.startsWith('text/');
  }
  if (media.mediaKind === 'image' || mediaIsImage(media.url, media.mimeType)) return ct.startsWith('image/');
  if (media.mediaKind === 'audio' || mediaIsAudio(media.url, media.mimeType)) return ct.startsWith('audio/') || ct.startsWith('application/ogg') || ct.startsWith('video/ogg');
  return ct.startsWith('video/') || ct.includes('mp4') || ct.includes('mpegurl');
}

export async function downloadDirect(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;

  onStatus?.('fetching_manifest');

  const ua = media.userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

  // When the extractor stored headers (e.g. YouTube CDN context), use them verbatim.
  // Otherwise build from session cookies — skip cookies for googlevideo.com CDN URLs.
  let headers: Record<string, string>;
  if (media.httpHeaders) {
    headers = { ...media.httpHeaders };
    const hasCookie = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
    if (!hasCookie && !/googlevideo\.com\//i.test(media.url)) {
      const cookies = await extractSessionCookies(media.pageUrl);
      if (cookies) headers['Cookie'] = cookies;
    }
  } else {
    const needsCookies = !/googlevideo\.com\//i.test(media.url);
    const cookies = needsCookies ? await extractSessionCookies(media.pageUrl) : '';
    headers = { 'User-Agent': ua, 'Referer': media.pageUrl, 'Accept': '*/*' };
    if (cookies) headers['Cookie'] = cookies;
  }

  const ext = guessExt(media.url, media.mimeType, media.mediaKind);
  const dir = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  const baseName = mediaIsSubtitle(media.url, media.mimeType, media.mediaKind)
    ? 'subtitle'
    : media.mediaKind === 'image' || mediaIsImage(media.url, media.mimeType)
      ? 'image'
      : media.mediaKind === 'audio' || mediaIsAudio(media.url, media.mimeType)
        ? 'audio'
        : 'video';
  const filePath = `${dir}${baseName}.${ext}`;

  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  onStatus?.('downloading');
  onProgress?.(0, 1);

  const MAX_ATTEMPTS = 3;
  let lastErr: Error = new Error('Download failed');
  let downloadUrl = media.url;
  let tokenRefreshed = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled');
    try {
      const res = await expoFetch(downloadUrl, { headers, signal });
      if (signal?.aborted) throw new Error('Cancelled');
      if (!res.ok) {
        // On a first 403, try refreshing the CDN token before giving up.
        if (res.status === 403 && !tokenRefreshed && opts.onTokenExpired) {
          const freshUrl = await opts.onTokenExpired(media.url);
          if (freshUrl) {
            downloadUrl = freshUrl;
            tokenRefreshed = true;
            attempt--; // don't count this as one of MAX_ATTEMPTS
            continue;
          }
        }
        throw new Error(`HTTP ${res.status} — server rejected the request`);
      }
      if (!res.body) throw new Error('Download returned an empty body');

      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!contentTypeLooksLikeMedia(ct, media)) {
        throw new Error('Server returned a page or non-media response instead of downloadable media');
      }

      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      onProgress?.(0, contentLength || 1);

      const file = new File(filePath);
      file.create({ intermediates: true, overwrite: true });
      const handle = file.open();
      try {
        const reader = res.body.getReader();
        let written = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal?.aborted) throw new Error('Cancelled');
          handle.writeBytes(value);
          written += value.byteLength;
          onProgress?.(written, contentLength || Math.max(written, 1));
        }
      } finally {
        handle.close();
      }

      if (file.size === 0) throw new Error('Downloaded file is empty — the URL may require a login or has expired');
      break; // success — exit retry loop
    } catch (err) {
      lastErr = err as Error;
      if (signal?.aborted || lastErr.message === 'Cancelled') throw lastErr;
      // Only retry on network / 5xx errors, not on auth or content-type errors
      const isRetryable = !/HTTP [234]\d\d|non-media|login|expired/.test(lastErr.message);
      if (!isRetryable || attempt === MAX_ATTEMPTS - 1) throw lastErr;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  onProgress?.(1, 1);
  onStatus?.('assembling');
  return filePath;
}

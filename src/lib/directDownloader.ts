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
]);

function guessExt(url: string, mimeType?: string | null, mediaKind?: DetectedMedia['mediaKind']): string {
  const path = url.split('?')[0].toLowerCase();
  const m = path.match(/\.([a-z0-9]{2,5})$/);
  if (m && MEDIA_EXTS.has(m[1])) return m[1];
  if (mimeType) {
    const mt = mimeType.toLowerCase();
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
  const baseName = media.mediaKind === 'image' || mediaIsImage(media.url, media.mimeType)
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
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled');
    try {
      const res = await expoFetch(media.url, { headers, signal });
      if (signal?.aborted) throw new Error('Cancelled');
      if (!res.ok) throw new Error(`HTTP ${res.status} — server rejected the request`);
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

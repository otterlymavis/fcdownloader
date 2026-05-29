import * as FileSystem from 'expo-file-system/legacy';
import { extractSessionCookies } from './cookieManager';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';

const MEDIA_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'mov',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac',
]);

function guessExt(url: string, mimeType?: string | null): string {
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
  if (mediaIsImage(url, mimeType)) return 'jpg';
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
  if (media.mediaKind === 'audio' || mediaIsAudio(media.url, media.mimeType)) return ct.startsWith('audio/');
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

  const ext = guessExt(media.url, media.mimeType);
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

  let aborted = false;
  const resumable = FileSystem.createDownloadResumable(
    media.url,
    filePath,
    { headers },
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (totalBytesExpectedToWrite > 0) {
        onProgress?.(totalBytesWritten, totalBytesExpectedToWrite);
      }
    },
  );

  signal?.addEventListener('abort', () => {
    aborted = true;
    resumable.pauseAsync().catch(() => {});
  });

  const result = await resumable.downloadAsync();

  if (aborted || signal?.aborted) throw new Error('Cancelled');
  if (!result || result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result?.status ?? 'unknown'} — server rejected the request`);
  }

  // Reject HTML error pages returned with 200 OK (CDN redirect chains to /404, /error, etc.)
  const ct = (
    (result.headers as Record<string, string> | undefined)?.['Content-Type'] ??
    (result.headers as Record<string, string> | undefined)?.['content-type'] ?? ''
  ).toLowerCase();
  if (!contentTypeLooksLikeMedia(ct, media)) {
    throw new Error('Server returned a page or non-media response instead of downloadable media');
  }

  const info = await FileSystem.getInfoAsync(filePath);
  if (!info.exists || (info.size ?? 0) === 0) {
    throw new Error('Downloaded file is empty — the URL may require a login or has expired');
  }

  onProgress?.(1, 1);
  onStatus?.('assembling');
  return filePath;
}

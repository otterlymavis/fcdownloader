import * as FileSystem from 'expo-file-system/legacy';
import { extractSessionCookies } from './cookieManager';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';

function guessExt(url: string, mimeType?: string | null): string {
  const path = url.split('?')[0].toLowerCase();
  const m = path.match(/\.([a-z0-9]{2,5})$/);
  if (m) return m[1];
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

function expectsLargeMedia(media: DetectedMedia): boolean {
  return (
    media.mediaKind === 'video' ||
    media.mediaKind === 'audio' ||
    (!media.mediaKind && !mediaIsImage(media.url, media.mimeType))
  );
}

function tinyDownloadMessage(media: DetectedMedia): string {
  if (/(?:xiaohongshu\.com|xhslink\.com|xhscdn\.com)/i.test(`${media.pageUrl} ${media.url}`)) {
    return 'Xiaohongshu returned a tiny non-media file. Open Browse, log in to Xiaohongshu, reload the post, then try again.';
  }

  return 'Downloaded file is too small to be media. The site likely returned a login, challenge, or expired-link page.';
}

function isXiaohongshuMedia(media: DetectedMedia): boolean {
  return /(?:xiaohongshu\.com|xhslink\.com|xhscdn\.com)/i.test(`${media.pageUrl} ${media.url}`);
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

  if (isXiaohongshuMedia(media)) {
    headers['User-Agent'] = headers['User-Agent'] || ua;
    headers['Referer'] = 'https://www.xiaohongshu.com/';
    headers['Origin'] = 'https://www.xiaohongshu.com';
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
  if (ct.includes('text/html') || ct.includes('text/xml')) {
    throw new Error('Server returned an HTML page instead of video — the URL may have expired or require login');
  }

  const info = await FileSystem.getInfoAsync(filePath);
  if (!info.exists || (info.size ?? 0) === 0) {
    throw new Error('Downloaded file is empty — the URL may require a login or has expired');
  }

  if (expectsLargeMedia(media) && (info.size ?? 0) < 32 * 1024) {
    throw new Error(tinyDownloadMessage(media));
  }

  onProgress?.(1, 1);
  onStatus?.('assembling');
  return filePath;
}

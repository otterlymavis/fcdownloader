import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';
import { extractSessionCookies } from './cookieManager';
import { getServerExtractorToken, getServerExtractorUrl } from './serverExtractor';

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
  // a /ytdl-stream?page_url=...&cookies=... URL. Download it directly using
  // the streaming download path — do NOT re-route through /download, which
  // would discard this URL and re-extract (double download, wrong path).
  if (media.url.includes('/ytdl-stream?')) {
    return _downloadYtdlStream(media, taskId, opts);
  }

  const token = await getServerExtractorToken();
  const cookies = await extractSessionCookies(media.pageUrl).catch(() => '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const sourceUrl = media.sourcePageUrl || media.pageUrl || media.url;
  const res = await expoFetch(`${base}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pageUrl: sourceUrl,
      referer: media.pageUrl && media.pageUrl !== sourceUrl ? media.pageUrl : undefined,
      cookies: cookies || undefined,
      formatId: media.formatId || undefined,
    }),
    signal,
  });

  if (signal?.aborted) throw new Error('Cancelled');
  if (!res.ok) throw new Error(`Server download failed (${res.status})`);
  if (!res.body) throw new Error('Server download returned an empty body');

  const contentType = res.headers.get('content-type');
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const ext = guessExt(media, contentType);
  const dir = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  const filePath = `${dir}${fileStem(media)}.${ext}`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  onStatus?.('downloading');
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

  if (file.size === 0) throw new Error('Server download produced an empty file');
  onStatus?.('assembling');
  onProgress?.(1, 1);
  return filePath;
}

// Download a /ytdl-stream?... URL directly. The server ran yt-dlp in download
// mode, blocks until the file is ready, then streams it back with Content-Length.
// Cookies are already baked into the URL query string by the server; we still
// send the bearer token in the Authorization header for endpoint protection.
async function _downloadYtdlStream(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions,
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;
  onStatus?.('downloading');

  const token = await getServerExtractorToken();
  const reqHeaders: Record<string, string> = {};
  if (token) reqHeaders.Authorization = `Bearer ${token}`;

  const res = await expoFetch(media.url, { headers: reqHeaders, signal });

  if (signal?.aborted) throw new Error('Cancelled');
  if (!res.ok) throw new Error(`ytdl-stream failed (${res.status})`);
  if (!res.body) throw new Error('ytdl-stream returned an empty body');

  const contentType = res.headers.get('content-type');
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const ext = guessExt(media, contentType);
  const dir = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  const filePath = `${dir}${fileStem(media)}.${ext}`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

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

  if (file.size === 0) throw new Error('ytdl-stream produced an empty file');
  onStatus?.('assembling');
  onProgress?.(1, 1);
  return filePath;
}

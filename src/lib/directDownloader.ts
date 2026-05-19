import * as FileSystem from 'expo-file-system/legacy';
import { extractSessionCookies } from './cookieManager';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';

function guessExt(url: string, mimeType?: string | null): string {
  const path = url.split('?')[0].toLowerCase();
  const m = path.match(/\.([a-z0-9]{2,4})$/);
  if (m) return m[1];
  if (mimeType) {
    const mt = mimeType.toLowerCase();
    if (mt.includes('mp4')) return 'mp4';
    if (mt.includes('webm')) return 'webm';
    if (mt.includes('mov') || mt.includes('quicktime')) return 'mov';
  }
  return 'mp4';
}

export async function downloadDirect(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;

  onStatus?.('fetching_manifest');

  const cookies = await extractSessionCookies(media.pageUrl);
  const ua = media.userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';
  const headers: Record<string, string> = {
    'User-Agent': ua,
    'Referer': media.pageUrl,
    'Accept': '*/*',
  };
  if (cookies) headers['Cookie'] = cookies;

  const ext = guessExt(media.url, media.mimeType);
  const dir = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  const filePath = `${dir}video.${ext}`;

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

  const info = await FileSystem.getInfoAsync(filePath);
  if (!info.exists || (info.size ?? 0) === 0) {
    throw new Error('Downloaded file is empty — the URL may require a login or has expired');
  }

  onProgress?.(1, 1);
  onStatus?.('assembling');
  return filePath;
}

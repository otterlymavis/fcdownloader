/**
 * YouTube download flow — on-device only.
 *
 * No bypass attempts for po_token / BotGuard. Always re-extracts via
 * InnerTube (HLS HD when YouTube serves it, 360p muxed mp4 otherwise) and
 * routes by media shape: HLS → downloadHLS, direct mp4 → streamToDisk.
 *
 * We re-extract instead of trusting `media.url` because URLs captured during
 * in-browser playback usually reflect the low-res variant the WebView was
 * actually streaming.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { DetectedMedia } from '../types';
import { downloadHLS, DownloadOptions } from './hlsDownloader';
import { extractYouTubeStreams } from './ytExtractor';

const YT_CDN_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Origin':  'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
  'Accept':  '*/*',
};

async function streamToDisk(
  url: string,
  headers: Record<string, string>,
  taskId: string,
  signal: AbortSignal | undefined,
  onProgress: DownloadOptions['onProgress'],
): Promise<string> {
  const ext      = url.split('?')[0].split('.').pop()?.slice(0, 4) ?? 'mp4';
  const dir      = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  const filePath = `${dir}video.${ext.length <= 4 ? ext : 'mp4'}`;

  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  console.log('[ytDlp] GET', url.slice(0, 120));

  const res = await expoFetch(url, { signal, headers });
  console.log('[ytDlp] response status:', res.status, 'content-length:', res.headers.get('content-length'));

  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  if (!res.body) throw new Error('Empty response body');

  const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
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
      if (contentLength > 0) onProgress?.(written, contentLength);
    }
  } finally {
    handle.close();
  }

  if (file.size === 0) throw new Error('Downloaded file is empty — URL may have expired');

  onProgress?.(1, 1);
  return filePath;
}

export async function downloadWithYtDlp(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;

  onStatus?.('fetching_manifest');

  // Always re-extract — browser-captured URLs typically reflect whatever
  // low-res variant the WebView player happened to be streaming.
  console.log('[ytDlp] re-extracting from page:', media.pageUrl);
  const items = await extractYouTubeStreams(media.pageUrl);

  if (items.length === 0) {
    throw new Error('YouTube extraction failed — video may be unavailable or require sign-in');
  }

  // Preference: HLS manifest (HD when YouTube serves it, no muxing required)
  //           → muxed mp4 (360p guaranteed fallback).
  const best =
    items.find((f) => f.mediaType === 'hls' && /\.m3u8|\/manifest\//i.test(f.url)) ??
    items.find((f) => f.hasAudio && f.hasVideo) ??
    items[0];

  console.log('[ytDlp] best:',
    'mediaType=', best.mediaType,
    'paired=', !!best.audioTrackUrl,
    'label=', best.label,
    'url=', best.url.slice(0, 80));

  // HLS manifest → segment downloader (handles master playlist + variant pick).
  if (best.mediaType === 'hls' && /\.m3u8|\/manifest\//i.test(best.url)) {
    return downloadHLS(best, taskId, opts);
  }

  // Direct progressive mp4 (360p itag-18 or anything single-file).
  onStatus?.('downloading');
  const path = await streamToDisk(
    best.url,
    best.httpHeaders ?? YT_CDN_HEADERS,
    taskId, signal, onProgress,
  );
  onStatus?.('assembling');
  return path;
}

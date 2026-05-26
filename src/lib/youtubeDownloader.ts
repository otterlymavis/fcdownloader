/**
 * YouTube download flow.
 *
 * The complexity here is intentionally bounded. We do NOT attempt to bypass
 * po_token / BotGuard / Service-Worker-hidden segment requests on-device —
 * those approaches were tried (page-scrape + nsig regex, headless WebView
 * capture, glibc yt-dlp binary in jniLibs) and all failed for the same root
 * cause: modern YouTube adaptive playback is gated on signatures we can't
 * compute on the device.
 *
 * Two tiers, both already invoked at extraction time in `platformExtractors`:
 *   1. Optional server extractor (if user has configured one)
 *   2. InnerTube — HLS HD when YouTube hands out an hlsManifestUrl, 360p
 *      muxed mp4 (itag 18) as the guaranteed fallback
 *
 * Whatever `media` arrives here, we delegate to the right downloader based on
 * shape: HLS manifest → downloadHLS, paired adaptive (server tier only) →
 * downloadDASH+native mux, direct mp4 → streamToDisk. We also re-extract
 * because browser-captured URLs typically reflect the low-res variant the
 * WebView was streaming.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { DetectedMedia } from '../types';
import { downloadHLS, DownloadOptions } from './hlsDownloader';
import { downloadDASH } from './dashDownloader';
import { downloadViaServer } from './serverDownloader';
import { extractYouTubeStreams } from './ytExtractor';
import { extractViaServer } from './serverExtractor';

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
  // Use a regex so URLs like /ytdl-stream (no file extension in path) fall
  // back to 'mp4' instead of producing a garbage extension from split('.').
  const extMatch = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  const ext      = extMatch ? extMatch[1].toLowerCase() : 'mp4';
  const dir      = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  const filePath = `${dir}video.${ext}`;

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

export async function downloadYouTube(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;

  onStatus?.('fetching_manifest');

  // Always re-extract — browser-captured URLs typically reflect whatever
  // low-res variant the WebView player happened to be streaming.
  console.log('[ytDlp] re-extracting from page:', media.pageUrl);
  let items = await extractViaServer(media.pageUrl);
  if (items.length === 0) items = await extractYouTubeStreams(media.pageUrl);

  if (items.length === 0) {
    throw new Error('YouTube extraction failed — video may be unavailable or require sign-in');
  }

  // Preference: HLS manifest (HD when YouTube serves it, no muxing required)
  //           → paired adaptive (HD from server extractor → native mux)
  //           → muxed mp4 (360p guaranteed fallback).
  const best =
    items.find((f) => f.mediaType === 'hls' && /\.m3u8|\/manifest\//i.test(f.url)) ??
    items.find((f) => f.audioTrackUrl) ??
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
  // Paired adaptive (server tier only) → DASH downloader's paired-track path
  // muxes via the native MediaMuxerModule.
  if (best.audioTrackUrl) {
    return downloadDASH(best, taskId, opts);
  }

  // ytdl-stream proxy URL (set by the server extractor when yt-dlp in
  // skip_download mode hits the SABR bot-check and falls back to a blocking
  // download proxy).  Must go through downloadViaServer / _downloadYtdlStream
  // which carries the bearer token and applies the JSON-error guard.
  // Calling streamToDisk directly on this URL would:
  //   a) produce a wrong file extension  (url has no .mp4 in the path), and
  //   b) skip the content-type check, so a JSON error body can be written
  //      to disk as a "video" file.
  if (best.forceServerDownload || best.url.includes('/ytdl-stream?')) {
    return downloadViaServer(best, taskId, opts);
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

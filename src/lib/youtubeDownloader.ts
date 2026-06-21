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
import { DetectedMedia } from '../types';
import { downloadHLS, DownloadOptions } from './hlsDownloader';
import { downloadDASH } from './dashDownloader';
import { downloadViaServer } from './serverDownloader';
import { downloadDirect } from './directDownloader';
import { extractYouTubeStreams } from './ytExtractor';
import { extractViaServer } from './serverExtractor';
import { debugLog } from './releaseLogger';

const YT_CDN_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Origin':  'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
  'Accept':  '*/*',
};

export async function downloadYouTube(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;

  onStatus?.('fetching_manifest');

  // Always re-extract — browser-captured URLs typically reflect whatever
  // low-res variant the WebView player happened to be streaming.
  debugLog('[ytDlp] re-extracting from page:', media.pageUrl);
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

  debugLog('[ytDlp] best:',
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
  return downloadDirect(
    { ...best, mediaType: 'direct', httpHeaders: best.httpHeaders ?? YT_CDN_HEADERS },
    taskId,
    { ...opts, signal, onProgress },
  );
}

import { DetectedMedia, DownloadStrategy } from '../types';
import { Platform } from 'react-native';
import { downloadHLS, DRMProtectedError, DownloadOptions } from './hlsDownloader';
import { downloadDirect } from './directDownloader';
import { downloadVimeoJson } from './vimeoJsonDownloader';
import { downloadDASH } from './dashDownloader';
import { downloadYouTube } from './youtubeDownloader';
import { downloadViaServer } from './serverDownloader';
import { getServerExtractorUrl } from './serverExtractor';
import { getSiteCapabilities } from './siteRegistry';

export { DRMProtectedError };

const VIMEO_PLAYLIST_JSON = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i;
const DASH_MIME = /application\/(dash|x-mpegdash)\+xml/i;
const DIRECT_MEDIA_RE = /\.(?:mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)|googlevideo\.com\/videoplayback/i;

/**
 * Determine download strategy purely by manifest type, not by platform.
 * Platform-specific logic lives in the injected script / platform extractors.
 */
const YT_PAGE_RE = /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/i;

export function pickStrategy(media: DetectedMedia): DownloadStrategy {
  const url  = media.url;
  const mime = media.mimeType ?? '';
  const pageUrl = media.pageUrl ?? '';

  if (media.audioOnly) return 'server-download';
  if (media.forceServerDownload) return 'server-download';
  if (media.mediaKind === 'image' || media.mediaKind === 'audio') return 'direct';
  if (/^(image|audio)\//i.test(mime)) return 'direct';

  // Auth-gated sites (Bilibili, Instagram, Xiaohongshu, NicoNico) hand back
  // IP/UA/cookie-locked *video* CDN URLs that a device-side direct or DASH fetch
  // can't satisfy — they 403/504 even with a Referer. Their registry entry sets
  // requiresAuth + a 'server-download' preference, so route video through the
  // proxy (which replays headers/cookies from a stable IP). Gated to video with
  // server-provided headers only: image galleries from the same sites (an XHS or
  // Instagram carousel) download fine device-side via the direct/CDN paths
  // below, and the proxy 502s on them — the on-device extractor mis-types their
  // extension-less CDN URLs as video, so without these guards they'd wrongly
  // route here.
  const isVideo =
    media.mediaKind === 'video' ||
    media.mediaType === 'dash' ||
    media.mediaType === 'hls' ||
    media.hasVideo === true;
  const hasServerHeaders =
    !!media.httpHeaders && Object.keys(media.httpHeaders).length > 0;
  const caps = getSiteCapabilities(pageUrl);
  if (
    isVideo &&
    hasServerHeaders &&
    caps?.requiresAuth &&
    caps.preferredStrategies[0] === 'server-download' &&
    (media.provenance === 'social-extractor' || !!media.sourcePageUrl)
  ) {
    return 'server-download';
  }

  // YouTube: on Android use yt-dlp binary; on iOS re-extract fresh signed URLs.
  // Both paths avoid the 403 caused by missing nsig transform on browse-tab-detected URLs.
  if (pageUrl.includes('tv.naver.com')) {
    return 'server-download';
  }
  if (YT_PAGE_RE.test(pageUrl)) return 'yt-dlp';

  // Paired tracks delivered as HLS playlists (e.g. Twitter/X's
  // video.twimg.com/.../pl/ renditions) can't be muxed by the on-device DASH
  // downloader — it expects MP4 segments. The server muxes them reliably via
  // ffmpeg, so route HLS-paired video to the proxy instead of a doomed DASH try.
  const isHlsTrack = (u: string) => /\.m3u8?(?:[?#]|$)/i.test(u) || /\/pl\//i.test(u);
  if (media.audioTrackUrl && (isHlsTrack(url) || isHlsTrack(media.audioTrackUrl))) {
    return 'server-download';
  }

  // Paired audio track → must mux (Bilibili DASH, custom paired streams)
  if (media.audioTrackUrl) return 'dash';

  // Vimeo JSON playlist
  if (VIMEO_PLAYLIST_JSON.test(url)) return 'vimeo-json';

  // Explicit DASH manifest
  if (media.mediaType === 'dash') return 'dash';
  if (/\.mpd(\?|#|$)/i.test(url) || DASH_MIME.test(mime)) return 'dash';
  // YouTube DASH manifest (no .mpd extension in URL)
  if (/manifest\.googlevideo\.com\/api\/manifest\/dash/i.test(url)) return 'dash';

  // Explicit HLS manifest
  if (/\.m3u8?(?:[?#]|$)/i.test(url) || /mpegurl/i.test(mime)) return 'hls-segments';

  // Direct video file
  if (/\.(mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp)(?:[?#]|$)/i.test(url)) return 'direct';

  // YouTube progressive CDN URL (muxed itag, single file)
  if (/googlevideo\.com\/videoplayback/i.test(url)) return 'direct';

  // Bilibili CDN (single-file track without paired audio)
  if (/bilivideo\.com\//i.test(url)) return 'direct';

  // Meta/TikTok/Twitter direct CDN URLs are usually signed MP4/WebM responses
  // even when the URL path does not expose a file extension.
  if (/(?:cdninstagram\.com|scontent[-\w]*\.cdninstagram\.com|fbcdn\.net|threadscdn\.com|video\.twimg\.com|tiktokcdn\.com|tiktokcdn-us\.com|v\d+-webapp\.tiktok\.com|weibocdn\.com|xhscdn\.com|akamaized\.net|cloudfront\.net|jwpcdn\.com|jwplatform\.com|kaltura\.com|mux\.com|mux\.dev)/i.test(url)) {
    return 'direct';
  }

  // Default: treat as HLS (handles m3u8 and unknown manifests)
  return 'hls-segments';
}

export async function runDownload(
  media: DetectedMedia,
  taskId: string,
  strategy: DownloadStrategy,
  opts: DownloadOptions = {},
): Promise<string> {
  if (Platform.OS === 'web') return downloadInBrowser(media, strategy, opts);

  try {
    switch (strategy) {
      case 'yt-dlp':       return downloadYouTube(media, taskId, opts);
      case 'direct':       return downloadDirect(media, taskId, opts);
      case 'hls-segments': return downloadHLS(media, taskId, opts);
      case 'vimeo-json':   return downloadVimeoJson(media, taskId, opts);
      case 'server-download': return downloadViaServer(media, taskId, opts);
      case 'dash':
      case 'ffmpeg':       return downloadDASH(media, taskId, opts);
      default:             return downloadHLS(media, taskId, opts);
    }
  } catch (err) {
    if (strategy === 'server-download' || opts.signal?.aborted || err instanceof DRMProtectedError) {
      throw err;
    }
    if (media.sourcePageUrl || media.provenance === 'social-extractor') {
      opts.onStatus?.('fetching_manifest');
      return downloadViaServer(media, taskId, opts);
    }
    throw err;
  }
}

async function downloadInBrowser(
  media: DetectedMedia,
  strategy: DownloadStrategy,
  opts: DownloadOptions = {},
): Promise<string> {
  opts.onStatus?.('fetching_manifest');

  let href = media.url;
  const base = await getServerExtractorUrl();
  const pageUrl = media.sourcePageUrl || media.pageUrl;
  const shouldUseBackend =
    Boolean(base && pageUrl) &&
    (
      strategy !== 'direct' ||
      media.provenance === 'social-extractor' ||
      Boolean(media.httpHeaders && Object.keys(media.httpHeaders).length) ||
      !DIRECT_MEDIA_RE.test(media.url)
    );

  if (base && shouldUseBackend) {
    const params = new URLSearchParams({ url: pageUrl });
    href = `${base}/download?${params.toString()}`;
  }

  opts.onStatus?.('downloading');
  opts.onProgress?.(1, 1);

  const doc = globalThis.document;
  if (!doc) throw new Error('Browser downloads are not available in this environment');

  const a = doc.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  a.download = '';
  doc.body.appendChild(a);
  a.click();
  a.remove();

  opts.onStatus?.('assembling');
  return href;
}

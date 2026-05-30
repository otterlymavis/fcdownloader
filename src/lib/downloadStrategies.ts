import { DetectedMedia, DownloadStrategy } from '../types';
import { downloadHLS, DRMProtectedError, DownloadOptions } from './hlsDownloader';
import { downloadDirect } from './directDownloader';
import { downloadVimeoJson } from './vimeoJsonDownloader';
import { downloadDASH } from './dashDownloader';
import { downloadYouTube } from './youtubeDownloader';
import { downloadViaServer } from './serverDownloader';

export { DRMProtectedError };

const VIMEO_PLAYLIST_JSON = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i;
const DASH_MIME = /application\/(dash|x-mpegdash)\+xml/i;

/**
 * Determine download strategy purely by manifest type, not by platform.
 * Platform-specific logic lives in the injected script / platform extractors.
 */
const YT_PAGE_RE = /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/i;

export function pickStrategy(media: DetectedMedia): DownloadStrategy {
  const url  = media.url;
  const mime = media.mimeType ?? '';

  if (media.audioOnly) return 'server-download';
  if (media.forceServerDownload) return 'server-download';
  if (media.mediaKind === 'image' || media.mediaKind === 'audio') return 'direct';
  if (/^(image|audio)\//i.test(mime)) return 'direct';

  // YouTube: on Android use yt-dlp binary; on iOS re-extract fresh signed URLs.
  // Both paths avoid the 403 caused by missing nsig transform on browse-tab-detected URLs.
  if (YT_PAGE_RE.test(media.pageUrl)) return 'yt-dlp';

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
  if (/\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(mime)) return 'hls-segments';

  // Direct video file
  if (/\.(mp4|webm|mov|avi|mkv|m4v|flv)(\?|$)/i.test(url)) return 'direct';

  // YouTube progressive CDN URL (muxed itag, single file)
  if (/googlevideo\.com\/videoplayback/i.test(url)) return 'direct';

  // Bilibili CDN (single-file track without paired audio)
  if (/bilivideo\.com\//i.test(url)) return 'direct';

  // Meta/TikTok/Twitter direct CDN URLs are usually signed MP4/WebM responses
  // even when the URL path does not expose a file extension.
  if (/(?:cdninstagram\.com|scontent[-\w]*\.cdninstagram\.com|fbcdn\.net|threadscdn\.com|video\.twimg\.com|tiktokcdn\.com|tiktokcdn-us\.com|v\d+-webapp\.tiktok\.com|weibocdn\.com|xhscdn\.com)/i.test(url)) {
    return 'direct';
  }

  // Default: treat as HLS (handles m3u8 and unknown manifests)
  return 'hls-segments';
}

export const STRATEGY_LABELS: Record<DownloadStrategy, string> = {
  'hls-segments': 'HLS Segments',
  'direct':       'Direct Download',
  'dash':         'DASH (FFmpeg)',
  'vimeo-json':   'Vimeo Playlist',
  'ffmpeg':       'FFmpeg',
  'yt-dlp':       'yt-dlp',
  'server-download': 'Server yt-dlp',
};

export async function runDownload(
  media: DetectedMedia,
  taskId: string,
  strategy: DownloadStrategy,
  opts: DownloadOptions = {},
): Promise<string> {
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

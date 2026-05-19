import { DetectedMedia, DownloadStrategy } from '../types';
import { downloadHLS, DRMProtectedError, DownloadOptions } from './hlsDownloader';
import { downloadDirect } from './directDownloader';
import { downloadVimeoJson } from './vimeoJsonDownloader';

export { DRMProtectedError };

const DIRECT_EXTS = /\.(mp4|webm|mov|avi|mkv|m4v|flv)(\?|$)/i;
const VIMEO_PLAYLIST_JSON = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i;
const YOUTUBE_CDN = /googlevideo\.com\/videoplayback/i;

/** Pick the most appropriate strategy for a detected media item. */
export function pickStrategy(media: DetectedMedia): DownloadStrategy {
  if (VIMEO_PLAYLIST_JSON.test(media.url)) return 'vimeo-json';
  if (YOUTUBE_CDN.test(media.url))         return 'direct';
  if (DIRECT_EXTS.test(media.url))         return 'direct';
  if (media.mediaType === 'dash')          return 'ffmpeg';
  return 'hls-segments';
}

/** Human-readable label for each strategy. */
export const STRATEGY_LABELS: Record<DownloadStrategy, string> = {
  'hls-segments': 'HLS Segments',
  'direct':       'Direct Download',
  'vimeo-json':   'Vimeo Playlist',
  'ffmpeg':       'FFmpeg (not installed)',
};

/** Run a specific strategy. Throws on failure so the caller can retry another. */
export async function runDownload(
  media: DetectedMedia,
  taskId: string,
  strategy: DownloadStrategy,
  opts: DownloadOptions = {},
): Promise<string> {
  switch (strategy) {
    case 'direct':
      return downloadDirect(media, taskId, opts);

    case 'hls-segments':
      return downloadHLS(media, taskId, opts);

    case 'vimeo-json':
      return downloadVimeoJson(media, taskId, opts);

    case 'ffmpeg':
      // To enable: npm install ffmpeg-kit-react-native, then rebuild.
      // Uncomment the block below and remove the throw.
      //
      // import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';
      // const dir = new Directory(Paths.document, 'downloads', taskId);
      // dir.create({ intermediates: true, idempotent: true });
      // const out = new File(dir, 'video.mp4');
      // const cookies = await extractSessionCookies(media.pageUrl);
      // const hdrs = cookies ? `-headers "Cookie: ${cookies}\\r\\nReferer: ${media.pageUrl}\\r\\n"` : '';
      // const session = await FFmpegKit.execute(
      //   `${hdrs} -i "${media.url}" -c copy -movflags +faststart "${out.uri}"`
      // );
      // if (!ReturnCode.isSuccess(await session.getReturnCode()))
      //   throw new Error('FFmpeg exited with error — check the stream URL');
      // return out.uri;
      throw new Error('FFmpeg strategy requires ffmpeg-kit-react-native — see downloadStrategies.ts');

    default:
      return downloadHLS(media, taskId, opts);
  }
}

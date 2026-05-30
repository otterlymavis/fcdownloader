import { DetectedMedia, FormatOption } from '../types';

const SOURCE_NAMES: Array<[RegExp, string]> = [
  [/video\.twimg\.com|twimg\.com/i, 'Twitter'],
  [/cdninstagram\.com|instagram\.com/i, 'Instagram'],
  [/threads\.net/i, 'Threads'],
  [/vimeocdn\.com|vimeo\.com/i, 'Vimeo'],
  [/tiktokcdn\.com|tiktokcdn-us\.com|v\d+-webapp\.tiktok\.com|tiktok\.com/i, 'TikTok'],
  [/v\.redd\.it|reddit\.com/i, 'Reddit'],
  [/googlevideo\.com|youtube\.com/i, 'YouTube'],
  [/dailymotion\.com|dmcdn\.net/i, 'Dailymotion'],
  [/facebook\.com|fbcdn\.net/i, 'Facebook'],
  [/twitch\.tv|usher\.twitch\.tv/i, 'Twitch'],
  [/pinimg\.com|pinterest\.com/i, 'Pinterest'],
  [/bilivideo\.com|bilibili\.com|bilibili\.tv|b23\.tv/i, 'Bilibili'],
  [/weibo\.com|weibo\.cn|weibocdn\.com|sinaimg\.cn/i, 'Weibo'],
  [/xiaohongshu\.com|xhslink\.com|xhscdn\.com/i, 'Xiaohongshu'],
];

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ts: 'video/mp2t',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

const SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa)(\?|#|$)/i;
const VIMEO_RANGE_RE = /vimeocdn\.com\/.*\/v2\/range\/.*\/avf\//i;
const USEFUL_EXT_RE = /\.(m3u8|mpd|mp4|m4v|webm|mov|jpe?g|png|webp|gif|avif|heic|mp3|m4a|aac|wav|ogg|opus|flac)(\?|#|$)/i;
const VIMEO_JSON_RE = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i;
const VIDEO_CDN_RE = /(?:googlevideo\.com\/videoplayback|video\.twimg\.com\/|cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|threadscdn\.com\/|tiktokcdn\.com\/|tiktokcdn-us\.com\/|v\d+-webapp\.tiktok\.com\/|v\.redd\.it\/|fbcdn\.net\/videos|pinimg\.com\/videos\/|dmcdn\.net\/|usher\.twitch\.tv\/|bilivideo\.com\/|weibocdn\.com\/|xhscdn\.com\/)/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|opus|flac)(\?|#|$)/i;
const VIDEO_EXT_RE = /\.(m3u8|mpd|mp4|m4v|webm|mov)(\?|#|$)/i;
const YT_RANGE_RE = /googlevideo\.com\/videoplayback[^#]*[?&](?:range=|sq=)\d/i;
const YT_CDN_RE = /googlevideo\.com\/videoplayback/i;
const TW_VIDEO_RE = /video\.twimg\.com\/(?:ext_tw_video|amplify_video)\/(\d+)\//i;
const YT_ITAG_RANK: Record<number, number> = {
  22: 100,
  59: 90,
  78: 85,
  18: 70,
  36: 40,
  17: 20,
};

export function getSourceName(url: string): string {
  for (const [pattern, name] of SOURCE_NAMES) {
    if (pattern.test(url)) return name;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const name = host.split('.').slice(-2, -1)[0] ?? 'Video';
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return 'Video';
  }
}

export function getMediaKind(
  item: Pick<DetectedMedia, 'url' | 'mimeType' | 'mediaKind'>,
): NonNullable<DetectedMedia['mediaKind']> {
  if (item.mediaKind) return item.mediaKind;
  const url = item.url.toLowerCase().split('?')[0];
  const mimeType = String(item.mimeType || '').toLowerCase();
  if (mimeType.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic)$/.test(url)) return 'image';
  if (mimeType.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(url)) return 'audio';
  return 'video';
}

export function getQuality(url: string, label?: string): string | null {
  if (label) return label;
  const ytHeight = url.match(/[?&]height=(\d+)/i);
  if (ytHeight) {
    const height = parseInt(ytHeight[1], 10);
    if (height >= 2160) return '4K';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    if (height >= 360) return '360p';
  }
  if (/4k|2160/i.test(url)) return '4K';
  if (/1080/i.test(url)) return '1080p';
  if (/720/i.test(url)) return '720p';
  if (/480/i.test(url)) return '480p';
  if (/360/i.test(url)) return '360p';
  if (/\bhd\b/i.test(url)) return 'HD';
  return null;
}

export function getMediaFormat(item: DetectedMedia): string {
  const kind = getMediaKind(item);
  const url = item.url.toLowerCase();
  if (item.mediaType === 'hls' || url.includes('.m3u8')) return 'HLS Stream';
  if (item.mediaType === 'dash' || url.includes('.mpd')) return 'DASH Stream';
  const ext = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/)?.[1];
  if (ext) return ext.toUpperCase();
  if (item.mimeType) return item.mimeType;
  if (kind === 'image') return 'Image';
  return kind === 'audio' ? 'Audio' : 'Video';
}

function formatDimensions(width?: number, height?: number): string | null {
  if (width && height) return `${width} x ${height}`;
  if (height) return `${height}p`;
  return null;
}

export function getFormatResolution(format: FormatOption): string | null {
  const dimensions = formatDimensions(format.width, format.height);
  if (dimensions) return dimensions;

  if (format.resolution && format.resolution !== 'audio only') return format.resolution;

  const labelResolution = format.label?.match(/(?:\d{3,4}p|4k|8k|\d{3,5}x\d{3,5})/i)?.[0];
  if (labelResolution) return labelResolution;

  return format.vcodec === 'none' ? 'Audio only' : null;
}

export function getMediaResolution(item: DetectedMedia): string | null {
  const direct = formatDimensions(item.width, item.height);
  if (direct) return direct;

  const selectedFormat = item.availableFormats?.find((format) => format.id === item.formatId);
  if (selectedFormat) {
    const selected = getFormatResolution(selectedFormat);
    if (selected) return selected;
  }

  const bestFormat = item.availableFormats
    ?.filter((format) => format.width || format.height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.width ?? 0) - (a.width ?? 0))[0];
  if (bestFormat) return getFormatResolution(bestFormat);

  const quality = getQuality(item.url, item.label);
  if (quality && /(?:\d{3,4}p|4k|8k)/i.test(quality)) return quality;

  const urlDimensions = item.url.match(/(?:^|[\/_-])(\d{3,5})x(\d{3,5})(?:[\/_.-]|$)/i);
  if (urlDimensions) return `${urlDimensions[1]} x ${urlDimensions[2]}`;

  try {
    const params = new URL(item.url).searchParams;
    const width = Number(params.get('width') || params.get('w') || 0);
    const height = Number(params.get('height') || params.get('h') || 0);
    const fromParams = formatDimensions(
      Number.isFinite(width) && width > 0 ? width : undefined,
      Number.isFinite(height) && height > 0 ? height : undefined,
    );
    if (fromParams) return fromParams;
  } catch {}

  return getMediaKind(item) === 'audio' ? 'Audio only' : null;
}

export function getMimeFromPath(path: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function getPageTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

export function getInitial(name: string): string {
  return (name[0] ?? '?').toUpperCase();
}

export function isUseful(url: string): boolean {
  if (isSegmentMediaUrl(url)) return false;
  return USEFUL_EXT_RE.test(url) || VIMEO_JSON_RE.test(url) || VIDEO_CDN_RE.test(url);
}

export function isNetworkDownloadCandidate(url: string): boolean {
  if (isSegmentMediaUrl(url)) return false;
  return VIDEO_EXT_RE.test(url) || AUDIO_EXT_RE.test(url) || VIMEO_JSON_RE.test(url) || VIDEO_CDN_RE.test(url);
}

export function isDirectMediaUrl(url: string): boolean {
  if (isSegmentMediaUrl(url)) return false;
  return USEFUL_EXT_RE.test(url) || VIMEO_JSON_RE.test(url) || VIDEO_CDN_RE.test(url);
}

export function isSegmentMediaUrl(url: string): boolean {
  const clean = url.split('#')[0];
  return SEGMENT_RE.test(clean) || VIMEO_RANGE_RE.test(url) || YT_RANGE_RE.test(url);
}

export function isLikelyThumbnailUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (!/\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(u)) return false;
  if (/(?:^|[\/_.-])(?:thumb|thumbnail|avatar|profile(?:_pic)?|placeholder|blank|pixel|beacon|tracking|tracker|counter|spacer|sprite|logo|icon|button|banner|ads?)(?:[\/_.-]|$)/i.test(u)) return true;
  if (/[?&](?:thumb|thumbnail|preview|avatar)=/i.test(u)) return true;
  try {
    const parsed = new URL(url);
    const dimensions = ['width', 'w', 'height', 'h']
      .map((key) => Number(parsed.searchParams.get(key) || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (dimensions.length && Math.max(...dimensions) <= 512) return true;
  } catch {}
  if (/(?:^|[\/_-])(?:\d{1,3}x\d{1,3}|s\d{2,4}x\d{2,4})(?:[\/_.-]|$)/i.test(u)) return true;
  return false;
}

export function isNonContentMediaUrl(url: string, mimeType?: string | null): boolean {
  const u = url.toLowerCase();
  const mt = String(mimeType || '').toLowerCase();
  if (/\.(?:html?|php|aspx?)(?:[?#]|$)/i.test(u)) return true;
  if (mt.includes('text/html') || mt.includes('application/xhtml') || mt.includes('application/json')) return true;
  if (/(?:doubleclick|googlesyndication|google-analytics|analytics|adservice|scorecardresearch|outbrain|taboola|treasuredata|bidswitch)/i.test(u)) return true;
  if (/(?:^|[\/_.-])(?:ad|ads|banner|beacon|tracking|tracker|counter|spacer|sprite|logo|icon|button|common|header|footer|gnb|nav|placeholder|blank|pixel)(?:[\/_.-]|$)/i.test(u)) return true;
  if (/\.gif(?:[?#]|$)/i.test(u) && !/(?:article|photo|gallery|image|upimg|contents|media|original|large)/i.test(u)) return true;
  return false;
}

export function guessMediaType(url: string): DetectedMedia['mediaType'] {
  const lower = url.toLowerCase();
  if (lower.includes('.mpd')) return 'dash';
  if (lower.includes('.m3u8')) return 'hls';
  return 'direct';
}

export function smartDedup(items: DetectedMedia[]): DetectedMedia[] {
  const grouped = new Map<string, { item: DetectedMedia; score: number }>();
  const ungrouped: DetectedMedia[] = [];
  for (const item of items) {
    const urlScore = getQualityScore(item.url);
    if (urlScore < 0) continue;
    const score = urlScore * (1 + (item.confidence ?? 0.5) * 0.2);
    const key = getVideoGroupKey(item.url);
    if (!key) {
      ungrouped.push(item);
      continue;
    }
    const existing = grouped.get(key);
    if (!existing || score > existing.score) grouped.set(key, { item, score });
  }
  return [...Array.from(grouped.values()).map((entry) => entry.item), ...ungrouped];
}

function getVideoGroupKey(url: string): string | null {
  try {
    if (YT_CDN_RE.test(url)) {
      const id = new URL(url).searchParams.get('id');
      return id ? `yt_${id}` : null;
    }
    const ytManifest = url.match(/manifest\.googlevideo\.com\/api\/manifest\/[^/]+\/.*?\/id\/([^/.]+)/);
    if (ytManifest) return `ytm_${ytManifest[1]}`;
    const twitterMatch = url.match(TW_VIDEO_RE);
    if (twitterMatch) return `tw_${twitterMatch[1]}`;
    return null;
  } catch {
    return null;
  }
}

function getQualityScore(url: string): number {
  if (YT_CDN_RE.test(url)) {
    try {
      const params = new URL(url).searchParams;
      const itag = parseInt(params.get('itag') ?? '0', 10);
      if ((params.get('mime') ?? '').startsWith('audio/')) return -1;
      return YT_ITAG_RANK[itag] ?? 1;
    } catch {
      return 1;
    }
  }
  const resolution = url.match(/\/(\d+)x(\d+)\//);
  if (!resolution && /\.m3u8/i.test(url)) return 10_000_000;
  if (resolution) return parseInt(resolution[1], 10) * parseInt(resolution[2], 10) + (/\.m3u8/i.test(url) ? 1 : 0);
  const lower = url.toLowerCase();
  if (/\.mpd/.test(lower)) return 3_000_000;
  if (/\.(mp4|m4v|webm|mov)/.test(lower)) return 100;
  return 50;
}

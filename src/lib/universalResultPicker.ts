import { DetectedMedia } from '../types';
import { getMediaGroupKey, getMediaKind, smartDedup } from './mediaHelpers';

export type UniversalResultDecision =
  | { action: 'none'; items: [] }
  | { action: 'enqueue'; items: DetectedMedia[] }
  | { action: 'pick'; items: DetectedMedia[] };

const UNIVERSAL_STRATEGIES = new Set(['universal-browser-probe', 'universal-media-probe']);
const PICKER_MEDIA_PATH_RE = /\.(?:m3u8?|mpd|mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp|jpe?g|png|webp|gif|avif|heic|mp3|m4a|aac|wav|ogg|opus|flac|vtt|srt)(?:$|\/)/i;
const META_MEDIA_HOST_RE = /(?:threadscdn\.com|cdninstagram\.com|fbcdn\.net)$/i;
const VOLATILE_MEDIA_PARAM_RE = /^(?:token|auth(?:_token)?|access_token|signature|sig|expires?|exp|policy|key-?pair-?id|hdnts|hdnea|jwt|session|pathsig|x-amz-.+|x-goog-.+|_nc_(?:cat|sid|ohc|ht|gid|eui2)|oh|oe|ccb|efg|edm)$/i;
const VIMEO_CONFIG_RE = /player\.vimeo\.com\/video\/(\d+)\/config\/?(?:[?#]|$)/i;
const VIMEO_PLAYER_RE = /player\.vimeo\.com\/video\/(\d+)(?:[/?#]|$)/i;
const VIMEO_PLAYLIST_RE = /vimeocdn\.com\/.*\/playlist\.json(?:[?#]|$)/i;

export function isUniversalExtractionStrategy(strategy?: string): boolean {
  return !!strategy && UNIVERSAL_STRATEGIES.has(strategy);
}

function isThreadsUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'threads.net' || host === 'threads.com';
  } catch {
    return /threads\.(?:net|com)\//i.test(url);
  }
}

function pickerAssetKey(item: DetectedMedia, pageUrl?: string): string {
  const kind = getMediaKind(item);
  try {
    const parsed = new URL(item.url);
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    const isThreadsMetaAsset =
      META_MEDIA_HOST_RE.test(host) &&
      (
        isThreadsUrl(pageUrl) ||
        isThreadsUrl(item.sourcePageUrl) ||
        isThreadsUrl(item.pageUrl) ||
        /threadscdn\.com/i.test(item.url)
      );

    if (PICKER_MEDIA_PATH_RE.test(path) || isThreadsMetaAsset) {
      const stableParams = Array.from(parsed.searchParams.entries())
        .filter(([name]) => !VOLATILE_MEDIA_PARAM_RE.test(name))
        .sort(([aName, aValue], [bName, bValue]) =>
          aName.localeCompare(bName) || aValue.localeCompare(bValue)
        );
      const stableQuery = new URLSearchParams(stableParams).toString();
      return `${kind}:${host}${path}${stableQuery ? `?${stableQuery}` : ''}`;
    }

    parsed.hash = '';
    return `${kind}:${parsed.toString()}`;
  } catch {
    return `${kind}:${item.url.split('#')[0]}`;
  }
}

function kindScore(kind: ReturnType<typeof getMediaKind>): number {
  if (kind === 'video')    return 4;
  if (kind === 'audio')    return 3;
  if (kind === 'image')    return 2;
  if (kind === 'subtitle') return 1; // supplementary — always below primary media
  return 0;
}

function vimeoVideoId(item: DetectedMedia): string | undefined {
  for (const value of [item.url, item.sourcePageUrl, item.pageUrl]) {
    const match = value?.match(VIMEO_CONFIG_RE) ?? value?.match(VIMEO_PLAYER_RE);
    if (match) return match[1];
  }
  return undefined;
}

function vimeoCandidateScore(item: DetectedMedia): number {
  if (VIMEO_CONFIG_RE.test(item.url)) return 50;
  if (VIMEO_PLAYLIST_RE.test(item.url)) return 40;
  if (item.mediaType === 'hls' || item.mediaType === 'dash') return 30;
  if (getMediaKind(item) === 'video') return 20;
  return 10;
}

function isGenericVimeoLabel(label?: string): boolean {
  return !label || /^(?:vimeo|vimeo player config|vimeo json playlist|application\/json|hls|dash)$/i.test(label.trim());
}

function isVimeoSupportingImage(item: DetectedMedia): boolean {
  if (getMediaKind(item) !== 'image') return false;
  try {
    const host = new URL(item.url).hostname;
    return /(?:^|\.)vimeocdn\.com$/i.test(host);
  } catch {
    return false;
  }
}

function collapseVimeoCandidates(items: DetectedMedia[]): DetectedMedia[] {
  const groups = new Map<string, DetectedMedia[]>();
  const passthrough: DetectedMedia[] = [];
  for (const item of items) {
    const id = vimeoVideoId(item);
    if (!id) {
      passthrough.push(item);
      continue;
    }
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  if (groups.size === 0) return items;

  const collapsed = Array.from(groups.values()).map((group) => {
    const selected = [...group].sort((a, b) =>
      vimeoCandidateScore(b) - vimeoCandidateScore(a) ||
      (b.confidence ?? 0) - (a.confidence ?? 0)
    )[0];
    const titled = group.find((item) => !isGenericVimeoLabel(item.sourceTitle || item.label));
    return titled ? {
      ...selected,
      label: titled.sourceTitle || titled.label,
      sourceTitle: titled.sourceTitle || titled.label,
      thumbnailUrl: selected.thumbnailUrl || titled.thumbnailUrl,
    } : selected;
  });

  // A live embedded player commonly causes WKWebView to report the site's logo
  // and Vimeo poster frames as low-confidence images. They are supporting UI,
  // not separate user choices, when a canonical Vimeo video is available.
  const usefulPassthrough = passthrough.filter((item) =>
    !isVimeoSupportingImage(item) || (item.confidence ?? 0) > 0.55
  );
  return [...collapsed, ...usefulPassthrough];
}

export function sortUniversalCandidates(items: DetectedMedia[]): DetectedMedia[] {
  return smartDedup(items).sort((a, b) => {
    const aKs = kindScore(getMediaKind(a));
    const bKs = kindScore(getMediaKind(b));
    if (aKs !== bKs) return bKs - aKs;

    const confidenceDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (Math.abs(confidenceDiff) > 0.001) return confidenceDiff;

    const aTypeScore = a.mediaType === 'hls' || a.mediaType === 'dash' ? 2 : 1;
    const bTypeScore = b.mediaType === 'hls' || b.mediaType === 'dash' ? 2 : 1;
    if (aTypeScore !== bTypeScore) return bTypeScore - aTypeScore;

    const aPixels = (a.width ?? 0) * (a.height ?? 0);
    const bPixels = (b.width ?? 0) * (b.height ?? 0);
    if (aPixels !== bPixels) return bPixels - aPixels;

    return a.url.localeCompare(b.url);
  });
}

export function simplifyUniversalPickerCandidates(
  items: DetectedMedia[],
  pageUrl?: string,
): DetectedMedia[] {
  const collapsedItems = collapseVimeoCandidates(items);
  const grouped = new Map<string, DetectedMedia>();
  for (const item of collapsedItems) {
    const key = pickerAssetKey(item, pageUrl);
    const existing = grouped.get(key);
    grouped.set(key, existing ? sortUniversalCandidates([existing, item])[0] ?? existing : item);
  }
  return sortUniversalCandidates(Array.from(grouped.values()));
}

function collapseEquivalentCandidates(items: DetectedMedia[]): DetectedMedia[] {
  const grouped = new Map<string, DetectedMedia>();
  const output: DetectedMedia[] = [];
  for (const item of items) {
    const key = getMediaGroupKey(item);
    if (!key) {
      output.push(item);
      continue;
    }
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, item);
      output.push(item);
      continue;
    }
    const currentBest = sortUniversalCandidates([existing, item])[0] ?? existing;
    if (currentBest.id === existing.id) continue;
    grouped.set(key, item);
    const idx = output.findIndex((candidate) => candidate.id === existing.id);
    if (idx >= 0) output[idx] = item;
  }
  return output;
}

export function decideUniversalResultHandling(
  strategy: string | undefined,
  items: DetectedMedia[],
  pageUrl?: string,
): UniversalResultDecision {
  if (items.length === 0) return { action: 'none', items: [] };
  if (!isUniversalExtractionStrategy(strategy)) {
    const collapsed = collapseEquivalentCandidates(items);
    return collapsed.length > 0 ? { action: 'enqueue', items: collapsed } : { action: 'none', items: [] };
  }

  const sorted = simplifyUniversalPickerCandidates(items, pageUrl);
  if (sorted.length <= 1) return { action: 'enqueue', items: sorted };

  // If there's exactly one primary (non-subtitle) item the user has no real
  // choice to make — skip the picker and enqueue it directly.
  const primary = sorted.filter((item) => getMediaKind(item) !== 'subtitle');
  if (primary.length === 1) return { action: 'enqueue', items: [primary[0]] };

  return { action: 'pick', items: sorted };
}

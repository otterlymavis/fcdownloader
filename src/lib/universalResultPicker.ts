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
  const grouped = new Map<string, DetectedMedia>();
  for (const item of items) {
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

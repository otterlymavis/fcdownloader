import { DetectedMedia } from '../types';
import { getMediaKind, smartDedup } from './mediaHelpers';

export type UniversalResultDecision =
  | { action: 'none'; items: [] }
  | { action: 'enqueue'; items: DetectedMedia[] }
  | { action: 'pick'; items: DetectedMedia[] };

const UNIVERSAL_STRATEGIES = new Set(['universal-browser-probe', 'universal-media-probe']);

export function isUniversalExtractionStrategy(strategy?: string): boolean {
  return !!strategy && UNIVERSAL_STRATEGIES.has(strategy);
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

export function decideUniversalResultHandling(strategy: string | undefined, items: DetectedMedia[]): UniversalResultDecision {
  if (items.length === 0) return { action: 'none', items: [] };
  if (!isUniversalExtractionStrategy(strategy)) return { action: 'enqueue', items };

  const sorted = sortUniversalCandidates(items);
  if (sorted.length <= 1) return { action: 'enqueue', items: sorted };

  // If there's exactly one primary (non-subtitle) item the user has no real
  // choice to make — skip the picker and enqueue it directly.
  const primary = sorted.filter((item) => getMediaKind(item) !== 'subtitle');
  if (primary.length === 1) return { action: 'enqueue', items: [primary[0]] };

  return { action: 'pick', items: sorted };
}

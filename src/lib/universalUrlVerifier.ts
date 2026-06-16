import { DetectedMedia, MediaKind, MediaType, SourceAuditEntry } from '../types';
import { isUniversalExtractionStrategy } from './universalResultPicker';

const DEFAULT_TIMEOUT_MS = 3500;

export interface UrlVerificationOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function appendAudit(item: DetectedMedia, audit: SourceAuditEntry): SourceAuditEntry[] {
  return [...(item.sourceAudit ?? []), audit];
}

function audit(url: string, selected: boolean, notes: string, extra: Partial<SourceAuditEntry> = {}): SourceAuditEntry {
  return {
    strategy: 'url-verifier',
    source: 'bounded-head-request',
    url,
    selected,
    notes,
    ...extra,
  };
}

function requestHeaders(item: DetectedMedia, range = false): HeadersInit {
  return {
    Accept: '*/*',
    Referer: item.sourcePageUrl || item.pageUrl,
    ...(range ? { Range: 'bytes=0-0' } : {}),
    ...(item.userAgent ? { 'User-Agent': item.userAgent } : {}),
    ...(item.httpHeaders ?? {}),
  };
}

function isDirectCandidate(item: DetectedMedia): boolean {
  return item.mediaType !== 'hls' && item.mediaType !== 'dash';
}

const SUBTITLE_MIME_RE = /^(?:text\/vtt|text\/x-vtt|text\/x-webvtt|application\/x-subrip|text\/x-ssa|text\/x-ass|application\/ttml\+xml|text\/ttml|text\/srt)\b/i;

function mediaTypeFromMime(mimeType: string | null): MediaType | undefined {
  const mime = (mimeType || '').toLowerCase();
  if (/mpegurl|m3u8/.test(mime)) return 'hls';
  if (/dash|mpd/.test(mime)) return 'dash';
  if (/^(?:video|audio|image)\//.test(mime)) return 'direct';
  if (SUBTITLE_MIME_RE.test(mime)) return 'direct';
  return undefined;
}

function mediaKindFromMime(mimeType: string | null): MediaKind | undefined {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (SUBTITLE_MIME_RE.test(mime)) return 'subtitle';
  return undefined;
}

function looksLikeNonMedia(mimeType: string | null): boolean {
  const mime = (mimeType || '').toLowerCase();
  if (SUBTITLE_MIME_RE.test(mime)) return false;
  return /^text\/html\b/.test(mime) || /^application\/json\b/.test(mime) || /^text\/plain\b/.test(mime);
}

function filenameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const utf = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf) {
    try { return decodeURIComponent(utf).slice(0, 120); } catch { return utf.slice(0, 120); }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1];
  return plain?.slice(0, 120);
}

function shouldFallbackToRangeGet(res: Response): boolean {
  return res.status === 403 || res.status === 405 || res.status === 406 || res.status === 501;
}

function applyVerificationResponse(item: DetectedMedia, res: Response, method: 'HEAD' | 'GET'): DetectedMedia | null {
  const mimeType = res.headers?.get?.('Content-Type') || undefined;
  const contentLength = Number(res.headers?.get?.('Content-Length') || 0) || undefined;
  const contentRange = res.headers?.get?.('Content-Range') || '';
  const rangeTotal = Number(contentRange.match(/\/(\d+)$/)?.[1] || 0) || undefined;
  const filename = filenameFromDisposition(res.headers?.get?.('Content-Disposition') || null);
  const resolvedUrl = res.url || item.url;
  const maybeType = mediaTypeFromMime(mimeType || null);
  const maybeKind = mediaKindFromMime(mimeType || null);
  const selected = res.ok && !looksLikeNonMedia(mimeType || null);
  if (!selected && res.ok && looksLikeNonMedia(mimeType || null)) {
    return null;
  }
  const note = selected
    ? method === 'GET' ? 'GET range fallback verified media candidate' : 'HEAD verified media candidate'
    : `${method} returned HTTP ${res.status}`;
  return {
    ...item,
    url: resolvedUrl,
    mimeType: mimeType ?? item.mimeType,
    mediaType: maybeType ?? item.mediaType,
    mediaKind: maybeKind ?? item.mediaKind,
    label: filename ?? item.label,
    confidence: selected ? Math.max(item.confidence ?? 0, maybeType ? 0.82 : 0.76) : item.confidence,
    sourceAudit: appendAudit(item, audit(resolvedUrl, selected, note, {
      status: res.status,
      mimeType,
      contentLength: rangeTotal ?? contentLength,
      rejectedReason: selected ? undefined : `HTTP ${res.status}`,
    })),
  };
}

async function verifyUrl(item: DetectedMedia, options: UrlVerificationOptions): Promise<DetectedMedia | null> {
  if (!isDirectCandidate(item)) return item;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS) : undefined;
  try {
    const res = await fetchImpl(item.url, {
      method: 'HEAD',
      headers: requestHeaders(item),
      signal: controller?.signal,
    });
    if (shouldFallbackToRangeGet(res)) {
      const rangeRes = await fetchImpl(item.url, {
        method: 'GET',
        headers: requestHeaders(item, true),
        signal: controller?.signal,
      });
      return applyVerificationResponse(item, rangeRes, 'GET');
    }
    return applyVerificationResponse(item, res, 'HEAD');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...item,
      sourceAudit: appendAudit(item, audit(item.url, false, `HEAD verification skipped: ${message}`, {
        rejectedReason: message,
      })),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyUniversalDirectCandidates(
  strategy: string | undefined,
  items: DetectedMedia[],
  options: UrlVerificationOptions = {},
): Promise<DetectedMedia[]> {
  if (!isUniversalExtractionStrategy(strategy)) return items;
  const verified = await Promise.all(items.map((item) => verifyUrl(item, options)));
  return verified.filter((item): item is DetectedMedia => !!item);
}

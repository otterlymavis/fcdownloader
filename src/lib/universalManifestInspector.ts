import { XMLParser } from 'fast-xml-parser';
import { DetectedMedia, FormatOption, SourceAuditEntry } from '../types';
import { isUniversalExtractionStrategy } from './universalResultPicker';
import { parseIsoDuration } from './universalMediaProbe';

const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_MAX_CHARS = 512_000;

export interface ManifestInspectionOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxChars?: number;
}

type ManifestKind = 'hls-master' | 'hls-media' | 'dash-mpd';

function resolveUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    const b = new URL(base);
    if (url.startsWith('//')) return `${b.protocol}${url}`;
    if (url.startsWith('/')) return `${b.protocol}//${b.host}${url}`;
    return base.slice(0, base.lastIndexOf('/') + 1) + url;
  } catch {
    return url;
  }
}

function appendAudit(item: DetectedMedia, audit: SourceAuditEntry): SourceAuditEntry[] {
  return [...(item.sourceAudit ?? []), audit];
}

function audit(url: string, selected: boolean, notes: string, extra: Partial<SourceAuditEntry> = {}): SourceAuditEntry {
  return {
    strategy: 'manifest-inspector',
    source: 'bounded-manifest-fetch',
    url,
    selected,
    notes,
    ...extra,
  };
}

function headersFor(item: DetectedMedia): HeadersInit {
  return {
    Accept: item.mediaType === 'dash'
      ? 'application/dash+xml,application/xml,text/xml,*/*;q=0.8'
      : 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*;q=0.8',
    Referer: item.sourcePageUrl || item.pageUrl,
    ...(item.userAgent ? { 'User-Agent': item.userAgent } : {}),
    ...(item.httpHeaders ?? {}),
  };
}

async function fetchManifestText(item: DetectedMedia, opts: ManifestInspectionOptions): Promise<{ text: string; status?: number; mimeType?: string; contentLength?: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetchImpl(item.url, {
      headers: headersFor(item),
      signal: controller?.signal,
    });
    const contentLength = Number(res.headers?.get?.('Content-Length') || 0) || undefined;
    if (contentLength && contentLength > maxChars) throw new Error(`manifest too large (${contentLength} bytes)`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > maxChars) throw new Error(`manifest too large (${text.length} chars)`);
    return {
      text,
      status: res.status,
      mimeType: res.headers?.get?.('Content-Type') || undefined,
      contentLength,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function resolutionLabel(width?: number, height?: number): string | undefined {
  if (height) return `${height}p`;
  if (width) return `${width}px wide`;
  return undefined;
}

function bitrateLabel(bitrate?: number): string | undefined {
  if (!bitrate) return undefined;
  return bitrate >= 1_000_000 ? `${(bitrate / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bitrate / 1000)} kbps`;
}

function splitCodecs(codecs?: string): { vcodec?: string; acodec?: string } {
  if (!codecs) return {};
  const parts = codecs.split(',').map((part) => part.trim()).filter(Boolean);
  return {
    vcodec: parts.find((part) => /^(?:avc|hev|hvc|vp|av01)/i.test(part)),
    acodec: parts.find((part) => /^(?:mp4a|opus|vorbis|ac-3|ec-3|flac)/i.test(part)),
  };
}

function videoCodecLabel(vcodec?: string): string | undefined {
  if (!vcodec) return undefined;
  const lc = vcodec.toLowerCase();
  if (lc.startsWith('av01')) return 'AV1';
  if (lc.startsWith('hev') || lc.startsWith('hvc')) return 'HEVC';
  if (lc.startsWith('avc')) return 'H.264';
  if (lc.startsWith('vp9') || lc === 'vp09') return 'VP9';
  if (lc.startsWith('vp8') || lc === 'vp08') return 'VP8';
  return undefined;
}

function audioCodecLabel(acodec?: string): string | undefined {
  if (!acodec) return undefined;
  const lc = acodec.toLowerCase();
  if (lc.startsWith('mp4a')) return 'AAC';
  if (lc.startsWith('opus')) return 'Opus';
  if (lc.startsWith('vorbis')) return 'Vorbis';
  if (lc === 'ac-3') return 'AC-3';
  if (lc === 'ec-3') return 'E-AC-3';
  if (lc.startsWith('flac')) return 'FLAC';
  return undefined;
}

function hlsDrmHint(text: string): { note: string; blocked: boolean } | undefined {
  if (/KEYFORMAT="(?:com\.apple\.streamingkeydelivery|urn:uuid:)/i.test(text))
    return { note: 'DRM key format detected', blocked: true };
  if (/METHOD=SAMPLE-AES/i.test(text))
    return { note: 'SAMPLE-AES encryption detected', blocked: true };
  // AES-128 uses a plain key URI — yt-dlp/FFmpeg handle it transparently.
  // It is NOT DRM and should not block download.
  if (/#EXT-X-KEY:.*METHOD=AES-128/i.test(text))
    return { note: 'AES-128 encrypted (downloadable)', blocked: false };
  return undefined;
}

function inspectHls(item: DetectedMedia, text: string, fetchMeta: { status?: number; mimeType?: string; contentLength?: number }): DetectedMedia {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('not an HLS manifest');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const formats: FormatOption[] = [];
  const isMaster = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'));
  const drmHint = hlsDrmHint(text);

  if (isMaster) {
    // ── Video variant streams (#EXT-X-STREAM-INF) ─────────────────
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseAttrs(lines[i]);
      const bandwidth = Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0) || undefined;
      const [width, height] = String(attrs.RESOLUTION || '').split('x').map((n) => Number(n) || undefined);
      const fps = Number(attrs['FRAME-RATE'] || 0) || undefined;
      const codecs = splitCodecs(attrs.CODECS);
      const vcLabel = videoCodecLabel(codecs.vcodec);
      const label = [resolutionLabel(width, height), vcLabel ? `(${vcLabel})` : undefined, bitrateLabel(bandwidth)].filter(Boolean).join(' ');
      const variantUrl = lines[i + 1] && !lines[i + 1].startsWith('#')
        ? resolveUrl(lines[i + 1], item.url)
        : undefined;
      formats.push({
        id: `hls_${formats.length}`,
        url: variantUrl,
        selectable: !!variantUrl,
        label: label || `HLS variant ${formats.length + 1}`,
        ext: 'm3u8',
        protocol: 'm3u8',
        width,
        height,
        resolution: width && height ? `${width}x${height}` : undefined,
        fps,
        filesizeApprox: bandwidth,
        ...codecs,
      });
    }

    // ── Alternate renditions (#EXT-X-MEDIA) — audio tracks & subtitles ──
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const attrs = parseAttrs(line);
      const type = (attrs.TYPE || '').toUpperCase();
      if (type !== 'AUDIO' && type !== 'SUBTITLES' && type !== 'CLOSED-CAPTIONS') continue;
      const uri = attrs.URI ? resolveUrl(attrs.URI, item.url) : undefined;
      const lang = attrs.LANGUAGE || attrs.NAME || '';
      const name = attrs.NAME || lang || type.toLowerCase();
      const isDefault = (attrs.DEFAULT || '').toUpperCase() === 'YES';
      const mediaKind: 'audio' | 'subtitle' = type === 'AUDIO' ? 'audio' : 'subtitle';
      formats.push({
        id: `hls_${type.toLowerCase()}_${formats.length}`,
        url: uri,
        selectable: !!uri,
        mediaKind,
        label: `${name}${isDefault ? ' (default)' : ''}`,
        ext: type === 'AUDIO' ? 'm4a' : 'vtt',
        protocol: type === 'AUDIO' ? 'm3u8' : 'direct',
        resolution: type === 'AUDIO' ? 'audio only' : undefined,
        language: lang || undefined,
        bitrate: Number(attrs.BANDWIDTH || 0) || undefined,
      });
    }

    // ── Thumbnail storyboard tracks (#EXT-X-IMAGE-STREAM-INF) ─────────────────
    // Used by YouTube, Twitch, and others to deliver scrubber-bar storyboards.
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-IMAGE-STREAM-INF:')) continue;
      const attrs = parseAttrs(line);
      const uri = attrs.URI ? resolveUrl(attrs.URI, item.url) : undefined;
      if (!uri) continue;
      const [tWidth, tHeight] = String(attrs.RESOLUTION || '').split('x').map((n) => Number(n) || undefined);
      formats.push({
        id: `hls_image_${formats.length}`,
        url: uri,
        selectable: false,
        mediaKind: 'image',
        label: tWidth && tHeight ? `Storyboard (${tWidth}x${tHeight})` : 'Storyboard thumbnails',
        ext: 'm3u8',
        protocol: 'm3u8',
        width: tWidth,
        height: tHeight,
      });
    }
  } else {
    formats.push({
      id: 'hls_media',
      url: item.url,
      selectable: true,
      label: 'HLS media playlist',
      ext: 'm3u8',
      protocol: 'm3u8',
      width: item.width,
      height: item.height,
      resolution: resolutionLabel(item.width, item.height),
    });
  }

  const isLive = !isMaster && !lines.some((l) => l === '#EXT-X-ENDLIST');

  formats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.width ?? 0) - (a.width ?? 0) || (b.filesizeApprox ?? 0) - (a.filesizeApprox ?? 0));
  const best = formats[0];
  const kind: ManifestKind = isMaster ? 'hls-master' : 'hls-media';
  const liveNote = isLive ? 'live stream' : undefined;
  const notes = [kind, drmHint?.note, liveNote].filter(Boolean).join('; ');
  const defaultLabel = isMaster ? 'HLS master playlist' : isLive ? 'HLS live stream' : 'HLS media playlist';
  return {
    ...item,
    label: item.label && item.label !== 'HLS' ? item.label : defaultLabel,
    width: item.width ?? best?.width,
    height: item.height ?? best?.height,
    bitrate: item.bitrate ?? best?.filesizeApprox,
    liveStream: isLive || undefined,
    availableFormats: formats.length ? formats : item.availableFormats,
    sourceAudit: appendAudit(item, audit(item.url, true, notes, {
      mimeType: fetchMeta.mimeType,
      contentLength: fetchMeta.contentLength,
      status: fetchMeta.status,
      rejectedReason: drmHint?.blocked ? drmHint.note : undefined,
    })),
  };
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function dashDrmHint(text: string): string | undefined {
  if (/<ContentProtection\b/i.test(text)) return 'DASH ContentProtection detected';
  if (/<cenc:pssh\b/i.test(text)) return 'DASH PSSH detected';
  if (/widevine|playready|fairplay/i.test(text)) return 'DRM system marker detected';
  return undefined;
}

function inspectDash(item: DetectedMedia, text: string, fetchMeta: { status?: number; mimeType?: string; contentLength?: number }): DetectedMedia {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName) => ['AdaptationSet', 'Representation', 'Period'].includes(tagName),
  });
  const doc = parser.parse(text);
  const mpd = doc?.MPD ?? doc;
  if (!mpd || typeof mpd !== 'object') throw new Error('not a DASH MPD');
  const mpdRecord = mpd as Record<string, unknown>;
  const isLive = String(mpdRecord['@_type'] ?? '').toLowerCase() === 'dynamic';
  const mpdDuration = parseIsoDuration(String(mpdRecord['@_mediaPresentationDuration'] ?? ''));
  const formats: FormatOption[] = [];
  const drmHint = dashDrmHint(text);

  for (const period of toArray((mpd as Record<string, unknown>).Period)) {
    if (!period || typeof period !== 'object') continue;
    for (const adaptation of toArray((period as Record<string, unknown>).AdaptationSet)) {
      if (!adaptation || typeof adaptation !== 'object') continue;
      const asRecord = adaptation as Record<string, unknown>;
      const asMime = String(asRecord['@_mimeType'] ?? asRecord['@_contentType'] ?? '').toLowerCase();
      const asLang = String(asRecord['@_lang'] ?? '');
      for (const rep of toArray(asRecord.Representation)) {
        if (!rep || typeof rep !== 'object') continue;
        const record = rep as Record<string, unknown>;
        const mimeType = String(record['@_mimeType'] ?? asMime);
        const content = mimeType.toLowerCase();
        const bandwidth = Number(record['@_bandwidth'] ?? 0) || undefined;
        const width = Number(record['@_width'] ?? 0) || undefined;
        const height = Number(record['@_height'] ?? 0) || undefined;
        const codecs = String(record['@_codecs'] ?? asRecord['@_codecs'] ?? '') || undefined;
        const lang = asLang || String(record['@_lang'] ?? '');
        const isSubtitle = content === 'text' || content.startsWith('text/') || /\b(?:vtt|ttml|dfxp|srt|webvtt)\b/i.test(content);
        const kind: 'video' | 'audio' | 'subtitle' = content.includes('audio') ? 'audio' : isSubtitle ? 'subtitle' : 'video';
        const parsedCodecs = splitCodecs(codecs);
        const vcLabel = kind === 'video' ? videoCodecLabel(parsedCodecs.vcodec) : undefined;
        const acLabel = kind === 'audio' ? audioCodecLabel(parsedCodecs.acodec) : undefined;
        const kindLabel = kind === 'audio'
          ? ['Audio', lang ? `(${lang})` : undefined, acLabel ? `[${acLabel}]` : undefined].filter(Boolean).join(' ')
          : kind === 'subtitle'
            ? `Subtitle${lang ? ` (${lang})` : ''}`
            : [resolutionLabel(width, height), vcLabel ? `(${vcLabel})` : undefined].filter(Boolean).join(' ') || undefined;
        const label = [kindLabel, bitrateLabel(bandwidth)].filter(Boolean).join(' ');
        const subtitleExt = /ttml|dfxp/.test(content) ? 'ttml' : 'vtt';
        formats.push({
          id: String(record['@_id'] ?? `dash_${formats.length}`),
          selectable: kind === 'video',
          mediaKind: kind,
          label: label || `DASH ${kind} ${formats.length + 1}`,
          ext: kind === 'subtitle' ? subtitleExt : mimeType.includes('webm') ? 'webm' : 'mp4',
          protocol: 'http_dash_segments',
          width,
          height,
          resolution: width && height ? `${width}x${height}` : kind === 'audio' ? 'audio only' : kind === 'subtitle' ? 'subtitle' : undefined,
          filesizeApprox: bandwidth,
          language: lang || undefined,
          bitrate: bandwidth,
          ...splitCodecs(codecs),
        });
      }
    }
  }

  const bestAudioId = [...formats]
    .filter((format) => format.mediaKind === 'audio')
    .sort((a, b) => (b.filesizeApprox ?? 0) - (a.filesizeApprox ?? 0))[0]?.id;
  if (bestAudioId) {
    formats.forEach((format) => {
      if (format.mediaKind === 'video') format.audioFormatId = bestAudioId;
    });
  }

  formats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.width ?? 0) - (a.width ?? 0) || (b.filesizeApprox ?? 0) - (a.filesizeApprox ?? 0));
  const bestVideo = formats.find((format) => format.mediaKind === 'video') ?? formats[0];
  const liveNote = isLive ? 'live stream' : undefined;
  const defaultLabel = isLive ? 'DASH live stream' : 'DASH MPD';
  return {
    ...item,
    label: item.label && item.label !== 'DASH' ? item.label : defaultLabel,
    width: item.width ?? bestVideo?.width,
    height: item.height ?? bestVideo?.height,
    bitrate: item.bitrate ?? bestVideo?.filesizeApprox,
    duration: item.duration ?? mpdDuration,
    liveStream: isLive || undefined,
    availableFormats: formats.length ? formats : item.availableFormats,
    sourceAudit: appendAudit(item, audit(item.url, true, ['dash-mpd', drmHint, liveNote].filter(Boolean).join('; '), {
      mimeType: fetchMeta.mimeType,
      contentLength: fetchMeta.contentLength,
      status: fetchMeta.status,
      rejectedReason: drmHint,
    })),
  };
}

export async function inspectManifestCandidate(
  item: DetectedMedia,
  options: ManifestInspectionOptions = {},
): Promise<DetectedMedia> {
  if (item.mediaType !== 'hls' && item.mediaType !== 'dash') return item;
  try {
    const fetched = await fetchManifestText(item, options);
    return item.mediaType === 'dash'
      ? inspectDash(item, fetched.text, fetched)
      : inspectHls(item, fetched.text, fetched);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...item,
      sourceAudit: appendAudit(item, audit(item.url, false, `inspection failed: ${message}`, {
        rejectedReason: message,
      })),
    };
  }
}

export async function inspectUniversalManifestCandidates(
  strategy: string | undefined,
  items: DetectedMedia[],
  options: ManifestInspectionOptions = {},
): Promise<DetectedMedia[]> {
  if (!isUniversalExtractionStrategy(strategy)) return items;
  return Promise.all(items.map((item) => inspectManifestCandidate(item, options)));
}

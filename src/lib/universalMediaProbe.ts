import { DetectedMedia, MediaKind, MediaType, Provenance } from '../types';

export interface UniversalMediaHint {
  url?: string;
  src?: string;
  mimeType?: string;
  mediaType?: MediaType;
  mediaKind?: MediaKind;
  label?: string;
  width?: number;
  height?: number;
  source?: string;
  provenance?: Provenance;
  status?: number;
  contentLength?: number;
  transferSize?: number;
  encodedBodySize?: number;
  method?: string;
}

export interface UniversalProbeInput {
  pageUrl: string;
  pageHtml?: string;
  mediaHints?: Array<UniversalMediaHint | Record<string, unknown>>;
  userAgent?: string;
}

let seq = 0;

const DIRECT_EXT_RE = /\.(?:mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i;
const AUDIO_EXT_RE = /\.(?:mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i;
const HLS_RE = /\.m3u8?(?:[?#]|$)|application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|mpegurl/i;
const DASH_RE = /\.mpd(?:[?#]|$)|application\/(?:dash|x-mpegdash)\+xml/i;
// Smooth Streaming (.ism/manifest) — treated as DASH-like adaptive bitrate
const SMOOTH_RE = /\.ism[l]?(?:\/manifest)?(?:[?#]|$)|application\/vnd\.ms-sstr\+xml/i;

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanCandidateUrl(value: string, pageUrl: string): string | undefined {
  const raw = decodeHtml(value)
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\\//g, '/')
    .replace(/[),;.\s"'<>]+$/g, '')
    .trim();
  if (!raw || /^(?:data:|blob:|javascript:|mailto:|#)/i.test(raw)) return undefined;
  // Unwrap Next.js image optimizer proxy: /_next/image?url=ENCODED_URL&w=...&q=...
  const nextImg = raw.match(/\/_next\/image\?[^"'\s]*\burl=([^&\s]+)/i);
  if (nextImg) {
    try {
      const decoded = decodeURIComponent(nextImg[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch { /* fall through */ }
  }
  try {
    const url = new URL(raw, pageUrl);
    if (!/^https?:$/i.test(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function mediaTypeFromUrl(url: string, mimeType = ''): MediaType {
  const signal = `${url} ${mimeType}`.toLowerCase();
  if (signal.includes('.mpd') || DASH_RE.test(signal) || SMOOTH_RE.test(signal)) return 'dash';
  if (signal.includes('.m3u8') || signal.includes('.m3u') || HLS_RE.test(signal)) return 'hls';
  return 'direct';
}

function mediaKindFromUrl(url: string, mimeType = ''): MediaKind {
  if (/^image\//i.test(mimeType) || IMAGE_EXT_RE.test(url)) return 'image';
  if (/^audio\//i.test(mimeType) || AUDIO_EXT_RE.test(url)) return 'audio';
  return 'video';
}

function hintString(hint: UniversalMediaHint | Record<string, unknown>, key: string): string | undefined {
  const value = hint[key as keyof typeof hint];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hintNumber(hint: UniversalMediaHint | Record<string, unknown>, key: string): number | undefined {
  const value = hint[key as keyof typeof hint];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hintMediaType(hint: UniversalMediaHint | Record<string, unknown>, url: string, mimeType?: string): MediaType | undefined {
  const mediaType = hintString(hint, 'mediaType');
  const kind = hintString(hint, 'kind');
  if (mediaType === 'hls' || mediaType === 'dash' || mediaType === 'direct' || mediaType === 'mse') return mediaType;
  if (kind === 'hls' || kind === 'dash' || kind === 'direct') return kind;
  return mediaTypeFromUrl(url, mimeType);
}

function hintMediaKind(hint: UniversalMediaHint | Record<string, unknown>, url: string, mimeType?: string): MediaKind | undefined {
  const mediaKind = hintString(hint, 'mediaKind');
  const kind = hintString(hint, 'kind');
  if (mediaKind === 'video' || mediaKind === 'image' || mediaKind === 'audio') return mediaKind;
  if (kind === 'video' || kind === 'image' || kind === 'audio') return kind;
  return mediaKindFromUrl(url, mimeType);
}

function hintProvenance(hint: UniversalMediaHint | Record<string, unknown>): Provenance | undefined {
  const provenance = hintString(hint, 'provenance');
  if (
    provenance === 'yt-player-response' ||
    provenance === 'player-sdk-hook' ||
    provenance === 'media-element' ||
    provenance === 'mediasource' ||
    provenance === 'append-buffer' ||
    provenance === 'fetch-hook' ||
    provenance === 'xhr-hook' ||
    provenance === 'perf-observer' ||
    provenance === 'page-global' ||
    provenance === 'mutation-observer' ||
    provenance === 'social-extractor' ||
    provenance === 'manifest-parser' ||
    provenance === 'message-event' ||
    provenance === 'manual'
  ) return provenance;
  return undefined;
}

function isLikelyJunk(url: string, kind: MediaKind): boolean {
  const lower = url.toLowerCase();
  if (/\/(?:favicon|apple-touch-icon|sprite|spacer|blank|pixel|tracking)[^/]*(?:[?#.]|$)/i.test(lower)) return true;
  if (/\.(?:svg|woff2?|ttf|eot|otf|ico)(?:[?#]|$)/i.test(lower)) return true;
  if (/(?:^|[/?&_-])(?:avatar|profile|badge|logo|icon)(?:[/?&_.=-]|$)/i.test(lower) && kind === 'image') return true;
  if (/\b(?:width|w|height|h)=(?:1|2|3|4|8|16)\b/i.test(lower) && kind === 'image') return true;
  return false;
}

function confidenceFor(source: string, mediaType: MediaType, kind: MediaKind): number {
  if (source === 'hint') return 0.9;
  if (source === 'media-element') return mediaType === 'direct' ? 0.88 : 0.92;
  if (source === 'resource-link') return mediaType === 'hls' || mediaType === 'dash' ? 0.82 : kind === 'image' ? 0.8 : 0.78;
  if (source === 'download-link') return kind === 'image' ? 0.8 : 0.82;
  if (source === 'data-attribute') return mediaType === 'hls' || mediaType === 'dash' ? 0.82 : kind === 'image' ? 0.8 : 0.78;
  if (source === 'css-background') return kind === 'image' ? 0.8 : 0.6;
  if (source === 'player-config' || source === 'html-template') return mediaType === 'hls' || mediaType === 'dash' ? 0.84 : kind === 'image' ? 0.64 : 0.78;
  if (source === 'hydration-data') return mediaType === 'hls' || mediaType === 'dash' ? 0.82 : kind === 'image' ? 0.62 : 0.76;
  if (source === 'microdata') return kind === 'image' ? 0.8 : 0.8;
  if (source === 'json-ld') return kind === 'video' ? 0.82 : 0.72;
  if (source === 'open-graph') return kind === 'video' ? 0.78 : kind === 'image' ? 0.8 : 0.76;
  if (source === 'generic-url') return mediaType === 'direct' && kind === 'image' ? 0.52 : 0.62;
  return 0.6;
}

function makeItem(
  url: string,
  pageUrl: string,
  source: string,
  opts: Partial<DetectedMedia> = {},
): DetectedMedia {
  const mimeType = opts.mimeType;
  const mediaType = opts.mediaType ?? mediaTypeFromUrl(url, mimeType);
  const mediaKind = opts.mediaKind ?? mediaKindFromUrl(url, mimeType);
  return {
    id: `universal_${Date.now()}_${seq++}`,
    url,
    pageUrl,
    userAgent: opts.userAgent ?? '',
    timestamp: Date.now(),
    mediaType,
    mediaKind,
    mimeType,
    label: opts.label,
    confidence: opts.confidence ?? confidenceFor(source, mediaType, mediaKind),
    provenance: opts.provenance ?? provenanceFor(source),
    width: opts.width,
    height: opts.height,
    thumbnailUrl: opts.thumbnailUrl,
    duration: opts.duration,
    forceServerDownload: opts.forceServerDownload,
    httpHeaders: opts.httpHeaders ?? { Referer: pageUrl },
    sourcePageUrl: pageUrl,
    extractor: 'universal-probe',
    sourceAudit: opts.sourceAudit,
  };
}

function provenanceFor(source: string): Provenance {
  if (source === 'media-element') return 'media-element';
  if (source === 'hint') return 'perf-observer';
  if (source === 'resource-link') return 'page-global';
  if (source === 'download-link') return 'page-global';
  if (source === 'data-attribute') return 'page-global';
  if (source === 'css-background') return 'page-global';
  if (source === 'player-config') return 'player-sdk-hook';
  if (source === 'hydration-data') return 'page-global';
  if (source === 'microdata') return 'page-global';
  if (source === 'json-ld') return 'page-global';
  if (source === 'open-graph') return 'page-global';
  return 'manifest-parser';
}

function pushCandidate(
  out: DetectedMedia[],
  seen: Set<string>,
  rawUrl: string | undefined,
  pageUrl: string,
  source: string,
  opts: Partial<DetectedMedia> = {},
  resolveUrl = pageUrl,
): void {
  if (!rawUrl) return;
  const url = cleanCandidateUrl(rawUrl, resolveUrl);
  if (!url || seen.has(url)) return;
  const mediaKind = opts.mediaKind ?? mediaKindFromUrl(url, opts.mimeType);
  if (isLikelyJunk(url, mediaKind)) return;
  seen.add(url);
  out.push(makeItem(url, pageUrl, source, { ...opts, mediaKind }));
}

function attr(tag: string, name: string): string | undefined {
  // Must be preceded by whitespace (or start-of-string), not just a word boundary —
  // `\b` would also match "src" inside "data-src" (since "-" is a non-word character),
  // silently returning the wrong attribute's value instead of undefined.
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'<>]+))`, 'i');
  const match = tag.match(re);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

export function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m) return undefined;
  const total = (Number(m[1] ?? 0) * 365.25 * 86400)
    + (Number(m[2] ?? 0) * 30.4375 * 86400)
    + (Number(m[3] ?? 0) * 7 * 86400)
    + (Number(m[4] ?? 0) * 86400)
    + (Number(m[5] ?? 0) * 3600)
    + (Number(m[6] ?? 0) * 60)
    + Number(m[7] ?? 0);
  return total > 0 ? Math.round(total) : undefined;
}

function extractPageTitle(html: string): string | undefined {
  // og:title / twitter:title are usually more specific than a generic site-wide
  // <title> tag (e.g. "MySite - Home"), so prefer them when present.
  const metaRe = /<meta\b[^>]*>/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRe.exec(html)) !== null) {
    const tag = metaMatch[0];
    const prop = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (prop === 'og:title' || prop === 'twitter:title') {
      const content = (attr(tag, 'content') ?? '').trim();
      if (content) return decodeHtml(content).trim().replace(/\s+/g, ' ');
    }
  }
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const title = decodeHtml(m[1]).trim().replace(/\s+/g, ' ');
  return title.length > 2 && title.length < 300 ? title : undefined;
}

function baseUrlFromHtml(html: string, pageUrl: string): string {
  const match = html.match(/<base\b[^>]*>/i);
  const href = match ? attr(match[0], 'href') : undefined;
  return href ? cleanCandidateUrl(href, pageUrl) ?? pageUrl : pageUrl;
}

function attrs(tag: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const re = /\b([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag)) !== null) {
    out.push({ name: match[1], value: match[3] ?? match[4] ?? match[5] ?? '' });
  }
  return out;
}

function bestSrcsetCandidate(srcset?: string): string | undefined {
  if (!srcset) return undefined;
  let best: { url: string; score: number } | undefined;
  for (const part of decodeHtml(srcset).split(',')) {
    const [url, descriptor = '1x'] = part.trim().split(/\s+/, 2);
    if (!url) continue;
    const width = descriptor.match(/^(\d+)w$/i);
    const density = descriptor.match(/^(\d+(?:\.\d+)?)x$/i);
    const score = width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 1;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url;
}

function dataAttributeMimeFor(name: string, url: string): string | undefined {
  const signal = `${name} ${url}`.toLowerCase();
  if (/dash|mpd|\.ism[l]?(?:\/manifest)?|ms-sstr/.test(signal)) return 'application/dash+xml';
  if (/hls|m3u8|mpegurl/.test(signal)) return 'application/vnd.apple.mpegurl';
  if (/audio|podcast|m4a|aac|mp3/.test(signal)) return 'audio/mp4';
  if (/image|img|photo|picture|thumb|thumbnail|poster|cover|original|fullsize|srcset/.test(signal)) return 'image/jpeg';
  if (/video|media|stream|playback|download|mp4|webm/.test(signal)) return 'video/mp4';
  return undefined;
}

function isStrongDataAttribute(name: string, url: string, mimeType?: string): boolean {
  if (!/^data-/i.test(name)) return false;
  if (/api|config|endpoint|href|link|page|profile|avatar|icon|tracking|pixel/i.test(name)) return false;
  const mediaName = /(?:video|media|stream|play|playback|download|hls|dash|mpd|mp4|m4v|webm|mov|ogg|flv|audio|mp3|m4a|podcast|image|img|photo|picture|thumb|thumbnail|poster|cover|original|fullsize|srcset|lazy|hd|sd)/i.test(name);
  if (!mediaName) return false;
  const signal = `${url} ${mimeType || ''}`;
  return DIRECT_EXT_RE.test(url) || HLS_RE.test(signal) || DASH_RE.test(signal) || SMOOTH_RE.test(signal) || /^(?:video|audio|image)\//i.test(mimeType || '');
}

function scanDataAttributes(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const tagRe = /<[a-zA-Z][^>]*\sdata-[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null && out.length < 180) {
    const tag = match[0];
    for (const { name, value } of attrs(tag)) {
      if (!/^data-/i.test(name)) continue;
      const rawUrl = name.toLowerCase().includes('srcset') ? bestSrcsetCandidate(value) : value;
      const mimeType = dataAttributeMimeFor(name, rawUrl || '');
      if (!rawUrl || !isStrongDataAttribute(name, rawUrl, mimeType)) continue;
      pushCandidate(out, seen, rawUrl, pageUrl, 'data-attribute', {
        mimeType,
        label: 'Embedded media',
        sourceAudit: [{
          strategy: 'data-attribute',
          source: 'html-attribute',
          url: cleanCandidateUrl(rawUrl, resolveUrl),
          selected: true,
          fieldPath: name,
          mimeType,
        }],
      }, resolveUrl);
    }
  }
}

const JSON_DATA_ATTR_NAME_RE = /^data-(?:config|setup|options|player|player-config|player-data|player-options|player-setup|video|video-config|media|media-config|sources?|jwplayer|jw-config|flowplayer|flowplayer-config|fp-config|plyr|vjs|stream|hls|dash|theo|embed|brightcove|bitmovin|kaltura|kaltura-config|clappr|clappr-config|dplayer|vidyard)$/i;
const JSON_DATA_CONTENT_RE = /"(?:sources?|file|src|hls|dash|stream|video_url|episode_url|recording_url|source_url|mp4|hlsUrl|dashUrl|streamUrl|mediaUrl|manifest_url|playback_url|master_url|m3u8_url|m3u8Url|live_url|liveUrl|audio_url|audioUrl)"\s*:/i;

function scanJsonDataAttributes(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const tagRe = /<[a-zA-Z][^>]*\sdata-[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(html)) !== null && out.length < 160) {
    const tag = tagMatch[0];
    for (const { name, value } of attrs(tag)) {
      if (!/^data-/i.test(name)) continue;
      const v = decodeHtml(value).trim();
      if (!v || (v[0] !== '{' && v[0] !== '[')) continue;
      const nameOk = JSON_DATA_ATTR_NAME_RE.test(name);
      const contentOk = !nameOk && JSON_DATA_CONTENT_RE.test(v);
      if (!nameOk && !contentOk) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(v); } catch { continue; }
      if (!parsed) continue;
      // Wrap in a synthetic hydration script and run the existing scanners
      const fakeHtml = `<script type="text/x-player-data" id="__INITIAL_STATE__">${v}</script>`;
      scanHydrationData(fakeHtml, pageUrl, out, seen, resolveUrl);
      scanPlayerConfigs(fakeHtml, pageUrl, out, seen, resolveUrl);
      if (out.length >= 160) return;
    }
  }
}

function scanCssBackgroundImages(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const scanCssText = (cssText: string, source: string) => {
    const text = decodeHtml(cssText);
    const urlRe = /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = urlRe.exec(text)) !== null && out.length < 180) {
      const nearby = text.slice(Math.max(0, match.index - 90), Math.min(text.length, match.index + 90));
      const rawUrl = match[1];
      if (!/(?:background(?:-image)?|image-set)\s*[:(,]/i.test(nearby)) continue;
      if (!IMAGE_EXT_RE.test(rawUrl)) continue;
      pushCandidate(out, seen, rawUrl, pageUrl, 'css-background', {
        mediaKind: 'image',
        mimeType: 'image/jpeg',
        label: 'Background image',
        sourceAudit: [{
          strategy: 'css-background',
          source,
          url: cleanCandidateUrl(rawUrl, resolveUrl),
          selected: true,
          fieldPath: 'background-image',
          mimeType: 'image/jpeg',
        }],
      }, resolveUrl);
    }
  };

  const styledTagRe = /<[a-zA-Z][^>]*\sstyle\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = styledTagRe.exec(html)) !== null) {
    scanCssText(match[2] ?? match[3] ?? match[4] ?? '', 'style-attribute');
  }

  const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((match = styleBlockRe.exec(html)) !== null) {
    scanCssText(match[1], 'style-tag');
  }
}

function scanMeta(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const metaRe = /<meta\b[^>]*>/gi;
  const metas: Array<{ key: string; content: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html)) !== null) {
    const tag = match[0];
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (!content) continue;
    metas.push({ key, content });
  }

  const videoMime = metas.find((item) => /^(?:og:video:type|twitter:player:stream:content_type)$/.test(item.key))?.content;
  const audioMime = metas.find((item) => /^(?:og:audio:type)$/.test(item.key))?.content;
  const imageMime = metas.find((item) => /^(?:og:image:type|twitter:image:type)$/.test(item.key))?.content;
  const metaDim = (re: RegExp): number | undefined => {
    const value = metas.find((item) => re.test(item.key))?.content;
    const num = value ? Number(value) : undefined;
    return num && Number.isFinite(num) && num > 0 ? num : undefined;
  };
  const videoWidth = metaDim(/^og:video:width$/);
  const videoHeight = metaDim(/^og:video:height$/);
  const imageWidth = metaDim(/^(?:og:image:width|twitter:image:width)$/);
  const imageHeight = metaDim(/^(?:og:image:height|twitter:image:height)$/);

  for (const { key, content } of metas) {
    if (/^(?:og:video(?::(?:url|secure_url))?|twitter:player:stream|twitter:player|video_url|media:url|content:url|media:video:url)$/.test(key)) {
      pushCandidate(out, seen, content, pageUrl, 'open-graph', { mediaKind: 'video', mimeType: videoMime, width: videoWidth, height: videoHeight }, resolveUrl);
    } else if (/^(?:og:audio(?::(?:url|secure_url))?|media:audio:url)$/.test(key)) {
      pushCandidate(out, seen, content, pageUrl, 'open-graph', { mediaKind: 'audio', mimeType: audioMime }, resolveUrl);
    } else if (/^(?:og:image(?::(?:url|secure_url))?|twitter:image(?::src)?|thumbnailurl)$/.test(key)) {
      pushCandidate(out, seen, content, pageUrl, 'open-graph', { mediaKind: 'image', mimeType: imageMime, label: 'Image', width: imageWidth, height: imageHeight }, resolveUrl);
    }
  }
}

function microdataMimeFor(prop: string, url: string, explicitType?: string): string | undefined {
  if (explicitType && /^(?:video|audio|image)\//i.test(explicitType)) return explicitType;
  if (explicitType && /(?:dash|mpegurl|m3u8)/i.test(explicitType)) return /dash/i.test(explicitType) ? 'application/dash+xml' : 'application/vnd.apple.mpegurl';
  if (SMOOTH_RE.test(url)) return 'application/vnd.ms-sstr+xml';
  if (DASH_RE.test(url)) return 'application/dash+xml';
  if (HLS_RE.test(url)) return 'application/vnd.apple.mpegurl';
  if (AUDIO_EXT_RE.test(url)) return 'audio/mp4';
  if (IMAGE_EXT_RE.test(url) || /^(?:thumbnailurl|image|poster)$/i.test(prop)) return 'image/jpeg';
  if (DIRECT_EXT_RE.test(url)) return 'video/mp4';
  return undefined;
}

function scanMicrodataMedia(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const tagRe = /<[a-zA-Z][^>]*\bitemprop\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null && out.length < 180) {
    const tag = match[0];
    const props = (match[2] ?? match[3] ?? match[4] ?? '').toLowerCase().split(/\s+/);
    const prop = props.find((item) => /^(?:contenturl|downloadurl|thumbnailurl|image|poster)$/.test(item));
    if (!prop) continue;
    const rawUrl = attr(tag, 'content') ?? attr(tag, 'href') ?? attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-lazy-src');
    if (!rawUrl) continue;
    const mimeType = microdataMimeFor(prop, rawUrl, attr(tag, 'type'));
    const mediaKind: MediaKind | undefined = /^(?:thumbnailurl|image|poster)$/i.test(prop) ? 'image' : undefined;
    const signal = `${rawUrl} ${mimeType || ''}`;
    if (!DIRECT_EXT_RE.test(signal) && !HLS_RE.test(signal) && !DASH_RE.test(signal) && !SMOOTH_RE.test(signal) && !/^(?:video|audio|image)\//i.test(mimeType || '')) continue;
    pushCandidate(out, seen, rawUrl, pageUrl, 'microdata', {
      mimeType,
      mediaKind,
      label: mediaKind === 'image' ? 'Microdata image' : 'Microdata media',
      sourceAudit: [{
        strategy: 'schema-microdata',
        source: 'itemprop',
        url: cleanCandidateUrl(rawUrl, resolveUrl),
        selected: true,
        fieldPath: prop,
        mimeType,
      }],
    }, resolveUrl);
  }
}

// ── HTML5 <template> element scanner ─────────────────────────────────────────
// Vue / Alpine / Lit / Handlebars / Mustache and similar frameworks use
// <template> elements as client-side templates.  The browser never renders
// their content, but media src/srcset attributes inside them are valid URLs.
function scanTemplateElements(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const tmplRe = /<template\b[^>]*>([\s\S]*?)<\/template>/gi;
  let match: RegExpExecArray | null;
  while ((match = tmplRe.exec(html)) !== null && out.length < 80) {
    const inner = match[1];
    if (!inner.trim()) continue;
    // Scan media elements inside the template body
    scanMediaElements(inner, pageUrl, out, seen, resolveUrl);
    scanDataAttributes(inner, pageUrl, out, seen, resolveUrl);
  }
}

// ── WordPress Gutenberg block comment scanner ─────────────────────────────────
// WordPress ≥5.0 serialises block data in HTML comments:
//   <!-- wp:video {"id":123,"src":"https://cdn.example.com/video.mp4"} /-->
//   <!-- wp:audio {"id":456,"src":"https://cdn.example.com/audio.mp3"} /-->
// The inner JSON sometimes has "url" instead of "src".
const WP_BLOCK_RE = /<!--\s*wp:(?:video|audio|media-text|cover)\s+(\{[^}]+\})\s*(?:\/-->|-->)/gi;
function scanWordPressBlocks(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  let match: RegExpExecArray | null;
  while ((match = WP_BLOCK_RE.exec(html)) !== null && out.length < 80) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(match[1]); } catch { continue; }
    const raw = (data.src ?? data.url ?? data.mediaUrl ?? data.mediaLink) as string | undefined;
    if (!raw || typeof raw !== 'string') continue;
    const kind: MediaKind = typeof data.mediaType === 'string' && data.mediaType === 'audio' ? 'audio' : 'video';
    pushCandidate(out, seen, raw, pageUrl, 'hydration-data', {
      mediaKind: kind,
      label: typeof data.caption === 'string' ? data.caption.slice(0, 120) : 'WordPress block media',
      sourceAudit: [{ strategy: 'wp-block', source: 'html-comment', url: cleanCandidateUrl(raw, resolveUrl), selected: true, fieldPath: 'wp:video/audio' }],
    }, resolveUrl);
  }
}

function scanTemplateScripts(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null && out.length < 160) {
    const typeVal = (attr(`<script ${match[1]}>`, 'type') ?? '').toLowerCase();
    if (!typeVal || /javascript|ecmascript|module|json|ld\+json/.test(typeVal)) continue;
    const tmplText = decodeHtml(match[2]);
    const tagRe2 = /<(video|audio|source|img)\b[^>]*>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe2.exec(tmplText)) !== null && out.length < 160) {
      const tag = tm[0];
      const tagName = tm[1].toLowerCase();
      const src = attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-lazy-src') ?? attr(tag, 'data-original') ?? attr(tag, 'data-original-src') ?? attr(tag, 'data-lazy') ?? attr(tag, 'data-video-url') ?? attr(tag, 'data-stream-url') ?? attr(tag, 'data-hls-url') ?? attr(tag, 'data-hls-src') ?? attr(tag, 'data-mp4') ?? attr(tag, 'data-file');
      const forcedKind: MediaKind | undefined =
        tagName === 'img' ? 'image' : tagName === 'audio' ? 'audio' : tagName === 'video' ? 'video' : undefined;
      pushCandidate(out, seen, src, pageUrl, 'html-template', {
        mimeType: attr(tag, 'type'),
        mediaKind: forcedKind,
      }, resolveUrl);
    }
  }
}

function scanMediaElements(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const tagRe = /<(video|audio|amp-video|amp-audio|source|track|img)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    const tagName = match[1].toLowerCase();

    if (tagName === 'track') {
      const kind = (attr(tag, 'kind') ?? '').toLowerCase();
      if (/^(?:subtitles|captions|descriptions?)$/.test(kind)) {
        const src = attr(tag, 'src');
        pushCandidate(out, seen, src, pageUrl, 'media-element', {
          mediaKind: 'subtitle',
          mimeType: 'text/vtt',
          label: attr(tag, 'label') ?? undefined,
        }, resolveUrl);
      }
      continue;
    }

    const src = attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-lazy-src') ?? attr(tag, 'data-original') ?? attr(tag, 'data-original-src') ?? attr(tag, 'data-lazy') ?? attr(tag, 'data-video-url') ?? attr(tag, 'data-stream-url') ?? attr(tag, 'data-hls-url') ?? attr(tag, 'data-hls-src') ?? attr(tag, 'data-mp4') ?? attr(tag, 'data-file');
    const srcset = attr(tag, 'srcset') ?? attr(tag, 'data-srcset');
    const mimeType = attr(tag, 'type');
    const isAmpVideo = tagName === 'amp-video';
    const isAmpAudio = tagName === 'amp-audio';
    const forcedKind: MediaKind | undefined =
      tagName === 'img' ? 'image'
      : (tagName === 'audio' || isAmpAudio) ? 'audio'
      : (tagName === 'video' || isAmpVideo) ? 'video'
      : undefined;
    const elemWidth = (tagName === 'video' || isAmpVideo || tagName === 'img') ? (Number(attr(tag, 'width')) || undefined) : undefined;
    const elemHeight = (tagName === 'video' || isAmpVideo || tagName === 'img') ? (Number(attr(tag, 'height')) || undefined) : undefined;
    // Background/decorative videos: autoplay+loop+muted with no controls are rarely
    // the user's download target. Penalise to below the auto-download threshold.
    const isBackgroundVideo = (tagName === 'video' || isAmpVideo)
      && /\bautoplay\b/i.test(tag) && /\bloop\b/i.test(tag)
      && /\bmuted\b/i.test(tag) && !/\bcontrols\b/i.test(tag);
    // Explicit user-facing video: <video controls> or <video playsinline> without background pattern.
    const isUserFacingVideo = !isBackgroundVideo && (tagName === 'video' || isAmpVideo)
      && (/\bcontrols\b/i.test(tag) || /\bplaysinline\b/i.test(tag));
    const videoConfidence = isBackgroundVideo ? 0.55 : isUserFacingVideo ? 0.82 : undefined;
    pushCandidate(out, seen, src, pageUrl, 'media-element', { mimeType, mediaKind: forcedKind, width: elemWidth, height: elemHeight, confidence: videoConfidence }, resolveUrl);
    if (srcset && (tagName === 'img' || tagName === 'source')) {
      pushCandidate(out, seen, bestSrcsetCandidate(srcset), pageUrl, 'media-element', {
        mimeType,
        mediaKind: 'image',
        label: 'Responsive image',
      }, resolveUrl);
    }
    if (tagName === 'video' || isAmpVideo) {
      pushCandidate(out, seen, attr(tag, 'poster'), pageUrl, 'media-element', { mediaKind: 'image', label: 'Poster' }, resolveUrl);
    }
  }
}

function resourceLinkKind(asValue: string, mimeType?: string): MediaKind | undefined {
  const signal = `${asValue} ${mimeType || ''}`.toLowerCase();
  if (/\bimage\b|^image\//.test(signal)) return 'image';
  if (/\baudio\b|^audio\//.test(signal)) return 'audio';
  if (/\bvideo\b|^video\/|dash|mpegurl|m3u8/.test(signal)) return 'video';
  return undefined;
}

function isStrongResourceLink(tag: string, url: string, mimeType?: string): boolean {
  const rel = (attr(tag, 'rel') ?? '').toLowerCase();
  const asValue = (attr(tag, 'as') ?? '').toLowerCase();
  const signal = `${url} ${mimeType || ''}`.toLowerCase();
  // Old-style Facebook/OpenGraph link hints (pre-OG-spec) and HTML5 media hints
  if (/^(?:video[_-]src|audio[_-]src|image[_-]src|media|video|audio)$/.test(rel)) {
    if (/^(?:video|audio|image)\//i.test(mimeType || '') || DIRECT_EXT_RE.test(url) || HLS_RE.test(signal) || DASH_RE.test(signal)) return true;
  }
  // <link rel="alternate" type="video/..."> or type="audio/...": used by podcast/video sites
  // to advertise alternate media representations of the page.
  if (rel === 'alternate' && /^(?:video|audio)\//i.test(mimeType || '')) return true;
  if (!/(?:preload|prefetch|prerender|modulepreload)/.test(rel)) return false;
  if (!/^(?:video|audio|image|fetch)$/.test(asValue)) return false;
  if (/^(?:video|audio|image)\//i.test(mimeType || '') || HLS_RE.test(signal) || DASH_RE.test(signal) || SMOOTH_RE.test(signal) || DIRECT_EXT_RE.test(signal)) return true;
  return false;
}

function scanResourceLinks(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const linkRe = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && out.length < 160) {
    const tag = match[0];
    const href = attr(tag, 'href') ?? bestSrcsetCandidate(attr(tag, 'imagesrcset'));
    const mimeType = attr(tag, 'type');
    if (!href || !isStrongResourceLink(tag, href, mimeType)) continue;
    const mediaKind = resourceLinkKind(attr(tag, 'as') ?? '', mimeType);
    pushCandidate(out, seen, href, pageUrl, 'resource-link', {
      mimeType,
      mediaKind,
      label: 'Preloaded media',
      sourceAudit: [{
        strategy: 'resource-link',
        source: 'link-tag',
        url: cleanCandidateUrl(href, resolveUrl),
        selected: true,
        fieldPath: attr(tag, 'rel') ?? 'link',
        mimeType,
      }],
    }, resolveUrl);
  }

  const downloadRe = /<a\b[^>]*\bdownload(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?[^>]*>/gi;
  while ((match = downloadRe.exec(html)) !== null && out.length < 180) {
    const tag = match[0];
    const href = attr(tag, 'href');
    if (!href) continue;
    const mimeType = attr(tag, 'type');
    const mimeSignal = mimeType || '';
    if (!DIRECT_EXT_RE.test(href) && !HLS_RE.test(`${href} ${mimeSignal}`) && !DASH_RE.test(`${href} ${mimeSignal}`) && !SMOOTH_RE.test(`${href} ${mimeSignal}`) && !/^(?:video|audio|image)\//i.test(mimeSignal)) continue;
    pushCandidate(out, seen, href, pageUrl, 'download-link', {
      mimeType,
      label: attr(tag, 'download') || 'Download',
      sourceAudit: [{
        strategy: 'download-link',
        source: 'anchor-download',
        url: cleanCandidateUrl(href, resolveUrl),
        selected: true,
        fieldPath: 'download',
        mimeType,
      }],
    }, resolveUrl);
  }

  // Scan plain <a href> links to media files (no `download` attr required).
  // Podcast listing pages and MP4 download pages often use bare anchor tags.
  // We require either a strong AV/HLS/DASH extension OR an explicit media MIME
  // type on the `type` attribute, and skip page-navigation hrefs.
  const MEDIA_ANCHOR_EXT_RE = /\.(?:mp3|mp4|m4v|m4a|webm|mov|ogg|opus|flac|wav|aac|m3u8?|mpd)(?:[?#]|$)/i;
  const PAGE_EXT_RE = /\.(?:html?|php|asp(?:x)?|jsp?|py|rb|go|cfm|cgi)(?:[?#]|$)/i;
  // \s (not \b) immediately before "href": a word boundary would also match "href"
  // inside "data-href", and greedy backtracking in [^>]* makes that ambiguous enough
  // to sometimes prefer the wrong attribute's value over the real href (see the
  // identical bug class fixed in attr() above).
  const anchorRe = /<a\b(?![^>]*\bdownload\b)[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))[^>]*>/gi;
  while ((match = anchorRe.exec(html)) !== null && out.length < 180) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    if (!href || PAGE_EXT_RE.test(href)) continue;
    const mimeType = attr(match[0], 'type');
    const mimeSignal = mimeType || '';
    const hasMediaExt = MEDIA_ANCHOR_EXT_RE.test(href);
    const hasMediaMime = /^(?:video|audio)\//i.test(mimeSignal) || /(?:mpegurl|dash\+xml|vnd\.apple\.mpegurl)/i.test(mimeSignal);
    if (!hasMediaExt && !hasMediaMime) continue;
    pushCandidate(out, seen, href, pageUrl, 'download-link', {
      mimeType,
      label: 'Media link',
      sourceAudit: [{
        strategy: 'media-anchor-href',
        source: 'anchor-href',
        url: cleanCandidateUrl(href, resolveUrl),
        selected: true,
        fieldPath: 'href',
        mimeType,
      }],
    }, resolveUrl);
  }
}

// ── Custom media element scanner ──────────────────────────────────────────────
// CMSes (Arc XP, Brightcove, WordPress block player, Drupal) and React-based
// media libraries register custom elements whose tag names contain "video",
// "audio", "player", or "media".  These are invisible to scanMediaElements
// because they are not in the HTML5 element set.  Common examples:
//   <audio-player src="...">, <video-player src="...">, <media-player src="...">
//   <jw-player file="...">, <bc-video video-id="...">, <flowplayer-video src="...">
const CUSTOM_MEDIA_ELEMENT_RE = /<([a-z][a-z0-9]*-(?:video|audio|player|media|stream)|(?:video|audio|media)-[a-z][a-z0-9-]*)\b[^>]*>/gi;
function scanCustomMediaElements(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  let match: RegExpExecArray | null;
  while ((match = CUSTOM_MEDIA_ELEMENT_RE.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    const tagName = match[1].toLowerCase();
    const isAudio = /audio/.test(tagName);
    const kind: MediaKind = isAudio ? 'audio' : 'video';
    // Try common source attributes in order
    const raw = attr(tag, 'src') ?? attr(tag, 'file') ?? attr(tag, 'url')
              ?? attr(tag, 'data-src') ?? attr(tag, 'data-file') ?? attr(tag, 'data-url')
              ?? attr(tag, 'playback-id');
    if (!raw) continue;
    const mimeType = attr(tag, 'type') ?? undefined;
    const signal = `${raw} ${mimeType || ''}`;
    if (!DIRECT_EXT_RE.test(raw) && !HLS_RE.test(signal) && !DASH_RE.test(signal) && !/^(?:video|audio)\//i.test(mimeType || '')) continue;
    pushCandidate(out, seen, raw, pageUrl, 'media-element', {
      mimeType,
      mediaKind: kind,
      label: `Custom player: ${tagName}`,
      sourceAudit: [{ strategy: 'custom-element', source: 'element-attr', url: cleanCandidateUrl(raw, resolveUrl), selected: true, fieldPath: 'src' }],
    }, resolveUrl);
  }
}

// ── data-bg-video / data-background-video attribute scanner ──────────────────
// Webflow, Squarespace and custom CMSes set video URLs in data-bg-video (or
// data-background-video) on <div>/<section> elements instead of using a native
// <video> tag. These are not caught by scanMediaElements so we scan them here.

function scanBgVideoAttrs(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const re = /<[a-zA-Z][^>]*\bdata-(?:bg-?video|background-?video)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    const rawUrl = attr(tag, 'data-bg-video') ?? attr(tag, 'data-bgvideo') ?? attr(tag, 'data-background-video') ?? attr(tag, 'data-backgroundvideo');
    if (!rawUrl) continue;
    pushCandidate(out, seen, rawUrl, pageUrl, 'media-element', { mediaKind: 'video' }, resolveUrl);
  }
}

// ── Podcast / RSS feed link scanner ──────────────────────────────────────────
// Many podcast pages advertise their RSS/Atom feed via <link rel="alternate">.
// Emitting the feed URL lets the server extraction pipeline parse it for audio.

function scanPodcastFeedLinks(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const linkRe = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && out.length < 200) {
    const tag = match[0];
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const mimeType = (attr(tag, 'type') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href || !rel.includes('alternate')) continue;
    if (!/application\/(?:rss|atom)\+xml|application\/feed\+json|application\/podcast\+xml/.test(mimeType)) continue;
    const url = cleanCandidateUrl(href, pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(makeItem(url, pageUrl, 'resource-link', {
      mediaKind: 'audio',
      mimeType: 'application/rss+xml',
      label: attr(tag, 'title') ?? 'Podcast feed',
      confidence: 0.78,
      forceServerDownload: true,
      sourceAudit: [{ strategy: 'feed-link', source: 'link-tag', url, selected: true, fieldPath: 'rel=alternate' }],
    }));
  }
}

// ── Known-player <iframe> embed detection ────────────────────────────────────

// Matches the netloc+path prefix of all well-known video/audio embed players.
const EMBED_IFRAME_RE = new RegExp(
  '^https?://(?:' +
  '(?:www\\.)?youtube(?:-nocookie)?\\.com/embed/[A-Za-z0-9_-]{6,}|' +
  'youtu\\.be/[A-Za-z0-9_-]{6,}|' +
  'player\\.vimeo\\.com/video/\\d+|' +
  '(?:www\\.)?dailymotion\\.com/embed/video/[A-Za-z0-9]+|' +
  'dai\\.ly/[A-Za-z0-9]+|' +
  'players\\.brightcove\\.net/\\d+/|' +
  'cdn\\.jwplayer\\.com/players/[^/]+\\.html|' +
  'fast\\.wistia\\.(?:net|com)/embed/|' +
  'wistia\\.(?:net|com)/embed/|' +
  'iframe\\.cloudflarestream\\.com/[a-f0-9]|' +
  '(?:[^/]+\\.)?cloudflarestream\\.com/[a-f0-9]{32}/iframe|' +
  'streamable\\.com/(?:e|o|s)/[A-Za-z0-9]+|' +
  'rumble\\.com/embed/[A-Za-z0-9]+|' +
  'player\\.twitch\\.tv/|' +
  'clips\\.twitch\\.tv/embed|' +
  'open\\.spotify\\.com/embed/(?:episode|track|show|playlist)/|' +
  '(?:www\\.)?loom\\.com/embed/[a-f0-9]+|' +
  'embed\\.vidyard\\.com/[^/?]+|' +
  'play\\.vidyard\\.com/[0-9a-zA-Z-]{8,}(?:\\.html)?(?:[^.a-zA-Z]|$)|' +
  'videopress\\.com/(?:v|embed)/[A-Za-z0-9]+|' +
  'w\\.soundcloud\\.com/player/|' +
  'player\\.simplecast\\.com/[^/?]+|' +
  'share\\.transistor\\.fm/[^/?]+|' +
  'embed\\.acast\\.com/[^/?]+|' +
  'embed\\.megaphone\\.fm/[^/?]+|' +
  'embed\\.ted\\.com/(?:talks|playlists)/|' +
  '(?:www\\.)?facebook\\.com/plugins/video\\.php|' +
  'www\\.facebook\\.com/video/embed|' +
  '[^/]+\\.panopto\\.(?:com|eu)/Panopto/Pages/(?:Viewer|Embed)\\.aspx|' +
  'content\\.jwplatform\\.com/players/[^/?]+|' +
  'videos\\.sproutvideo\\.com/embed/[^/?]+|' +
  '[^/]+\\.kaltura\\.com/[^/]+/(?:embed|embedPlaykitJs)/|' +
  'embed\\.kumu\\.io/[^/?]+|' +
  // Short-form / social video
  '(?:www\\.)?tiktok\\.com/embed/|' +
  'vm\\.tiktok\\.com/|' +
  'odysee\\.com/\\$/embed/|' +
  '(?:www\\.)?bitchute\\.com/embed/[A-Za-z0-9]+|' +
  '(?:www\\.)?youtube(?:-nocookie)?\\.com/embed/[A-Za-z0-9_-]{6,}|' +
  // Podcast hosting
  'anchor\\.fm/[^/]+/embed/episodes/|' +
  'widget\\.spreaker\\.com/player|' +
  'www\\.buzzsprout\\.com/[^/]+/player|' +
  'player\\.captivate\\.fm/[^/?]+|' +
  '(?:www\\.)?podbean\\.com/player|' +
  // Business / screen recording
  'app\\.vidcast\\.io/share/embed/|' +
  'share\\.descript\\.com/embed/|' +
  // CDN-backed video hosting
  'iframe\\.mediadelivery\\.net/embed/|' +
  'iframe\\.bunny\\.net/embed/|' +
  // PeerTube federated instances: any host with /videos/embed/<UUID>
  '[^/]+/videos/embed/[0-9a-f]{8}-[0-9a-f]{4}-|' +
  // Kick.com live streams
  'player\\.kick\\.com/|' +
  // Bandcamp audio/music player
  '(?:www\\.)?bandcamp\\.com/EmbeddedPlayer/|' +
  // Instagram post / reel / TV embeds
  '(?:www\\.)?instagram\\.com/(?:p|reel|tv)/[A-Za-z0-9_-]+/embed/|' +
  // Twitter/X embedded Tweet player (video-bearing tweets)
  'platform\\.(?:twitter|x)\\.com/embed/' +
  ')',
  'i',
);

function scanIframeEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const re = /<(?:iframe|object|embed)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    // Try candidate URL attributes in order. GDPR/CMP consent-deferred iframes use
    // src="about:blank" and store the real embed URL in data-*-src attributes.
    const candidates = [
      attr(tag, 'src'), attr(tag, 'data'), attr(tag, 'data-src'),
      attr(tag, 'data-consent-src'), attr(tag, 'data-cmp-src'),
      attr(tag, 'data-cookieconsent-src'), attr(tag, 'data-delayed-src'),
    ];
    for (const rawUrl of candidates) {
      if (!rawUrl) continue;
      const url = cleanCandidateUrl(rawUrl, resolveUrl);
      if (!url || seen.has(url) || !EMBED_IFRAME_RE.test(url)) continue;
      seen.add(url);
      out.push(makeItem(url, pageUrl, 'player-config', {
        mediaKind: 'video',
        label: 'Embedded video',
        confidence: 0.82,
        provenance: 'page-global',
        forceServerDownload: true,
        sourceAudit: [{ strategy: 'iframe-embed', source: 'embed-tag', url, selected: true }],
      }));
      break;
    }
    // <object data="media.mp4" type="video/..."> and <embed src="media.mp4" type="video/...">
    // are direct media embeds (not Flash, not embed players) — treat like <video src>.
    const tagName = (/<(\w+)/.exec(tag)?.[1] ?? '').toLowerCase();
    if (tagName === 'object' || tagName === 'embed') {
      const directSrc = attr(tag, tagName === 'object' ? 'data' : 'src') ?? '';
      const directType = attr(tag, 'type') ?? '';
      if (directSrc && /^(?:video|audio)\//i.test(directType) && DIRECT_EXT_RE.test(directSrc)) {
        const mediaKind: MediaKind = /^audio\//i.test(directType) ? 'audio' : 'video';
        pushCandidate(out, seen, directSrc, pageUrl, 'media-element', {
          mimeType: directType,
          mediaKind,
          label: 'Embedded media',
          sourceAudit: [{ strategy: 'object-embed', source: 'embed-tag', url: cleanCandidateUrl(directSrc, resolveUrl), selected: true, fieldPath: tagName === 'object' ? 'data' : 'src', mimeType: directType }],
        }, resolveUrl);
      }
    }
    // <iframe srcdoc="..."> embeds inline HTML — scan it for media elements.
    const srcdoc = attr(tag, 'srcdoc');
    if (srcdoc && out.length < 80) {
      const innerHtml = srcdoc.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      scanMediaElements(innerHtml, pageUrl, out, seen, resolveUrl);
      scanIframeEmbeds(innerHtml, pageUrl, out, seen, resolveUrl);
    }
  }
}

// ── Flash object / flashvars scanner ─────────────────────────────────────────
// Legacy Flash embeds advertise the media file in a flashvars query string or
// in <param name="movie"> / <param name="src">.  The keys we care about:
//   file, mp4, hd, src, stream, url (rarely: flv, clip)
// Also covers <embed type="application/x-shockwave-flash" flashvars="..."> and
// direct <param name="src" value="URL"> / <param name="movie" value="URL">.

const FLASHVARS_MEDIA_KEY_RE = /^(?:file|mp4|hd|src|stream|url|clip|flv|video_file|videofile|video_url|videoUrl|media_url|content_url)$/i;

function scanFlashEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  // Scan <object> blocks for nested <param> tags
  const objectRe = /<object\b[^>]*>([\s\S]*?)<\/object>/gi;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = objectRe.exec(html)) !== null && out.length < 80) {
    const block = objectMatch[0] + objectMatch[1];
    // Extract flashvars from <param name="flashvars" value="...">
    const fvParamRe = /<param\b[^>]*\bname\s*=\s*["']flashvars["'][^>]*>/gi;
    let fvMatch: RegExpExecArray | null;
    while ((fvMatch = fvParamRe.exec(block)) !== null) {
      const fv = attr(fvMatch[0], 'value') ?? '';
      try {
        const params = new URLSearchParams(fv);
        for (const [k, v] of params.entries()) {
          if (!FLASHVARS_MEDIA_KEY_RE.test(k)) continue;
          const url = cleanCandidateUrl(v, resolveUrl);
          if (!url || !DIRECT_EXT_RE.test(url)) continue;
          pushCandidate(out, seen, url, pageUrl, 'player-config', {
            label: 'Flash media',
            sourceAudit: [{ strategy: 'flash-param', source: 'flashvars', url, selected: true, fieldPath: k }],
          }, resolveUrl);
        }
      } catch { /* malformed flashvars */ }
    }
    // <param name="src"|"movie" value="URL"> — may be a direct media file
    const srcParamRe = /<param\b[^>]*\bname\s*=\s*["'](?:src|movie)["'][^>]*>/gi;
    let srcMatch: RegExpExecArray | null;
    while ((srcMatch = srcParamRe.exec(block)) !== null) {
      const v = attr(srcMatch[0], 'value') ?? '';
      if (!v || /\.swf(?:[?#]|$)/i.test(v)) continue; // skip .swf player files
      if (!DIRECT_EXT_RE.test(v)) continue;
      pushCandidate(out, seen, v, pageUrl, 'player-config', {
        label: 'Flash media',
        sourceAudit: [{ strategy: 'flash-param', source: 'param-src', url: cleanCandidateUrl(v, resolveUrl), selected: true, fieldPath: 'movie' }],
      }, resolveUrl);
    }
  }
  // <embed type="...flash..." flashvars="..."> — flashvars as direct attribute
  const embedRe = /<embed\b[^>]*\btype\s*=\s*["'][^"']*(?:flash|shockwave)[^"']*["'][^>]*>/gi;
  let embedMatch: RegExpExecArray | null;
  while ((embedMatch = embedRe.exec(html)) !== null && out.length < 80) {
    const tag = embedMatch[0];
    const fv = attr(tag, 'flashvars') ?? '';
    if (fv) {
      try {
        const params = new URLSearchParams(fv);
        for (const [k, v] of params.entries()) {
          if (!FLASHVARS_MEDIA_KEY_RE.test(k)) continue;
          const url = cleanCandidateUrl(v, resolveUrl);
          if (!url || !DIRECT_EXT_RE.test(url)) continue;
          pushCandidate(out, seen, url, pageUrl, 'player-config', {
            label: 'Flash media',
            sourceAudit: [{ strategy: 'flash-embed', source: 'flashvars-attr', url, selected: true, fieldPath: k }],
          }, resolveUrl);
        }
      } catch { /* malformed */ }
    }
    // Also check src attribute for direct media
    const embedSrc = attr(tag, 'src') ?? '';
    if (embedSrc && DIRECT_EXT_RE.test(embedSrc) && !/\.swf(?:[?#]|$)/i.test(embedSrc)) {
      pushCandidate(out, seen, embedSrc, pageUrl, 'player-config', {
        label: 'Flash media',
        sourceAudit: [{ strategy: 'flash-embed', source: 'src-attr', url: cleanCandidateUrl(embedSrc, resolveUrl), selected: true, fieldPath: 'src' }],
      }, resolveUrl);
    }
  }
}

// ── Kaltura player embed scanner ─────────────────────────────────────────────
// kWidget.embed({ wid: "_1234567", entry_id: "1_abc12345" }) → HLS manifest URL

const KALTURA_CDN = 'https://cdnapisec.kaltura.com';

function scanKalturaEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let script: RegExpExecArray | null;
  while ((script = scriptRe.exec(html)) !== null && out.length < 180) {
    const text = script[1];
    if (!/(?:kWidget|KalturaPlayer|kaltura_player|kaltura-player|Kaltura\.Player)/i.test(text)) continue;
    const widM = /["']?wid["']?\s*:\s*["']?_?(\d{5,10})["']?/i.exec(text)
      ?? /["']?partner_?[Ii]d["']?\s*:\s*["']?(\d{5,10})["']?/.exec(text);
    const entryM = /["']?entry_id["']?\s*:\s*["']([01]_[A-Za-z0-9]{6,16})["']?/i.exec(text)
      ?? /["']?entryId["']?\s*:\s*["']([01]_[A-Za-z0-9]{6,16})["']?/i.exec(text);
    if (!widM || !entryM) continue;
    const partnerId = widM[1];
    const entryId = entryM[1];
    const hlsUrl = `${KALTURA_CDN}/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/applehttp/protocol/https/manifest.m3u8`;
    pushCandidate(out, seen, hlsUrl, pageUrl, 'player-config', {
      label: 'Kaltura HLS',
      confidence: 0.82,
      provenance: 'player-sdk-hook',
      sourceAudit: [{
        strategy: 'kaltura-embed',
        source: 'kwidget-embed',
        url: hlsUrl,
        selected: true,
        fieldPath: `entryId=${entryId}`,
      }],
    });
  }
}

// ── AMP social embed component scanner ───────────────────────────────────────
// AMP pages replace <iframe> with custom elements: <amp-youtube data-videoid="...">,
// <amp-vimeo data-videoid="...">, etc. We reconstruct the canonical embed URL
// and mark it forceServerDownload so the extraction pipeline processes it normally.

function scanAmpEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  // amp-video-iframe: generic AMP iframe wrapper — its src may point to any player
  const vifRe = /<amp-video-iframe\b[^>]*>/gi;
  let vifMatch: RegExpExecArray | null;
  while ((vifMatch = vifRe.exec(html)) !== null && out.length < 80) {
    const tag = vifMatch[0];
    const rawSrc = attr(tag, 'src');
    if (!rawSrc) continue;
    const url = cleanCandidateUrl(rawSrc, pageUrl);
    if (!url || seen.has(url) || !EMBED_IFRAME_RE.test(url)) continue;
    seen.add(url);
    out.push(makeItem(url, pageUrl, 'player-config', {
      mediaKind: 'video', label: 'AMP video iframe', confidence: 0.84,
      provenance: 'media-element', forceServerDownload: true,
      sourceAudit: [{ strategy: 'amp-embed', source: 'amp-tag', url, selected: true, fieldPath: 'amp-video-iframe' }],
    }));
  }

  const ampRe = /<(amp-youtube|amp-vimeo|amp-brightcove|amp-dailymotion|amp-soundcloud|amp-jwplayer)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = ampRe.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    const component = match[1].toLowerCase();
    let embedUrl: string | undefined;
    let label: string | undefined;
    let mediaKind: MediaKind = 'video';
    let fieldPath: string | undefined;

    if (component === 'amp-youtube') {
      const videoId = attr(tag, 'data-videoid');
      if (videoId) { embedUrl = `https://www.youtube.com/embed/${videoId}`; label = 'YouTube video'; fieldPath = `data-videoid=${videoId}`; }
    } else if (component === 'amp-vimeo') {
      const videoId = attr(tag, 'data-videoid');
      if (videoId) { embedUrl = `https://player.vimeo.com/video/${videoId}`; label = 'Vimeo video'; fieldPath = `data-videoid=${videoId}`; }
    } else if (component === 'amp-brightcove') {
      const account = attr(tag, 'data-account');
      const videoId = attr(tag, 'data-video-id') ?? attr(tag, 'data-videoid');
      if (account && videoId) { embedUrl = `https://players.brightcove.net/${account}/default_default/index.html?videoId=${videoId}`; label = 'Brightcove video'; fieldPath = `data-account=${account}`; }
    } else if (component === 'amp-dailymotion') {
      const videoId = attr(tag, 'data-videoid');
      if (videoId) { embedUrl = `https://www.dailymotion.com/embed/video/${videoId}`; label = 'Dailymotion video'; fieldPath = `data-videoid=${videoId}`; }
    } else if (component === 'amp-soundcloud') {
      const trackId = attr(tag, 'data-trackid');
      if (trackId) { embedUrl = `https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/${trackId}`; label = 'SoundCloud track'; mediaKind = 'audio'; fieldPath = `data-trackid=${trackId}`; }
    } else if (component === 'amp-jwplayer') {
      const mediaId = attr(tag, 'data-media-id') ?? attr(tag, 'data-playlist-id');
      const playerId = attr(tag, 'data-player-id');
      if (mediaId && playerId) { embedUrl = `https://content.jwplatform.com/players/${mediaId}-${playerId}.html`; label = 'JW Player video'; fieldPath = `data-media-id=${mediaId}`; }
    }

    if (!embedUrl || seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    out.push(makeItem(embedUrl, pageUrl, 'player-config', {
      mediaKind,
      label,
      confidence: 0.85,
      provenance: 'media-element',
      forceServerDownload: true,
      sourceAudit: [{ strategy: 'amp-embed', source: 'amp-tag', url: embedUrl, selected: true, fieldPath }],
    }));
  }
}

// ── Wistia div-based embed scanner ───────────────────────────────────────────
// Wistia embeds without an <iframe> use a div with class "wistia_async_[ID]".
// We reconstruct the standard iframe embed URL so the server extractor handles it.

function scanWistiaDivEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  // wistia_async_[ID] div embeds
  const re = /class\s*=\s*["'][^"']*\bwistia_async_([a-z0-9]+)\b[^"']*["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 80) {
    const videoId = match[1];
    const embedUrl = `https://fast.wistia.com/embed/iframe/${videoId}`;
    if (seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    out.push(makeItem(embedUrl, pageUrl, 'player-config', {
      mediaKind: 'video',
      label: 'Wistia video',
      confidence: 0.85,
      provenance: 'media-element',
      forceServerDownload: true,
      sourceAudit: [{ strategy: 'wistia-div', source: 'class-attr', url: embedUrl, selected: true, fieldPath: `wistia_async_${videoId}` }],
    }));
  }
  // <wistia-player media-id="ID"> custom element (Wistia v2 embed)
  const wpRe = /<wistia-player\b[^>]*\bmedia-id\s*=\s*["']([a-z0-9]+)["'][^>]*>/gi;
  while ((match = wpRe.exec(html)) !== null && out.length < 80) {
    const videoId = match[1];
    const embedUrl = `https://fast.wistia.com/embed/iframe/${videoId}`;
    if (seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    out.push(makeItem(embedUrl, pageUrl, 'player-config', {
      mediaKind: 'video',
      label: 'Wistia video',
      confidence: 0.85,
      provenance: 'media-element',
      forceServerDownload: true,
      sourceAudit: [{ strategy: 'wistia-player-element', source: 'media-id-attr', url: embedUrl, selected: true, fieldPath: `media-id=${videoId}` }],
    }));
  }
}

// ── Brightcove native Video.js div embed scanner ─────────────────────────────
// Brightcove embeds <video-js data-account="X" data-video-id="Y"> or
// <video class="video-js" data-account="X" data-video-id="Y">.
// Reconstruct the Brightcove player embed URL for server-side extraction.

function scanBrightcoveDivEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const re = /<(video-js|video|div)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    const account = attr(tag, 'data-account');
    if (!account) continue;
    const videoId = attr(tag, 'data-video-id') ?? attr(tag, 'data-videoid');
    if (!videoId) continue;
    const player = attr(tag, 'data-player') ?? 'default';
    const embed = attr(tag, 'data-embed') ?? 'default';
    const embedUrl = `https://players.brightcove.net/${account}/${player}_${embed}/index.html?videoId=${encodeURIComponent(videoId)}`;
    if (seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    out.push(makeItem(embedUrl, pageUrl, 'player-config', {
      mediaKind: 'video',
      label: 'Brightcove video',
      confidence: 0.86,
      provenance: 'media-element',
      forceServerDownload: true,
      sourceAudit: [{ strategy: 'brightcove-div', source: 'data-attr', url: embedUrl, selected: true, fieldPath: `data-account=${account}` }],
    }));
  }
}

// ── Vidyard div-based embed scanner ──────────────────────────────────────────
// Modern Vidyard uses <div class="vidyard-player-container" data-uuid="UUID">
// instead of an <iframe>. Also catches thumbnail img src patterns.

function scanVidyardEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  function tryAdd(uuid: string) {
    const embedUrl = `https://play.vidyard.com/${uuid}`;
    if (seen.has(embedUrl) || out.length >= 80) return;
    seen.add(embedUrl);
    out.push(makeItem(embedUrl, pageUrl, 'player-config', {
      mediaKind: 'video',
      label: 'Vidyard video',
      confidence: 0.82,
      provenance: 'media-element',
      forceServerDownload: true,
      sourceAudit: [{ strategy: 'vidyard-embed', source: 'vidyard-element', url: embedUrl, selected: true, fieldPath: `data-uuid=${uuid}` }],
    }));
  }
  // <div class="vidyard-player-container" data-uuid="UUID">
  const divRe = /class\s*=\s*["'][^"']*\bvidyard-player[^"']*["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = divRe.exec(html)) !== null && out.length < 80) {
    const uuid = attr(m[0], 'data-uuid');
    if (uuid && /^[0-9a-zA-Z-]{8,}$/.test(uuid)) tryAdd(uuid);
  }
  // <img src="https://play.vidyard.com/UUID.jpg"> thumbnail → strip extension
  const imgRe = /https?:\/\/play\.vidyard\.com\/([0-9a-zA-Z-]{8,})\.(?:jpg|png|gif)/gi;
  let imgM: RegExpExecArray | null;
  while ((imgM = imgRe.exec(html)) !== null && out.length < 80) tryAdd(imgM[1]);
}

// ── Generic div-based embed scanner ──────────────────────────────────────────
// Many CMS/player integrations use <div data-src="EMBED_URL"> instead of iframes.
// Also handles data-vimeo-id, data-youtube-id, data-dailymotion-id on any element.

function scanDivEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  // 1. data-src / data-url / data-embed-src whose values match EMBED_IFRAME_RE
  const divRe = /<(?:div|section|figure|article)\b[^>]*\sdata-(?:src|url|embed(?:-src)?)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = divRe.exec(html)) !== null && out.length < 80) {
    const rawUrl = m[1];
    const url = cleanCandidateUrl(rawUrl, pageUrl);
    if (!url || seen.has(url) || !EMBED_IFRAME_RE.test(url)) continue;
    seen.add(url);
    out.push(makeItem(url, pageUrl, 'player-config', {
      mediaKind: 'video', label: 'Embedded video', confidence: 0.80,
      provenance: 'page-global', forceServerDownload: true,
      sourceAudit: [{ strategy: 'div-embed', source: 'data-attr', url, selected: true }],
    }));
  }
  // 2. data-vimeo-id, data-youtube-id, data-dailymotion-id on any tag
  const idRe = /<[a-zA-Z][^>]*\sdata-(?:vimeo-id|youtube-id|yt-id|dailymotion-id|dm-id|dm-video-id)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = idRe.exec(html)) !== null && out.length < 80) {
    const tag = m[0];
    const vimeoId = attr(tag, 'data-vimeo-id');
    const ytId = attr(tag, 'data-youtube-id') ?? attr(tag, 'data-yt-id');
    const dmId = attr(tag, 'data-dailymotion-id') ?? attr(tag, 'data-dm-id') ?? attr(tag, 'data-dm-video-id');
    const tryPlatform = (embedUrl: string, label: string) => {
      if (seen.has(embedUrl) || out.length >= 80) return;
      seen.add(embedUrl);
      out.push(makeItem(embedUrl, pageUrl, 'player-config', {
        mediaKind: 'video', label, confidence: 0.85, provenance: 'media-element',
        forceServerDownload: true,
        sourceAudit: [{ strategy: 'div-embed', source: 'data-id-attr', url: embedUrl, selected: true }],
      }));
    };
    if (vimeoId) tryPlatform(`https://player.vimeo.com/video/${vimeoId}`, 'Vimeo video');
    if (ytId) tryPlatform(`https://www.youtube.com/embed/${ytId}`, 'YouTube video');
    if (dmId) tryPlatform(`https://www.dailymotion.com/embed/video/${dmId}`, 'Dailymotion video');
  }
}

// ── Mux <mux-video> / <mux-audio> / <mux-player> custom elements ─────────────
// Mux uses playback-id attribute on its custom HTML elements.
// Reconstruct the Mux CDN HLS URL from the playback ID.

function scanMuxEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const re = /<mux-(?:video|audio|player)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    const tagName = match[0].slice(1, match[0].indexOf(' ') > -1 ? match[0].indexOf(' ') : match[0].indexOf('>')).toLowerCase();
    const isAudio = tagName === 'mux-audio';
    const playbackId = attr(tag, 'playback-id') ?? attr(tag, 'data-playback-id');
    if (playbackId && /^[a-zA-Z0-9]{8,}$/.test(playbackId)) {
      const url = `https://stream.mux.com/${playbackId}.m3u8`;
      if (!seen.has(url)) {
        seen.add(url);
        out.push(makeItem(url, pageUrl, 'player-config', {
          mediaKind: isAudio ? 'audio' : 'video',
          mimeType: 'application/vnd.apple.mpegurl',
          label: 'Mux video',
          confidence: 0.88,
          provenance: 'media-element',
          sourceAudit: [{ strategy: 'mux-element', source: 'custom-element', url, selected: true, fieldPath: `playback-id=${playbackId}` }],
        }));
      }
    }
    // Also handle src attribute pointing directly to a Mux CDN URL
    const src = attr(tag, 'src');
    if (src) pushCandidate(out, seen, src, pageUrl, 'media-element', { mediaKind: isAudio ? 'audio' : 'video', mimeType: 'application/vnd.apple.mpegurl' });
  }
}

// ── Cloudflare Stream <stream> custom element ────────────────────────────────
// Cloudflare Stream uses <stream src="VIDEO_ID" controls> which renders as an
// iframe. We reconstruct the canonical iframe embed URL so the server extractor
// can handle it via run_extraction.

function scanCloudflareStreamElements(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const re = /<stream\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    const videoId = attr(tag, 'src');
    if (!videoId || !/^[a-f0-9]{32}$/i.test(videoId)) continue;
    const embedUrl = `https://iframe.cloudflarestream.com/${videoId}`;
    if (seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    out.push(makeItem(embedUrl, pageUrl, 'player-config', {
      mediaKind: 'video',
      label: 'Cloudflare Stream video',
      confidence: 0.87,
      provenance: 'media-element',
      forceServerDownload: true,
      sourceAudit: [{ strategy: 'cf-stream-element', source: 'custom-element', url: embedUrl, selected: true, fieldPath: `src=${videoId}` }],
    }));
  }
}

// ── Plyr embed elements ──────────────────────────────────────────────────────
// Plyr wraps YouTube/Vimeo via data-plyr-provider + data-plyr-id, or points
// to a direct HTML5 file via data-plyr-src.

function scanPlyrEmbeds(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const re = /<[a-z][a-z0-9-]*\b[^>]*\bdata-plyr(?:-provider|-id|-embed-id|-src)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 80) {
    const tag = match[0];
    const provider = (attr(tag, 'data-plyr-provider') ?? '').toLowerCase();
    const id = attr(tag, 'data-plyr-id') ?? attr(tag, 'data-plyr-embed-id');
    const src = attr(tag, 'data-plyr-src');
    if (provider === 'youtube' && id) {
      const embedUrl = `https://www.youtube.com/embed/${id}`;
      if (!seen.has(embedUrl)) {
        seen.add(embedUrl);
        out.push(makeItem(embedUrl, pageUrl, 'player-config', {
          mediaKind: 'video', label: 'Plyr/YouTube video', confidence: 0.85,
          provenance: 'page-global', forceServerDownload: true,
          sourceAudit: [{ strategy: 'plyr-embed', source: 'data-plyr', url: embedUrl, selected: true, fieldPath: `provider=youtube&id=${id}` }],
        }));
      }
    } else if (provider === 'vimeo' && id) {
      const embedUrl = `https://player.vimeo.com/video/${id}`;
      if (!seen.has(embedUrl)) {
        seen.add(embedUrl);
        out.push(makeItem(embedUrl, pageUrl, 'player-config', {
          mediaKind: 'video', label: 'Plyr/Vimeo video', confidence: 0.85,
          provenance: 'page-global', forceServerDownload: true,
          sourceAudit: [{ strategy: 'plyr-embed', source: 'data-plyr', url: embedUrl, selected: true, fieldPath: `provider=vimeo&id=${id}` }],
        }));
      }
    } else if (src) {
      pushCandidate(out, seen, src, pageUrl, 'player-config', { mediaKind: 'video', confidence: 0.82 });
    }
  }
}

// ── JSON Feed 1.0 / 1.1 scanner ──────────────────────────────────────────────

function scanJsonFeed(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const trimmed = html.trimStart();
  if (!trimmed.startsWith('{')) return;
  let data: Record<string, unknown>;
  try { data = JSON.parse(html) as Record<string, unknown>; } catch { return; }
  if (!data || typeof data !== 'object') return;
  const version = String(data.version ?? '');
  const items = data.items;
  if (!version.includes('jsonfeed.org') && !Array.isArray(items)) return;
  if (!Array.isArray(items)) return;
  const feedTitle = String(data.title ?? '');
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const title = String(rec.title ?? rec.summary ?? feedTitle);
    const attachments = Array.isArray(rec.attachments) ? rec.attachments : [];
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue;
      const a = att as Record<string, unknown>;
      const mime = String(a.mime_type ?? '');
      const rawUrl = String(a.url ?? '');
      if (!rawUrl.startsWith('http')) continue;
      const mLower = mime.toLowerCase();
      if (!mLower.startsWith('audio/') && !mLower.startsWith('video/')) continue;
      pushCandidate(out, seen, rawUrl, pageUrl, 'feed-enclosure', {
        mimeType: mime || undefined,
        mediaKind: mLower.startsWith('audio/') ? 'audio' : 'video',
        label: title || undefined,
        confidence: 0.88,
        provenance: 'page-global',
      });
    }
    // Some non-standard JSON Feeds put the media URL directly in external_url/url
    // instead of attachments. Only accept it if it actually has a direct AV extension.
    const extUrl = String(rec.external_url ?? rec.url ?? '');
    if (extUrl.startsWith('http') && /\.(?:mp3|m4a|ogg|opus|flac|wav|mp4|webm|mov)(?:[?#]|$)/i.test(extUrl)) {
      pushCandidate(out, seen, extUrl, pageUrl, 'feed-enclosure', {
        mediaKind: feedMediaKind('', extUrl),
        label: title || undefined,
        confidence: 0.88,
        provenance: 'page-global',
      });
    }
    if (out.length >= 120) break;
  }
}

// ── RSS 2.0 / Atom 1.0 / Media RSS feed scanner ────────────────────────────

const FEED_MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/x-mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv',
};

function feedMimeExt(mime: string, url: string): string {
  const lower = mime.toLowerCase();
  if (FEED_MIME_EXT[lower]) return FEED_MIME_EXT[lower];
  const m = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : lower.startsWith('audio/') ? 'm4a' : 'mp4';
}

function feedMediaKind(mime: string, url: string): MediaKind {
  const lower = mime.toLowerCase();
  if (lower.startsWith('audio/') || /\.(mp3|m4a|ogg|opus|flac|wav)(?:[?#]|$)/i.test(url)) return 'audio';
  return 'video';
}

function cdata(s: string): string {
  const m = s.match(/^<!\[CDATA\[([\s\S]*?)]]>$/);
  return (m ? m[1] : s).trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function xmlTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? cdata(m[1]) : '';
}

function scanFeedContent(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  if (!/^\s*<\?xml\b|<rss\b|<feed\b|<rdf:RDF\b/i.test(html.slice(0, 800))) return;

  const baseCount = out.length;

  function tryAdd(rawUrl: string | undefined, mime: string, title: string, thumbUrl?: string): void {
    if (!rawUrl) return;
    const url = cleanCandidateUrl(rawUrl, pageUrl);
    if (!url || seen.has(url)) return;
    const mLower = mime.toLowerCase();
    const isAV = mLower.startsWith('audio/') || mLower.startsWith('video/');
    const hasExt = /\.(mp3|m4a|ogg|opus|flac|wav|mp4|webm|mov|ogv)(?:[?#]|$)/i.test(url);
    if (!isAV && !hasExt) return;
    seen.add(url);
    out.push(makeItem(url, pageUrl, 'feed-enclosure', {
      mimeType: mime || undefined,
      mediaKind: feedMediaKind(mime, url),
      label: title || undefined,
      confidence: 0.88,
      provenance: 'page-global',
      thumbnailUrl: thumbUrl ? (cleanCandidateUrl(thumbUrl, pageUrl) ?? undefined) : undefined,
      sourceAudit: [{ strategy: 'feed-scanner', source: 'feed-enclosure', url, selected: true, mimeType: mime || undefined }],
    }));
  }

  // ── RSS 2.0 / Podcast: <item> blocks ─────────────────────────────────────
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let itemM: RegExpExecArray | null;
  while ((itemM = itemRe.exec(html)) !== null && out.length < 120) {
    const block = itemM[1];
    const title = xmlTag(block, 'title');
    const thumbM = block.match(/<itunes:image\b[^>]*\/?>/i) ?? block.match(/<media:thumbnail\b[^>]*\/?>/i);
    const thumb = thumbM ? (attr(thumbM[0], 'href') ?? attr(thumbM[0], 'url')) : undefined;
    // <enclosure url="..." type="..."/>
    const encM = block.match(/<enclosure\b[^>]*\/?>/i);
    if (encM) tryAdd(attr(encM[0], 'url'), attr(encM[0], 'type') ?? '', title, thumb);
    // <media:content> — may be inside <media:group>
    const mcBlock = block.match(/<media:group\b[^>]*>([\s\S]*?)<\/media:group>/i)?.[1] ?? block;
    const mcRe = /<media:content\b[^>]*\/?>/gi;
    let mcM: RegExpExecArray | null;
    while ((mcM = mcRe.exec(mcBlock)) !== null) {
      const medium = (attr(mcM[0], 'medium') ?? '').toLowerCase();
      const type = attr(mcM[0], 'type') ?? '';
      if (medium === 'audio' || medium === 'video' || type.startsWith('audio/') || type.startsWith('video/'))
        tryAdd(attr(mcM[0], 'url'), type, title, thumb);
    }
  }

  // ── Atom 1.0: <entry> blocks (only when no RSS items extracted) ───────────
  if (out.length === baseCount) {
    const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    let entryM: RegExpExecArray | null;
    while ((entryM = entryRe.exec(html)) !== null && out.length < 120) {
      const block = entryM[1];
      const title = xmlTag(block, 'title');
      const linkRe = /<link\b[^>]*\/?>/gi;
      let linkM: RegExpExecArray | null;
      while ((linkM = linkRe.exec(block)) !== null) {
        if ((attr(linkM[0], 'rel') ?? '').toLowerCase() === 'enclosure')
          tryAdd(attr(linkM[0], 'href'), attr(linkM[0], 'type') ?? '', title);
      }
      // <content type="video/..." src="...">
      const contentRe = /<content\b[^>]*>/gi;
      let contentM: RegExpExecArray | null;
      while ((contentM = contentRe.exec(block)) !== null) {
        const type = attr(contentM[0], 'type') ?? '';
        if (type.startsWith('audio/') || type.startsWith('video/'))
          tryAdd(attr(contentM[0], 'src'), type, title);
      }
    }
  }

  // Channel-level thumbnail as fallback for items that have none (most podcast
  // feeds only set artwork at the channel level, not per-episode).
  if (out.length > baseCount) {
    let channelThumb: string | undefined;
    const itunesChM = html.match(/<itunes:image\b[^>]*\/?>/i);
    if (itunesChM) channelThumb = attr(itunesChM[0], 'href');
    if (!channelThumb) {
      const imgBlockM = html.match(/<image\b[^>]*>([\s\S]*?)<\/image>/i);
      if (imgBlockM) channelThumb = xmlTag(imgBlockM[1], 'url') || undefined;
    }
    if (channelThumb) {
      const cleanedChannelThumb = cleanCandidateUrl(channelThumb, pageUrl) ?? undefined;
      if (cleanedChannelThumb) {
        for (let i = baseCount; i < out.length; i++) {
          if (!out[i].thumbnailUrl) out[i].thumbnailUrl = cleanedChannelThumb;
        }
      }
    }
  }
}

function scanGenericUrls(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>): void {
  const re = /https?:\\?\/\\?\/[^"'<>\s)]+?(?:\.m3u8?[^"'<>\s)]*|\.mpd[^"'<>\s)]*|\.(?:mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#][^"'<>\s)]*)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && out.length < 120) {
    pushCandidate(out, seen, match[0], pageUrl, 'generic-url');
  }
}

function playerMimeFor(key: string, url: string, nearby = ''): string | undefined {
  if (SMOOTH_RE.test(url)) return 'application/vnd.ms-sstr+xml';
  if (DASH_RE.test(url) || /\.mpd(?:[?#]|$)/i.test(url)) return 'application/dash+xml';
  if (HLS_RE.test(url) || /\.m3u8?(?:[?#]|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
  if (/\.(?:mp4|m4v|mov)(?:[?#]|$)/i.test(url)) return 'video/mp4';
  if (/\.webm(?:[?#]|$)/i.test(url)) return 'video/webm';
  if (AUDIO_EXT_RE.test(url)) return 'audio/mp4';
  if (IMAGE_EXT_RE.test(url)) return 'image/jpeg';
  if (/^(?:dash_url|dashUrl|mpd_url|mpdUrl)$/i.test(key)) return 'application/dash+xml';
  if (/^(?:hls_url|hlsUrl|m3u8_url|m3u8Url|manifest_url|manifestUrl|master_url|masterUrl)$/i.test(key)) return 'application/vnd.apple.mpegurl';
  if (/^(?:flv_url|flvUrl)$/i.test(key)) return 'video/x-flv';
  if (/^(?:audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl)$/i.test(key)) return 'audio/mpeg';
  if (/^(?:live_url|liveUrl|live_stream_url|liveStreamUrl)$/i.test(key)) return 'video/mp4';
  if (/^(?:mp4_url|mp4Url|video_url|videoUrl|playable_url|playableUrl|hd_src|hdSrc|sd_src|sdSrc|stream_url|streamUrl|media_url|mediaUrl|contentUrl|contentURL|download_url|downloadUrl|play_url|playUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl)$/i.test(key)) return 'video/mp4';
  const explicitType = nearby.match(/\b(?:type|mimeType|contentType)\s*:\s*["']([^"']+)["']/i)?.[1];
  if (/dash/i.test(explicitType || '')) return 'application/dash+xml';
  if (/mpegurl|m3u8|hls/i.test(explicitType || '')) return 'application/vnd.apple.mpegurl';
  if (/video\/webm/i.test(explicitType || '')) return 'video/webm';
  if (/video\//i.test(explicitType || '')) return 'video/mp4';
  if (/audio\//i.test(explicitType || '')) return 'audio/mp4';
  if (/image\//i.test(explicitType || '')) return 'image/jpeg';
  const signal = `${key} ${url} ${nearby}`.toLowerCase();
  if (/dash|mpd/.test(signal)) return 'application/dash+xml';
  if (/hls|m3u8|mpegurl/.test(signal)) return 'application/vnd.apple.mpegurl';
  if (/mp4|video/.test(signal)) return 'video/mp4';
  if (/webm/.test(signal)) return 'video/webm';
  if (/m4a|aac|audio/.test(signal)) return 'audio/mp4';
  if (/jpe?g|png|webp|image|thumbnail|poster|cover/.test(signal)) return 'image/jpeg';
  return undefined;
}

function isStrongPlayerConfigUrl(key: string, rawUrl: string, mimeType?: string): boolean {
  const url = rawUrl.toLowerCase();
  if (DIRECT_EXT_RE.test(url) || HLS_RE.test(`${url} ${mimeType || ''}`) || DASH_RE.test(`${url} ${mimeType || ''}`) || SMOOTH_RE.test(`${url} ${mimeType || ''}`)) return true;
  if (/(?:googlevideo\.com\/videoplayback|video\.twimg\.com|cdninstagram\.com|threadscdn\.com|jwpcdn\.com|jwplatform\.com|kaltura\.com|mux\.com|mux\.dev|akamaized\.net|cloudfront\.net|bilivideo\.com|weibocdn\.com|xhscdn\.com|vimeocdn\.com|fastly\.net\/[^"'\s]+\.(?:mp4|m3u8|mpd)|res\.cloudinary\.com|[^"'\s]+\.b-cdn\.net|[^"'\s]+\.bunnycdn\.com)/i.test(url)) return true;
  const urlLike = /^(?:https?:\\?\/\\?\/|\/\/|\/|\.{1,2}\/)/i.test(rawUrl);
  return urlLike && /^(?:file|src|source|stream|stream_url|streamUrl|media_url|mediaUrl|video_url|videoUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|play_url|playUrl|download_url|downloadUrl|hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|mp4_url|mp4Url|flv_url|flvUrl|m3u8_url|m3u8Url|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|hd_src|hdSrc|sd_src|sdSrc|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl|contentUrl|contentURL)$/i.test(key) && !!mimeType && /^(?:video|audio|image|application\/(?:dash|vnd\.apple\.mpegurl|x-mpegurl|vnd\.ms-sstr\+xml))/i.test(mimeType);
}

function scanPlayerConfigs(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  const fieldRe = /["']?\b(file|src|source|stream|stream_url|streamUrl|media_url|mediaUrl|video_url|videoUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|play_url|playUrl|download_url|downloadUrl|hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|mp4_url|mp4Url|flv_url|flvUrl|m3u8_url|m3u8Url|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|hd_src|hdSrc|sd_src|sdSrc|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl|contentUrl|contentURL|image_url|imageUrl|thumbnail_url|thumbnailUrl|poster|cover|url)\b["']?\s*:\s*["']([^"'\\\s<>]{1,1000})["']/gi;
  let script: RegExpExecArray | null;
  while ((script = scriptRe.exec(html)) !== null && out.length < 160) {
    // Skip pure-JSON data blobs (Next.js __NEXT_DATA__, JSON feeds, ld+json) —
    // those are handled by scanHydrationData / scanJsonLd with correct provenance.
    if (/type\s*=\s*["']application\/(?:json|ld\+json|feed\+json)["']/i.test(script[0].slice(0, 200))) continue;
    // text/x-player-data is the synthetic type set by scanJsonDataAttributes for confirmed
    // player config blobs — skip the content guard because the attr name already confirms it.
    const isConfirmedPlayerData = /type\s*=\s*["']text\/x-player-data["']/i.test(script[0].slice(0, 200));
    const text = decodeHtml(script[1])
      .replace(/\\u002F/gi, '/')
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/');
    if (!isConfirmedPlayerData && !/(?:jwplayer|videojs|brightcove|kaltura|bitmovin|flowplayer|clappr|wistia|vidyard|sources|playlist|hls|m3u8|dash|stream|video_url|audio_url|audioUrl|mp3_url|podcast_url|enclosure_url|file_url|fileUrl|episode_url|recording_url|live_url|liveUrl|media_url|manifest_url|master_url|playback_url|videoConfig|playerConfig|file\s*:|window\.\w+(?:Video|Player|Media|Config|Data|Setup)\b)/i.test(text)) continue;
    let match: RegExpExecArray | null;
    while ((match = fieldRe.exec(text)) !== null && out.length < 160) {
      const key = match[1];
      const rawUrl = match[2];
      const nearby = `${text.slice(match.index, Math.min(text.length, match.index + 260))} ${text.slice(Math.max(0, match.index - 140), match.index)}`;
      const mimeType = playerMimeFor(key, rawUrl, nearby);
      if (!isStrongPlayerConfigUrl(key, rawUrl, mimeType)) continue;
      pushCandidate(out, seen, rawUrl, pageUrl, 'player-config', {
        mimeType,
        label: 'Player source',
        sourceAudit: [{
          strategy: 'embedded-player-config',
          source: 'script-config',
          url: cleanCandidateUrl(rawUrl, resolveUrl),
          selected: true,
          fieldPath: key,
          mimeType,
        }],
      }, resolveUrl);
    }
  }
}

function isHydrationScript(tag: string, text: string): boolean {
  return (
    /\bid\s*=\s*["'](?:__NEXT_DATA__|__NUXT_DATA__|__APOLLO_STATE__|__INITIAL_STATE__|__INITIAL_DATA__|app-data|__SVELTE__|__sveltekit_data|__astro_manifest__)["']/i.test(tag) ||
    /\btype\s*=\s*["']application\/(?:json|ld\+json)["']/i.test(tag) ||
    /(?:window\.)?(?:__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__INITIAL_DATA__|__APOLLO_STATE__|__remixContext|__ROUTER_DATA__|__PRELOADED_STATE__|__APP_STATE__|__STORE__|__REDUX_STATE__|__SERVER_DATA__|__SVELTE_DATA__|__MEDIA_DATA__|__VIDEO_DATA__|__VIDEO_CONFIG__|__PLAYER_CONFIG__|__MEDIA_CONFIG__|__APP_CONFIG__|__SITE_CONFIG__|__PAGE_CONFIG__|__PAGE_DATA__|__INITIAL_PROPS__|__BC_PLAYER_CONFIG__|initialState|initialData|pageData|siteData|videoData|playerData|videoConfig|playerConfig|mediaConfig|mediaData|appConfig|siteConfig|pageConfig|initialProps|wp_playlist|BCL)\s*[=:]/i.test(text)
  );
}

function hydrationMimeFor(key: string, url: string, nearby = ''): string | undefined {
  if (/^(?:hls_url|hlsUrl|m3u8_url|m3u8Url|manifest_url|manifestUrl|master_url|masterUrl)$/i.test(key)) return 'application/vnd.apple.mpegurl';
  if (/^(?:dash_url|dashUrl|mpd_url|mpdUrl)$/i.test(key)) return 'application/dash+xml';
  if (/^(?:flv_url|flvUrl)$/i.test(key)) return 'video/x-flv';
  if (/^(?:audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl)$/i.test(key)) return 'audio/mpeg';
  if (/^(?:live_url|liveUrl|live_stream_url|liveStreamUrl)$/i.test(key)) return 'video/mp4';
  if (/^(?:mp4_url|mp4Url|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl)$/i.test(key)) return 'video/mp4';
  if (/^(?:video_url|videoUrl|playable_url|playableUrl|browser_native_hd_url|browserNativeHdUrl|hd_src|hdSrc|sd_src|sdSrc|stream_url|streamUrl|media_url|mediaUrl|contentUrl|contentURL|download_url|downloadUrl|play_url|playUrl|playback_url|playbackUrl)$/i.test(key) && DIRECT_EXT_RE.test(url)) {
    return mediaKindFromUrl(url) === 'audio' ? 'audio/mp4' : 'video/mp4';
  }
  if (/^(?:image_url|imageUrl|photo_url|photoUrl|thumbnail_url|thumbnailUrl|cover_url|coverUrl|poster|original_url|originalUrl|src_url|srcUrl)$/i.test(key)) return 'image/jpeg';
  if (/^(?:subtitle_url|subtitleUrl|vtt_url|vttUrl|caption_url|captionUrl|track_url|trackUrl|transcript_url|transcriptUrl)$/i.test(key)) return 'text/vtt';
  if (/^(?:srt_url|srtUrl)$/i.test(key)) return 'application/x-subrip';
  const signal = `${key} ${url} ${nearby}`.toLowerCase();
  if (/(?:dash|mpd|application\/dash\+xml)/.test(signal)) return 'application/dash+xml';
  if (/(?:hls|m3u8|mpegurl|application\/vnd\.apple\.mpegurl|application\/x-mpegurl)/.test(signal)) return 'application/vnd.apple.mpegurl';
  if (/(?:mp4|video\/mp4|browser_native_hd_url|hd_src|sd_src|video_url|playable_url)/.test(signal)) return 'video/mp4';
  if (/(?:webm|video\/webm)/.test(signal)) return 'video/webm';
  if (/(?:audio|m4a|aac|mp3|audio\/)/.test(signal)) return 'audio/mp4';
  if (/(?:image|photo|thumbnail|cover|poster|jpe?g|png|webp)/.test(signal)) return 'image/jpeg';
  return undefined;
}

function isStrongHydrationUrl(key: string, rawUrl: string, mimeType?: string): boolean {
  const signal = `${rawUrl} ${mimeType || ''}`.toLowerCase();
  if (DIRECT_EXT_RE.test(signal) || HLS_RE.test(signal) || DASH_RE.test(signal) || SMOOTH_RE.test(signal)) return true;
  const urlLike = /^(?:https?:\\?\/\\?\/|\/\/|\/|\.{1,2}\/)/i.test(rawUrl);
  if (/^(?:hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|m3u8_url|m3u8Url|mp4_url|mp4Url|flv_url|flvUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|video_url|videoUrl|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|browser_native_hd_url|browserNativeHdUrl|hd_src|hdSrc|sd_src|sdSrc|stream_url|streamUrl|media_url|mediaUrl|contentUrl|contentURL|download_url|downloadUrl|play_url|playUrl|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl)$/i.test(key)) {
    return urlLike && !!mimeType && /^(?:video|audio|application\/(?:dash|vnd\.apple\.mpegurl|x-mpegurl|vnd\.ms-sstr\+xml))/i.test(mimeType);
  }
  if (/^(?:image_url|imageUrl|photo_url|photoUrl|thumbnail_url|thumbnailUrl|cover_url|coverUrl|poster|original_url|originalUrl|src_url|srcUrl)$/i.test(key)) {
    return urlLike && !!mimeType && /^image\//i.test(mimeType);
  }
  if (/^(?:subtitle_url|subtitleUrl|vtt_url|vttUrl|srt_url|srtUrl|caption_url|captionUrl|track_url|trackUrl|transcript_url|transcriptUrl)$/i.test(key)) {
    return urlLike && (
      (!!mimeType && /^(?:text\/vtt|application\/x-subrip|text\/plain)$/i.test(mimeType))
      || /\.(?:vtt|webvtt|srt|ass|ssa|sub|sbv|dfxp|ttml)(?:[?#]|$)/i.test(rawUrl)
    );
  }
  return false;
}

function scanHydrationData(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const fieldRe = /["']?(hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|m3u8_url|m3u8Url|mp4_url|mp4Url|flv_url|flvUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|video_url|videoUrl|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|browser_native_hd_url|browserNativeHdUrl|hd_src|hdSrc|sd_src|sdSrc|stream_url|streamUrl|media_url|mediaUrl|contentUrl|contentURL|download_url|downloadUrl|play_url|playUrl|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl|image_url|imageUrl|photo_url|photoUrl|thumbnail_url|thumbnailUrl|cover_url|coverUrl|poster|original_url|originalUrl|src_url|srcUrl|subtitle_url|subtitleUrl|vtt_url|vttUrl|srt_url|srtUrl|caption_url|captionUrl|track_url|trackUrl|transcript_url|transcriptUrl)["']?\s*:\s*["']([^"'\\\s<>]{1,1000})["']/gi;
  let script: RegExpExecArray | null;
  while ((script = scriptRe.exec(html)) !== null && out.length < 180) {
    const tagAttrs = script[1] ?? '';
    const text = decodeHtml(script[2])
      .replace(/\\u002F/gi, '/')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=')
      .replace(/\\\//g, '/');
    if (!isHydrationScript(tagAttrs, text)) continue;
    let match: RegExpExecArray | null;
    while ((match = fieldRe.exec(text)) !== null && out.length < 180) {
      const key = match[1];
      const rawUrl = match[2];
      const nearby = text.slice(Math.max(0, match.index - 200), Math.min(text.length, match.index + 320));
      const mimeType = hydrationMimeFor(key, rawUrl, nearby);
      if (!isStrongHydrationUrl(key, rawUrl, mimeType)) continue;
      pushCandidate(out, seen, rawUrl, pageUrl, 'hydration-data', {
        mimeType,
        label: 'Page data source',
        sourceAudit: [{
          strategy: 'page-hydration-data',
          source: 'script-json',
          url: cleanCandidateUrl(rawUrl, resolveUrl),
          selected: true,
          fieldPath: key,
          mimeType,
        }],
      }, resolveUrl);
    }
  }
}

function safeJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(decodeHtml(text).trim());
  } catch {
    return undefined;
  }
}

function scanJsonLd(html: string, pageUrl: string, out: DetectedMedia[], seen: Set<string>, resolveUrl = pageUrl): void {
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const parsed = safeJsonParse(match[1]);
    if (parsed) walkStructuredData(parsed, pageUrl, out, seen, undefined, resolveUrl);
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstString(record.url ?? record.contentUrl ?? record.contentURL);
  }
  return undefined;
}

function structuredDimension(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value && typeof value === 'object') {
    const num = (value as Record<string, unknown>).value;
    if (typeof num === 'number') return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function walkStructuredData(value: unknown, pageUrl: string, out: DetectedMedia[], seen: Set<string>, inheritedKind?: MediaKind, resolveUrl = pageUrl): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walkStructuredData(item, pageUrl, out, seen, inheritedKind, resolveUrl));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const typeText = asArray(record['@type'] ?? record.type).join(' ').toLowerCase();
  const kind: MediaKind | undefined =
    /videoobject|movie|tvepisode|clip|broadcastevent|musicvideo(?:object)?|liveblogposting/.test(typeText) ? 'video'
    : /audioobject|musicrecording|podcastepisode|radioepisode|musicrelease|audiobook/.test(typeText) ? 'audio'
    : /imageobject|photograph/.test(typeText) ? 'image'
    : inheritedKind;

  if (kind) {
    const url = firstString(record.contentUrl ?? record.contentURL ?? record.downloadUrl ?? record.embedUrl ?? (kind !== inheritedKind ? record.url : undefined));
    pushCandidate(out, seen, url, pageUrl, 'json-ld', {
      mediaKind: kind,
      label: typeof record.name === 'string' ? record.name.slice(0, 120) : undefined,
      thumbnailUrl: firstString(record.thumbnailUrl ?? record.thumbnail),
      duration: parseIsoDuration(record.duration),
      width: structuredDimension(record.width),
      height: structuredDimension(record.height),
    }, resolveUrl);
  }

  for (const key of ['@graph', 'video', 'audio', 'image', 'associatedMedia', 'encoding', 'encodings', 'thumbnail',
                      'hasPart', 'mainEntity', 'mediaObject', 'subjectOf', 'workExample',
                      'itemListElement', 'item',
                      'items', 'results', 'data', 'entries', 'list', 'tracks', 'videos', 'audios', 'content', 'clips']) {
    if (key in record) walkStructuredData(record[key], pageUrl, out, seen, kind, resolveUrl);
  }
}

export function probeUniversalMedia(input: UniversalProbeInput): DetectedMedia[] {
  const out: DetectedMedia[] = [];
  const seen = new Set<string>();
  const pageUrl = input.pageUrl;

  for (const hint of input.mediaHints ?? []) {
    const rawUrl = hintString(hint, 'url') ?? hintString(hint, 'src');
    const cleanUrl = rawUrl ? cleanCandidateUrl(rawUrl, pageUrl) : undefined;
    const mimeType = hintString(hint, 'mimeType');
    pushCandidate(out, seen, rawUrl, pageUrl, 'hint', {
      mimeType,
      mediaType: cleanUrl ? hintMediaType(hint, cleanUrl, mimeType) : undefined,
      mediaKind: cleanUrl ? hintMediaKind(hint, cleanUrl, mimeType) : undefined,
      label: hintString(hint, 'label') ?? hintString(hint, 'title') ?? hintString(hint, 'source'),
      width: hintNumber(hint, 'width'),
      height: hintNumber(hint, 'height'),
      userAgent: input.userAgent,
      confidence: hintNumber(hint, 'confidence') ?? undefined,
      provenance: hintProvenance(hint),
      sourceAudit: cleanUrl ? [{
        strategy: 'browser-session-hint',
        source: hintString(hint, 'source') ?? hintString(hint, 'provenance') ?? 'media-hint',
        url: cleanUrl,
        selected: true,
        mimeType,
        status: hintNumber(hint, 'status'),
        contentLength: hintNumber(hint, 'contentLength') ?? hintNumber(hint, 'encodedBodySize') ?? hintNumber(hint, 'transferSize'),
        notes: hintString(hint, 'method'),
      }] : undefined,
    });
  }

  const html = input.pageHtml ?? '';
  if (html) {
    // JSON Feed 1.0/1.1 is a JSON object; short-circuit HTML scanners when found.
    const beforeJsonFeed = out.length;
    scanJsonFeed(html, pageUrl, out, seen);
    if (out.length > beforeJsonFeed) {
      return out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    }

    // RSS / Atom / Media RSS: structurally different from HTML.
    // Short-circuit HTML scanners when feed items are found.
    const beforeFeedContent = out.length;
    scanFeedContent(html, pageUrl, out, seen);
    if (out.length > beforeFeedContent) {
      return out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    }

    const resolveUrl = baseUrlFromHtml(html, pageUrl);
    // Expand <noscript> blocks: lazy-load sites put the real <img src> inside
    // <noscript> and JS replaces it with a data-src placeholder at runtime.
    const noscriptExpanded = html.replace(
      /<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi,
      (_, inner: string) => inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
    );
    const htmlWithNoscript = noscriptExpanded !== html ? `${html}\n${noscriptExpanded}` : html;
    scanMediaElements(htmlWithNoscript, pageUrl, out, seen, resolveUrl);
    scanBgVideoAttrs(htmlWithNoscript, pageUrl, out, seen, resolveUrl);
    scanTemplateScripts(html, pageUrl, out, seen, resolveUrl);
    scanTemplateElements(html, pageUrl, out, seen, resolveUrl);
    scanWordPressBlocks(html, pageUrl, out, seen, resolveUrl);
    scanCustomMediaElements(html, pageUrl, out, seen, resolveUrl);
    scanDataAttributes(html, pageUrl, out, seen, resolveUrl);
    scanCssBackgroundImages(html, pageUrl, out, seen, resolveUrl);
    scanResourceLinks(html, pageUrl, out, seen, resolveUrl);
    scanPodcastFeedLinks(html, pageUrl, out, seen);
    scanMeta(html, pageUrl, out, seen, resolveUrl);
    scanMicrodataMedia(html, pageUrl, out, seen, resolveUrl);
    scanJsonLd(html, pageUrl, out, seen, resolveUrl);
    scanPlayerConfigs(html, pageUrl, out, seen, resolveUrl);
    scanHydrationData(html, pageUrl, out, seen, resolveUrl);
    scanJsonDataAttributes(html, pageUrl, out, seen, resolveUrl);
    scanKalturaEmbeds(html, pageUrl, out, seen);
    scanAmpEmbeds(htmlWithNoscript, pageUrl, out, seen);
    scanWistiaDivEmbeds(htmlWithNoscript, pageUrl, out, seen);
    scanBrightcoveDivEmbeds(htmlWithNoscript, pageUrl, out, seen);
    scanVidyardEmbeds(html, pageUrl, out, seen);
    scanDivEmbeds(html, pageUrl, out, seen);
    scanMuxEmbeds(html, pageUrl, out, seen);
    scanCloudflareStreamElements(html, pageUrl, out, seen);
    scanPlyrEmbeds(html, pageUrl, out, seen);
    scanIframeEmbeds(htmlWithNoscript, pageUrl, out, seen, resolveUrl);
    scanFlashEmbeds(html, pageUrl, out, seen, resolveUrl);
    scanGenericUrls(html, pageUrl, out, seen);
  }

  const pageTitle = html ? extractPageTitle(html) : undefined;
  if (pageTitle) {
    for (const item of out) {
      if (!item.sourceTitle) item.sourceTitle = pageTitle;
    }
  }

  return out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

export function autoDownloadableUniversalMedia(items: DetectedMedia[]): DetectedMedia[] {
  const directItems = items.filter((item) => !item.forceServerDownload);
  const strongVideoOrAudio = directItems.filter((item) => {
    const kind = item.mediaKind ?? mediaKindFromUrl(item.url, item.mimeType);
    return (kind === 'video' || kind === 'audio') && (item.confidence ?? 0) >= 0.75;
  });
  if (strongVideoOrAudio.length > 0) return strongVideoOrAudio;
  return directItems.filter((item) => {
    const kind = item.mediaKind ?? mediaKindFromUrl(item.url, item.mimeType);
    return kind === 'image' && (item.confidence ?? 0) >= 0.8;
  });
}

export function probeUniversalMediaFromSession(input: UniversalProbeInput): DetectedMedia[] {
  return autoDownloadableUniversalMedia(probeUniversalMedia(input));
}

export async function probeUniversalMediaFromUrl(pageUrl: string, init?: RequestInit): Promise<DetectedMedia[]> {
  if (DIRECT_EXT_RE.test(pageUrl) || HLS_RE.test(pageUrl) || DASH_RE.test(pageUrl) || SMOOTH_RE.test(pageUrl)) {
    return probeUniversalMedia({ pageUrl, mediaHints: [{ url: pageUrl }] });
  }
  const res = await fetch(pageUrl, {
    ...init,
    headers: {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) return [];
  const pageHtml = await res.text();
  return probeUniversalMedia({ pageUrl, pageHtml });
}

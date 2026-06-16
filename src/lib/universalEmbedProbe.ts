export interface UniversalEmbedCandidate {
  url: string;
  source: string;
  fieldPath?: string;
}

export interface UniversalOEmbedOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxChars?: number;
  headers?: HeadersInit;
}

const DEFAULT_OEMBED_TIMEOUT_MS = 4000;
const DEFAULT_OEMBED_MAX_CHARS = 96_000;
const KNOWN_EMBED_RE = /^(?:(?:www\.)?youtube\.com\/embed\/|youtu\.be\/|player\.vimeo\.com\/video\/|(?:www\.)?dailymotion\.com\/embed\/video\/|dai\.ly\/|fast\.wistia\.(?:net|com)\/embed\/|wistia\.(?:net|com)\/embed\/|players\.brightcove\.net\/|cdn\.jwplayer\.com\/players\/|(?:[^/]+\.)?kaltura\.com\/.*\/embed|embed\.vidyard\.com\/|streamable\.com\/[eos]\/|rumble\.com\/embed\/|clips\.twitch\.tv\/embed|player\.twitch\.tv\/|odysee\.com\/\$\/embed\/|iframe\.mediadelivery\.net\/embed\/|(?:[^/]+\.)?cloudflarestream\.com\/[a-f0-9]+\/iframe|iframe\.bunny\.net\/embed\/|videopress\.com\/(?:v|embed)\/|(?:www\.)?loom\.com\/embed\/|open\.spotify\.com\/embed\/(?:episode|track|show|playlist)\/|(?:[^/]+\.)?panopto\.(?:com|eu)\/Panopto\/|w\.soundcloud\.com\/player\/|widget\.spreaker\.com\/player|(?:www\.)?podbean\.com\/player|player\.simplecast\.com\/|share\.transistor\.fm\/|embed\.acast\.com\/|embed\.megaphone\.fm\/)/i;

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

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'<>]+))`, 'i');
  const match = tag.match(re);
  return match?.[2] ?? match?.[3] ?? match?.[4];
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

function cleanEmbedUrl(raw: string | undefined, pageUrl: string): string | undefined {
  if (!raw) return undefined;
  const value = decodeHtml(raw)
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .trim();
  if (!value || /^(?:data:|blob:|javascript:|mailto:|#)/i.test(value)) return undefined;
  try {
    const url = new URL(value, pageUrl);
    if (!/^https?:$/i.test(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function baseUrlFromHtml(html: string, pageUrl: string): string {
  const match = html.match(/<base\b[^>]*>/i);
  const href = match ? attr(match[0], 'href') : undefined;
  return cleanEmbedUrl(href, pageUrl) ?? pageUrl;
}

function isKnownEmbedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return KNOWN_EMBED_RE.test(`${parsed.hostname}${parsed.pathname}`);
  } catch {
    return false;
  }
}

function pushEmbed(
  out: UniversalEmbedCandidate[],
  seen: Set<string>,
  rawUrl: string | undefined,
  pageUrl: string,
  source: string,
  fieldPath?: string,
): void {
  const url = cleanEmbedUrl(rawUrl, pageUrl);
  if (!url || seen.has(url) || !isKnownEmbedUrl(url)) return;
  seen.add(url);
  out.push({ url, source, fieldPath });
}

function scanEmbedTags(html: string, pageUrl: string, out: UniversalEmbedCandidate[], seen: Set<string>, source = 'embed-tag'): void {
  const tagRe = /<(iframe|embed|object)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null && out.length < 12) {
    const tag = match[0];
    const tagName = match[1].toLowerCase();
    pushEmbed(out, seen, attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-lazy-src') ?? attr(tag, 'data'), pageUrl, source, tagName);
    for (const { name, value } of attrs(tag)) {
      if (/^srcdoc$/i.test(name)) continue;
      if (!/(?:embed|iframe|player)(?:-|_|$)|(?:src|url)$/i.test(name)) continue;
      pushEmbed(out, seen, value, pageUrl, source, name);
    }
    const srcdoc = attr(tag, 'srcdoc');
    if (srcdoc) scanEmbedTags(decodeHtml(srcdoc), pageUrl, out, seen, 'embed-srcdoc');
  }
}

function scanEmbedAttributes(html: string, pageUrl: string, out: UniversalEmbedCandidate[], seen: Set<string>): void {
  const tagRe = /<[a-zA-Z][^>]*(?:embed|iframe|player)[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null && out.length < 12) {
    for (const { name, value } of attrs(match[0])) {
      if (/^srcdoc$/i.test(name)) continue;
      if (!/(?:embed|iframe|player)(?:-|_|$)|(?:src|url)$/i.test(name)) continue;
      pushEmbed(out, seen, value, pageUrl, 'embed-attribute', name);
    }
  }
}

function scanObjectParams(html: string, pageUrl: string, out: UniversalEmbedCandidate[], seen: Set<string>): void {
  const paramRe = /<param\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(html)) !== null && out.length < 12) {
    const tag = match[0];
    const name = attr(tag, 'name') ?? '';
    if (!/^(?:movie|src|source|url|player|playerUrl|embedUrl)$/i.test(name)) continue;
    pushEmbed(out, seen, attr(tag, 'value'), pageUrl, 'object-param', name);
  }
}

function oEmbedLinksFromHtml(pageUrl: string, pageHtml?: string): string[] {
  if (!pageHtml) return [];
  const html = String(pageHtml).slice(0, 1_500_000);
  const resolveUrl = baseUrlFromHtml(html, pageUrl);
  const out: string[] = [];
  const seen = new Set<string>();
  const linkRe = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && out.length < 5) {
    const tag = match[0];
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = cleanEmbedUrl(attr(tag, 'href'), resolveUrl);
    if (!href || seen.has(href)) continue;
    if (!type.includes('json+oembed') && !(rel.includes('alternate') && /(?:^|[?&/._-])oembed(?:[?&/._=-]|$)/i.test(href))) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

async function fetchOEmbedJson(url: string, pageUrl: string, opts: UniversalOEmbedOptions): Promise<unknown | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OEMBED_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? DEFAULT_OEMBED_MAX_CHARS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json+oembed,application/json,text/json,*/*;q=0.8',
        Referer: pageUrl,
        ...(opts.headers ?? {}),
      },
      signal: controller?.signal,
    });
    const contentLength = Number(res.headers?.get?.('Content-Length') || 0) || undefined;
    if (contentLength && contentLength > maxChars) return undefined;
    if (!res.ok) return undefined;
    const text = await res.text();
    if (text.length > maxChars) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pushOEmbedJsonCandidates(
  value: unknown,
  pageUrl: string,
  out: UniversalEmbedCandidate[],
  seen: Set<string>,
  sourceUrl: string,
): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const html = typeof record.html === 'string' ? record.html : undefined;
  if (html) {
    const before = out.length;
    scanEmbedTags(decodeHtml(html), pageUrl, out, seen, 'oembed-json');
    for (let i = before; i < out.length; i++) {
      out[i].fieldPath = out[i].fieldPath ? `html.${out[i].fieldPath}` : 'html';
    }
  }
  for (const key of ['embed_url', 'embedUrl', 'player_url', 'playerUrl', 'url']) {
    const raw = record[key];
    if (typeof raw === 'string') pushEmbed(out, seen, raw, pageUrl, 'oembed-json', key);
  }
  for (const item of out) {
    if (item.source === 'oembed-json' && !item.fieldPath) item.fieldPath = sourceUrl;
  }
}

export function extractUniversalEmbedUrls(pageUrl: string, pageHtml?: string): UniversalEmbedCandidate[] {
  if (!pageHtml) return [];
  const html = String(pageHtml).slice(0, 1_500_000);
  const resolveUrl = baseUrlFromHtml(html, pageUrl);
  const out: UniversalEmbedCandidate[] = [];
  const seen = new Set<string>();

  scanEmbedTags(html, resolveUrl, out, seen);
  scanEmbedAttributes(html, resolveUrl, out, seen);
  scanObjectParams(html, resolveUrl, out, seen);

  const jsonLikeRe = /["']?(embedUrl|embedURL|embed_url|playerUrl|player_url|iframeUrl|iframe_url)["']?\s*:\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonLikeRe.exec(html)) !== null && out.length < 12) {
    pushEmbed(out, seen, match[2], resolveUrl, 'script-embed-url', match[1]);
  }

  return out;
}

export async function extractUniversalOEmbedUrls(
  pageUrl: string,
  pageHtml?: string,
  opts: UniversalOEmbedOptions = {},
): Promise<UniversalEmbedCandidate[]> {
  const links = oEmbedLinksFromHtml(pageUrl, pageHtml);
  if (links.length === 0) return [];
  const out: UniversalEmbedCandidate[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const parsed = await fetchOEmbedJson(link, pageUrl, opts);
    pushOEmbedJsonCandidates(parsed, link, out, seen, link);
    if (out.length >= 12) break;
  }
  return out;
}

export interface VimeoStreams {
  hls?: string;
  dash?: string;
  progressive: Array<{ url: string; quality: string }>;
}

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function parseVimeoPlayerUrl(url: string): { videoId: string; params: string } | null {
  const m = url.match(/player\.vimeo\.com\/video\/(\d+)(.*)/);
  if (!m) return null;
  const params = m[2].startsWith('?') ? m[2].slice(1) : m[2].replace(/^\/.*?\?/, '');
  return { videoId: m[1], params };
}

function parseConfigJson(data: any): VimeoStreams {
  const result: VimeoStreams = { progressive: [] };
  const files = data?.request?.files;
  if (!files) return result;

  if (files.hls?.cdns) {
    const cdns = Object.values(files.hls.cdns) as any[];
    const preferred = cdns.find((c: any) => c.url?.includes('akamai')) ?? cdns.find((c: any) => c.url);
    if (preferred?.url) result.hls = preferred.url;
  }
  if (files.dash?.cdns) {
    const cdns = Object.values(files.dash.cdns) as any[];
    const preferred = cdns.find((c: any) => c.url);
    if (preferred?.url) result.dash = preferred.url;
  }
  if (Array.isArray(files.progressive)) {
    result.progressive = (files.progressive as any[])
      .filter((p: any) => p.url)
      .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0))
      .map((p: any) => ({ url: p.url, quality: `${p.height ?? '?'}p` }));
  }
  return result;
}

function makeVimeoHeaders(playerPageUrl: string, cookies?: string): Record<string, string> {
  // Referer must be the Vimeo player page URL itself — Vimeo's server checks same-origin.
  // Using the embedding site URL causes the privacy error.
  const h: Record<string, string> = {
    'User-Agent': CHROME_UA,
    'Referer': playerPageUrl,
    'Origin': 'https://player.vimeo.com',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (cookies) h['Cookie'] = cookies;
  return h;
}

// Try the /config JSON endpoint directly
async function tryConfigEndpoint(
  videoId: string,
  params: string,
  referer: string,
  cookies?: string,
): Promise<VimeoStreams | null> {
  const configUrl = `https://player.vimeo.com/video/${videoId}/config${params ? '?' + params : ''}`;
  try {
    const res = await fetch(configUrl, { headers: makeVimeoHeaders(referer, cookies) });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.trimStart()[0] !== '{') return null; // HTML privacy page, not JSON
    return parseConfigJson(JSON.parse(text));
  } catch {
    return null;
  }
}

// Fetch the player HTML page and extract the embedded config JSON
async function tryPlayerPage(
  videoId: string,
  params: string,
  referer: string,
  cookies?: string,
): Promise<VimeoStreams | null> {
  const playerUrl = `https://player.vimeo.com/video/${videoId}${params ? '?' + params : ''}`;
  try {
    const res = await fetch(playerUrl, { headers: makeVimeoHeaders(referer, cookies) });
    if (!res.ok) return null;
    const html = await res.text();

    // Vimeo embeds the config JSON in several ways
    const patterns = [
      /window\.__playerConfig\s*=\s*(\{.+?\});?\s*<\/script>/s,
      /window\.vimeo_config\s*=\s*(\{.+?\});?\s*<\/script>/s,
      /<script[^>]+id="player-config"[^>]*>\s*(\{.+?\})\s*<\/script>/s,
      /var\s+playerConfig\s*=\s*(\{.+?\});?\s*<\/script>/s,
      /"player_url":"[^"]*","config":(\{.+?\}),"jwt"/s,
    ];

    for (const re of patterns) {
      const m = html.match(re);
      if (!m) continue;
      try {
        const config = JSON.parse(m[1]);
        const streams = parseConfigJson(config);
        if (streams.hls || streams.dash || streams.progressive.length > 0) return streams;
      } catch {}
    }
  } catch {}
  return null;
}

export async function extractVimeoStreams(
  playerUrl: string,
  referer: string,
  _userAgent: string,
  cookies?: string,
): Promise<VimeoStreams> {
  const parsed = parseVimeoPlayerUrl(playerUrl);
  if (!parsed) throw new Error('Not a Vimeo player URL');

  const refBase = referer.startsWith('http') ? referer : `https://${referer}`;

  // Try config endpoint first (faster), then fall back to full player HTML
  const fromConfig = await tryConfigEndpoint(parsed.videoId, parsed.params, refBase, cookies);
  if (fromConfig && (fromConfig.hls || fromConfig.dash || fromConfig.progressive.length > 0)) {
    return fromConfig;
  }

  const fromPage = await tryPlayerPage(parsed.videoId, parsed.params, refBase, cookies);
  if (fromPage && (fromPage.hls || fromPage.dash || fromPage.progressive.length > 0)) {
    return fromPage;
  }

  throw new Error(
    'Vimeo returned a privacy error. The video may be restricted to logged-in users or specific domains only.',
  );
}

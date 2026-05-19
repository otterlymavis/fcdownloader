/**
 * Platform-specific video URL extraction for pasted social-media page URLs.
 * Called when the user pastes a site URL (not a direct CDN URL) into the
 * manual-add field. Works best for public / unauthenticated content.
 */
import { DetectedMedia } from '../types';

let _seq = 0;
const genId = () => `ext_${Date.now()}_${_seq++}`;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchHtml(url: string, ua = DESKTOP_UA): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return res.text();
}

function makeItem(url: string, pageUrl: string, label?: string): DetectedMedia {
  const clean = url
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .trim();
  return {
    id: genId(),
    url: clean,
    pageUrl,
    userAgent: '',
    timestamp: Date.now(),
    mediaType: clean.toLowerCase().includes('.mpd') ? 'dash' : 'hls',
    label,
  };
}

function extractUrls(text: string, re: RegExp): string[] {
  const results: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? m[0])
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\/g, '')
      .trim();
    if (raw.startsWith('http') && !results.includes(raw)) results.push(raw);
  }
  return results;
}

// ── TikTok ────────────────────────────────────────────────────────
async function extractTikTok(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];

    // TikTok embeds rehydration data in a script tag
    const scriptMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (scriptMatch) {
      try {
        const json = JSON.stringify(JSON.parse(scriptMatch[1]));
        extractUrls(json, /"playAddr"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u =>
          results.push(makeItem(u, pageUrl)),
        );
        extractUrls(json, /"downloadAddr"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u => {
          if (!results.some(r => r.url === makeItem(u, pageUrl).url))
            results.push(makeItem(u, pageUrl));
        });
      } catch {}
    }

    // Fallback: scan page for TikTok CDN URLs directly
    if (results.length === 0) {
      extractUrls(html, /https?:\/\/v\d+-webapp\.tiktok\.com\/[^\s"'<>]{8,}/g).forEach(u =>
        results.push(makeItem(u, pageUrl)),
      );
    }

    return results;
  } catch { return []; }
}

// ── Twitter / X ───────────────────────────────────────────────────
async function extractTwitter(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    const results: DetectedMedia[] = [];

    const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (scriptMatch) {
      extractUrls(
        scriptMatch[1],
        /https?:\\\/\\\/video\.twimg\.com\\\/[^"\\]+?\.mp4[^"\\]*/g,
      ).forEach(u => results.push(makeItem(u, pageUrl)));
    }

    // OG / Twitter card meta-tags as fallback
    extractUrls(
      html,
      /<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
    )
      .filter(u => u.startsWith('http'))
      .forEach(u => { if (!results.some(r => r.url === u)) results.push(makeItem(u, pageUrl)); });

    return results;
  } catch { return []; }
}

// ── Instagram / Threads ───────────────────────────────────────────
async function extractInstagram(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];

    extractUrls(html, /"video_url"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u =>
      results.push(makeItem(u, pageUrl)),
    );

    if (results.length === 0) {
      extractUrls(
        html,
        /<meta\s+property\s*=\s*["']og:video["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
      ).forEach(u => results.push(makeItem(u, pageUrl)));
    }

    return results;
  } catch { return []; }
}

// ── Dailymotion ───────────────────────────────────────────────────
async function extractDailymotion(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const match = pageUrl.match(/dailymotion\.com\/video\/([A-Za-z0-9]+)/);
    if (!match) return [];
    const videoId = match[1];

    const res = await fetch(
      `https://www.dailymotion.com/player/metadata/video/${videoId}`,
      { headers: { 'User-Agent': DESKTOP_UA, 'Referer': 'https://www.dailymotion.com/' } },
    );
    const data = await res.json() as Record<string, unknown>;
    const results: DetectedMedia[] = [];

    const qualities = data.qualities as Record<string, Array<{ type?: string; url?: string }>> | undefined;
    if (qualities) {
      for (const list of Object.values(qualities)) {
        for (const q of list) {
          if (q.type === 'application/x-mpegURL' && q.url) {
            results.push(makeItem(q.url, pageUrl));
          }
        }
      }
    }

    return results;
  } catch { return []; }
}

// ── YouTube ───────────────────────────────────────────────────────
async function extractYouTube(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    const results: DetectedMedia[] = [];

    const ytMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|const|let|\n|<)/);
    if (ytMatch) {
      try {
        const data = JSON.parse(ytMatch[1]) as any;
        const sd = data.streamingData;
        if (sd) {
          // HLS manifest — single URL, quality-adaptive, best choice
          if (sd.hlsManifestUrl) {
            results.push(makeItem(sd.hlsManifestUrl, pageUrl, 'HLS (best)'));
          }

          // Progressive formats only — video+audio in one file, sorted highest quality first.
          // Adaptive formats are video-only or audio-only and require ffmpeg to merge, so skip them.
          const progressive: Array<{ url: string; qualityLabel?: string; bitrate?: number }> =
            (sd.formats ?? [])
              .filter((f: any) => f.url && f.mimeType?.startsWith('video/'))
              .sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

          for (const f of progressive) {
            if (!results.some(r => r.url === f.url)) {
              results.push(makeItem(f.url, pageUrl, f.qualityLabel));
            }
          }
        }
      } catch {}
    }

    return results;
  } catch { return []; }
}

// ── TVer ──────────────────────────────────────────────────────────
async function extractTVer(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const episodeMatch = pageUrl.match(/tver\.jp\/episodes\/(ep[A-Za-z0-9]+)/);
    if (!episodeMatch) return [];
    const episodeId = episodeMatch[1];

    const res = await fetch(
      `https://platform-api.tver.jp/service/api/v1/callEpisode/${episodeId}`,
      {
        headers: {
          'x-tver-platform-type': 'web',
          'Origin': 'https://tver.jp',
          'Referer': 'https://tver.jp/',
          'User-Agent': DESKTOP_UA,
        },
      },
    );
    if (!res.ok) return [];

    const json = JSON.stringify(await res.json());
    const results: DetectedMedia[] = [];

    extractUrls(json, /(https?:\/\/[^"\\]+\.m3u8[^"\\]*)/g)
      .forEach(u => results.push(makeItem(u, pageUrl)));

    if (results.length === 0) {
      extractUrls(json, /(https?:\/\/[^"\\]+\.mp4[^"\\]*)/g)
        .forEach(u => results.push(makeItem(u, pageUrl)));
    }

    return results;
  } catch { return []; }
}

// ── Facebook ──────────────────────────────────────────────────────
async function extractFacebook(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl, MOBILE_UA);
    const results: DetectedMedia[] = [];

    for (const re of [
      /"hd_src"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /"sd_src"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /"browser_native_hd_url"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /"browser_native_sd_url"\s*:\s*"(https?:\/\/[^"]+)"/g,
    ]) {
      extractUrls(html, re).forEach(u => {
        if (!results.some(r => r.url === u)) results.push(makeItem(u, pageUrl));
      });
    }

    return results;
  } catch { return []; }
}

// ── Pinterest ─────────────────────────────────────────────────────
async function extractPinterest(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    const results: DetectedMedia[] = [];

    extractUrls(html, /"v_hlsUrl"\s*:\s*"(https?:\/\/[^"]+)"/g).forEach(u =>
      results.push(makeItem(u, pageUrl)),
    );
    if (results.length === 0) {
      extractUrls(html, /"v_url"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/g).forEach(u =>
        results.push(makeItem(u, pageUrl)),
      );
    }

    return results;
  } catch { return []; }
}

// ── Generic OG / meta-tag fallback ────────────────────────────────
async function extractOgVideo(pageUrl: string): Promise<DetectedMedia[]> {
  try {
    const html = await fetchHtml(pageUrl);
    return extractUrls(
      html,
      /<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]+content\s*=\s*["']([^"']+)["']/gi,
    )
      .filter(u => u.startsWith('http'))
      .map(u => makeItem(u, pageUrl));
  } catch { return []; }
}

// ── Platform registry ─────────────────────────────────────────────
const PLATFORMS: Array<{ re: RegExp; fn: (url: string) => Promise<DetectedMedia[]> }> = [
  { re: /tiktok\.com\/@[^/]+\/video\/\d+|tiktok\.com\/t\/[A-Za-z0-9]+/,          fn: extractTikTok      },
  { re: /(?:twitter|x)\.com\/[^/]+\/status\/\d+/,                                  fn: extractTwitter     },
  { re: /instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+/,                           fn: extractInstagram   },
  { re: /threads\.net\/@[^/]+\/post\/[A-Za-z0-9_-]+/,                              fn: extractInstagram   },
  { re: /dailymotion\.com\/video\/[A-Za-z0-9]+/,                                    fn: extractDailymotion },
  { re: /(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)[?/]?[A-Za-z0-9_-]{11}/,   fn: extractYouTube     },
  { re: /facebook\.com\/(?:watch|reel|video)|fb\.watch/,                            fn: extractFacebook    },
  { re: /pinterest\.(?:com|[a-z]{2,3})\/pin\/\d+/,                                 fn: extractPinterest   },
  { re: /tver\.jp\/episodes\/ep[A-Za-z0-9]+/,                                       fn: extractTVer        },
];

/** Returns true if the URL looks like a social-media post page (not a CDN media URL). */
export function isSocialPageUrl(url: string): boolean {
  return PLATFORMS.some(p => p.re.test(url));
}

/**
 * Attempts to extract video URLs from a social-media post page URL.
 * Falls back to scanning OG meta tags if the platform extractor finds nothing.
 */
export async function extractFromSocialUrl(pageUrl: string): Promise<DetectedMedia[]> {
  for (const platform of PLATFORMS) {
    if (platform.re.test(pageUrl)) {
      const items = await platform.fn(pageUrl);
      if (items.length > 0) return items;
      break;
    }
  }
  return extractOgVideo(pageUrl);
}

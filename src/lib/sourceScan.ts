import { DetectedMedia } from '../types';

const VIDEO_PATTERNS = [
  /["'`](https?:\/\/[^"'`\s]{8,}\.m3u8[^"'`\s]*)/gi,
  /["'`](https?:\/\/[^"'`\s]{8,}\.mpd[^"'`\s]*)/gi,
  /["'`](https?:\/\/[^"'`\s]{8,}\.mp4[^"'`\s]*)/gi,
  /(https?:\\\/\\\/[^"'`\s]{8,}\.(?:m3u8|mpd|mp4)[^"'`\s]*)/gi,
  /"(?:src|file|url|source|stream|hls|manifest|videoUrl|video_url|playbackUrl|streamUrl)"\s*:\s*"(https?:\/\/[^"]{8,})"/gi,
  /(?:source|src|url|file|hls|manifest)\s*[:=]\s*["'`](https?:\/\/[^"'`\s]{8,})/gi,
];

// Reject URLs that are clearly static assets (images, fonts, scripts, etc.)
const SKIP_STATIC = /\.(png|jpe?g|gif|svg|ico|webp|bmp|avif|woff2?|ttf|eot|otf|css|js|mjs|json|html?|pdf|zip|gz|map|xml|txt)(\?|#|$)/i;
const SKIP_SEGMENT = /\.(ts|m4s|aac|m4a|cmfv|cmfa)(\?|#|$)/i;

function isFragmentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return SKIP_SEGMENT.test(url.split('#')[0]) ||
    (lower.includes('vimeocdn.com/') && lower.includes('/v2/range/') && lower.includes('/avf/'));
}

function guessType(url: string): 'hls' | 'dash' {
  const u = url.toLowerCase();
  if (u.includes('.mpd')) return 'dash';
  return 'hls';
}

function normalizeUrl(raw: string): string {
  let url = raw
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/&amp;/g, '&')
    .trim();
  try { url = decodeURIComponent(url); } catch {}
  return url;
}

let _seq = 0;

export async function scanPageSource(
  pageUrl: string,
  userAgent: string,
): Promise<DetectedMedia[]> {
  const res = await fetch(pageUrl, {
    headers: {
      'User-Agent': userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = await res.text();
  const seen = new Set<string>();
  const results: DetectedMedia[] = [];

  for (const pattern of VIDEO_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(html)) !== null) {
      const url = normalizeUrl(m[1]);
      if (SKIP_STATIC.test(url.split('?')[0])) continue;
      if (isFragmentUrl(url)) continue;
      if (!seen.has(url)) {
        seen.add(url);
        results.push({
          id: `src_${Date.now()}_${_seq++}`,
          url,
          pageUrl,
          userAgent,
          timestamp: Date.now(),
          mediaType: guessType(url),
        });
      }
    }
  }

  return results;
}

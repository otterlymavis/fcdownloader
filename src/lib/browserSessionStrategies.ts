import { DetectedMedia, SourceAuditEntry } from '../types';

type BrowserNetworkHintInput = string | {
  url?: string;
  pageUrl?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  contentLength?: number;
  transferSize?: number;
  encodedBodySize?: number;
  provenance?: string;
  initiatorType?: string;
  timestamp?: number;
};

const AUDIT_HOST_RE = /(?:youtube\.com|youtu\.be|(?:player\.)?vimeo\.com|vimeocdn\.com|bilivideo\.com|bilibili\.com|b23\.tv|weibo\.com|weibo\.cn|weibocdn\.com|xiaohongshu\.com|rednote\.com|xhslink\.com|xhscdn\.com|tiktok\.com|vm\.tiktok\.com|reddit\.com|redd\.it|naver\.com|naver\.me|pstatic\.net|nicovideo\.jp|nico\.ms|niconico\.com|nicochannel\.jp|tver\.jp|tver\.co\.jp|abema\.tv|abema\.io|twitcasting\.tv|openrec\.tv|video\.fc2\.com|live\.fc2\.com|nhk\.or\.jp|nhk\.jp|cu\.tbs\.co\.jp|tbs\.co\.jp|tbs\.jp|fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|fujitv\.co\.jp|video\.yahoo\.co\.jp|news\.yahoo\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|ameblo\.jp|ameba\.jp|natalie\.mu|oricon\.co\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|pixiv\.net|fanbox\.cc|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net)/i;
const AUDIT_URL_RE = /https?:\\?\/\\?\/[^"'\\<>\s]*(?:\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)|(?:sinaimg\.cn|weibocdn\.com|xhscdn\.com|bilivideo\.com|hdslb\.com|biliimg\.com|pstatic\.net|pximg\.net|kakaocdn\.net|daumcdn\.net|cdninstagram\.com|fbcdn\.net|threadscdn\.com|(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp))[^"'\\<>\s]*/gi;
const MEDIA_URL_RE = /(?:\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)|(?:vimeocdn\.com\/.*\/playlist\.json|player\.vimeo\.com\/video\/\d+\/config)(?:[?#]|$)|(?:sinaimg\.cn|weibocdn\.com|xhscdn\.com|bilivideo\.com|hdslb\.com|biliimg\.com|pstatic\.net|pximg\.net|kakaocdn\.net|daumcdn\.net|cdninstagram\.com|fbcdn\.net|threadscdn\.com|(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp))/i;
const MEDIA_MIME_RE = /^(?:video\/|audio\/|image\/|application\/(?:dash\+xml|x-mpegdash\+xml|vnd\.apple\.mpegurl|x-mpegurl)|application\/octet-stream$)/i;
const NON_MEDIA_MIME_RE = /^(?:text\/html|text\/plain|application\/(?:json|javascript|x-javascript|xml)|text\/css)/i;

function normaliseAuditUrl(raw: string): string {
  let url = String(raw || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\')
    .replace(/&amp;/g, '&')
    .trim();
  if (url.startsWith('//')) url = `https:${url}`;
  return url.replace(/^http:\/\//i, 'https://');
}

export function extractHtmlAuditCandidates(pageUrl: string, pageHtml?: string): SourceAuditEntry[] {
  if (!pageHtml || !AUDIT_HOST_RE.test(pageUrl)) return [];
  const html = String(pageHtml).slice(0, 1_500_000);
  const out: SourceAuditEntry[] = [];
  const seen = new Set<string>();

  const add = (rawUrl: string, strategy: string, source: string, fieldPath?: string) => {
    const url = normaliseAuditUrl(rawUrl);
    if (!/^https?:\/\//i.test(url)) return;
    if (!MEDIA_URL_RE.test(url)) return;
    if (/(?:avatar|profile|emoji|sprite|favicon|tracking|pixel|blank)/i.test(url)) return;
    const key = `${strategy}\n${source}\n${url.replace(/\?.*$/, '')}\n${fieldPath || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, strategy, source, fieldPath, selected: false });
  };

  const metaRe = /<meta\s[^>]*(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html)) !== null && out.length < 160) {
    add(match[2], 'embedded-metadata', 'meta-tag', match[1]);
  }
  while ((match = AUDIT_URL_RE.exec(html)) !== null && out.length < 240) {
    add(match[0], 'embedded-metadata', 'html-url-regex', 'document');
  }
  return out;
}

export function mediaHintsFromDetected(items: DetectedMedia[], fallbackReferer: string): Array<Record<string, unknown>> {
  return items.slice(0, 40).map((item) => ({
    url: item.url,
    kind: item.mediaType === 'dash' ? 'dash' : item.mediaType === 'hls' ? 'hls' : item.mediaKind || item.mediaType,
    title: item.sourceTitle || item.label,
    referer: item.sourcePageUrl || item.pageUrl || fallbackReferer,
    headers: item.httpHeaders || {},
    mimeType: item.mimeType,
    width: item.width,
    height: item.height,
    bitrate: item.bitrate,
    confidence: item.confidence,
    provenance: item.provenance,
  }));
}

function networkEntryUrl(entry: BrowserNetworkHintInput): string {
  return typeof entry === 'string' ? entry : String(entry.url || '');
}

function networkEntrySize(entry: BrowserNetworkHintInput): number | undefined {
  if (typeof entry === 'string') return undefined;
  return entry.contentLength ?? entry.encodedBodySize ?? entry.transferSize;
}

function isMediaNetworkEntry(url: string, mimeType?: string): boolean {
  if (MEDIA_URL_RE.test(url)) return true;
  if (!mimeType || NON_MEDIA_MIME_RE.test(mimeType)) return false;
  if (/^application\/octet-stream/i.test(mimeType)) return false;
  return MEDIA_MIME_RE.test(mimeType);
}

export function mediaHintsFromNetworkLog(urls: BrowserNetworkHintInput[], fallbackReferer: string): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const hints: Array<Record<string, unknown>> = [];
  for (const raw of urls) {
    const url = normaliseAuditUrl(networkEntryUrl(raw));
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    const entry = typeof raw === 'string' ? {} : raw;
    const lower = url.toLowerCase();
    const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : undefined;
    if (!isMediaNetworkEntry(url, mimeType)) continue;
    seen.add(url);
    const kind =
      lower.includes('.mpd') || /dash\+xml/i.test(mimeType || '') ? 'dash'
      : lower.includes('.m3u8') || lower.includes('.m3u') || /mpegurl|m3u8/i.test(mimeType || '') ? 'hls'
      : /^audio\//i.test(mimeType || '') || /\.(?:mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(lower) ? 'audio'
      : /^image\//i.test(mimeType || '') || /\.(?:jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(lower) ? 'image'
      : 'video';
    const size = networkEntrySize(raw);
    const source = entry.provenance || entry.initiatorType || 'network-log';
    const strongStatus = typeof entry.status === 'number' && entry.status >= 200 && entry.status < 400;
    const sourceBoost = source === 'fetch-hook' || source === 'xhr-hook' ? 0.04 : 0;
    const sizeBoost = typeof size === 'number' && size > 1_000_000 ? 0.03 : 0;
    hints.push({
      url,
      kind,
      referer: entry.pageUrl || fallbackReferer,
      provenance: source,
      mimeType,
      contentLength: size,
      status: entry.status,
      method: entry.method,
      confidence: Math.min(0.95, (kind === 'image' ? 0.55 : kind === 'audio' ? 0.76 : 0.78) + sourceBoost + sizeBoost + (strongStatus ? 0.02 : 0)),
      source,
    });
    if (hints.length >= 80) break;
  }
  return hints;
}

import { DetectedMedia, SourceAuditEntry } from '../types';

const AUDIT_HOST_RE = /(?:youtube\.com|youtu\.be|(?:player\.)?vimeo\.com|vimeocdn\.com|bilivideo\.com|bilibili\.com|b23\.tv|weibo\.com|weibo\.cn|weibocdn\.com|xiaohongshu\.com|rednote\.com|xhslink\.com|xhscdn\.com|tiktok\.com|vm\.tiktok\.com|reddit\.com|redd\.it|naver\.com|naver\.me|pstatic\.net|nicovideo\.jp|nico\.ms|niconico\.com|nicochannel\.jp|tver\.jp|tver\.co\.jp|abema\.tv|abema\.io|twitcasting\.tv|openrec\.tv|video\.fc2\.com|live\.fc2\.com|nhk\.or\.jp|nhk\.jp|cu\.tbs\.co\.jp|tbs\.co\.jp|tbs\.jp|fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|fujitv\.co\.jp|video\.yahoo\.co\.jp|news\.yahoo\.co\.jp|ameblo\.jp|ameba\.jp|natalie\.mu|oricon\.co\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|pixiv\.net|fanbox\.cc|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net)/i;
const AUDIT_URL_RE = /https?:\\?\/\\?\/[^"'\\<>\s]*(?:\.(?:m3u8|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)|(?:sinaimg\.cn|weibocdn\.com|xhscdn\.com|bilivideo\.com|hdslb\.com|biliimg\.com|pstatic\.net|pximg\.net|kakaocdn\.net|daumcdn\.net|cdninstagram\.com|fbcdn\.net|threadscdn\.com))[^"'\\<>\s]*/gi;
const MEDIA_URL_RE = /(?:\.(?:m3u8|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)|(?:sinaimg\.cn|weibocdn\.com|xhscdn\.com|bilivideo\.com|hdslb\.com|biliimg\.com|pstatic\.net|pximg\.net|kakaocdn\.net|daumcdn\.net|cdninstagram\.com|fbcdn\.net|threadscdn\.com))/i;

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

/**
 * Service worker — central state, talks to the Fly backend, drives chrome.downloads.
 *
 * Responsibilities:
 *  - Maintain a per-tab list of detected media URLs (from content scripts +
 *    webRequest interception of m3u8/mpd/mp4).
 *  - Read cookies for the current page domain via chrome.cookies (HttpOnly
 *    cookies that a bookmarklet can't see). Forward to the backend.
 *  - Route to chrome.downloads.download() for direct mp4 URLs (no server
 *    bandwidth) OR to the backend /download endpoint for HLS / paired
 *    YouTube HD streams.
 */

// Default backend URL baked into THIS build at packaging time. The OSS
// source has FCDL_DEFAULT_BACKEND = "" in config.js so forks don't inherit
// anyone's infrastructure; a distribution build replaces that value at
// packaging time so end users never have to enter the URL manually.
import { FCDL_DEFAULT_BACKEND } from "./config.js";
const DEFAULT_BACKEND = (FCDL_DEFAULT_BACKEND || "").trim().replace(/\/+$/, "");
const DEBUG_LOGS = false;
const LOCAL_HELPER_MIN_VERSION = "0.4.0-go";
const LOCAL_HELPER_STATUS_TIMEOUT_MS = 3500;
const LOCAL_HELPER_START_TIMEOUT_MS = 20000;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i;
const VIMEO_CONFIG_RE = /player\.vimeo\.com\/video\/\d+\/config\/?(?:[?#]|$)/i;
const SERVER_ONLY_RE = /youtube\.com|youtu\.be|(?:player\.)?vimeo\.com|vimeocdn\.com|bilivideo\.(?:com|cn)|bilibili\.com|b23\.tv|weibo\.com|weibo\.cn|weibocdn\.com|xiaohongshu\.com|rednote\.com|xhslink\.com|xhscdn\.com|tiktok\.com|vm\.tiktok\.com|reddit\.com|redd\.it|naver\.com|naver\.me|pstatic\.net|nicovideo\.jp|nico\.ms|niconico\.com|nicochannel\.jp|seiga\.nicovideo\.jp|tver\.jp|tver\.co\.jp|abema\.tv|abema\.io|twitcasting\.tv|openrec\.tv|video\.fc2\.com|live\.fc2\.com|nhk\.or\.jp|nhk\.jp|cu\.tbs\.co\.jp|tbs\.co\.jp|tbs\.jp|fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|fujitv\.co\.jp|video\.yahoo\.co\.jp|news\.yahoo\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|ameblo\.jp|ameba\.jp|natalie\.mu|oricon\.co\.jp|mdpr\.jp|modelpress\.jp|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|story\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|pixiv\.net|fanbox\.cc|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net|trilltrill\.jp|note\.com|lineblog\.me|hatenablog\.(?:com|jp)|hatenadiary\.(?:com|jp)|hatena\.ne\.jp|blog\.fc2\.com|gyazo\.com|streamable\.com|redgifs\.com|linkedin\.com|bsky\.app|tumblr\.com/;
const PAGE_HTML_RE = /(?:^|\.)(?:oricon\.co\.jp|mdpr\.jp|modelpress\.jp|news\.yahoo\.co\.jp|news\.naver\.com|n\.news\.naver\.com|m\.news\.naver\.com|entertain\.naver\.com|m\.entertain\.naver\.com|sports\.news\.naver\.com|m\.sports\.naver\.com|t\.bilibili\.com|bilibili\.com|ameblo\.jp|ameba\.jp|natalie\.mu|kstyle\.com|tistory\.com|daum\.net|tv\.kakao\.com|story\.kakao\.com|blog\.livedoor\.jp|livedoor\.blog|pixiv\.net|fanbox\.cc|bunshun\.jp|dailyshincho\.jp|news-postseven\.com|josei7\.com|friday\.kodansha\.co\.jp|gendai\.media|withonline\.jp|vivi\.tv|cancam\.jp|classy-online\.jp|classyonline\.jp|jj-jj\.net|gingerweb\.jp|ar-mag\.jp|bisweb\.jp|ray-web\.jp|hpplus\.jp|ananweb\.jp|croissant-online\.jp|frau\.tokyo|mi-mollet\.com|fashion-press\.net|fashionsnap\.com|wwdjapan\.com|thetv\.jp|mantan-web\.jp|crank-in\.net|cinematoday\.jp|eiga\.com|realsound\.jp|spice\.eplus\.jp|jprime\.jp|smart-flash\.jp|flash\.jp|nikkan-gendai\.com|asagei\.com|entamenext\.com|girlsnews\.tv|tokyo-sports\.co\.jp|hochi\.news|sponichi\.co\.jp|nikkansports\.com|sanspo\.com|mainichi\.jp|asahi\.com|yomiuri\.co\.jp|sankei\.com|tokyo-np\.co\.jp|47news\.jp|jiji\.com|itmedia\.co\.jp|impress\.co\.jp|news\.mynavi\.jp|ascii\.jp|gigazine\.net|trilltrill\.jp|lineblog\.me|hatenablog\.com|hatenablog\.jp|hatenadiary\.com|hatenadiary\.jp|hatena\.ne\.jp|blog\.fc2\.com|seiga\.nicovideo\.jp|story\.kakao\.com)$/i;
const PROXY_REQUIRED_RE = /(?:(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|cdninstagram\.com|fbcdn\.net|threadscdn\.com|weibocdn\.com|xhscdn\.com|ci\.xiaohongshu\.com|bilivideo\.(?:com|cn)|biliimg\.com|hdslb\.com|pstatic\.net|pximg\.net|yimg\.jp|kakaocdn\.net|daumcdn\.net|img-mdpr\.freetls\.fastly\.net|obs\.line-scdn\.net|obs-beta\.line-scdn\.net|media\.trilltrill\.jp|fashionsnap-assets\.com|lohas\.nicoseiga\.jp|akamaized\.net)/i;
const REPLAY_HEADER_ALLOW_RE = /^(accept|accept-language|origin|range|referer|user-agent)$/i;
const RUNTIME_CAPTURE_HOST_RE = /(?:tver\.jp|tver\.co\.jp|abema\.tv|abema\.io|(?:[a-z0-9-]+\.)*streaks\.jp|fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|fujitv\.co\.jp|cu\.tbs\.co\.jp|tbs\.co\.jp|tbs\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|video\.fc2\.com|live\.fc2\.com|nicovideo\.jp|nico\.ms|niconico\.com|nicochannel\.jp|news\.yahoo\.co\.jp|video\.yahoo\.co\.jp|mantan-web\.jp|tv\.kakao\.com|kakao\.com|xiaohongshu\.com|rednote\.com|xhslink\.com|xhscdn\.com|ci\.xiaohongshu\.com|bilibili\.com|bilivideo\.(?:com|cn)|hdslb\.com|biliimg\.com|naver\.com|naver\.me|pstatic\.net|brightcove\.net|boltdns\.net|akamaihd\.net|akamaized\.net|vod-abematv|linear-abematv|kakaocdn\.net|daumcdn\.net|nimg\.jp|dmc\.nico|video\.bsky\.app|cdn\.bsky\.app)/i;
const PREFLIGHT_MEDIA_TYPES = [
  "video/",
  "image/",
  "audio/",
  "application/x-mpegURL",
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
  "application/octet-stream",
];
const NETWORK_CAPTURE_MEDIA_TYPES = PREFLIGHT_MEDIA_TYPES.filter((type) => type !== "image/");

function debugLog(...args) {
  if (DEBUG_LOGS) console.log(...args);
}

function debugWarn(...args) {
  if (DEBUG_LOGS) console.warn(...args);
}

// On install: seed the storage.sync backend from DEFAULT_BACKEND so the
// user never sees the "configure backend" screen on a public-distribution
// build. Existing user overrides are preserved.
//
// On update or fresh install with NO default baked in (i.e. someone built
// from source without setting the env var), open the options page so the
// configuration step is at least obvious.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install" && details.reason !== "update") return;
  try {
    const stored = await chrome.storage.sync.get({ backend: "" });
    if (!stored.backend?.trim()) {
      if (DEFAULT_BACKEND) {
        await chrome.storage.sync.set({ backend: DEFAULT_BACKEND });
        debugLog("[fcdl] seeded backend from build default:", DEFAULT_BACKEND);
      } else {
        chrome.runtime.openOptionsPage();
      }
    }
  } catch (e) {
    debugWarn("[fcdl] onInstalled setup failed:", e);
  }
});

// ── Detected videos per tab ───────────────────────────────────────────────

const tabState = new Map(); // tabId -> { url, pageUrl, items: [{url, kind, source, ...}], sourceAudit: [...] }
const requestHeadersByUrl = new Map();

function ensureTab(tabId, pageUrl) {
  let s = tabState.get(tabId);
  if (!s || s.pageUrl !== pageUrl) {
    s = { tabId, pageUrl, items: [], technicalItems: [], sourceAudit: [], preferCapturedMedia: false, updatedAt: Date.now() };
    tabState.set(tabId, s);
  }
  return s;
}

function isSupportedAuditPage(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname;
    return PAGE_HTML_RE.test(host) || SERVER_ONLY_RE.test(pageUrl) || RUNTIME_CAPTURE_HOST_RE.test(pageUrl);
  } catch {
    return false;
  }
}

function normalizeAuditUrl(raw) {
  let url = String(raw || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\")
    .replace(/&amp;/g, "&")
    .trim();
  if (url.startsWith("//")) url = `https:${url}`;
  return url.replace(/^http:\/\//i, "https://");
}

function auditSourceCandidate(tabId, pageUrl, candidate) {
  if (tabId == null || !pageUrl || !candidate) return;
  const url = normalizeAuditUrl(candidate.url || "");
  if (url && !/^https?:\/\//i.test(url)) return;
  const state = ensureTab(tabId, pageUrl);
  const entry = {
    strategy: String(candidate.strategy || "browser-capture").slice(0, 80),
    source: String(candidate.source || "extension").slice(0, 120),
    url: url || undefined,
    pageUrl,
    fieldPath: candidate.fieldPath ? String(candidate.fieldPath).slice(0, 180) : undefined,
    mimeType: candidate.mimeType ? String(candidate.mimeType).slice(0, 160) : undefined,
    width: Number.isFinite(Number(candidate.width)) ? Number(candidate.width) : undefined,
    height: Number.isFinite(Number(candidate.height)) ? Number(candidate.height) : undefined,
    status: Number.isFinite(Number(candidate.status)) ? Number(candidate.status) : undefined,
    contentLength: Number.isFinite(Number(candidate.contentLength)) ? Number(candidate.contentLength) : undefined,
    selected: candidate.selected === true,
    notes: candidate.notes ? String(candidate.notes).slice(0, 500) : undefined,
  };
  const key = [entry.strategy, entry.source, entry.url || "", entry.fieldPath || ""].join("\n");
  if (state.sourceAudit.some((item) => [item.strategy, item.source, item.url || "", item.fieldPath || ""].join("\n") === key)) return;
  state.sourceAudit.push(entry);
  state.sourceAudit = state.sourceAudit.slice(-240);
  state.updatedAt = Date.now();
}

function sourceAuditForTab(tabId, pageUrl, extra = []) {
  const state = tabId != null ? tabState.get(tabId) : null;
  const combined = [...(state?.sourceAudit || []), ...(Array.isArray(extra) ? extra : [])];
  const out = [];
  const seen = new Set();
  for (const item of combined) {
    if (!item || typeof item !== "object") continue;
    const url = normalizeAuditUrl(item.url || "");
    const key = [item.strategy || "", item.source || "", url, item.fieldPath || ""].join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, url: url || undefined, pageUrl: item.pageUrl || pageUrl });
    if (out.length >= 240) break;
  }
  return out;
}

// Higher = more likely to be "the" video the user wants. Pages that scoop
// up every video_url JSON field (Threads feeds, AmusePlus news pages with
// comments) would otherwise drown the actual embed in noise.
function isCapturedVideoItem(item) {
  if (!item || item.kind === "image" || item.kind === "audio" || item.kind === "embed") return false;
  if (VIMEO_CONFIG_RE.test(item.url || "")) return true;
  return item.source === "network" ||
    item.source === "video-tag" ||
    item.kind === "hls" ||
    item.kind === "dash";
}

function itemPriority(item, preferCapturedMedia = false) {
  if (preferCapturedMedia && isCapturedVideoItem(item)) return 110;
  if (item.source === "youtube-hd-local") return 104;
  if (item.source === "iframe" || item.kind === "embed") return 100;
  if (item.source === "video-tag") return 80;
  if (item.kind === "hls" || item.kind === "dash") return 60;
  if (item.source === "yt-innertube-android") return 94;
  if (item.source === "youtube-hd-server") return 89;
  if (item.source === "yt-player-response") return 90;
  if (item.source === "bili-playinfo") return 90;
  if (item.source === "weibo-page") return 95;
  if (item.source === "japanese-page") return 92;
  if (item.source === "backend") return 95;
  if (item.source === "reddit-json") return item.kind === "image" ? 72 : 88;
  if (item.source === "network") return 40;
  if (item.source === "meta-json") return 30;  // common on Meta feeds; usually noise
  if (item.source === "og:video") return 70;
  // Images always rank below any video signal — defensive backstop in case
  // the host-scoped image scanners in content.js still capture something
  // unwanted. On image-host pages (IG/Pinterest/Reddit) the primary item
  // is usually the iframe/video at priority 100; images sit below it.
  if (item.kind === "image") return 25;
  return 50;
}

function helperAbsentFallbackScore(item) {
  if (!item || item.source === "youtube-hd-local" || item.source === "youtube-hd-server") return -1;
  if (item.source === "yt-innertube-android") return 100;
  if (item.source === "video-tag" && item.kind === "direct") return 90;
  if (VIMEO_CONFIG_RE.test(item.url || "")) return 88;
  if (item.kind === "direct" && /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(item.url || "")) return 85;
  if (item.source === "network" && item.kind === "direct") return 80;
  if (item.source === "reddit-json" && item.kind !== "image") return 78;
  if (item.kind === "hls" || item.kind === "dash" || item.kind === "paired") return 70;
  if (item.backendRouted || item.source === "backend") return 60;
  if (item.kind === "embed" || item.source === "iframe") return 50;
  if (item.source === "reddit-json" && item.kind === "image") return 35;
  if (item.kind === "audio") return 30;
  if (item.kind === "image") return 20;
  return 40;
}

function bestHelperAbsentFallback(tabId) {
  const state = tabState.get(tabId);
  const candidates = (state?.items || [])
    .map((item) => ({ item, score: helperAbsentFallbackScore(item) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => (b.score - a.score) || ((b.item.priority || 0) - (a.item.priority || 0)) || ((b.item.capturedAt || 0) - (a.item.capturedAt || 0)));
  return candidates[0]?.item || null;
}

function backendStrategyForItem(item, urlForBackend) {
  if (item.backendRouted) return "backend-extract";
  if (item.kind === "hls") return "backend-hls";
  if (item.kind === "dash") return "backend-dash";
  if (item.kind === "paired") return "backend-paired";
  if (item.kind === "embed") return "backend-embed";
  if (SERVER_ONLY_RE.test(item.url || urlForBackend)) return "backend-site-extractor";
  return "";
}

function preferRuntimeCapturedMedia(tabId, pageUrl) {
  if (tabId == null || !pageUrl) return;
  const s = ensureTab(tabId, pageUrl);
  s.preferCapturedMedia = true;
  s.items = s.items.map((item) => ({
    ...item,
    priority: itemPriority(item, true),
  }));
  s.items.sort((a, b) => (b.priority - a.priority) || (b.capturedAt - a.capturedAt));
}

function mediaKindForUrl(url) {
  if (VIMEO_CONFIG_RE.test(url)) return "direct";
  if (url.includes(".m3u8")) return "hls";
  if (url.includes(".mpd")) return "dash";
  if (IMAGE_EXT_RE.test(url)) return "image";
  if (AUDIO_EXT_RE.test(url)) return "audio";
  return "direct";
}

function mediaKindForResponse(url, contentType = "") {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("vnd.apple.mpegurl") || /\.m3u8(?:[?#]|$)/i.test(url)) return "hls";
  if (ct.includes("dash+xml") || /\.mpd(?:[?#]|$)/i.test(url)) return "dash";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("image/")) return "image";
  return mediaKindForUrl(url);
}

function isConcreteMediaUrl(url) {
  const u = String(url || "").toLowerCase().split("?")[0];
  return /\.(?:mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac)(?:$|[?#])/.test(u);
}

function isConcreteStreamUrl(url) {
  const u = String(url || "").toLowerCase().split("?")[0];
  return u.endsWith(".m3u8") || u.endsWith(".mpd") || isConcreteMediaUrl(url);
}

function isBilibiliNetworkNoise(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    // Bilibili pages fan out into many DASH video/audio segment URLs on
    // bilivideo/hdslb/upos mirrors. Those are not user-facing downloads: the
    // helper should download the page URL and choose/mux the real media.
    if (
      /(?:^|\.)bilivideo\.(?:com|cn)$/i.test(host) ||
      /(?:^|\.)hdslb\.com$/i.test(host) ||
      /^upos-[a-z0-9-]+/i.test(host) ||
      /(?:^|\.)akamaized\.net$/i.test(host) && /^upos-/i.test(host) ||
      /\/upgcxcode\//i.test(path) ||
      /\/live-bvc\//i.test(path) ||
      /\/bfs\//i.test(path)
    ) return true;
    if (/^(?:broadcast\.chat|api|api\.vc|data)\.bilibili\.com$/i.test(host)) return true;
    if (/^(?:api|api\.vc|data)\.bilibili\.com$/i.test(host)) return true;
    if (/(?:^|\.)biliapi\.(?:com|net)$/i.test(host)) return true;
    if (/\.(?:m4s|mp4|m4v|webm|mov|m3u8|mpd|mp3|m4a|aac)(?:$|[?#])/i.test(path)) return false;
    if (/^(?:api|api\.vc|data)\.bilibili\.com$/i.test(host)) return true;
    if (/^(?:i\d*|s\d*|archive)\.hdslb\.com$/i.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function replayHeadersObject(headers = []) {
  const out = {};
  for (const h of headers || []) {
    if (!h?.name || typeof h.value !== "string") continue;
    if (!REPLAY_HEADER_ALLOW_RE.test(h.name)) continue;
    out[h.name] = h.value;
  }
  return out;
}

function encodeReplayHeaders(headers = {}) {
  const clean = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!REPLAY_HEADER_ALLOW_RE.test(name)) continue;
    if (typeof value !== "string" || !value) continue;
    clean[name] = value;
  }
  const json = JSON.stringify(clean);
  if (json === "{}") return "";
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function isLikelyThumbnailUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!IMAGE_EXT_RE.test(u)) return false;
  if (/(?:^|[\/_.-])(?:thumb|thumbnail|avatar|profile(?:_pic)?|cover|poster)(?:[\/_.-]|$)/i.test(u)) return true;
  if (/[?&](?:thumb|thumbnail|preview|avatar|width|w|height|h)=/i.test(u)) return true;
  if (/(?:^|[\/_-])(?:\d{1,3}x\d{1,3}|s\d{2,4}x\d{2,4})(?:[\/_.-]|$)/i.test(u)) return true;
  return false;
}

function isXhsPageUrl(url) {
  try {
    return /(?:^|\.)(?:xiaohongshu|rednote)\.com$/i.test(new URL(url).hostname)
      || /(?:^|\.)xhslink\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isXhsExtractorItem(item) {
  return item?.source === "xhs-state" || item?.source === "xhs-page";
}

function xhsFallbackItem(pageUrl) {
  return {
    url: pageUrl,
    pageUrl,
    kind: "embed",
    source: "xhs-page",
    label: "Xiaohongshu",
    backendRouted: true,
  };
}

function isPageLevelMediaItem(item) {
  if (!item || item.source === "network") return false;
  if (item.source === "backend" || item.backendRouted) return true;
  if (item.source === "youtube-hd-local" || item.source === "youtube-hd-server") return true;
  if (item.source === "bili-playinfo" || item.source === "weibo-page" || item.source === "japanese-page") return true;
  if (item.source === "xhs-state" || item.source === "xhs-page") return true;
  if (item.kind === "embed" || item.source === "iframe") return true;
  return false;
}

function sameSiteHost(a, b) {
  try {
    const ah = new URL(a).hostname.toLowerCase();
    const bh = new URL(b).hostname.toLowerCase();
    return ah === bh || ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`);
  } catch {
    return false;
  }
}

function isLikelyCdnFragmentUrl(mediaUrl, pageUrl = "") {
  try {
    const parsed = new URL(mediaUrl);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const query = parsed.search.toLowerCase();
    if (isBilibiliNetworkNoise(mediaUrl)) return true;
    if (sameSiteHost(mediaUrl, pageUrl) && !/(?:segment|fragment|chunk|frag|hls|dash|m3u8|mpd|m4s)/i.test(path)) return false;
    if (/\.(?:m4s|m4a)(?:$|[?#])/i.test(path)) return true;
    if (/(?:^|[\/_.-])(?:seg(?:ment)?|frag(?:ment)?|chunk|part)[-_]?\d+/i.test(path)) return true;
    if (/[?&](?:range|rn|deadline|expires?|token|signature|sig|policy|x-amz-|hdnea|hdnts|bytestart|byteend)=/i.test(query)) return true;
    if (/(?:^|\.)((?:akamaized|akamaihd|cloudfront|fastly|edgesuite|edgekey|bilivideo|googlevideo|byteoversea|bytecdn|mcdn|cdn|vod|video-cdn)\.(?:net|com|cn)|.*(?:cdn|edge|cache|vod|media|video|stream).*)$/i.test(host) && !sameSiteHost(mediaUrl, pageUrl)) return true;
    return false;
  } catch {
    return false;
  }
}

function hasPageLevelMediaItem(state) {
  return Boolean(state?.items?.some(isPageLevelMediaItem));
}

function addTechnicalItem(state, item, reason = "technical source") {
  if (!state || !item?.url) return;
  const baseUrl = item.url.replace(/[?&]range=[^&]*/g, "").replace(/[?&]rn=[^&]*/g, "");
  if ((state.technicalItems || []).some((i) => i.url === baseUrl || i.url === item.url)) return;
  const tech = {
    ...item,
    url: baseUrl,
    reason,
    capturedAt: Date.now(),
    priority: itemPriority(item, state.preferCapturedMedia),
  };
  state.technicalItems = [tech, ...(state.technicalItems || [])].slice(0, 30);
  state.updatedAt = Date.now();
}

function pruneXhsTabState(tabId, pageUrl) {
  if (tabId == null || !isXhsPageUrl(pageUrl)) return [];
  const s = ensureTab(tabId, pageUrl);
  s.items = s.items.filter(isXhsExtractorItem);
  if (!s.items.length) {
    const item = xhsFallbackItem(pageUrl);
    s.items.push({ ...item, capturedAt: Date.now(), priority: itemPriority(item, s.preferCapturedMedia) });
  }
  s.updatedAt = Date.now();
  updateBadge(tabId, s.items.length);
  return s.items;
}

function addItem(tabId, pageUrl, item) {
  const s = ensureTab(tabId, pageUrl);
  if (!item || !item.url) return;
  if (isXhsPageUrl(pageUrl) && item.source === "network") return;
  if (item.source === "network" && hasPageLevelMediaItem(s) && isLikelyCdnFragmentUrl(item.url, pageUrl)) {
    addTechnicalItem(s, item, "Hidden because a better page-level media item exists");
    return;
  }
  if (isBilibiliPageUrl(pageUrl) && item.source === "network" && isBilibiliNetworkNoise(item.url)) {
    addTechnicalItem(s, item, "Bilibili CDN/audio/video fragment");
    return;
  }
  if (item.kind === "image" && isLikelyThumbnailUrl(item.url)) return;
  auditSourceCandidate(tabId, pageUrl, {
    url: item.url,
    strategy: item.source === "network" ? "network-request" : "dom-source",
    source: item.source || "detected-media",
    mimeType: item.mime || item.mimeType,
    width: item.width,
    height: item.height,
    selected: true,
  });
  if (item.source === "weibo-page" || item.source === "japanese-page" || /(?:^|\.)weibo\.(?:com|cn)\//i.test(item.url)) {
    s.items = s.items.filter((i) => !(i.kind === "image" || i.source === "network" || i.source === "image-tag"));
  }
  if (isXhsPageUrl(pageUrl) && isXhsExtractorItem(item)) {
    s.items = s.items.filter((i) => isXhsExtractorItem(i));
  }
  if (isPageLevelMediaItem(item)) {
    const kept = [];
    for (const existing of s.items) {
      if (existing.source === "network" && isLikelyCdnFragmentUrl(existing.url, pageUrl)) {
        addTechnicalItem(s, existing, "Hidden because a better page-level media item exists");
      } else {
        kept.push(existing);
      }
    }
    s.items = kept;
  }
  // De-dupe by URL (strip range / rn so byte-segment requests collapse onto
  // their master URL).
  const baseUrl = item.url.replace(/[?&]range=[^&]*/g, "").replace(/[?&]rn=[^&]*/g, "");
  if (s.items.find((i) => i.url === baseUrl || i.url === item.url)) return;
  const enriched = { ...item, url: baseUrl, capturedAt: Date.now(), priority: itemPriority(item, s.preferCapturedMedia) };
  s.items.push(enriched);
  // Sort by priority desc, then by recency desc. Cap so feed-noise sites
  // don't fill the popup with dozens of low-relevance URLs.
  s.items.sort((a, b) => (b.priority - a.priority) || (b.capturedAt - a.capturedAt));
  s.items = s.items.slice(0, 10);
  s.updatedAt = Date.now();
  updateBadge(tabId, s.items.length);
}

function updateBadge(tabId, count) {
  try {
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#222222" });
  } catch {}
}

// ── webRequest interception — catches segment URLs the DOM doesn't show ───
//
// MV3 forbids blocking webRequest in production, but onCompleted (non-blocking
// observation) is allowed and gives us exactly what we need. Guarded by a
// try/catch + null check because the API may be missing if the webRequest
// permission isn't granted (or the user is on a fork that strips it).
try {
  if (chrome.webRequest?.onBeforeSendHeaders) {
    const capture = (details) => {
      if (!details.tabId || details.tabId < 0 || !details.url || !isLikelyMedia(details.url)) return;
      const headers = replayHeadersObject(details.requestHeaders || []);
      if (!Object.keys(headers).length) return;
      requestHeadersByUrl.set(details.url, { headers, ts: Date.now() });
      if (requestHeadersByUrl.size > 300) {
        const cutoff = Date.now() - 5 * 60_000;
        for (const [key, value] of requestHeadersByUrl) {
          if (value.ts < cutoff || requestHeadersByUrl.size > 240) requestHeadersByUrl.delete(key);
        }
      }
    };
    try {
      chrome.webRequest.onBeforeSendHeaders.addListener(
        capture,
        { urls: ["<all_urls>"] },
        ["requestHeaders", "extraHeaders"],
      );
    } catch {
      chrome.webRequest.onBeforeSendHeaders.addListener(
        capture,
        { urls: ["<all_urls>"] },
        ["requestHeaders"],
      );
    }
  }
  if (chrome.webRequest?.onCompleted) {
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (!details.tabId || details.tabId < 0) return;
        const u = details.url;
        if (!u || u.length < 12) return;
        if (isBilibiliNetworkNoise(u)) {
          chrome.tabs.get(details.tabId).then((tab) => {
            if (!tab?.url) return;
            const state = ensureTab(details.tabId, tab.url);
            addTechnicalItem(state, {
              url: u,
              kind: mediaKindForUrl(u),
              source: "network",
            }, "Bilibili CDN/audio/video fragment");
          }).catch(() => {});
          return;
        }
        const contentType = details.responseHeaders?.find((h) => /content-type/i.test(h.name))?.value || "";
        const mediaByType = NETWORK_CAPTURE_MEDIA_TYPES.some((type) =>
          contentType.toLowerCase().startsWith(type.toLowerCase())
        );
        const imageByType = /^image\//i.test(contentType) || IMAGE_EXT_RE.test(u);
        if (!isLikelyMedia(u) && !mediaByType && !imageByType) return;

        chrome.tabs.get(details.tabId).then((tab) => {
          if (!tab?.url) return;
          if (isXhsPageUrl(tab.url)) return;
          const replay = requestHeadersByUrl.get(u)?.headers || {};
          const width = Number(details.responseHeaders?.find((h) => /^x-fcdl-video-width$/i.test(h.name))?.value || 0);
          const height = Number(details.responseHeaders?.find((h) => /^x-fcdl-video-height$/i.test(h.name))?.value || 0);
          const contentLength = Number(details.responseHeaders?.find((h) => /^content-length$/i.test(h.name))?.value || 0);
          if (isSupportedAuditPage(tab.url) && (imageByType || isLikelyMedia(u) || mediaByType)) {
            auditSourceCandidate(details.tabId, tab.url, {
              url: u,
              strategy: "network-request",
              source: "chrome.webRequest",
              mimeType: contentType,
              status: details.statusCode,
              contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined,
              width: Number.isFinite(width) && width > 0 ? width : undefined,
              height: Number.isFinite(height) && height > 0 ? height : undefined,
              selected: false,
            });
          }
          if (!isLikelyMedia(u) && !mediaByType) return;
          addItem(details.tabId, tab.url, {
            url: u,
            kind: mediaKindForResponse(u, contentType),
            source: "network",
            headers: replay,
            mime: contentType,
            width: Number.isFinite(width) && width > 0 ? width : undefined,
            height: Number.isFinite(height) && height > 0 ? height : undefined,
          });
        }).catch(() => {});
      },
      { urls: ["<all_urls>"] },
      ["responseHeaders"],
    );
    debugLog("[fcdl] webRequest listener registered");
  } else {
    debugWarn("[fcdl] chrome.webRequest unavailable — install permission missing?");
  }
} catch (e) {
  debugWarn("[fcdl] webRequest setup failed:", e);
}

function isLikelyMedia(url) {
  const u = url.toLowerCase().split("?")[0];
  if (isBilibiliNetworkNoise(url)) return false;
  if (VIMEO_CONFIG_RE.test(url)) return true;
  if (u.endsWith(".m3u8") || u.endsWith(".mpd")) return true;
  if (u.endsWith(".mp4") || u.endsWith(".webm") || u.endsWith(".mov")) return true;
  // Network-level image captures are overwhelmingly thumbnails, avatars, and
  // previews. Dedicated page/gallery extractors can still return real images.
  if (IMAGE_EXT_RE.test(u)) return false;
  if (AUDIO_EXT_RE.test(u)) return true;
  // Known video CDNs (no extension)
  if (/googlevideo\.com\/videoplayback/.test(url)) {
    return false;
  }
  if (/(?:video\.twimg\.com|cdninstagram\.com|scontent[-\w]*\.cdninstagram\.com|fbcdn\.net|threadscdn\.com|(?:v|i|preview)\.redd\.it|tiktokcdn\.com|v\d+-webapp\.tiktok\.com|bilivideo\.(?:com|cn)|ci\.xiaohongshu\.com|weibocdn\.com|xhscdn\.com|dmcdn\.net|pinimg\.com\/(?:videos|originals|736x|1200x|564x)|vimeocdn\.com|nicovideo\.cdn\.nimg\.jp|dmc\.nico|nimg\.jp|abema(?:tv)?\.akamaized\.net|linear-abematv\.akamaized\.net|vod-abematv\.akamaized\.net|brightcove\.net|boltdns\.net|bcovlive-a\.akamaihd\.net)/.test(url)) {
    return true;
  }
  if (RUNTIME_CAPTURE_HOST_RE.test(url)) return true;
  return false;
}

// ── Cookies forwarding ────────────────────────────────────────────────────

async function cookieHeaderFor(url) {
  try {
    const { allowCookies } = await getSettings();
    if (!allowCookies) return "";

    if (/(?:youtube\.com|youtu\.be|googlevideo\.com)/i.test(url || "")) {
      return youtubeCookieHeader();
    }
    // XHS rebranded internationally as rednote.com — login session lives under
    // xiaohongshu.com (and vice versa). Merge cookies from both domains so the
    // server can authenticate against the XHS API regardless of which surface
    // the user is browsing on.
    if (/(?:xiaohongshu\.com|rednote\.com|xhscdn\.com|xhslink\.com)/i.test(url || "")) {
      return xhsCookieHeader();
    }
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    // Format as Cookie: name=value; name=value
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

// Remote-cookie consent must not disable authentication for the local
// companion. These cookies stay on loopback and let sites such as Bilibili
// expose clean HD streams instead of anonymous watermarked previews.
async function localHelperCookieHeaderFor(url) {
  try {
    if (/(?:youtube\.com|youtu\.be|googlevideo\.com)/i.test(url || "")) {
      return youtubeCookieHeader();
    }
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

async function xhsCookieHeader() {
  try {
    const byName = new Map();
    for (const url of [
      "https://www.xiaohongshu.com/",
      "https://xiaohongshu.com/",
      "https://www.rednote.com/",
      "https://rednote.com/",
    ]) {
      const cookies = await chrome.cookies.getAll({ url }).catch(() => []);
      for (const c of cookies || []) byName.set(c.name, c.value);
    }
    for (const domain of ["xiaohongshu.com", ".xiaohongshu.com", "rednote.com", ".rednote.com"]) {
      const cookies = await chrome.cookies.getAll({ domain }).catch(() => []);
      for (const c of cookies || []) byName.set(c.name, c.value);
    }
    return Array.from(byName, ([name, value]) => `${name}=${value}`).join("; ");
  } catch {
    return "";
  }
}

async function youtubeCookieHeader() {
  try {
    const byName = new Map();
    for (const url of ["https://www.youtube.com/", "https://youtube.com/"]) {
      const cookies = await chrome.cookies.getAll({ url }).catch(() => []);
      for (const c of cookies || []) {
        byName.set(c.name, c.value);
      }
    }
    for (const domain of ["youtube.com", ".youtube.com"]) {
      const cookies = await chrome.cookies.getAll({ domain }).catch(() => []);
      for (const c of cookies || []) {
        byName.set(c.name, c.value);
      }
    }
    return Array.from(byName, ([name, value]) => `${name}=${value}`).join("; ");
  } catch {
    return "";
  }
}

// ── Settings ──────────────────────────────────────────────────────────────

async function getSettings() {
  const stored = await chrome.storage.sync.get({
    backend: "",
    muxRemote: true,
    allowCookies: false,
    removeWatermark: false,
  });
  return {
    backend: (stored.backend || DEFAULT_BACKEND).trim().replace(/\/+$/, ""),
    muxRemote: stored.muxRemote !== false,
    allowCookies: stored.allowCookies === true,
    removeWatermark: stored.removeWatermark === true,
  };
}

// ── Backend extract ───────────────────────────────────────────────────────

async function callExtract(pageUrl, referer, cookies, pageHtml, mediaHints, sourceAudit) {
  const { backend, removeWatermark } = await getSettings();
  if (!backend) {
    throw new Error(
      "Backend URL is not configured. Open the extension options and set one (e.g. https://your-instance.fly.dev)."
    );
  }
  const body = { pageUrl };
  if (referer) body.referer = referer;
  if (cookies) body.cookies = cookies;
  if (pageHtml) body.pageHtml = pageHtml;
  if (Array.isArray(mediaHints) && mediaHints.length) body.mediaHints = mediaHints.slice(0, 20);
  if (Array.isArray(sourceAudit) && sourceAudit.length) body.sourceAudit = sourceAudit.slice(0, 240);
  if (removeWatermark) body.removeWatermark = true;

  // Hard-cap the request. removeWatermark can try a source-derived URL,
  // snapwc, and then the normal extractor fallback, so give it more room.
  const ac = new AbortController();
  const timeoutMs = removeWatermark ? 45_000 : 25_000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(`${backend}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} — ${text.slice(0, 240)}`);
    }
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Backend timed out after ${Math.round(timeoutMs / 1000)}s. The site probably blocked the server, or yt-dlp can't extract it. Check fly logs for the real reason.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function backendDownloadUrl(backend, pageUrl, referer, replayHeaders, options = {}) {
  const p = new URLSearchParams({ url: pageUrl });
  if (referer) p.set("referer", referer);
  if (options.audioOnly) p.set("audioOnly", "1");
  const encodedHeaders = encodeReplayHeaders(replayHeaders);
  if (encodedHeaders) p.set("headers", encodedHeaders);
  return `${backend}/download?${p.toString()}`;
}

async function pageHtmlForTab(tabId, pageUrl) {
  try {
    const host = new URL(pageUrl).hostname;
    if (!PAGE_HTML_RE.test(host) && !SERVER_ONLY_RE.test(pageUrl) && !RUNTIME_CAPTURE_HOST_RE.test(pageUrl)) return "";
  } catch {
    return "";
  }
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "fcdl:get_page_html" });
    return resp?.ok && typeof resp.pageHtml === "string" ? resp.pageHtml : "";
  } catch {
    return "";
  }
}

function extractAuditCandidatesFromHtml(pageUrl, pageHtml) {
  if (!pageHtml || !isSupportedAuditPage(pageUrl)) return [];
  const html = String(pageHtml).slice(0, 1_500_000);
  const out = [];
  const seen = new Set();
  const add = (url, strategy, source, fieldPath) => {
    url = normalizeAuditUrl(url);
    if (!/^https?:\/\//i.test(url)) return;
    if (!/(?:\.(?:m3u8|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)|(?:(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|sinaimg\.cn|weibocdn\.com|xhscdn\.com|ci\.xiaohongshu\.com|bilivideo\.(?:com|cn)|hdslb\.com|biliimg\.com|pstatic\.net|pximg\.net|kakaocdn\.net|daumcdn\.net|cdninstagram\.com|fbcdn\.net|threadscdn\.com))/i.test(url)) return;
    if (/(?:avatar|profile|emoji|sprite|favicon|tracking|pixel|blank)/i.test(url)) return;
    const key = `${strategy}\n${source}\n${url.replace(/\?.*$/, "")}\n${fieldPath || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, strategy, source, fieldPath, pageUrl, selected: false });
  };

  const metaRe = /<meta\s[^>]*(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null && out.length < 160) {
    add(m[2], "embedded-metadata", "meta-tag", m[1]);
  }
  const urlRe = /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:\.(?:m3u8|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)|(?:(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|fod-sp\.fujitv\.co\.jp|free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|sinaimg\.cn|weibocdn\.com|xhscdn\.com|ci\.xiaohongshu\.com|bilivideo\.(?:com|cn)|hdslb\.com|biliimg\.com|pstatic\.net|pximg\.net|kakaocdn\.net|daumcdn\.net|cdninstagram\.com|fbcdn\.net|threadscdn\.com))[^"'\\<>\s]*)/gi;
  while ((m = urlRe.exec(html)) !== null && out.length < 240) {
    add(m[1], "embedded-metadata", "html-url-regex", "document");
  }
  return out;
}

function mediaHintsForTab(tabId) {
  const state = tabId != null ? tabState.get(tabId) : null;
  return (state?.items || [])
    .filter((item) => isConcreteStreamUrl(item.url || "") && item.source !== "backend")
    .slice(0, 20)
    .map((item) => ({
      url: item.url,
      kind: item.kind,
      title: item.title,
      referer: item.referer || item.pageUrl || state.pageUrl,
      headers: item.headers || {},
    }));
}

function cookieHeaderList(cookies) {
  return cookies ? [{ name: "X-FCDL-Cookies", value: cookies }] : [];
}

function isBilibiliPageUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith("bilibili.com") || host === "b23.tv" || host.endsWith("bilibili.tv");
  } catch {
    return /(?:bilibili\.com|b23\.tv|bilibili\.tv)/i.test(String(url || ""));
  }
}

function localHelperDownloadUrl(pageUrl, youtubeOnly = false, options = {}) {
  const params = new URLSearchParams({ url: pageUrl });
  if (!youtubeOnly) params.set("max_height", "1080");
  if (options.removeWatermark) params.set("remove_watermark", "1");
  return `http://127.0.0.1:8765/${youtubeOnly ? "youtube-hd" : "download"}?${params.toString()}`;
}

function isPageLikeDownloadUrl(url) {
  const value = String(url || "");
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (/\.(?:html?|php|aspx?|jsp)(?:$|[?#])/i.test(parsed.pathname)) return true;
    if (!isConcreteStreamUrl(value) && (PAGE_HTML_RE.test(parsed.hostname) || SERVER_ONLY_RE.test(value))) return true;
  } catch {
    if (/\.(?:html?|php|aspx?|jsp)(?:$|[?#])/i.test(value)) return true;
  }
  return false;
}

function decodeWeiboMediaUrl(raw) {
  let url = String(raw || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\")
    .replace(/&amp;/g, "&")
    .trim()
    .replace(/^http:\/\//i, "https://");
  if (url.startsWith("//")) url = `https:${url}`;
  return url.replace(
    /\/\/([^/]+\.sinaimg\.cn)\/(?:thumb\d+|thumbnail|square|orj\d+|mw\d+|bmiddle|large)\//i,
    "//$1/original/",
  );
}

const WEIBO_CDN_VARIANTS = ["original", "woriginal", "large", "mw2000", "mw1024", "mw690", "orj960", "orj720", "orj480", "orj360", "bmiddle", "oslarge"];

function weiboAuditFromUrls(pageUrl, urls, source, fieldPath = "weibo-image-url") {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const selectedUrl = decodeWeiboMediaUrl(raw);
    for (const url of [selectedUrl, ...WEIBO_CDN_VARIANTS.map((variant) =>
      selectedUrl.replace(/\/\/([^/]+\.sinaimg\.cn)\/(?:thumb\d+|thumbnail|square|orj\d+|mw\d+|bmiddle|large|original|woriginal|oslarge)\//i, `//$1/${variant}/`)
    )]) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        strategy: url === selectedUrl ? source : "cdn-variant",
        source: url === selectedUrl ? "weibo-client" : "weibo-cdn",
        fieldPath,
        pageUrl,
        selected: url === selectedUrl,
        notes: url === selectedUrl ? "Selected by extension extraction." : "Generated from known Weibo CDN size path.",
      });
    }
  }
  return out;
}

function extractWeiboGalleryFromHtml(pageUrl, pageHtml) {
  if (!/(?:^|\/\/)(?:m\.)?weibo\.(?:com|cn)\//i.test(pageUrl || "")) return null;
  const html = String(pageHtml || "");
  if (!html) return null;

  const titleMatch = html.match(/<meta\s[^>]*?(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*?content=["']([^"']+)["']/i);
  const title = titleMatch?.[1]
    ? titleMatch[1].replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim()
    : "Weibo";

  const urls = [];
  const seen = new Set();
  const imageRe = /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:sinaimg\.cn|weibocdn\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp|gif|heic)(?:\?[^"'\\<>\s]*)?)/gi;
  let m;
  while ((m = imageRe.exec(html)) !== null && urls.length < 40) {
    const url = decodeWeiboMediaUrl(m[1]);
    const lowered = url.toLowerCase();
    if (/(?:avatar|profile|icon|emoji|face|card)/i.test(lowered)) continue;
    const key = url.replace(/\?.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }

  if (!urls.length) return null;
  return {
    kind: "gallery",
    title,
    count: urls.length,
    sourceAudit: weiboAuditFromUrls(pageUrl, urls, "html-metadata", "rendered-html"),
    items: urls.map((url, idx) => {
      const ext = (url.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1] || "jpg").toLowerCase();
      return {
        kind: "image",
        url,
        ext,
        mimeType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg",
        title: `${title} #${idx + 1}`,
        headers: {
          Referer: pageUrl,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        },
        extractor: "weibo-extension",
      };
    }),
  };
}

// ── Download orchestration ────────────────────────────────────────────────


// Preflight a backend /download URL: fetch the headers, abort the body. If
// the server is going to respond with JSON (its error format), we return the
// error text instead of saving garbage as a .mp4.
function weiboIdFromUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (/video\.weibo\.com$/i.test(u.hostname)) return u.searchParams.get("fid") || "";
    if (parts[0] === "tv" && parts[1] === "show") return parts.slice(2).join("/");
    if (/m\.weibo\.cn$/i.test(u.hostname) && ["status", "detail"].includes(parts[0])) return parts[1] || "";
    if (/weibo\.com$/i.test(u.hostname) && parts.length >= 2) return parts[1] || "";
  } catch {}
  return "";
}

function weiboGalleryFromStatus(pageUrl, status) {
  const meta = status?.data && typeof status.data === "object" ? status.data : status;
  if (!meta || typeof meta !== "object") return null;
  const pics = Array.isArray(meta.pics) ? meta.pics : [];
  const urls = [];
  const seen = new Set();
  for (const pic of pics) {
    const raw = pic?.largest?.url || pic?.large?.url || pic?.original?.url || pic?.url || "";
    const url = decodeWeiboMediaUrl(raw);
    if (!url || !/\.(?:jpe?g|png|webp|gif|heic)(?:[?#]|$)/i.test(url)) continue;
    const key = url.replace(/\?.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  if (!urls.length && typeof meta.original_pic === "string") {
    urls.push(decodeWeiboMediaUrl(meta.original_pic));
  }
  if (!urls.length) return null;
  const title = String(meta.text_raw || meta.text || "Weibo").replace(/<[^>]+>/g, "").trim() || "Weibo";
  return {
    kind: "gallery",
    title,
    count: urls.length,
    sourceAudit: weiboAuditFromUrls(pageUrl, urls, "mobile-endpoint", "statuses/show.pics"),
    cleanSourceStatus: "not_found_in_status_api",
    items: urls.map((url, idx) => {
      const ext = (url.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1] || "jpg").toLowerCase();
      return {
        kind: "image",
        url,
        ext,
        mimeType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg",
        title: `${title} #${idx + 1}`,
        headers: { Referer: pageUrl },
        extractor: "weibo-extension",
      };
    }),
  };
}

function weiboPhotoPageTargets(pageUrl, status) {
  const meta = status?.data && typeof status.data === "object" ? status.data : status;
  if (!meta || typeof meta !== "object") return [];
  const uid = String(meta.user?.id || meta.user?.idstr || "").trim();
  const mid = String(meta.mid || meta.id || meta.idstr || weiboIdFromUrl(pageUrl) || "").trim();
  if (!uid || !mid) return [];
  const pids = [];
  for (const pic of Array.isArray(meta.pics) ? meta.pics : []) {
    if (pic?.pid) pids.push(String(pic.pid));
  }
  return pids.slice(0, 9).map((pid, idx) => ({
    pid,
    index: idx,
    url: `https://photo.weibo.com/${encodeURIComponent(uid)}/wbphotos/large/mid/${encodeURIComponent(mid)}/pid/${encodeURIComponent(pid)}`,
  }));
}

function weiboImageUrlsFromText(text) {
  const urls = [];
  const seen = new Set();
  const re = /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:sinaimg\.cn|weibocdn\.com)[^"'\\<>\s]*\.(?:jpe?g|png|webp|gif|heic)(?:\?[^"'\\<>\s]*)?)/gi;
  let m;
  while ((m = re.exec(String(text || ""))) !== null && urls.length < 80) {
    const url = decodeWeiboMediaUrl(m[1]);
    if (/(?:avatar|profile|icon|emoji|face|card)/i.test(url)) continue;
    const key = url.replace(/\?.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

async function augmentWeiboGalleryWithPhotoPages(pageUrl, status, gallery) {
  const targets = weiboPhotoPageTargets(pageUrl, status);
  if (!gallery || !targets.length) return gallery;
  const audit = Array.isArray(gallery.sourceAudit) ? [...gallery.sourceAudit] : [];
  const existing = new Set((gallery.items || []).map((item) => String(item.url || "").replace(/\?.*$/, "")));
  const discovered = [];
  for (const target of targets) {
    try {
      const r = await fetch(target.url, {
        credentials: "include",
        headers: { Accept: "text/html,application/xhtml+xml,*/*" },
      });
      const text = await r.text().catch(() => "");
      const urls = weiboImageUrlsFromText(text);
      audit.push({
        url: target.url,
        strategy: "archive-source-platform-lookup",
        source: "photo.weibo.com",
        fieldPath: `pics[${target.index}].pid`,
        status: r.status,
        selected: false,
        notes: urls.length
          ? `Photo page exposed ${urls.length} image URL(s).`
          : "Photo page did not expose image URLs, or redirected to visitor/login HTML.",
      });
      for (const url of urls) {
        audit.push(...weiboAuditFromUrls(pageUrl, [url], "archive-source-platform-lookup", `photo.weibo.com:${target.pid}`));
        const key = url.replace(/\?.*$/, "");
        if (!existing.has(key)) {
          existing.add(key);
          discovered.push({ url, sourcePid: target.pid });
        }
      }
    } catch (e) {
      audit.push({
        url: target.url,
        strategy: "archive-source-platform-lookup",
        source: "photo.weibo.com",
        fieldPath: `pics[${target.index}].pid`,
        selected: false,
        notes: `Photo page probe failed: ${String(e?.message || e).slice(0, 180)}`,
      });
    }
  }
  gallery.sourceAudit = audit;
  gallery.cleanSourceStatus = discovered.length ? "alternate_photo_page_candidates_found" : "not_found_after_photo_page_probe";
  return gallery;
}

async function extractWeiboGalleryViaApi(pageUrl) {
  if (!/(?:^|\/\/)(?:m\.)?weibo\.(?:com|cn)\//i.test(pageUrl || "")) return null;
  const id = weiboIdFromUrl(pageUrl);
  if (!id) return null;
  for (const apiUrl of [
    `https://m.weibo.cn/statuses/show?id=${encodeURIComponent(id)}`,
    `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(id)}`,
  ]) {
    try {
      const r = await fetch(apiUrl, {
        credentials: "include",
        headers: { Accept: "application/json,text/plain,*/*" },
      });
      if (!r.ok) continue;
      const status = await r.json();
      const gallery = weiboGalleryFromStatus(pageUrl, status);
      if (gallery) return await augmentWeiboGalleryWithPhotoPages(pageUrl, status, gallery);
    } catch (e) {
      debugWarn("[fcdl] local Weibo API failed:", e?.message || e);
    }
  }
  return null;
}

function backendErrorMessage(body, fallback = "") {
  const text = String(body || "").trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail ?? parsed?.error;
    if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 240);
  } catch {}
  return text.slice(0, 240);
}

function fetchHeadersFromChromeHeaders(headers = []) {
  const out = new Headers();
  const forbidden = /^(cookie|host|origin|referer|user-agent|content-length)$/i;
  for (const h of headers) {
    if (h?.name && typeof h.value === "string" && !forbidden.test(h.name)) {
      out.set(h.name, h.value);
    }
  }
  return out;
}

async function preflightBackendUrl(url, headers = []) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, 85_000);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: fetchHeadersFromChromeHeaders(headers),
      signal: ac.signal,
    });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      ac.abort();
      return { ok: false, error: backendErrorMessage(body, `HTTP ${r.status}`) };
    }
    if (PREFLIGHT_MEDIA_TYPES.some((type) => ct.startsWith(type))) {
      ac.abort();  // abort the body; chrome.downloads will fetch fresh
      return { ok: true };
    }
    // It's some other content-type — almost certainly the error JSON FastAPI
    // returns when yt-dlp fails. Read it so we can show the message.
    const body = await r.text().catch(() => "");
    return { ok: false, error: backendErrorMessage(body, ct || "Unexpected response") };
  } catch (e) {
    if (timedOut) return { ok: false, error: "Backend took too long to respond. It may be struggling to extract this media." };
    if (e.name === "AbortError") return { ok: true };  // we aborted on success
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function preflightDirectUrl(url, headers = []) {
  const ac = new AbortController();
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: fetchHeadersFromChromeHeaders(headers),
      signal: ac.signal,
    });
    const ct = r.headers.get("content-type") || "";
    const len = Number(r.headers.get("content-length") || "0");
    ac.abort();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    if (/^(text\/html|application\/xhtml\+xml|application\/json)\b/i.test(ct)) {
      return { ok: false, error: ct || "page response" };
    }
    if (/^(video|audio|image)\//i.test(ct) || len > 1024) return { ok: true };
    return { ok: false, error: ct || "not a media response" };
  } catch (e) {
    if (e.name === "AbortError") return { ok: true };
    return { ok: false, error: String(e.message || e) };
  }
}

async function preflightLocalHelperUrl(url, headers = []) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  try {
    const parsed = new URL(url);
    const mediaUrl = parsed.searchParams.get("url") || "";
    const checkUrl = `http://127.0.0.1:8765/formats?${new URLSearchParams({ url: mediaUrl }).toString()}`;
    const r = await fetch(checkUrl, {
      method: "GET",
      headers: fetchHeadersFromChromeHeaders(headers),
      signal: ac.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.ok === false) {
      return { ok: false, error: data?.error || `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLocalHelperHealth(timeoutMs = LOCAL_HELPER_STATUS_TIMEOUT_MS) {
  const info = await fetchLocalHelperInfo(timeoutMs);
  return localHelperReady(info);
}

async function fetchLocalHelperInfo(timeoutMs = LOCAL_HELPER_STATUS_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const health = await fetch("http://127.0.0.1:8765/health", {
      method: "GET",
      signal: ac.signal,
    });
    const data = await health.json().catch(() => ({}));
    if (!health.ok || data?.ok === false) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseHelperVersion(version) {
  const m = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map((part) => Number(part) || 0) : null;
}

function helperVersionAtLeast(version, minimum = LOCAL_HELPER_MIN_VERSION) {
  const got = parseHelperVersion(version);
  const min = parseHelperVersion(minimum);
  if (!got || !min) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i] > min[i]) return true;
    if (got[i] < min[i]) return false;
  }
  return true;
}

function localHelperReady(health) {
  return Boolean(health?.ok && helperVersionAtLeast(health.version));
}

function localHelperProblem(health) {
  if (!health?.ok) return "Companion is not running.";
  if (!helperVersionAtLeast(health.version)) {
    return `Companion is outdated (${health.version || "unknown"}). Update FCDownloader Companion to ${LOCAL_HELPER_MIN_VERSION} or newer.`;
  }
  return "";
}

async function ensureLocalHelperTools(timeoutMs = 10 * 60 * 1000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch("http://127.0.0.1:8765/tools/ensure", {
      method: "GET",
      signal: ac.signal,
    });
    const data = await response.json().catch(() => ({}));
    return response.ok && data?.ok !== false
      ? { ok: true, health: await fetchLocalHelperInfo(LOCAL_HELPER_STATUS_TIMEOUT_MS), tools: data.tools || [] }
      : { ok: false, error: data?.error || `HTTP ${response.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForLocalHelper(timeoutMs = LOCAL_HELPER_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchLocalHelperHealth(LOCAL_HELPER_STATUS_TIMEOUT_MS)) return true;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

async function launchLocalCompanion() {
  try {
    await chrome.tabs.create({
      url: "fcdownloader-companion://start",
      active: false,
    });
    return true;
  } catch (e) {
    debugWarn("[fcdl] companion launch failed:", e?.message || e);
    return false;
  }
}

async function downloadItem(tabId, item) {
  if (item?.kind === "image" && isLikelyThumbnailUrl(item.url)) {
    throw new Error("Skipping thumbnail image.");
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const tabPageUrl = tab?.url || "";
  const tabTitle = tab?.title || "";

  // For backendRouted items (popup-resolved /extract results), item.pageUrl
  // is the actual URL we sent to /extract (e.g. https://player.vimeo.com/...),
  // and we MUST send the same URL to /download for the cache to hit and for
  // yt-dlp to take the same path.
  //
  // For content-script-detected items (iframe / video tag), the *video* URL
  // is item.url — that's what yt-dlp can extract. The TAB url (e.g.
  // https://amuseplus.jp/...) is just the embedding page; yt-dlp has no
  // extractor for it. Sending the tab URL to backend was the bug.
  const urlForBackend = item.backendRouted
    ? item.pageUrl
    : (item.url || item.pageUrl || tabPageUrl);
  const referer = item.referer || item.pageUrl || tabPageUrl || null;
  const downloadPageUrl = item.pageUrl || referer || urlForBackend || tabPageUrl;
  const cookieSourceUrl = referer || urlForBackend;
  const cookies = await cookieHeaderFor(cookieSourceUrl);
  const localHelperCookies = await localHelperCookieHeaderFor(cookieSourceUrl);
  const { backend, removeWatermark } = await getSettings();

  debugLog("[fcdl] download", {
    item_url: (item.url || "").slice(0, 80),
    sent_url: (urlForBackend || "").slice(0, 80),
    referer: (referer || "").slice(0, 80),
    cookies_chars: cookies.length,
    backendRouted: !!item.backendRouted,
    kind: item.kind,
  });

  async function viaBackend(pageForBackend) {
    if (!backend) {
      throw new Error("Backend URL is not configured.");
    }
    const dlUrl = backendDownloadUrl(backend, pageForBackend, referer, item.headers || null, {
      audioOnly: item.audioOnly,
    });
    const headers = cookieHeaderList(cookies);
    debugLog("[fcdl] → backend for", (pageForBackend || "").slice(0, 100), "cookies?", !!cookies);
    const check = await preflightBackendUrl(dlUrl, headers);
    if (!check.ok) {
      throw new Error(`Backend: ${check.error}`);
    }
    return chromeDownload(dlUrl, suggestedFilename(item, urlForBackend, tabTitle), headers);
  }

  async function viaProxy(sourceUrl) {
    if (!backend) {
      throw new Error("Backend URL is not configured.");
    }
    const filename = suggestedFilename(item, downloadPageUrl, tabTitle);
    const proxied = await buildProxiedUrl(
      { ...item, url: sourceUrl },
      { referer, cookies, filename },
    );
    const check = await preflightBackendUrl(proxied, cookieHeaderList(cookies));
    if (!check.ok) throw new Error(`Proxy: ${check.error}`);
    return chromeDownload(proxied, filename, cookieHeaderList(cookies));
  }

  const capturedConcreteMedia =
    (isConcreteMediaUrl(item.url) || (item.kind === "direct" && isLikelyMedia(item.url || ""))) &&
    (item.source === "network" || item.source === "video-tag" || item.source === "meta-json");
  const backendStrategy = backendStrategyForItem(item, urlForBackend);

  const hasReplayHeaders = Boolean(item.headers && Object.keys(item.headers).length);
  const isYoutubeHdHelperItem = item.source === "youtube-hd-local" || item.source === "youtube-hd-server";
  const helperTarget = isYoutubeHdHelperItem
    ? (item.pageUrl || tabPageUrl || item.url)
    : (item.kind === "embed" || item.source === "iframe" || item.backendRouted || SERVER_ONLY_RE.test(downloadPageUrl || "")
      ? (downloadPageUrl || urlForBackend)
      : (urlForBackend || downloadPageUrl));
  const isBilibiliHelperTarget = isBilibiliPageUrl(helperTarget);
  const helperHeaders = cookieHeaderList(localHelperCookies);
  const helperCanTry =
    item.kind !== "image" &&
    helperTarget &&
    /^https?:\/\//i.test(helperTarget) &&
    !/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i.test(helperTarget) &&
    (!cookies || isYoutubeHdHelperItem || isBilibiliHelperTarget) &&
    (!hasReplayHeaders || isYoutubeHdHelperItem);

  const routes = [];
  const addRoute = (name, enabled, run) => {
    if (enabled && !routes.some((route) => route.name === name)) {
      routes.push({ name, run });
    }
  };

  addRoute("direct Weibo image", item.kind === "image" && isWeiboDirectImageUrl(item.url), async () => {
    debugLog("[fcdl] → direct Weibo image");
    const check = await preflightDirectUrl(item.url);
    if (!check.ok) throw new Error(`Weibo image direct download failed (${check.error})`);
    return chromeDownload(item.url, suggestedFilename(item, downloadPageUrl, tabTitle));
  });

  addRoute("direct Reddit image", item.kind === "image" && isRedditDirectImageUrl(item.url), async () => {
    debugLog("[fcdl] → direct Reddit image");
    const check = await preflightDirectUrl(item.url);
    if (!check.ok) throw new Error(`Reddit image direct download failed (${check.error})`);
    return chromeDownload(item.url, suggestedFilename(item, downloadPageUrl, tabTitle));
  });

  addRoute("server stream", (item.url || "").includes("/ytdl-stream?"), async () => {
    debugLog("[fcdl] → ytdl-stream direct download");
    const headers = cookieHeaderList(cookies);
    const check = await preflightBackendUrl(item.url, headers);
    if (!check.ok) {
      _notifyYtdlError("YouTube download failed", check.error);
      throw new Error(check.error);
    }
    const dlId = await chromeDownload(item.url, suggestedFilename(item, item.url, tabTitle), headers);
    _watchYtdlStreamDownload(dlId).catch((e) =>
      debugWarn("[fcdl] ytdl-stream watcher error:", e?.message || e)
    );
    return dlId;
  });

  addRoute("audio only", item.audioOnly, async () => {
    debugLog("[fcdl] → backend audio only");
    return viaBackend(downloadPageUrl || urlForBackend || item.url);
  });

  addRoute("local helper", isYoutubeHdHelperItem && helperCanTry, async () => {
    debugLog("[fcdl] → local youtube helper");
    const health = await fetchLocalHelperInfo();
    if (!localHelperReady(health)) {
      const standalone = bestHelperAbsentFallback(tabId);
      if (!health && standalone) {
        debugLog("[fcdl] → Companion absent; using best standalone candidate", standalone.source, standalone.kind);
        return downloadItem(tabId, standalone);
      }
      throw new Error(localHelperProblem(health));
    }
    if (health.needsSetup) {
      const setup = await ensureLocalHelperTools();
      if (!setup.ok) throw new Error(setup.error || "Companion video tools are not ready.");
    }
    const localUrl = localHelperDownloadUrl(helperTarget, true);
    const check = await preflightLocalHelperUrl(localUrl, helperHeaders);
    if (!check.ok) throw new Error(check.error);
    const dlId = await chromeDownload(localUrl, suggestedFilename({ ...item, ext: "mp4" }, helperTarget, tabTitle), helperHeaders);
    _watchYtdlStreamDownload(dlId).catch((e) =>
      debugWarn("[fcdl] local helper watcher error:", e?.message || e)
    );
    return dlId;
  });

  addRoute("direct", item.url && !backendStrategy && !hasReplayHeaders && !isPageLikeDownloadUrl(item.url), async () => {
    debugLog("[fcdl] → direct CDN");
    const directHeaders = [];
    const check = await preflightDirectUrl(item.url, directHeaders);
    if (!check.ok) throw new Error(`Direct download failed (${check.error})`);
    if (/googlevideo\.com/i.test(item.url || "")) {
      if (!check.ok) throw new Error(`YouTube direct 360p was refused by YouTube (${check.error})`);
    }
    return chromeDownload(item.url, suggestedFilename(item, downloadPageUrl, tabTitle), directHeaders);
  });

  addRoute("local helper", !isYoutubeHdHelperItem && helperCanTry && !capturedConcreteMedia, async () => {
    debugLog("[fcdl] → local helper");
    const health = await fetchLocalHelperInfo();
    if (!localHelperReady(health)) throw new Error(localHelperProblem(health));
    if (health.needsSetup) {
      const setup = await ensureLocalHelperTools();
      if (!setup.ok) throw new Error(setup.error || "Companion video tools are not ready.");
    }
    const localUrl = localHelperDownloadUrl(helperTarget, false, {
      removeWatermark: isBilibiliHelperTarget || removeWatermark,
    });
    const check = await preflightLocalHelperUrl(localUrl, helperHeaders);
    if (!check.ok) throw new Error(check.error);
    const dlId = await chromeDownload(localUrl, suggestedFilename({ ...item, ext: "mp4" }, helperTarget, tabTitle), helperHeaders);
    _watchYtdlStreamDownload(dlId).catch((e) =>
      debugWarn("[fcdl] local helper watcher error:", e?.message || e)
    );
    return dlId;
  });

  addRoute("proxy", capturedConcreteMedia && (hasReplayHeaders || PROXY_REQUIRED_RE.test(item.url || "") || SERVER_ONLY_RE.test(item.url || "")), async () => {
    debugLog("[fcdl] → proxy captured concrete media");
    return viaProxy(item.url);
  });

  addRoute(backendStrategy || "backend", Boolean(backendStrategy), async () => {
    debugLog("[fcdl] →", backendStrategy);
    return viaBackend(urlForBackend);
  });

  addRoute("backend fallback", item.url && !backendStrategy, async () => {
    debugLog("[fcdl] → backend fallback");
    return viaBackend(item.url);
  });

  addRoute("direct fallback", item.url && backendStrategy && !hasReplayHeaders && !/googlevideo\.com/i.test(item.url || "") && !isPageLikeDownloadUrl(item.url), async () => {
    debugLog("[fcdl] → direct fallback");
    const check = await preflightDirectUrl(item.url);
    if (!check.ok) throw new Error(`Direct fallback failed (${check.error})`);
    return chromeDownload(item.url, suggestedFilename(item, downloadPageUrl, tabTitle));
  });

  const errors = [];
  for (const route of routes) {
    try {
      const result = await route.run();
      if (result && typeof result === "object" && result.downloadId) return result;
      return {
        downloadId: result,
        route: route.name,
        progressUrl: route.name === "local helper" ? helperTarget : "",
      };
    } catch (e) {
      const message = String(e?.message || e);
      errors.push(`${route.name}: ${message}`);
      debugWarn(`[fcdl] ${route.name} failed; trying next route:`, message);
    }
  }
  throw new Error(errors.length ? `All download methods failed. ${errors.join(" | ")}` : "No usable download method was available.");
}

// Surface download failures (the chrome.downloads.download callback gives us
// a downloadId immediately but the actual file fetch can fail later). Log
// any interrupted downloads so we can see them in the service-worker console.
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "interrupted") {
    debugWarn("[fcdl] download interrupted:", delta);
  } else if (delta.state?.current === "complete") {
    debugLog("[fcdl] download complete:", delta.id);
  }
});

// Monitor a ytdl-stream download started by chrome.downloads.
// When the server returns a JSON error (4xx/5xx) Chrome saves it using the URL
// path + content-type as the filename ("ytdl-stream.json").  This watcher
// detects that outcome, removes the garbage file, and shows a notification
// so the user knows what happened.
async function _watchYtdlStreamDownload(downloadId) {
  const MAX_WAIT_MS = 15 * 60 * 1000; // 15 min — ytdl-stream can take a while
  const finalState = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChange);
      resolve("timeout");
    }, MAX_WAIT_MS);
    function onChange(delta) {
      if (delta.id !== downloadId || settled) return;
      const s = delta.state?.current;
      if (s === "complete" || s === "interrupted") {
        settled = true;
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        resolve(s);
      }
    }
    chrome.downloads.onChanged.addListener(onChange);
  });

  if (finalState === "timeout") return; // download still in progress at max wait

  const [dl] = await new Promise((res) => chrome.downloads.search({ id: downloadId }, res));
  if (!dl) return;

  const isJsonFile = /\.json$/i.test(dl.filename || "");
  // Also catch cases where Chrome respected the .mp4 filename hint but wrote
  // the server's JSON error body — any real video file is much larger than 1 KB.
  const isTinyFile = dl.state === "complete" && typeof dl.fileSize === "number" && dl.fileSize > 0 && dl.fileSize < 1024;
  const interrupted = dl.state === "interrupted";

  if ((isJsonFile || isTinyFile) && dl.state === "complete") {
    // Chrome saved the server's JSON error body — remove it and tell the user.
    debugWarn("[fcdl] ytdl-stream returned a JSON/tiny error file — removing:", dl.filename, "size:", dl.fileSize);
    chrome.downloads.removeFile(downloadId, () => {
      chrome.downloads.erase({ id: downloadId }, () => {});
    });
    _notifyYtdlError(
      "YouTube download failed",
      "The server couldn't download this video. YouTube is blocking server-side downloads " +
      "for this video. Try a different video, or use the bookmarklet on desktop.",
    );
    return;
  }

  if (interrupted) {
    debugWarn("[fcdl] ytdl-stream download interrupted:", dl.error);
    _notifyYtdlError(
      "YouTube download interrupted",
      "The server download failed (" + (dl.error || "unknown error") + "). " +
      "YouTube may be blocking the server. Try again.",
    );
  }
}

function _notifyYtdlError(title, message) {
  try {
    if (typeof chrome.notifications?.create === "function") {
      chrome.notifications.create("ytdl-error-" + Date.now(), {
        type: "basic",
        iconUrl: "icons/icon-48.png",
        title,
        message,
      });
    }
  } catch (e) {
    debugWarn("[fcdl] notification failed:", e?.message || e);
  }
}

function safeDownloadHeaders(headers = []) {
  const forbidden = /^(cookie|host|origin|referer|user-agent|content-length)$/i;
  return (headers || []).filter((h) =>
    h?.name &&
    typeof h.value === "string" &&
    !forbidden.test(h.name)
  );
}

function chromeDownload(url, filename, headers = []) {
  return new Promise((resolve, reject) => {
    const safeHeaders = safeDownloadHeaders(headers);
    const opts = {
      url,
      filename: filename || undefined,
      saveAs: false,
    };
    if (safeHeaders.length) opts.headers = safeHeaders;
    chrome.downloads.download(opts, (downloadId) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(downloadId);
    });
  });
}

function suggestedFilename(item, pageUrl, tabTitle = "") {
  const title = item.title || tabTitle || hostname(pageUrl) || "media";
  const safe = sanitizeForFile(title, 120) || "media";
  const ext = (item.ext || extFromUrl(item.url) || (item.kind === "image" ? "jpg" : item.kind === "audio" ? "mp3" : "mp4")).toLowerCase();
  return `${safe}.${ext.replace(/[^a-z0-9]/g, "") || "bin"}`;
}

function extFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "";
  } catch {
    return String(url || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || "";
  }
}

function isWeiboDirectImageUrl(url) {
  const value = String(url || "");
  return /(?:^|\/\/)(?:[^/]+\.)?(?:sinaimg\.cn|weibocdn\.com)\//i.test(value) &&
    IMAGE_EXT_RE.test(value);
}

function isRedditDirectImageUrl(url) {
  return /(?:^|\.)i\.redd\.it\//i.test(String(url || "")) && IMAGE_EXT_RE.test(url);
}

// ── Gallery downloads — Instagram carousel, Reddit gallery, Threads ───────

function sanitizeForFile(s, max = 60) {
  return String(s || "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, max);
}

function galleryFilename(title, index, item) {
  const base = sanitizeForFile(title) || "gallery";
  // 1-based index, zero-padded so files sort naturally in Downloads.
  const n = String(index + 1).padStart(2, "0");
  const ext = (item.ext || (item.kind === "image" ? "jpg" : "mp4"))
    .toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  return `${base}/${base}-${n}.${ext}`;
}

// Route gallery items through the server's /proxy endpoint so it can attach
// the Referer / Cookie / User-Agent that the CDN expects. chrome.downloads
// itself can't set those headers, which is why direct downloads from
// cdninstagram.com / fbcdn.net silently land as 0-byte or HTML files.
async function buildProxiedUrl(item, ctx) {
  const { backend } = await getSettings();
  const params = new URLSearchParams({ url: item.url });
  const itemReferer = item.headers?.Referer || item.headers?.referer || ctx?.referer || "";
  if (itemReferer) params.set("referer", itemReferer);
  const encodedHeaders = encodeReplayHeaders(item.headers || {});
  if (encodedHeaders) params.set("headers", encodedHeaders);
  // Pass an ext-aware suggested filename so the proxy can set
  // Content-Disposition. The path-folder part of galleryFilename has to be
  // dropped here because Content-Disposition can't contain a directory.
  params.set("filename", (ctx?.filename || "").split("/").pop() || "");
  return `${backend}/proxy?${params.toString()}`;
}

async function downloadGalleryItem(title, index, item, ctx) {
  if (item?.kind === "image" && isLikelyThumbnailUrl(item.url)) {
    throw new Error(`gallery item ${index} is a thumbnail`);
  }

  const filename = galleryFilename(title, index, item);
  const sourceUrl = item.kind === "paired" ? (item.videoUrl || item.url) : item.url;
  if (!sourceUrl) throw new Error(`gallery item ${index} has no URL`);

  const weiboDirectImage = item.kind === "image" && isWeiboDirectImageUrl(sourceUrl);
  const hasReplayHeaders = !weiboDirectImage && Boolean(item.headers && Object.keys(item.headers).length);
  const canTryDirect = weiboDirectImage || (!ctx?.cookies && !hasReplayHeaders && !PROXY_REQUIRED_RE.test(sourceUrl));
  if (canTryDirect) {
    try {
      const check = await preflightDirectUrl(sourceUrl);
      if (!check.ok) throw new Error(check.error);
      return chromeDownload(sourceUrl, filename);
    } catch (e) {
      debugWarn(`[fcdl] gallery item ${index} direct failed, falling back to proxy:`, e?.message || e);
    }
  }

  const proxied = await buildProxiedUrl(
    { ...item, url: sourceUrl },
    { ...(ctx || {}), filename },
  );
  const check = await preflightBackendUrl(proxied, cookieHeaderList(ctx?.cookies));
  if (!check.ok) throw new Error(`Proxy: ${check.error}`);
  return chromeDownload(proxied, filename, cookieHeaderList(ctx?.cookies));
}

async function downloadGallery(tabId, pageUrl, title, items) {
  // Build referer + cookies once for the whole batch; every item in a carousel
  // shares the same auth context (same Instagram/Reddit/Threads post).
  const cookies = await cookieHeaderFor(pageUrl || "");
  const ctx = { referer: pageUrl || "", cookies };

  let started = 0;
  let failed  = 0;
  for (let i = 0; i < items.length; i++) {
    try {
      await downloadGalleryItem(title, i, items[i], ctx);
      started++;
    } catch (e) {
      failed++;
      debugWarn(`[fcdl] gallery item ${i} failed:`, e);
    }
    // Tiny gap so chrome.downloads doesn't queue them as one batch and so
    // the user's Downloads UI doesn't look like a single concurrent storm.
    await new Promise((r) => setTimeout(r, 120));
  }
  return { started, failed };
}

async function downloadMany(tabId, items) {
  let started = 0;
  let failed = 0;
  const errors = [];
  for (let i = 0; i < Math.min(items.length, 10); i++) {
    try {
      await downloadItem(tabId, items[i]);
      started++;
    } catch (e) {
      failed++;
      const error = String(e?.message || e);
      errors.push({ index: i, error });
      debugWarn(`[fcdl] selected item ${i} failed:`, e);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { started, failed, errors };
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// ── Message handler — popup ↔ service worker ──────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "fcdl:ping") {
      sendResponse({ ok: true, ts: Date.now() });
      return;
    }
    if (msg.type === "fcdl:list") {
      const tabId = msg.tabId ?? sender.tab?.id;
      const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const s = tabId != null ? tabState.get(tabId) : null;
      const pageUrl = tab?.url || "";
      const items = isXhsPageUrl(pageUrl) ? pruneXhsTabState(tabId, pageUrl) : (s?.items || []);
      sendResponse({ pageUrl, items, technicalItems: s?.technicalItems || [], settings: await getSettings() });
      return;
    }
    if (msg.type === "fcdl:helper_status") {
      const health = await fetchLocalHelperInfo(LOCAL_HELPER_STATUS_TIMEOUT_MS);
      sendResponse({ ok: true, ready: localHelperReady(health), health, problem: localHelperProblem(health) });
      return;
    }
    if (msg.type === "fcdl:helper_start") {
      const ready = await waitForLocalHelper(LOCAL_HELPER_START_TIMEOUT_MS);
      const health = await fetchLocalHelperInfo(LOCAL_HELPER_STATUS_TIMEOUT_MS);
      sendResponse({ ok: true, ready: ready && localHelperReady(health), health, problem: localHelperProblem(health) });
      return;
    }
    if (msg.type === "fcdl:helper_ensure_tools") {
      sendResponse(await ensureLocalHelperTools());
      return;
    }
    if (msg.type === "fcdl:detected") {
      // From content script: items it found in the DOM
      const tabId = msg.tabId ?? sender.tab?.id;
      const pageUrl = msg.pageUrl ?? sender.tab?.url;
      if (tabId != null && pageUrl && Array.isArray(msg.items)) {
        for (const it of msg.items) addItem(tabId, pageUrl, { ...it, source: it.source || "dom" });
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "fcdl:extract") {
      // Popup-initiated: hit backend /extract with pageUrl + cookies
      const t0 = Date.now();
      try {
        const cookies = await cookieHeaderFor(msg.referer || msg.pageUrl);
        const pageHtml = await pageHtmlForTab(msg.tabId, msg.pageUrl);
        const mediaHints = mediaHintsForTab(msg.tabId);
        const htmlAudit = extractAuditCandidatesFromHtml(msg.pageUrl, pageHtml);
        for (const candidate of htmlAudit) auditSourceCandidate(msg.tabId, msg.pageUrl, candidate);
        const sourceAudit = sourceAuditForTab(msg.tabId, msg.pageUrl, htmlAudit);
        const weiboGallery = extractWeiboGalleryFromHtml(msg.pageUrl, pageHtml);
        if (weiboGallery) {
          debugLog("[fcdl] extract local Weibo gallery:", weiboGallery.items.length);
          const apiAugmented = await extractWeiboGalleryViaApi(msg.pageUrl);
          if (apiAugmented?.sourceAudit?.length) {
            weiboGallery.sourceAudit = [
              ...(weiboGallery.sourceAudit || []),
              ...apiAugmented.sourceAudit,
            ];
            weiboGallery.cleanSourceStatus = apiAugmented.cleanSourceStatus;
          }
          weiboGallery.sourceAudit = sourceAuditForTab(msg.tabId, msg.pageUrl, weiboGallery.sourceAudit);
          sendResponse({ ok: true, info: weiboGallery });
          return;
        }
        const weiboApiGallery = await extractWeiboGalleryViaApi(msg.pageUrl);
        if (weiboApiGallery) {
          debugLog("[fcdl] extract Weibo API gallery:", weiboApiGallery.items.length);
          weiboApiGallery.sourceAudit = sourceAuditForTab(msg.tabId, msg.pageUrl, weiboApiGallery.sourceAudit);
          sendResponse({ ok: true, info: weiboApiGallery });
          return;
        }
        debugLog("[fcdl] extract →", msg.pageUrl, "cookies:", cookies.length, "chars", "html:", pageHtml.length, "chars", "hints:", mediaHints.length);
        const info = await callExtract(msg.pageUrl, msg.referer || null, cookies || null, pageHtml || null, mediaHints, sourceAudit);
        debugLog("[fcdl] extract ←", Date.now() - t0, "ms, kind=", info?.kind);
        sendResponse({ ok: true, info });
      } catch (e) {
        const elapsed = Date.now() - t0;
        debugWarn("[fcdl] extract failed in", elapsed, "ms:", e);
        const error = String(e.message || e);
        if (/No extractor found for this URL and the page HTML contained no detectable media/i.test(error)) {
          preferRuntimeCapturedMedia(msg.tabId, msg.pageUrl);
        }
        sendResponse({ ok: false, error, sourceAudit: sourceAuditForTab(msg.tabId, msg.pageUrl) });
      }
      return;
    }
    if (msg.type === "fcdl:download") {
      try {
        const result = await downloadItem(msg.tabId, msg.item);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }
    if (msg.type === "fcdl:download_many") {
      const items = Array.isArray(msg.items) ? msg.items : [];
      const r = await downloadMany(msg.tabId, items);
      sendResponse({ ok: true, ...r });
      return;
    }
    if (msg.type === "fcdl:download_gallery") {
      const r = await downloadGallery(msg.tabId, msg.pageUrl, msg.title, msg.items);
      sendResponse({ ok: true, ...r });
      return;
    }
    if (msg.type === "fcdl:download_gallery_item") {
      try {
        const tabId = msg.tabId ?? sender.tab?.id;
        const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
        const pageUrl = msg.pageUrl || tab?.url || "";
        const cookies = await cookieHeaderFor(pageUrl);
        const itemReferer = msg.item?.headers?.Referer || msg.item?.headers?.referer || pageUrl;
        const id = await downloadGalleryItem(msg.title, msg.index, msg.item, { referer: itemReferer, cookies });
        sendResponse({ ok: true, downloadId: id });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      return;
    }
    if (msg.type === "fcdl:clear") {
      const tabId = msg.tabId ?? sender.tab?.id;
      tabState.delete(tabId);
      updateBadge(tabId, 0);
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // async
});

// Clean up state when tab is closed / navigated
chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) {
    // navigation — start fresh
    tabState.delete(tabId);
    updateBadge(tabId, 0);
  }
});

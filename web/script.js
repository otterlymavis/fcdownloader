// The backend URL is supplied at runtime — pick the first source that has a
// value. NEVER hardcode a personal Fly.io / Cloudflare URL here; forks of the
// project should bring their own backend.
//
// In priority order:
//  1. `?api=https://...` query param (manual override / debugging)
//  2. `window.EXTRACTOR_URL` global (set by an `index.html` <script> block)
//  3. `<meta name="extractor-url" content="https://...">` tag (set at deploy time)
//  4. Empty → the form shows a "configure backend" message instead of submitting.

const $ = (id) => document.getElementById(id);

const form = $("general-form");
const urlIn = $("url");
const submit = $("submit");
const status = $("status");
const result = $("result");
const thumb = $("thumb");
const titleEl = $("title");
const metaEl = $("meta");
const downloadLink = $("download");
const galleryResult = $("gallery-result");
const galleryList = $("gallery-list");
const downloadAll = $("download-all");
const reset = $("reset");
const bookmarklet = $("bookmarklet");
const releaseVersion = $("release-version");
const helperChip = $("helper-chip");
const helperText = $("helper-text");
const downloadWidget = $("download-widget");
const downloadToggle = $("download-menu-toggle");
const downloadMenu = $("download-menu");

const LOCAL_HELPER = "http://127.0.0.1:8765";
const EXPECTED_HELPER_VERSION = "0.3.0-go";
const DIRECT_MEDIA_RE = /\.(?:mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif)(?:[?#]|$)|googlevideo\.com\/videoplayback|(?:video|audio)\.twimg\.com|cdninstagram\.com|fbcdn\.net|v\.redd\.it|vod\.pstatic\.net/i;
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/|youtube-nocookie\.com\/embed)/i;
const WEB_PROXY_REQUIRED_RE = /(?:cdninstagram\.com|fbcdn\.net|threadscdn\.com|weibocdn\.com|xhscdn\.com|bilivideo\.com|biliimg\.com|hdslb\.com|pstatic\.net|pximg\.net|yimg\.jp|kakaocdn\.net|daumcdn\.net|img-mdpr\.freetls\.fastly\.net)/i;
const DEBUG_LOGS = false;

let sharedReferer = "";
let sharedCookies = "";
let sharedPageHtml = "";
let sharedMediaHints = [];
let companionReady = false;
let companionNeedsSetup = false;
let initialSubmitStarted = false;

function debugInfo(...args) {
  if (DEBUG_LOGS) console.info(...args);
}

function getBackend() {
  const qs = new URLSearchParams(location.search).get("api");
  if (qs) return clean(qs);

  if (window.EXTRACTOR_URL) return clean(window.EXTRACTOR_URL);

  const meta = document.querySelector('meta[name="extractor-url"]');
  if (meta?.content) return clean(meta.content);

  return "";  // No backend configured — caller must handle this gracefully.
}

function clean(url) {
  return String(url).trim().replace(/\/+$/, "");
}

function metaContent(name) {
  return document.querySelector(`meta[name="${name}"]`)?.content?.trim() || "";
}

function applyReleaseLinks() {
  const release = metaContent("release-version");
  if (releaseVersion && release) releaseVersion.textContent = `Release ${release}`;

  const links = {
    android: metaContent("android-download-url") || metaContent("mobile-download-url"),
    ios: metaContent("ios-download-url"),
    extension: metaContent("extension-download-url"),
    helper: metaContent("helper-download-url") || metaContent("companion-download-url"),
    "helper-checksums": metaContent("helper-checksums-url"),
    "self-host": metaContent("self-host-url"),
  };
  for (const [key, href] of Object.entries(links)) {
    const anchor = document.querySelector(`[data-download-link="${key}"]`);
    if (!anchor) continue;
    if (href) {
      anchor.href = href;
      anchor.removeAttribute("aria-disabled");
      anchor.classList.remove("download-tile-disabled");
      continue;
    }
    anchor.removeAttribute("href");
    anchor.setAttribute("aria-disabled", "true");
    anchor.classList.add("download-tile-disabled");
    const detail = anchor.querySelector("span");
    if (detail) detail.textContent = "Coming soon";
  }
}

async function checkCompanion() {
  if (!helperChip || !helperText) return companionReady;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1600);
  try {
    const response = await fetch(`${LOCAL_HELPER}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.ok !== false) {
      companionReady = true;
      companionNeedsSetup = Boolean(data?.needsSetup);
      helperChip.classList.remove("missing");
      helperChip.classList.add("ready");
      helperText.textContent = data?.version && data.version !== EXPECTED_HELPER_VERSION
        ? "Companion outdated: update recommended"
        : companionNeedsSetup
        ? "Companion ready: video tools install on first HD download"
        : "Companion ready: local downloads enabled";
      return true;
    }
    throw new Error("not ready");
  } catch {
    companionReady = false;
    companionNeedsSetup = false;
    helperChip.classList.remove("ready");
    helperChip.classList.add("missing");
    helperText.textContent = "Companion optional: server/direct downloads still work";
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildBookmarklet() {
  const frontend = location.origin + location.pathname;
  const src =
    `(function(){` +
    `var u=location.href;` +
    `var v=null;` +
    `var host=location.hostname||"";` +
    `var re=/https?:\\/\\/(?:player\\.vimeo\\.com\\/video\\/\\d+|www\\.youtube\\.com\\/embed\\/[\\w-]+|youtube\\.com\\/embed\\/[\\w-]+|player\\.twitch\\.tv\\/[^\\s"']+|(?:www\\.)?dailymotion\\.com\\/embed\\/[\\w-]+|fast\\.wistia\\.net\\/embed\\/[^\\s"']+)/;` +
    `var pageRe=/(?:^|\\.)(?:instagram\\.com|bilibili\\.com|bilibili\\.tv|b23\\.tv|weibo\\.com|weibo\\.cn|xiaohongshu\\.com|naver\\.com|naver\\.me|pstatic\\.net|mdpr\\.jp|modelpress\\.jp|ameblo\\.jp|ameba\\.jp|natalie\\.mu|oricon\\.co\\.jp|kstyle\\.com|tistory\\.com|daum\\.net|kakao\\.com|livedoor\\.jp|pixiv\\.net|fanbox\\.cc|bunshun\\.jp|dailyshincho\\.jp|news-postseven\\.com|josei7\\.com|gendai\\.media|withonline\\.jp|vivi\\.tv|cancam\\.jp|hpplus\\.jp|fashion-press\\.net|fashionsnap\\.com|wwdjapan\\.com|thetv\\.jp|mantan-web\\.jp|crank-in\\.net|cinematoday\\.jp|eiga\\.com|realsound\\.jp|jprime\\.jp|smart-flash\\.jp|mainichi\\.jp|asahi\\.com|yomiuri\\.co\\.jp|sankei\\.com|47news\\.jp|jiji\\.com|itmedia\\.co\\.jp|impress\\.co\\.jp|ascii\\.jp|gigazine\\.net)$/i;` +
    `if(pageRe.test(host))v=u;` +
    `function dec(s){return String(s||"").replace(/\\\\u0026/g,"&").replace(/\\\\u003d/g,"=").replace(/\\\\\\//g,"/").replace(/&amp;/g,"&");}` +
    `function hint(u,k){u=dec(u);if(!u||!/^https?:/i.test(u))return;for(var i=0;i<hints.length;i++)if(hints[i].url===u)return;hints.push({url:u,kind:k||(/\\.m3u8(?:[?#]|$)/i.test(u)?"hls":/\\.mpd(?:[?#]|$)/i.test(u)?"dash":"direct"),referer:location.href,title:document.title});}` +
    `var hints=[];` +
    `function scanText(txt){if(v||!txt)return;var pats=[/"video_url"\\s*:\\s*"(https?:\\\\?\\/\\\\?\\/[^"]+)"/,/"playable_url(?:_quality_hd)?"\\s*:\\s*"(https?:\\\\?\\/\\\\?\\/[^"]+)"/,/"browser_native_(?:hd|sd)_url"\\s*:\\s*"(https?:\\\\?\\/\\\\?\\/[^"]+)"/,/(https?:\\\\?\\/\\\\?\\/[^"'\\\\<>\\s]*(?:cdninstagram\\.com|fbcdn\\.net|threadscdn\\.com|bilivideo\\.com|weibocdn\\.com|xhscdn\\.com|vod\\.pstatic\\.net)[^"'\\\\<>\\s]*(?:\\.mp4|\\.m3u8|\\.mov)[^"'\\\\<>\\s]*)/];for(var p=0;p<pats.length&&!v;p++){var m=txt.match(pats[p]);if(m)v=dec(m[1]||m[0]);}}` +
    `var ifs=document.querySelectorAll("iframe");` +
    `var seen=[];` +
    `for(var i=0;i<ifs.length;i++){` +
      `var s=ifs[i].src||ifs[i].getAttribute("data-src")||ifs[i].getAttribute("data-lazy-src")||"";` +
      `if(s)seen.push(s);` +
      `if(s&&re.test(s)&&!v)v=s.match(re)[0];` +
    `}` +
    `if(!v){` +
      `var vs=document.querySelectorAll("video[src],video source[src],audio[src],audio source[src]");` +
      `for(var k=0;k<vs.length;k++){hint(vs[k].currentSrc||vs[k].src);if(!v)v=vs[k].currentSrc||vs[k].src;}` +
    `}` +
    `try{(performance.getEntriesByType("resource")||[]).forEach(function(e){var n=e.name||"";if(/(?:\\.m3u8|\\.mpd|\\.mp4|\\.m4v|\\.webm|\\.mov|\\.m4a|\\.mp3|v\\.redd\\.it|cdninstagram\\.com|fbcdn\\.net|threadscdn\\.com|bilivideo\\.com|xhscdn\\.com|kakaocdn\\.net|pstatic\\.net|abema(?:tv)?\\.akamaized\\.net|brightcove\\.net|boltdns\\.net)/i.test(n))hint(n);});}catch(e){}` +
    `if(!v){try{if(window.__playinfo__)scanText(JSON.stringify(window.__playinfo__));}catch(e){}}` +
    `if(!v){try{["__additionalDataLoaded","instagram_data","_sharedData","__initialData","__bbox","__relay_store__"].forEach(function(k){try{if(window[k])scanText(JSON.stringify(window[k]));}catch(e){}});}catch(e){}}` +
    `if(!v){try{scanText(document.documentElement.outerHTML.slice(0,1500000));}catch(e){}}` +
    `if(!v){var meta=document.querySelector('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"]');if(meta&&meta.content)v=meta.content;}` +
    `if(!v){var m=document.documentElement.outerHTML.match(re);if(m)v=m[0];}` +
    `if(!v){alert("FCDownload: no recognised media found on this page.\\n\\nIframes seen:\\n"+(seen.length?seen.join("\\n"):"(none)"));return;}` +
    `var c=document.cookie||"";` +
    `var t="${frontend}#url="+encodeURIComponent(v)+"&ref="+encodeURIComponent(u)+"&xfer=1";` +
    `var w=window.open(t,"_blank");` +
    `var h="";try{h=document.documentElement.outerHTML.slice(0,1500000);}catch(e){}` +
    `if(w){var n=0;var send=function(){try{w.postMessage({type:"fcdl:cookies",cookies:c,referer:u,pageHtml:h,mediaHints:hints},"${location.origin}");}catch(e){}if(++n<20)setTimeout(send,150);};send();}` +
    `})();`;

  return "javascript:" + encodeURIComponent(src);
}

if (bookmarklet) {
  bookmarklet.href = buildBookmarklet();
}

applyReleaseLinks();
checkCompanion();
setInterval(checkCompanion, 10000);

function setDownloadMenuOpen(open) {
  if (!downloadToggle || !downloadMenu) return;
  downloadMenu.hidden = !open;
  downloadToggle.setAttribute("aria-expanded", String(open));
}

if (downloadToggle && downloadMenu) {
  downloadToggle.addEventListener("click", () => {
    setDownloadMenuOpen(downloadMenu.hidden);
  });

  document.addEventListener("click", (event) => {
    if (downloadMenu.hidden || downloadWidget?.contains(event.target)) return;
    setDownloadMenuOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDownloadMenuOpen(false);
  });

  downloadMenu.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link && link.getAttribute("href") === "#cards") {
      setDownloadMenuOpen(false);
    }
  });
}

// ── Auto-extract URL from messy pastes ───────────────────────────────
//
// Browsers' built-in share sheets and copy buttons frequently append junk
// to the clipboard: titles, tracking text, hashtags, "Sent from my..." sigs.
// If the user pastes something with a URL buried in it, pluck the URL out
// and replace the pasted content with just that. We only do this on `paste`
// (not on every keystroke) so manual typing isn't affected.
const URL_RE = /https?:\/\/[^\s<>"'`\\]+/i;

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(URL_RE);
  if (!m) return null;
  // Trim trailing punctuation that's almost certainly not part of the URL
  // ("Check this out: <URL>." — strip the trailing "." and similar).
  return m[0].replace(/[.,;:!?)\]}>'"]+$/, "");
}

if (urlIn) {
  urlIn.addEventListener("paste", (event) => {
    const pasted = (event.clipboardData || window.clipboardData)?.getData("text") || "";
    const url = extractFirstUrl(pasted);
    if (!url) return;
    // If the paste is JUST a URL, let the browser handle it normally — no point
    // intercepting. Only rewrite when there's surrounding noise.
    if (pasted.trim() === url) return;
    event.preventDefault();
    urlIn.value = url;
    urlIn.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setStatus(text, isError = false) {
  if (!text) {
    status.hidden = true;
    status.textContent = "";
    status.classList.remove("error");
    return;
  }

  status.hidden = false;
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function setBusy(busy) {
  submit.disabled = busy;
  submit.textContent = busy ? "Fetching..." : "Fetch Media";
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";

  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatDimensions(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return `${w} x ${h}`;
  if (Number.isFinite(h) && h > 0) return `${h}p`;
  return "";
}

function mediaResolution(item = {}) {
  const direct = formatDimensions(item.width, item.height);
  if (direct) return direct;

  const selectedFormat = Array.isArray(item.formats)
    ? item.formats.find((format) => String(format.id || format.formatId || "") === String(item.formatId || ""))
    : null;
  const selected = formatDimensions(selectedFormat?.width, selectedFormat?.height);
  if (selected) return selected;

  const bestFormat = Array.isArray(item.formats)
    ? item.formats
        .filter((format) => format?.width || format?.height)
        .sort((a, b) => (Number(b.height || 0) - Number(a.height || 0)) || (Number(b.width || 0) - Number(a.width || 0)))[0]
    : null;
  const best = formatDimensions(bestFormat?.width, bestFormat?.height);
  if (best) return best;

  const label = String(item.label || "");
  if (/(?:\d{3,4}p|4k|8k)/i.test(label)) return label.match(/(?:\d{3,4}p|4k|8k)/i)[0];

  const url = String(item.url || item.videoUrl || "");
  const urlDimensions = url.match(/(?:^|[\/_-])(\d{3,5})x(\d{3,5})(?:[\/_.-]|$)/i);
  if (urlDimensions) return `${urlDimensions[1]} x ${urlDimensions[2]}`;
  try {
    const params = new URL(url).searchParams;
    const fromParams = formatDimensions(
      params.get("width") || params.get("w"),
      params.get("height") || params.get("h"),
    );
    if (fromParams) return fromParams;
  } catch {}

  return item.kind === "audio" ? "Audio only" : "";
}

async function extract(pageUrl, referer, cookies, pageHtml, mediaHints) {
  const backend = getBackend();
  if (!backend) {
    throw new Error(
      "No backend configured. Set EXTRACTOR_URL via the deploy meta tag, window.EXTRACTOR_URL, or the ?api= query param."
    );
  }
  const body = { pageUrl };
  if (referer) body.referer = referer;
  if (cookies) body.cookies = cookies;
  if (pageHtml) body.pageHtml = pageHtml;
  if (Array.isArray(mediaHints) && mediaHints.length) body.mediaHints = mediaHints;

  const response = await fetch(`${backend}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`${response.status} - ${detail.slice(0, 180)}`);
  }

  return response.json();
}

function buildDownloadUrl(pageUrl, referer) {
  const params = new URLSearchParams({ url: pageUrl });
  if (referer) params.set("referer", referer);
  return `${getBackend()}/download?${params.toString()}`;
}

function buildProxyUrl(mediaUrl, referer, filename) {
  const params = new URLSearchParams({ url: mediaUrl });
  if (referer) params.set("referer", referer);
  if (filename) params.set("filename", filename);
  return `${getBackend()}/proxy?${params.toString()}`;
}

function buildYouTube360DownloadUrl(pageUrl) {
  const backend = getBackend();
  if (!backend) {
    throw new Error(
      "No backend configured. Set EXTRACTOR_URL via the deploy meta tag, window.EXTRACTOR_URL, or the ?api= query param."
    );
  }
  const params = new URLSearchParams({ page_url: pageUrl });
  return `${backend}/youtube-360-stream?${params.toString()}`;
}

function isLikelyThumbnailUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!/\.(?:jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.test(u)) return false;
  if (/(?:^|[\/_.-])(?:thumb|thumbnail|avatar|profile(?:_pic)?|cover|poster)(?:[\/_.-]|$)/i.test(u)) return true;
  if (/[?&](?:thumb|thumbnail|preview|avatar|width|w|height|h)=/i.test(u)) return true;
  if (/(?:^|[\/_-])(?:\d{1,3}x\d{1,3}|s\d{2,4}x\d{2,4})(?:[\/_.-]|$)/i.test(u)) return true;
  return false;
}

function displayThumbnail(url) {
  return "";
}

function cookieHeaders(cookies) {
  return cookies ? { "X-FCDL-Cookies": cookies } : {};
}

function filenameFromResponse(response, fallback) {
  const disposition = response.headers.get("content-disposition") || "";
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf) {
    try { return decodeURIComponent(utf); } catch {}
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return plain || fallback || "media";
}

async function downloadRequest(request, fallbackFilename) {
  const headers = { ...(request.headers || {}), ...cookieHeaders(request.cookies) };
  let body;
  if (request.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.body);
  }
  const response = await fetch(request.url, {
    method: request.method || "GET",
    headers,
    body,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`${response.status} - ${detail.slice(0, 180)}`);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  try {
    startDownload(href, filenameFromResponse(response, fallbackFilename));
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }
}

function buildCompanionDownloadUrl(pageUrl) {
  const params = new URLSearchParams({ url: pageUrl, max_height: "1080" });
  return `${LOCAL_HELPER}/download?${params.toString()}`;
}

function isYouTubeUrl(pageUrl) {
  return YOUTUBE_RE.test(pageUrl);
}

function directInfo(pageUrl) {
  if (!DIRECT_MEDIA_RE.test(pageUrl)) return null;
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  const lower = pageUrl.toLowerCase();
  let kind = "direct";
  if (/\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(lower)) kind = "image";
  if (/\.(?:mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(lower)) kind = "audio";
  const host = parsed.hostname.replace(/^www\./, "");
  return {
    info: {
      title: host || "Direct media",
      label: kind === "direct" ? "Direct browser download" : kind,
      kind,
    },
    downloadUrl: pageUrl,
    downloadLabel: "Download Direct",
    galleryItems: null,
    notice: "Using the direct media URL. No Companion or backend needed.",
  };
}

function safeFilePart(text, fallback) {
  return String(text || fallback || "media")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || fallback || "media";
}

function extForItem(item) {
  const ext = String(item?.ext || "").replace(/^\./, "").toLowerCase();
  if (ext) return ext;
  if (item?.kind === "image") return "jpg";
  if (item?.kind === "audio") return "m4a";
  return "mp4";
}

function itemLabel(item, index) {
  if (item?.kind === "image") return `Photo ${index + 1}`;
  if (item?.kind === "audio") return `Audio ${index + 1}`;
  return `Video ${index + 1}`;
}

function describeGallery(items) {
  let photos = 0;
  let audio = 0;
  let videos = 0;
  for (const item of items) {
    if (item.kind === "image") photos += 1;
    else if (item.kind === "audio") audio += 1;
    else videos += 1;
  }
  const parts = [];
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (videos) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  if (audio) parts.push(`${audio} audio file${audio === 1 ? "" : "s"}`);
  return parts.join(" - ") || `${items.length} items`;
}

function galleryItemDownload(item, pageUrl, referer, cookies, title, index) {
  const base = safeFilePart(title, "gallery");
  const ext = extForItem(item);
  const filename = `${base}-${String(index + 1).padStart(2, "0")}.${ext}`;
  const itemReferer = item.headers?.Referer || item.headers?.referer || referer || pageUrl;
  const hasReplayHeaders = Boolean(item.headers && Object.keys(item.headers).length);
  if (item.kind === "paired") {
    return {
      href: "",
      disabledReason: "This item has separate video and audio streams. Use the extension or app for this one.",
    };
  }
  if (!item.url) {
    return {
      href: "",
      disabledReason: "This item did not include a downloadable URL.",
    };
  }
  if (item.kind === "hls") {
    const href = buildDownloadUrl(item.url, itemReferer);
    return {
      href,
      request: cookies ? { url: href, cookies } : null,
      filename,
    };
  }
  if (!cookies && !hasReplayHeaders && !WEB_PROXY_REQUIRED_RE.test(item.url || "")) {
    return {
      href: item.url,
      filename,
    };
  }
  return {
    href: cookies ? "" : buildProxyUrl(item.url, itemReferer, filename),
    request: cookies ? {
      url: `${getBackend()}/proxy`,
      method: "POST",
      body: { url: item.url, referer: itemReferer, filename },
      cookies,
    } : null,
    filename,
  };
}

function startDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  if (filename) a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function chooseWebStrategy(pageUrl, referer, cookies) {
  const direct = directInfo(pageUrl);
  if (direct) return { type: "direct", direct };
  if (companionReady && !referer && !cookies) return { type: "companion" };
  return { type: "backend" };
}

function companionLabel(data) {
  const heights = (data.formats || [])
    .map((fmt) => Number(fmt.height || 0))
    .filter((height) => height > 0);
  const bestHeight = Math.min(1080, Math.max(0, ...heights));
  return bestHeight ? `Companion local download - up to ${bestHeight}p` : "Companion local download";
}

async function extractWithCompanion(pageUrl) {
  const params = new URLSearchParams({ url: pageUrl });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${LOCAL_HELPER}/formats?${params.toString()}`, {
      method: "GET",
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || response.statusText || "Companion extraction failed");
    }
    return {
      info: {
        title: data.title || pageUrl,
        thumbnail: displayThumbnail(data.thumbnail),
        duration: data.duration,
        kind: "video",
        label: companionLabel(data),
      },
      downloadUrl: buildCompanionDownloadUrl(pageUrl),
      downloadLabel: "Download with Companion",
      galleryItems: null,
      notice: "Using Companion for local yt-dlp/ffmpeg download.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveMedia(pageUrl, referer, cookies, pageHtml, mediaHints) {
  let strategy = chooseWebStrategy(pageUrl, referer, cookies);
  if (strategy.type === "direct") return strategy.direct;

  await checkCompanion();
  strategy = chooseWebStrategy(pageUrl, referer, cookies);
  if (strategy.type === "companion") {
    try {
      return await extractWithCompanion(pageUrl);
    } catch (error) {
      debugInfo("Companion route failed, falling back to backend:", error?.message || error);
    }
  }

  if (isYouTubeUrl(pageUrl)) {
    let info = {};
    try {
      info = await extract(pageUrl, referer, cookies, pageHtml, mediaHints);
    } catch (error) {
      debugInfo("YouTube metadata extraction failed, using 360p fallback:", error?.message || error);
    }
    return {
      info: {
        title: info.title || "YouTube video",
        thumbnail: displayThumbnail(info.thumbnail),
        duration: info.duration,
        kind: "video",
        label: "YouTube 360p MP4",
      },
      downloadUrl: buildYouTube360DownloadUrl(pageUrl),
      downloadRequest: cookies ? {
        url: buildYouTube360DownloadUrl(pageUrl),
        cookies,
      } : null,
      downloadLabel: "Download 360p MP4",
      galleryItems: null,
      notice: "Using the YouTube 360p fallback. Open Companion for higher quality local downloads.",
    };
  }

  const info = await extract(pageUrl, referer, cookies, pageHtml, mediaHints);
  if (info.kind === "gallery" && Array.isArray(info.items)) {
    return {
      info: {
        title: info.title || info.uploader || "Media gallery",
        thumbnail: displayThumbnail(info.items.find((item) => item.thumbnail)?.thumbnail),
        kind: "gallery",
        label: describeGallery(info.items),
      },
      galleryItems: info.items,
      downloadUrl: "",
      downloadLabel: `Download all ${info.items.length}`,
      notice: "Multiple media items found. Your browser may ask for permission to download several files.",
    };
  }
  return {
    info,
    downloadUrl: buildDownloadUrl(pageUrl, referer),
    downloadRequest: cookies ? {
      url: buildDownloadUrl(pageUrl, referer),
      cookies,
    } : null,
    downloadLabel: "Download Media",
    galleryItems: null,
    notice: companionReady
      ? "Using the backend for this link because the local helper could not extract it."
      : "",
  };
}

function renderSingleResult(resolved, info, url) {
  galleryResult.hidden = true;
  galleryList.innerHTML = "";
  downloadAll.onclick = null;
  downloadLink.hidden = false;

  thumb.src = info.thumbnail ?? "";
  thumb.style.display = info.thumbnail ? "" : "none";
  titleEl.textContent = info.title ?? url;

  const details = [];
  if (info.label) details.push(info.label);
  details.push(mediaResolution(info));
  if (info.duration) details.push(fmtDuration(info.duration));
  if (info.kind) details.push(info.kind);
  metaEl.textContent = details.join(" - ");

  downloadLink.href = resolved.downloadUrl;
  downloadLink.textContent = resolved.downloadLabel || "Download Media";
  downloadLink.onclick = resolved.downloadRequest
    ? async (event) => {
        event.preventDefault();
        try {
          setStatus("Starting secure download...");
          await downloadRequest(resolved.downloadRequest, safeFilePart(info.title, "media"));
          setStatus("Download started.");
        } catch {
          setStatus("Download failed. Try the app or extension for this media.", true);
        }
      }
    : null;
}

function renderGalleryResult(resolved, info, url, referer, cookies) {
  const items = resolved.galleryItems || [];
  const title = info.title || "Media gallery";
  const downloads = items.map((item, index) => {
    if (item.kind === "image" && isLikelyThumbnailUrl(item.url)) {
      return { item, index, disabledReason: "Thumbnail skipped." };
    }
    return {
      item,
      index,
      ...galleryItemDownload(item, url, referer, cookies, title, index),
    };
  });
  const available = downloads.filter((entry) => entry.href || entry.request);

  downloadLink.hidden = true;
  galleryResult.hidden = false;
  galleryList.innerHTML = "";

  thumb.src = info.thumbnail || "";
  thumb.style.display = info.thumbnail ? "" : "none";
  titleEl.textContent = title;
  metaEl.textContent = describeGallery(items);

  downloadAll.textContent = available.length === items.length
    ? `Download all ${items.length}`
    : `Download ${available.length} available`;
  downloadAll.disabled = available.length === 0;
  downloadAll.onclick = () => {
    available.forEach((entry, offset) => {
      setTimeout(() => {
        if (entry.request) {
          downloadRequest(entry.request, entry.filename).catch(() => {
            setStatus("Some downloads failed. Try the app or extension for this gallery.", true);
          });
        } else {
          startDownload(entry.href, entry.filename);
        }
      }, offset * 350);
    });
    setStatus(`Starting ${available.length} download${available.length === 1 ? "" : "s"}...`);
  };

  downloads.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "gallery-item";

    const meta = [
      entry.item.ext ? entry.item.ext.toUpperCase() : entry.item.kind,
      mediaResolution(entry.item),
      entry.item.duration ? fmtDuration(entry.item.duration) : "",
    ].filter(Boolean).join(" - ");

    const copy = document.createElement("div");
    copy.innerHTML = `
      <div class="gallery-item-title"></div>
      <div class="gallery-item-meta"></div>
    `;
    copy.querySelector(".gallery-item-title").textContent = entry.item.title || itemLabel(entry.item, entry.index);
    copy.querySelector(".gallery-item-meta").textContent = entry.disabledReason || meta;

    if (entry.href || entry.request) {
      const link = document.createElement("a");
      link.className = "primary";
      link.href = entry.href || "#";
      link.download = entry.filename || "";
      link.textContent = "Download";
      if (entry.request) {
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          try {
            setStatus("Starting secure download...");
            await downloadRequest(entry.request, entry.filename);
            setStatus("Download started.");
          } catch {
            setStatus("Download failed. Try the app or extension for this item.", true);
          }
        });
      }
      li.append(copy, link);
    } else {
      const disabled = document.createElement("span");
      disabled.className = "ghost";
      disabled.setAttribute("aria-disabled", "true");
      disabled.textContent = "Unavailable";
      li.append(copy, disabled);
    }

    galleryList.appendChild(li);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlIn.value.trim();
  if (!url) return;

  result.hidden = true;
  setBusy(true);
  setStatus("Finding your media...");

  try {
    const resolved = await resolveMedia(url, sharedReferer || null, sharedCookies || null, sharedPageHtml || null, sharedMediaHints);
    const info = resolved.info || {};
    if (resolved.galleryItems?.length) {
      renderGalleryResult(resolved, info, url, sharedReferer || null, sharedCookies || null);
    } else {
      renderSingleResult(resolved, info, url);
    }
    result.hidden = false;
    setStatus(resolved.notice || "");
  } catch (error) {
    setStatus("We could not fetch this media. Check the link and try again.", true);
  } finally {
    setBusy(false);
  }
});

reset.addEventListener("click", () => {
  result.hidden = true;
  setStatus("");
  downloadLink.textContent = "Download Media";
  downloadLink.hidden = false;
  galleryResult.hidden = true;
  galleryList.innerHTML = "";
  downloadAll.onclick = null;
  urlIn.value = "";
  sharedReferer = "";
  sharedCookies = "";
  sharedPageHtml = "";
  sharedMediaHints = [];
  urlIn.focus();
});

function getParam(name) {
  const search = new URLSearchParams(location.search).get(name);
  if (search) return search;

  const hash = new URLSearchParams(location.hash.replace(/^#/, "")).get(name);
  return hash || "";
}

const initUrl = getParam("url");
sharedReferer = getParam("ref") || getParam("referer");
const expectsCookieTransfer = getParam("xfer") === "1";

function submitInitialUrl() {
  if (!initUrl || initialSubmitStarted) return;
  initialSubmitStarted = true;
  urlIn.value = initUrl;
  form.requestSubmit();
}

window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "fcdl:cookies") return;
  if (typeof data.cookies === "string") sharedCookies = data.cookies;
  if (typeof data.referer === "string" && !sharedReferer) sharedReferer = data.referer;
  if (typeof data.pageHtml === "string") sharedPageHtml = data.pageHtml;
  if (Array.isArray(data.mediaHints)) sharedMediaHints = data.mediaHints.slice(0, 20);
  submitInitialUrl();
});

if (initUrl) {
  if (expectsCookieTransfer) setTimeout(submitInitialUrl, 900);
  else submitInitialUrl();
}

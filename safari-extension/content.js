const api = globalThis.browser || globalThis.chrome;

const MEDIA_RE = /\.(?:m3u8|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i;
const CDN_RE = /(?:(?:[a-z0-9-]+\.)*streaks\.jp\/|i\.fod\.fujitv\.co\.jp\/|fod-sp\.fujitv\.co\.jp\/|free\.tbs\.co\.jp\/|dmm\.co\.jp\/|dmm\.com\/|fanza\.jp\/|lemino\.docomo\.ne\.jp\/|animestore\.docomo\.ne\.jp\/|video\.dmkt-sp\.jp\/|unext\.jp\/|video\.unext\.jp\/|hulu\.jp\/|telasa\.jp\/|plus\.nhk\.jp\/|nhk-ondemand\.jp\/|wowow\.co\.jp\/|wod\.wowow\.co\.jp\/|b-ch\.com\/|bandainamcoid\.com\/|tv\.rakuten\.co\.jp\/|jod\.jsports\.co\.jp\/|jsports\.co\.jp\/|spoox\.skyperfectv\.co\.jp\/|skyperfectv\.co\.jp\/|locipo\.jp\/|dougaizm\.mbs\.jp\/|mbs\.jp\/|ytv\.co\.jp\/|video\.tv-tokyo\.co\.jp\/|douga\.tv-asahi\.co\.jp\/|ktv-smart\.jp\/|ktv\.jp\/|vod\.ntv\.co\.jp\/|cu\.ntv\.co\.jp\/|googlevideo\.com\/videoplayback|video\.twimg\.com\/|cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|threadscdn\.com\/|tiktokcdn\.com\/|v\d+-webapp\.tiktok\.com\/|(?:v|i|preview)\.redd\.it\/|fbcdn\.net\/|pinimg\.com\/(?:videos|originals|736x|1200x|564x)\/|dmcdn\.net\/|vimeocdn\.com\/|bilivideo\.(?:com|cn)\/|weibocdn\.com\/|sinaimg\.cn\/|xhscdn\.com\/|ci\.xiaohongshu\.com\/|pstatic\.net\/|media\.trilltrill\.jp\/|obs\.line-scdn\.net\/|fashionsnap-assets\.com\/|i\.gyazo\.com\/)/i;
const VIMEO_CONFIG_RE = /player\.vimeo\.com\/video\/\d+\/config\/?(?:[?#]|$)/i;

function absolutize(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return "";
  }
}

function isMedia(url) {
  return MEDIA_RE.test(url) || CDN_RE.test(url) || VIMEO_CONFIG_RE.test(url);
}

function vimeoConfigUrlFromValue(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";
  const raw = /^\d+$/.test(rawValue) ? `https://player.vimeo.com/video/${rawValue}` : absolutize(rawValue);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (/^player\.vimeo\.com$/i.test(parsed.hostname)) {
      const match = parsed.pathname.match(/^\/video\/(\d+)(?:\/|$)/i);
      if (!match) return "";
      parsed.pathname = `/video/${match[1]}/config`;
      parsed.hash = "";
      return parsed.href;
    }
    if (!/^(?:www\.)?vimeo\.com$/i.test(parsed.hostname)) return "";
    const segments = parsed.pathname.split("/").filter(Boolean);
    let idIndex = -1;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (/^\d+$/.test(segments[i])) {
        idIndex = i;
        break;
      }
    }
    if (idIndex < 0) return "";
    const config = new URL(`https://player.vimeo.com/video/${segments[idIndex]}/config`);
    parsed.searchParams.forEach((paramValue, key) => config.searchParams.append(key, paramValue));
    if (
      idIndex === 0 &&
      segments.length === 2 &&
      /^[a-z0-9]+$/i.test(segments[1]) &&
      !config.searchParams.has("h")
    ) {
      config.searchParams.set("h", segments[1]);
    }
    return config.href;
  } catch {
    return "";
  }
}

function collectFromElements() {
  const urls = [];
  const add = (value) => {
    const url = absolutize(value);
    if (url && isMedia(url) && !urls.includes(url)) urls.push(url);
  };
  document.querySelectorAll("video, audio, source, img, iframe, [data-vimeo-id], [data-vimeo-url]").forEach((el) => {
    add(el.currentSrc || el.src || el.getAttribute("src"));
    add(el.getAttribute("data-src"));
    add(el.getAttribute("data-consent-src"));
    add(el.getAttribute("data-cmp-src"));
    add(el.getAttribute("data-original"));
    add(vimeoConfigUrlFromValue(el.getAttribute("data-vimeo-url") || el.getAttribute("data-vimeo-id")));
    const srcset = el.getAttribute("srcset") || el.getAttribute("data-srcset") || "";
    srcset.split(",").forEach((part) => add(part.trim().split(/\s+/)[0]));
  });
  document.querySelectorAll("meta[property], meta[name]").forEach((el) => {
    add(el.getAttribute("content"));
  });
  return urls.slice(0, 40);
}

function scanText(text) {
  const out = [];
  const body = String(text || "").replace(/\\u0026/g, "&").replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  const vimeoOptionRe = /["']?(id|url)["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|(\d{4,}))/gi;
  let optionMatch;
  if (/Vimeo\.Player|player\.vimeo\.com|vimeo\.com\//i.test(body)) {
    while ((optionMatch = vimeoOptionRe.exec(body)) && out.length < 80) {
      const key = optionMatch[1];
      const value = optionMatch[2] || optionMatch[3] || optionMatch[4] || "";
      if (key.toLowerCase() === "url" && !/vimeo\.com\//i.test(value)) continue;
      const url = vimeoConfigUrlFromValue(value);
      if (url && !out.includes(url)) out.push(url);
    }
  }
  const re = /https?:\/\/[^"'<>\s\\]+/gi;
  let match;
  while ((match = re.exec(body)) && out.length < 80) {
    const url = match[0].replace(/&amp;/g, "&");
    if (isMedia(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

function collectMedia() {
  const urls = collectFromElements();
  try {
    scanText(document.documentElement.outerHTML.slice(0, 1_500_000)).forEach((url) => {
      if (!urls.includes(url)) urls.push(url);
    });
  } catch {}
  return urls.slice(0, 40);
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fcdl:safari:scan") return;
  sendResponse({
    ok: true,
    pageUrl: location.href,
    title: document.title || "",
    media: collectMedia(),
  });
});

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
const reset = $("reset");
const bookmarklet = $("bookmarklet");
const releaseVersion = $("release-version");
const helperChip = $("helper-chip");
const helperText = $("helper-text");

const LOCAL_HELPER = "http://127.0.0.1:8765";
const DIRECT_MEDIA_RE = /\.(?:mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif)(?:[?#]|$)|googlevideo\.com\/videoplayback|(?:video|audio)\.twimg\.com|cdninstagram\.com|fbcdn\.net|v\.redd\.it/i;

let sharedReferer = "";
let sharedCookies = "";
let companionReady = false;

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
    mobile: metaContent("mobile-download-url"),
    extension: metaContent("extension-download-url"),
    companion: metaContent("companion-download-url"),
    "self-host": metaContent("self-host-url"),
  };
  for (const [key, href] of Object.entries(links)) {
    const anchor = document.querySelector(`[data-download-link="${key}"]`);
    if (anchor && href) anchor.href = href;
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
      helperChip.classList.remove("missing");
      helperChip.classList.add("ready");
      helperText.textContent = "Companion ready: local downloads enabled";
      return true;
    }
    throw new Error("not ready");
  } catch {
    companionReady = false;
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
    `var pageRe=/(?:^|\\.)(?:instagram\\.com|bilibili\\.com|bilibili\\.tv|b23\\.tv|weibo\\.com|weibo\\.cn|xiaohongshu\\.com)$/i;` +
    `if(pageRe.test(host))v=u;` +
    `function dec(s){return String(s||"").replace(/\\\\u0026/g,"&").replace(/\\\\u003d/g,"=").replace(/\\\\\\//g,"/").replace(/&amp;/g,"&");}` +
    `function scanText(txt){if(v||!txt)return;var pats=[/"video_url"\\s*:\\s*"(https?:\\\\?\\/\\\\?\\/[^"]+)"/,/"playable_url(?:_quality_hd)?"\\s*:\\s*"(https?:\\\\?\\/\\\\?\\/[^"]+)"/,/"browser_native_(?:hd|sd)_url"\\s*:\\s*"(https?:\\\\?\\/\\\\?\\/[^"]+)"/,/(https?:\\\\?\\/\\\\?\\/[^"'\\\\<>\\s]*(?:cdninstagram\\.com|fbcdn\\.net|threadscdn\\.com|bilivideo\\.com|weibocdn\\.com|xhscdn\\.com)[^"'\\\\<>\\s]*(?:\\.mp4|\\.m3u8|\\.mov)[^"'\\\\<>\\s]*)/];for(var p=0;p<pats.length&&!v;p++){var m=txt.match(pats[p]);if(m)v=dec(m[1]||m[0]);}}` +
    `var ifs=document.querySelectorAll("iframe");` +
    `var seen=[];` +
    `for(var i=0;i<ifs.length;i++){` +
      `var s=ifs[i].src||ifs[i].getAttribute("data-src")||ifs[i].getAttribute("data-lazy-src")||"";` +
      `if(s)seen.push(s);` +
      `if(s&&re.test(s)&&!v)v=s.match(re)[0];` +
    `}` +
    `if(!v){` +
      `var vs=document.querySelectorAll("video[src],video source[src]");` +
      `for(var k=0;k<vs.length&&!v;k++)v=vs[k].currentSrc||vs[k].src;` +
    `}` +
    `if(!v){try{if(window.__playinfo__)scanText(JSON.stringify(window.__playinfo__));}catch(e){}}` +
    `if(!v){try{["__additionalDataLoaded","instagram_data","_sharedData","__initialData","__bbox","__relay_store__"].forEach(function(k){try{if(window[k])scanText(JSON.stringify(window[k]));}catch(e){}});}catch(e){}}` +
    `if(!v){try{scanText(document.documentElement.outerHTML.slice(0,1500000));}catch(e){}}` +
    `if(!v){var meta=document.querySelector('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"]');if(meta&&meta.content)v=meta.content;}` +
    `if(!v){var m=document.documentElement.outerHTML.match(re);if(m)v=m[0];}` +
    `if(!v){alert("FCDownload: no recognised media found on this page.\\n\\nIframes seen:\\n"+(seen.length?seen.join("\\n"):"(none)"));return;}` +
    `var c=document.cookie||"";` +
    `var t="${frontend}#url="+encodeURIComponent(v)` +
      `+"&ref="+encodeURIComponent(u)` +
      `+(c?"&cookies="+encodeURIComponent(c):"");` +
    `window.open(t,"_blank");` +
    `})();`;

  return "javascript:" + encodeURIComponent(src);
}

if (bookmarklet) {
  bookmarklet.href = buildBookmarklet();
}

applyReleaseLinks();
checkCompanion();
setInterval(checkCompanion, 10000);

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

async function extract(pageUrl, referer, cookies) {
  const backend = getBackend();
  if (!backend) {
    throw new Error(
      "No backend configured. Set EXTRACTOR_URL via the deploy meta tag, window.EXTRACTOR_URL, or the ?api= query param."
    );
  }
  const body = { pageUrl };
  if (referer) body.referer = referer;
  if (cookies) body.cookies = cookies;

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

function buildDownloadUrl(pageUrl, referer, cookies) {
  const params = new URLSearchParams({ url: pageUrl });
  if (referer) params.set("referer", referer);
  if (cookies) params.set("cookies", cookies);
  return `${getBackend()}/download?${params.toString()}`;
}

function buildCompanionDownloadUrl(pageUrl) {
  const params = new URLSearchParams({ url: pageUrl, max_height: "1080" });
  return `${LOCAL_HELPER}/download?${params.toString()}`;
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
    notice: "Using the direct media URL. No Companion or backend needed.",
  };
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
        thumbnail: data.thumbnail || "",
        duration: data.duration,
        kind: "video",
        label: companionLabel(data),
      },
      downloadUrl: buildCompanionDownloadUrl(pageUrl),
      downloadLabel: "Download with Companion",
      notice: "Using Companion for local yt-dlp/ffmpeg download.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveMedia(pageUrl, referer, cookies) {
  let strategy = chooseWebStrategy(pageUrl, referer, cookies);
  if (strategy.type === "direct") return strategy.direct;

  await checkCompanion();
  strategy = chooseWebStrategy(pageUrl, referer, cookies);
  if (strategy.type === "companion") {
    try {
      return await extractWithCompanion(pageUrl);
    } catch (error) {
      console.info("Companion route failed, falling back to backend:", error?.message || error);
    }
  }

  const info = await extract(pageUrl, referer, cookies);
  return {
    info,
    downloadUrl: buildDownloadUrl(pageUrl, referer, cookies),
    downloadLabel: "Download Media",
    notice: companionReady
      ? "Using the backend for this link because the local helper could not extract it."
      : "",
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlIn.value.trim();
  if (!url) return;

  result.hidden = true;
  setBusy(true);
  setStatus("Finding your media...");

  try {
    const resolved = await resolveMedia(url, sharedReferer || null, sharedCookies || null);
    const info = resolved.info || {};

    thumb.src = info.thumbnail ?? "";
    thumb.style.display = info.thumbnail ? "" : "none";
    titleEl.textContent = info.title ?? url;

    const details = [];
    if (info.label) details.push(info.label);
    if (info.duration) details.push(fmtDuration(info.duration));
    if (info.kind) details.push(info.kind);
    metaEl.textContent = details.join(" - ");

    downloadLink.href = resolved.downloadUrl;
    downloadLink.textContent = resolved.downloadLabel || "Download Media";
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
  urlIn.value = "";
  sharedReferer = "";
  sharedCookies = "";
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
sharedCookies = getParam("cookies");

if (initUrl) {
  urlIn.value = initUrl;
  form.requestSubmit();
}

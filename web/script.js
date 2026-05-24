const DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev";

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

let sharedReferer = "";
let sharedCookies = "";

function getBackend() {
  const qs = new URLSearchParams(location.search).get("api");
  if (qs) return clean(qs);

  if (window.EXTRACTOR_URL) return clean(window.EXTRACTOR_URL);

  const meta = document.querySelector('meta[name="extractor-url"]');
  if (meta?.content) return clean(meta.content);

  return DEFAULT_BACKEND;
}

function clean(url) {
  return String(url).trim().replace(/\/+$/, "");
}

function buildBookmarklet() {
  const frontend = location.origin + location.pathname;
  const src =
    `(function(){` +
    `var u=location.href;` +
    `var v=null;` +
    `var re=/https?:\\/\\/(?:player\\.vimeo\\.com\\/video\\/\\d+|www\\.youtube\\.com\\/embed\\/[\\w-]+|youtube\\.com\\/embed\\/[\\w-]+|player\\.twitch\\.tv\\/[^\\s"']+|(?:www\\.)?dailymotion\\.com\\/embed\\/[\\w-]+|fast\\.wistia\\.net\\/embed\\/[^\\s"']+)/;` +
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
    `if(!v){var m=document.documentElement.outerHTML.match(re);if(m)v=m[0];}` +
    `if(!v){alert("FCDownload: no recognised embed/video found on this page.\\n\\nIframes seen:\\n"+(seen.length?seen.join("\\n"):"(none)"));return;}` +
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
  submit.textContent = busy ? "Fetching..." : "Fetch Video";
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
  const body = { pageUrl };
  if (referer) body.referer = referer;
  if (cookies) body.cookies = cookies;

  const response = await fetch(`${getBackend()}/extract`, {
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlIn.value.trim();
  if (!url) return;

  result.hidden = true;
  setBusy(true);
  setStatus("Finding your video...");

  try {
    const info = await extract(url, sharedReferer || null, sharedCookies || null);

    thumb.src = info.thumbnail ?? "";
    thumb.style.display = info.thumbnail ? "" : "none";
    titleEl.textContent = info.title ?? url;

    const details = [];
    if (info.label) details.push(info.label);
    if (info.duration) details.push(fmtDuration(info.duration));
    if (info.kind) details.push(info.kind);
    metaEl.textContent = details.join(" - ");

    downloadLink.href = buildDownloadUrl(url, sharedReferer || null, sharedCookies || null);
    result.hidden = false;
    setStatus("");
  } catch (error) {
    setStatus("We could not fetch this video. Check the link and try again.", true);
  } finally {
    setBusy(false);
  }
});

reset.addEventListener("click", () => {
  result.hidden = true;
  setStatus("");
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

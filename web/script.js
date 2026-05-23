// fcdownloader web frontend — single-screen, no library, no history.
// Talks to the Fly-hosted yt-dlp backend; the browser handles file saving.

const DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev";
const SETTINGS_KEY = "fcdl.web.settings.v1";

// ── State ───────────────────────────────────────────────────────────────────

const settings = loadSettings();
applyTheme(settings.theme);

function loadSettings() {
  try {
    return { theme: "system", backend: "", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { theme: "system", backend: "" };
  }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

function applyTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function getBackend() {
  const qs = new URLSearchParams(location.search).get("api");
  if (qs) return clean(qs);
  if (settings.backend) return clean(settings.backend);
  if (window.EXTRACTOR_URL) return clean(window.EXTRACTOR_URL);
  const meta = document.querySelector('meta[name="extractor-url"]');
  if (meta?.content) return clean(meta.content);
  return DEFAULT_BACKEND;
}
function clean(url) { return String(url).trim().replace(/\/+$/, ""); }

// ── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const form     = $("form");
const urlIn    = $("url");
const refIn    = $("referer");
const cookIn   = $("cookies");
const advanced = $("advanced");
const submit   = $("submit");
const status   = $("status");
const preview  = $("preview");
const thumb    = $("thumb");
const titleEl  = $("title");
const metaEl   = $("meta");
const downloadLink = $("download");
const settingsBtn  = $("settings-btn");
const settingsDlg  = $("settings");
const themeSelect  = $("theme-select");
const bookmarklet  = $("bookmarklet");

// ── Bookmarklet ─────────────────────────────────────────────────────────────
//
// Runs in the user's browser tab on a video page. Sends the *page URL* to the
// web app (not the iframe src — yt-dlp's generic extractor handles embed
// discovery, and using the page URL avoids Vimeo's "embed-only" error). Also
// forwards readable cookies for paywalled / login-gated pages. HttpOnly
// cookies aren't readable by bookmarklets, but most session cookies are.

const FRONTEND = location.origin + location.pathname;
function buildBookmarklet() {
  const src =
    `(function(){` +
    `var u=location.href;` +
    `var c=document.cookie||'';` +
    `var t='${FRONTEND}#url='+encodeURIComponent(u)` +
      `+'&ref='+encodeURIComponent(u)` +
      `+(c?'&cookies='+encodeURIComponent(c):'');` +
    `window.open(t,'_blank');` +
    `})();`;
  return "javascript:" + encodeURIComponent(src);
}
if (bookmarklet) bookmarklet.href = buildBookmarklet();

// ── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(text, isError = false) {
  if (!text) { status.hidden = true; status.textContent = ""; status.classList.remove("error"); return; }
  status.hidden = false;
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function setBusy(busy) {
  submit.disabled = busy;
  submit.textContent = busy ? "Fetching…" : "Fetch";
}

function fmtDuration(s) {
  if (!Number.isFinite(s)) return "";
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ── API ─────────────────────────────────────────────────────────────────────

async function extract(pageUrl, referer, cookies) {
  const body = { pageUrl };
  if (referer) body.referer = referer;
  if (cookies) body.cookies = cookies;
  const r = await fetch(`${getBackend()}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => r.statusText);
    throw new Error(`${r.status} — ${detail.slice(0, 220)}`);
  }
  return r.json();
}

function buildDownloadUrl(pageUrl, referer, cookies) {
  const p = new URLSearchParams({ url: pageUrl });
  if (referer) p.set("referer", referer);
  if (cookies) p.set("cookies", cookies);
  return `${getBackend()}/download?${p.toString()}`;
}

// ── Form submit ─────────────────────────────────────────────────────────────

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url      = urlIn.value.trim();
  const referer  = (refIn?.value ?? "").trim();
  const cookies  = (cookIn?.value ?? "").trim();
  if (!url) return;

  preview.hidden = true;
  setBusy(true);
  setStatus(referer || cookies ? "Resolving (with referer/cookies)…" : "Resolving stream URLs…");

  try {
    const info = await extract(url, referer || null, cookies || null);
    preview.hidden = false;
    setStatus("");

    thumb.src = info.thumbnail ?? "";
    thumb.style.display = info.thumbnail ? "" : "none";
    titleEl.textContent = info.title ?? url;

    const bits = [];
    if (info.label)    bits.push(info.label);
    if (info.duration) bits.push(fmtDuration(info.duration));
    if (info.kind)     bits.push(info.kind);
    metaEl.textContent = bits.join(" · ");

    downloadLink.href = buildDownloadUrl(url, referer || null, cookies || null);
  } catch (err) {
    setStatus(`Could not extract: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
});

// ── Settings dialog ─────────────────────────────────────────────────────────

settingsBtn.addEventListener("click", () => {
  themeSelect.value = settings.theme || "system";
  settingsDlg.showModal();
});

settingsDlg.addEventListener("close", () => {
  if (settingsDlg.returnValue !== "save") return;
  settings.theme = themeSelect.value;
  saveSettings();
  applyTheme(settings.theme);
});

// ── Initial autofill from bookmarklet payload (?url=&ref=&cookies= or hash) ─

function getParam(name) {
  const search = new URLSearchParams(location.search).get(name);
  if (search) return search;
  const hash = new URLSearchParams(location.hash.replace(/^#/, "")).get(name);
  return hash;
}

const initUrl     = getParam("url");
const initRef     = getParam("ref") || getParam("referer");
const initCookies = getParam("cookies");

if (initRef && refIn)     { refIn.value = initRef;     if (advanced) advanced.open = true; }
if (initCookies && cookIn){ cookIn.value = initCookies; if (advanced) advanced.open = true; }
if (initUrl) {
  urlIn.value = initUrl;
  form.requestSubmit();
}

# FCDownloader — Architecture & Internals

## Overview

FCDownloader takes a social media or video page URL and downloads the underlying media file. It runs across five surfaces that share the same extraction philosophy but have different delivery mechanisms.

---

## The five surfaces

| Surface | Location | Runtime |
|---|---|---|
| Mobile app | `src/` | React Native / Expo (iOS + Android) |
| Desktop browser extension | `extension/` | Chrome / Firefox / Edge (Manifest V3) |
| Safari extension (standalone) | `safari-extension/` | Safari on macOS — sends URLs to companion app |
| Safari App Extension (Xcode) | `safari-extension-xcode/` | Bundled with iOS app, works on iOS + macOS Safari |
| Fly.io backend | `server/` | Python / FastAPI + yt-dlp |
| Desktop companion | `desktop-companion/nobrowser-go-helper/` | Go binary, HTTP server at `127.0.0.1:8765` |

The **desktop extension** and **mobile app** are the two primary consumer surfaces. The backend and companion are optional accelerators — the app was originally built to work without them.

---

## The extraction layer model

Every surface uses the same conceptual hierarchy. Higher = tried first, lower = fallback.

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1 — Browser DOM + webRequest (extension only)    │
│                                                         │
│  content.js scans the page as it loads:                 │
│  • <video> tags, <iframe> embeds, <img> elements        │
│  • chrome.webRequest.onCompleted intercepts CDN URLs    │
│    (HLS/DASH/mp4/m4s segments as the browser fetches)   │
│                                                         │
│  Zero latency. Requires a real browser session.         │
│  Can't be faked from a server.                          │
└────────────────────────┬────────────────────────────────┘
                         │ nothing found
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2 — Browser-side platform API calls              │
│                                                         │
│  content.js fetches platform APIs using the user's      │
│  real IP + session cookies. Server IPs are often        │
│  blocked; browser IPs are not.                          │
│                                                         │
│  YouTube   → InnerTube /youtubei/v1/player              │
│  Reddit    → /comments/{id}.json  ← only reliable path  │
│  Bilibili  → window.__playinfo__ (page JS global)       │
│  Weibo     → page HTML sinaimg/weibocdn URL scan        │
│  XHS       → window.__INITIAL_STATE__ (needs login)     │
│  TikTok    → __UNIVERSAL_DATA_FOR_REHYDRATION__ SSR      │
└────────────────────────┬────────────────────────────────┘
                         │ nothing found
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 3 — Local companion  127.0.0.1:8765              │
│                                                         │
│  Go binary runs yt-dlp on the user's own machine.       │
│  Best for YouTube HD (real format selection).           │
│  User's IP → no blocks. Auto-installs yt-dlp + ffmpeg.  │
│  Optional: companion must be running.                   │
└────────────────────────┬────────────────────────────────┘
                         │ not running / failed
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 4 — Fly.io /extract backend                      │
│                                                         │
│  Full strategy pipeline (11 strategies, see below).     │
│  Datacenter IP → Reddit 403, some rate limits.          │
│  Forwards user cookies so authenticated content works.  │
└────────────────────────┬────────────────────────────────┘
                         │ failed
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 5 — Direct CDN download                          │
│                                                         │
│  chrome.downloads on an already-captured URL.           │
│  No server bandwidth. Works for public CDN URLs.        │
└─────────────────────────────────────────────────────────┘
```

---

## Desktop browser extension (`extension/`)

### content.js — what it scans

The content script runs at `document_idle` and re-scans every 2 seconds for up to 8 cycles. It also has a `MutationObserver` for SPA navigation.

| Scanner | When it runs | What it finds |
|---|---|---|
| `scanVideoTags` | All pages | `<video>` `currentSrc`/`src` (skips `blob:`) |
| `scanIframes` | All pages | Embed iframes (Vimeo, YouTube, Twitch, Dailymotion…) |
| `scanImageTags` | Image hosts only¹ | `<img>` with naturalWidth/Height ≥ 160px |
| `scanMetaTags` | All pages | `og:video`, `twitter:player:stream`; `og:image` on image hosts only |
| `scanYouTubeInnertube` | youtube.com | Async InnerTube call → HLS HD or itag-18 360p muxed |
| `scanBilibili` | bilibili.com | Reads `window.__playinfo__` (JS global set by page) |
| `scanBilibiliDynamic` | t.bilibili.com | Scans page HTML for `bilivideo.(com\|cn)` CDN URLs |
| `scanWeibo` | weibo.com/cn | Scans for sinaimg/weibocdn image URLs; `mapp.api.weibo.cn` → backendRouted |
| `scanXiaohongshu` | xiaohongshu.com | Parses `window.__INITIAL_STATE__`; needs login; else backendRouted |
| `scanRedditAsync` | reddit.com | **Async**: fetches `reddit.com/comments/{id}.json` — only works from browser IP |
| `scanJapanesePlatforms` | Niconico, TVer, ABEMA, NHK, etc. | Creates backendRouted embed item |
| `scanMetaJson` | **Fallback only** | Full outerHTML scan for JSON-encoded CDN URLs |

¹ Image hosts: instagram.com, reddit.com, pinterest, twitter/x, facebook, tumblr, xiaohongshu.com

**`backendRouted`** items go directly to the backend `/extract` when downloaded — the extension doesn't try to download the page URL directly.

### background.js — download routes

When the user clicks download, these routes are tried in order:

```
1.  Direct Weibo image     sinaimg.cn / weibocdn.com → chrome.downloads (no server)
2.  Direct Reddit image    i.redd.it → chrome.downloads (no server)
3.  Server stream          /ytdl-stream proxy URL → chrome.downloads + error watcher
4.  Audio only             → backend /download with audioOnly flag
5.  Local helper (YT HD)   127.0.0.1:8765/youtube-hd
6.  Direct download        No backend strategy needed → chrome.downloads
7.  Local helper (general) 127.0.0.1:8765/download
8.  Proxy                  CDN needs Referer/auth → backend /proxy
9.  Backend extractor      SERVER_ONLY_RE match → backend /download
10. Backend fallback        Any remaining item → backend /download
11. Direct fallback         Last resort chrome.downloads
```

### Key regex constants

```
SERVER_ONLY_RE       URLs that must go through backend/helper:
                     YouTube, Bilibili, TikTok, Reddit, Weibo, XHS, NicoNico,
                     TVer, ABEMA, NHK, Oricon, mdpr.jp, ~50 JP/KR sites

PAGE_HTML_RE         Hosts where extension sends page HTML to backend:
                     Oricon, mdpr.jp, Bilibili, ~40 JP/KR news/blog sites

PROXY_REQUIRED_RE    CDN URLs that need headers proxied through server:
                     cdninstagram, fbcdn, weibocdn, xhscdn, ci.xiaohongshu.com,
                     bilivideo.(com|cn), pximg, kakaocdn, img-mdpr.freetls.fastly.net

isLikelyMedia(url)   webRequest filter — matches:
                     .m3u8/.mpd/.mp4/.webm, known video CDNs
                     Images excluded (captured by DOM scan instead)
```

---

## Fly.io backend (`server/`)

### File roles

| File | Role |
|---|---|
| `main.py` | FastAPI routes: `/extract` `/download` `/proxy` `/ytdl-stream` `/playlist` |
| `strategies.py` | Ordered fallback pipeline + yt-dlp options builder |
| `extractors.py` | Custom extractors: Meta, Weibo, Modelpress, Naver Blog, curated sites (~30) |
| `new_extractors.py` | Custom extractors: XHS, Bilibili, TikTok, Reddit, Snapwc, Douyin |
| `registry.py` | Per-site capability profiles (is_youtube, japanese domains, etc.) |
| `classifier.py` | URL risk + capability analysis |
| `auth.py` | Cookie file management (write per-request, delete after) |
| `source_audit.py` | Structured logging of every URL candidate tried |
| `languages.py` | Accept-Language header selection per domain |
| `supervisor.py` | StreamSupervisor: blocking yt-dlp download + cleanup for `/ytdl-stream` |

### Extraction pipeline

Every `/extract` request runs this pipeline. First success wins. All failures go into `diagnostics[]` in the error response.

**Non-YouTube:**
```
 1  watermark-free source      Douyin aweme/v1/play, XHS full variants  [remove_watermark only]
 2  watermark-removal proxy    snapwc.com RSA+AES encrypted protocol    [remove_watermark only]
 3  platform extractor  ──┐    Custom Python extractors (see table)
    OR                    │    Order swapped based on platform_first flag:
 4  yt-dlp             ──┘    Weibo/XHS/TikTok/Reddit → platform first; others → yt-dlp first
 5  WebView/runtime            SKIP — browser-only
 6  HLS manifest detector      Fetch page HTML, regex scan for .m3u8
 7  DASH manifest detector     Fetch page HTML, regex scan for .mpd
 8  OG/meta tag extractor      Fetch page HTML, scan og:video meta tags
 9  generic media detector     Fetch page HTML, scan for .mp4/.webm/etc.
10  embedded player detector   Detect Brightcove / JW Player / iframe in page HTML
11  generic yt-dlp             force_generic_extractor=True
12  ytdl-stream                /ytdl-stream proxy URL (actual download mode)
13  browser playback fallback  SKIP — mobile app WebView only
```

**YouTube only** (HTML detectors are useless — YouTube never embeds raw stream URLs):
```
1  yt-dlp         5 player clients: ios, web_safari, web_creator, mweb, tv
                  HLS result → treated as failure (SABR guard) → falls to ytdl-stream
2  ytdl-stream    Runs yt-dlp in actual download mode, streams result
3  browser        SKIP
```

**yt-dlp base options:**
- Format: `bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/best[ext=mp4]/best`
- Cookies written from forwarded browser cookies to a temp file, deleted after the request
- Per-site Referer + Accept-Language injected (e.g. Bilibili gets `Referer: https://www.bilibili.com/`)
- FC2: DNS fallback via Google DNS (datacenter DNS often fails on video.fc2.com)

### Custom server extractors

**`extractors.py`:**

| Extractor | Sites | How |
|---|---|---|
| `extract_meta_page` | Instagram, Threads | Mobile UA page fetch → scan `video_url`, `playable_url`, `browser_native_hd_url`, carousel |
| `extract_modelpress` | mdpr.jp | Discovers all sibling `/photo/detail/N` pages, extracts `img-mdpr.freetls.fastly.net` URLs |
| `extract_naver_blog` | blog.naver.com | Follows frameset `<iframe id=mainFrame>` to PostView; scrapes `se-image-resource` img tags |
| `extract_curated_site` | Oricon, Natalie, Kstyle, Daum, Kakao, Livedoor, Yahoo JP, Naver article, Pixiv, ~30 JP/KR news sites | CDN-matched gallery per site profile |
| `extract_weibo` | weibo.com, weibo.cn, mapp.api.weibo.cn | Calls `ajax/statuses/show` → `m.weibo.cn/statuses/show`; CDN variants across 12 sinaimg size paths |
| `extract_weibo_from_html` | weibo.com | Parses `window.$render_data` from tab HTML sent by the extension |

**`new_extractors.py`:**

| Extractor | Sites | How |
|---|---|---|
| `extract_xiaohongshu` | xiaohongshu.com, rednote.com, xhslink.com | Mobile UA page fetch → `window.__INITIAL_STATE__` → `noteDetailMap`; video stream candidates ranked by quality (h264/h265/av1); image gallery filtered to note media CDNs only |
| `extract_bilibili` | bilibili.com, b23.tv | **API first**: `/x/web-interface/view` → cid+aid → `/x/player/playurl` with fnval=1 (durl muxed MP4) and fnval=16 (DASH video); **page HTML fallback**: `window.__playinfo__`, `readyVideoUrl` |
| `extract_tiktok` | tiktok.com, douyin.com | 1) `__UNIVERSAL_DATA_FOR_REHYDRATION__` or `__NEXT_DATA__` in page HTML; 2) raw regex for `downloadAddr`/`playAddr`; 3) TikTok mobile API `api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/`. Handles photo slideshows via `imagePost.images` |
| `extract_reddit` | reddit.com, redd.it | Follows `/s/` share redirect; fetches `/.json?limit=1` with macOS Chrome UA; prefers HLS > DASH > fallback_url. **Video posts only** — gallery/image posts are browser-side only |
| `extract_douyin_watermark_free` | douyin.com, iesdouyin.com | Parses `window._ROUTER_DATA` for video_id → `aweme/v1/play/` endpoint for clean no-watermark URL |
| `extract_via_snapwc` | TikTok, XHS, Instagram, Reddit, Weibo | RSA-1024 + AES-CBC encrypted protocol: visitor init → analytics events (bot gate) → ephemeral RSA keypair → encrypted parse → decrypt response. Only when `remove_watermark=True` |

### Oricon quality scoring (in `extractors.py`)
Oricon CDN serves the same image at multiple resolutions. The extractor scores them:
```
_o_  (original)        → 1000  ← selected
_l_  (large)           →  700
/detail/img660/        →  650
/detail/img320/ etc.   →  100  ← rejected
others                 →  500
```

---

## Local companion (`desktop-companion/nobrowser-go-helper/`)

Go HTTP server. Auto-downloads and verifies yt-dlp and ffmpeg on first run.

| Endpoint | What it does |
|---|---|
| `GET /health` | `{ok, needsSetup, version}` — extension pings this before every download |
| `GET /formats?url=` | Lists available formats via yt-dlp (no download) |
| `GET /download?url=&max_height=` | Best format up to max_height; streams to chrome.downloads |
| `GET /youtube-hd?url=` | YouTube-specific: `bv*[height<=1080][ext=mp4]+ba[ext=m4a]/137+140/136+140/18` |
| `GET /download/progress?url=` | Live progress: `{status, percent, speed, eta}` |
| `GET /tools/ensure` | Download + SHA256-verify yt-dlp and ffmpeg |

Pinned yt-dlp: `2026.03.17`. Rate limit: 90 req/min.

---

## Mobile app (`src/lib/`)

| File | Role |
|---|---|
| `extractionManager.ts` | Orchestrates: XHS preferOnDevice first, then server, then platform extractors, then generic HTML |
| `platformExtractors.ts` | On-device: YouTube InnerTube, TikTok API, Reddit JSON, Bilibili `__playinfo__`, Weibo statuses API, XHS `__INITIAL_STATE__`, Instagram/Threads scrape, Dailymotion API, TVer, NicoNico, ABEMA, Naver, Modelpress, Ameba, curated JP sites, OG meta |
| `serverExtractor.ts` | POSTs to Fly.io `/extract`; forwards WebView cookies; 45s timeout |
| `siteRegistry.ts` | Per-site hints: `preferredStrategies`, `requiresAuth`, `acceptLanguage`, `preferOnDevice` |
| `downloadStrategies.ts` | Picks download strategy from a `DetectedMedia` item (yt-dlp / server-download / hls-segments / dash / direct) |
| `ffmpegMux.ts` | Native ffmpeg mux for paired DASH video+audio streams |
| `cookieManager.ts` | Extracts session cookies from in-app WebView for forwarding to server |

---

## Platform quirks worth knowing

### Reddit
- **All server IPs are blocked** (Fly.io, AWS, etc.) with HTTP 403 — no cookie forwarding helps
- `scanRedditAsync` in the browser extension is the **only reliable server-free path**: fetches `/comments/{id}.json` from the user's real browser IP
- Video posts: HLS > DASH > fallback_url (fallback_url has video only, no audio)
- Gallery posts: `i.redd.it/{media_id}.{ext}` — direct download, no Referer needed
- Share links (`/s/ID`): browser follows redirect; server also handles with `urlopen(redirect: follow)`

### YouTube
- `skip_download=True` from datacenter IPs often returns an HLS/SABR manifest that **can't be remuxed** (bound to the extracting IP). The server detects this and falls through to `ytdl-stream`.
- `ytdl-stream` runs yt-dlp in actual download mode and streams the bytes through the server.
- Local companion and InnerTube client avoid this problem entirely.

### Bilibili
- Page HTML returns **HTTP 412** to datacenter IPs. But the `/x/player/playurl` REST API is usually still accessible from the same IP.
- Without login cookies: capped at 480p durl (combined MP4).
- With login cookies forwarded from browser: HD DASH available.

### XHS / Xiaohongshu
- Almost all content requires login.
- CDN URLs (`xhscdn.com`, `ci.xiaohongshu.com`) return 403 without `Referer: https://www.xiaohongshu.com/`.
- Mobile app runs on-device extraction first (`preferOnDevice: true`) because the server can't authenticate.
- Short links (`xhslink.com`) redirect to `xiaohongshu.com/explore/{24-char hex id}`.

### Weibo
- `mapp.api.weibo.cn/fx/...` share links: on datacenter IP (not logged in) → redirects to `passport.weibo.cn?url=https%3A%2F%2Fm.weibo.cn%2F...`. Server extracts the embedded URL from the `url=` query param.
- Images served at multiple CDN size paths (`original`, `woriginal`, `large`, `mw2000`, `mw1024`, `mw690`, `orj960`, `orj720`, `orj480`, `orj360`, `bmiddle`, `oslarge`) — server generates variants across all 12.

### TikTok
- Photo/slideshow posts have **no `/video/` in the URL** — yt-dlp doesn't handle them. Custom extractor reads `imagePost.images[].imageURL.urlList`.
- SSR page HTML (`__UNIVERSAL_DATA_FOR_REHYDRATION__`) usually embeds CDN video URLs without needing cookies.

### Oricon
- Multi-page photo galleries: each photo is on `/news/{id}/photo/{n}/`. Server discovers all sibling pages from the current page and fetches them all.

### Modelpress
- Photos are spread across paginated `/photo/detail/N` URLs. Server infers all sibling IDs from the current page's title (e.g. "画像 2/7") and fetches each one.

### FC2
- DNS resolution often fails from datacenter (NXDOMAIN on `video.fc2.com`). Server falls back to Google DNS (`dns.google/resolve?name=video.fc2.com&type=A`).

---

## Test scripts

```
test_all_urls.py              Server /extract only — fast overview
test_all_strategies.py        All strategies: server + browser simulation + local helper
test_browser_strategies.py    Browser-side strategies only (no server calls)
test_server.py                Backend health + individual endpoint tests
npm run test:strategy-matrices
                              No-network app/backend strategy matrix drift check
```

```bash
# Test everything for all platforms
python test_all_strategies.py

# Filter to specific platforms
python test_all_strategies.py reddit bilibili xhs

# Use a different backend
python test_all_strategies.py --backend https://my-instance.fly.dev

# Verify strategy matrices without network calls
npm run test:strategy-matrices
```

Note: browser-side strategy simulation from Python is limited — it runs from the test machine's IP without real session cookies. Reddit and auth-gated platforms (XHS, Weibo private posts) will fail in Python but work correctly in the real browser extension.

---

## Safari extensions

### `safari-extension/` — standalone Manifest V3
Works in Chrome, Firefox, Edge, Safari on desktop without any companion app.
- **Send page** → opens `fcdownloader://share?url=…` deep link (opens FCDownloader Mac/iOS app)
- **Find media** → simpler DOM + CDN URL scan than the full extension
- Targets: FCDownloader app / macOS Shortcuts / a-Shell / custom URL template

### `safari-extension-xcode/` — Xcode Safari App Extension
Native Xcode project bundling the same extension JS into an iOS + macOS Safari App Extension. Ships with the iOS app on the App Store. Shares the same `content.js`/`background.js` source as `safari-extension/`.

---

## Branches

| Branch | Purpose |
|---|---|
| `master` | Stable release base |
| `helper-version` | Active development — local Go companion, desktop extension, all current features |
| `backend-version` | Backend-focused variant |

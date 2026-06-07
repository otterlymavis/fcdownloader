# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Mobile app (Expo / React Native)
```bash
expo start                  # Metro bundler
expo run:ios                # Build + run on iOS simulator
expo run:android            # Build + run on Android emulator
npx tsc --noEmit            # Type-check (no compile output)
```

### Server (Python / FastAPI)
```bash
cd server
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8080 --reload   # Dev server

# Test extraction against the running server
python3 test_all_urls.py                             # All URLs
python3 test_all_urls.py --backend http://localhost:8080  # Local backend
python3 test_all_strategies.py reddit bilibili       # Filter by site name

# Syntax-check server files without the full env
python3 -m py_compile server/extractors.py server/strategies.py
```

### Browser extension
```bash
npm run pack:extension          # Build zip for Chrome/Firefox/Edge
npm run validate:safari-extension  # JS syntax-check the Safari extension
```

### Desktop companion
```bash
npm run dist:companion:nobrowser-go   # Build Go binary + Electron wrapper
npm run test:companion:nobrowser-go   # Test the Go helper
```

### Output cap — always pipe potentially large commands
```bash
COMMAND 2>&1 | head -c 4000
```

## Architecture

FCDownloader is a multi-surface media downloader. All surfaces share the same extraction philosophy but have different delivery mechanisms.

### Five surfaces

| Surface | Location | Runtime |
|---|---|---|
| Mobile app | `src/` + `App.tsx` | Expo SDK 55 / React Native 0.83.6 / Hermes |
| Desktop browser extension | `extension/` | Chrome/Firefox/Edge Manifest V3 |
| Safari extension (standalone) | `safari-extension/` | macOS Safari, sends URLs to companion |
| Safari App Extension (Xcode) | `safari-extension-xcode/` | Bundled with iOS app; same JS as above |
| Fly.io backend | `server/` | Python 3.12 / FastAPI / yt-dlp |

Active development branch: `helper-version`. Stable base: `master`.

### Extraction layer model (highest → lowest priority)

1. **Browser DOM + webRequest** — `extension/content.js` scans `<video>`, iframes, CDN URLs intercepted by `chrome.webRequest`. Zero latency, requires real browser session.
2. **Browser-side platform API calls** — content.js fetches platform APIs (YouTube InnerTube, Reddit `.json`, TikTok SSR, Bilibili `window.__playinfo__`) from the user's real IP and cookies.
3. **Local companion** (`desktop-companion/nobrowser-go-helper/`) — Go HTTP server at `127.0.0.1:8765`, runs yt-dlp on the user's machine. Sidesteps datacenter IP blocks.
4. **Fly.io `/extract` backend** — full 13-strategy fallback pipeline (see below).
5. **Direct CDN download** — if a URL is already known, download without extraction.

### Server extraction pipeline (`server/strategies.py`)

Every `/extract` request tries these in order; first success wins:

```
1  watermark-free source      [remove_watermark only]
2  watermark-removal proxy    [remove_watermark only]
3  platform extractor  ──┐    Custom Python extractors
   OR                    │    (order depends on platform_first flag:
4  yt-dlp             ──┘     Weibo/XHS/TikTok/Reddit first; others yt-dlp first)
5  WebView/runtime            SKIP
6  HLS manifest detector      page HTML → .m3u8 regex
7  DASH manifest detector     page HTML → .mpd regex
8  OG/meta tag extractor      page HTML → og:video
9  generic media detector     page HTML → .mp4/.webm
10 embedded player detector   Brightcove / JW Player / iframe
11 generic yt-dlp             force_generic_extractor=True
12 ytdl-stream                actual download mode, streamed through server
13 browser playback fallback  SKIP
```

### Custom server extractors

**`server/extractors.py`** — image/gallery-heavy sites:
- `extract_meta_page` — Instagram, Threads (mobile UA scrape)
- `extract_modelpress` — mdpr.jp (discovers all sibling `/photo/detail/N` pages)
- `extract_trilltrill` — trilltrill.jp (reads `page_view_content.article_photo_link`)
- `extract_article_photo_gallery` — any site with `/photos/N`, `/gallery/N`, `/image/N`, `/pic/N` patterns; probes N+1, N+2, … until 404
- `extract_generic_media_images` — any article/post/news URL; finds images via JSON-LD, named JS keys, `__NEXT_DATA__`/`__NUXT__`, `<article>` img tags, media CDN subdomains
- `extract_curated_site` — ~30 curated JP/KR sites via `_CURATED_SITE_PROFILES`; matched by host → CDN-filtered gallery
- `extract_naver_blog` — follows frameset `<iframe id=mainFrame>` to PostView
- `extract_weibo` / `extract_weibo_from_html`

**`server/new_extractors.py`** — video-heavy platforms:
- `extract_xiaohongshu` — `window.__INITIAL_STATE__` → noteDetailMap; ranked video streams
- `extract_bilibili` — REST API first (`/x/player/playurl`), page HTML fallback
- `extract_tiktok` — SSR hydration → `downloadAddr`/`playAddr`; photo slideshows via `imagePost.images`
- `extract_reddit` — `.json?limit=1` endpoint; HLS > DASH > fallback_url
- `extract_douyin_watermark_free` — `aweme/v1/play/` no-watermark endpoint
- `extract_via_snapwc` — RSA+AES encrypted third-party proxy

**Dispatch:** `_strategy_platform_extractors` in `strategies.py` checks URL host strings in order. New extractors go there. The curated profile fallback (`extract_curated_site`) and universal fallbacks (`extract_article_photo_gallery`, `extract_generic_media_images`) come last.

### Mobile app (`src/lib/`)

| File | Role |
|---|---|
| `extractionManager.ts` | Top-level orchestrator: on-device first, then server |
| `platformExtractors.ts` | On-device: YouTube, TikTok, Reddit, Bilibili, XHS, Instagram, Dailymotion, TVer, NicoNico, ABEMA, Naver, Modelpress, Ameba, curated JP sites, OG meta |
| `serverExtractor.ts` | POSTs to Fly.io `/extract`; forwards WebView cookies; 45s timeout |
| `downloadStrategies.ts` | Picks strategy from `DetectedMedia` (yt-dlp / server-download / hls / dash / direct). Routes `tv.naver.com` to server-download. Handles web platform via `downloadInBrowser`. |
| `hlsDownloader.ts` | HLS segment downloader: parses master + media playlists, `EXT-X-BYTERANGE` support, batch 12 parallel segments, `debugLog`-gated logging |
| `directDownloader.ts` | Single-file download via `expoFetch` + streaming `File` writer |
| `cookieManager.ts` | Extracts WebView session cookies; guarded for web platform |
| `siteRegistry.ts` | Per-site hints: `preferredStrategies`, `requiresAuth`, `acceptLanguage` |
| `releaseLogger.ts` | `debugLog`/`debugWarn` — only emit in `__DEV__` builds. Use instead of `console.log`. |

### Key platform quirks

**Reddit:** All server/datacenter IPs return HTTP 403. The only reliable server path is the extension's `scanRedditAsync` (real browser IP). Gallery posts (`i.redd.it`) are direct download.

**YouTube:** `skip_download=True` from datacenter IPs often returns an SABR manifest bound to the extracting IP — the server detects this and falls through to `ytdl-stream`. Local companion avoids this entirely.

**Bilibili:** Page HTML returns HTTP 412 to datacenter IPs; the `/x/player/playurl` REST API is still accessible. Without login: 480p cap.

**XHS:** Almost everything requires login. Mobile app uses `preferOnDevice: true` because the server can't authenticate. Short links (`xhslink.com`) redirect to `xiaohongshu.com/explore/{24-char hex}`.

**TikTok photo/slideshow posts:** No `/video/` in URL — yt-dlp skips them. Custom extractor reads `imagePost.images[].imageURL.urlList`.

**FC2:** DNS resolution often fails from datacenter; server falls back to Google DNS (`dns.google/resolve`).

**Weibo:** Server generates 12 CDN size variants (`original`, `woriginal`, `large`, `mw2000`, etc.) for image posts.

### Adding a new site extractor (server)

1. Add extractor function to `server/extractors.py` (gallery/image sites) or `server/new_extractors.py` (video platforms)
2. Add host check in `_strategy_platform_extractors` in `server/strategies.py` (before the `extract_curated_site` call)
3. Add the site to `URLS` in `test_all_urls.py` for regression testing
4. If site is a CDN gallery (no custom logic needed), add a profile to `_CURATED_SITE_PROFILES` instead — no `strategies.py` change needed

### Adding to `_CURATED_SITE_PROFILES`

Each profile needs `label`, `hosts` (tuple of substrings), `referer`, `language`, and `cdn` (tuple of CDN domain substrings to whitelist). The extractor scans all image URLs in the page HTML and keeps only those matching the `cdn` tokens. Note: the CDN scanner requires a file extension (`.jpg`, `.png`, etc.) — extensionless CDN URLs need a dedicated extractor instead.

### Server deployment

```bash
fly deploy   # deploys server/ as Docker image to fcdownloader-extractor.fly.dev
```

App: `fcdownloader-extractor`, region: `iad`, `shared-cpu-1x` / 512MB. Auto-stops when idle. Rate limit: 40 req/min hard.

yt-dlp is pinned to `git+https://github.com/yt-dlp/yt-dlp@master` (not a tagged release) to pick up YouTube extractor fixes before they tag.

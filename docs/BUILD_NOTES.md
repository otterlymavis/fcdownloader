# FCDownloader — Build & Architecture Notes

Reference document covering the design decisions, build steps, and known
limitations from the multi-platform refactor. Useful when you come back to
this in a few months and need to remember why something is the way it is.

---

## Project shape

A media downloader that runs as:

1. **Native mobile app** (Android + iOS) built with Expo / React Native
2. **HTTP backend** running yt-dlp on Fly.io
3. **Static web frontend** on Vercel/Cloudflare Pages, talking to the backend

Three platforms, one repo, two branches:

| Branch | What it builds | When to use |
|---|---|---|
| `master` | Local-only mobile app (no backend dependency) | Public distribution where you don't want to maintain a server. YouTube limited to 360p / HLS-when-available |
| `backend-version` | Mobile app **+** server-backed HD **+** web frontend | Personal use or for users you trust. Full HD via your Fly backend |

---

## Why the architecture looks the way it does

We tried many on-device-only paths for HD YouTube downloads. **All failed**, for predictable reasons:

| Approach | Failed because |
|---|---|
| Regex nsig/decipher extraction (`ytDlpExtractor.ts`) | Late-2025 YouTube player JS removed the `split("")…join("")` pattern; the regexes don't match |
| Headless WebView capture (`HeadlessYouTubeWebView.tsx`) | YouTube's player uses a Service Worker for segment fetches — invisible to `fetch`/`XHR` JS hooks AND to `react-native-webview`'s `shouldInterceptRequest` patch |
| `react-native-webview` patch URL capture | Only catches connection-setup pings without `itag`, not real segment URLs |
| Native `yt-dlp` binary in `jniLibs` | The Linux yt-dlp binary is **glibc-linked** (`/lib/ld-linux-aarch64.so.1`); Android uses bionic libc, kernel can't load the ELF |
| InnerTube IOS/ANDROID adaptive HD URLs | YouTube enforces **po_token** on adaptive URLs since 2024 — returns 403 without it |

What's left as **reliable on-device**:

- **InnerTube IOS `hlsManifestUrl`** — works for some videos (HD up to 4K, no muxing needed)
- **InnerTube ANDROID itag-18** — guaranteed 360p muxed mp4 (not po_token-gated)

For HD on every video → **server backend running real yt-dlp**.

---

## Mobile app

### Project layout (Expo SDK 55, RN 0.83.6, TS, Hermes)

```
App.tsx                       — main UI
src/lib/
  ytExtractor.ts              — InnerTube IOS/ANDROID extraction
  ytDlpDownloader.ts          — YouTube download flow
  platformExtractors.ts       — TikTok / Vimeo / Instagram / ... per-site
  hlsDownloader.ts            — HLS segment downloader
  dashDownloader.ts           — DASH manifest + paired-track native mux
  directDownloader.ts         — single-file direct downloads
  ffmpegMux.ts                — wrapper over the native mux modules
  serverExtractor.ts          — optional server tier (backend-version only)
  cookieManager.ts            — WebView cookie extraction
  vimeoExtractor.ts           — Vimeo /config endpoint extraction
android/app/src/main/java/com/mabisuuu/fcdownloader/
  MediaMuxerModule.kt         — stdlib MediaMuxer + MediaExtractor
  MediaMuxerPackage.kt        — RN package registration
  MainApplication.kt          — registers MediaMuxerPackage
plugins/
  withMediaMuxer.js           — Expo config plugin for iOS muxer
  withShareExtension.js       — iOS Share Extension config plugin
```

### Native modules

- **Android `MediaMuxerModule`** — uses `android.media.MediaMuxer` +
  `MediaExtractor`. Lossless `-c copy` style merge of video + audio mp4/m4a.
  Manually placed in `android/`, registered in `MainApplication.kt`.
  **Don't** run `npx expo prebuild --clean` — that wipes it.

- **iOS muxer via `plugins/withMediaMuxer.js`** — config plugin writes Swift
  using `AVAssetExportSession` + ObjC bridge into `ios/MediaMuxer/` during
  prebuild. Same JS module name (`MediaMuxerModule`) as Android.

- **Removed**: `ffmpeg-kit-react-native` (archived upstream in 2025, binaries
  pulled from Maven), `YtDlpModule.kt` (glibc binary doesn't run on Android).

### Building locally

```powershell
cd D:\fcdownloader
npx expo run:android                            # debug build, installs + runs
npx expo run:android --variant release --no-install    # release APK only
```

Output APK: `android/app/build/outputs/apk/release/app-release.apk`

### Building via GitHub Actions (free, unlimited for public repos)

Workflow at `.github/workflows/build-android.yml` triggers on push to either
branch (and manual dispatch). Requires two GitHub secrets:

| Secret | What it is |
|---|---|
| `RELEASE_KEYSTORE_BASE64` | Base64 of `android/app/fcdownloader.keystore`. Generate locally with `[Convert]::ToBase64String([IO.File]::ReadAllBytes("...\fcdownloader.keystore"))`. |
| `EXPO_PUBLIC_EXTRACTOR_URL` (optional) | Fly backend URL. Only used by `backend-version` builds. |

Output: APK artifact attached to each workflow run.

### Trigger CI manually

https://github.com/otterlymavis/fcdownloader/actions → **Build Android APK** →
**Run workflow** → pick branch.

### Common build gotchas

- **`./gradlew: Permission denied`** — Windows-tracked `gradlew` lacks the
  Unix exec bit. Fixed in the workflow with `chmod +x` step + tracked in git
  as executable.
- **`Unable to load app config` (EAS Build)** — the `.ts` config plugin
  needs a compiled `.js` sibling (`plugins/withMediaMuxer.js`); EAS loads
  plugins through Node before any TS transpile.
- **`fly: missing app name`** — you're outside `server/` where `fly.toml`
  lives. Either `cd server` or pass `-a fcdownloader-extractor`.

---

## Backend (`server/`)

### What it does

Stateless HTTP service running yt-dlp via the Python library (not subprocess).
Two endpoints:

```
POST /extract  { "pageUrl": "...", "referer"?: "...", "cookies"?: "..." }
              → { "kind": "hls"|"paired"|"direct",
                  "url"?, "videoUrl"?, "audioUrl"?,
                  "headers": {...}, "title", "thumbnail", "duration", ... }

GET /download?url=...&referer=...&cookies=...
              → streams muxed mp4 to the browser (Content-Disposition: attachment)
```

`/extract` is used by the mobile app; `/download` is used by the web frontend.

### Stack

- **FastAPI** + uvicorn
- **yt-dlp** (Python library — same code as the CLI)
- **ffmpeg** in the container (for `/download` stream-muxing)
- **slowapi** for per-IP rate limiting
- In-memory cache (Python dict) keyed by videoId + referer
- Docker image, deployed to Fly.io

### Config (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | 8080 | |
| `RATE_LIMIT` | `30/minute;300/hour;1500/day` | per-IP via slowapi |
| `CACHE_TTL` | 300 | seconds |
| `TRUSTED_TOKEN` | (unset) | optional bearer-token bypass |
| `YT_COOKIES_BASE64` | (unset) | base64-encoded `cookies.txt`, decoded to a tempfile at startup |
| `YT_COOKIES_FILE` | (unset) | path to cookies file (alternative to base64) |
| `ALLOWED_ORIGINS` | `*` | comma-separated CORS allowlist |

### Deploy to Fly

```powershell
cd D:\fcdownloader\server
fly auth login
fly launch --no-deploy --copy-config          # only once
fly secrets set YT_COOKIES_BASE64=<...>
fly secrets set TRUSTED_TOKEN=<...>           # optional
fly secrets set ALLOWED_ORIGINS="https://your-web.vercel.app"
fly deploy
```

After deploy:

```powershell
fly status -a fcdownloader-extractor
fly logs   -a fcdownloader-extractor --no-tail | Select-Object -Last 30
fly dashboard                                  # billing, metrics
```

### YouTube cookies

YouTube bot-detects datacenter IPs (Fly's). Mitigated by passing real session
cookies:

1. Install "Get cookies.txt LOCALLY" browser extension
2. Sign in to youtube.com with a **throwaway** account
3. Export → `cookies.txt`
4. Base64-encode + set as `YT_COOKIES_BASE64` Fly secret:
   ```powershell
   $bytes = [IO.File]::ReadAllBytes("$HOME\Downloads\cookies.txt")
   $b64 = [Convert]::ToBase64String($bytes)
   fly secrets set YT_COOKIES_BASE64=$b64 -a fcdownloader-extractor
   fly deploy
   ```
5. Cookies typically expire every ~2 weeks → repeat

### yt-dlp configuration

The server's `_run_ydl()` passes:

- `format`: tiered preference favouring h264/mp4 + m4a (Android MediaMuxer-compatible),
  falling through to any best available
- `extractor_args.youtube.player_client = ["android_vr", "tv_simply", "mweb"]`
  — these clients return non-SABR URLs on datacenter IPs. The default `web`
  client returns SABR-only on cloud IPs (URLs missing → format-not-available)
- `extractor_args.vimeo.referer = [referer]` when a referer is supplied —
  needed because yt-dlp's Vimeo extractor reads `_configuration_arg('referer')`
  before falling back to other places
- `referer` top-level ydl_opt + `http_headers.Referer` as belt-and-suspenders
- `cookiefile` from `YT_COOKIES_BASE64` if set

### Generic-extractor fallback

If yt-dlp returns `Unsupported URL`, the server transparently retries with
`force_generic_extractor=True`. The generic extractor scrapes the page HTML
for `<video>/<source>/m3u8/iframe` patterns — catches many sites without a
dedicated extractor.

### Cost expectations

Per `/extract` call: ~50ms CPU, ~3 KB response. Video bytes don't traverse
the server.

| Traffic | Fly cost |
|---|---|
| Just you | $0/mo |
| ~100 users / 30 dl/day each | $0/mo (well under free tier) |
| ~1000 users / 30 dl/day each | $0 (~400k calls/mo, free tier limit) |
| 10,000+ users | a few dollars/mo |

For **`/download`** (server proxies bytes through ffmpeg mux):

| Traffic | Egress | Cost |
|---|---|---|
| ~100 downloads × 100 MB each | 10 GB | <$1/mo (free tier covers) |
| ~1000 downloads × 100 MB | 100 GB | ~$2 |
| ~10,000 downloads × 100 MB | 1 TB | ~$20 |

**Set a Fly spend cap** (https://fly.io/dashboard → Billing → Spend
Management → e.g. $5/mo) as an absolute ceiling.

---

## Web frontend (`web/`)

### What it is

Static HTML/CSS/JS, no build step. Three files: `index.html`, `style.css`,
`script.js`. Talks to the Fly backend via fetch.

### Features

- Paste URL → Fetch → preview card (thumbnail + title + quality)
- **Download** button navigates to `${BACKEND}/download?url=...&referer=...&cookies=...`
  — browser handles the file save via Content-Disposition
- Optional Referer + Cookies fields for paywalled / domain-restricted embeds
- Bookmarklet (desktop only) that:
  1. Scans the current page for embed iframes (Vimeo, YouTube, Twitch, Wistia,
     Dailymotion)
  2. Falls back to `<video src>` / regex match over page HTML
  3. Opens the web app pre-filled with the embed URL, page URL (as referer),
     and readable cookies
- Settings dialog: theme + (hidden) backend URL override
- Mobile-friendly: bookmarklet hint hidden on touch screens, replaced with a
  pointer to the mobile app

### Deploy

```powershell
cd D:\fcdownloader\web
npx vercel               # first time setup
npx vercel --prod        # subsequent deploys
```

Or push to GitHub and Cloudflare Pages auto-deploys (Build output: `web/`).

### Configuration

Backend URL resolved in order:
1. `?api=...` query string
2. `localStorage` setting (no UI to set this anymore, but honoured)
3. `window.EXTRACTOR_URL`
4. `<meta name="extractor-url">`
5. Hard-coded `DEFAULT_BACKEND` in `script.js`

### CORS

Backend defaults to `*` (open). To lock down:

```powershell
fly secrets set ALLOWED_ORIGINS="https://your-web.vercel.app" -a fcdownloader-extractor
fly deploy -a fcdownloader-extractor
```

### Custom domain

Free subdomain rename: Vercel project Settings → Domains → rename the
`*.vercel.app`. Custom domain: add via the same panel, configure DNS A/CNAME
records as Vercel instructs.

---

## Per-site notes

### YouTube

- **HD reliable**: only via server (yt-dlp + cookies) OR the IOS InnerTube
  HLS path (some videos only)
- **360p reliable everywhere**: InnerTube ANDROID itag-18 (no po_token gate)
- yt-dlp client preference: `android_vr` → `tv_simply` → `mweb`. Web client
  is SABR-only on cloud IPs.

### Vimeo (incl. AmusePlus, FC2 embedded, fanclub sites)

- **Vimeo embed-only videos** require the Referer header to match the
  embedding domain
- yt-dlp Vimeo extractor reads referer via `_configuration_arg('referer')` —
  the server sets BOTH `extractor_args.vimeo.referer` and the http_headers
  Referer for robustness
- For **AmusePlus specifically**: page is paywalled + Vimeo iframe is
  JS-loaded. Workflow:
  1. Sign in to amuseplus.jp in your browser
  2. Open the video page (wait for the player to render)
  3. Click the FCDownload bookmarklet → captures the Vimeo iframe URL +
     forwards readable cookies + AmusePlus URL as referer
  4. Server hits Vimeo with AmusePlus as Referer → HD
- Limitation: if the critical AmusePlus auth cookie is `HttpOnly`, JS can't
  read it → bookmarklet captures partial cookies → may fail. The **mobile
  app** (which has a real WebView session) is the fallback path.

### TikTok / Instagram / Twitter/X / Reddit / Dailymotion / Bilibili / Facebook / Vimeo public

Both the mobile app (`platformExtractors.ts`) and the backend (via yt-dlp's
1800+ extractors) handle these. The mobile flow works without the backend.

### TVer (Japanese broadcaster catch-up)

Mobile-only currently (via `platformExtractors.extractTVer`). Server side
relies on yt-dlp which has dedicated `Tver` extractor — also works.

---

## Branch strategy & day-to-day workflow

```
master                  — local-only mobile app
backend-version         — mobile app + server + web frontend
```

To work on master:
```powershell
git checkout master
```

To work on the full stack (server + web + backend-version mobile):
```powershell
git checkout backend-version
```

When fixing something that applies to both branches, commit on
`backend-version` first, then cherry-pick to `master`:

```powershell
git checkout backend-version
# ... make changes, commit ...
git push origin backend-version
git checkout master
git cherry-pick <sha>
git push origin master
```

(Some commits won't apply cleanly because master doesn't have `server/` —
resolve by `git rm` on server changes, keep the rest.)

---

## Common commands cheatsheet

### Mobile

```powershell
# Dev iteration (USB device or emulator):
npx expo run:android

# Release APK on this PC:
npx expo run:android --variant release --no-install

# Release APK in CI:
git push origin master       # or backend-version → triggers workflow
# then https://github.com/otterlymavis/fcdownloader/actions
```

### Server

```powershell
cd D:\fcdownloader\server
fly deploy                                # rebuild + redeploy
fly logs   -a fcdownloader-extractor      # live tail
fly logs   -a fcdownloader-extractor --no-tail
fly status -a fcdownloader-extractor      # is it running?
fly secrets list -a fcdownloader-extractor
fly secrets set KEY=value -a fcdownloader-extractor
```

### Web

```powershell
cd D:\fcdownloader\web
npx vercel --prod                         # if hosting on Vercel manually
# Or just `git push` — Cloudflare Pages / Vercel auto-deploys
```

### Server smoke test from PowerShell

```powershell
curl.exe https://fcdownloader-extractor.fly.dev/
# {"ok":true,...}

# Open in a browser (avoids PowerShell URL-encoding weirdness):
# https://fcdownloader-extractor.fly.dev/download?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ
```

---

## Troubleshooting

### "Could not extract: 502 — Unsupported URL"

yt-dlp doesn't have a dedicated extractor for the URL AND the generic
extractor couldn't find anything in the page HTML. Usually means:
- The page requires login (server got a login HTML page back instead of the video page)
- The video iframe is JS-rendered (server-side fetch doesn't run JS)

Fix: use the bookmarklet from your already-signed-in browser to capture
the embed URL directly.

### "Cannot download embed-only video without embedding URL"

Server tried a `player.vimeo.com/...` URL without a Referer that satisfies
Vimeo's domain whitelist. Make sure you're submitting both fields (or use
the bookmarklet which fills both automatically).

### "Sign in to confirm you're not a bot"

The Fly cookies expired. Re-export from a logged-in YouTube session and
update the secret:
```powershell
fly secrets set YT_COOKIES_BASE64=<new base64> -a fcdownloader-extractor
fly deploy -a fcdownloader-extractor
```

### Web app downloads start playing inline instead of saving

The server's `Content-Disposition: attachment` should force a download. If
the browser plays it inline: right-click → "Save Video As".

### "Network request failed" in the mobile app

Cleartext HTTP blocked. The Android manifest has
`android:usesCleartextTraffic="true"` (committed). If you're seeing this on
a fresh build, do a full reinstall (`adb uninstall` + `npx expo run:android`)
not just Metro reload — manifest changes require a native rebuild.

### "Permission denied" running `./gradlew` in CI

Workflow has `chmod +x android/gradlew` step + the file is tracked with
+x in git. If still failing, the CI runner's clone may have lost the bit;
re-trigger.

### Bookmarklet does nothing on a video page

You're using the old cached version. The `javascript:` URL is frozen when
you drag it. Refresh the web app, re-drag.

### `Get-ChildItem : Cannot find path 'D:\fcdownloader\.env.local'`

You're trying to read a file that doesn't exist yet. The `.env.local` is
only needed for **local** Expo builds — CI builds use the EAS env vars or
GitHub secrets. For local: `New-Item .env.local -ItemType File`, then
populate with `EXPO_PUBLIC_EXTRACTOR_URL=https://...`.

---

## What was abandoned and why (so you don't try again)

| Idea | Why it doesn't work |
|---|---|
| Regex nsig/decipher extraction | YouTube changed the player JS pattern; fragile and chronic to maintain |
| Headless WebView + JS hooks to capture HD URLs | Service Worker hides segment fetches from all JS / native intercepts |
| `react-native-webview` `shouldInterceptRequest` for segments | Same: SW bypasses it |
| `yt-dlp` Linux binary in `jniLibs` | glibc-linked, can't load on bionic-libc Android |
| `ffmpeg-kit-react-native` | Archived upstream 2025; native binaries removed from Maven |
| BotGuard / po_token client-side generation | Massive engineering effort; yt-dlp upstream still struggles |

The reliable HD path is **server-side yt-dlp with periodically-refreshed
cookies**, exactly what the `backend-version` branch ships.

---

## Repo links

- GitHub: https://github.com/otterlymavis/fcdownloader
- master branch (local-only): https://github.com/otterlymavis/fcdownloader/tree/master
- backend-version branch (full): https://github.com/otterlymavis/fcdownloader/tree/backend-version
- CI runs: https://github.com/otterlymavis/fcdownloader/actions
- Fly app: https://fcdownloader-extractor.fly.dev (status check at `/`)

---

*Generated as a reference for future maintenance. If something here goes
stale, the truth is in the code — start at `src/lib/ytExtractor.ts`,
`server/main.py`, and `web/script.js`.*

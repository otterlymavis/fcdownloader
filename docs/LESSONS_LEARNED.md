# Lessons Learned — What to Know, What Took Too Long, and Why

A candid post-mortem of building FCDownloader, written so the next person
(or future-you) doesn't repeat the same dead-ends.

---

## What you need to learn to build tools like this

Roughly in order from "fundamentals" to "specialised":

### 1. The web platform and HTTP

- **Same-Origin Policy, CORS, cookies (incl. `HttpOnly`, `SameSite`)** — every
  decision in this codebase is shaped by these
- **HTTP headers a server inspects** — `Referer`, `User-Agent`, `Cookie`,
  `Authorization`, `Range`. Most "video sites" make access decisions based on
  Referer + cookies
- **HTTP status codes you'll see**: 200, 206 (range), 302/307 (redirects), 401, 403, 404, 429, 502, 504
- **Streaming responses, `Content-Disposition`, `Transfer-Encoding: chunked`** —
  what you need to make "download" buttons work in browsers

### 2. The browser sandbox and its limits

- **You cannot read arbitrary cross-origin data from a webpage**
- **A static frontend cannot fetch from googlevideo.com** (no CORS), so HD
  YouTube-on-web requires a server
- **JavaScript bookmarklets** run with the page's origin and can read its DOM
  + non-HttpOnly cookies. They're the closest a "static web app" gets to a
  browser extension
- **Service Workers** intercept fetch calls and can rewrite/synthesize
  responses; this is why our `fetch`/`XHR` hooks on YouTube didn't see
  segment requests
- **Media Source Extensions (MSE)** — modern video players (YouTube, Vimeo,
  Netflix) push buffered media into a `MediaSource` rather than using
  `<video src>`. The actual URLs are hidden from naive scraping

### 3. Mobile platform constraints

- **Android `usesCleartextTraffic`** — HTTP is blocked by default since
  Android 9. You either flip the manifest flag or stick to HTTPS
- **Android W^X enforcement** — files in app `filesDir` can't be `exec()`'d.
  Termux-style binaries must ship in `jniLibs/<arch>/lib*.so` so the OS
  extracts them to `nativeLibraryDir` (where exec is allowed)
- **Android ABI / native libc** — Linux distro binaries (glibc-linked, e.g.
  `yt-dlp_linux_aarch64`) **cannot** run on Android (bionic libc, different
  dynamic linker). You need Android-specific builds, or Termux, or pure-Java
- **iOS sandbox** — apps can't `fork()`/`exec()` arbitrary binaries. There's
  no equivalent of jniLibs. You ship Swift/ObjC code or use WebKit
- **React Native bridging** — the `NativeModules` interface, `@ReactMethod`
  in Kotlin, `RCT_EXTERN_METHOD` in ObjC

### 4. Video pipeline

- **Containers**: mp4, mkv, webm, m4s, ts. Each has different muxing rules
- **Codecs**: video (h264/avc1, h265/hevc, vp9, av1), audio (aac/m4a, opus,
  vorbis). Not every combination muxes cleanly — Android `MediaMuxer` doesn't
  accept vp9-into-mp4 for example
- **Manifests**: HLS (`.m3u8`, multiple variants, segments listed) and DASH
  (`.mpd`, XML, BaseURL or SegmentTemplate). You need a parser for each
- **Adaptive streaming vs progressive** — adaptive = many small chunks
  selected at runtime; progressive = one big file from byte 0 to N. The
  former requires more sophisticated download orchestration

### 5. YouTube's specific defenses (essentially their own subfield)

- **`signatureCipher`** — historic. Videos served URLs that need a JS-defined
  cipher applied to a signature param. The cipher function lives in the
  player JS and changes every few weeks
- **`n` parameter / nsig transform** — newer. URLs include `n=...` that
  needs a JS transform applied or YouTube throttles you to ~10 KB/s. Same
  problem as decipher: the function is in obfuscated player JS
- **PO Token / BotGuard** — newest. YouTube runs a JavaScript anti-bot
  challenge in real browsers; the result token is required on HD URLs.
  Without it: HTTP 403 even with valid signatures
- **SABR (Server-side Adaptive BitRate)** — YouTube increasingly serves
  "URLs without a usable URL" — the player has to negotiate live with the
  server. yt-dlp marks these as `missing url`
- **InnerTube clients** — YouTube has many "client identities" (web,
  web_safari, android, android_vr, tv_simply, mweb, ios, …). Each gets
  different responses. Knowing which one to spoof for which content type
  is a chronic moving target

### 6. Build & deploy tooling

- **Expo SDK + EAS Build** — what runs `npx expo run:android`, how config
  plugins (`plugins/with*.js`) modify the generated native projects
- **Gradle + Android SDK / NDK** — the actual Android build, how `gradle.properties`
  controls signing
- **Docker** — for the Fly server (FastAPI + ffmpeg)
- **Fly.io / Vercel / Cloudflare Pages** — the three free-tier hosts that
  cover ~99% of small-app deployments
- **GitHub Actions** — CI/CD for unlimited free APK builds (public repos)

### 7. Investigation skills (the meta-skill)

This is what I should have used more of earlier. **Before writing code**:

- Open the actual page in DevTools, watch the Network tab — what URLs does
  the real player hit? What headers does it send?
- `file <binary>` to see what architecture a downloaded binary expects
- `curl -v` to see real HTTP requests/responses, not what you assumed
- `fly logs`, browser console, `adb logcat` — read what's actually happening
  before guessing what's broken

---

## Why the build took so long — the actual mistakes

### Mistake 1: Trusting outdated assumptions

The project memory said `ffmpeg-kit-react-native@6.0.2` was installed. It
wasn't (had been removed at some point), but I built two implementations
assuming it was, then had to redo both.

**Fix going forward**: verify the *current* state before committing to a
plan. `cat package.json`, `npm ls`, `git log --oneline path/to/file` — read
the truth, don't extrapolate from notes.

### Mistake 2: Treating "this might work" as "this will work"

I tried five different on-device HD strategies in sequence:

1. Regex nsig/decipher → broken player JS pattern
2. InnerTube paired adaptive → po_token gates HD URLs
3. Headless WebView → Service Worker hides segments
4. yt-dlp binary in jniLibs → glibc ELF doesn't run on bionic
5. ALL of the above retries with cookies → still gated

Each was a "let me try one more thing" with three days of code before
discovering the next blocker. **The honest truth was visible early**:
yt-dlp's own GitHub issues said po_token requires a real BotGuard-running
browser. There is no on-device JavaScript solution.

**Fix going forward**: when investigating a hard problem, **read what people
who've already failed at it published**. The yt-dlp project has years of
public commentary on every YouTube defense. A 20-minute read would have
saved a week.

### Mistake 3: Not distinguishing "works on Linux/macOS dev box" from "works on the target"

I tested yt-dlp on my Windows machine. It worked. I deployed it on Fly. It
got bot-checked because the IP was a datacenter IP. I deployed the Linux
yt-dlp binary on Android assuming "yt-dlp is yt-dlp". It can't even load
because Android uses different libc.

Every cross-platform assumption needs an explicit "**does this binary/protocol
actually function in the target environment?**" check.

**Fix going forward**: write down assumptions explicitly. "This binary uses
glibc — does Android have glibc? No. Does this approach work? No."

### Mistake 4: Chasing the wrong layer

For AmusePlus specifically, I spent significant time trying to:
1. Force yt-dlp's generic extractor
2. Pass referer in five different ways
3. Capture URLs via headless browser

The *actual* answer was sitting in the user's already-authenticated browser:
the Vimeo iframe URL was right there in the DOM, with the right cookies,
behind no JS challenge. A 30-line bookmarklet beats all the headless-Chrome
infrastructure.

**The principle**: ask "**where does the data already live, who has the
credentials, what's the path of least resistance?**" before architecting
the solution.

### Mistake 5: Not testing each layer before adding the next

We added: ffmpeg-kit, then native MediaMuxer, then iOS AVAssetExport, then
yt-dlp binary, then headless WebView, then server backend, then web app.
By the time something failed in production, we had no idea which layer.

**Fix going forward**: get the simplest end-to-end working first (paste URL →
get bytes), then add features one at a time, with a smoke test for each.

### Mistake 6: Quality of communication

Several rounds were lost to:
- PowerShell `curl` aliased to `Invoke-WebRequest` with different syntax
- Smart-quote replacement when copy/pasting commands
- Path issues between Windows and bash subshells
- "Did this deploy" confusion (Fly's CLI vs Vercel's vs CF Pages)

**Fix going forward**: when the user is on Windows, use Windows-native
syntax (`curl.exe`, `Get-Content`, Vercel's GUI, etc.) consistently. When
something fails, *first* verify the command actually ran in the expected
environment.

---

## Why AmusePlus specifically took so long

There were **five chained constraints**, each invisible until you'd
defeated the previous one:

```
1. AmusePlus page requires Japan-region auth-session cookies
   ↓ server can't fetch the page without those
2. Even with cookies, the page renders the Vimeo iframe via JavaScript
   ↓ server's curl-style fetch sees a skeleton HTML, no embed
3. Vimeo's video is "embed-only" with domain whitelist (amuseplus.jp)
   ↓ even if you find the Vimeo URL, raw access returns "embed-only" error
4. yt-dlp's Vimeo extractor wants the referer set via specific channels
   ↓ http_headers alone wasn't enough; needed extractor_args.vimeo.referer
5. The user's BROWSER session has all the pieces (cookies, rendered DOM,
   accepted Vimeo embed) — bookmarklet is the natural fit
```

Looking back, **the bookmarklet idea should have been the first reach**, not
the fallback after weeks of server-side attempts. The mobile app already
had the equivalent ("open the page in the in-app browser, capture URLs
from network") — we just needed the web equivalent: the user's *own*
browser is the in-app browser.

**Lesson**: when a target site has multi-factor protection (auth + JS + 3rd
party embed + domain whitelist), don't try to recreate every factor on the
server. **Run inside the user's already-passing environment**. That's what
a bookmarklet, browser extension, or in-app WebView is.

---

## A reasonable curriculum if you're starting

Roughly 3-6 months of self-study if you build along the way:

1. **HTTP fundamentals** (1 week) — read MDN's HTTP docs. Write a tiny
   server in any language. Use `curl -v` until you know the headers cold.
2. **One mobile platform end-to-end** (2-3 weeks) — Android Studio + Kotlin,
   OR React Native + Expo. Build "Hello World" → "fetch JSON" → "play a video".
3. **The browser as a tool** (1 week) — Chrome DevTools Network/Console
   tabs, the difference between page context and Service Worker context,
   how to inspect a video site's request flow.
4. **Video formats** (1 week) — read FFmpeg's docs on demuxing/muxing, the
   HLS RFC (8216), DASH-IF examples. Use `ffprobe` on real files.
5. **Read yt-dlp's source** (2-4 weeks, ongoing) — start with the YouTube
   extractor (`yt_dlp/extractor/youtube/`). It's the single best resource
   for understanding what every defense looks like and what counter-measures
   exist. Read the closed issues, especially around po_token and SABR.
6. **A tiny version of each component** (2 weeks each) —
   - A FastAPI/Express server that runs yt-dlp and returns JSON. Deploy to
     Fly.io free tier.
   - A static HTML page that calls the server.
   - A React Native app that calls the server.
7. **Cross-platform headaches** (ongoing) — every time you hit a wall, spend
   30 minutes reading why before writing code.

After all that you'll be roughly where you'd want to be on day 1 of building
something like this.

---

## TL;DR — three things I wish I'd known on day 1

1. **YouTube HD on a mobile/web client is fundamentally a server problem.**
   po_token, nsig, SABR all require running real browser JS. Either you run
   that JS (browser/WebView) or you run yt-dlp server-side with rotating
   cookies. There is no third option that survives the next YouTube update.

2. **For multi-factor-protected content (auth + DRM + region + embed), the
   user's own browser is the cheapest "headless browser".** Build a
   bookmarklet/extension instead of recreating their environment on a server.

3. **Read the source of the existing tools first.** yt-dlp's codebase
   answers "how do I download from X" for 1800+ sites. If you're building
   a downloader and not citing yt-dlp's extractor for the target site, you
   are doing duplicate work and probably reinventing a worse version.

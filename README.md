# FCDownloader

A comprehensive, multi-surface media downloader designed to extract and save video, audio, and image galleries from a wide range of social media, streaming, and content websites. FCDownloader uses a hybrid extraction pipeline to resolve, capture, and download media files, bypassing CDN restrictions and platform rate limits.

---

## Architecture & The Five Surfaces

FCDownloader operates across five distinct surfaces, which share the same extraction philosophy but use different runtimes and delivery mechanisms:

| Surface | Location | Runtime / Stack | Description |
|---|---|---|---|
| **Mobile App** | [src/](file:///Users/imac/Documents/fcdownloader/src) | Expo SDK 55 / React Native 0.83.6 / Hermes | iOS and Android clients with integrated browser, downloads, and media library storage. |
| **Browser Extension** | [extension/](file:///Users/imac/Documents/fcdownloader/extension) | Chrome / Firefox / Edge Manifest V3 | Toolbar extension capturing network requests (`webRequest.onCompleted`) and downloading media. |
| **Safari Extension (macOS)** | [safari-extension/](file:///Users/imac/Documents/fcdownloader/safari-extension) | Safari Extension API | Standalone extension for macOS Safari that redirects extraction requests to the local Companion. |
| **Safari App Extension (iOS)** | [safari-extension-xcode/](file:///Users/imac/Documents/fcdownloader/safari-extension-xcode) | Xcode App Extension | Bundled with the iOS app, supporting both iOS and macOS Safari content detection. |
| **Fly.io Backend** | [server/](file:///Users/imac/Documents/fcdownloader/server) | Python 3.12 / FastAPI / yt-dlp | Main extraction pipeline with custom extractors, deployed to Fly.io. |
| **Desktop Companion** | [desktop-companion/](file:///Users/imac/Documents/fcdownloader/desktop-companion) | Go Helper + Electron UI | Runs yt-dlp on the user's local machine to avoid datacenter IP blocks. |

For a deep dive into the inner workings, see [docs/architecture.md](file:///Users/imac/Documents/fcdownloader/docs/architecture.md).

---

## The Extraction Layer Model

To extract media with minimum latency and maximum reliability, every FCDownloader surface runs a fallback-based hierarchy:

```text
┌─────────────────────────────────────────────────────────┐
│  Layer 1 — Browser DOM + webRequest (extension only)    │
│  • Scans <video>, <iframe>, and <img> elements in DOM.  │
│  • Intercepts CDN URLs (HLS, DASH, mp4) via webRequest. │
│  • Zero latency, uses real browser IP/cookies.          │
└────────────────────────┬────────────────────────────────┘
                         │ nothing found
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2 — Browser-side platform API calls              │
│  • Calls platform APIs using user's real browser session.│
│  • YouTube (InnerTube), Reddit (.json), TikTok (SSR).   │
└────────────────────────┬────────────────────────────────┘
                         │ nothing found
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 3 — Local companion (127.0.0.1:8765)             │
│  • Runs yt-dlp locally via Go helper.                   │
│  • Sidesteps datacenter IP blocks for YouTube HD.        │
└────────────────────────┬────────────────────────────────┘
                         │ not running / failed
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 4 — Fly.io /extract backend                      │
│  • 13-strategy backend pipeline.                        │
│  • Custom platform extractors + fallback yt-dlp.        │
└────────────────────────┬────────────────────────────────┘
                         │ failed
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 5 — Direct CDN download                          │
│  • Fallback to download raw media directly via HTTP.    │
└─────────────────────────────────────────────────────────┘
```

---

## Supported Platforms

* **Video / Social**: YouTube, Bilibili, TikTok, Reddit, Instagram, Threads, X/Twitter, Facebook, Pinterest, Dailymotion, Weibo, Xiaohongshu (XHS), TVer, Niconico, ABEMA, Naver, NHK, TBS, FOD, TwitCasting, OpenREC, FC2, Yahoo Japan.
* **Image Galleries & Blogs**: Modelpress, Naver Blog, Ameblo, Natalie, Oricon, Kstyle, Daum/Tistory, Kakao TV, Livedoor Blog, Pixiv/Fanbox, Bilibili dynamics, Bunshun, Daily Shincho, News Post Seven, FRIDAY, Fashion Press, Fashionsnap, WWD Japan, Real Sound, JPrime, Smart Flash, and ~30 curated sites.

---

## Getting Started & Local Development

### Prerequisites

* Node.js v22 (recommended)
* Python 3.10+ (for server development)
* Go 1.21+ (for experimental Go companion helper)

### 1. Mobile App (Expo / React Native)

Install dependencies and run the Metro bundler:
```bash
npm install
npx expo start                  # Starts Metro bundler
npx expo run:ios                # Build and run on iOS Simulator
npx expo run:android            # Build and run on Android Emulator
```

### 2. Extraction Server (Python / FastAPI)

The backend resides in the [server/](file:///Users/imac/Documents/fcdownloader/server) directory:
```bash
cd server
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8080 --reload
```
For more information, see [server/README.md](file:///Users/imac/Documents/fcdownloader/server/README.md).

### 3. Browser Extension (Manifest V3)

To test the browser extension in Chrome, Edge, or Brave:
1. Go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the [extension/](file:///Users/imac/Documents/fcdownloader/extension) directory.

To build extension packages:
```bash
npm run pack:extension
```
See [extension/README.md](file:///Users/imac/Documents/fcdownloader/extension/README.md) for Firefox/Safari guides.

### 4. Desktop Companion

Run the Electron interface and the local Go helper:
```bash
cd desktop-companion
npm install
npm start
```
For building the compiled Go helper executable:
```bash
npm run helper:build
```
See [desktop-companion/README.md](file:///Users/imac/Documents/fcdownloader/desktop-companion/README.md).

---

## Verification & Testing

Verify correctness across all surfaces with the following test commands:

```bash
# Type-check TypeScript files
npm run typecheck

# Run on-device extraction tests (universal probe, manifest inspector, etc.)
npm run test:universal-probe

# Validate Safari extension files
npm run validate:safari-extension

# Run server unit tests (requires python/pytest)
npm run test:server

# Run all checks (typecheck + universal probe + extension validate + doctor)
npm run check
```

---

## Deployment

### Fly.io Backend
The FastAPI server is deployed to Fly.io:
```bash
cd server
fly deploy
```

### Mobile App (EAS)
Configure EAS builds for iOS/Android using [eas.json](file:///Users/imac/Documents/fcdownloader/eas.json).

---

## Documentation Index
* [Architecture & Internals](file:///Users/imac/Documents/fcdownloader/docs/architecture.md)
* [Build Notes](file:///Users/imac/Documents/fcdownloader/docs/BUILD_NOTES.md)
* [Lessons Learned](file:///Users/imac/Documents/fcdownloader/docs/LESSONS_LEARNED.md)
* [Release Setup](file:///Users/imac/Documents/fcdownloader/docs/RELEASE_SETUP.md)
* [Supported Websites list](file:///Users/imac/Documents/fcdownloader/docs/SUPPORTED_WEBSITES_VERIFICATION_2026-05-30.md)

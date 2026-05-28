# FCDownloader Companion

Electron desktop companion for local yt-dlp + ffmpeg downloads. It starts the
optional local helper used by the browser extension and web app:

```text
http://127.0.0.1:8765/health
http://127.0.0.1:8765/formats?url=<public media page url>
http://127.0.0.1:8765/download?url=<public media page url>&max_height=1080
http://127.0.0.1:8765/youtube-hd?url=<youtube page url>
```

## Development

```powershell
cd desktop-companion
npm install
npm start
```

During development, the app first uses a built helper executable from
`desktop-companion/build/helper/` when present. If it is missing, it falls back
to Python and the repo venv at `D:\fcdownloader\.venv\Scripts\python.exe`.

The app registers the `fcdownloader-companion://start` protocol. The extension
and web page use that protocol when the user explicitly asks to open the
Companion.

## Build the bundled helper

```powershell
cd desktop-companion
npm run helper:build
```

This builds `scripts/local-youtube-helper.py` into a native executable using
PyInstaller and pinned helper dependencies from `helper-requirements.txt`.
Public installers include this executable, so users do not need Python,
or `yt-dlp` installed separately.

The helper no longer bundles ffmpeg. It first uses `FCDL_FFMPEG_EXE`,
`IMAGEIO_FFMPEG_EXE`, or a system `ffmpeg` on `PATH`; if none is available, it
downloads the pinned ffmpeg binary on first use and caches it under the user's
FCDownloader cache directory. Set `FCDL_FFMPEG_DIR` to override the cache
folder, or `FCDL_FFMPEG_BASE_URL` to mirror the ffmpeg binaries.

## Packaging

```powershell
cd desktop-companion
npm run dist
```

## Experimental no-browser Go companion

```powershell
cd desktop-companion
npm run variants:nobrowser-go
npm run test:nobrowser-go
```

This builds a small native helper plus tray controller. The helper pins
`yt-dlp` to `2026.03.17` from `nobrowser-go-helper/tool_manifest.json` and
verifies downloads with SHA-256 when a hash is present. Cached tools with a
known mismatched hash are removed and downloaded again. Logs are written to the
FCDownloader cache under `logs/native-helper.log`; set `FCDL_YOUTUBE_TEST_URL`
before running the test script to include a live YouTube formats regression.

The Windows tray menu includes Start, Stop, Status, Install/update video tools,
Open cache folder, Open mirror config, Open log, and Run at login. The installer
also creates Start Menu shortcuts for the same maintenance tasks. `GET /tools`
reports cached tool status, `GET /tools/ensure` downloads or repairs pinned
tools before the first media download, and `GET /tools/progress` reports current
first-use download progress. Restricted-network users can edit
`helper-config.json` from the tray or Start Menu to set a `ytDlpUrl` or
`ffmpegBaseUrl` mirror.

Local helper access is still open by default for the extension and web hub, but
the Go helper rejects non-local `Host` headers. Set `FCDL_HELPER_TOKEN` to
require `X-FCDL-Helper-Token` or `?token=...`, and set
`FCDL_ALLOWED_ORIGINS` to a comma-separated origin allowlist when you want
stricter local CORS.

The same command also cross-builds macOS Intel and Apple Silicon helper
packages in `dist-nobrowser-go-mac/`. Each package contains a background
`.app` wrapper plus a terminal fallback binary. On macOS release builders, set
`FCDL_MAC_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID` to sign, notarize, and staple the `.app` before archiving.

For trusted public releases, configure code-signing/notarization secrets as
described in `docs/RELEASE_SETUP.md`.

## Size audits

```powershell
cd desktop-companion
npm run helper:audit-size
npm run helper:audit-summary
npm run lite:audit-size
```

The helper audit writes `build/helper-size-summary.json`. The lite audit writes
`build/lite-size-summary.json`. In practice the Electron lite build is still
dominated by Chromium/Electron runtime files, while the compatibility helper is
dominated by Python, OpenSSL, sqlite, and the full `yt_dlp` package. Treat the
Go NoBrowser companion as the preferred small Windows helper and the PyInstaller
helper as the broad compatibility fallback.

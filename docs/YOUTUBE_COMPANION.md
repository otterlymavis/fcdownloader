# YouTube HD Companion App

## Decision

YouTube HD downloads should use a local desktop companion app. The browser
extension can detect the video and start the browser download, but it cannot
reliably run the required native tooling itself.

Server-only HD is not reliable for public users:

- YouTube often blocks datacenter IPs, including Fly.io-style backend hosts.
- User browser cookies do not always make a server session trusted.
- Googlevideo URLs captured in the browser can be tied to the user's network
  path, so server-side muxing can return empty files.
- HD YouTube is normally separate video plus audio, so a muxer such as ffmpeg
  is required.

## Current Local Protocol

The extension calls a local HTTP helper:

```text
GET http://127.0.0.1:8765/health
GET http://127.0.0.1:8765/youtube-hd?url=<youtube page url>
```

The helper runs yt-dlp, resolves ffmpeg from `FCDL_FFMPEG_EXE`, PATH, or a
first-use cache, muxes the best MP4 video/audio up to 1080p, and returns a
real MP4 response to the browser.

For development:

```powershell
scripts/start-youtube-helper.ps1
```

## Recommended Public Packaging

Use Electron for the first public companion app.

Reasons:

- It is the most common desktop companion-app stack for browser extensions.
- Windows/macOS/Linux installers and auto-update are standard through
  electron-builder or similar tooling.
- The app can run a background local service, show a tray icon, and expose
  status/errors without asking users to run PowerShell.
- It can bundle or download pinned yt-dlp and ffmpeg binaries during install.

Tauri is a good later option if app size matters more than implementation
speed. Native messaging is technically cleaner for extension-to-app IPC, but
installation is more browser-specific and harder to support at the start.

The Electron app lives in `desktop-companion/`. It wraps the local helper and
exposes start/stop/status UI. Public builds now package the helper as a native
PyInstaller executable with pinned `yt-dlp`, so users do not need Python setup.
ffmpeg is downloaded and cached the first time the helper needs to mux a
download, unless a system or explicitly configured ffmpeg is already available.

## Target Flow

1. User installs the FCDownloader extension.
2. User installs the FCDownloader Companion desktop app.
3. Companion starts on login and listens only on `127.0.0.1`.
4. Companion registers `fcdownloader-companion://start`.
5. Extension tries `/health`; if unavailable, it opens the companion protocol
   and retries for a short window.
6. Clicking the item downloads through `/youtube-hd`, producing a muxed MP4.

## Security Notes

- Bind only to `127.0.0.1`.
- Keep the API small: `/health` and `/youtube-hd`.
- Accept only YouTube page URLs, not arbitrary media URLs.
- Do not expose cookies through the local API.
- Add a per-install token before public release if the helper gains any
  broader file or network capabilities.

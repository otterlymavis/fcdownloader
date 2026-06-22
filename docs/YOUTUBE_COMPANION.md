# YouTube HD Companion App

## Decision

The desktop Companion is an optional capability upgrade. The browser extension
must continue to offer every usable direct, captured-stream, and backend route
when Companion is missing, stopped, outdated, or still installing tools.

Companion is preferred only when a download needs native extraction or muxing.
Its absence may reduce available quality or formats, but must not disable the
popup, media detection, standard downloads, or backend-provided streams.

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

## Public Packaging

The canonical public Companion is the lightweight Go tray installer. It alone
owns `fcdownloader-companion://start`; legacy and Electron variants use
separate protocol names so installing or uninstalling them cannot replace the
canonical launcher.

Compatibility is determined primarily by the helper API reported by `/health`:

```json
{
  "apiVersion": "v1",
  "version": "0.4.0-go",
  "variant": "nobrowser-go",
  "buildId": "exact-build-identity"
}
```

Matching API versions remain compatible even when release patch versions
differ. `release.json` is the shared source for extension/helper compatibility.

## Target Flow

1. User installs the extension and standard downloads work immediately.
2. The popup presents Companion as an optional HD/advanced-format upgrade.
3. If installed, Companion starts on login and listens only on `127.0.0.1`.
4. The extension uses direct, captured, or backend routes before requiring
   Companion.
5. A helper-only choice falls back to the best standalone candidate when
   Companion is unavailable or incompatible.
6. Install/update actions always resolve the current canonical installer.

## Security Notes

- Bind only to `127.0.0.1`.
- Keep the API small: `/health` and `/youtube-hd`.
- Accept only YouTube page URLs, not arbitrary media URLs.
- Do not expose cookies through the local API.
- Add a per-install token before public release if the helper gains any
  broader file or network capabilities.

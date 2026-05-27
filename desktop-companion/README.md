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
`yt-dlp`, or ffmpeg installed separately.

## Packaging

```powershell
cd desktop-companion
npm run dist
```

For trusted public releases, configure code-signing/notarization secrets as
described in `docs/RELEASE_SETUP.md`.

# Release Setup

FCDownloader public releases are a bundle of separate surfaces that share the
same backend and helper API contracts.

## Compatibility

| Release | Mobile app | Extension | Companion | Backend API | Local helper API |
|---|---|---|---|---|---|
| 1.5.0 | 1.1.x | 1.4.x | 0.2.x | v1 | v1 |

The numbers do not need to match. The contract versions do.

## Required channels

- Backend: deploy `server/` first. The current Fly app is
  `https://fcdownloader-extractor.fly.dev`.
- Companion: build installers from `desktop-companion/`. The installer bundles
  a PyInstaller-built helper executable with pinned `yt-dlp` and
  `imageio-ffmpeg`, so users do not need Python on PATH.
- Extension: build with `EXTENSION_DEFAULT_BACKEND` so users do not need to
  configure the backend manually.
- Web: bake the backend and release links into `web/index.html`, then deploy
  `web/` to a static host.
- Mobile: build production App Store / Play Store binaries with EAS.
  Store submission is intentionally not automated yet; submit from EAS, App
  Store Connect, or Play Console after store metadata and credentials are
  configured.

## GitHub setup

Repository secrets:

- `FLY_API_TOKEN`: deploys the extractor backend.
- `EXPO_TOKEN`: runs EAS builds.
- `EXPO_PUBLIC_EXTRACTOR_URL`: backend URL baked into mobile and web builds.
- `EXPO_PUBLIC_EXTRACTOR_TOKEN`: optional backend trusted token for mobile.
- `EXTENSION_DEFAULT_BACKEND`: backend URL baked into extension packages.
- `COMPANION_CSC_LINK`: Windows/macOS code signing certificate for electron-builder.
- `COMPANION_CSC_KEY_PASSWORD`: password for the signing certificate.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: macOS notarization.

Repository variables:

- `MOBILE_DOWNLOAD_URL`
- `EXTENSION_DOWNLOAD_URL`
- `COMPANION_DOWNLOAD_URL`
- `SELF_HOST_URL`

## Release order

1. Deploy backend: run **Deploy Backend to Fly**.
2. Tag a bundle release: `v1.5.0`.
3. Let tag workflows attach companion installers, extension zip, and web zip.
4. Run **EAS Production Build** for `all`.
5. Submit mobile builds manually from EAS/App Store Connect/Play Console once
   store metadata, privacy answers, screenshots, and credentials are ready.
6. Publish or update the static `web/` deployment so it points to the latest
   release links.

## Local commands

```powershell
npm run bake:web
npm run pack:extension
npm run dist:companion
```

For the extension:

```powershell
$env:EXTENSION_DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev"
npm run pack:extension
```

For the web hub:

```powershell
$env:EXTRACTOR_URL = "https://fcdownloader-extractor.fly.dev"
$env:COMPANION_DOWNLOAD_URL = "https://github.com/otterlymavis/fcdownloader/releases/latest"
npm run bake:web
```

## Signing status

The workflows are wired for signing and notarization, but they cannot produce
trusted public installers until the signing secrets above exist. Unsigned builds
are useful for testing only.

## Health checks

- Public backend: `GET https://fcdownloader-extractor.fly.dev/`
- Backend version: `GET https://fcdownloader-extractor.fly.dev/version`
- Local Companion helper: `GET http://127.0.0.1:8765/health`

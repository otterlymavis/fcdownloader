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
  a PyInstaller-built helper executable with pinned `yt-dlp`, so users do not
  need Python on PATH. ffmpeg is resolved from an explicit path, PATH, or a
  first-use download cache.
- NoBrowser Go Companion: build with `npm run variants:nobrowser-go` from
  `desktop-companion/`. This emits a tiny Windows installer plus macOS Intel
  and Apple Silicon helper packages. The macOS packages contain a background
  `.app` wrapper and should be signed/notarized before public distribution.
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
- `RELEASE_KEYSTORE_BASE64`: Android upload keystore for legacy APK workflow.
- `MYAPP_UPLOAD_KEY_ALIAS`: Android upload key alias.
- `MYAPP_UPLOAD_STORE_PASSWORD`: Android upload keystore password.
- `MYAPP_UPLOAD_KEY_PASSWORD`: Android upload key password.
- `EXTENSION_DEFAULT_BACKEND`: backend URL baked into extension packages.
- `COMPANION_CSC_LINK`: Windows/macOS code signing certificate for electron-builder.
- `COMPANION_CSC_KEY_PASSWORD`: password for the signing certificate.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: macOS notarization.
- `FCDL_MAC_SIGN_IDENTITY`: Developer ID Application identity used by the
  experimental NoBrowser Go macOS `.app` packager.
- `FCDL_YOUTUBE_TEST_URL`: optional public YouTube URL used by the scheduled
  NoBrowser Go live formats regression.

Repository variables:

- `ANDROID_DOWNLOAD_URL`
- `IOS_DOWNLOAD_URL`
- `EXTENSION_DOWNLOAD_URL`
- `HELPER_DOWNLOAD_URL`
- `HELPER_NOBROWSER_GO_DOWNLOAD_URL`: preferred tiny Windows helper installer
  for web/download pages when available.
- `HELPER_CHECKSUMS_URL`: URL for `companion-artifacts.sha256`.
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
$env:ANDROID_DOWNLOAD_URL = "https://github.com/otterlymavis/fcdownloader/releases/latest/download/fcdownloader-v1.5.7.apk"
$env:IOS_DOWNLOAD_URL = "https://testflight.apple.com/join/your-code"
$env:EXTENSION_DOWNLOAD_URL = "https://github.com/otterlymavis/fcdownloader/releases/latest/download/fcdownloader-extension-v1.5.7.zip"
$env:HELPER_DOWNLOAD_URL = "https://github.com/otterlymavis/fcdownloader/releases/latest/download/FCDownloader%20Companion%20NoBrowser%20Go%20Setup%200.2.1.exe"
$env:HELPER_CHECKSUMS_URL = "https://github.com/otterlymavis/fcdownloader/releases/latest/download/companion-artifacts.sha256"
npm run bake:web
```

For the experimental NoBrowser Go companion:

```powershell
cd desktop-companion
npm run variants:nobrowser-go
npm run test:nobrowser-go
npm run test:nobrowser-go:installer
```

The **NoBrowser Go Regression** GitHub Actions workflow runs weekly on Windows.
It always builds the tiny helper, runs the helper smoke test, and runs the
installer smoke test. If `FCDL_YOUTUBE_TEST_URL` is configured, it also checks a
live YouTube formats extraction path.

On tagged companion releases, `release-companion.yml` now attaches both:

- the regular Electron companion installer
- the tiny `FCDownloader Companion NoBrowser Go Setup ...exe`
- `companion-artifacts.json` and `companion-artifacts.sha256` checksums

Use the NoBrowser Go installer as the preferred Windows helper download link.
Keep the Electron/PyInstaller companion available as the compatibility fallback.

On a macOS release builder, signing/notarization is enabled when these
environment variables are present:

```bash
export FCDL_MAC_SIGN_IDENTITY="Developer ID Application: Example Team (TEAMID)"
export APPLE_ID="release@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
npm run variants:nobrowser-go
```

## Signing status

The workflows are wired for signing and notarization, but they cannot produce
trusted public installers until the signing secrets above exist. Unsigned builds
are useful for testing only. Cross-built macOS zips produced on Windows may need
`chmod +x` after extraction; release macOS packages should be built on macOS so
`ditto`, `codesign`, `notarytool`, and `stapler` preserve the app bundle
correctly.

## Health checks

- Public backend: `GET https://fcdownloader-extractor.fly.dev/`
- Backend version: `GET https://fcdownloader-extractor.fly.dev/version`
- Local Companion helper: `GET http://127.0.0.1:8765/health`

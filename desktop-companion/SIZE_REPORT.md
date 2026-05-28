# Companion Size Report

Last generated from local build artifacts with:

```powershell
npm run helper:audit-size
npm run helper:audit-summary
npm run lite:audit-size
```

## Current Windows variants

| Variant | Output | Size | Notes |
|---|---:|---:|---|
| NoBrowser Go | `dist-nobrowser-go-ver/FCDownloader Companion NoBrowser Go Setup 0.2.1.exe` | ~2.8 MB | Preferred tiny Windows companion. Downloads `yt-dlp` and ffmpeg on first use. |
| Lite Electron | `dist-lite-ver-fresh/FCDownloader Companion Lite Setup 0.2.1.exe` | ~105 MB | Still carries Electron/Chromium plus the compatibility helper. |
| Compatibility helper | `build/helper/fcdownloader-local-helper.exe` | ~21.7 MB | Python/PyInstaller fallback; no bundled ffmpeg. |

## Lite Electron unpacked footprint

Top installed-size contributors from `build/lite-size-summary.json`:

| Component | Approx size | Practical action |
|---|---:|---|
| Electron executable | ~201 MB | Not meaningfully reducible without leaving Electron. |
| Electron graphics/media DLLs | ~43 MB | Some can be removed only if Chromium features are not used; risky for Electron. |
| Compatibility helper | ~21.7 MB | Replace with NoBrowser Go helper where possible. |
| Chromium license/resource files | ~25 MB | Mostly required packaging/runtime assets. |

Conclusion: further `lite-ver` reductions are limited. The meaningful tiny path
is the Go tray/helper installer.

## PyInstaller compatibility helper

Top compressed groups from `build/helper-size-summary.json`:

| Group | Approx size | Practical action |
|---|---:|---|
| Python/OpenSSL/sqlite/runtime DLLs | largest share | Hard to remove while running `yt_dlp` under Python. |
| `yt_dlp` package | ~2.8 MB | Required for compatibility helper extraction. |
| Python extension modules | ~1.4 MB | Exclusions help only a little. |

Current mitigation:

- ffmpeg is no longer bundled.
- unused stdlib modules such as `tkinter`, `unittest`, `pydoc`, and `doctest`
  are excluded.
- optional UPX is supported with `FCDL_PYI_UPX_DIR`.

Conclusion: keep this as the compatibility fallback, but prefer NoBrowser Go for
public Windows helper downloads.

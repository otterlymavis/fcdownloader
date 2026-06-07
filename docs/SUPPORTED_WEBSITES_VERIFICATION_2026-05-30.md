# Supported Websites Verification - 2026-05-30

Command run from the repository root:

```powershell
python scripts\verify-supported-websites-full.py
```

Result:

- Total cases: 93
- Passed: 77
- Unexpected failures: 0
- Expected blocked: 16

The full JSON report was written locally to `artifacts/supported-websites-full-report.json`.
That directory is intentionally ignored because these reports are generated artifacts.

## Expected Blocked Cases

These entries are counted separately from failures because they require geo access,
login cookies, a browser session, DRM-authorized playback, a currently live stream, or
working DNS/TLS from the test environment.

- TVer: often geo, DRM, or current-episode restricted.
- ABEMA: often region or DRM restricted.
- FC2 Live: sample channel was offline during the run.
- TBS: sample commonly geo restricted and extractor dependent.
- FOD / Fuji TV: DRM and region restrictions are common.
- Yahoo Japan video/news: datacenter fetches often receive 403.
- Kakao TV: current CDN media URL rejects direct server probes.
- Threads: Meta generally needs browser runtime and cookies.
- Xiaohongshu / XHS: often requires an app or browser session.
- Bilibili dynamic / opus: test post had no valid video URL, and dynamic pages often need browser/session context.
- Naver Entertainment: home feed is rendered client-side; direct article URLs are handled when available.
- Naver Sports: home feed is client-side or unavailable to this server environment.
- Yahoo Japan articles: server fetch often receives 403; extension page HTML path is supported.
- HP+ MORE: DNS resolution for `more.hpplus.jp` failed in this environment.
- Mantan Web: server fetch currently receives 403; browser/session path is used when available.
- Flash: `flash.jp` DNS/TLS lookup failed in this environment.

## Notes

Passing cases included direct media, HLS manifests, yt-dlp-backed video extraction,
paired audio/video outputs, and image gallery extraction across the supported sample
set. No source-code change was required by this verification run.

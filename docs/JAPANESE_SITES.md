# Japanese Site Support

FCDownloader supports Japanese sites only for media the user owns, controls, or
has permission to access. The backend and extension do not attempt to bypass DRM,
paid access controls, geo restrictions, or site terms.

## First-pass supported routes

These sites are routed through the backend or local browser context because
they commonly use HLS, JavaScript players, authenticated sessions, or referer
checks:

- Niconico / NicoNico Channel Plus
- TVer
- ABEMA
- NHK video, VOD, Radiru, and NHK for School pages supported by yt-dlp
- TwitCasting
- FC2 Video / FC2 Live
- OpenREC
- TBS / TBS Free
- FOD / Fuji TV
- Yahoo Japan video/news pages

The backend prefers yt-dlp first, then falls back to HLS/DASH, Open Graph media,
generic media URL scanning, and embedded player detection. Japanese sites get an
`Accept-Language: ja` hint and common referer/origin headers where needed.

## Not supported

Do not add extractors that defeat DRM or paid viewing checks. For services such
as Lemino, U-NEXT, WOWOW, Hulu Japan, Netflix, Amazon Prime Video, or DRM-backed
TVer/ABEMA/FOD assets, FCDownloader should fail cleanly and explain that the
stream is protected.

## Extension behavior

The extension adds a single backend-routed item for known Japanese video pages
instead of filling the popup with thumbnails or ad/media fragments. If a page
also exposes a direct `<video>`, iframe, HLS, or DASH URL, the service worker
still de-duplicates and ranks the page-level route above low-confidence network
captures.

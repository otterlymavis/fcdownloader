# Japanese Site Support

FCDownloader supports Japanese sites only for media the user owns, controls, or
has permission to access. The backend and extension do not attempt to bypass DRM,
paid access controls, geo restrictions, or site terms.

## Supported routes

These sites are routed through the backend or local browser context because
they commonly use HLS, JavaScript players, authenticated sessions, or referer
checks:

### Video and streaming

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
- Naver TV / Naver short links
- Kakao TV
- Bilibili video pages

### News, magazines, and article galleries

These pages are parsed as article/gallery pages and their media downloads are
routed through the backend proxy when the CDN needs a referer. The goal is to
return the article body media, not logos, site headers, or related-story
thumbnails.

- Modelpress / mdpr.jp
- Naver Blog, Naver News, Naver Entertainment, Naver Sports
- Ameblo / Ameba Blog
- Natalie.mu
- Oricon
- Kstyle
- Daum / Tistory
- Livedoor Blog
- Yahoo Japan article galleries
- Pixiv / Fanbox, for media available to the user's authorized session
- Bilibili dynamic, opus, and read/image posts
- Bunshun Online
- Daily Shincho
- News Post Seven / Josei Seven
- FRIDAY / Kodansha, Gendai Media
- With, ViVi, CanCam, CLASSY, JJ, Ginger, ar, bis, Ray
- HP+ magazine sites, including non-no, SPUR, MAQUIA, LEE, BAILA, and MORE
- anan web, Croissant Online, FRaU, mi-mollet
- Fashion Press, Fashionsnap, WWD Japan
- The Television, Mantan Web, Crank In, Cinema Today, Eiga.com
- Real Sound, Spice, JPrime, Smart Flash, Flash, Nikkan Gendai, Asagei
- Entame Next, GirlsNews, Tokyo Sports
- Hochi, Sponichi, Nikkan Sports, Sanspo
- Mainichi, Asahi, Yomiuri, Sankei, Tokyo Shimbun, Kyodo, 47News, Jiji
- ITmedia, Impress/Watch, Mynavi News, ASCII, Gigazine

The backend prefers yt-dlp first, then falls back to HLS/DASH, Open Graph media,
generic media URL scanning, and embedded player detection. Japanese sites get an
`Accept-Language: ja` hint and common referer/origin headers where needed.

## Hybrid download architecture

Japanese news, magazine, and blog pages use a hybrid path:

- The backend extracts the article/body media URLs and returns the headers each
  CDN expects.
- Android and iOS download directly from the media CDN when possible, replaying
  those headers locally and falling back to the backend only if direct download
  fails.
- The web app and browser extension download safe, headerless media URLs
  directly. If a gallery item needs cookies, referer headers, or a known
  restricted CDN, they route that item through the backend `/proxy` endpoint.

This keeps server bandwidth low for plain media while still working on sites
that block browser save-as or cross-origin direct downloads.

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

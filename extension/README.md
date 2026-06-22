# FCDownloader - Browser Extension

Captures media from pages you choose so you can save videos, images, audio,
and galleries that you own, control, or have permission to access. Toolbar
icon -> click -> see what's been detected -> Download.

Why use the extension instead of the web app or bookmarklet:

| | Bookmarklet (web app) | Extension |
|---|---|---|
| One-click activation | Drag to bookmarks, click | Toolbar icon |
| Read HttpOnly cookies | JS can't | `chrome.cookies` API |
| Capture URLs at network layer | No | `webRequest.onCompleted` |
| Download with chosen filename | Cross-origin filename often ignored | `chrome.downloads.download` |
| Skip server bandwidth for plain mp4 | Always via backend | Direct CDN download when possible |

The same backend (`https://your-instance.fly.dev`) is used for cases that
need server-side muxing, authenticated header replay, or extraction. Configure
a different backend in extension Settings.

Supported backend routes include major video/social sites such as YouTube,
Bilibili, Vimeo, TikTok, Instagram, Threads, X/Twitter, Facebook, Pinterest,
Dailymotion, Reddit, Weibo, Xiaohongshu, TVer, Niconico, ABEMA, Naver, NHK,
TBS, FOD/Fuji TV, TwitCasting, OpenREC, FC2, and Yahoo Japan. Article/gallery
support includes many Japanese and Korean news, magazine, and blog sites such
as Modelpress, Naver Blog/News, Ameblo, Natalie, Oricon, Kstyle, Daum/Tistory,
Kakao TV, Livedoor Blog, Yahoo Japan galleries, Pixiv/Fanbox, Bilibili dynamic
posts, Bunshun, Daily Shincho, News Post Seven, FRIDAY/Kodansha, Fashion Press,
Fashionsnap, WWD Japan, Real Sound, JPrime, Smart Flash, major newspapers,
sports papers, and Japanese tech/news sites.

The extension uses a hybrid download path. Backend extraction finds the real
media URLs and headers. The extension downloads safe headerless files directly
with `chrome.downloads`; gallery items that need cookies, referer replay, or a
known restricted CDN are routed through the backend `/proxy` endpoint.

## Load it for testing

### Chrome / Edge / Brave

1. Open `chrome://extensions/` (or `edge://extensions/`, `brave://extensions/`)
2. Toggle **Developer mode** on.
3. **Load unpacked** -> pick the `D:\fcdownloader\extension` folder.
4. The FCDownloader icon appears in the toolbar. Click it on any video page.

To update after code changes, hit **Reload** on the extension card.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on** -> pick `extension/manifest.json`
3. For permanent install, sign the extension through AMO.

## How it works internally

```
content.js          - scans the rendered DOM on every page.
background.js       - service worker; stores per-tab items, observes
                      webRequest completions, reads current-site cookies,
                      and routes downloads.
popup.html/.js/.css - toolbar dropdown.
options.html/.js    - backend URL override and route-through-backend toggle.
```

## Privacy and permissions

FCDownloader does not include analytics, advertising, or telemetry. The
extension may process the current page URL, detected media URLs, media
metadata, rendered page HTML snippets, source-audit diagnostics, and cookies
for the current site when authenticated access is needed. That data is sent
only to the backend URL configured in the extension and to the media CDNs the
browser downloads from.

See the repository-level `PRIVACY.md` before publishing, and link that policy
from the Chrome Web Store, Firefox Add-ons, and any public web page.

## Permissions explained

| Permission | Why |
|---|---|
| `<all_urls>` | Inject content script on user-visited pages because supported media sites and embedded players use many domains |
| `downloads` | Trigger user-requested downloads to the browser Downloads folder |
| `cookies` | Read cookies for the current page domain to forward to the configured backend when authenticated access is needed |
| `storage` | Save backend URL and preferences via `chrome.storage.sync` |
| `tabs` | Read the active tab URL when the popup opens |
| `webRequest` | Observe network requests to catch HLS/DASH manifest URLs the DOM does not expose |

No data is sold. No analytics or telemetry are built into the extension.

## Backend configuration

Click the settings icon in the popup, or right-click the extension icon ->
**Options**. Set the backend URL to your own deployment if you do not want to
share the default. Leave blank to use the backend baked into a public build.

## Building for the Chrome Web Store

For public distribution, build the helper and extension as one paired artifact
set. This deletes/regenerates `dist/extension`, stamps matching build IDs into
the extension and helper, and writes release manifests under `dist/`:

```powershell
$env:EXTENSION_DEFAULT_BACKEND='https://your-instance.fly.dev'
npm run build:distribution
npm run smoke:distribution:static
npm run smoke:distribution
```

Upload `dist/fcdownloader-extension-v<version>.zip` at
https://chrome.google.com/webstore/devconsole.

For Firefox, upload the same source package to https://addons.mozilla.org for
signing.

## Known limitations

- **Service Workers (MV3) sleep** after idle periods. The extension wakes on
  user action, but tab state may be cleared between sessions.
- **`chrome.cookies` reads only the current tab's site cookies**. Cross-domain
  auth does not automatically carry across unrelated sites.
- **FCDownloader Companion is optional**. Without it, the extension still uses
  direct browser downloads, backend extraction, page playback capture, and the
  YouTube 360p browser stream when available. With Companion running, YouTube
  HD downloads are routed through local yt-dlp + ffmpeg instead of a datacenter
  backend that may be blocked by YouTube. The popup checks
  `http://127.0.0.1:8765/health` and can open
  `fcdownloader-companion://start` on request.
- **Direct browser downloads from cross-origin CDNs** work for many mp4 CDNs.
  Restricted CDNs may require backend proxying.
- **Firefox Android** can use custom collections, but it is not officially
  packaged here. Chrome Android does not support extensions.

## Releasing a public-distribution build

The committed source has an empty `FCDL_DEFAULT_BACKEND` in `config.js`, so
building the extension as-is requires the user to enter a backend URL once.
For a public-facing release, always build the paired helper + extension
distribution artifacts from source:

```bash
EXTENSION_DEFAULT_BACKEND=https://your-instance.fly.dev npm run build:distribution
npm run smoke:distribution:static
npm run smoke:distribution
```

`smoke:distribution:static` is suitable for CI because it verifies the generated
folder, the built helper, and matching build IDs without needing Chrome.
`smoke:distribution` launches Chrome for Testing and verifies helper detection
plus Bilibili 1080p extraction. For the heavier end-to-end check that also
starts a Bilibili download through the extension route, run:

```bash
npm run smoke:distribution:download
```

Do not manually edit or ship a previously generated `dist/extension` folder.
It is a copied build artifact and can go stale. Chrome unpacked-extension
testing should point to the freshly generated `dist/extension` after
`npm run build:distribution`.

Automated releases should set the `EXTENSION_DEFAULT_BACKEND` repository
secret, run `npm run build:distribution`, then run static smoke from the
generated artifacts before publishing. Run the Chrome smoke before publishing
from a local machine or CI image that has Chrome for Testing available.

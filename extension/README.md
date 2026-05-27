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
metadata, and cookies for the current site when authenticated access is
needed. That data is sent only to the backend URL configured in the extension
and to the media CDNs the browser downloads from.

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
| `activeTab` | Programmatic invocation on the current tab |
| `webRequest` | Observe network requests to catch HLS/DASH manifest URLs the DOM does not expose |

No data is sold. No analytics or telemetry are built into the extension.

## Backend configuration

Click the settings icon in the popup, or right-click the extension icon ->
**Options**. Set the backend URL to your own deployment if you do not want to
share the default. Leave blank to use the backend baked into a public build.

## Building for the Chrome Web Store

For public distribution, use the packaging script so the backend URL is baked
into `dist/extension/config.js` without committing it to source:

```powershell
$env:EXTENSION_DEFAULT_BACKEND='https://your-instance.fly.dev'
npm run pack:extension
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
For a public-facing release, bake in the URL at packaging time:

```bash
EXTENSION_DEFAULT_BACKEND=https://your-instance.fly.dev npm run pack:extension
```

Automated releases should set the `EXTENSION_DEFAULT_BACKEND` repository
secret and run the release workflow from a version tag.

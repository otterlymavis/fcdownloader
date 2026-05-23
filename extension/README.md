# FCDownloader — Browser Extension

Captures videos from the page you're on (YouTube, Vimeo, Twitter/X,
Instagram, Threads, TikTok, AmusePlus, and ~1800 other sites yt-dlp knows
about). Toolbar icon → click → see what's been detected → Download.

Why use the extension instead of the web app or bookmarklet:

| | Bookmarklet (web app) | Extension |
|---|---|---|
| One-click activation | Drag to bookmarks, click | Toolbar icon |
| Read HttpOnly cookies | ❌ JS can't | ✅ `chrome.cookies` API |
| Capture URLs at network layer | ❌ | ✅ `webRequest.onCompleted` |
| Download with chosen filename | ⚠ cross-origin filename ignored | ✅ `chrome.downloads.download` |
| Skip server bandwidth for plain mp4 | ❌ always via backend | ✅ direct CDN download when possible |

Same backend (`https://fcdownloader-extractor.fly.dev`) is used for cases
that genuinely need server-side muxing (HLS → mp4, paired YouTube HD).
Configure a different backend in extension Settings.

## Load it for testing (no store install needed)

### Chrome / Edge / Brave

1. Open `chrome://extensions/` (or `edge://extensions/`, `brave://extensions/`)
2. Toggle **Developer mode** on (top-right)
3. **Load unpacked** → pick the `D:\fcdownloader\extension` folder
4. The FCDownloader icon appears in the toolbar. Click it on any video page.

To update after code changes: hit **Reload** on the extension card (or use
the keyboard shortcut Ctrl+R on the extensions page).

### Firefox

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/manifest.json`
3. The extension stays loaded until Firefox restarts. For permanent
   install you'd need to sign the extension (free via AMO; required by
   stable Firefox releases).

### Firefox Android

Firefox Android supports extensions via a custom collection — possible but
fiddly. Not officially packaged here yet.

## How it works internally

```
content.js          —  scans the rendered DOM on every page (iframes,
                       <video>, og:video meta, Meta JSON, YouTube
                       ytInitialPlayerResponse, Bilibili __playinfo__)

background.js       —  service worker. Maintains per-tab item list,
                       listens to webRequest.onCompleted for media URLs,
                       reads cookies via chrome.cookies, routes downloads
                       (direct browser fetch or backend /download).

popup.html/.js/.css —  toolbar dropdown. Lists detected items; "Find
                       videos on this page" hits backend /extract for
                       title + thumbnail + label.

options.html/.js    —  backend URL override, route-through-backend toggle.
```

## Permissions explained (the things Chrome will warn about)

| Permission | Why |
|---|---|
| `<all_urls>` | Inject content script everywhere — needed because video sites are 1800+ and can't be enumerated |
| `downloads` | Trigger file downloads to the user's Downloads folder |
| `cookies` | Read HttpOnly session cookies for the current page domain to forward to the backend (so authenticated content works) |
| `storage` | Save backend URL + preferences via `chrome.storage.sync` |
| `tabs` | Read the active tab's URL when the popup opens |
| `activeTab` | Programmatic invocation on the current tab |
| `webRequest` (host_permissions) | Observe network requests to catch HLS/DASH manifest URLs the DOM doesn't expose |

No data is sent anywhere except (a) the backend URL you configure and (b)
the CDN URLs that the browser fetches for downloads. No analytics, no
telemetry.

## Backend configuration

Click the ⚙ icon in the popup, or right-click the extension icon →
**Options**. Set the backend URL to your own deployment if you don't want
to share the default. Leave blank to use `https://fcdownloader-extractor.fly.dev`.

## Building for the Chrome Web Store

```powershell
cd D:\fcdownloader\extension
# Zip everything excluding readme/docs:
Compress-Archive -Path manifest.json,background.js,content.js,popup.html,popup.css,popup.js,options.html,options.js,icons -DestinationPath fcdownloader-extension.zip
```

Then upload `fcdownloader-extension.zip` at
https://chrome.google.com/webstore/devconsole. One-time $5 developer fee
the first time. Review usually takes 2-7 days.

For Firefox: same zip, upload to https://addons.mozilla.org. Signing is
free and automatic. Once signed, can be installed in stable Firefox
without unpacking.

## Known limitations

- **Service Workers (MV3) sleep** after ~30s idle. The extension wakes
  automatically on user action; tab state may be cleared between sessions
  by design.
- **`chrome.cookies` reads only the domain of the current tab's URL** —
  cross-domain auth (e.g. YouTube auth cookie when on a different site)
  doesn't carry across. Not usually a problem.
- **HD YouTube still needs the backend** — po_token enforcement applies to
  the browser too. The extension's contribution is forwarding the user's
  own cookies (incl. HttpOnly) to the backend, which gives the backend
  access to age-gated / region-locked content the user has rights to.
- **Direct chrome.downloads on cross-origin CDNs**: works for most mp4
  CDNs without CORS restrictions (fbcdn, twimg, tiktokcdn, etc.).
  Falls back to backend on failure.
- **Firefox Android**: works via custom collection but not officially
  packaged here. Chrome Android does not support extensions at all.

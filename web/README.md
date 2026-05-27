# fcdownloader web

Static frontend for the fcdownloader extractor backend. Three files —
`index.html`, `style.css`, `script.js`. No build step, no framework. Deploy
to any static host (Vercel, Cloudflare Pages, GitHub Pages, your own
nginx, …).

The web page is also the public download hub. It links to mobile builds,
browser extension packages, the FCDownloader Companion installer, the web
downloader, and self-hosting docs. It checks
`http://127.0.0.1:8765/health` so desktop users can see whether the optional
Companion helper is ready for local downloads.

## Configure the backend URL

The frontend needs to know where your Fly extractor lives. Order of
precedence (highest first):

1. `?api=https://your-backend` query string  — handy for testing
2. `window.EXTRACTOR_URL = "..."` inline `<script>` before `script.js`
3. `<meta name="extractor-url" content="...">` in `index.html`

If none of these are set the page shows an error instead of attempting a
fetch — there's intentionally no hardcoded fallback so forks of this project
don't accidentally point at someone else's backend.

For your own deploy, the cleanest path is option 3 — edit `index.html`:

```html
<meta name="extractor-url" content="https://your-app.fly.dev">
```

Or bake release metadata with:

```powershell
$env:EXTRACTOR_URL='https://your-app.fly.dev'
$env:ANDROID_DOWNLOAD_URL='https://github.com/you/fcdownloader/releases/latest/download/fcdownloader-v1.1.0.apk'
$env:IOS_DOWNLOAD_URL='https://testflight.apple.com/join/your-code'
$env:EXTENSION_DOWNLOAD_URL='https://github.com/you/fcdownloader/releases/latest/download/fcdownloader-extension-v1.4.2.zip'
$env:HELPER_DOWNLOAD_URL='https://github.com/you/fcdownloader/releases/latest/download/FCDownloader%20Companion%20Setup%200.2.0.exe'
npm run bake:web
```

## Deploy to Vercel (1 minute)

```bash
npm i -g vercel
cd web
vercel               # accept defaults; pick "static" as the framework
vercel --prod        # promote the preview to prod
```

You get a URL like `fcdownloader.vercel.app`. Subsequent pushes to the repo
auto-deploy if you link the project to GitHub.

## Deploy to Cloudflare Pages

1. Sign in at https://pages.cloudflare.com
2. **Create a project → Connect to Git** → pick your fcdownloader repo
3. Build settings:
   - **Build command**: (leave empty)
   - **Build output directory**: `web`
4. Save and deploy. URL is `<project>.pages.dev`.

## Deploy to GitHub Pages

```bash
# From the repo root, push the web/ directory to a gh-pages branch:
git subtree push --prefix web origin gh-pages
```

Then in repo settings → Pages → Branch: `gh-pages`, folder: `/ (root)`.

## CORS

The frontend will make a `POST /extract` request to your Fly backend from a
different origin (e.g. `vercel.app` → `fly.dev`). The backend's CORS is
permissive (`*`) by default. To lock it down once you have a public domain:

```powershell
fly secrets set ALLOWED_ORIGINS="https://your-frontend.vercel.app"
fly deploy
```

Comma-separate multiple origins:
`ALLOWED_ORIGINS="https://fcdl.vercel.app,https://fcdl.pages.dev"`

## What the page does

1. User pastes a URL and clicks **Fetch**.
2. If it is already a direct media URL, the browser downloads it directly.
3. If Companion is running, the page tries local `/formats` and prepares a
   local `/download?url=...&max_height=1080` link.
4. If the helper is absent or cannot extract that URL, the frontend falls back
   to the configured backend `POST /extract` and `GET /download?url=...`.
5. The preview card shows the best available route, title, duration, and kind.

## Privacy policy

Publish `privacy.html` with the static site and link the same policy from app
store and extension store listings. The page explains that FCDownloader does
not add analytics or ads, and that URLs, media metadata, cookies, and backend
request metadata may be processed only to find and download media the user is
authorized to access.

## Cost notes

Unlike the mobile app where the phone fetches CDN bytes directly, the web
flow has the server proxying every byte (ffmpeg downloads from googlevideo,
mux's, streams to the browser). At Fly's $0.02/GB egress this works out to
~$0.002 per 100 MB video. A spend cap on the Fly dashboard is recommended
before you publish the URL widely.

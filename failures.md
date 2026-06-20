# FCDownloader — Known Failures & Extraction Limits

Last updated after session: Bilibili dynamic post fix + structured server error codes.

---

## Fixed in this session (were failing, now work)

| Platform | Fix |
|---|---|
| **Bilibili dynamic / opus** | Dynamic API (`x/polymer/web-dynamic/v1/detail`) resolves embedded BV ID; video posts on `t.bilibili.com` and `bilibili.com/opus` now extract correctly |
| **trilltrill.jp** | New `extract_trilltrill` reads `page_view_content.article_photo_link` |
| **Fashionsnap** | Added `fashionsnap-assets.com` to curated CDN token list |
| **ViVi** | Test URL was a wp-json API endpoint; actual article pages work fine |
| **Mainichi** | Test URL was a category page; article pages work (39 images extracted) |
| **note.com** | New `extract_note` via public REST API `/api/v3/notes/<key>` |
| **LINE Blog** | New curated profile (`obs.line-scdn.net` CDN) |
| **Hatena Blog** | New curated profile (`cdn-ak.f.st-hatena.com` CDN) |
| **FC2 Blog** | New curated profile (`blog-imgs` CDN) |
| **Gyazo** | New curated profile (`i.gyazo.com` CDN) |

---

## Expected failures — auth/subscription/geo

These fail from the server's datacenter IP by design. They work correctly in the browser extension and mobile app when the user is logged in.

| Platform | Reason | Works via |
|---|---|---|
| **Instagram** | Datacenter IP rate-limited; requires login cookies | Browser extension / app WebView |
| **Threads** | Requires auth from datacenter IPs | Browser extension (when logged in) |
| **Reddit** | Server IPs return HTTP 403 | Browser extension `scanRedditAsync` (real IP) |
| **Weibo** | Auth required; mapp.api share links redirect to passport.weibo.cn | App on-device path |
| **Douyin** | Requires login session | App on-device with cookies |
| **ABEMA** | Subscription + region-locked | App WebView (logged in) |
| **OpenREC** | Requires login | App WebView (logged in) |
| **WWD Japan** | Subscription paywall blocks server IP | App WebView (logged in) |

---

## Expected failures — DRM / geo-blocked / offline

| Platform | Reason |
|---|---|
| **TVer** | Japanese broadcast geo-block; `MEDIA_NOT_AVAILABLE` from Fly.io US region |
| **FC2 Live** | Live stream was offline when tested |
| **TBS** | DRM-protected streaming service |
| **FOD / Fuji TV** | Subscription-only; DRM |
| **DMM** | Subscription/DRM; some content geo-blocked |
| **Mildom** | Live stream platform; VOD often requires login |

---

## Partially working / known quirks

| Platform | Status |
|---|---|
| **Naver Entertainment / Sports** | Article pages extract images fine; video content often requires login |
| **YouTube** | Skip-download mode returns SABR manifest (bound to extracting IP) → falls to `ytdl-stream` which works but is slow (~15–30s) |

---

## How to verify an extraction

```bash
# Against live server
curl -s -X POST https://fcdownloader-extractor.fly.dev/extract \
  -H 'Content-Type: application/json' \
  -d '{"pageUrl":"URL_HERE"}' | python3 -m json.tool | head -40

# Against local server
cd server && uvicorn main:app --port 8080 --reload
python3 tests/test_all_urls.py --backend http://localhost:8080
python3 tests/test_all_urls.py --backend http://localhost:8080 Fashionsnap ViVi Mainichi
```

---

## Deploy the server

After merging or pushing server changes:

```bash
cd server
fly deploy   # app: fcdownloader-extractor, region: iad
```

The Dockerfile now forces `pip install --upgrade yt-dlp` on every build to bypass Docker layer caching. Live server at time of writing runs yt-dlp `2026.03.17` (needs deploy to get latest).

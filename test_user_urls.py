import urllib.request
import json
import os

BACKEND = os.environ.get("FCDOWNLOADER_BACKEND", "https://fcdownloader-extractor.fly.dev").rstrip("/")
EXPECTED_BLOCKED = {"Reddit Shortlink"}


def error_message(e):
    body = e.read().decode()
    try:
        detail = json.loads(body).get("detail")
        if isinstance(detail, dict):
            return detail.get("message") or body
        return detail or body
    except Exception:
        return body

URLS = {
    "YouTube First Video": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "TikTok Shortlink": "https://vm.tiktok.com/ZNR7eeRqB/",
    "TikTok NASA": "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
    "Reddit Shortlink": "https://www.reddit.com/r/shiba/s/nC3HbrECzI",
    "Bilibili": "https://www.bilibili.com/video/BV1PkR2BkEUt",
    "Bilibili Large": "https://www.bilibili.com/video/BV1ux411U7Dp/",
    "Xiaohongshu Shortlink": "http://xhslink.com/o/AuDpBCMNn0z",
    "Weibo API": "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html",
    "Twitter/X": "https://x.com/NASA/status/1902118174591521056",
    "Vimeo": "https://vimeo.com/76979871",
    "Dailymotion": "https://www.dailymotion.com/video/xa52aa8",
    "NHK World": "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/",
    "Oricon": "https://www.oricon.co.jp/news/2285123/full/",
    "Modelpress": "https://mdpr.jp/photo/detail/20095233",
    "Direct MP4": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    "Direct Image": "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg",
    "Direct Audio": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
    "HLS Manifest": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    "DASH Manifest": "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
}

results = []
for name, url in URLS.items():
    req = urllib.request.Request(
        f'{BACKEND}/extract',
        data=json.dumps({"pageUrl": url}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        items = data.get("items") or data.get("media") or []
        results.append(f"[PASS] {name} -> {data.get('kind', 'unknown')} | {len(items)} items")
    except urllib.error.HTTPError as e:
        mark = "EXPECTED" if name in EXPECTED_BLOCKED else "FAIL"
        results.append(f"[{mark}] {name} -> {e.code} {error_message(e)}")
    except Exception as e:
        results.append(f"[FAIL] {name} -> {str(e)}")

print("\n--- SERVER EXTRACT RESULTS ---")
for r in results:
    print(r)

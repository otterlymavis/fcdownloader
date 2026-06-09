import urllib.request
import json
import os
import time

BACKEND = os.environ.get("FCDOWNLOADER_BACKEND", "https://fcdownloader-extractor.fly.dev").rstrip("/")
PACE_SECONDS = float(os.environ.get(
    "FCDOWNLOADER_TEST_PACE",
    "2.1" if "127.0.0.1" in BACKEND or "localhost" in BACKEND else "0",
))
EXPECTED_BLOCKED = {"Reddit Gallery"}

URLS = [
    ("YouTube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("YouTube First Video", "https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    ("Weibo", "https://m.weibo.cn/status/4286822303972514"),
    ("Weibo Share", "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html"),
    ("Xiaohongshu", "http://xhslink.com/o/AuDpBCMNn0z"),
    ("Reddit Gallery", "https://www.reddit.com/r/shiba/s/nC3HbrECzI"),
    ("TikTok Short", "https://vm.tiktok.com/ZNR7eeRqB/"),
    ("TikTok NASA", "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780"),
    ("Facebook", "https://www.facebook.com/watch/?v=10153231379946729"),
    ("Bilibili", "https://www.bilibili.com/video/BV1PkR2BkEUt"),
    ("Twitter", "https://x.com/NASA/status/1902118174591521056"),
    ("Vimeo", "https://vimeo.com/76979871"),
    ("Dailymotion", "https://www.dailymotion.com/video/xa52aa8"),
    ("Pinterest", "https://www.pinterest.com/pin/84301824269690044/"),
    ("NHK World", "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/"),
    ("Oricon", "https://www.oricon.co.jp/news/2285123/full/"),
    ("Modelpress", "https://mdpr.jp/photo/detail/20095233"),
    ("Direct MP4", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"),
    ("Direct Image", "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg"),
    ("Direct Audio", "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg"),
    ("HLS Manifest", "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"),
    ("DASH Manifest", "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd")
]

results = []

for name, url in URLS:
    req = urllib.request.Request(
        f'{BACKEND}/extract',
        data=json.dumps({"pageUrl": url}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Origin": "http://localhost:8081"}
    )
    try:
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        results.append((name, "PASS", str(data)[:100]))
    except Exception as e:
        status = "EXPECTED" if name in EXPECTED_BLOCKED else "FAIL"
        results.append((name, status, str(e)))
    if PACE_SECONDS > 0:
        time.sleep(PACE_SECONDS)

for n, status, details in results:
    print(f"[{status}] {n} - {details}")

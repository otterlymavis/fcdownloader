import urllib.request
import json

URLS = [
    ("YouTube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("Weibo", "https://m.weibo.cn/status/4286822303972514"),
    ("Xiaohongshu", "http://xhslink.com/o/AuDpBCMNn0z"),
    ("Reddit", "https://www.reddit.com/r/videos/comments/18xzt8s/what_is_this_thing/"),
    ("TikTok", "https://www.tiktok.com/@tiktok/video/7106594312292453678"),
    ("Facebook", "https://www.facebook.com/watch/?v=10153231379946729"),
    ("Bilibili", "https://www.bilibili.com/video/BV1GJ411x7h7/"),
    ("Twitter", "https://twitter.com/X/status/123456789")
]

results = []

for name, url in URLS:
    req = urllib.request.Request(
        'https://fcdownloader-extractor.fly.dev/extract',
        data=json.dumps({"pageUrl": url}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Origin": "http://localhost:8081"}
    )
    try:
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        results.append((name, "PASS", str(data)[:100]))
    except Exception as e:
        results.append((name, "FAIL", str(e)))

for n, status, details in results:
    print(f"[{status}] {n} - {details}")

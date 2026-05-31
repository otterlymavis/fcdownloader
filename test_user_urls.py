import urllib.request
import json

URLS = {
    "TikTok Shortlink": "https://vm.tiktok.com/ZNR7eeRqB/",
    "Reddit Shortlink": "https://www.reddit.com/r/shiba/s/nC3HbrECzI",
    "Bilibili": "https://www.bilibili.com/video/BV1PkR2BkEUt",
    "Xiaohongshu Shortlink": "http://xhslink.com/o/AuDpBCMNn0z",
    "Weibo API": "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html"
}

results = []
for name, url in URLS.items():
    req = urllib.request.Request(
        'https://fcdownloader-extractor.fly.dev/extract',
        data=json.dumps({"pageUrl": url}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        results.append(f"[PASS] {name} -> {data.get('kind', 'unknown')} | {len(data.get('media', []))} items")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        results.append(f"[FAIL] {name} -> {e.code} {body}")
    except Exception as e:
        results.append(f"[FAIL] {name} -> {str(e)}")

print("\n--- SERVER EXTRACT RESULTS ---")
for r in results:
    print(r)

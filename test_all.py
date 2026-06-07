import urllib.request
import json
import time

URLS = {
    "YouTube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "Twitter": "https://x.com/NASA/status/1902118174591521056",
    "Instagram": "https://www.instagram.com/p/C-h902Ttc2C/",
    "TikTok": "https://www.tiktok.com/@tiktok/video/7106594312292453678",
    "Facebook": "https://www.facebook.com/watch/?v=10153231379946729",
    "Reddit": "https://www.reddit.com/r/videos/comments/18xzt8s/what_is_this_thing/",
    "Vimeo": "https://vimeo.com/76979871",
    "Weibo": "https://m.weibo.cn/status/4286822303972514",
    "Bilibili": "https://www.bilibili.com/video/BV1GJ411x7h7/",
    "Xiaohongshu": "http://xhslink.com/o/AuDpBCMNn0z",
    "Naver TV": "https://tv.naver.com/v/33215888",
    "Kakao TV": "https://tv.kakao.com/channel/3268481/cliplink/436329432",
    "Niconico": "https://www.nicovideo.jp/watch/1173108780",
    "TVer": "https://tver.jp/episodes/epc1hdugbk",
    "Abema": "https://abema.tv/video/episode/90-1869_s1_p1"
}

results = []
print("Testing all websites across ALL supported platforms (Simulated Backend Core)...")

for name, url in URLS.items():
    req = urllib.request.Request(
        'http://127.0.0.1:8000/extract',
        data=json.dumps({"pageUrl": url}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Origin": "http://localhost"}
    )
    try:
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        kind = data.get("kind", "unknown")
        
        results.append(f"[PASS] {name} -> {kind}")
        print(f"[PASS] {name}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        results.append(f"[FAIL] {name} -> {e.code} {body}")
        print(f"[FAIL] {name} {body}")
    except Exception as e:
        results.append(f"[FAIL] {name} -> {str(e)}")
        print(f"[FAIL] {name} {str(e)}")

print("\n--- FINAL TEST RESULTS ---")
for r in results:
    print(r)

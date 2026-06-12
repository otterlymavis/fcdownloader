import re
import urllib.request
import urllib.error
import time
from urllib.parse import urljoin

domains_to_fetch = {
    "TVer": {"url": "https://tver.jp/", "pattern": r'href="(/episodes/[^"]+)"'},
    "TBS": {"url": "https://cu.tbs.co.jp/", "pattern": r'href="(/episode/[0-9]+)"'},
    "FOD / Fuji TV": {"url": "https://fod.fujitv.co.jp/", "pattern": r'href="(/title/[^"]+)"'},
    "Nippon TV VOD": {"url": "https://vod.ntv.co.jp/", "pattern": r'href="(/program/[0-9]+)"'},
    "Yahoo Japan video/news": {"url": "https://news.yahoo.co.jp/video", "pattern": r'href="(https://news\.yahoo\.co\.jp/articles/[^"]+)"'},
    "Yahoo Japan articles": {"url": "https://news.yahoo.co.jp/", "pattern": r'href="(https://news\.yahoo\.co\.jp/articles/[^"]+)"'},
    "ITmedia": {"url": "https://www.itmedia.co.jp/", "pattern": r'href="(https://www\.itmedia\.co\.jp/[^"]+\.html)"'},
    "Bunshun": {"url": "https://bunshun.jp/", "pattern": r'href="(/articles/-/[0-9]+)"'},
    "Gendai Media": {"url": "https://gendai.media/", "pattern": r'href="(/articles/-/[0-9]+)"'},
    "eiga.com": {"url": "https://eiga.com/news/", "pattern": r'href="(/news/[0-9]+/[0-9]+/)"'},
    "Entame Next": {"url": "https://entamenext.com/", "pattern": r'href="(/articles/detail/[0-9]+)"'},
    "Asahi": {"url": "https://www.asahi.com/video/", "pattern": r'href="(/articles/[^"]+)"'},
    "Mantan Web": {"url": "https://mantan-web.jp/", "pattern": r'href="(/article/[^"]+\.html)"'},
    "Fashion Press": {"url": "https://www.fashion-press.net/", "pattern": r'href="(/news/[0-9]+)"'},
    "FRaU": {"url": "https://frau.tokyo/", "pattern": r'href="(/article/detail/[0-9]+)"'},
    "Croissant Online": {"url": "https://croissant-online.jp/", "pattern": r'href="(https://croissant-online\.jp/[^"]+/[0-9]+/)"'},
    "Oricon": {"url": "https://www.oricon.co.jp/news/", "pattern": r'href="(/news/[0-9]+/full/)"'},
    "Bilibili-large": {"url": "https://www.bilibili.com/", "pattern": r'href="(//www\.bilibili\.com/video/BV[^"/]+/?)"'},
    "Bilibili dynamic / opus": {"url": "https://t.bilibili.com/", "pattern": r'href="(//t\.bilibili\.com/[0-9]+)"'},
    "Weibo": {"url": "https://m.weibo.cn/", "pattern": r'href="(/detail/[0-9]+)"'},
    "Douyin": {"url": "https://www.douyin.com/", "pattern": r'href="(//www\.douyin\.com/video/[0-9]+)"'},
    "NicoNico": {"url": "https://www.nicovideo.jp/", "pattern": r'href="(watch/sm[0-9]+)"'},
    "TwitCasting": {"url": "https://twitcasting.tv/", "pattern": r'href="(/[^/]+/movie/[0-9]+)"'},
    "FC2 Video": {"url": "https://video.fc2.com/", "pattern": r'href="(/content/[^/]+/?)"'},
    "OpenREC": {"url": "https://www.openrec.tv/", "pattern": r'href="(/live/[^"]+)"'},
    "Naver TV": {"url": "https://tv.naver.com/", "pattern": r'href="(/v/[0-9]+)"'},
    "Kakao TV": {"url": "https://tv.kakao.com/", "pattern": r'href="(/channel/[0-9]+/cliplink/[0-9]+)"'},
    "DMM": {"url": "https://www.dmm.co.jp/mono/dvd/", "pattern": r'href="(/mono/dvd/-/detail/=/cid=[^/]+/)"'},
}

results = {}

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
}

print("Fetching fresh URLs...")
for name, info in domains_to_fetch.items():
    url = info["url"]
    pattern = info["pattern"]
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8', errors='ignore')
            matches = re.findall(pattern, html)
            # Filter matches
            matches = [m for m in matches if len(m) > 5 and not m.endswith(".css") and not m.endswith(".js")]
            if matches:
                # Get the first match that looks like a valid item
                best_match = matches[0]
                # Some matches might be absolute or relative
                if best_match.startswith('//'):
                    full_url = 'https:' + best_match
                elif best_match.startswith('/'):
                    full_url = urljoin(url, best_match)
                elif not best_match.startswith('http'):
                    full_url = urljoin(url, best_match)
                else:
                    full_url = best_match
                
                results[name] = full_url
                print(f"✅ {name}: {full_url}")
            else:
                print(f"❌ {name}: No matches found")
    except Exception as e:
        print(f"⚠️ {name}: Error fetching - {e}")
    time.sleep(0.5)

print("\n--- Summary ---")
print(f"Successfully fetched {len(results)} / {len(domains_to_fetch)} URLs")

with open("fresh_urls.json", "w") as f:
    import json
    json.dump(results, f, indent=2)

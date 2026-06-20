import urllib.request
import json
import time
import os

BACKEND = os.environ.get("FCDOWNLOADER_BACKEND", "http://127.0.0.1:8080").rstrip("/")
PACE_SECONDS = float(os.environ.get(
    "FCDOWNLOADER_TEST_PACE",
    "2.1" if "127.0.0.1" in BACKEND or "localhost" in BACKEND else "0",
))
EXPECTED_BLOCKED = {"Instagram Reel", "Reddit Gallery", "TVer", "Abema", "Threads", "Douyin"}


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
    "YouTube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "YouTube First Video": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "Twitter": "https://x.com/NASA/status/1902118174591521056",
    "Instagram Reel": "https://www.instagram.com/reel/C7VgIvhsKgR/",
    "Threads": "https://www.threads.net/@zuck/post/C7VgIvhsKgR",
    "Bluesky": "https://bsky.app/profile/bsky.app/post/3mmwmla3xph26",
    "Mastodon": "https://mastodon.social/@Gargron/116690424322009521",
    "Tumblr": "https://humansofnewyork.tumblr.com/post/753752476340060160",
    "FC2 Video": "http://video.fc2.com/en/content/20121103kUan1KHs",
    "OpenREC": "https://www.openrec.tv/capture/l9nk2x4gn14",
    "TwitCasting": "https://twitcasting.tv/ivetesangalo/movie/2357609",
    "Douyin": "https://www.douyin.com/video/6918273131559881997",
    "Gyazo": "https://gyazo.com/5593f3bbe109c38ebf07c16dd25dc4c4",
    "Pixiv": "https://www.pixiv.net/artworks/100000000",
    "TRILL": "https://trilltrill.jp/articles/4750322/photos/1",
    "Natalie": "https://natalie.mu/music/news/670767",
    "Naver Blog": "https://blog.naver.com/jalee3228/224297926556",
    "Naver News": "https://news.naver.com/election/region2026",
    "Hatena Blog": "https://staff.hatenablog.com/entry/2026/06/05/145729",
    "Ameblo": "https://ameblo.jp/chunta-2011/",
    "Kstyle": "https://kstyle.com/topicNews.ksn?topicNo=1107",
    "Livedoor Blog": "http://blog.livedoor.jp/new_alces/archives/4980902.html",
    "Yahoo Japan articles": "https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f",
    "Bunshun": "https://bunshun.jp/articles/photo/88467",
    "Daily Shincho": "https://www.dailyshincho.jp/article/2026/06031137/",
    "News Post Seven": "https://www.news-postseven.com/news",
    "FRIDAY": "https://friday.kodansha.co.jp/article/469626",
    "Gendai Media": "https://gendai.media/articles/-/167825",
    "With": "https://withonline.jp/with-class/education/mamacolumn/SQMdi",
    "ViVi": "https://www.vivi.tv/post480665/",
    "CanCam": "https://cancam.jp/archives/category/fashion/item",
    "CLASSY": "https://classy-online.jp/fashion/jewelry-watch/",
    "JJ": "https://jj-jj.net/fashion/fashion_category/fashion-news/",
    "Ginger": "https://gingerweb.jp/timeless/person/20260531-taisei_kido-4",
    "ar": "https://ar-mag.jp/articles/-/19822",
    "bis": "https://bisweb.jp/category/column",
    "Ray": "https://ray-web.jp/531989",
    "HP+ non-no": "https://nonno.hpplus.jp/fashion/watches/",
    "HP+ SPUR": "https://spur.hpplus.jp/jewelry_watch/",
    "HP+ MAQUIA": "https://maquia.hpplus.jp/tag/3259/",
    "HP+ LEE": "https://lee.hpplus.jp/column/",
    "HP+ BAILA": "https://baila.hpplus.jp/fashion/watch-jewerly",
    "ananweb": "https://ananweb.jp/categories/horoscope/76522",
    "TikTok Short": "https://vm.tiktok.com/ZNR7eeRqB/",
    "TikTok NASA": "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
    "Facebook": "https://www.facebook.com/watch/?v=10153231379946729",
    "Reddit Gallery": "https://www.reddit.com/r/shiba/s/nC3HbrECzI",
    "Vimeo": "https://vimeo.com/76979871",
    "Dailymotion": "https://www.dailymotion.com/video/xa52aa8",
    "Pinterest": "https://www.pinterest.com/pin/84301824269690044/",
    "Weibo": "https://m.weibo.cn/status/4286822303972514",
    "Weibo Share": "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html",
    "Bilibili": "https://www.bilibili.com/video/BV1PkR2BkEUt",
    "Xiaohongshu": "http://xhslink.com/o/AuDpBCMNn0z",
    "Naver TV": "http://tv.naver.com/v/81652",
    "Kakao TV": "http://tv.kakao.com/channel/2671005/cliplink/301965083",
    "Niconico": "https://www.nicovideo.jp/watch/sm9",
    "TVer": "https://tver.jp/episodes/epc1hdugbk",
    "Abema": "https://abema.tv/video/episode/194-25_s2_p1",
    "NHK World": "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/",
    "Oricon": "https://www.oricon.co.jp/news/2285123/full/",
    "Modelpress": "https://mdpr.jp/photo/detail/20095233",
    "Direct MP4": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    "Direct Image": "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg",
    "Direct Audio": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
    "HLS Manifest": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    "DASH Manifest": "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd"
}

results = []
print("Testing all websites across ALL supported platforms (Simulated Backend Core)...")

for name, url in URLS.items():
    try:
        req = urllib.request.Request(
            f'{BACKEND}/extract',
            data=json.dumps({"pageUrl": url}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Origin": "http://localhost"}
        )
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        kind = data.get("kind", "unknown")
        
        results.append(f"[PASS] {name} -> {kind}")
        print(f"[PASS] {name}")
    except urllib.error.HTTPError as e:
        mark = "EXPECTED" if name in EXPECTED_BLOCKED else "FAIL"
        msg = error_message(e)
        results.append(f"[{mark}] {name} -> {e.code} {msg}")
        print(f"[{mark}] {name} {msg}")
    except Exception as e:
        results.append(f"[FAIL] {name} -> {str(e)}")
        print(f"[FAIL] {name} {str(e)}")
    if PACE_SECONDS > 0:
        time.sleep(PACE_SECONDS)

print("\n--- FINAL TEST RESULTS ---")
for r in results:
    print(r)

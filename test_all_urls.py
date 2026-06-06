#!/usr/bin/env python3
"""
FCDownloader — platform extraction test tool.

Runs every known-good sample URL against the extractor backend's /extract
endpoint and prints a PASS/FAIL table, so you can re-verify platform support
after server or app changes. Can also inject each URL into the Android app via
adb for a real on-device download test.

Usage:
  python test_all_urls.py                    # test all platforms via server /extract
  python test_all_urls.py youtube xhs        # only the named platforms (case-insensitive)
  python test_all_urls.py --device           # inject each into the Android app (adb) instead
  python test_all_urls.py --server https://...   # override backend URL
  python test_all_urls.py instagram --cookies-file cookies.txt
  python test_all_urls.py --pace 18          # seconds between device injects (--device mode)

Notes:
  * Server mode needs only Python + internet (no phone).
  * Device mode needs: phone connected, USB debugging on, the app installed,
    and `adb reverse tcp:8081 tcp:8081` if running a Metro dev build.
  * Some URLs are login/geo-gated (marked below) and are expected to be partial
    or to fail without cookies / a Japan IP — that's a source-site limitation,
    not an app bug.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:  # make non-ASCII titles safe on any console
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BACKEND = "https://fcdownloader-extractor.fly.dev"
APP_COMPONENT = "com.mabisuuu.fcdownloader/.MainActivity"

# platform -> (url, note). Real URLs used during testing.
URLS = {
    # ── Global / Social ───────────────────────────────────────────────────
    "YouTube":       ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", ""),
    "YouTube-zoo":   ("https://www.youtube.com/watch?v=jNQXAC9IVRw", "first YouTube video"),
    "TikTok":        ("https://vm.tiktok.com/ZNR7eeRqB/", "photo/gallery post"),
    "TikTok-NASA":   ("https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780", "video"),
    "Instagram":     ("https://www.instagram.com/reel/C7VgIvhsKgR/", "LOGIN-GATED: only public images without IG cookies"),
    "Threads":       ("https://www.threads.net/@instagram/post/CuZsgc9vQ0M", ""),
    "Twitter/X":     ("https://x.com/NASA/status/1902118174591521056", "extracts; video download may need work"),
    "Facebook":      ("https://www.facebook.com/watch/?v=10153231379946729", ""),
    "Reddit":        ("https://www.reddit.com/r/shiba/s/nC3HbrECzI", "server IP often blocked -> on-device path"),
    "Pinterest":     ("https://www.pinterest.com/pin/84301824269690044/", ""),
    "Vimeo":         ("https://vimeo.com/76979871", ""),
    "Dailymotion":   ("https://www.dailymotion.com/video/xa52aa8", ""),
    # ── Chinese ───────────────────────────────────────────────────────────
    "Bilibili":      ("https://www.bilibili.com/video/BV1PkR2BkEUt", "small video"),
    "Bilibili-large":("https://www.bilibili.com/video/BV1ux411U7Dp/", "~66MB; exercises download-ahead"),
    "Bilibili dynamic / opus": ("https://t.bilibili.com/998134289197432852", ""),
    "Weibo":         ("https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html", ""),
    "Xiaohongshu":   ("http://xhslink.com/o/AuDpBCMNn0z", "server /extract is gated -> FAIL here is expected; the APP extracts on-device (use --device)"),
    "Douyin":        ("https://www.douyin.com/video/7212345678901234567", ""),
    # ── Japanese / Korean Video & Streaming ──────────────────────────────
    "NicoNico":      ("https://www.nicovideo.jp/watch/sm17517479", "some content login/geo-gated"),
    "TVer":          ("https://tver.jp/episodes/ep1orpabaq", "GEO-LOCKED to Japan"),
    "ABEMA":         ("https://abema.tv/video/episode/194-25_s2_p1", ""),
    "NHK":           ("https://www3.nhk.or.jp/nhkworld/en/shows/2049165/", ""),
    "TwitCasting":   ("https://twitcasting.tv/ivetesangalo/movie/2357609", ""),
    "FC2 Video":     ("http://video.fc2.com/en/content/20121103kUan1KHs", ""),
    "FC2 Live":      ("https://live.fc2.com/57892267/", ""),
    "OpenREC":       ("https://www.openrec.tv/movie/nqz5xl5km8v", ""),
    "TBS":           ("https://www.tbs.com/shows/american-dad/season-6/episode-12/you-debt-your-life", ""),
    "FOD / Fuji TV": ("https://fod.fujitv.co.jp/title/5d40/5d40110076", ""),
    "Naver TV":      ("http://tv.naver.com/v/81652", ""),
    "Kakao TV":      ("http://tv.kakao.com/channel/2671005/cliplink/301965083", ""),
    "Yahoo Japan video/news": ("https://news.yahoo.co.jp/articles/a70fe3a064f1cfec937e2252c7fc6c1ba3201c0e", "datacenter fetches often 403"),
    "DMM":           ("https://www.dmm.co.jp/digital/video/-/detail/=/cid=13ds00645/", ""),
    "Mildom":        ("https://www.mildom.com/playback/10105254/20200824", ""),
    # ── Japanese / Korean News, Magazines, Blogs & Galleries ─────────────
    "Oricon":        ("https://www.oricon.co.jp/news/2452025/photo/1/", "photo gallery"),
    "Modelpress":    ("https://mdpr.jp/photo/detail/20095233", "photo gallery"),
    "TRILL":         ("https://trilltrill.jp/articles/4750322/photos/1", "article photo gallery"),
    "Natalie":       ("https://natalie.mu/music/news/670767", ""),
    "Naver Blog":    ("https://blog.naver.com/jalee3228/224297926556", ""),
    "Naver News":    ("https://news.naver.com/election/region2026", ""),
    "Naver Entertainment": ("https://entertain.naver.com/now", ""),
    "Naver Sports":  ("https://sports.news.naver.com/news/read?oid=001&aid=0012345678", ""),
    "note.com":      ("https://note.com/mercari_inc/n/n5bf1e12d7b5f", "article with images"),
    "LINE Blog":     ("https://lineblog.me/yoshizawakahoru/archives/20060421.html", "image blog"),
    "Hatena Blog":   ("https://hatenablog.com/", ""),
    "FC2 Blog":      ("https://blog.fc2.com/", ""),
    "Gyazo":         ("https://gyazo.com/", "image capture"),
    "Ameblo":        ("https://ameblo.jp/chunta-2011/", ""),
    "Kstyle":        ("https://kstyle.com/topicNews.ksn?topicNo=1107", ""),
    "Daum / Tistory": ("https://storymarketer.tistory.com/entry/%EB%B8%94%EB%A1%9C%EA%B7%B8-%EB%A7%88%EC%BC%80%ED%8C%85-%EC%95%84%EC%A7%81-%ED%9A%A8%EA%B3%BC-%EC%9E%88%EC%9D%84%EA%B9%8C", ""),
    "Livedoor Blog": ("http://blog.livedoor.jp/new_alces/archives/4980902.html", ""),
    "Yahoo Japan articles": ("https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f", ""),
    "Pixiv / Fanbox": ("https://www.pixiv.net/artworks/100000000", ""),
    "Bunshun":       ("https://bunshun.jp/articles/photo/88467", "photo gallery"),
    "Daily Shincho": ("https://www.dailyshincho.jp/article/2026/06031137/", ""),
    "News Post Seven / Josei Seven": ("https://www.news-postseven.com/news", ""),
    "FRIDAY":        ("https://friday.kodansha.co.jp/article/469626", ""),
    "Gendai Media":  ("https://gendai.media/articles/-/167825", ""),
    "With":          ("https://withonline.jp/with-class/education/mamacolumn/SQMdi", ""),
    "ViVi":          ("https://www.vivi.tv/wp-json/wp/v2/pages/8913", ""),
    "CanCam":        ("https://cancam.jp/archives/category/fashion/item", ""),
    "CLASSY":        ("https://classy-online.jp/fashion/jewelry-watch/", ""),
    "JJ":            ("https://jj-jj.net/fashion/fashion_category/fashion-news/", ""),
    "Ginger":        ("https://gingerweb.jp/timeless/person/20260531-taisei_kido-4", ""),
    "ar":            ("https://ar-mag.jp/articles/-/19822", ""),
    "bis":           ("https://bisweb.jp/category/column", ""),
    "Ray":           ("https://ray-web.jp/531989", ""),
    "HP+ non-no":    ("https://nonno.hpplus.jp/fashion/watches/", ""),
    "HP+ SPUR":      ("https://spur.hpplus.jp/jewelry_watch/", ""),
    "HP+ MAQUIA":    ("https://maquia.hpplus.jp/tag/3259/", ""),
    "HP+ LEE":       ("https://lee.hpplus.jp/column/", ""),
    "HP+ BAILA":     ("https://baila.hpplus.jp/fashion/watch-jewerly", ""),
    "ananweb":       ("https://ananweb.jp/categories/horoscope/76522", ""),
    "Croissant Online": ("https://croissant-online.jp/life/273608/", ""),
    "FRaU":          ("https://frau.tokyo/list/tag/frau/SPORTS", ""),
    "mi-mollet":     ("https://mi-mollet.com/ud/article_photo/search", ""),
    "Fashion Press": ("https://www.fashion-press.net/news/", ""),
    "Fashionsnap":   ("https://www.fashionsnap.com/article/2026-06-03/nakagawa-masashichi-shitsurindo/?ref=simple-news-click", ""),
    "WWD Japan":     ("https://www.wwdjapan.com/s/505009", ""),
    "thetv.jp":      ("https://thetv.jp/news/detail/1401412/", ""),
    "Mantan Web":    ("https://mantan-web.jp/article/20240401dog00m200001000c.html", ""),
    "Crank In":      ("https://www.crank-in.net/news/186258", ""),
    "CinemaToday":   ("https://www.cinematoday.jp/news/N0153809", ""),
    "eiga.com":      ("https://eiga.com/news/20260522/23/", ""),
    "Real Sound":    ("https://realsound.jp/movie/2026/05/post-2406453.html?utm_source=rs-pickup-pc&utm_medium=all&utm_campaign=block-1", ""),
    "Spice":         ("https://spice.eplus.jp/articles/346378", ""),
    "JPrime":        ("https://www.jprime.jp/list/tag/NEWS", ""),
    "Smart Flash":   ("https://smart-flash.jp/entertainment/", ""),
    "Nikkan Gendai": ("https://www.nikkan-gendai.com/articles/index/news", ""),
    "Asagei":        ("https://www.asagei.com/category/sports", ""),
    "Entame Next":   ("https://entamenext.com/category/lists/news", ""),
    "GirlsNews":     ("https://girlsnews.tv/category/news", ""),
    "Tokyo Sports":  ("https://www.tokyo-sports.co.jp/list/sports", ""),
    "Hochi":         ("https://hochi.news/photos/", ""),
    "Sponichi":      ("https://www.sponichi.co.jp/soccer/tokusyu/wc2026/?from=glonavi", ""),
    "Nikkan Sports": ("https://www.nikkansports.com/baseball/samurai/wbc2026/", ""),
    "Sanspo":        ("https://www.sanspo.com/sports/baseball/mlb/", ""),
    "Mainichi":      ("https://mainichi.jp/ch150910144i/%E9%A6%96%E7%9B%B8%E6%97%A5%E3%80%85", ""),
    "Asahi":         ("http://www.asahi.com/news/", ""),
    "Yomiuri":       ("https://www.yomiuri.co.jp/news/", ""),
    "Sankei":        ("https://www.sankei.com/sports/", ""),
    "Tokyo Shimbun": ("https://www.tokyo-np.co.jp/special_contents/special_frontline/honne_column?ref=gnb_pc", ""),
    "Kyodo":         ("https://www.kyodo.co.jp/news", ""),
    "47News":        ("https://www.47news.jp/topic/today0603", ""),
    "Jiji":          ("https://www.jiji.com/jc/2026syu", ""),
    "ITmedia":       ("https://www.itmedia.co.jp/news/articles/2606/03/news138.html", ""),
    "Impress / Watch": ("https://www.watch.impress.co.jp/category/life/watch/", ""),
    "Mynavi News":   ("https://news.mynavi.jp/techplus/list/headline/whitepaper/article_type/case/", ""),
    "ASCII":         ("https://ascii.jp/puacl2026/", ""),
    "Gigazine":      ("https://gigazine.net/gsc_news/en/", ""),
}


def load_cookie_header(path):
    """Return a Cookie header from either raw Cookie text or Netscape cookies.txt."""
    if not path:
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read().strip()
    if not raw:
        return None
    if "\t" not in raw and "=" in raw and not raw.startswith("#"):
        return " ".join(raw.split())
    pairs = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            name, value = parts[5], parts[6]
            if name:
                pairs.append(f"{name}={value}")
    return "; ".join(pairs) if pairs else None


def test_server(url, backend, timeout=75, cookies=None):
    payload = {"pageUrl": url}
    if cookies:
        payload["cookies"] = cookies
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        backend + "/extract", data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
        dt = time.time() - t0
        if data.get("items"):
            return ("PASS", f"gallery: {len(data['items'])} items", dt)
        kind = data.get("kind")
        if kind:
            return ("PASS", f"{kind} — {(data.get('title') or '')[:36]}", dt)
        return ("FAIL", "no media", dt)
    except urllib.error.HTTPError as e:
        try:
            d = json.load(e)
            m = d.get("detail")
            msg = (m.get("message") if isinstance(m, dict) else m) or f"HTTP {e.code}"
        except Exception:
            msg = f"HTTP {e.code}"
        return ("FAIL", str(msg)[:70], time.time() - t0)
    except Exception as e:
        return ("FAIL", str(e)[:70], time.time() - t0)


def inject_device(url):
    enc = urllib.parse.quote(url, safe="")
    subprocess.run(
        ["adb", "shell", "am", "start", "-n", APP_COMPONENT,
         "-a", "android.intent.action.VIEW", "-d", f"fcdownloader://share?url={enc}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(3)
    # Tap the Download button (coords for a 1008x2244 screen; adjust if needed)
    subprocess.run(["adb", "shell", "input", "tap", "504", "558"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser(description="FCDownloader platform extraction tester")
    ap.add_argument("platforms", nargs="*", help="subset to test (default: all)")
    ap.add_argument("--device", action="store_true", help="inject into the Android app via adb instead of /extract")
    ap.add_argument("--server", default=BACKEND, help="backend base URL")
    ap.add_argument("--cookies", default=None, help="raw Cookie header to send with every /extract request")
    ap.add_argument("--cookies-file", default=None, help="raw Cookie header or Netscape cookies.txt file")
    ap.add_argument("--pace", type=float, default=20.0, help="seconds between device injects")
    args = ap.parse_args()
    cookies = args.cookies or load_cookie_header(args.cookies_file)

    wanted = [p.lower() for p in args.platforms]
    items = [(k, v) for k, v in URLS.items() if not wanted or k.lower() in wanted]
    if not items:
        print("No matching platforms. Available:", ", ".join(URLS))
        return

    if args.device:
        print(f"Injecting {len(items)} URLs into the app — watch the Library tab.\n")
        for name, (url, note) in items:
            print(f"  -> {name}: {url}" + (f"   [{note}]" if note else ""))
            inject_device(url)
            time.sleep(args.pace)
        print("\nDone. Open the app's Library tab to see Saved / failed items.")
        return

    print(f"Testing {len(items)} platforms against {args.server}/extract\n")
    width = max(len(k) for k, _ in items)
    npass = 0
    for name, (url, note) in items:
        status, detail, dt = test_server(url, args.server, cookies=cookies)
        if status == "PASS":
            npass += 1
        mark = "PASS" if status == "PASS" else "FAIL"
        line = f"[{mark}] {name.ljust(width)}  {detail}  ({dt:.1f}s)"
        if note:
            line += f"  <{note}>"
        print(line)
    print(f"\n{npass}/{len(items)} passed")


if __name__ == "__main__":
    main()

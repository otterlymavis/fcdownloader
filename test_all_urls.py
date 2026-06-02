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
    # ── Global ────────────────────────────────────────────────────────────
    "YouTube":       ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", ""),
    "YouTube-zoo":   ("https://www.youtube.com/watch?v=jNQXAC9IVRw", "first YouTube video"),
    "TikTok":        ("https://vm.tiktok.com/ZNR7eeRqB/", "photo/gallery post"),
    "TikTok-NASA":   ("https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780", "video"),
    "Instagram":     ("https://www.instagram.com/reel/C7VgIvhsKgR/", "LOGIN-GATED: only public images without IG cookies"),
    "Twitter/X":     ("https://x.com/NASA/status/1902118174591521056", "extracts; video download may need work"),
    "Facebook":      ("https://www.facebook.com/watch/?v=10153231379946729", ""),
    "Reddit":        ("https://www.reddit.com/r/shiba/s/nC3HbrECzI", "server IP often blocked -> on-device path"),
    "Pinterest":     ("https://www.pinterest.com/pin/84301824269690044/", ""),
    "Vimeo":         ("https://vimeo.com/76979871", ""),
    "Dailymotion":   ("https://www.dailymotion.com/video/xa52aa8", ""),
    # ── Chinese ───────────────────────────────────────────────────────────
    "Bilibili":      ("https://www.bilibili.com/video/BV1PkR2BkEUt", "small video"),
    "Bilibili-large":("https://www.bilibili.com/video/BV1ux411U7Dp/", "~66MB; exercises download-ahead"),
    "Weibo":         ("https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html", ""),
    "Xiaohongshu":   ("http://xhslink.com/o/AuDpBCMNn0z", "server /extract is gated -> FAIL here is expected; the APP extracts on-device (use --device)"),
    # ── Japanese / Korean ──────────────────────────────────────────────────
    "NicoNico":      ("https://www.nicovideo.jp/watch/sm17517479", "some content login/geo-gated"),
    "TVer":          ("https://tver.jp/episodes/ep1orpabaq", "GEO-LOCKED to Japan"),
    "Oricon":        ("https://www.oricon.co.jp/news/2452025/full/", "photo gallery"),
    "Modelpress":    ("https://mdpr.jp/photo/detail/20095233", "photo gallery"),
    "Natalie":       ("https://natalie.mu/music/news/670767", ""),
    "thetv.jp":      ("https://thetv.jp/news/detail/1401412/", ""),
    "CinemaToday":   ("https://www.cinematoday.jp/news/N0153809", ""),
    "eiga.com":      ("https://eiga.com/news/20260522/23/", ""),
    "ananweb":       ("https://ananweb.jp/categories/horoscope/76522", ""),
    "Bunshun":       ("https://bunshun.jp/articles/photo/88467", "photo gallery"),
    "YahooNews":     ("https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f",
                      "not in registry; relies on generic extraction"),
}


def test_server(url, backend, timeout=75):
    body = json.dumps({"pageUrl": url}).encode("utf-8")
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
    ap.add_argument("--pace", type=float, default=20.0, help="seconds between device injects")
    args = ap.parse_args()

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
        status, detail, dt = test_server(url, args.server)
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

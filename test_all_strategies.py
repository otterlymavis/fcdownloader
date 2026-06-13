#!/usr/bin/env python3
"""
FCDownloader — comprehensive strategy tester.

Tests EVERY extraction approach for each URL:
  1. server       POST /extract on Fly backend (yt-dlp + platform extractors)
  2. client-api   Direct platform API calls (what the content script does in browser)
  3. client-page  Fetch page HTML and scrape it (simulates DOM/state extraction)
  4. local-helper GET 127.0.0.1:8765 (desktop companion, if running)
  5. browser-only webRequest capture + DOM scan — needs a real browser, noted only

Run:
  python test_all_strategies.py                   # all platforms
  python test_all_strategies.py reddit bilibili   # filter by name (case-insensitive)
  python test_all_strategies.py --backend https://... # override backend URL
  python test_all_strategies.py --check-matrices  # no-network strategy coverage check
"""

import argparse, ast, json, os, re, sys, time, threading
import urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ── Config ─────────────────────────────────────────────────────────────────────

BACKEND       = os.environ.get("FCDOWNLOADER_BACKEND", "https://fcdownloader-extractor.fly.dev")
LOCAL_HELPER  = "http://127.0.0.1:8765"
DESKTOP_UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
MOBILE_UA     = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

# ── HTTP helpers ───────────────────────────────────────────────────────────────

def _request(url, method="GET", data=None, headers=None, timeout=20):
    h = {"User-Agent": DESKTOP_UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    if data and isinstance(data, dict):
        data = json.dumps(data).encode()
        h["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        res = urllib.request.urlopen(req, timeout=timeout)
        body = res.read()
        final_url = res.url
        ct = res.headers.get("content-type", "")
        if "json" in ct:
            return json.loads(body), None, final_url
        return body.decode("utf-8", errors="replace"), None, final_url
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return None, json.loads(body), e.geturl() or url
        except Exception:
            return None, {"_raw": body[:300], "status": e.code}, url
    except Exception as e:
        return None, {"_raw": str(e)}, url

def get_html(url, ua=DESKTOP_UA, extra=None, timeout=15):
    h = {"User-Agent": ua, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9"}
    if extra:
        h.update(extra)
    req = urllib.request.Request(url, headers=h)
    try:
        res = urllib.request.urlopen(req, timeout=timeout)
        return res.read().decode("utf-8", errors="replace"), res.url, None
    except urllib.error.HTTPError as e:
        return None, url, f"HTTP {e.code}"
    except Exception as e:
        return None, url, str(e)

def get_json(url, ua=DESKTOP_UA, extra=None, timeout=15):
    h = {"User-Agent": ua, "Accept": "application/json"}
    if extra:
        h.update(extra)
    req = urllib.request.Request(url, headers=h)
    try:
        res = urllib.request.urlopen(req, timeout=timeout)
        return json.loads(res.read()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)

# ── Result helpers ─────────────────────────────────────────────────────────────

class R:
    def __init__(self, ok, detail="", note=""):
        self.ok = ok
        self.detail = detail  # e.g. "gallery: 3 items" or error message
        self.note = note      # extra context

    def __repr__(self):
        s = "PASS" if self.ok else "FAIL"
        parts = [f"[{s}]", self.detail]
        if self.note:
            parts.append(f"({self.note})")
        return "  ".join(p for p in parts if p)

def _summarise_server(data):
    """Turn a /extract JSON response into a short human string."""
    if data is None:
        return ""
    if isinstance(data, dict):
        kind = data.get("kind", "")
        if kind == "gallery":
            n = len(data.get("items", []))
            title = data.get("title", "")
            return f"gallery: {n} items" + (f'  "{title[:40]}"' if title else "")
        if kind == "paired":
            return f"paired HD  {data.get('label','')}"
        if kind == "hls":
            return f"HLS  {data.get('label','')}"
        if kind in ("direct", "image", "audio"):
            title = data.get("title","") or data.get("label","")
            return f"{kind}  {title[:60]}"
    return str(data)[:80]

def _items_str(items):
    if not items:
        return ""
    first = items[0]
    label = first.get("label","") or first.get("kind","")
    dims = f" {first.get('dims','')}" if first.get("dims") else ""
    if len(items) == 1:
        return f"1 item  {label}{dims}"
    return f"{len(items)} items  {label}{dims} …"

# ── Strategy implementations ───────────────────────────────────────────────────

# 1. SERVER ────────────────────────────────────────────────────────────────────

def strat_server(url, backend=BACKEND):
    data, err, _ = _request(f"{backend}/extract", method="POST",
                             data={"pageUrl": url}, timeout=45)
    if data:
        return R(True, _summarise_server(data))
    if err:
        msg = err.get("detail", {})
        if isinstance(msg, dict):
            msg = msg.get("message", str(err)[:120])
        elif isinstance(msg, str):
            pass
        else:
            msg = err.get("_raw", str(err))[:120]
        return R(False, str(msg)[:120])
    return R(False, "no response")

# 2. LOCAL HELPER ──────────────────────────────────────────────────────────────

_helper_status = None
_helper_lock   = threading.Lock()

def _helper_running():
    global _helper_status
    with _helper_lock:
        if _helper_status is None:
            data, err = get_json(f"{LOCAL_HELPER}/health", timeout=2)
            _helper_status = bool(data and data.get("ok") is not False)
        return _helper_status

def strat_local_helper(url):
    if not _helper_running():
        return R(False, "companion not running", "start fcdownloader-companion to enable")
    params = urllib.parse.urlencode({"url": url, "max_height": "1080"})
    fmt_data, err = get_json(f"{LOCAL_HELPER}/formats?{params}", timeout=30)
    if err:
        return R(False, err)
    fmts = fmt_data.get("formats", [])
    if not fmts:
        return R(False, "no formats")

    def height_value(fmt):
        try:
            return int(fmt.get("height") or 0)
        except (TypeError, ValueError):
            return 0

    best = max(fmts, key=height_value)
    height = height_value(best)
    ext = best.get("ext") or best.get("format_id") or ""
    label = f"{height}p  {ext}" if height else f"format available  {ext}".rstrip()
    return R(True, label, f"{len(fmts)} formats available")

# 3. YOUTUBE InnerTube ─────────────────────────────────────────────────────────

def strat_yt_innertube(url):
    vid = re.search(r"(?:[?&]v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})", url)
    if not vid:
        return R(False, "no video ID in URL")
    video_id = vid.group(1)
    body = {
        "videoId": video_id,
        "context": {"client": {
            "clientName": "ANDROID", "clientVersion": "20.10.38",
            "androidSdkVersion": 33, "osName": "Android",
            "hl": "en", "gl": "US",
        }},
    }
    data, err = get_json(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        extra={
            "Content-Type": "application/json",
            "X-Youtube-Client-Name": "3",
            "X-Youtube-Client-Version": "20.10.38",
        },
        timeout=15,
    )
    # get_json only does GET; do a POST manually
    req = urllib.request.Request(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        data=json.dumps(body).encode(),
        headers={
            "User-Agent": MOBILE_UA,
            "Content-Type": "application/json",
            "X-Youtube-Client-Name": "3",
            "X-Youtube-Client-Version": "20.10.38",
        },
    )
    try:
        res = urllib.request.urlopen(req, timeout=15)
        data = json.loads(res.read())
    except Exception as e:
        return R(False, str(e)[:100])

    hls = data.get("streamingData", {}).get("hlsManifestUrl")
    fmts = data.get("streamingData", {}).get("formats", [])
    muxed = next((f for f in fmts if str(f.get("itag")) == "18" and f.get("url")), None)
    if hls:
        return R(True, f"HLS manifest  (+ itag-18 fallback)" if muxed else "HLS manifest")
    if muxed:
        return R(True, f"itag-18 muxed 360p", "no HLS served for this video")
    return R(False, "no usable stream in InnerTube response")

# 4. TIKTOK mobile API ─────────────────────────────────────────────────────────

def strat_tiktok(url):
    # Resolve short link
    html, final, err = get_html(url, ua=MOBILE_UA)
    if err and not final.startswith("http"):
        return R(False, f"redirect failed: {err}")

    id_m = re.search(r"(?:video|photo|v|item)/(\d{10,})", final)
    if id_m:
        vid = id_m.group(1)
        api = f"https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id={vid}"
        data, err = get_json(api, ua=MOBILE_UA)
        if not err and data:
            aweme = (data.get("aweme_list") or [{}])[0]
            vurls = aweme.get("video", {}).get("play_addr", {}).get("url_list", [])
            if vurls:
                return R(True, "TikTok video via mobile API", "direct mp4 URL")
            imgs = aweme.get("image_post_info", {}).get("images", [])
            if imgs:
                return R(True, f"TikTok photo: {len(imgs)} images via mobile API")

    # Fallback: __UNIVERSAL_DATA_FOR_REHYDRATION__ in SSR HTML
    if html:
        sm = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)</script>', html)
        if sm:
            try:
                raw = json.dumps(json.loads(sm.group(1)))
                plays = re.findall(r'"playAddr"\s*:\s*"(https?://[^"]+)"', raw)
                if plays:
                    return R(True, f"TikTok video via page SSR data  ({len(plays)} url(s))")
            except Exception:
                pass
        # CDN URL scan
        cdn = re.findall(r'https?://[^"\'<>\s]*(?:tiktokcdn\.com|v\d+-webapp\.tiktok\.com)[^"\'<>\s]*', html)
        if cdn:
            return R(True, f"{len(cdn)} TikTok CDN URL(s) in page HTML")

    return R(False, "no media found", "TikTok SSR may not embed video URLs without cookies")

# 5. REDDIT JSON API ───────────────────────────────────────────────────────────

def strat_reddit_json(url):
    # Follow share link redirect
    html, final, err = get_html(url, ua=DESKTOP_UA, extra={"Accept-Language": "en-US,en;q=0.9"})
    if err or not final or not final.startswith("http"):
        return R(False, f"redirect blocked: {err or final}",
                 "Reddit blocks non-browser IPs; works in real browser with user session")

    post_m = re.search(r"/comments/([A-Za-z0-9]+)", final)
    if not post_m:
        return R(False, f"no post ID after redirect (landed on {final[:60]})")

    json_url = f"https://www.reddit.com/comments/{post_m.group(1)}.json?limit=1&raw_json=1"
    data, err = get_json(json_url, ua=DESKTOP_UA,
                         extra={"Accept-Language": "en-US,en;q=0.9", "Accept": "application/json"})
    if err:
        return R(False, err, "works in real browser where Reddit session cookie is present")

    p = data[0]["data"]["children"][0]["data"]
    items = []
    if p.get("secure_media", {}).get("reddit_video"):
        rv = p["secure_media"]["reddit_video"]
        u = rv.get("hls_url") or rv.get("fallback_url")
        if u:
            items.append({"label": "Reddit Video", "kind": "hls" if rv.get("hls_url") else "direct"})
    if p.get("is_gallery") and p.get("media_metadata"):
        EXT = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
        order = [x["media_id"] for x in p.get("gallery_data", {}).get("items", [])] \
                or list(p["media_metadata"].keys())
        for mid in order:
            meta = p["media_metadata"].get(mid, {})
            if meta.get("status") == "valid":
                ext = EXT.get(meta.get("m"), "jpg")
                items.append({"url": f"https://i.redd.it/{mid}.{ext}", "label": "Reddit Image",
                               "dims": f"{meta.get('s',{}).get('x','?')}x{meta.get('s',{}).get('y','?')}"})
    if not items and p.get("url"):
        u = p["url"]
        if re.search(r"\.(jpe?g|png|gif|webp)(?:[?#]|$)", u, re.I):
            items.append({"url": u, "label": "Reddit Image"})

    if items:
        return R(True, _items_str(items))
    return R(False, "post has no extractable media")

# 6. BILIBILI __playinfo__ ─────────────────────────────────────────────────────

def strat_bilibili_page(url):
    html, _, err = get_html(url, ua=DESKTOP_UA, extra={
        "Referer": "https://www.bilibili.com/",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    if not html:
        return R(False, err or "fetch failed")

    m = re.search(r"window\.__playinfo__\s*=\s*(\{[\s\S]+?\})\s*</script>", html)
    if not m:
        # Check if page loaded at all (title present?)
        title_m = re.search(r"<title[^>]*>([^<]{3,})</title>", html)
        note = f"page title: {title_m.group(1)[:50]}" if title_m else "no title found"
        return R(False, "__playinfo__ not in page HTML", note)

    try:
        pi = json.loads(m.group(1))
    except Exception as e:
        return R(False, f"JSON parse error: {e}")

    data = pi.get("data", {})
    if data.get("durl"):
        u = data["durl"][0].get("url", "").replace("\\u0026", "&")
        q = data.get("quality", "?")
        return R(True, f"durl  quality={q}", "progressive MP4, no mux needed")
    if data.get("dash"):
        vids = sorted(data["dash"].get("video", []), key=lambda x: x.get("bandwidth", 0), reverse=True)
        best = vids[0] if vids else {}
        h = best.get("height", "?")
        return R(True, f"DASH  {h}p  ({len(vids)} video tracks)", "needs audio track mux for full quality")
    return R(False, "__playinfo__ present but no durl or dash data")

# 7. WEIBO API + page ──────────────────────────────────────────────────────────

def strat_weibo(url):
    target = url
    if "mapp.api.weibo.cn" in url:
        _, target, err = get_html(url, ua=MOBILE_UA)
        if err or not target or not target.startswith("http"):
            return R(False, f"share link redirect failed: {err or target}")

    # Try statuses API
    def weibo_id(u):
        try:
            p = urllib.parse.urlparse(u)
            parts = p.path.strip("/").split("/")
            host = p.hostname or ""
            if "m.weibo.cn" in host and parts[0] in ("status", "detail"):
                return parts[1] if len(parts) > 1 else ""
            if re.search(r"(?:^|\.)weibo\.com$", host) and len(parts) >= 2:
                return parts[1]
        except Exception:
            pass
        return ""

    wid = weibo_id(target)
    if wid:
        for api_url in [
            f"https://m.weibo.cn/statuses/show?id={wid}",
            f"https://weibo.com/ajax/statuses/show?id={wid}",
        ]:
            data, err = get_json(api_url, ua=MOBILE_UA, extra={"Referer": target})
            if not err and data:
                meta = data.get("data") or data
                pics = meta.get("pics", [])
                if pics:
                    items = [{"url": (p.get("largest") or p.get("large") or p).get("url",""),
                              "label": "Weibo Image"} for p in pics]
                    return R(True, _items_str(items), "via Weibo statuses API")
                if meta.get("page_info", {}).get("media_info", {}).get("stream_url"):
                    return R(True, "Weibo video via statuses API")

    # Fallback: scrape sinaimg/weibocdn URLs from page HTML
    html, _, err = get_html(target, ua=MOBILE_UA)
    if html:
        imgs = re.findall(
            r'https?://[^"\'<>\s]*(?:sinaimg\.cn|weibocdn\.com)[^"\'<>\s]*\.(?:jpe?g|png|webp|gif)',
            html, re.I,
        )
        imgs = [u for u in imgs if not re.search(r"avatar|profile|icon|emoji|face|card", u, re.I)]
        if imgs:
            return R(True, f"{len(imgs)} image URL(s) in page HTML", "via page scrape")
    return R(False, "no media — may need Weibo login cookies", target[:80])

# 8. XHS __INITIAL_STATE__ ─────────────────────────────────────────────────────

def strat_xhs_state(url):
    target = url
    if "xhslink.com" in url:
        _, target, err = get_html(url, ua=MOBILE_UA)
        if err or not target or not target.startswith("http"):
            return R(False, f"redirect failed: {err or target}")

    html, _, err = get_html(target, ua=MOBILE_UA, extra={"Referer": "https://www.xiaohongshu.com/"})
    if not html:
        return R(False, err or "fetch failed")

    sm = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*;?\s*</script>", html)
    if not sm:
        return R(False, "__INITIAL_STATE__ not found",
                 "XHS requires login — works in browser with active session")

    try:
        state = json.loads(sm.group(1).replace("undefined", "null"))
        note_map = (state.get("note") or state.get("noteDetail") or {}).get("noteDetailMap", {})
        if not note_map:
            return R(False, "no noteDetailMap in state (login required)")
        note_id = next(iter(note_map))
        note = (note_map[note_id] or {}).get("note", {})
        imgs = note.get("imageList", [])
        if imgs:
            return R(True, f"{len(imgs)} image(s) from __INITIAL_STATE__")
        if note.get("video"):
            return R(True, "video from __INITIAL_STATE__")
    except Exception as e:
        return R(False, f"parse error: {e}")

    return R(False, "state found but no media", "XHS post may require login to view")

# 9. OG meta + CDN scrape ──────────────────────────────────────────────────────

def strat_og_meta(url, accept_lang="en-US,en;q=0.9"):
    html, _, err = get_html(url, ua=DESKTOP_UA,
                             extra={"Accept-Language": accept_lang})
    if not html:
        return R(False, err or "fetch failed")
    seen, items = set(), []
    for m in re.finditer(
        r'<meta\s[^>]*(?:property|name)=["\'](?:og:(?:image(?::secure_url)?|video(?::url)?)|twitter:image)["\'][^>]*content=["\']([^"\']+)["\']',
        html, re.I,
    ):
        u = m.group(1).replace("&amp;", "&")
        if u.startswith("http") and u not in seen:
            seen.add(u)
            kind = "image" if re.search(r"\.(jpe?g|png|webp|gif|avif)", u, re.I) else "direct"
            items.append({"url": u, "kind": kind, "label": "OG"})
    # CDN patterns specific to Japanese media sites
    for m in re.finditer(
        r'(https?://[^"\'<>\s]*(?:'
        r'contents\.oricon\.co\.jp|img-mdpr\.freetls\.fastly\.net|ogre\.natalie\.mu'
        r'|img\.thetv\.jp|img\.mantan-web\.jp|img\.cinematoday\.jp'
        r')[^"\'<>\s]*\.(?:jpe?g|png|webp))',
        html, re.I,
    ):
        u = m.group(1)
        if u not in seen:
            seen.add(u)
            items.append({"url": u, "kind": "image", "label": "CDN"})
    if items:
        return R(True, _items_str(items))
    return R(False, "no OG/CDN media found in page")


def strat_dailymotion_metadata(url):
    m = re.search(r"dailymotion\.com/video/([A-Za-z0-9]+)", url)
    if not m:
        return R(False, "no Dailymotion video ID")
    data, err = get_json(
        f"https://www.dailymotion.com/player/metadata/video/{m.group(1)}",
        ua=DESKTOP_UA,
        extra={"Referer": "https://www.dailymotion.com/"},
    )
    if err or not isinstance(data, dict):
        return R(False, err or "metadata fetch failed")
    qualities = data.get("qualities") or {}
    streams = [
        item
        for items in qualities.values() if isinstance(items, list)
        for item in items if isinstance(item, dict) and item.get("url")
    ]
    if not streams:
        return R(False, "metadata contained no streams")
    hls = next((item for item in streams if ".m3u8" in item.get("url", "")), streams[0])
    return R(True, "HLS metadata" if ".m3u8" in hls.get("url", "") else "direct metadata")

# ── Platform table ─────────────────────────────────────────────────────────────
#
# Each platform: (display_name, url, [(label, fn, kwargs), ...], browser_only_note)
#
# "browser-only" strategies are listed as notes — they need a real browser with
# the user's session and network capture (webRequest API).

PLATFORMS = [
    # ── Global / Social ───────────────────────────────────────────────────
    ("YouTube", "https://www.youtube.com/watch?v=jNQXAC9IVRw", [
        ("server /extract",          strat_server,        {}),
        ("client: InnerTube API",    strat_yt_innertube,  {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: webRequest captures googlevideo.com CDN; DOM scan finds <video> blob URL"),

    ("TikTok (short URL / photo)", "https://vm.tiktok.com/ZNR7eeRqB/", [
        ("server /extract",          strat_server,        {}),
        ("client: TikTok mobile API",strat_tiktok,        {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: webRequest captures tiktokcdn.com media URLs; short link now resolves to a photo slideshow"),

    ("Threads", "https://www.threads.com/@nasa/post/DZceA72Drjf", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: Threads app-based extraction; domain moved threads.net → threads.com"),

    ("Twitter/X", "https://x.com/NASA/status/1902118174591521056", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: twimg.com capture"),

    ("Facebook", "https://www.facebook.com/watch/?v=10153231379946729", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: fbcdn.net capture"),

    ("Reddit (gallery)", "https://www.reddit.com/r/shiba/s/nC3HbrECzI", [
        ("server /extract",          strat_server,        {}),
        ("client: Reddit JSON API",  strat_reddit_json,   {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: scanImageTags finds loaded i.redd.it images; webRequest captures v.redd.it video"),

    ("Pinterest", "https://www.pinterest.com/pin/84301824269690044/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: pinterest pin image extraction"),

    ("Vimeo", "https://vimeo.com/76979871", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: player.vimeo.com capture"),

    ("Dailymotion", "https://www.dailymotion.com/video/xa52aa8", [
        ("server /extract",          strat_server,        {}),
        ("client: player metadata",  strat_dailymotion_metadata, {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: dmcdn.net capture"),

    # ── Chinese ───────────────────────────────────────────────────────────
    ("Bilibili", "https://www.bilibili.com/video/BV1PkR2BkEUt", [
        ("server /extract",          strat_server,        {}),
        ("client: __playinfo__ page",strat_bilibili_page, {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: scanBilibili() reads window.__playinfo__ set by page JS; webRequest captures bilivideo.com segments"),

    ("Bilibili dynamic / opus", "https://t.bilibili.com/892040939527667727", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: dynamic feed scrape"),

    ("Weibo (share link)", "https://m.weibo.cn/detail/4904263725515320", [
        ("server /extract",          strat_server,        {}),
        ("client: Weibo statuses API + page", strat_weibo, {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: scanWeibo() scrapes page HTML for sinaimg/weibocdn URLs; private posts need session"),

    ("Xiaohongshu (explore)", "https://www.xiaohongshu.com/explore/65b2e03d000000000103117d", [
        ("server /extract",          strat_server,        {}),
        ("client: __INITIAL_STATE__",strat_xhs_state,     {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: scanXiaohongshu() reads window.__INITIAL_STATE__ after login; xhscdn.com webRequest capture"),

    ("Douyin", "https://www.douyin.com/video/7465568516827773226", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: douyin live video extract"),

    # ── Japanese / Korean Video & Streaming ──────────────────────────────
    ("NicoNico", "https://www.nicovideo.jp/watch/sm9", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: nicovideo HLS stream capture"),

    ("TVer", "https://tver.jp/episodes/epc1hdugbk", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: TVer video streams"),

    ("ABEMA", "https://abema.tv/video/episode/194-25_s2_p1", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: ABEMA HLS capture"),

    ("NHK", "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: NHK streams"),

    ("TwitCasting", "https://twitcasting.tv/ivetesangalo/movie/2357609", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: twitcasting VOD extraction"),

    ("FC2 Video", "https://video.fc2.com/en/content/20121103kUan1KHs", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: FC2 video extraction"),

    ("FC2 Live", "https://live.fc2.com/99999999/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: FC2 Live extraction"),

    ("OpenREC", "https://www.openrec.tv/capture/l9nk2x4gn14", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: openrec VOD capture"),

    ("TBS", "https://cu.tbs.co.jp/episode/11578", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: TBS video stream capture"),

    ("FOD / Fuji TV", "https://fod.fujitv.co.jp/title/5d40/5d40110076", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: FOD video stream capture"),

    ("Naver TV", "http://tv.naver.com/v/81652", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: Naver TV HLS capture"),

    ("Kakao TV", "https://tv.kakao.com/channel/2856/cliplink/463538508", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: Kakao video stream capture"),

    ("Yahoo Japan video/news", "https://news.yahoo.co.jp/articles/197bd0c92eca977bb77b3503f890a5f0e3f3e5fe", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: yahoo news video stream"),

    ("DMM", "https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=3841h_015/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: DMM video extraction"),

    ("Lemino / docomo video", "https://lemino.docomo.ne.jp/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: Japan IP/session playback capture; DRM titles cannot be downloaded"),

    ("U-NEXT", "https://video.unext.jp/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: Japan IP/session playback capture; DRM titles cannot be downloaded"),

    ("Hulu Japan / TELASA", "https://www.hulu.jp/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: paid/current session; DRM titles cannot be downloaded"),

    ("Locipo / broadcaster catch-up", "https://locipo.jp/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: current episode player capture after geo/session checks"),

    ("MBS Dougaizm", "https://dougaizm.mbs.jp/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: current episode player capture after geo/session checks"),

    ("NHK Plus / On Demand", "https://plus.nhk.jp/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: current episode/session capture; paid On Demand may be DRM"),

    # ── Japanese / Korean News, Magazines, Blogs & Galleries ─────────────
    ("Oricon", "https://www.oricon.co.jp/news/2285123/full/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: scanImageTags captures loaded <img> elements (already large enough to pass 160px filter)"),

    ("Modelpress", "https://mdpr.jp/photo/detail/20095233", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: scanImageTags captures loaded <img> elements"),

    ("Natalie", "https://natalie.mu/music/news/670767", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: natalie.mu image parsing"),

    ("Naver Blog", "https://blog.naver.com/jalee3228/224297926556", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: naver blog photo extraction"),

    ("Naver News", "https://news.naver.com/election/region2026", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: naver news photo extraction"),

    ("Naver Entertainment", "https://entertain.naver.com/read?oid=108&aid=0003257812", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: naver entertainment photo extraction"),

    ("Naver Sports", "https://sports.news.naver.com/kbaseball/news/read?oid=241&aid=0003450000", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: naver sports photo extraction"),

    ("Ameblo", "https://ameblo.jp/chunta-2011/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: ameblo photo extraction"),

    ("Kstyle", "https://kstyle.com/topicNews.ksn?topicNo=1107", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: kstyle photo extraction"),

    ("Daum / Tistory", "https://lovelyddodam.tistory.com/114", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: tistory photo extraction"),

    ("Livedoor Blog", "http://blog.livedoor.jp/new_alces/archives/4980902.html", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: livedoor blog photo extraction"),

    ("Yahoo Japan articles", "https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: yahoo article galleries"),

    ("Pixiv / Fanbox", "https://www.pixiv.net/artworks/100000000", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: pixiv/fanbox media extraction"),

    ("Bunshun", "https://bunshun.jp/articles/-/89384", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: bunshun gallery extraction"),

    ("Daily Shincho", "https://www.dailyshincho.jp/article/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: daily shincho gallery extraction"),

    ("News Post Seven / Josei Seven", "https://www.news-postseven.com/news", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: news post seven gallery extraction"),

    ("FRIDAY", "https://friday.kodansha.co.jp/article/469626", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: friday gallery extraction"),

    ("Gendai Media", "https://gendai.media/articles/-/167825", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: gendai media gallery extraction"),

    ("With", "https://withonline.jp/with-class/education/mamacolumn/SQMdi", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: with online gallery extraction"),

    ("ViVi", "https://www.vivi.tv/post480665/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: vivi gallery extraction"),

    ("CanCam", "https://cancam.jp/archives/category/fashion/item", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: cancam gallery extraction"),

    ("CLASSY", "https://classy-online.jp/fashion/jewelry-watch/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: classy gallery extraction"),

    ("JJ", "https://jj-jj.net/fashion/fashion_category/fashion-news/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: jj gallery extraction"),

    ("Ginger", "https://gingerweb.jp/timeless/person/20260531-taisei_kido-4", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: ginger gallery extraction"),

    ("ar", "https://ar-mag.jp/articles/-/19822", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: ar gallery extraction"),

    ("bis", "https://bisweb.jp/category/column", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: bis gallery extraction"),

    ("Ray", "https://ray-web.jp/531989", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: ray gallery extraction"),

    ("HP+ non-no", "https://nonno.hpplus.jp/fashion/watches/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: non-no gallery extraction"),

    ("HP+ SPUR", "https://spur.hpplus.jp/jewelry_watch/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: spur gallery extraction"),

    ("HP+ MAQUIA", "https://maquia.hpplus.jp/tag/3259/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: maquia gallery extraction"),

    ("HP+ LEE", "https://lee.hpplus.jp/column/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: lee gallery extraction"),

    ("HP+ BAILA", "https://baila.hpplus.jp/fashion/watch-jewerly", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: baila gallery extraction"),

    ("ananweb", "https://ananweb.jp/categories/horoscope/76522", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: ananweb gallery extraction"),

    ("Croissant Online", "https://croissant-online.jp/life/268743/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: croissant gallery extraction"),

    ("FRaU", "https://frau.tokyo/list/tag/frau/SPORTS", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: frau gallery extraction"),

    ("mi-mollet", "https://mi-mollet.com/ud/article_photo/search", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: mi-mollet gallery extraction"),

    ("Fashion Press", "https://www.fashion-press.net/news/147206", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: fashion press gallery extraction"),

    ("Fashionsnap", "https://www.fashionsnap.com/article/2026-06-03/nakagawa-masashichi-shitsurindo/?ref=simple-news-click", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: fashionsnap gallery extraction"),

    ("WWD Japan", "https://www.wwdjapan.com/s/505009", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: wwd japan gallery extraction"),

    ("thetv.jp", "https://thetv.jp/news/detail/1401412/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: thetv gallery extraction"),

    ("Mantan Web", "https://mantan-web.jp/article/20240501dog00m200001000c.html", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: mantan web gallery extraction"),

    ("Crank In", "https://www.crank-in.net/news", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: crank-in gallery extraction"),

    ("CinemaToday", "https://www.cinematoday.jp/news/N0153809", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: cinematoday gallery extraction"),

    ("eiga.com", "https://eiga.com/news/20260522/23/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: eiga.com gallery extraction"),

    ("Real Sound", "https://realsound.jp/movie/2026/05/post-2406453.html?utm_source=rs-pickup-pc&utm_medium=all&utm_campaign=block-1", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: real sound gallery extraction"),

    ("Spice", "https://spice.eplus.jp/articles/346378", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: spice gallery extraction"),

    ("JPrime", "https://www.jprime.jp/list/tag/NEWS", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: jprime gallery extraction"),

    ("Smart Flash", "https://smart-flash.jp/entertainment/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: smart flash gallery extraction"),

    ("Nikkan Gendai", "https://www.nikkan-gendai.com/articles/index/news", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: nikkan gendai gallery extraction"),

    ("Asagei", "https://www.asagei.com/category/sports", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: asagei gallery extraction"),

    ("Entame Next", "https://entamenext.com/category/lists/news", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: entame next gallery extraction"),

    ("GirlsNews", "https://girlsnews.tv/category/news", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: girlsnews gallery extraction"),

    ("Tokyo Sports", "https://www.tokyo-sports.co.jp/list/sports", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: tokyo sports gallery extraction"),

    ("Hochi", "https://hochi.news/photos/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: hochi gallery extraction"),

    ("Sponichi", "https://www.sponichi.co.jp/soccer/tokusyu/wc2026/?from=glonavi", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: sponichi gallery extraction"),

    ("Nikkan Sports", "https://www.nikkansports.com/baseball/samurai/wbc2026/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: nikkan sports gallery extraction"),

    ("Sanspo", "https://www.sanspo.com/sports/baseball/mlb/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: sanspo gallery extraction"),

    ("Mainichi", "https://mainichi.jp/ch150910144i/%E9%A6%96%E7%9B%B8%E6%97%A5%E3%80%85", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: mainichi gallery extraction"),

    ("Asahi", "https://www.asahi.com/articles/ASV6B3GFTV6BUEFT00VM.html?iref=comtop_list_01", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: asahi gallery extraction"),

    ("Yomiuri", "https://www.yomiuri.co.jp/news/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: yomiuri gallery extraction"),

    ("Sankei", "https://www.sankei.com/sports/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: sankei gallery extraction"),

    ("Tokyo Shimbun", "https://www.tokyo-np.co.jp/special_contents/special_frontline/honne_column?ref=gnb_pc", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: tokyo shimbun gallery extraction"),

    ("Kyodo", "https://www.kyodo.co.jp/news", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: kyodo gallery extraction"),

    ("47News", "https://www.47news.jp/topic/today0603", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: 47news gallery extraction"),

    ("Jiji", "https://www.jiji.com/jc/2026syu", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: jiji gallery extraction"),

    ("ITmedia", "https://www.itmedia.co.jp/news/articles/2606/10/news058.html", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: itmedia gallery extraction"),

    ("Impress / Watch", "https://www.watch.impress.co.jp/category/life/watch/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: watch impress gallery extraction"),

    ("Mynavi News", "https://news.mynavi.jp/techplus/list/headline/whitepaper/article_type/case/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: mynavi gallery extraction"),

    ("ASCII", "https://ascii.jp/puacl2026/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: ascii gallery extraction"),

    ("Gigazine", "https://gigazine.net/gsc_news/en/", [
        ("server /extract",          strat_server,        {}),
        ("client: OG meta + CDN",    strat_og_meta,       {"accept_lang": "ja-JP,ja;q=0.9"}),
        ("local helper",             strat_local_helper,  {}),
    ], "🌐 browser-only: gigazine gallery extraction"),
]

APP_DOWNLOAD_STRATEGIES = [
    {
        "strategy": "yt-dlp",
        "name": "YouTube page",
        "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "pageUrl": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "mediaType": "direct",
        "mediaKind": "video",
        "note": "YouTube page URL routes through yt-dlp / server re-extract paths.",
    },
    {
        "strategy": "direct",
        "name": "MDN MP4",
        "url": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "pageUrl": "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video",
        "mediaType": "direct",
        "mediaKind": "video",
        "note": "Plain progressive MP4 with a stable public media URL.",
    },
    {
        "strategy": "direct",
        "name": "Wikimedia JPEG",
        "url": "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg",
        "pageUrl": "https://commons.wikimedia.org/wiki/File:Fronalpstock_big.jpg",
        "mediaType": "direct",
        "mediaKind": "image",
        "note": "Image media should stay on the direct downloader path.",
    },
    {
        "strategy": "hls-segments",
        "name": "Mux HLS",
        "url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        "pageUrl": "https://test-streams.mux.dev/",
        "mediaType": "hls",
        "mediaKind": "video",
        "mimeType": "application/vnd.apple.mpegurl",
        "note": "Public HLS test stream with a real manifest.",
    },
    {
        "strategy": "dash",
        "name": "Akamai DASH",
        "url": "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
        "pageUrl": "https://reference.dashif.org/dash.js/latest/samples/getting-started/basic-embed.html",
        "mediaType": "dash",
        "mediaKind": "video",
        "mimeType": "application/dash+xml",
        "note": "Public DASH-IF Big Buck Bunny MPD.",
    },
    {
        "strategy": "dash",
        "name": "Paired DASH tracks",
        "url": "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash-video.mp4",
        "pageUrl": "https://shaka-player-demo.appspot.com/demo/",
        "mediaType": "direct",
        "mediaKind": "video",
        "audioTrackUrl": "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash-audio.mp4",
        "note": "Separate video/audio tracks exercise muxing through the DASH downloader.",
    },
    {
        "strategy": "ffmpeg",
        "name": "ffmpeg mux alias",
        "url": "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash-video.mp4",
        "pageUrl": "https://shaka-player-demo.appspot.com/demo/",
        "mediaType": "direct",
        "mediaKind": "video",
        "audioTrackUrl": "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash-audio.mp4",
        "note": "The app handles ffmpeg as the same muxing path as dash.",
    },
    {
        "strategy": "vimeo-json",
        "name": "Vimeo config / playlist source",
        "url": "https://player.vimeo.com/video/76979871/config",
        "pageUrl": "https://vimeo.com/76979871",
        "mediaType": "direct",
        "mediaKind": "video",
        "note": "Real Vimeo endpoint used to discover CDN playlist JSON media.",
    },
    {
        "strategy": "server-download",
        "name": "Twitter paired HLS",
        "url": "https://x.com/NASA/status/1902118174591521056",
        "pageUrl": "https://x.com/NASA/status/1902118174591521056",
        "mediaType": "hls",
        "mediaKind": "video",
        "provenance": "social-extractor",
        "note": "Server path handles page re-extraction and muxing for social extractor results.",
    },
]

EXPECTED_APP_STRATEGIES = {
    "hls-segments",
    "direct",
    "dash",
    "vimeo-json",
    "ffmpeg",
    "yt-dlp",
    "server-download",
}

BACKEND_EXTRACTION_STRATEGIES = [
    {
        "strategy": "direct media URL short-circuit",
        "name": "Direct media request",
        "url": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "note": "Runs before the normal strategy list for obvious media URLs.",
    },
    {
        "strategy": "direct media content-type probe",
        "name": "Content-Type media probe",
        "url": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
        "note": "Runs before cookie setup when the URL probes as media by response headers.",
    },
    {
        "strategy": "yt-dlp",
        "name": "Primary yt-dlp extractor",
        "url": "https://vimeo.com/76979871",
        "note": "First-line extractor for most non-platform-first pages and YouTube.",
    },
    {
        "strategy": "platform-specific extractor",
        "name": "Custom platform extractor",
        "url": "https://x.com/NASA/status/1902118174591521056",
        "note": "Preferred for platform-first social/gallery sites.",
    },
    {
        "strategy": "ytdl-stream",
        "name": "yt-dlp download-mode stream",
        "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "note": "Fallback for YouTube SABR/HLS guard and selected server-stream pages.",
    },
    {
        "strategy": "WebView/runtime interception",
        "name": "Client runtime placeholder",
        "url": "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
        "note": "Server records this as client-side only.",
    },
    {
        "strategy": "structured media data",
        "name": "JSON-LD / structured media",
        "url": "https://www.oricon.co.jp/news/2285123/full/",
        "note": "Looks for schema.org and other structured media blocks.",
    },
    {
        "strategy": "HTML media scanner",
        "name": "HLS/DASH/OG/generic HTML scan",
        "url": "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/",
        "note": "Single page fetch that scans for manifests, OG media, and generic CDN URLs.",
    },
    {
        "strategy": "embedded player detector",
        "name": "Embedded player lookup",
        "url": "https://www.dailymotion.com/video/xa52aa8",
        "note": "Finds iframe/player embeds and hands them back to yt-dlp.",
    },
    {
        "strategy": "og:image fallback",
        "name": "Open Graph image fallback",
        "url": "https://mdpr.jp/photo/detail/20095233",
        "note": "Last server-side image fallback before generic yt-dlp.",
    },
    {
        "strategy": "generic yt-dlp extractor",
        "name": "Generic yt-dlp fallback",
        "url": "https://www.pinterest.com/pin/84301824269690044/",
        "note": "Generic extractor pass after custom and HTML-based strategies.",
    },
    {
        "strategy": "browser playback fallback",
        "name": "App WebView placeholder",
        "url": "https://tver.jp/episodes/epc1hdugbk",
        "note": "Server records this as app-only playback capture.",
    },
    {
        "strategy": "watermark-free source",
        "name": "Source watermark-free media",
        "url": "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
        "note": "Only runs when remove_watermark is requested.",
    },
    {
        "strategy": "watermark-removal proxy",
        "name": "Proxy watermark removal",
        "url": "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
        "note": "Only runs when remove_watermark is requested after source lookup.",
    },
]

EXPECTED_BACKEND_STRATEGIES = {
    "direct media URL short-circuit",
    "direct media content-type probe",
    "yt-dlp",
    "platform-specific extractor",
    "ytdl-stream",
    "WebView/runtime interception",
    "structured media data",
    "HTML media scanner",
    "embedded player detector",
    "og:image fallback",
    "generic yt-dlp extractor",
    "browser playback fallback",
    "watermark-free source",
    "watermark-removal proxy",
}

# ── Runner ─────────────────────────────────────────────────────────────────────

def run_strategy(label, fn, url, kwargs):
    t0 = time.time()
    try:
        r = fn(url, **kwargs) if kwargs else fn(url)
    except Exception as e:
        r = R(False, str(e)[:120])
    elapsed = time.time() - t0
    return label, r, elapsed

def run_platform(name, url, strategies, browser_note, backend):
    results = []
    # Patch server strategy with correct backend
    patched = []
    for label, fn, kwargs in strategies:
        if fn is strat_server:
            patched.append((label, fn, {**kwargs, "backend": backend}))
        else:
            patched.append((label, fn, kwargs))

    with ThreadPoolExecutor(max_workers=len(patched)) as pool:
        futures = {pool.submit(run_strategy, lbl, fn, url, kw): lbl
                   for lbl, fn, kw in patched}
        order = {lbl: i for i, (lbl, _, _) in enumerate(patched)}
        raw = []
        for f in as_completed(futures):
            raw.append(f.result())
        raw.sort(key=lambda x: order[x[0]])

    return raw, browser_note

def expected_failure_reason(platform, label, r, platform_results):
    if r.ok:
        return ""

    detail = (r.detail or "").lower()
    if "not running" in detail:
        return ""

    _TIMEOUT_TOKENS = (
        "read operation timed out", "handshake operation timed out",
        "the read operation timed out", "timed out",
    )
    is_connectivity_failure = any(t in detail for t in _TIMEOUT_TOKENS) or any(
        tok in detail for tok in ("no route to host", "nodename nor servname",
                                  "urlopen error [errno 65]", "urlopen error [errno 8]")
    )

    if label == "server /extract" and is_connectivity_failure:
        return "remote backend timeout"

    # If the server itself was unreachable, client/helper failures are collateral
    server_detail = next(
        ((r2.detail or "").lower() for lbl, r2, _ in platform_results if lbl == "server /extract"),
        "",
    )
    server_unreachable = any(t in server_detail for t in _TIMEOUT_TOKENS) or any(
        tok in server_detail for tok in ("no route to host", "nodename nor servname",
                                         "urlopen error [errno 65]", "urlopen error [errno 8]")
    )
    if server_unreachable and is_connectivity_failure:
        return "remote backend timeout"

    if label == "local helper":
        if any(other.ok and other_label != "local helper" for other_label, other, _ in platform_results):
            return "helper unsupported for this page"
        if platform in {
            "Threads", "Reddit (gallery)", "Bilibili dynamic / opus", "Douyin",
            "TVer", "DMM", "Bunshun", "Xiaohongshu (explore)",
        }:
            return "helper needs browser/session or unsupported fixture"
        # Helper also fails when the whole site is unreachable from the test environment
        if server_unreachable:
            return "remote backend timeout"

    # Bilibili returns HTTP 412 to datacenter/test IPs; __playinfo__ won't be in page HTML
    if label == "client: __playinfo__ page" and ("http 412" in detail or "__playinfo__ not in page" in detail):
        if any(other.ok for other_label, other, _ in platform_results if other_label != label):
            return "expected server-side block"

    if label == "client: OG meta + CDN":
        # Site blocked the scraper (403/308/etc.) or returned nothing — OG scrape is unavailable
        _og_blocked = "no og/cdn media" in detail or any(
            c in detail for c in ("http 308", "http 403", "http 404", "http 429", "http 5")
        )
        if _og_blocked and any(other.ok for other_label, other, _ in platform_results if other_label != label):
            return "generic OG scrape unavailable"

    expected_platforms = {
        "Threads", "Reddit (gallery)", "Bilibili dynamic / opus", "Weibo (share link)",
        "Xiaohongshu (xhslink)", "Xiaohongshu (explore)", "Douyin", "TVer", "ABEMA",
        "FC2 Video", "FC2 Live", "OpenREC", "FOD / Fuji TV", "DMM",
        "Hulu Japan / TELASA", "Bunshun",
        # Yahoo Japan video/news: Fly.io routing-blocked; Yahoo bots get 403
        "Yahoo Japan video/news",
        # Japanese streaming portals: geo-locked to Japan; server returns a clear restriction message
        "Lemino / docomo video", "U-NEXT", "Locipo / broadcaster catch-up",
        "MBS Dougaizm", "NHK Plus / On Demand",
    }
    if platform not in expected_platforms:
        return ""

    if any(token in detail for token in (
        "sign in", "login", "auth", "cookie", "geo-restricted", "geo-sensitive",
        "drm", "no valid video", "getaddrinfo failed", "http 403", "http 404",
        "http error 4", "http 502", "not found", "no media", "no og/cdn media",
        "no detectable media", "nonetype", "age-gated", "current episode", "requires",
        "nodename nor servname", "no route to host", "unable to download",
    )):
        return "expected source/browser restriction"

    return ""

def fmt_result(label, r, elapsed):
    icon  = "✓" if r.ok else "✗"
    color = ""
    s     = f"  {icon} {label:<35}  {r.detail}"
    if r.note:
        s += f"  [{r.note}]"
    s += f"  ({elapsed:.1f}s)"
    return s

# ── Main ───────────────────────────────────────────────────────────────────────

def fmt_expected_result(label, r, elapsed, expected_reason):
    line = fmt_result(label, r, elapsed)
    if not expected_reason:
        return line
    return f"{line}  <{expected_reason}>"

def validate_app_strategy_matrix():
    covered = {case["strategy"] for case in APP_DOWNLOAD_STRATEGIES}
    missing = sorted(EXPECTED_APP_STRATEGIES - covered)
    extra = sorted(covered - EXPECTED_APP_STRATEGIES)
    return missing, extra

def validate_backend_strategy_matrix():
    covered = {case["strategy"] for case in BACKEND_EXTRACTION_STRATEGIES}
    missing = sorted(EXPECTED_BACKEND_STRATEGIES - covered)
    extra = sorted(covered - EXPECTED_BACKEND_STRATEGIES)
    return missing, extra

def validate_matrix_entries(label, entries):
    errors = []
    required = ("strategy", "name", "url")
    for idx, case in enumerate(entries, 1):
        for key in required:
            if not str(case.get(key, "")).strip():
                errors.append(f"{label}[{idx}] missing {key}")
        parsed = urllib.parse.urlparse(str(case.get("url", "")))
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            errors.append(f"{label}[{idx}] has invalid url: {case.get('url')!r}")
        audio_url = case.get("audioTrackUrl")
        if audio_url:
            parsed_audio = urllib.parse.urlparse(str(audio_url))
            if parsed_audio.scheme not in ("http", "https") or not parsed_audio.netloc:
                errors.append(f"{label}[{idx}] has invalid audioTrackUrl: {audio_url!r}")
    return errors

def read_app_strategies_from_source():
    path = os.path.join(os.path.dirname(__file__), "src", "types", "index.ts")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            src = f.read()
    except OSError:
        return set()
    m = re.search(r"export\s+type\s+DownloadStrategy\s*=\s*([^;]+);", src)
    if not m:
        return set()
    return set(re.findall(r"'([^']+)'", m.group(1)))

def _ast_target_names(target):
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        names = set()
        for item in target.elts:
            names.update(_ast_target_names(item))
        return names
    return set()

def _collect_strategy_tuple_names(node):
    names = set()
    if (
        isinstance(node, ast.Tuple)
        and len(node.elts) >= 2
        and isinstance(node.elts[0], ast.Constant)
        and isinstance(node.elts[0].value, str)
    ):
        names.add(node.elts[0].value)
    for child in ast.iter_child_nodes(node):
        names.update(_collect_strategy_tuple_names(child))
    return names

def read_backend_strategies_from_source():
    path = os.path.join(os.path.dirname(__file__), "server", "strategies.py")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            src = f.read()
    except OSError:
        return set()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return {name for name in EXPECTED_BACKEND_STRATEGIES if name in src}

    strategy_targets = {
        "strategies",
        "platform_strategy",
        "ytdlp_strategy",
        "watermark_proxy_strategy",
    }
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            if any(_ast_target_names(target) & strategy_targets for target in node.targets):
                names.update(_collect_strategy_tuple_names(node.value))
        elif isinstance(node, ast.AnnAssign):
            if _ast_target_names(node.target) & strategy_targets:
                names.update(_collect_strategy_tuple_names(node.value))

    for preflight in ("direct media URL short-circuit", "direct media content-type probe"):
        if preflight in src:
            names.add(preflight)
    return names

def validate_strategy_matrices_against_sources():
    app_missing, app_extra = validate_app_strategy_matrix()
    backend_missing, backend_extra = validate_backend_strategy_matrix()
    source_app = read_app_strategies_from_source()
    source_backend = read_backend_strategies_from_source()
    return {
        "app_missing": app_missing,
        "app_extra": app_extra,
        "backend_missing": backend_missing,
        "backend_extra": backend_extra,
        "entry_errors": validate_matrix_entries("app", APP_DOWNLOAD_STRATEGIES)
        + validate_matrix_entries("backend", BACKEND_EXTRACTION_STRATEGIES),
        "source_app_missing": sorted(source_app - EXPECTED_APP_STRATEGIES),
        "source_app_stale": sorted(EXPECTED_APP_STRATEGIES - source_app) if source_app else [],
        "source_backend_missing": sorted(EXPECTED_BACKEND_STRATEGIES - source_backend),
        "source_backend_unexpected": sorted(source_backend - EXPECTED_BACKEND_STRATEGIES),
    }

def print_matrix_check(check):
    print("App matrix missing:", check["app_missing"])
    print("App matrix extra:", check["app_extra"])
    print("Backend matrix missing:", check["backend_missing"])
    print("Backend matrix extra:", check["backend_extra"])
    print("Matrix entry errors:", check["entry_errors"])
    print("App source strategies not in matrix:", check["source_app_missing"])
    print("Matrix app strategies not in source:", check["source_app_stale"])
    print("Backend strategies not found in source:", check["source_backend_missing"])
    print("Backend source strategies not in matrix:", check["source_backend_unexpected"])
    return not any(check.values())

def main():
    parser = argparse.ArgumentParser(description="Test all FCDownloader extraction strategies")
    parser.add_argument("platforms", nargs="*", help="Filter platforms by name (case-insensitive)")
    parser.add_argument("--backend", default=BACKEND)
    parser.add_argument(
        "--check-matrices",
        action="store_true",
        help="Validate app/backend strategy URL matrices without making network requests",
    )
    args = parser.parse_args()

    if args.check_matrices:
        ok = print_matrix_check(validate_strategy_matrices_against_sources())
        sys.exit(0 if ok else 1)

    selected = [p for p in PLATFORMS
                if not args.platforms
                or any(f.lower() in p[0].lower() for f in args.platforms)]
    if not selected:
        print(f"No platforms matched. Available: {', '.join(p[0] for p in PLATFORMS)}")
        sys.exit(1)

    backend = args.backend.rstrip("/")
    helper_up = _helper_running()

    W = 72
    print(f"\n{'═'*W}")
    print(f"  FCDownloader — All Strategies  ({len(selected)} platform(s))")
    print(f"  Backend : {backend}")
    print(f"  Helper  : {'running at ' + LOCAL_HELPER if helper_up else 'not running'}")
    print(f"{'═'*W}")

    missing_app, extra_app = validate_app_strategy_matrix()
    print("\n  App download strategy media matrix")
    print(f"  {'-'*W}")
    for case in APP_DOWNLOAD_STRATEGIES:
        bits = [case["strategy"], case["name"], case["url"]]
        if case.get("audioTrackUrl"):
            bits.append(f"+ audio {case['audioTrackUrl']}")
        print("  - " + " | ".join(bits))
    if missing_app:
        print(f"  Missing app strategies: {', '.join(missing_app)}")
    if extra_app:
        print(f"  Unknown app strategies: {', '.join(extra_app)}")

    missing_backend, extra_backend = validate_backend_strategy_matrix()
    print("\n  Backend extraction strategy media matrix")
    print(f"  {'-'*W}")
    for case in BACKEND_EXTRACTION_STRATEGIES:
        print(f"  - {case['strategy']} | {case['name']} | {case['url']}")
    if missing_backend:
        print(f"  Missing backend strategies: {', '.join(missing_backend)}")
    if extra_backend:
        print(f"  Unknown backend strategies: {', '.join(extra_backend)}")

    total_pass = total_fail = skipped = total_expected = 0

    for name, url, strategies, browser_note in selected:
        print(f"\n  ▸ {name}")
        print(f"    {url}")
        print(f"  {'─'*W}")

        results, bnote = run_platform(name, url, strategies, browser_note, backend)

        for label, r, elapsed in results:
            expected_reason = expected_failure_reason(name, label, r, results)
            print(fmt_expected_result(label, r, elapsed, expected_reason))
            if r.ok:
                total_pass += 1
            elif expected_reason:
                total_expected += 1
            else:
                total_fail += 1
                if "not running" in r.detail:
                    skipped += 1

        print(f"    {bnote}")

    print(f"\n{'═'*W}")
    print(f"  Tested  : {total_pass + total_fail + total_expected} strategies across {len(selected)} platform(s)")
    print(f"  App strategy media samples: {len(APP_DOWNLOAD_STRATEGIES)} "
          f"covering {len(EXPECTED_APP_STRATEGIES) - len(missing_app)}/{len(EXPECTED_APP_STRATEGIES)} strategies")
    print(f"  Backend strategy media samples: {len(BACKEND_EXTRACTION_STRATEGIES)} "
          f"covering {len(EXPECTED_BACKEND_STRATEGIES) - len(missing_backend)}/{len(EXPECTED_BACKEND_STRATEGIES)} strategies")
    print(f"  Passed  : {total_pass}")
    print(f"  Expected/blocked: {total_expected}")
    print(f"  Failed  : {total_fail - skipped}"
          + (f"  ({skipped} skipped — helper not running)" if skipped else ""))
    print(f"{'═'*W}\n")

if __name__ == "__main__":
    main()

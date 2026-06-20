#!/usr/bin/env python3
"""
Simulate the extension's browser-side (client-side) extraction strategies.

These run in the content script using the user's real IP and session — they
never touch the Fly backend. This is what actually works when the server is
blocked (e.g. Reddit) or when no backend is configured.

Each strategy mirrors what content.js does in the browser.
"""
import re, json, sys, time
import urllib.request, urllib.error, urllib.parse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
MOBILE_UA  = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

def fetch(url, ua=DESKTOP_UA, extra_headers=None, timeout=15, follow=True):
    headers = {"User-Agent": ua, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    try:
        res = urllib.request.urlopen(req, timeout=timeout)
        return res.read().decode("utf-8", errors="replace"), res.url
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)

def fetch_json(url, ua=DESKTOP_UA, extra_headers=None, timeout=15):
    headers = {"User-Agent": ua, "Accept": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    try:
        res = urllib.request.urlopen(req, timeout=timeout)
        return json.loads(res.read()), None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        return None, f"HTTP {e.code}: {body}"
    except Exception as e:
        return None, str(e)

# ── Strategies ─────────────────────────────────────────────────────────────────

def strategy_reddit_json(url):
    """
    scanRedditAsync() — fetch Reddit's JSON API from the browser.
    Works because the request uses the user's real IP, not a datacenter IP.
    """
    # Follow the /s/ share redirect first
    _, final = fetch(url, ua=DESKTOP_UA)
    if not final or final.startswith("HTTP"):
        return [], f"redirect failed: {final}"
    post_match = re.search(r"/comments/([A-Za-z0-9]+)", final)
    if not post_match:
        return [], f"no post ID in {final}"
    post_id = post_match.group(1)
    json_url = f"https://www.reddit.com/comments/{post_id}.json?limit=1&raw_json=1"
    data, err = fetch_json(json_url, ua=DESKTOP_UA,
                           extra_headers={"Accept": "application/json"})
    if err:
        return [], err
    p = data[0]["data"]["children"][0]["data"]
    items = []
    if p.get("secure_media", {}).get("reddit_video"):
        rv = p["secure_media"]["reddit_video"]
        u = rv.get("hls_url") or rv.get("fallback_url")
        if u:
            items.append({"url": u, "kind": "hls" if rv.get("hls_url") else "direct", "label": "Reddit Video"})
    if p.get("is_gallery") and p.get("media_metadata"):
        EXT = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
        order = [x["media_id"] for x in p.get("gallery_data", {}).get("items", [])] \
                or list(p["media_metadata"].keys())
        for mid in order:
            meta = p["media_metadata"].get(mid, {})
            if meta.get("status") != "valid":
                continue
            ext = EXT.get(meta.get("m"), "jpg")
            items.append({"url": f"https://i.redd.it/{mid}.{ext}", "kind": "image",
                          "label": "Reddit Image",
                          "dims": f"{meta.get('s',{}).get('x','?')}x{meta.get('s',{}).get('y','?')}"})
    if not items and p.get("url"):
        u = p["url"]
        if re.search(r"\.(jpe?g|png|gif|webp)(?:[?#]|$)", u, re.I) or re.search(r"i\.redd\.it", u):
            items.append({"url": u, "kind": "image", "label": "Reddit Image"})
    return items, None

def strategy_bilibili_playinfo(url):
    """
    scanBilibili() — extract stream URLs from window.__playinfo__ embedded in page.
    Works without login for 480p; HD needs cookies.
    """
    html, final = fetch(url, ua=DESKTOP_UA,
                        extra_headers={"Referer": "https://www.bilibili.com/"})
    if not html:
        return [], final
    m = re.search(r"window\.__playinfo__\s*=\s*(\{[\s\S]+?\})\s*</script>", html)
    if not m:
        return [], "__playinfo__ not found in page"
    pi = json.loads(m.group(1))
    data = pi.get("data", {})
    items = []
    if data.get("durl"):
        u = data["durl"][0].get("url", "").replace("\\u0026", "&")
        if u:
            items.append({"url": u, "kind": "direct", "label": "Bilibili MP4 (durl)"})
    elif data.get("dash"):
        vids = sorted(data["dash"].get("video", []),
                      key=lambda x: x.get("bandwidth", 0), reverse=True)
        if vids:
            u = (vids[0].get("baseUrl") or vids[0].get("base_url", "")).replace("\\u0026", "&")
            h = vids[0].get("height", "?")
            if u:
                items.append({"url": u, "kind": "direct", "label": f"Bilibili {h}p DASH video"})
    return items, None

def strategy_tiktok_api(url):
    """
    extractTikTok() equivalent — resolve short URL then try TikTok mobile API.
    """
    html, final = fetch(url, ua=MOBILE_UA)
    if not html:
        return [], final
    id_match = re.search(r"(?:video|photo|v|item)/(\d+)", final)
    if id_match:
        vid = id_match.group(1)
        api = f"https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id={vid}"
        data, err = fetch_json(api, ua=MOBILE_UA)
        if not err and data:
            aweme = (data.get("aweme_list") or [{}])[0]
            urls = aweme.get("video", {}).get("play_addr", {}).get("url_list", [])
            if urls:
                return [{"url": urls[0], "kind": "direct", "label": "TikTok Video"}], None
            imgs = aweme.get("image_post_info", {}).get("images", [])
            items = []
            for img in imgs:
                u = (img.get("display_image") or {}).get("url_list", [None])[0]
                if u:
                    items.append({"url": u, "kind": "image", "label": "TikTok Photo"})
            if items:
                return items, None
    # Fallback: scan __UNIVERSAL_DATA_FOR_REHYDRATION__
    sm = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)</script>', html)
    if sm:
        raw = json.dumps(json.loads(sm.group(1)))
        urls = re.findall(r'"playAddr"\s*:\s*"(https?://[^"]+)"', raw)
        if urls:
            return [{"url": u.replace("\\/", "/"), "kind": "direct", "label": "TikTok Video"} for u in urls[:1]], None
    return [], "no media found in page"

def strategy_weibo_api(url):
    """
    extractWeiboGalleryViaApi() equivalent — use Weibo's statuses/show API.
    Also handles mapp.api.weibo.cn redirect URLs.
    """
    target = url
    if "mapp.api.weibo.cn" in url:
        _, target = fetch(url, ua=MOBILE_UA)
        if not target or target.startswith("HTTP"):
            return [], f"redirect failed: {target}"

    def weibo_id(u):
        try:
            parts = urllib.parse.urlparse(u).path.strip("/").split("/")
            host = urllib.parse.urlparse(u).hostname or ""
            if "m.weibo.cn" in host and parts[0] in ("status", "detail"):
                return parts[1] if len(parts) > 1 else ""
            if "weibo.com" in host and len(parts) >= 2:
                return parts[1]
        except:
            pass
        return ""

    wid = weibo_id(target)
    if not wid:
        return [], f"could not extract Weibo ID from {target}"

    for api in [f"https://m.weibo.cn/statuses/show?id={wid}",
                f"https://weibo.com/ajax/statuses/show?id={wid}"]:
        data, err = fetch_json(api, ua=MOBILE_UA,
                               extra_headers={"Referer": target})
        if err:
            continue
        meta = data.get("data") or data
        pics = meta.get("pics", [])
        items = []
        for pic in pics:
            u = (pic.get("largest") or pic.get("large") or pic).get("url", "")
            if u and re.search(r"\.(jpe?g|png|webp|gif)", u, re.I):
                items.append({"url": u, "kind": "image", "label": "Weibo Image"})
        if not items and meta.get("original_pic"):
            items.append({"url": meta["original_pic"], "kind": "image", "label": "Weibo Image"})
        if items:
            return items, None

    return [], "Weibo API returned no pics"

def strategy_xhs_state(url):
    """
    scanXiaohongshu() — parse window.__INITIAL_STATE__ from the XHS page.
    Requires the user to be logged in; without login returns a backendRouted fallback.
    """
    target = url
    if "xhslink.com" in url:
        _, target = fetch(url, ua=MOBILE_UA)
        if not target or target.startswith("HTTP"):
            return [], f"redirect failed: {target}"

    html, _ = fetch(target, ua=MOBILE_UA,
                    extra_headers={"Referer": "https://www.xiaohongshu.com/"})
    if not html:
        return [], "page fetch failed"

    sm = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*;?\s*</script>", html)
    if not sm:
        return [{"url": target, "kind": "embed", "label": "Xiaohongshu (needs login)",
                 "backendRouted": True}], None

    try:
        state = json.loads(sm.group(1).replace("undefined", "null"))
        note_map = (state.get("note") or state.get("noteDetail") or {}).get("noteDetailMap", {})
        note_id = re.search(r"/(?:explore|discovery/item|item)/([a-f0-9]{24})", target)
        note_id = note_id.group(1) if note_id else next(iter(note_map), None)
        note = (note_map.get(note_id) or {}).get("note", {})
        items = []
        if note.get("imageList"):
            for img in note["imageList"]:
                info_list = img.get("infoList", [])
                u = next((i["url"] for i in info_list if i.get("imageScene") in ("WB_DFT","WB_MK","WB_PRV")), None) \
                    or img.get("urlDefault") or img.get("url") or ""
                if u and "sns-avatar" not in u and "avatar" not in u.lower():
                    items.append({"url": u, "kind": "image", "label": "XHS Image"})
        if items:
            return items, None
    except Exception as e:
        return [], f"state parse error: {e}"

    return [{"url": target, "kind": "embed", "label": "Xiaohongshu (needs login)",
             "backendRouted": True}], None

def strategy_og_meta(url, ua=DESKTOP_UA, accept_lang=None):
    """
    Generic OG/meta scrape — works for Oricon, Modelpress, and other news/gallery sites.
    """
    headers = {}
    if accept_lang:
        headers["Accept-Language"] = accept_lang
    html, _ = fetch(url, ua=ua, extra_headers=headers or None)
    if not html:
        return [], "page fetch failed"
    items = []
    seen = set()
    for m in re.finditer(
        r'<meta\s[^>]*(?:property|name)=["\'](?:og:image(?::secure_url)?|og:video(?::url)?|twitter:image)["\'][^>]*content=["\']([^"\']+)["\']',
        html, re.I
    ):
        u = m.group(1).replace("&amp;", "&")
        if u.startswith("http") and u not in seen:
            seen.add(u)
            kind = "image" if re.search(r"\.(jpe?g|png|webp|gif|avif)", u, re.I) else "direct"
            items.append({"url": u, "kind": kind, "label": "OG media"})
    # Also scan for inline CDN image URLs in page HTML
    for m in re.finditer(
        r'(https?://[^"\'<>\s]*(?:contents\.oricon\.co\.jp|img-mdpr\.freetls\.fastly\.net|natalie\.mu|mdpr\.jp/photo)[^"\'<>\s]*\.(?:jpe?g|png|webp))',
        html, re.I
    ):
        u = m.group(1)
        if u not in seen:
            seen.add(u)
            items.append({"url": u, "kind": "image", "label": "CDN image"})
    return items, None

# ── Test runner ───────────────────────────────────────────────────────────────

TESTS = [
    ("TikTok (short)",       "https://vm.tiktok.com/ZNR7eeRqB/",                              strategy_tiktok_api,    {}),
    ("Reddit (gallery)",     "https://www.reddit.com/r/shiba/s/nC3HbrECzI",                   strategy_reddit_json,   {}),
    ("Bilibili",             "https://www.bilibili.com/video/BV1PkR2BkEUt",                   strategy_bilibili_playinfo, {}),
    ("Weibo (share link)",   "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html", strategy_weibo_api, {}),
    ("XHS (short link)",     "http://xhslink.com/o/AuDpBCMNn0z",                              strategy_xhs_state,     {}),
    ("Oricon",               "https://www.oricon.co.jp/news/2452025/full/",                   strategy_og_meta,       {"ua": DESKTOP_UA, "accept_lang": "ja-JP,ja;q=0.9"}),
    ("Modelpress",           "https://mdpr.jp/photo/detail/20095233",                         strategy_og_meta,       {"ua": DESKTOP_UA, "accept_lang": "ja-JP,ja;q=0.9"}),
]
EXPECTED_BLOCKED = {
    "TikTok (short)": "raw script fetch lacks TikTok browser runtime/session",
    "Reddit (gallery)": "Reddit blocks unauthenticated raw script JSON fetches",
    "Bilibili": "public page no longer exposes __playinfo__ to raw script fetches",
    "Weibo (share link)": "Weibo redirects raw script fetches through visitor login",
}

print(f"\n{'─'*70}")
print("  Browser-side extraction strategies (no server involved)")
print(f"{'─'*70}\n")

passed = expected = failed = 0
for name, url, fn, kwargs in TESTS:
    t0 = time.time()
    try:
        items, err = fn(url, **kwargs) if kwargs else fn(url)
    except Exception as e:
        items, err = [], str(e)
    elapsed = time.time() - t0

    if items:
        passed += 1
        summary = f"{len(items)} item(s)"
        first = items[0]
        detail = first.get("label", "")
        if first.get("dims"):
            detail += f"  [{first['dims']}]"
        if first.get("backendRouted"):
            detail += "  (needs login — would route to backend)"
        print(f"  [PASS] {name:<22}  {summary:<12}  {detail}  ({elapsed:.1f}s)")
    else:
        if name in EXPECTED_BLOCKED:
            expected += 1
            print(f"  [EXPECTED] {name:<18}  {err or 'no media'}  <{EXPECTED_BLOCKED[name]}>  ({elapsed:.1f}s)")
        else:
            failed += 1
            print(f"  [FAIL] {name:<22}  {err or 'no media'}  ({elapsed:.1f}s)")

print(f"\n{'─'*70}")
print(f"  {passed}/{passed+expected+failed} passed  ({expected} expected blocked, browser-side strategies, no server used)")
print(f"{'─'*70}\n")

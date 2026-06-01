"""
Platform extractors for XHS, Bilibili, TikTok, and Reddit.
Imported into extractors.py so strategies.py can call extractors.extract_*.
"""
from __future__ import annotations

import gzip
import json
import re
import urllib.parse
import urllib.request
from typing import Any

from utils import cache_key, guess_ext_from_url, safe_headers

_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def _fetch(url: str, headers: dict[str, str], timeout: int = 15) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
                body = gzip.decompress(body)
            return body
    except Exception:
        return None


def _script_json(html: str, marker: str) -> dict[str, Any] | None:
    """Extract a JSON object assigned to `marker` from inside a <script> block."""
    for block in re.findall(r"<script[^>]*>(.*?)</script>", html, re.DOTALL):
        if marker not in block:
            continue
        m = re.search(re.escape(marker) + r"\s*=\s*", block)
        if not m:
            continue
        candidate = block[m.end():].strip().rstrip(";").strip()
        # Replace JS-only literals that break json.loads
        candidate = candidate.replace("undefined", "null")
        try:
            obj, _ = json.JSONDecoder().raw_decode(candidate)
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return None


# ── Xiaohongshu (XHS / 小红书) ─────────────────────────────────────────────────

# CDN prefixes that host actual note media (images/videos).
# Avatar CDNs (sns-avatar-*) are intentionally excluded.
_XHS_MEDIA_CDN = (
    "sns-webpic",
    "sns-img-hw.xhscdn.com",
    "sns-img-bd.xhscdn.com",
    "sns-img-qc.xhscdn.com",
    "ci.xiaohongshu.com",
    "sns-video-hw.xhscdn.com",
    "sns-video-bd.xhscdn.com",
    "sns-video-qc.xhscdn.com",
    "xhscdn.com/spectrum/",
    "xhscdn.com/media/",
)
_XHS_MEDIA_PATH_MARKERS = (
    "/notes_pre_post/",
    "/note_pre_post",
    "/spectrum/",
    "/media/",
)

# imageScene values that represent the full note image (not a square crop or avatar).
_XHS_GOOD_SCENES = ("WB_DFT", "WB_MK", "WB_PRV")


def _xhs_best_image_url(img: dict[str, Any]) -> str | None:
    """Return the best available URL for an XHS imageList entry, skipping avatars."""
    # infoList contains per-scene variants; prefer full-image scenes over SQUARE crops
    info_list = img.get("infoList") or []
    for scene in _XHS_GOOD_SCENES:
        for info in info_list:
            if isinstance(info, dict) and info.get("imageScene") == scene:
                u = info.get("url") or ""
                if u and _xhs_is_media_url(u):
                    return u
    # urlDefault / url fallbacks
    for key in ("urlDefault", "url"):
        u = img.get(key) or ""
        if u and _xhs_is_media_url(u):
            return u
    # Last resort: any infoList URL that isn't an avatar
    for info in info_list:
        if isinstance(info, dict):
            u = info.get("url") or ""
            if u and _xhs_is_media_url(u):
                return u
    return None


def _xhs_is_media_url(url: str) -> bool:
    """Return True if the URL points to a note media asset (not an avatar)."""
    if not url:
        return False
    low = url.replace("\\/", "/").lower()
    if any(skip in low for skip in ("sns-avatar", "/avatar/", "avatar", "profile")):
        return False
    return any(marker in low for marker in _XHS_MEDIA_CDN) or any(
        marker in low for marker in _XHS_MEDIA_PATH_MARKERS
    )


def _xhs_stream_url(stream: dict[str, Any]) -> str | None:
    """Return the first playable stream URL from XHS' shifting video shapes."""
    for codec in ("h264", "h265", "av1", "h264_hls"):
        si = stream.get(codec)
        candidates = si if isinstance(si, list) else [si]
        for item in candidates:
            if not isinstance(item, dict):
                continue
            url = item.get("masterUrl") or item.get("master_url")
            if not url:
                backups = item.get("backupUrls") or item.get("backup_urls") or []
                url = backups[0] if backups else None
            if url and _xhs_is_media_url(url):
                return url
    return None


def _xhs_find_note(data: dict[str, Any], url_note_id: str | None) -> tuple[str | None, dict[str, Any]]:
    """Walk the __INITIAL_STATE__ to locate the noteDetailMap and return (note_id, note_dict)."""
    for section_key in ("note", "noteDetail", "noteData"):
        section = data.get(section_key)
        if not isinstance(section, dict):
            continue
        ndm = section.get("noteDetailMap") or {}
        if not ndm:
            continue
        # Prefer the ID we extracted from the URL — avoids picking a related/recommended note
        note_id = (
            (url_note_id if url_note_id and url_note_id in ndm else None)
            or section.get("currentNoteId")
            or next(iter(ndm), None)
        )
        if not note_id:
            continue
        entry = ndm.get(note_id) or {}
        # Some versions nest under "note", others don't
        note = entry.get("note") or entry
        if isinstance(note, dict) and note:
            return note_id, note
    return None, {}


def extract_xiaohongshu(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    # Note ID from the URL is the most reliable source — prevents picking up a
    # related/recommended note whose images happen to be avatars.
    url_note_id_m = re.search(
        r"/(?:explore|discovery/item|item)/([a-f0-9]{24})", page_url
    )
    url_note_id = url_note_id_m.group(1) if url_note_id_m else None

    headers = safe_headers({
        "User-Agent": _MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        "Referer": "https://www.xiaohongshu.com/",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(page_url, headers)
    if not body:
        return None
    html = body.decode("utf-8", errors="ignore")

    data = _script_json(html, "window.__INITIAL_STATE__")
    if not data:
        return None

    note_id, note = _xhs_find_note(data, url_note_id)
    if not note_id or not note:
        return None

    title = note.get("title") or note.get("desc") or "Xiaohongshu"

    # Video
    video = note.get("video")
    if video:
        stream = (video.get("media") or {}).get("stream") or {}
        if isinstance(stream, dict):
            url = _xhs_stream_url(stream)
            if url:
                is_hls = ".m3u8" in url
                first_img_url = None
                imgs = note.get("imageList") or []
                if imgs and isinstance(imgs[0], dict):
                    first_img_url = _xhs_best_image_url(imgs[0])
                return {
                    "id": note_id,
                    "title": title,
                    "url": url,
                    "ext": "m3u8" if is_hls else "mp4",
                    "protocol": "m3u8_native" if is_hls else "https",
                    "http_headers": {
                        "Referer": "https://www.xiaohongshu.com/",
                        "User-Agent": _MOBILE_UA,
                    },
                    "thumbnail": first_img_url,
                }

    # Image gallery — filter out avatar URLs
    images = note.get("imageList") or []
    entries: list[dict[str, Any]] = []
    for idx, img in enumerate(images):
        if not isinstance(img, dict):
            continue
        url = _xhs_best_image_url(img)
        if not url:
            continue
        entries.append({
            "id": f"{note_id}_{idx}",
            "title": f"{title} #{idx + 1}",
            "url": url,
            "ext": guess_ext_from_url(url) or "jpg",
            "protocol": "https",
            "http_headers": {"Referer": "https://www.xiaohongshu.com/"},
            "thumbnail": url,
        })

    if not entries:
        return None
    if len(entries) == 1:
        return entries[0]
    return {"_type": "playlist", "id": note_id, "title": title, "entries": entries}


# ── Bilibili ──────────────────────────────────────────────────────────────────

def _parse_bilibili_playinfo(
    data: dict[str, Any], title: str, page_url: str, thumb: str | None = None
) -> dict[str, Any] | None:
    play = data.get("data") or data  # API wraps in .data; inline HTML doesn't

    # durl = single MP4/FLV file (video + audio combined) — always prefer this.
    # DASH baseUrl = video-only .m4s segment that requires separate audio muxing.
    durl = play.get("durl") or []
    if durl:
        best = max(durl, key=lambda d: (d.get("size") or 0))
        url = best.get("url") or ""
        if url:
            return {
                "id": cache_key(page_url),
                "title": title,
                "url": url,
                "ext": "mp4",
                "protocol": "https",
                "http_headers": {"Referer": "https://www.bilibili.com/"},
                "thumbnail": thumb,
            }

    # DASH fallback: video-only stream — acceptable when durl is unavailable.
    dash = play.get("dash")
    if isinstance(dash, dict):
        videos = dash.get("video") or []
        if videos:
            best = max(videos, key=lambda v: (v.get("bandwidth") or 0))
            url = best.get("baseUrl") or best.get("base_url") or ""
            if url:
                return {
                    "id": cache_key(page_url),
                    "title": title,
                    "url": url,
                    "ext": "mp4",
                    "protocol": "https",
                    "http_headers": {"Referer": "https://www.bilibili.com/"},
                    "thumbnail": thumb,
                }

    return None


def extract_bilibili(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    api_headers = safe_headers({
        "User-Agent": _DESKTOP_UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json",
        **({"Cookie": cookies} if cookies else {}),
    })

    # Extract BV/AV ID from the URL — no page fetch needed.
    # Bilibili returns 412 to datacenter IPs on the page itself, but the
    # x/web-interface API is often still reachable from the same IP.
    bvid_m = re.search(r"(?:BV|bv)([A-Za-z0-9]{10})", page_url)
    aid_m = re.search(r"/av(\d+)", page_url) or re.search(r"[?&]aid=(\d+)", page_url)
    bvid = "BV" + bvid_m.group(1) if bvid_m else None
    aid = aid_m.group(1) if aid_m else None

    title = "Bilibili Video"
    thumb: str | None = None

    if bvid or aid:
        try:
            param = f"bvid={bvid}" if bvid else f"aid={aid}"
            info_body = _fetch(
                f"https://api.bilibili.com/x/web-interface/view?{param}",
                api_headers, timeout=10,
            )
            if info_body:
                vid_data = json.loads(info_body.decode("utf-8")).get("data") or {}
                cid = vid_data.get("cid")
                aid_val = vid_data.get("aid")
                thumb = vid_data.get("pic") or thumb
                title = vid_data.get("title") or title
                if cid and aid_val:
                    # fnval=1  → durl (single MP4 with audio, works without login for ≤480p)
                    # fnval=16 → DASH (video-only .m4s, needs muxing)
                    for fnval in ("1", "16"):
                        play_body = _fetch(
                            f"https://api.bilibili.com/x/player/playurl"
                            f"?avid={aid_val}&cid={cid}&qn=80&fnval={fnval}&fnver=0&fourk=1",
                            api_headers, timeout=10,
                        )
                        if play_body:
                            api_play = json.loads(play_body.decode("utf-8"))
                            result = _parse_bilibili_playinfo(api_play, title, page_url, thumb=thumb)
                            if result:
                                return result
        except Exception:
            pass

    # Fall back to page HTML when the API didn't give us anything.
    page_headers = safe_headers({
        "User-Agent": _DESKTOP_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        "Referer": "https://www.bilibili.com/",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(page_url, page_headers)
    if not body:
        return None
    html = body.decode("utf-8", errors="ignore")

    title_m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.DOTALL)
    if title_m:
        t = re.sub(r"\s*[_-]\s*哔哩哔哩.*$", "", title_m.group(1).strip(), flags=re.I).strip()
        if t:
            title = t

    # __playinfo__ embedded in page HTML (DASH format; durl is tried first above)
    play_data = _script_json(html, "window.__playinfo__")
    if play_data:
        result = _parse_bilibili_playinfo(play_data, title, page_url, thumb=thumb)
        if result:
            return result

    # readyVideoUrl in HTML (older pages)
    m = re.search(r'"readyVideoUrl"\s*:\s*"([^"]+)"', html)
    if m:
        url = m.group(1).replace("\\/", "/").replace("\\u0026", "&")
        return {
            "id": cache_key(page_url),
            "title": title,
            "url": url,
            "ext": "mp4",
            "protocol": "https",
            "http_headers": {"Referer": "https://www.bilibili.com/"},
        }

    return None


# ── TikTok ────────────────────────────────────────────────────────────────────

def _tiktok_from_item(item: dict[str, Any], page_url: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    video = item.get("video") or {}
    vid_id = str(item.get("id") or item.get("aweme_id") or cache_key(page_url))
    desc = item.get("desc") or item.get("title") or "TikTok Video"

    # Regular video post
    for addr_key in ("downloadAddr", "download_addr", "playAddr", "play_addr"):
        addr = video.get(addr_key)
        if isinstance(addr, dict):
            urls = addr.get("url_list") or addr.get("urlList") or []
            if urls:
                return {
                    "id": vid_id, "title": desc,
                    "url": urls[0], "ext": "mp4",
                    "protocol": "https", "http_headers": {},
                }
        elif isinstance(addr, str) and addr.startswith("http"):
            return {
                "id": vid_id, "title": desc,
                "url": addr, "ext": "mp4",
                "protocol": "https", "http_headers": {},
            }

    # Photo slideshow post — images live in imagePost.images[].imageURL.urlList
    image_post = item.get("imagePost") or {}
    images = image_post.get("images") or []
    if images:
        entries: list[dict[str, Any]] = []
        for idx, img in enumerate(images):
            if not isinstance(img, dict):
                continue
            img_urls = (img.get("imageURL") or {}).get("urlList") or []
            if not img_urls:
                continue
            entries.append({
                "id": f"{vid_id}_{idx}",
                "title": f"{desc} #{idx + 1}",
                "url": img_urls[0],
                "ext": "jpeg",
                "protocol": "https",
                "http_headers": {},
                "thumbnail": img_urls[0],
            })
        if entries:
            if len(entries) == 1:
                return entries[0]
            return {
                "_type": "playlist",
                "id": vid_id,
                "title": desc,
                "entries": entries,
                "thumbnail": entries[0]["url"],
            }

    return None


def extract_tiktok(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    video_id_m = re.search(r"/video/(\d+)", page_url)
    video_id = video_id_m.group(1) if video_id_m else None

    # Strategy 1: parse __UNIVERSAL_DATA_FOR_REHYDRATION__ from page HTML
    html_headers = safe_headers({
        "User-Agent": _MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(page_url, html_headers)
    if body:
        html = body.decode("utf-8", errors="ignore")

        m = re.search(
            r'<script[^>]+id=["\']__UNIVERSAL_DATA_FOR_REHYDRATION__["\'][^>]*>(.*?)</script>',
            html, re.DOTALL,
        )
        if m:
            try:
                urd = json.loads(m.group(1))
                scope = urd.get("__DEFAULT_SCOPE__") or {}
                for key in scope:
                    if "video-detail" in key or "video.detail" in key or "item" in key.lower():
                        section = scope[key]
                        item_struct = (
                            ((section.get("itemInfo") or {}).get("itemStruct"))
                            or ((section.get("videoInfo") or {}).get("itemStruct"))
                            or {}
                        )
                        result = _tiktok_from_item(item_struct, page_url)
                        if result:
                            return result
            except Exception:
                pass

        m2 = re.search(
            r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
            html, re.DOTALL,
        )
        if m2:
            try:
                nd = json.loads(m2.group(1))
                item_struct = (
                    (((nd.get("props") or {}).get("pageProps") or {})
                     .get("itemInfo") or {}).get("itemStruct") or {}
                )
                result = _tiktok_from_item(item_struct, page_url)
                if result:
                    return result
            except Exception:
                pass

        # Raw scan for video MP4 URLs in HTML
        for pattern in (
            r'"downloadAddr"\s*:\s*"(https?://[^"]+\.mp4[^"]*)"',
            r'"playAddr"\s*:\s*"(https?://[^"]+\.mp4[^"]*)"',
        ):
            m3 = re.search(pattern, html)
            if m3:
                url = m3.group(1).replace("\\/", "/").replace("\\u0026", "&")
                return {
                    "id": video_id or cache_key(page_url),
                    "title": "TikTok Video",
                    "url": url, "ext": "mp4",
                    "protocol": "https", "http_headers": {},
                }

    # Strategy 2: TikTok API (often blocked on datacenter IPs without cookies)
    if video_id:
        api_url = (
            f"https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/"
            f"?aweme_id={video_id}"
        )
        api_body = _fetch(api_url, safe_headers({"User-Agent": _MOBILE_UA, "Accept": "*/*"}))
        if api_body:
            try:
                data = json.loads(api_body.decode("utf-8"))
                for aweme in (data.get("aweme_list") or []):
                    result = _tiktok_from_item(aweme, page_url)
                    if result:
                        return result
            except Exception:
                pass

    return None


# ── Reddit ────────────────────────────────────────────────────────────────────

def extract_reddit(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    _reddit_ua = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    )
    # Share links (/s/xxx) are redirects — follow them to get the canonical URL
    # before appending /.json, otherwise the JSON endpoint returns 404.
    if re.search(r"/s/[A-Za-z0-9]+/?$", page_url):
        try:
            req = urllib.request.Request(
                page_url,
                headers=safe_headers({
                    "User-Agent": _reddit_ua,
                    "Accept": "text/html,*/*",
                    **({"Cookie": cookies} if cookies else {}),
                }),
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                page_url = resp.url
        except Exception:
            pass

    # Strip query string and trailing slash before appending /.json
    json_url = re.sub(r"[?#].*$", "", page_url).rstrip("/") + "/.json?limit=1"
    headers = safe_headers({
        # A real browser UA is required; Reddit blocks obvious bots
        "User-Agent": _reddit_ua,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(json_url, headers)
    if not body:
        return None

    try:
        data = json.loads(body.decode("utf-8"))
        post = data[0]["data"]["children"][0]["data"]
    except Exception:
        return None

    reddit_video = (post.get("secure_media") or {}).get("reddit_video") or {}
    if not reddit_video:
        reddit_video = (post.get("media") or {}).get("reddit_video") or {}

    if not reddit_video:
        return None

    vid_id = post.get("id") or cache_key(page_url)
    title = post.get("title") or "Reddit Video"
    thumb = post.get("thumbnail")
    if thumb in ("default", "self", "nsfw", ""):
        thumb = None

    # Prefer HLS (audio+video in one stream) > DASH > fallback_url (video only)
    for key, ext, proto in (
        ("hls_url",      "m3u8", "m3u8_native"),
        ("dash_url",     "mpd",  "http_dash_segments"),
        ("fallback_url", "mp4",  "https"),
    ):
        url = reddit_video.get(key)
        if url:
            return {
                "id": vid_id, "title": title,
                "url": url, "ext": ext,
                "protocol": proto, "http_headers": {},
                "thumbnail": thumb,
            }

    return None

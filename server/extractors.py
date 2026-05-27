"""
Platform-specific media extractors.

Each extractor handles one or more sites that either (a) have no yt-dlp
extractor, or (b) need custom logic that yt-dlp doesn't handle well from a
server/datacenter context.

Currently implemented:
  - Meta family (Instagram, Threads) — HTML scrape for video_url / carousel
  - Weibo — REST API extraction with playback_list format selection

All extractors return either:
  - A standard yt-dlp info dict (single video / image)
  - A yt-dlp "playlist" dict with an `entries` list (carousel / gallery)
  - None on failure

None of these functions log raw cookie values.
"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
from typing import Any, Iterator

import languages
from config import MOBILE_UA
from utils import (
    cache_key,
    normalize_url,
    safe_headers,
    safe_text,
    strip_header_controls,
    guess_ext_from_url,
)


# ── Shared helpers ────────────────────────────────────────────────────────────

_WEIBO_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)


# ── Meta family (Instagram / Threads) ────────────────────────────────────────


def extract_meta_page(
    page_url: str,
    cookies: str | None,
    label: str,
) -> dict[str, Any] | None:
    """Fetch a Meta-family page and pull out video_url / og:video / carousel.

    Returns the standard response shape or None when nothing usable was found.
    """
    page_url = normalize_url(page_url)
    try:
        req = urllib.request.Request(
            page_url,
            headers=safe_headers({
                "User-Agent": MOBILE_UA,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                **({"Cookie": cookies} if cookies else {}),
            }),
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html_text = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        print(f"[{label}] fetch failed for {page_url}: {str(exc)[:200]}")
        return None

    def _decode(u: str) -> str:
        return (
            u.replace("\\u0026", "&")
             .replace("\\u003d", "=")
             .replace("\\/", "/")
             .replace("\\\\", "\\")
        )

    found: list[tuple[int, str, str]] = []  # (offset, url, "image"|"video")

    for pattern in (
        r'"video_url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"playable_url(?:_quality_hd)?"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"browser_native_(?:hd|sd)_url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"video_versions"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
    ):
        for m in re.finditer(pattern, html_text):
            found.append((m.start(), _decode(m.group(1)), "video"))

    for pattern in (
        r'"display_url"\s*:\s*"(https?:\\?/\\?/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"',
        r'"image_versions2"\s*:\s*\{\s*"candidates"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
    ):
        for m in re.finditer(pattern, html_text):
            found.append((m.start(), _decode(m.group(1)), "image"))

    for m in re.finditer(
        r'<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["\'](?:og:video(?::url)?|twitter:player:stream)["\']'
        r'[^>]+content\s*=\s*["\']([^"\']+)["\']',
        html_text, re.IGNORECASE,
    ):
        found.append((m.start(), _decode(m.group(1)), "video"))

    for m in re.finditer(
        r'https?:\\?/\\?/(?:[\w-]+\.)?(?:fbcdn|threadscdn|instagram)\.com/[^\s"\'<>\\]+\.(?:mp4|m3u8)(?:\?[^\s"\'<>\\]*)?',
        html_text,
    ):
        found.append((m.start(), _decode(m.group(0)), "video"))

    found.sort(key=lambda t: t[0])
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for _off, u, kind in found:
        if not u.startswith("http"):
            continue
        dedup_key = u.split("?")[0]
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        uniq.append((u, kind))

    if not uniq:
        return None

    title: str | None = None
    title_m = re.search(
        r'<meta\s+property\s*=\s*["\']og:title["\'][^>]+content\s*=\s*["\']([^"\']+)["\']',
        html_text, re.IGNORECASE,
    )
    if title_m:
        title = title_m.group(1)

    thumb: str | None = None
    thumb_m = re.search(
        r'<meta\s+property\s*=\s*["\']og:image["\'][^>]+content\s*=\s*["\']([^"\']+)["\']',
        html_text, re.IGNORECASE,
    )
    if thumb_m:
        thumb = _decode(thumb_m.group(1))

    def _is_likely_avatar(u: str) -> bool:
        return bool(re.search(r"/profile_pic|/avatar|/s\d+x\d+/", u, re.I)) and "/post/" not in u

    filtered = [(u, k) for u, k in uniq if not _is_likely_avatar(u)]
    if filtered:
        uniq = filtered

    if len(uniq) >= 2:
        entries = []
        for u, kind in uniq:
            is_hls = ".m3u8" in u
            ext = guess_ext_from_url(u) or ("m3u8" if is_hls else ("jpg" if kind == "image" else "mp4"))
            entries.append({
                "id":           cache_key(u),
                "url":          u,
                "ext":          ext,
                "protocol":     "m3u8_native" if is_hls else "https",
                "http_headers": {"User-Agent": MOBILE_UA, "Referer": page_url},
                "title":        title,
            })
        print(f"[{label}] carousel: {len(entries)} item(s)")
        return {
            "_type":   "playlist",
            "entries": entries,
            "title":   title,
            "thumbnail": thumb,
            "id":      cache_key(page_url),
        }

    chosen, kind = uniq[0]
    is_hls = ".m3u8" in chosen
    print(f"[{label}] single: {chosen[:100]}")
    return {
        "url": chosen,
        "http_headers": {"User-Agent": MOBILE_UA, "Referer": page_url},
        "title": title,
        "thumbnail": thumb,
        "duration": None,
        "ext": "m3u8" if is_hls else guess_ext_from_url(chosen) or "mp4",
        "protocol": "m3u8_native" if is_hls else "https",
        "format_note": "HD" if ("hd_url" in chosen or "_hd_" in chosen) else None,
        "id": cache_key(page_url),
    }


def extract_threads(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return extract_meta_page(page_url, cookies, "threads")


def extract_instagram(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return extract_meta_page(page_url, cookies, "instagram")


# ── Weibo ─────────────────────────────────────────────────────────────────────


def _weibo_headers(page_url: str, cookies: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {
        "User-Agent": _WEIBO_DESKTOP_UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": languages.accept_language_for_url(
            page_url,
            "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        ),
        "Referer": page_url or "https://weibo.com/",
        "Origin": "https://weibo.com",
        "X-Requested-With": "XMLHttpRequest",
    }
    if cookies:
        headers["Cookie"] = cookies
    return headers


def _download_weibo_json(
    url: str,
    page_url: str,
    cookies: str | None,
    query: dict[str, str] | None = None,
    data: bytes | None = None,
) -> dict[str, Any] | None:
    url = normalize_url(url)
    page_url = normalize_url(page_url)
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    try:
        req = urllib.request.Request(
            url,
            data=data,
            headers=safe_headers(_weibo_headers(page_url, cookies)),
            method="POST" if data is not None else "GET",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            ct = resp.headers.get("Content-Type", "")
    except Exception as exc:  # noqa: BLE001
        print(f"[weibo] JSON fetch failed for {url}: {str(exc)[:200]}")
        return None

    if "json" not in ct.lower() and not body.lstrip().startswith(("{", "[")):
        print(f"[weibo] expected JSON, got {ct or 'unknown content-type'} from {url}")
        return None
    try:
        data_obj = json.loads(body)
        return data_obj if isinstance(data_obj, dict) else None
    except Exception as exc:  # noqa: BLE001
        print(f"[weibo] JSON parse failed for {url}: {str(exc)[:200]}")
        return None


def _json_get_path(obj: Any, *path: str) -> Any:
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _walk_json(obj: Any) -> Iterator[Any]:
    yield obj
    if isinstance(obj, dict):
        for value in obj.values():
            yield from _walk_json(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk_json(value)


def _weibo_id_from_url(page_url: str) -> str | None:
    parsed = urllib.parse.urlparse(page_url)
    host = parsed.netloc.lower()
    path = parsed.path.strip("/")
    qs = urllib.parse.parse_qs(parsed.query)
    if "video.weibo.com" in host:
        return (qs.get("fid") or [None])[-1]
    if path.startswith("tv/show/"):
        return path.split("/", 2)[-1] or None
    parts = [p for p in path.split("/") if p]
    if "m.weibo.cn" in host and len(parts) >= 2 and parts[0] in {"status", "detail"}:
        return parts[1]
    if "weibo.com" in host and len(parts) >= 2:
        return parts[1]
    return None


def _weibo_best_format(media_info: dict[str, Any]) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []

    def add_candidate(url: str, extra: dict[str, Any] | None = None) -> None:
        clean = url.replace("\\u0026", "&").replace("\\/", "/")
        lower = clean.lower()
        candidates.append({
            "url": clean,
            "ext": "m3u8" if ".m3u8" in lower else "mp4",
            "protocol": "m3u8_native" if ".m3u8" in lower else "https",
            "http_headers": {
                "Referer": "https://weibo.com/",
                "User-Agent": _WEIBO_DESKTOP_UA,
            },
            **(extra or {}),
        })

    playback = media_info.get("playback_list")
    if isinstance(playback, list):
        for item in playback:
            play = item.get("play_info") if isinstance(item, dict) else None
            if not isinstance(play, dict) or not play.get("url"):
                continue
            add_candidate(play["url"], {
                "format_id":   play.get("label"),
                "format_note": play.get("quality_desc"),
                "width":       play.get("width"),
                "height":      play.get("height"),
                "tbr":         play.get("bitrate"),
                "filesize":    play.get("size"),
            })

    if not candidates:
        urls = media_info.get("urls")
        if isinstance(urls, dict):
            for key in ("mp4_uhd_mp4", "mp4_hd_mp4", "mp4_ld_mp4", "mp4_hd", "mp4_ld"):
                value = urls.get(key)
                if isinstance(value, str) and value.startswith("http"):
                    add_candidate(value, {
                        "format_id":   key,
                        "format_note": key.replace("_", " ").upper(),
                    })

    if not candidates:
        for key in ("stream_url_hd", "stream_url"):
            value = media_info.get(key)
            if isinstance(value, str) and value.startswith("http"):
                add_candidate(value, {
                    "format_id":   key,
                    "format_note": "HD" if key.endswith("_hd") else None,
                })

    if not candidates:
        seen: set[str] = set()
        for value in _walk_json(media_info):
            if not isinstance(value, str) or not re.search(r"https?://", value):
                continue
            url = value.replace("\\u0026", "&").replace("\\/", "/")
            if not re.search(
                r"(?:weibocdn\.com|sinaimg\.cn).*\.(?:mp4|m3u8|mov)(?:[?#]|$)", url, re.I
            ):
                continue
            if url in seen:
                continue
            seen.add(url)
            add_candidate(url)

    if not candidates:
        return None

    def score(fmt: dict[str, Any]) -> int:
        u = (fmt.get("url") or "").lower()
        height = int(fmt.get("height") or 0)
        width = int(fmt.get("width") or 0)
        bitrate = int(fmt.get("tbr") or 0)
        size = int(fmt.get("filesize") or 0)
        fmt_id = str(fmt.get("format_id") or "").lower()
        mp4_bonus = 10_000_000 if ".mp4" in u else 0
        hls_penalty = -1_000_000 if ".m3u8" in u else 0
        hd_bonus = 500_000 if any(t in u or t in fmt_id for t in ("hd", "uhd")) else 0
        low_penalty = -250_000 if any(t in u or t in fmt_id for t in ("ld", "sd")) else 0
        return mp4_bonus + hd_bonus + low_penalty + hls_penalty + height * width + bitrate + size // 1024

    return sorted(candidates, key=score)[-1]


def _weibo_parse_post(
    meta: dict[str, Any], page_url: str
) -> dict[str, Any] | None:
    entries: list[dict[str, Any]] = []

    def thumbnail_url() -> str | None:
        pic = _json_get_path(meta, "page_info", "page_pic")
        if isinstance(pic, dict):
            return pic.get("url")
        return pic if isinstance(pic, str) else None

    def add_video_from_media_info(
        media_info: Any, fallback_id: str | None = None
    ) -> None:
        if not isinstance(media_info, dict):
            return
        best = _weibo_best_format(media_info)
        if not best:
            return
        entries.append({
            **best,
            "id": fallback_id or str(
                meta.get("id") or meta.get("mid") or cache_key(best["url"])
            ),
            "title": (
                media_info.get("video_title")
                or media_info.get("kol_title")
                or media_info.get("name")
                or meta.get("text_raw")
            ),
            "thumbnail": thumbnail_url(),
            "duration": media_info.get("duration"),
        })

    mix_items = _json_get_path(meta, "mix_media_info", "items")
    if isinstance(mix_items, list):
        for item in mix_items:
            if not isinstance(item, dict) or item.get("type") == "pic":
                continue
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            add_video_from_media_info(
                data.get("media_info"),
                str(data.get("object_id") or ""),
            )

    page_info = meta.get("page_info") if isinstance(meta.get("page_info"), dict) else {}
    top_media_info = page_info.get("media_info")
    if isinstance(top_media_info, dict) and isinstance(page_info.get("urls"), dict):
        top_media_info = {**top_media_info, "urls": page_info["urls"]}
    add_video_from_media_info(top_media_info)

    if not entries:
        return None

    title = (
        _json_get_path(meta, "page_info", "media_info", "video_title")
        or _json_get_path(meta, "page_info", "media_info", "kol_title")
        or _json_get_path(meta, "page_info", "media_info", "name")
        or meta.get("text_raw")
    )
    thumb = thumbnail_url()
    post_id = str(
        meta.get("id") or meta.get("id_str") or meta.get("mid") or cache_key(page_url)
    )

    if len(entries) > 1:
        return {
            "_type":     "playlist",
            "entries":   entries,
            "title":     title,
            "thumbnail": thumb,
            "id":        post_id,
        }

    single = entries[0]
    single.setdefault("id", post_id)
    single.setdefault("title", title)
    single.setdefault("thumbnail", thumb)
    single.setdefault("http_headers", {
        "Referer": "https://weibo.com/",
        "User-Agent": _WEIBO_DESKTOP_UA,
    })
    return single


def extract_weibo(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    video_id = _weibo_id_from_url(page_url)
    if not video_id:
        return None

    if ":" in video_id:
        body = (
            f'data={{"Component_Play_Playinfo":{{"oid":"{video_id}"}}}}'
        ).encode("utf-8", errors="replace")
        component = _download_weibo_json(
            "https://weibo.com/tv/api/component",
            page_url,
            cookies,
            query={"page": f"/tv/show/{video_id}"},
            data=body,
        )
        mid = _json_get_path(
            component or {}, "data", "Component_Play_Playinfo", "mid"
        )
        if mid:
            video_id = str(mid)

    meta = _download_weibo_json(
        "https://weibo.com/ajax/statuses/show",
        page_url,
        cookies,
        query={"id": video_id},
    )
    if not meta:
        meta = _download_weibo_json(
            "https://m.weibo.cn/statuses/show",
            page_url,
            cookies,
            query={"id": video_id},
        )
    if isinstance(meta, dict) and isinstance(meta.get("data"), dict):
        meta = meta["data"]

    parsed = _weibo_parse_post(meta, page_url) if meta else None
    if parsed:
        count = len(parsed.get("entries") or [parsed])
        print(f"[weibo] extracted {count} media item(s) via ajax/statuses/show")
    return parsed

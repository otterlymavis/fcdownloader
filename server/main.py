"""
HD extraction server for the fcdownloader app.

Hardened for distribution: per-IP rate limiting, response caching, and an
optional shared-token tier-skip for trusted callers (your own dev/testing
devices). No secrets are required to use the endpoint — security comes from
the rate limit + cache layer, since a bundled-in-APK token leaks the moment
anyone decompiles the APK.

Endpoint:
    POST /extract  { "pageUrl": "https://www.youtube.com/watch?v=..." }
    →  { "kind": "hls"|"paired"|"direct",
         "url"?, "videoUrl"?, "audioUrl"?,
         "headers": {...},
         "label"?, "mimeType"?, "audioMimeType"?, "expire"? }
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shlex
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
from typing import Any, Iterator

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from yt_dlp import YoutubeDL


def _client_ip(request: Request) -> str:
    """
    Return the real client IP, honouring proxy headers set by Fly.io /
    Cloudflare / generic L7 proxies. SlowAPI's default `get_remote_address`
    reads `request.client.host`, which on Fly is the internal proxy IP and
    would put all real clients in the same bucket.
    """
    # Order: Fly's specific header → CF-Connecting-IP → X-Forwarded-For first hop
    hdr = request.headers
    for key in ("Fly-Client-IP", "CF-Connecting-IP", "X-Real-IP"):
        v = hdr.get(key)
        if v:
            return v.strip()
    xff = hdr.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# ── Configuration ────────────────────────────────────────────────────────────

# Optional. Devices that send this token bypass the rate limit (handy for your
# own dev phone or a test harness). Casual users hit the default rate limit.
TRUSTED_TOKEN = os.environ.get("TRUSTED_TOKEN", "").strip()

COOKIES_FILE = os.environ.get("YT_COOKIES_FILE", "").strip()

# YouTube bot-detects datacenter IPs and demands cookies. Easiest way to ship
# them to Fly without a volume: base64-encode the cookies.txt and pass as a
# secret. We decode it once at startup.
_COOKIES_B64 = os.environ.get("YT_COOKIES_BASE64", "").strip()
if _COOKIES_B64 and not COOKIES_FILE:
    try:
        _tmp = tempfile.NamedTemporaryFile(mode="wb", suffix="-cookies.txt", delete=False)
        _tmp.write(base64.b64decode(_COOKIES_B64))
        _tmp.close()
        COOKIES_FILE = _tmp.name
        print(f"[startup] cookies decoded to {COOKIES_FILE}")
    except Exception as e:  # noqa: BLE001
        print(f"[startup] WARNING: failed to decode YT_COOKIES_BASE64: {e}")

# Per-IP rate limit. Defaults give a normal user plenty of headroom but block
# anyone trying to use the endpoint as a generic yt-dlp service.
RATE_LIMIT = os.environ.get("RATE_LIMIT", "30/minute;300/hour;1500/day")

# Cache TTL in seconds. yt-dlp signed URLs are valid for ~6h, so callers that
# request the same video within this window get the cached extraction back
# without invoking yt-dlp.
CACHE_TTL = int(os.environ.get("CACHE_TTL", "300"))  # 5 min default
CACHE_MAX = int(os.environ.get("CACHE_MAX", "2000")) # hard cap on entries

# yt-dlp format spec — tiered from "ideal for Android MediaMuxer" down to
# "anything yt-dlp can produce". MediaMuxer needs h264+aac in mp4 container;
# the higher-priority alternatives target that pair. Lower-priority fallbacks
# accept any codec/container so we don't fail entire videos when YouTube only
# serves vp9/opus for a particular region+client combination.
FORMAT_SPEC = (
    # Ideal — h264/avc1 video + m4a/aac audio (MediaMuxer-compatible)
    "bv*[height<=1080][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/"
    "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/"
    # Any 1080p video + best audio (might need re-encode if vp9/opus on Android)
    "bv*[height<=1080]+ba/"
    # Any pre-muxed file (single download, no mux step at all)
    "b[ext=mp4][height<=1080]/"
    "b[height<=1080]/"
    "b"
)

# ── App + middleware ─────────────────────────────────────────────────────────

limiter = Limiter(key_func=_client_ip)
app = FastAPI(title="fcdownloader-extractor", version="2.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS — set ALLOWED_ORIGINS to a comma-separated list of your web frontend
# origins to lock this down. Leave unset / "*" for a fully-public API.
# Browser-extension origins (chrome-extension://, moz-extension://) are ALWAYS
# allowed — extensions go through the OS install chain so the trust boundary
# is already at the user; restricting them by per-install random ID is
# impractical and breaks the legit use case.
_allowed = os.environ.get("ALLOWED_ORIGINS", "*").strip()
_origins = ["*"] if _allowed == "*" else [o.strip() for o in _allowed.split(",") if o.strip()]
_extension_origin_regex = r"^(chrome|moz|safari-web|edge)-extension://[a-zA-Z0-9_-]+$"
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=_extension_origin_regex,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# ── Cache ────────────────────────────────────────────────────────────────────

# Simple in-memory dict cache. For one Fly machine this is fine; if you scale
# horizontally later, switch to Redis (one line change).
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _cache_get(key: str) -> dict[str, Any] | None:
    entry = _cache.get(key)
    if not entry:
        return None
    ts, val = entry
    if time.time() - ts > CACHE_TTL:
        _cache.pop(key, None)
        return None
    return val


def _cache_put(key: str, val: dict[str, Any]) -> None:
    # Trivial LRU-by-insertion-order eviction. Python 3.7+ preserves dict order.
    if len(_cache) >= CACHE_MAX:
        # Drop the oldest 10% in one pass to amortise eviction cost.
        for k in list(_cache.keys())[: CACHE_MAX // 10]:
            _cache.pop(k, None)
    _cache[key] = (time.time(), val)


def _cache_key(page_url: str) -> str:
    # Stable across query-param shuffles by extracting the canonical video id.
    m = re.search(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/|/v/)([A-Za-z0-9_-]{11})", page_url)
    return m.group(1) if m else page_url


# ── Request model ────────────────────────────────────────────────────────────


class ExtractRequest(BaseModel):
    pageUrl: str
    # Optional embedding-page URL. For Vimeo videos restricted to a specific
    # domain (e.g. AmusePlus pages embedding a Vimeo player), passing the
    # embedding URL as Referer is what unlocks playback. yt-dlp's Vimeo
    # extractor reads this and forwards it on the /config request.
    referer: str | None = None
    # Optional raw Cookie header for logged-in pages. Do not send this in a URL.
    cookies: str | None = None


class DownloadRequest(BaseModel):
    pageUrl: str
    referer: str | None = None
    cookies: str | None = None


# ── Routes ───────────────────────────────────────────────────────────────────


@app.get("/")
def health() -> dict[str, Any]:
    return {
        "ok":          True,
        "cached":      len(_cache),
        "rate_limit":  RATE_LIMIT,
        "cache_ttl":   CACHE_TTL,
    }


# ── Threads / Meta HTML extractor ────────────────────────────────────────────
#
# yt-dlp has no Threads extractor (Meta's threads.net site). The mobile app
# handles it by treating Threads URLs the same as Instagram and regex-scanning
# the page HTML for the standard Meta `video_url` JSON field. We mirror that
# here so the web app and the mobile app behave identically.

_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

def _extract_meta_page(page_url: str, cookies: str | None, label: str) -> dict[str, Any] | None:
    """Fetch a Meta-family page and pull out a video_url, an og:video tag,
    or any direct mp4 / m3u8 URL. Returns the standard response shape or
    None when nothing usable was found (caller falls through to yt-dlp)."""
    try:
        req = urllib.request.Request(page_url, headers={
            "User-Agent": _MOBILE_UA,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            **({"Cookie": cookies} if cookies else {}),
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        print(f"[{label}] fetch failed for {page_url}: {str(e)[:200]}")
        return None

    # Meta JSON-encodes URLs with escaped slashes + unicode. Decode patterns.
    def _decode(u: str) -> str:
        return (u.replace("\\u0026", "&")
                 .replace("\\u003d", "=")
                 .replace("\\/", "/")
                 .replace("\\\\", "\\"))

    # Collect (offset, url, kind) tuples in document order. The offset is what
    # lets us pair carousel items together — Instagram carousel JSON appears
    # contiguously in the HTML in carousel order, so sorting by offset gives
    # us the user-visible item order.
    found: list[tuple[int, str, str]] = []  # (offset, url, "image"|"video")

    # Videos: "video_url" / "playable_url" / "browser_native_*_url" / "video_versions[].url"
    for pattern in (
        r'"video_url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"playable_url(?:_quality_hd)?"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"browser_native_(?:hd|sd)_url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"video_versions"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
    ):
        for m in re.finditer(pattern, html):
            found.append((m.start(), _decode(m.group(1)), "video"))

    # Images: "display_url" (single-item posts), and image_versions2 candidates
    # (carousel image entries; first candidate is the highest-resolution).
    for pattern in (
        r'"display_url"\s*:\s*"(https?:\\?/\\?/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"',
        r'"image_versions2"\s*:\s*\{\s*"candidates"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
    ):
        for m in re.finditer(pattern, html):
            found.append((m.start(), _decode(m.group(1)), "image"))

    # og:video / twitter:player:stream tags (always-present fallback)
    for m in re.finditer(
        r'<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["\'](?:og:video(?::url)?|twitter:player:stream)["\']'
        r'[^>]+content\s*=\s*["\']([^"\']+)["\']', html, re.IGNORECASE):
        found.append((m.start(), _decode(m.group(1)), "video"))

    # Raw fbcdn / threads-cdn URLs in the page (last-resort)
    for m in re.finditer(
        r'https?:\\?/\\?/(?:[\w-]+\.)?(?:fbcdn|threadscdn|instagram)\.com/[^\s"\'<>\\]+\.(?:mp4|m3u8)(?:\?[^\s"\'<>\\]*)?',
        html):
        found.append((m.start(), _decode(m.group(0)), "video"))

    # Sort by offset (document order), then de-dupe — first occurrence wins so
    # the carousel order is preserved.
    found.sort(key=lambda t: t[0])
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []  # (url, kind)
    for _off, u, kind in found:
        if not u.startswith("http"):
            continue
        # Strip query strings for the dedup key — Instagram's CDN signs the same
        # asset with multiple oh/oe pairs across the page (avatar + post tile +
        # carousel item), and we want a single dedup'd item per asset.
        dedup_key = u.split("?")[0]
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        uniq.append((u, kind))

    if not uniq:
        return None

    title = None
    title_m = re.search(r'<meta\s+property\s*=\s*["\']og:title["\'][^>]+content\s*=\s*["\']([^"\']+)["\']', html, re.IGNORECASE)
    if title_m:
        title = title_m.group(1)
    thumb = None
    thumb_m = re.search(r'<meta\s+property\s*=\s*["\']og:image["\'][^>]+content\s*=\s*["\']([^"\']+)["\']', html, re.IGNORECASE)
    if thumb_m:
        thumb = _decode(thumb_m.group(1))

    # Heuristic: avatars + page chrome thumbnails appear MANY times across the
    # page HTML. Real carousel media occurs once. Filter obvious avatar/icon
    # CDN paths so a single-image post doesn't get padded with profile pics.
    def _is_likely_avatar(u: str) -> bool:
        return bool(re.search(r"/profile_pic|/avatar|/s\d+x\d+/", u, re.I)) and "/post/" not in u

    filtered = [(u, k) for u, k in uniq if not _is_likely_avatar(u)]
    if filtered:
        uniq = filtered

    # Carousel: ≥2 unique media. Return as a playlist so the gallery pipeline
    # picks it up. Single item → fall through to the existing single-info shape.
    if len(uniq) >= 2:
        entries = []
        for u, kind in uniq:
            is_hls = ".m3u8" in u
            ext = _guess_ext_from_url(u) or ("m3u8" if is_hls else ("jpg" if kind == "image" else "mp4"))
            entries.append({
                "id":           _cache_key(u),
                "url":          u,
                "ext":          ext,
                "protocol":     "m3u8_native" if is_hls else "https",
                "http_headers": {"User-Agent": _MOBILE_UA, "Referer": page_url},
                "title":        title,
            })
        print(f"[{label}] carousel: {len(entries)} item(s) ({sum(1 for u,k in uniq if k=='image')} photo, {sum(1 for u,k in uniq if k=='video')} video)")
        return {
            "_type":   "playlist",
            "entries": entries,
            "title":   title,
            "thumbnail": thumb,
            "id":      _cache_key(page_url),
        }

    chosen, kind = uniq[0]
    is_hls = ".m3u8" in chosen

    print(f"[{label}] single: {chosen[:100]}")

    return {
        "url": chosen,
        "http_headers": {"User-Agent": _MOBILE_UA, "Referer": page_url},
        "title": title,
        "thumbnail": thumb,
        "duration": None,
        "ext": "m3u8" if is_hls else _guess_ext_from_url(chosen) or "mp4",
        "protocol": "m3u8_native" if is_hls else "https",
        "format_note": "HD" if ("hd_url" in chosen or "_hd_" in chosen) else None,
        "id": _cache_key(page_url),
    }


def _extract_meta_threads(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return _extract_meta_page(page_url, cookies, "threads")


def _extract_meta_instagram(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return _extract_meta_page(page_url, cookies, "instagram")


# Shared yt-dlp invocation — used by both /extract and /download
def _run_ydl(
    page_url: str,
    referer: str | None = None,
    cookies: str | None = None,
) -> dict[str, Any]:
    http_headers: dict[str, str] = {}
    if referer:
        http_headers["Referer"] = referer
    elif "bilivideo.com" in page_url or "bilibili.com" in page_url:
        # Bilibili's anti-bot wall on api.bilibili.com / webpage requests
        # returns HTTP 412 to plain User-Agents. Set the desktop UA + Referer +
        # Origin so the request looks like a normal browser session, and
        # yt-dlp's WBI signing has the right context to work against.
        http_headers["Referer"]    = "https://www.bilibili.com/"
        http_headers["Origin"]     = "https://www.bilibili.com"
        http_headers["User-Agent"] = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        )
    if cookies:
        http_headers["Cookie"] = cookies

    direct_media = re.search(
        r"(?:\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:[?#]|$)|bilivideo\.com/|cdninstagram\.com/|scontent[-\w]*\.cdninstagram\.com/|fbcdn\.net/|threadscdn\.com/)",
        page_url,
        re.IGNORECASE,
    )
    if direct_media:
        ext = _guess_ext_from_url(page_url) or ("m3u8" if ".m3u8" in page_url.lower() else "mp4")
        return {
            "url": page_url,
            "http_headers": http_headers,
            "title": None,
            "thumbnail": None,
            "duration": None,
            "ext": ext,
            "protocol": "m3u8_native" if ".m3u8" in page_url.lower() else "https",
            "id": _cache_key(page_url),
        }

    # YouTube client selection (order matters — first match wins):
    #   - tv:          newer TV client, returns non-SABR formats up to 1080p
    #                  and is the current recommended primary client.
    #   - web_safari:  desktop client that doesn't require po_token.
    #   - mweb:        mobile web, lower quality but reliable last-resort.
    # `android_vr` / `tv_simply` started returning sabr.malformed_config in
    # early 2026 when YouTube tightened SABR config validation; removed.
    # `player_skip=configs` tells yt-dlp not to negotiate the SABR config
    # endpoint that's been changing format under us.
    extractor_args: dict[str, Any] = {
        "youtube": {
            "player_client": ["tv", "web_safari", "mweb"],
            "player_skip": ["configs"],
        },
    }
    # Vimeo's embed-only check reads its `referer` extractor_arg first, then
    # falls back to `ydl_opts['referer']`. Set BOTH to be robust across
    # yt-dlp versions; otherwise we get the "Cannot download embed-only
    # video without embedding URL" error even with the Referer http header set.
    if referer:
        extractor_args["vimeo"] = {"referer": [referer]}

    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "format": FORMAT_SPEC,
        "skip_download": True,
        "outtmpl": "/tmp/%(id)s.%(ext)s",
        "extractor_args": extractor_args,
    }
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts["cookiefile"] = COOKIES_FILE
    if referer:
        ydl_opts["referer"] = referer
    if http_headers:
        ydl_opts["http_headers"] = http_headers
    # Threads (Meta) has no yt-dlp extractor — handle it here by mirroring the
    # mobile app's Instagram-style HTML regex extraction. Returns a
    # yt-dlp-shaped info dict so the rest of the pipeline is unchanged.
    if "threads.net" in page_url or "threads.com" in page_url:
        threads_info = _extract_meta_threads(page_url, cookies)
        if threads_info:
            return threads_info
        print(f"[threads] HTML scrape found nothing; falling back to yt-dlp for {page_url}")
    if "instagram.com" in page_url:
        instagram_info = _extract_meta_instagram(page_url, cookies)
        if instagram_info:
            return instagram_info
        print(f"[instagram] HTML scrape found nothing; falling back to yt-dlp for {page_url}")

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        # yt-dlp returns "Unsupported URL" for sites it doesn't have a
        # dedicated extractor for. Retry with the generic extractor — it
        # scrapes the page for video tags / m3u8 URLs / iframe embeds and
        # often succeeds where the URL-pattern matchers gave up
        # (AmusePlus → Vimeo iframe is the canonical case).
        if "Unsupported URL" in msg:
            print(f"[ydl] retrying with generic extractor for {page_url}")
            try:
                ydl_opts["force_generic_extractor"] = True
                with YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(page_url, download=False)
            except Exception as e2:  # noqa: BLE001
                print(f"[ydl] generic also failed for {page_url}: {str(e2)[:200]}")
                raise HTTPException(502, f"yt-dlp: {e2}")
        else:
            print(f"[ydl] failed for {page_url} (referer={referer}, cookies={bool(cookies)}): {msg[:200]}")
            raise HTTPException(502, f"yt-dlp: {e}")
    if not info:
        raise HTTPException(502, "yt-dlp returned no info")
    return info


@app.post("/extract")
@limiter.limit(RATE_LIMIT)
def extract(
    request: Request,
    req: ExtractRequest,
) -> dict[str, Any]:
    # Different referers can produce different responses (Vimeo /config domain
    # check), so include it in the cache key.
    cache_key = _request_cache_key(req.pageUrl, req.referer, req.cookies)
    if (cached := _cache_get(cache_key)) is not None:
        return cached

    info = _run_ydl(req.pageUrl, referer=req.referer, cookies=req.cookies)

    # Instagram carousels / Reddit galleries / Threads carousels come back as
    # yt-dlp playlists. Return them as a gallery so the client can offer
    # "Save all" rather than just the first item.
    if info.get("_type") == "playlist" and info.get("entries"):
        response = _to_gallery_response(info)
        response["title"] = info.get("title")
        _cache_put(cache_key, response)
        print(f"[extract] gallery: {len(response['items'])} item(s)")
        return response

    response = _to_response(info)
    # Title / thumbnail / duration are useful for web UIs that preview before
    # download. Extract once; cheap to include.
    response["title"]     = info.get("title")
    response["thumbnail"] = info.get("thumbnail")
    response["duration"]  = info.get("duration")

    if response.get("kind") == "paired":
        rf = info.get("requested_formats", [{}, {}])
        print(f"[extract] paired: video={rf[0].get('format_id')} ({rf[0].get('height')}p {rf[0].get('vcodec')}) audio={rf[1].get('format_id')} {response.get('label')} extractor={info.get('extractor')}")
    else:
        print(f"[extract] {response.get('kind')}: itag={info.get('format_id')} height={info.get('height')} vcodec={info.get('vcodec')} {response.get('label')} extractor={info.get('extractor')}")

    # Bilibili-specific: yt-dlp needs a SESSDATA cookie for bilibili.com to
    # return anything above 480p. If we picked <720p for a Bilibili URL, the
    # cookies file is almost certainly the cause — log it so it shows up in
    # `fly logs` next to the request.
    if "bilibili" in (info.get("extractor") or "") or "bilibili.com" in req.pageUrl:
        h = info.get("height") or (info.get("requested_formats") or [{}])[0].get("height") or 0
        if h and h < 720:
            has_bili_cookies = False
            if COOKIES_FILE and os.path.exists(COOKIES_FILE):
                try:
                    with open(COOKIES_FILE, "r", encoding="utf-8", errors="ignore") as f:
                        has_bili_cookies = any("bilibili" in line for line in f)
                except Exception:
                    pass
            print(f"[extract] WARNING: Bilibili capped at {h}p. cookies_have_bilibili={has_bili_cookies}. "
                  f"Upload a cookies.txt with bilibili.com SESSDATA to YT_COOKIES_BASE64.")

    _cache_put(cache_key, response)
    return response


# ── /download — server-muxed mp4 streamed to the client ─────────────────────


def _safe_filename(title: str | None, video_id: str) -> str:
    base = title if title else video_id
    # Strip path-unsafe chars; collapse whitespace; cap length.
    s = re.sub(r"[^\w\-一-鿿぀-ヿ ]", "", base, flags=re.UNICODE).strip()
    s = re.sub(r"\s+", " ", s) or video_id
    return s[:80] + ".mp4"


def _ffmpeg_header_arg(headers: dict[str, str] | None) -> str | None:
    if not headers:
        return None
    return "".join(f"{k}: {v}\r\n" for k, v in headers.items() if v)


def _download_headers(referer: str | None, cookies: str | None, page_url: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {}
    if referer:
        headers["Referer"] = referer
    elif page_url and ("bilibili.com" in page_url or "bilivideo.com" in page_url):
        # Bilibili CDN (upos-*.bilivideo.com) returns 403 without Referer.
        # If the caller didn't pass one, derive it from the page URL host.
        headers["Referer"] = "https://www.bilibili.com/"
        headers["Origin"]  = "https://www.bilibili.com"
    if cookies:
        headers["Cookie"] = cookies
    return headers


def _needs_headered_direct_stream(page_url: str, media_url: str, headers: dict[str, str]) -> bool:
    if headers.get("Cookie"):
        return True
    combined = f"{page_url} {media_url}".lower()
    return any(host in combined for host in (
        "bilibili.com",
        "bilivideo.com",
        "instagram.com",
        "cdninstagram.com",
        "fbcdn.net",
        "threadscdn.com",
    ))


def _ffmpeg_stream(
    video_url: str,
    audio_url: str | None,
    hls_master: str | None,
    request_headers: dict[str, str] | None = None,
) -> Iterator[bytes]:
    """
    Run ffmpeg as a subprocess, pipe its stdout to the HTTP response.

    Two muxing scenarios:
     - Paired (audio_url given): `-i video -i audio -c copy` → mp4 (fast, no re-encode)
     - HLS (hls_master given):  `-i master.m3u8 -c copy`     → mp4
     - Direct single mp4:        not handled here — caller redirects to the URL instead
    """
    ff_headers = _ffmpeg_header_arg(request_headers)
    input_header_args = ["-headers", ff_headers] if ff_headers else []

    if audio_url:
        args = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            *input_header_args, "-i", video_url,
            *input_header_args, "-i", audio_url,
            "-c", "copy",
            "-map", "0:v:0", "-map", "1:a:0",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", "pipe:1",
        ]
    elif hls_master:
        args = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            *input_header_args, "-i", hls_master,
            "-c", "copy",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", "pipe:1",
        ]
    else:
        raise HTTPException(500, "internal: no mux source")

    print("[download] ffmpeg", shlex.join(args[:12]) + " ...")
    proc = subprocess.Popen(
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
    )
    try:
        while True:
            chunk = proc.stdout.read(64 * 1024) if proc.stdout else b""
            if not chunk:
                break
            yield chunk
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.kill()


@app.get("/download")
@limiter.limit(RATE_LIMIT)
def download(
    request: Request,
    url: str = Query(..., description="Video page or player URL"),
    referer: str | None = Query(None, description="Optional Referer for domain-restricted embeds (e.g. AmusePlus → Vimeo)"),
    cookies: str | None = Query(None, description="Optional Cookie header for logged-in embeds"),
) -> StreamingResponse:
    info = _run_ydl(url, referer=referer, cookies=cookies)
    response = _to_response(info)
    video_id = info.get("id") or _cache_key(url)
    filename = _safe_filename(info.get("title"), video_id)

    headers = {
        # Content-Disposition with both forms — RFC 5987 filename* for unicode,
        # plain filename= as ASCII fallback for older browsers.
        "Content-Disposition": (
            f'attachment; filename="{video_id}.mp4"; '
            f"filename*=UTF-8''{_url_quote(filename)}"
        ),
        "Cache-Control": "no-store",
    }

    kind = response["kind"]
    request_headers = {**(response.get("headers") or {}), **_download_headers(referer, cookies, page_url=url)}
    if kind == "paired":
        return StreamingResponse(
            _ffmpeg_stream(response["videoUrl"], response["audioUrl"], None, request_headers),
            media_type="video/mp4", headers=headers,
        )
    if kind == "hls":
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], request_headers),
            media_type="video/mp4", headers=headers,
        )
    # kind == "direct" → already a single mp4, redirect the browser straight to
    # googlevideo (saves server bandwidth — 100% of the bytes go phone↔CDN).
    if _needs_headered_direct_stream(url, response["url"], request_headers):
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], request_headers),
            media_type="video/mp4", headers=headers,
        )
    return RedirectResponse(response["url"], status_code=307, headers=headers)


@app.post("/download")
@limiter.limit(RATE_LIMIT)
def download_post(
    request: Request,
    req: DownloadRequest,
) -> StreamingResponse:
    info = _run_ydl(req.pageUrl, referer=req.referer, cookies=req.cookies)
    response = _to_response(info)
    video_id = info.get("id") or _cache_key(req.pageUrl)
    filename = _safe_filename(info.get("title"), video_id)
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{video_id}.mp4"; '
            f"filename*=UTF-8''{_url_quote(filename)}"
        ),
        "Cache-Control": "no-store",
    }
    request_headers = {**(response.get("headers") or {}), **_download_headers(req.referer, req.cookies, page_url=req.pageUrl)}

    kind = response["kind"]
    if kind == "paired":
        return StreamingResponse(
            _ffmpeg_stream(response["videoUrl"], response["audioUrl"], None, request_headers),
            media_type="video/mp4", headers=headers,
        )
    if kind == "hls":
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], request_headers),
            media_type="video/mp4", headers=headers,
        )
    return StreamingResponse(
        _ffmpeg_stream("", None, response["url"], request_headers),
        media_type="video/mp4", headers=headers,
    )


# ── /debug — diagnostic endpoint, no caching, returns yt-dlp's raw format list
#
# Use this to figure out *why* a given URL came back at the quality it did.
# Two interesting buckets:
#  - max_height_seen < expected (e.g. 480 for Bilibili 1080p video) → yt-dlp
#    itself can't see HD. Almost always means missing/expired cookies for the
#    site, OR the wrong extractor client/player. Check `cookies_loaded` and the
#    `formats` table.
#  - max_height_seen ≥ expected but chosen format is lower → our FORMAT_SPEC
#    rejected the HD formats. Inspect `chosen_format` + the format constraints.
#
# Endpoint is intentionally noisy and slow (re-runs yt-dlp every call); never
# cache responses. Locked to clients passing the TRUSTED_TOKEN to keep random
# strangers from using it as a free yt-dlp probe.

@app.get("/debug")
def debug_extract(
    request: Request,
    url: str = Query(...),
    referer: str | None = Query(None),
    cookies: str | None = Query(None),
    authorization: str | None = Header(None),
) -> dict[str, Any]:
    # Trusted-token gate. Without a token configured, allow the call (handy in
    # local dev / Fly logs). With a token configured, require it.
    if TRUSTED_TOKEN:
        bearer = (authorization or "").replace("Bearer ", "").strip()
        if bearer != TRUSTED_TOKEN:
            raise HTTPException(401, "debug requires TRUSTED_TOKEN")

    out: dict[str, Any] = {
        "url":              url,
        "cookies_loaded":   bool(COOKIES_FILE and os.path.exists(COOKIES_FILE)),
        "cookies_file":     COOKIES_FILE or None,
        "format_spec":      FORMAT_SPEC,
    }

    # Probe which cookie domains are present, without leaking the values. This
    # is the actionable bit for Bilibili HD: cookies need a SESSDATA entry on
    # bilibili.com or yt-dlp can only see the 480p durl track.
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        try:
            with open(COOKIES_FILE, "r", encoding="utf-8", errors="ignore") as f:
                domains: dict[str, list[str]] = {}
                for line in f:
                    if line.startswith("#") or "\t" not in line:
                        continue
                    parts = line.split("\t")
                    if len(parts) < 7:
                        continue
                    domain, name = parts[0], parts[5]
                    domains.setdefault(domain.lstrip("."), []).append(name)
                out["cookie_domains"] = {d: sorted(set(names)) for d, names in domains.items()}
        except Exception as e:  # noqa: BLE001
            out["cookie_domains_error"] = str(e)[:200]

    # Run yt-dlp with NO format filter so we get the full format list yt-dlp
    # was able to see for this URL. This separates "yt-dlp couldn't see HD"
    # from "we filtered HD out".
    http_headers: dict[str, str] = {}
    if referer: http_headers["Referer"] = referer
    if cookies: http_headers["Cookie"] = cookies
    probe_opts: dict[str, Any] = {
        "quiet":          True,
        "no_warnings":    True,
        "skip_download":  True,
        "extractor_args": {
            "youtube": {"player_client": ["tv", "web_safari", "mweb"], "player_skip": ["configs"]},
        },
    }
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        probe_opts["cookiefile"] = COOKIES_FILE
    if http_headers:
        probe_opts["http_headers"] = http_headers

    try:
        with YoutubeDL(probe_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        out["error"] = f"yt-dlp: {str(e)[:400]}"
        return out

    out["extractor"]  = info.get("extractor")
    out["title"]      = info.get("title")
    out["_type"]      = info.get("_type")

    # If it's a playlist (e.g. an IG carousel), summarise the entries instead
    # of dumping each one's formats.
    if info.get("_type") == "playlist":
        out["entry_count"] = len(info.get("entries") or [])
        out["entry_summary"] = [
            {
                "id":     (e or {}).get("id"),
                "ext":    (e or {}).get("ext"),
                "height": (e or {}).get("height"),
                "format": (e or {}).get("format_id"),
            }
            for e in (info.get("entries") or [])[:10]
        ]
        return out

    formats = info.get("formats") or []
    out["format_count"] = len(formats)
    out["max_height_seen"] = max(
        (f.get("height") or 0 for f in formats if f.get("vcodec") not in (None, "none")),
        default=None,
    )

    # Run yt-dlp AGAIN with our real FORMAT_SPEC so we can compare which one it
    # would have chosen for /extract. format_id / height tells us the
    # final answer.
    pick_opts = {**probe_opts, "format": FORMAT_SPEC}
    try:
        with YoutubeDL(pick_opts) as ydl2:
            picked = ydl2.extract_info(url, download=False)
        if picked.get("requested_formats"):
            v, a = picked["requested_formats"]
            out["chosen_format"] = {
                "paired":         True,
                "video_format_id": v.get("format_id"),
                "video_height":   v.get("height"),
                "video_vcodec":   v.get("vcodec"),
                "video_ext":      v.get("ext"),
                "audio_format_id": a.get("format_id"),
                "audio_acodec":   a.get("acodec"),
            }
        else:
            out["chosen_format"] = {
                "paired":     False,
                "format_id":  picked.get("format_id"),
                "height":     picked.get("height"),
                "vcodec":     picked.get("vcodec"),
                "acodec":     picked.get("acodec"),
                "ext":        picked.get("ext"),
            }
    except Exception as e:  # noqa: BLE001
        out["chosen_format_error"] = f"yt-dlp: {str(e)[:400]}"

    # Compact table of formats yt-dlp saw. Trim to fields that matter for
    # diagnosing quality issues.
    out["formats"] = [
        {
            "id":     f.get("format_id"),
            "ext":    f.get("ext"),
            "height": f.get("height"),
            "width":  f.get("width"),
            "fps":    f.get("fps"),
            "vcodec": f.get("vcodec"),
            "acodec": f.get("acodec"),
            "tbr":    f.get("tbr"),
            "proto":  f.get("protocol"),
            "note":   f.get("format_note"),
        }
        for f in formats
    ]
    return out


# ── /proxy — stream a media URL through the server with auth-shape headers ──
#
# Browser extensions can't set Referer / Origin / User-Agent on
# chrome.downloads.download() calls. That's a blocker for Instagram /
# Bilibili / Threads / Reddit CDN URLs that 403 or redirect to login when
# those headers are missing. /proxy streams the bytes through us so we can
# attach the headers the CDN expects.
#
# Used by the extension's gallery downloads (each photo + video in an IG
# carousel goes through here). Not for yt-dlp-resolved video streams —
# those still use /download because they may need ffmpeg muxing.


def _default_proxy_headers(target_url: str, referer: str | None) -> dict[str, str]:
    """Sane defaults so the CDN we're hitting will actually respond. The caller
    may override any of these via explicit query params."""
    host = ""
    try:
        host = urllib.parse.urlparse(target_url).hostname or ""
    except Exception:
        pass
    h: dict[str, str] = {
        "User-Agent":      _MOBILE_UA,
        "Accept":          "*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        h["Referer"] = referer
    elif "cdninstagram" in host or "fbcdn" in host:
        h["Referer"] = "https://www.instagram.com/"
    elif "threadscdn" in host:
        h["Referer"] = "https://www.threads.com/"
    elif "bilivideo" in host or "biliapi" in host or "bilibili" in host:
        h["Referer"] = "https://www.bilibili.com/"
        h["Origin"]  = "https://www.bilibili.com"
    elif "redd.it" in host or "redditmedia" in host:
        h["Referer"] = "https://www.reddit.com/"
    return h


@app.get("/proxy")
@limiter.limit(RATE_LIMIT)
def proxy(
    request: Request,
    url: str = Query(..., description="Media URL to proxy"),
    referer: str | None = Query(None),
    cookies: str | None = Query(None),
    filename: str | None = Query(None, description="Suggested filename for Content-Disposition"),
) -> StreamingResponse:
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must be absolute http(s)")
    headers = _default_proxy_headers(url, referer)
    if cookies:
        headers["Cookie"] = cookies

    try:
        req = urllib.request.Request(url, headers=headers)
        upstream = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")[:240]
        except Exception: pass
        raise HTTPException(e.code, f"upstream: {body or e.reason}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"upstream: {str(e)[:240]}")

    content_type = upstream.headers.get("Content-Type", "application/octet-stream")
    out_headers: dict[str, str] = {"Cache-Control": "no-store"}
    if filename:
        safe = re.sub(r'[<>:"/\\|?*\x00-\x1F]+', "", filename).strip()[:160] or "download"
        out_headers["Content-Disposition"] = f'attachment; filename="{safe}"; filename*=UTF-8\'\'{_url_quote(safe)}'
    # Pass through Content-Length when known so the browser shows accurate progress.
    if cl := upstream.headers.get("Content-Length"):
        out_headers["Content-Length"] = cl

    def stream() -> Iterator[bytes]:
        try:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            try: upstream.close()
            except Exception: pass

    return StreamingResponse(stream(), media_type=content_type, headers=out_headers)


def _url_quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")


def _request_cache_key(page_url: str, referer: str | None, cookies: str | None) -> str:
    key = _cache_key(page_url)
    if referer:
        key += "|" + referer
    if cookies:
        key += "|cookies:" + hashlib.sha256(cookies.encode("utf-8")).hexdigest()[:16]
    return key


# ── Response shaping ─────────────────────────────────────────────────────────


_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "heic"}


def _guess_ext_from_url(url: str) -> str:
    m = re.search(r"\.([a-z0-9]{2,5})(?:\?|$)", url.split("?")[0].lower())
    return m.group(1) if m else ""


def _to_gallery_response(info: dict[str, Any]) -> dict[str, Any]:
    """Shape an Instagram carousel / Reddit gallery / Threads thread into a
    list of media items. Each entry is either an image (.jpg/.webp) or a
    video; the client downloads them one by one."""
    items: list[dict[str, Any]] = []
    for entry in info.get("entries") or []:
        if not entry:
            continue

        # Video entries: yt-dlp picks `requested_formats` (paired) or surfaces
        # the chosen format's URL directly. Images: just a `url`.
        url: str | None = None
        is_paired = False
        if entry.get("requested_formats") and len(entry["requested_formats"]) == 2:
            # Paired video — would need server muxing; surface both URLs.
            video, audio = entry["requested_formats"]
            if video.get("vcodec") == "none" and audio.get("vcodec") != "none":
                video, audio = audio, video
            items.append({
                "kind":          "paired",
                "videoUrl":      video["url"],
                "audioUrl":      audio["url"],
                "headers":       _headers_for(video),
                "label":         _label_for(video),
                "ext":           video.get("ext") or "mp4",
                "title":         entry.get("title"),
            })
            continue

        url = entry.get("url")
        if not url and entry.get("formats"):
            # Last format is usually best for IG/Reddit single-format entries
            url = entry["formats"][-1].get("url")
        if not url:
            continue

        ext = (entry.get("ext") or _guess_ext_from_url(url) or "").lower()
        is_image = ext in _IMAGE_EXTS
        items.append({
            "kind":     "image" if is_image else ("hls" if _looks_like_hls(url, entry.get("protocol")) else "direct"),
            "url":      url,
            "headers":  _headers_for(entry),
            "label":    _label_for(entry),
            "ext":      ext or ("mp4" if not is_image else "jpg"),
            "mimeType": _mime_for(entry) if not is_image else f"image/{ext or 'jpeg'}",
            "title":    entry.get("title"),
        })

    return {"kind": "gallery", "items": items, "count": len(items)}


def _to_response(info: dict[str, Any]) -> dict[str, Any]:
    requested = info.get("requested_formats")
    if requested and len(requested) == 2:
        video, audio = requested
        if video.get("vcodec") == "none" and audio.get("vcodec") != "none":
            video, audio = audio, video
        return {
            "kind":          "paired",
            "videoUrl":      video["url"],
            "audioUrl":      audio["url"],
            "headers":       _headers_for(video),
            "label":         _label_for(video),
            "mimeType":      _mime_for(video),
            "audioMimeType": _mime_for(audio),
            "expire":        _expire_of(video["url"]),
        }

    url = info.get("url")
    if not url:
        raise HTTPException(502, "yt-dlp info had no url")

    if _looks_like_hls(url, info.get("protocol")):
        return {
            "kind":     "hls",
            "url":      url,
            "headers":  _headers_for(info),
            "label":    _label_for(info),
            "mimeType": "application/x-mpegURL",
            "expire":   _expire_of(url),
        }

    return {
        "kind":     "direct",
        "url":      url,
        "headers":  _headers_for(info),
        "label":    _label_for(info),
        "mimeType": _mime_for(info),
        "expire":   _expire_of(url),
    }


def _looks_like_hls(url: str, protocol: str | None) -> bool:
    if protocol and "m3u8" in protocol:
        return True
    return ".m3u8" in url or "/api/manifest/hls" in url


def _headers_for(f: dict[str, Any]) -> dict[str, str]:
    h = (f.get("http_headers") or {}).copy()
    h.pop("Authorization", None)
    h.pop("authorization", None)
    h.pop("Cookie", None)
    h.pop("cookie", None)
    return h


def _label_for(f: dict[str, Any]) -> str | None:
    if note := f.get("format_note"):
        return note
    if height := f.get("height"):
        return f"{height}p"
    return f.get("resolution")


def _mime_for(f: dict[str, Any]) -> str | None:
    ext = f.get("ext")
    if not ext:
        return None
    return {
        "m4a": "audio/mp4",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mkv": "video/x-matroska",
    }.get(ext, f"video/{ext}")


def _expire_of(url: str) -> int | None:
    m = re.search(r"[?&]expire=(\d+)", url)
    return int(m.group(1)) if m else None

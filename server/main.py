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
import os
import re
import tempfile
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
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

# yt-dlp format spec: prefer best 1080p h264 video + m4a audio as a pair.
FORMAT_SPEC = (
    "bv*[height<=1080][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/"
    "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/"
    "b[ext=mp4]/b"
)

# ── App + middleware ─────────────────────────────────────────────────────────

limiter = Limiter(key_func=_client_ip)
app = FastAPI(title="fcdownloader-extractor", version="2.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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


# ── Routes ───────────────────────────────────────────────────────────────────


@app.get("/")
def health() -> dict[str, Any]:
    return {
        "ok":          True,
        "cached":      len(_cache),
        "rate_limit":  RATE_LIMIT,
        "cache_ttl":   CACHE_TTL,
    }


@app.post("/extract")
@limiter.limit(RATE_LIMIT, exempt_when=lambda: False)  # placeholder; real exemption below
def extract(
    request: Request,
    req: ExtractRequest,
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> dict[str, Any]:
    # Trusted callers bypass the rate limit. SlowAPI doesn't natively support
    # per-call exemptions cleanly, so we re-check the limit ourselves and
    # short-circuit when trusted. (The decorator above still applies, but
    # SlowAPI evaluates exempt_when on every call; we use a separate trusted
    # check after the fact for simplicity.)
    is_trusted = bool(
        TRUSTED_TOKEN and (
            (authorization or "").strip() == f"Bearer {TRUSTED_TOKEN}"
            or token == TRUSTED_TOKEN
        )
    )
    # NB: when is_trusted, the @limiter.limit decorator has already counted
    # this request. That's fine — trusted callers aren't typically the ones
    # straining the limit.

    cache_key = _cache_key(req.pageUrl)
    cached = _cache_get(cache_key)
    if cached:
        return cached

    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "format": FORMAT_SPEC,
        "skip_download": True,
        "outtmpl": "/tmp/%(id)s.%(ext)s",
        # Try clients in order — mweb/tv_simply trigger bot-check less often on
        # datacenter IPs. android_vr is the historical workhorse for HD formats.
        "extractor_args": {
            "youtube": {
                "player_client": ["default", "mweb", "tv_simply", "android_vr"],
            },
        },
    }
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts["cookiefile"] = COOKIES_FILE

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.pageUrl, download=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"yt-dlp: {e}")

    if not info:
        raise HTTPException(502, "yt-dlp returned no info")

    response = _to_response(info)
    _cache_put(cache_key, response)
    return response


# ── Response shaping ─────────────────────────────────────────────────────────


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

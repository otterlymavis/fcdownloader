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
import os
import re
import shlex
import subprocess
import tempfile
import time
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
_allowed = os.environ.get("ALLOWED_ORIGINS", "*").strip()
_origins = ["*"] if _allowed == "*" else [o.strip() for o in _allowed.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
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


# Shared yt-dlp invocation — used by both /extract and /download
def _run_ydl(
    page_url: str,
    referer: str | None = None,
    cookies: str | None = None,
) -> dict[str, Any]:
    http_headers: dict[str, str] = {}
    if referer:
        http_headers["Referer"] = referer
    if cookies:
        http_headers["Cookie"] = cookies

    extractor_args: dict[str, Any] = {
        "youtube": {"player_client": ["android_vr", "tv_simply", "mweb"]},
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
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
    except Exception as e:  # noqa: BLE001
        print(f"[ydl] failed for {page_url} (referer={referer}, cookies={bool(cookies)}): {str(e)[:200]}")
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
    response = _to_response(info)
    # Title / thumbnail / duration are useful for web UIs that preview before
    # download. Extract once; cheap to include.
    response["title"]     = info.get("title")
    response["thumbnail"] = info.get("thumbnail")
    response["duration"]  = info.get("duration")

    if response.get("kind") == "paired":
        rf = info.get("requested_formats", [{}, {}])
        print(f"[extract] paired: video={rf[0].get('format_id')} audio={rf[1].get('format_id')} {response.get('label')}")
    else:
        print(f"[extract] {response.get('kind')}: itag={info.get('format_id')} {response.get('label')}")

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


def _download_headers(referer: str | None, cookies: str | None) -> dict[str, str]:
    headers: dict[str, str] = {}
    if referer:
        headers["Referer"] = referer
    if cookies:
        headers["Cookie"] = cookies
    return headers


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
) -> StreamingResponse:
    info = _run_ydl(url, referer=referer)
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
    if kind == "paired":
        return StreamingResponse(
            _ffmpeg_stream(response["videoUrl"], response["audioUrl"], None),
            media_type="video/mp4", headers=headers,
        )
    if kind == "hls":
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"]),
            media_type="video/mp4", headers=headers,
        )
    # kind == "direct" → already a single mp4, redirect the browser straight to
    # googlevideo (saves server bandwidth — 100% of the bytes go phone↔CDN).
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
    request_headers = _download_headers(req.referer, req.cookies)

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

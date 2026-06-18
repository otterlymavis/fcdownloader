"""
fcdownloader-extractor — FastAPI entry point.

Architecture:
  config.py      — environment configuration
  models.py      — Pydantic request/response models + ErrorCode enum
  registry.py    — per-site extractor capability profiles
  classifier.py  — URL risk/capability analysis
  auth.py        — SessionAuthManager (cookie security)
  telemetry.py   — per-request structured logging
  extractors.py  — platform-specific extractors (Meta/Weibo)
  strategies.py  — ExtractionStrategyEngine + ordered fallback pipeline
  supervisor.py  — StreamSupervisor (blocking yt-dlp download + cleanup)
  utils.py       — pure utility functions (no side effects)
  main.py        — thin FastAPI routes (this file)

Endpoint summary:
  GET  /                → health check
  GET  /version         → service + yt-dlp + ffmpeg versions
  POST /extract         → resolve media URL(s) for a page
  GET  /download        → stream server-muxed mp4 to client
  POST /download        → stream server-muxed mp4 (with more options)
  GET  /ytdl-stream     → server-side yt-dlp download proxy for hard formats
  POST /playlist        → flat item list for a playlist URL
  GET  /proxy           → stream a CDN media URL with auth headers
  GET  /debug           → diagnostic endpoint (requires TRUSTED_TOKEN)
"""
from __future__ import annotations

import http.client
import base64
import hashlib
import ipaddress
import json
import os
import re
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Iterator

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from yt_dlp import YoutubeDL
from yt_dlp.version import __version__ as YT_DLP_VERSION

import auth
import extractors
import source_audit
import languages
import registry
import supervisor
import universal
from config import (
    ALLOWED_ORIGINS,
    CACHE_MAX,
    CACHE_TTL,
    COOKIES_FILE,
    FORMAT_SPEC,
    MOBILE_UA,
    RATE_LIMIT,
    STREAM_STALL_TIMEOUT,
    TRUSTED_TOKEN,
)
from models import DownloadRequest, ExtractRequest, PlaylistRequest, ProxyRequest
from strategies import run_extraction, run_extraction_with_format
from telemetry import make_context
from utils import (
    UTF8_ENV,
    cache_key,
    configure_utf8_runtime,
    content_disposition,
    content_disposition_any,
    expire_of,
    guess_ext_from_url,
    looks_like_hls,
    normalize_url,
    request_cache_key,
    safe_ascii_filename,
    safe_header_value,
    safe_headers,
    safe_text,
    url_quote,
)

# ── Runtime setup ─────────────────────────────────────────────────────────────

configure_utf8_runtime()


# ── UTF-8 JSON response ───────────────────────────────────────────────────────

class UTF8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", errors="replace")


# ── Client IP (for rate limiting) ─────────────────────────────────────────────

def _client_ip(request: Request) -> str:
    hdr = request.headers
    for key in ("Fly-Client-IP", "CF-Connecting-IP", "X-Real-IP"):
        v = hdr.get(key)
        if v:
            return v.strip()
    xff = hdr.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── App + middleware ──────────────────────────────────────────────────────────

limiter = Limiter(key_func=_client_ip)
app = FastAPI(
    title="fcdownloader-extractor",
    version="3.0",
    default_response_class=UTF8JSONResponse,
)
BACKEND_API_VERSION = "v1"
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={
            "detail": {
                "message": f"Rate limit exceeded ({exc.detail}). Please wait before retrying.",
                "error_code": "RATE_LIMITED",
            }
        },
    )

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)

_extension_origin_regex = r"^(chrome|moz|safari-web|edge)-extension://[a-zA-Z0-9_-]+$"
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=_extension_origin_regex,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-FCDL-Cookies"],
    expose_headers=["Content-Disposition", "Content-Length", "X-Request-ID"],
)

# ── Startup version log ───────────────────────────────────────────────────────

def _log_startup_versions() -> None:
    try:
        import subprocess as _sp
        ffmpeg_line = _sp.check_output(
            ["ffmpeg", "-version"], text=True, stderr=_sp.DEVNULL
        ).split("\n")[0]
    except Exception:
        ffmpeg_line = "not found"
    print(f"[startup] yt-dlp={YT_DLP_VERSION} | {ffmpeg_line}", flush=True)

_log_startup_versions()


# ── Cache ─────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _cache_get(key: str) -> dict[str, Any] | None:
    import time
    entry = _cache.get(key)
    if not entry:
        return None
    ts, val = entry
    if time.time() - ts > CACHE_TTL:
        _cache.pop(key, None)
        return None
    return val


def _cache_put(key: str, val: dict[str, Any]) -> None:
    import time
    if len(_cache) >= CACHE_MAX:
        for k in list(_cache.keys())[: CACHE_MAX // 10]:
            _cache.pop(k, None)
    _cache[key] = (time.time(), val)


# ── Response shaping ──────────────────────────────────────────────────────────

_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "heic"}
_UNIVERSAL_PAGE_FETCH_TIMEOUT = 8


def _without_thumbnail_fields(item: dict[str, Any]) -> dict[str, Any]:
    cleaned = item.copy()
    cleaned.pop("thumbnail", None)
    return cleaned


def _headers_for(f: dict[str, Any]) -> dict[str, str]:
    h = (f.get("http_headers") or {}).copy()
    h.pop("Authorization", None)
    h.pop("authorization", None)
    h.pop("Cookie", None)
    h.pop("cookie", None)
    return safe_headers(h)


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
        "mpd": "application/dash+xml",
        "m4a": "audio/mp4",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mkv": "video/x-matroska",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "gif": "image/gif",
        "avif": "image/avif",
        "heic": "image/heic",
    }.get(ext, f"video/{ext}")


def _format_options(info: dict[str, Any]) -> list[dict[str, Any]]:
    formats = info.get("formats") or []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for f in formats:
        if not isinstance(f, dict):
            continue
        fid = safe_text(f.get("format_id"))
        if not fid or fid in seen:
            continue
        seen.add(fid)
        out.append({
            "id":             fid,
            "label":          _label_for(f) or f.get("format"),
            "ext":            f.get("ext"),
            "protocol":       f.get("protocol"),
            "width":          f.get("width"),
            "height":         f.get("height"),
            "resolution":     f.get("resolution"),
            "fps":            f.get("fps"),
            "vcodec":         f.get("vcodec"),
            "acodec":         f.get("acodec"),
            "filesize":       f.get("filesize"),
            "filesizeApprox": f.get("filesize_approx"),
        })
    return out


def _safe_source_audit(raw: Any, limit: int = 300) -> list[dict[str, Any]]:
    return source_audit.sanitize_audit(raw, limit=limit)


def _attach_source_audit(
    response: dict[str, Any],
    info: dict[str, Any] | None,
    request_audit: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    audit = _safe_source_audit(request_audit)
    audit.extend(_safe_source_audit((info or {}).get("_source_audit")))
    audit = _safe_source_audit(audit)
    if audit:
        response["sourceAudit"] = audit
    return response


def _localize_ytdl_stream_urls(response: dict[str, Any], request: Request) -> dict[str, Any]:
    """Return same-server ytdl-stream URLs for the current request host."""
    base = str(request.base_url).rstrip("/")
    # Fly.io terminates TLS at the edge and forwards to the app over plain HTTP,
    # so request.base_url always carries scheme="http". Honour x-forwarded-proto
    # (set by Fly's proxy) to rewrite the scheme to "https" when appropriate.
    request_headers = getattr(request, "headers", {}) or {}
    forwarded_scheme = request_headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    if forwarded_scheme in ("https", "http"):
        parsed_base = urllib.parse.urlparse(base)
        base = urllib.parse.urlunparse((forwarded_scheme,) + parsed_base[1:])

    def localize(value: Any) -> Any:
        if not isinstance(value, str) or "/ytdl-stream?" not in value:
            return value
        parsed = urllib.parse.urlparse(value)
        if parsed.path != "/ytdl-stream":
            return value
        return urllib.parse.urlunparse((
            urllib.parse.urlparse(base).scheme,
            urllib.parse.urlparse(base).netloc,
            parsed.path,
            parsed.params,
            parsed.query,
            parsed.fragment,
        ))

    localized = dict(response)
    for key in ("url", "videoUrl", "audioUrl"):
        if key in localized:
            localized[key] = localize(localized[key])
    return localized


def _is_public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _assert_public_http_url(url: str) -> str:
    url = normalize_url(url)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "url must be absolute public http(s)")

    host = parsed.hostname
    try:
        ip = ipaddress.ip_address(host)
        if not _is_public_ip(str(ip)):
            raise HTTPException(400, "private-network URLs are not allowed")
        return url
    except ValueError:
        pass

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(400, f"could not resolve host: {safe_text(exc)[:120]}")

    resolved = {info[4][0] for info in infos}
    if not resolved or any(not _is_public_ip(ip) for ip in resolved):
        raise HTTPException(400, "private-network URLs are not allowed")
    return url


class _PublicHTTPRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        _assert_public_http_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_PUBLIC_URL_OPENER = urllib.request.build_opener(_PublicHTTPRedirectHandler)


def _urlopen_public(req_or_url: urllib.request.Request | str, timeout: float) -> Any:
    target = req_or_url.full_url if isinstance(req_or_url, urllib.request.Request) else req_or_url
    _assert_public_http_url(target)
    return _PUBLIC_URL_OPENER.open(req_or_url, timeout=timeout)


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
            "width":         video.get("width"),
            "height":        video.get("height"),
            "mimeType":      _mime_for(video),
            "audioMimeType": _mime_for(audio),
            "expire":        expire_of(video["url"]),
            "extractor":     info.get("extractor"),
            "formatId":      "+".join([
                safe_text(video.get("format_id")),
                safe_text(audio.get("format_id")),
            ]).strip("+"),
            "formats":       _format_options(info),
            "thumbnail":     info.get("thumbnail"),
        }

    url = info.get("url")
    if not url:
        raise HTTPException(502, "yt-dlp info had no url")

    ext = (info.get("ext") or guess_ext_from_url(url) or "").lower()
    if ext in _IMAGE_EXTS:
        return {
            "kind":      "image",
            "url":       url,
            "headers":   _headers_for(info),
            "label":     _label_for(info),
            "width":     info.get("width"),
            "height":    info.get("height"),
            "mimeType":  _mime_for({**info, "ext": ext}),
            "expire":    expire_of(url),
            "extractor": info.get("extractor"),
            "formatId":  info.get("format_id"),
            "formats":   _format_options(info),
            "thumbnail": info.get("thumbnail"),
        }

    if ext == "mpd" or safe_text(info.get("protocol")).lower() == "http_dash_segments":
        return {
            "kind":      "dash",
            "url":       url,
            "headers":   _headers_for(info),
            "label":     _label_for(info),
            "width":     info.get("width"),
            "height":    info.get("height"),
            "mimeType":  "application/dash+xml",
            "expire":    expire_of(url),
            "extractor": info.get("extractor"),
            "formatId":  info.get("format_id"),
            "formats":   _format_options(info),
            "thumbnail": info.get("thumbnail"),
        }

    if looks_like_hls(url, info.get("protocol")):
        return {
            "kind":      "hls",
            "url":       url,
            "headers":   _headers_for(info),
            "label":     _label_for(info),
            "width":     info.get("width"),
            "height":    info.get("height"),
            "mimeType":  "application/x-mpegURL",
            "expire":    expire_of(url),
            "extractor": info.get("extractor"),
            "formatId":  info.get("format_id"),
            "formats":   _format_options(info),
            "thumbnail": info.get("thumbnail"),
        }

    return {
        "kind":      "direct",
        "url":       url,
        "headers":   _headers_for(info),
        "label":     _label_for(info),
        "width":     info.get("width"),
        "height":    info.get("height"),
        "mimeType":  _mime_for(info),
        "expire":    expire_of(url),
        "extractor": info.get("extractor"),
        "formatId":  info.get("format_id"),
        "formats":   _format_options(info),
        "thumbnail": info.get("thumbnail"),
    }


def _to_gallery_response(info: dict[str, Any]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for entry in info.get("entries") or []:
        if not entry:
            continue
        if entry.get("requested_formats") and len(entry["requested_formats"]) == 2:
            video, audio = entry["requested_formats"]
            if video.get("vcodec") == "none" and audio.get("vcodec") != "none":
                video, audio = audio, video
            items.append(_without_thumbnail_fields({
                "kind":      "paired",
                "videoUrl":  video["url"],
                "audioUrl":  audio["url"],
                "headers":   _headers_for(video),
                "label":     _label_for(video),
                "width":     video.get("width"),
                "height":    video.get("height"),
                "ext":       video.get("ext") or "mp4",
                "title":     entry.get("title"),
                "duration":  entry.get("duration"),
                "extractor": entry.get("extractor"),
                "formatId":  "+".join([
                    safe_text(video.get("format_id")),
                    safe_text(audio.get("format_id")),
                ]).strip("+"),
            }))
            continue

        url = entry.get("url")
        if not url and entry.get("formats"):
            usable_formats = [
                f for f in entry["formats"]
                if isinstance(f, dict) and f.get("url")
            ]
            picked = max(
                usable_formats,
                key=lambda f: (
                    int(f.get("height") or 0),
                    int(f.get("width") or 0),
                    int(f.get("tbr") or f.get("abr") or 0),
                ),
                default={},
            )
            if picked:
                entry = {**entry, **picked}
            url = entry.get("url")
        if not url:
            continue

        ext = (entry.get("ext") or guess_ext_from_url(url) or "").lower()
        is_image = ext in _IMAGE_EXTS
        items.append(_without_thumbnail_fields({
            "kind":      "image" if is_image else ("dash" if ext == "mpd" or safe_text(entry.get("protocol")).lower() == "http_dash_segments" else ("hls" if looks_like_hls(url, entry.get("protocol")) else "direct")),
            "url":       url,
            "headers":   _headers_for(entry),
            "label":     _label_for(entry),
            "width":     entry.get("width"),
            "height":    entry.get("height"),
            "ext":       ext or ("mp4" if not is_image else "jpg"),
            "mimeType":  _mime_for({**entry, "ext": ext or "jpg"}) if is_image else ("application/dash+xml" if ext == "mpd" else _mime_for(entry)),
            "title":     entry.get("title"),
            "duration":  entry.get("duration"),
            "extractor": entry.get("extractor"),
            "formatId":  entry.get("format_id"),
        }))

    return {"kind": "gallery", "items": items, "count": len(items)}


# ── Download helpers ──────────────────────────────────────────────────────────

_HEADERED_DIRECT_HOSTS = (
    "bilibili.com", "bilivideo.com",
    "instagram.com", "cdninstagram.com", "fbcdn.net", "threadscdn.com",
    "weibo.com", "weibo.cn", "sinaimg.cn", "weibocdn.com",
    "xiaohongshu.com", "rednote.com", "xhscdn.com",
    "naver.com", "naver.net", "pstatic.net",
    "mdpr.jp", "modelpress.jp",
    "ameblo.jp", "ameba.jp", "stat.ameba.jp",
    "natalie.mu", "oricon.co.jp", "kstyle.com",
    "tistory.com", "daum.net", "kakao.com", "kakaocdn.net",
    "livedoor.jp", "livedoor.blog", "livedoor.blogimg.jp",
    "yimg.jp", "pximg.net", "pixiv.net", "fanbox.cc",
    "biliimg.com", "hdslb.com",
    "bunshun.jp", "dailyshincho.jp", "news-postseven.com", "josei7.com",
    "kodansha.co.jp", "gendai.media", "hpplus.jp", "fashion-press.net",
    "fashionsnap.com", "wwdjapan.com", "thetv.jp", "mantan-web.jp",
    "crank-in.net", "cinematoday.jp", "eiga.com", "realsound.jp",
    "spice.eplus.jp", "jprime.jp", "smart-flash.jp", "flash.jp",
    "nikkan-gendai.com", "asagei.com", "entamenext.com", "girlsnews.tv",
    "tokyo-sports.co.jp", "hochi.news", "sponichi.co.jp", "nikkansports.com",
    "sanspo.com", "mainichi.jp", "asahi.com", "yomiuri.co.jp", "sankei.com",
    "tokyo-np.co.jp", "kyodo.co.jp", "47news.jp", "jiji.com", "itmedia.co.jp",
    "impress.co.jp", "mynavi.jp", "ascii.jp", "gigazine.net",
    "lemino.docomo.ne.jp", "animestore.docomo.ne.jp", "video.dmkt-sp.jp",
    "unext.jp", "video.unext.jp", "hulu.jp", "telasa.jp",
    "plus.nhk.jp", "nhk-ondemand.jp", "wowow.co.jp", "wod.wowow.co.jp",
    "b-ch.com", "bandainamcoid.com", "tv.rakuten.co.jp",
    "jod.jsports.co.jp", "jsports.co.jp", "spoox.skyperfectv.co.jp",
    "skyperfectv.co.jp", "locipo.jp", "dougaizm.mbs.jp", "mbs.jp",
    "ytv.co.jp", "video.tv-tokyo.co.jp", "douga.tv-asahi.co.jp",
    "ktv-smart.jp", "ktv.jp", "vod.ntv.co.jp", "cu.ntv.co.jp",
)

_SINA_CDN_SUFFIXES = ("sinaimg.cn", "weibocdn.com")
_DOH_CDN_SUFFIXES = _SINA_CDN_SUFFIXES + ("naver.net", "pstatic.net")
_REPLAY_HEADER_ALLOW = {
    "accept",
    "accept-language",
    "origin",
    "range",
    "referer",
    "user-agent",
}

_MEDIA_HINT_HOST_RE = re.compile(
    r"(?:\.m3u8?|\.mpd|\.mp4|\.m4v|\.webm|\.mov|\.mp3|\.m4a|\.aac|\.wav|\.ogg|\.opus|\.flac)(?:[?#]|$)|"
    r"(?:v\.redd\.it|cdninstagram\.com|fbcdn\.net|threadscdn\.com|bilivideo\.com|xhscdn\.com|"
    r"kakaocdn\.net|daumcdn\.net|pstatic\.net|naver\.net|abema(?:tv)?\.akamaized\.net|"
    r"brightcove\.net|boltdns\.net|bcovlive-a\.akamaihd\.net|bcovlive\.io|akamaihd\.net|"
    r"akamaized\.net|vod-abematv|linear-abematv|nimg\.jp|dmc\.nico|yimg\.jp|"
    r"gyao\.yahoo\.co\.jp|fod-sp\.fujitv\.co\.jp|streaming\.yahoo\.co\.jp|"
    r"tver\.jp|tver\.co\.jp|(?:[a-z0-9-]+\.)*streaks\.jp|i\.fod\.fujitv\.co\.jp|"
    r"free\.tbs\.co\.jp|dmm\.co\.jp|dmm\.com|fanza\.jp|lemino\.docomo\.ne\.jp|"
    r"animestore\.docomo\.ne\.jp|video\.dmkt-sp\.jp|unext\.jp|video\.unext\.jp|"
    r"hulu\.jp|telasa\.jp|plus\.nhk\.jp|nhk-ondemand\.jp|wowow\.co\.jp|"
    r"wod\.wowow\.co\.jp|b-ch\.com|bandainamcoid\.com|tv\.rakuten\.co\.jp|"
    r"jod\.jsports\.co\.jp|jsports\.co\.jp|spoox\.skyperfectv\.co\.jp|"
    r"skyperfectv\.co\.jp|locipo\.jp|dougaizm\.mbs\.jp|mbs\.jp|ytv\.co\.jp|"
    r"video\.tv-tokyo\.co\.jp|douga\.tv-asahi\.co\.jp|ktv-smart\.jp|ktv\.jp|"
    r"vod\.ntv\.co\.jp|cu\.ntv\.co\.jp|edgekey\.net|edgesuite\.net|hdslb\.com|biliimg\.com)",
    re.I,
)
_MEDIA_HINT_MIME_RE = re.compile(
    r"^(?:video/|audio/|image/|application/(?:dash\+xml|x-mpegdash\+xml|vnd\.apple\.mpegurl|x-mpegurl))",
    re.I,
)
_NON_MEDIA_HINT_MIME_RE = re.compile(
    r"^(?:text/html|text/plain|text/css|application/(?:json|javascript|x-javascript|xml))",
    re.I,
)


def _decode_replay_headers(encoded: str | None) -> dict[str, str]:
    if not encoded:
        return {}
    raw = safe_text(encoded).strip()
    if not raw or len(raw) > 16_384:
        return {}
    try:
        padded = raw + ("=" * (-len(raw) % 4))
        data = base64.urlsafe_b64decode(padded.encode("ascii"))
        parsed = json.loads(data.decode("utf-8", errors="strict"))
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    allowed: dict[str, str] = {}
    for key, value in parsed.items():
        name = safe_text(key).strip()
        if name.lower() not in _REPLAY_HEADER_ALLOW:
            continue
        allowed[name] = safe_text(value)
    return safe_headers(allowed)


def _direct_media_url_kind(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower()
    host = (parsed.hostname or "").lower()
    if looks_like_hls(url, None) or path.endswith((".m3u", ".m3u8")):
        return "hls"
    if path.endswith((".mp4", ".m4v", ".webm", ".mov", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac")):
        return "direct"
    if any(h in host for h in (
        "cdninstagram.com", "fbcdn.net", "threadscdn.com",
        "video.twimg.com", "tiktokcdn.com", "tiktokcdn-us.com",
        "weibocdn.com", "xhscdn.com", "akamaized.net", "cloudfront.net",
        "jwpcdn.com", "jwplatform.com", "kaltura.com", "mux.com", "mux.dev",
    )):
        return "direct"
    return ""


def _media_hint_kind(url: str, mime_type: str, raw_kind: str = "") -> str:
    kind = raw_kind.lower()
    if kind in {"dash", "hls", "audio", "image", "video", "direct"}:
        return kind
    if "dash+xml" in mime_type.lower() or "x-mpegdash" in mime_type.lower():
        return "dash"
    if "mpegurl" in mime_type.lower() or "m3u8" in mime_type.lower():
        return "hls"
    if mime_type.lower().startswith("audio/"):
        return "audio"
    if mime_type.lower().startswith("image/"):
        return "image"
    if mime_type.lower().startswith("video/"):
        return "video"
    return _direct_media_url_kind(url) or "direct"


def _media_hint_ext(url: str, kind: str, mime_type: str) -> str:
    ext = guess_ext_from_url(url)
    if ext:
        return ext
    lower = mime_type.lower()
    if kind == "dash":
        return "mpd"
    if kind == "hls":
        return "m3u8"
    if kind == "audio":
        if "mpeg" in lower or "mp3" in lower:
            return "mp3"
        if "ogg" in lower or "opus" in lower:
            return "ogg"
        if "wav" in lower:
            return "wav"
        return "m4a"
    if kind == "image":
        if "png" in lower:
            return "png"
        if "webp" in lower:
            return "webp"
        if "gif" in lower:
            return "gif"
        return "jpg"
    if "webm" in lower:
        return "webm"
    return "mp4"


def _media_hint_supported(url: str, mime_type: str) -> bool:
    if _MEDIA_HINT_HOST_RE.search(url):
        return True
    if not mime_type or _NON_MEDIA_HINT_MIME_RE.search(mime_type):
        return False
    return bool(_MEDIA_HINT_MIME_RE.search(mime_type))


def _accept_language_for_url(url: str) -> str:
    """Return a sensible Accept-Language value based on the URL's hostname TLD."""
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return "en-US,en;q=0.9"
    if re.search(r"(?:^|\.)(?:jp|co\.jp|ne\.jp|or\.jp|ac\.jp)$", host, re.I):
        return "ja-JP,ja;q=0.9,en;q=0.5"
    if re.search(r"(?:^|\.)(?:kr|co\.kr)$", host, re.I):
        return "ko-KR,ko;q=0.9,en;q=0.5"
    if re.search(r"(?:^|\.)(?:cn|com\.cn|net\.cn|org\.cn)$", host, re.I):
        return "zh-CN,zh;q=0.9,en;q=0.5"
    if re.search(r"(?:^|\.)(?:tw|com\.tw|net\.tw)$", host, re.I):
        return "zh-TW,zh;q=0.9,en;q=0.5"
    return "en-US,en;q=0.9"


def _fetch_page_content(req: ExtractRequest) -> tuple[str | None, str, str | None]:
    """Fetch the request URL and return (decoded_text, content_type, link_header).

    Returns (None, '', None) on failure.  link_header is the raw HTTP Link:
    response header value (used for feed auto-discovery on podcast hosts that
    don't include <link rel="alternate"> in their HTML).
    """
    req.pageUrl = _assert_public_http_url(req.pageUrl)
    if not universal.should_fetch_page_html(req.pageUrl):
        return None, "", None
    headers = safe_headers({
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,*/*;q=0.2",
        "Accept-Language": _accept_language_for_url(req.pageUrl),
    })
    if req.referer:
        headers["Referer"] = safe_header_value("Referer", req.referer)
    if req.cookies:
        headers["Cookie"] = safe_header_value("Cookie", req.cookies)
    for _attempt in range(2):
        try:
            request = urllib.request.Request(req.pageUrl, headers=headers, method="GET")
            with _urlopen_public(request, timeout=_UNIVERSAL_PAGE_FETCH_TIMEOUT) as resp:
                status = int(getattr(resp, "status", 200) or 200)
                if status >= 400:
                    return None, "", None
                content_type = getattr(resp, "headers", {}).get("Content-Type", "") or ""
                link_header = getattr(resp, "headers", {}).get("Link", None)
                # Content-Disposition: attachment; filename="video.mp4" — treat
                # as binary even when Content-Type is application/octet-stream.
                cd = getattr(resp, "headers", {}).get("Content-Disposition", "") or ""
                if re.search(r"\battachment\b", cd, re.I) and not re.match(r"^(?:video|audio)/", content_type, re.I):
                    _cd_filename = re.search(r'filename[*]?=(?:UTF-8\'\')?["\']?([^"\';\s]+)', cd, re.I)
                    if _cd_filename:
                        _cd_ext = guess_ext_from_url(_cd_filename.group(1).strip('"\'')).lower()
                        if _cd_ext in {"mp4", "m4v", "webm", "mov", "avi", "mkv", "flv", "mpg", "mpeg",
                                       "mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"}:
                            _cd_kind = "audio" if _cd_ext in {"mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"} else "video"
                            content_type = f"{_cd_kind}/{_cd_ext}"
                max_bytes = max(universal.PAGE_FETCH_MAX_BYTES, 2_000_000)
                body = resp.read(max_bytes + 1)
                if len(body) > max_bytes:
                    return None, content_type, link_header
                return body.decode(universal.charset_from_content_type(content_type), errors="replace"), content_type, link_header
        except Exception:
            if _attempt == 0:
                continue
            return None, "", None
    return None, "", None


def _fetch_universal_page_html(req: ExtractRequest) -> str | None:
    text, ct, _lh = _fetch_page_content(req)
    return text if text and universal.is_htmlish_content_type(ct) else None


def _info_from_media_hints(page_url: str, hints: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    entries: list[dict[str, Any]] = []
    audit: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in hints or []:
        if not isinstance(raw, dict):
            continue
        url = normalize_url(safe_text(raw.get("url")))
        mime_type = safe_text(raw.get("mimeType"))
        if not url.startswith(("http://", "https://")):
            audit.append({"strategy": "browser-capture", "source": "mediaHints", "url": url, "selected": False, "rejectedReason": "not an http(s) URL"})
            continue
        if not _media_hint_supported(url, mime_type):
            audit.append({"strategy": "browser-capture", "source": "mediaHints", "url": url, "selected": False, "rejectedReason": "not a supported media URL"})
            continue
        if url in seen:
            continue
        seen.add(url)
        kind = _media_hint_kind(url, mime_type, safe_text(raw.get("kind")))
        if kind == "dash":
            protocol = "http_dash_segments"
        elif kind == "hls" or looks_like_hls(url, None):
            protocol = "m3u8"
        else:
            protocol = "https"
        headers = safe_headers(raw.get("headers") or {})
        if raw.get("referer") and "Referer" not in headers:
            headers["Referer"] = safe_text(raw.get("referer"))
        entries.append({
            "id": cache_key(url),
            "title": safe_text(raw.get("title")) or "Captured media",
            "url": url,
            "webpage_url": page_url,
            "ext": _media_hint_ext(url, kind, mime_type),
            "protocol": protocol,
            "http_headers": headers,
            "extractor": "browser-captured",
        })
        audit.append({"strategy": "browser-capture", "source": "mediaHints", "url": url, "selected": True, "kind": kind})
        if len(entries) >= 20:
            break
    if not entries:
        return None
    if len(entries) == 1:
        entries[0]["_source_audit"] = audit
        return entries[0]
    return {
        "_type": "playlist",
        "title": "Captured media",
        "webpage_url": page_url,
        "extractor": "browser-captured",
        "entries": entries,
        "_source_audit": audit,
    }


def _needs_headered_direct_stream(
    page_url: str, media_url: str, headers: dict[str, str]
) -> bool:
    combined = f"{page_url} {media_url}".lower()
    if headers.get("Cookie"):
        return True
    return any(host in combined for host in _HEADERED_DIRECT_HOSTS)


def _download_headers(
    referer: str | None, cookies: str | None, page_url: str | None = None
) -> dict[str, str]:
    headers: dict[str, str] = {}
    if referer:
        headers["Referer"] = normalize_url(referer)
    elif page_url and ("bilibili.com" in page_url or "bilivideo.com" in page_url):
        headers["Referer"] = "https://www.bilibili.com/"
        headers["Origin"]  = "https://www.bilibili.com"
    elif page_url and any(h in page_url for h in ("weibo.com", "weibo.cn", "weibocdn.com")):
        headers["Referer"] = "https://weibo.com/"
        headers["Origin"]  = "https://weibo.com"
    elif page_url and any(h in page_url for h in ("xiaohongshu.com", "rednote.com", "xhscdn.com")):
        headers["Referer"] = "https://www.xiaohongshu.com/"
        headers["Origin"]  = "https://www.xiaohongshu.com"
    elif page_url and "blog.naver.com" in page_url:
        headers["Referer"] = "https://blog.naver.com/"
        headers["Origin"]  = "https://blog.naver.com"
    elif page_url and any(h in page_url for h in ("news.naver.com", "entertain.naver.com", "sports.news.naver.com", "m.sports.naver.com")):
        headers["Referer"] = "https://news.naver.com/"
        headers["Origin"]  = "https://news.naver.com"
    elif page_url and any(h in page_url for h in ("naver.com", "naver.net", "pstatic.net", "naver.me")):
        headers["Referer"] = "https://tv.naver.com/"
        headers["Origin"]  = "https://tv.naver.com"
    elif page_url and any(h in page_url for h in ("mdpr.jp", "modelpress.jp")):
        headers["Referer"] = "https://mdpr.jp/"
        headers["Origin"]  = "https://mdpr.jp"
    elif page_url and any(h in page_url for h in ("pixiv.net", "fanbox.cc", "pximg.net")):
        headers["Referer"] = "https://www.pixiv.net/"
    elif page_url and any(h in page_url for h in ("bilibili.com", "biliimg.com", "hdslb.com")):
        headers["Referer"] = "https://www.bilibili.com/"
        headers["Origin"]  = "https://www.bilibili.com"
    elif page_url and any(h in page_url for h in ("tistory.com", "daum.net", "kakao.com", "kakaocdn.net")):
        headers["Referer"] = "https://www.daum.net/"
        headers["Origin"]  = "https://www.daum.net"
    elif page_url and any(h in page_url for h in ("ameblo.jp", "ameba.jp", "natalie.mu", "oricon.co.jp", "kstyle.com", "livedoor.jp", "livedoor.blog", "yahoo.co.jp", "yimg.jp")):
        headers["Referer"] = normalize_url(page_url)
    elif page_url and registry.is_japanese_domain(page_url):
        headers["Referer"] = normalize_url(page_url)
    if cookies:
        headers["Cookie"] = safe_text(cookies)
    return safe_headers(headers)


def _ffmpeg_header_arg(headers: dict[str, str] | None) -> str | None:
    safe = safe_headers(headers)
    if not safe:
        return None
    return "".join(f"{k}: {v}\r\n" for k, v in safe.items() if v)


def _ffmpeg_stream(
    video_url: str,
    audio_url: str | None,
    hls_master: str | None,
    request_headers: dict[str, str] | None = None,
    *,
    request_id: str | None = None,
) -> Iterator[bytes]:
    """Mux video+audio (or remux HLS) via ffmpeg and yield output as chunks.

    Hardening:
      - stderr captured in a drain thread (prevents pipe-buffer deadlock and
        surfaces ffmpeg error messages in server logs on failure).
      - Process runs in its own process group on POSIX so _kill_process_tree()
        reaches the full subprocess tree on disconnect or stall.
      - Stall watchdog kills ffmpeg if no bytes arrive for STREAM_STALL_TIMEOUT
        seconds (CDN hang, codec stall, expired stream URL).
      - Structured log on exit: bytes_sent, duration_ms, rc, stderr_tail,
        disconnect_reason.
    """
    ff_headers = _ffmpeg_header_arg(request_headers)
    input_header_args = ["-headers", ff_headers] if ff_headers else []
    video_url  = normalize_url(video_url) if video_url else video_url
    audio_url  = normalize_url(audio_url) if audio_url else audio_url
    hls_master = normalize_url(hls_master) if hls_master else hls_master

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

    rid = request_id or uuid.uuid4().hex[:12]
    print(f"[ffmpeg] rid={rid} " + shlex.join(args[:12]) + " ...")

    popen_kwargs: dict = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,   # capture; DEVNULL silenced errors entirely
        "bufsize": 0,
        "env": UTF8_ENV,
    }
    if sys.platform != "win32":
        popen_kwargs["preexec_fn"] = os.setsid  # own process group

    proc = subprocess.Popen(args, **popen_kwargs)

    # Drain stderr in a background thread to prevent pipe-buffer deadlock.
    # ffmpeg writes to stderr on errors even at -loglevel error.
    _stderr_lines: list[str] = []

    def _drain_stderr() -> None:
        try:
            assert proc.stderr is not None
            for raw in iter(proc.stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace").rstrip()
                _stderr_lines.append(line)
                if len(_stderr_lines) > 50:
                    _stderr_lines.pop(0)
        except Exception:
            pass

    _stderr_thread = threading.Thread(
        target=_drain_stderr, daemon=True, name=f"ffmpeg-stderr-{rid}",
    )
    _stderr_thread.start()

    # Stall watchdog: kill ffmpeg if it stops writing bytes.
    _last_chunk: list[float] = [time.monotonic()]
    _kill_evt = threading.Event()

    def _stall_watch() -> None:
        while not _kill_evt.wait(timeout=5.0):
            elapsed = time.monotonic() - _last_chunk[0]
            if elapsed > STREAM_STALL_TIMEOUT:
                print(
                    f"[ffmpeg] rid={rid} stall detected ({elapsed:.0f}s without output) — killing",
                    flush=True,
                )
                if sys.platform != "win32":
                    try:
                        _sigkill = getattr(signal, "SIGKILL", signal.SIGTERM)
                        pgid = os.getpgid(proc.pid)
                        os.killpg(pgid, _sigkill)
                    except Exception:
                        pass
                else:
                    proc.kill()
                break

    _watchdog_thread = threading.Thread(
        target=_stall_watch, daemon=True, name=f"ffmpeg-stall-{rid}",
    )
    _watchdog_thread.start()

    t0 = time.monotonic()
    bytes_sent: int = 0
    disconnect_reason: str | None = None

    try:
        while True:
            chunk = proc.stdout.read(64 * 1024) if proc.stdout else b""
            if not chunk:
                break
            _last_chunk[0] = time.monotonic()
            bytes_sent += len(chunk)
            yield chunk
    except GeneratorExit:
        disconnect_reason = "client disconnected"
        raise
    except Exception as exc:
        disconnect_reason = f"{type(exc).__name__}: {str(exc)[:80]}"
        raise
    finally:
        _kill_evt.set()

        if proc.poll() is None:
            if sys.platform != "win32":
                try:
                    pgid = os.getpgid(proc.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except Exception:
                    pass
            else:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

        _stderr_thread.join(timeout=2.0)

        duration_ms = (time.monotonic() - t0) * 1000
        stderr_tail = " | ".join(_stderr_lines[-5:]) if _stderr_lines else ""
        print(
            f"[ffmpeg] rid={rid} done: "
            f"bytes={bytes_sent:,} duration={duration_ms:.0f}ms "
            f"rc={proc.returncode} disconnect={disconnect_reason or 'none'}"
            + (f" stderr={stderr_tail!r}" if stderr_tail else ""),
            flush=True,
        )


def _youtube_video_id(page_url: str) -> str | None:
    m = re.search(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})", page_url)
    return m.group(1) if m else None


def _cookie_header_from_netscape_file(path: str | None, host_hint: str = "youtube") -> str | None:
    if not path or not os.path.exists(path):
        return None
    pairs: list[str] = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                cols = line.split("\t")
                if len(cols) < 7:
                    continue
                domain, _flag, _path, _secure, _expiry, name, value = cols[:7]
                if host_hint in domain and name and value:
                    pairs.append(f"{name}={value}")
    except Exception:
        return None
    return "; ".join(pairs) if pairs else None


def _youtube_android_streams(
    page_url: str,
    max_height: int = 1080,
    cookies: str | None = None,
) -> dict[str, Any]:
    video_id = _youtube_video_id(page_url)
    if not video_id:
        raise HTTPException(400, "invalid YouTube URL")

    client_version = "20.10.38"
    ua = "com.google.android.youtube/20.10.38 (Linux; U; Android 13) gzip"
    body = {
        "videoId": video_id,
        "context": {
            "client": {
                "hl": "en",
                "gl": "US",
                "clientName": "ANDROID",
                "clientVersion": client_version,
                "androidSdkVersion": 33,
                "osName": "Android",
                "osVersion": "13",
                "platform": "MOBILE",
                "utcOffsetMinutes": 0,
            },
        },
    }
    req_headers = {
        "Content-Type": "application/json",
        "User-Agent": ua,
        "X-Youtube-Client-Name": "3",
        "X-Youtube-Client-Version": client_version,
        "Origin": "https://www.youtube.com",
        "Referer": f"https://www.youtube.com/watch?v={video_id}",
    }
    if cookies:
        req_headers["Cookie"] = safe_text(cookies)

    req = urllib.request.Request(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        data=json.dumps(body).encode("utf-8"),
        headers=req_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"YouTube InnerTube request failed: {safe_text(exc)[:300]}")

    status = (data.get("playabilityStatus") or {}).get("status")
    if status not in (None, "OK"):
        reason = (data.get("playabilityStatus") or {}).get("reason") or status
        raise HTTPException(422, f"YouTube refused playback: {safe_text(reason)[:300]}")

    adaptive = (data.get("streamingData") or {}).get("adaptiveFormats") or []
    videos = [
        f for f in adaptive
        if f.get("url")
        and str(f.get("mimeType") or "").startswith("video/mp4")
        and isinstance(f.get("height"), int)
        and f["height"] <= max_height
    ]
    audios = [
        f for f in adaptive
        if f.get("url") and str(f.get("mimeType") or "").startswith("audio/mp4")
    ]
    if not videos or not audios:
        raise HTTPException(502, "YouTube InnerTube returned no muxable HD streams")

    videos.sort(key=lambda f: (int(f.get("height") or 0), int(f.get("bitrate") or 0)), reverse=True)
    audios.sort(key=lambda f: (str(f.get("itag")) == "140", int(f.get("bitrate") or 0)), reverse=True)
    details = data.get("videoDetails") or {}
    return {
        "video": videos[0],
        "audio": audios[0],
        "title": details.get("title") or "YouTube Video",
        "id": video_id,
    }


def _youtube_android_360_stream(
    page_url: str,
    cookies: str | None = None,
) -> dict[str, Any]:
    video_id = _youtube_video_id(page_url)
    if not video_id:
        raise HTTPException(400, "invalid YouTube URL")

    client_version = "20.10.38"
    ua = "com.google.android.youtube/20.10.38 (Linux; U; Android 13) gzip"
    body = {
        "videoId": video_id,
        "context": {
            "client": {
                "hl": "en",
                "gl": "US",
                "clientName": "ANDROID",
                "clientVersion": client_version,
                "androidSdkVersion": 33,
                "osName": "Android",
                "osVersion": "13",
                "platform": "MOBILE",
                "utcOffsetMinutes": 0,
            },
        },
    }
    req_headers = {
        "Content-Type": "application/json",
        "User-Agent": ua,
        "X-Youtube-Client-Name": "3",
        "X-Youtube-Client-Version": client_version,
        "Origin": "https://www.youtube.com",
        "Referer": f"https://www.youtube.com/watch?v={video_id}",
    }
    if cookies:
        req_headers["Cookie"] = safe_text(cookies)

    req = urllib.request.Request(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        data=json.dumps(body).encode("utf-8"),
        headers=req_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"YouTube InnerTube request failed: {safe_text(exc)[:300]}")

    status = (data.get("playabilityStatus") or {}).get("status")
    if status not in (None, "OK"):
        reason = (data.get("playabilityStatus") or {}).get("reason") or status
        raise HTTPException(422, f"YouTube refused playback: {safe_text(reason)[:300]}")

    formats = (data.get("streamingData") or {}).get("formats") or []
    candidates = [
        f for f in formats
        if f.get("url")
        and str(f.get("mimeType") or "").startswith("video/mp4")
        and f.get("audioQuality")
        and isinstance(f.get("height"), int)
        and f["height"] <= 360
    ]
    if not candidates:
        raise HTTPException(502, "YouTube InnerTube returned no muxed 360p stream")

    candidates.sort(
        key=lambda f: (
            int(f.get("height") or 0),
            str(f.get("itag")) == "18",
            int(f.get("bitrate") or 0),
        ),
        reverse=True,
    )
    details = data.get("videoDetails") or {}
    return {
        "stream": candidates[0],
        "title": details.get("title") or "YouTube Video",
        "id": video_id,
    }


def _resolve_a_records(host: str) -> list[str]:
    try:
        return [info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)]
    except socket.gaierror:
        pass
    for resolver in (
        f"https://dns.google/resolve?name={urllib.parse.quote(host)}&type=A",
        f"https://cloudflare-dns.com/dns-query?name={urllib.parse.quote(host)}&type=A",
    ):
        try:
            req_headers = {"Accept": "application/dns-json"} if "cloudflare-dns" in resolver else {}
            req = urllib.request.Request(resolver, headers=req_headers)
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            ips = [
                ans.get("data")
                for ans in data.get("Answer", [])
                if ans.get("type") == 1 and isinstance(ans.get("data"), str)
            ]
            if ips:
                return ips
        except Exception as exc:  # noqa: BLE001
            print(f"[direct] DoH resolver failed for {host}: {str(exc)[:120]}")
    return []


def _open_direct_media(url: str, headers: dict[str, str]) -> Any:
    url = _assert_public_http_url(url)
    headers = safe_headers(headers)
    try:
        req = urllib.request.Request(url, headers=headers)
        return _urlopen_public(req, timeout=30)
    except urllib.error.URLError as exc:
        host = urllib.parse.urlparse(url).hostname or ""
        if host.endswith(_DOH_CDN_SUFFIXES):
            print(f"[direct] system resolver failed for {host}: {str(exc)[:160]}; trying DoH/IP")
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme == "http":
                return _open_http_via_ip(url, headers)
            return _open_https_via_ip(url, headers)
        raise


def _open_http_via_ip(url: str, headers: dict[str, str]) -> http.client.HTTPResponse:
    url = normalize_url(url)
    headers = safe_headers(headers)
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if not host:
        raise urllib.error.URLError("missing host")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    ips = _resolve_a_records(host)
    if not ips:
        raise urllib.error.URLError(f"could not resolve {host}")
    last_error: Exception | None = None
    for ip in ips[:4]:
        conn: http.client.HTTPConnection | None = None
        try:
            conn = http.client.HTTPConnection(ip, parsed.port or 80, timeout=30)
            conn.request("GET", path, headers=safe_headers({**headers, "Host": host}))
            resp = conn.getresponse()
            if 300 <= resp.status < 400 and resp.getheader("Location"):
                location = urllib.parse.urljoin(url, resp.getheader("Location") or "")
                conn.close()
                return _open_direct_media(location, headers)
            if resp.status >= 400:
                body = resp.read(240).decode("utf-8", errors="replace")
                conn.close()
                raise urllib.error.HTTPError(url, resp.status, body or resp.reason, resp.headers, None)
            return resp
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
    raise urllib.error.URLError(str(last_error or f"could not connect to {host}"))


def _open_https_via_ip(url: str, headers: dict[str, str]) -> http.client.HTTPResponse:
    url = normalize_url(url)
    headers = safe_headers(headers)
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if not host:
        raise urllib.error.URLError("missing host")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    ips = _resolve_a_records(host)
    if not ips:
        raise urllib.error.URLError(f"could not resolve {host}")
    last_error: Exception | None = None
    for ip in ips[:4]:
        conn: http.client.HTTPSConnection | None = None
        try:
            sock = socket.create_connection((ip, parsed.port or 443), timeout=15)
            context = ssl.create_default_context()
            tls = context.wrap_socket(sock, server_hostname=host)
            conn = http.client.HTTPSConnection(host, timeout=30)
            conn.sock = tls
            conn.request("GET", path, headers=safe_headers({**headers, "Host": host}))
            resp = conn.getresponse()
            if 300 <= resp.status < 400 and resp.getheader("Location"):
                location = urllib.parse.urljoin(url, resp.getheader("Location") or "")
                conn.close()
                return _open_direct_media(location, headers)
            if resp.status >= 400:
                body = resp.read(240).decode("utf-8", errors="replace")
                conn.close()
                raise urllib.error.HTTPError(url, resp.status, body or resp.reason, resp.headers, None)
            return resp
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
    raise urllib.error.URLError(str(last_error or f"could not connect to {host}"))


def _response_header(upstream: Any, name: str, default: str | None = None) -> str | None:
    headers = getattr(upstream, "headers", None)
    if headers is not None:
        try:
            return headers.get(name, default)
        except Exception:
            pass
    getheader = getattr(upstream, "getheader", None)
    if callable(getheader):
        return getheader(name, default)
    return default


def _direct_media_stream(
    media_url: str,
    request_headers: dict[str, str],
    response_headers: dict[str, str],
) -> StreamingResponse:
    media_url = normalize_url(media_url)
    headers = safe_headers({"User-Agent": MOBILE_UA, "Accept": "*/*", **(request_headers or {})})
    try:
        upstream = _open_direct_media(media_url, headers)
    except urllib.error.HTTPError as exc:  # type: ignore[attr-defined]
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:240]
        except Exception:
            pass
        raise HTTPException(exc.code, f"upstream: {body or exc.reason}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"upstream: {str(exc)[:240]}")

    content_type = _response_header(upstream, "Content-Type", "video/mp4")
    out_headers = {**response_headers}
    if cl := _response_header(upstream, "Content-Length"):
        out_headers["Content-Length"] = cl

    def stream() -> Iterator[bytes]:
        try:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                upstream.close()
            except Exception:
                pass

    return StreamingResponse(stream(), media_type=content_type, headers=out_headers)


# Mobile-app POST /download only. Two problems with real-time proxying of a large
# CDN stream to the mobile client: (1) the upstream can stall near the end, and
# (2) the mobile HTTP/2 client resets the stream if no bytes arrive for ~10s.
# Fix: "download-ahead" — a background thread pulls the upstream into a temp file
# as fast as it can, while the response generator streams to the client from that
# growing file. Bytes start flowing within ~1s (so the client read-timeout never
# fires), and the on-disk buffer absorbs any near-end upstream stall. The
# browser-driven GET /download path keeps using the real-time _direct_media_stream
# (browsers resume on their own), so the extension and web app are unaffected.
_MAX_BUFFER_BYTES = 600 * 1024 * 1024  # safety cap; abort runaway downloads

def _buffered_direct_media_stream(
    media_url: str,
    request_headers: dict[str, str],
    response_headers: dict[str, str],
) -> StreamingResponse:
    media_url = normalize_url(media_url)
    headers = safe_headers({"User-Agent": MOBILE_UA, "Accept": "*/*", **(request_headers or {})})
    tmpdir = tempfile.mkdtemp(prefix="fcdl_buf_")
    filepath = os.path.join(tmpdir, "media")

    def _cleanup() -> None:
        shutil.rmtree(tmpdir, ignore_errors=True)

    try:
        upstream = _open_direct_media(media_url, headers)
    except urllib.error.HTTPError as exc:  # type: ignore[attr-defined]
        _cleanup()
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:240]
        except Exception:
            pass
        raise HTTPException(exc.code, f"upstream: {body or exc.reason}")
    except Exception as exc:  # noqa: BLE001
        _cleanup()
        raise HTTPException(502, f"upstream: {str(exc)[:240]}")

    content_type = _response_header(upstream, "Content-Type", "video/mp4")
    content_length = _response_header(upstream, "Content-Length")

    # Shared producer state. The producer thread writes to disk; the generator
    # reads behind it. A lock guards the counters/flags.
    state: dict[str, Any] = {"written": 0, "done": False, "error": None}
    lock = threading.Lock()

    def _producer() -> None:
        try:
            with open(filepath, "wb") as f:
                while True:
                    chunk = upstream.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    f.flush()
                    with lock:
                        state["written"] += len(chunk)
                        if state["written"] > _MAX_BUFFER_BYTES:
                            state["error"] = "media exceeds server buffer limit"
                            return
        except Exception as exc:  # noqa: BLE001 — upstream reset/stall mid-download
            with lock:
                state["error"] = str(exc)[:200]
        finally:
            with lock:
                state["done"] = True
            try:
                upstream.close()
            except Exception:
                pass

    threading.Thread(target=_producer, daemon=True).start()

    out_headers = {**response_headers}
    if content_length:
        out_headers["Content-Length"] = content_length

    def stream() -> Iterator[bytes]:
        read_pos = 0
        try:
            with open(filepath, "rb") as f:
                while True:
                    with lock:
                        written = state["written"]
                        done = state["done"]
                        error = state["error"]
                    if read_pos < written:
                        f.seek(read_pos)
                        chunk = f.read(min(written - read_pos, 1024 * 1024))
                        if chunk:
                            read_pos += len(chunk)
                            yield chunk
                            continue
                    # Caught up to the producer.
                    if read_pos >= written and error:
                        # Truncated/failed: end the body short so the client sees a
                        # length mismatch and retries, rather than a silent partial.
                        raise RuntimeError(f"upstream: {error}")
                    if read_pos >= written and done:
                        break
                    time.sleep(0.05)
        finally:
            _cleanup()

    return StreamingResponse(stream(), media_type=content_type, headers=out_headers)


def _ffmpeg_version() -> str | None:
    try:
        proc = subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=5, env=UTF8_ENV,
        )
        return (proc.stdout.splitlines() or [None])[0]
    except Exception:
        return None


# ── Filename helpers ──────────────────────────────────────────────────────────

def _safe_filename(title: str | None, video_id: str) -> str:
    from utils import safe_filename
    return safe_filename(title, video_id, ext="mp4")


def _safe_filename_audio(title: str | None, video_id: str, ext: str = "m4a") -> str:
    from utils import safe_filename
    return safe_filename(title, video_id, ext=ext)


# ── Backward-compatible aliases (used by tests/test_unicode.py) ──────────────
# Tests import private helper names from main; these shims preserve that
# contract without duplicating logic.

_safe_text           = safe_text
_normalize_url       = normalize_url
_safe_headers        = safe_headers
_content_disposition = content_disposition

def _safe_filename(title: str | None, video_id: str) -> str:  # noqa: F811
    from utils import safe_filename
    return safe_filename(title, video_id, ext="mp4")

def _is_japanese_domain(url: str) -> bool:
    from registry import is_japanese_domain
    return is_japanese_domain(url)


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/")
def health() -> dict[str, Any]:
    return {
        "ok":         True,
        "service":    "fcdownloader-extractor",
        "apiVersion": BACKEND_API_VERSION,
        "cached":     len(_cache),
        "rate_limit": RATE_LIMIT,
        "cache_ttl":  CACHE_TTL,
    }


@app.get("/version")
def version() -> dict[str, Any]:
    return {
        "ok":             True,
        "service":        "fcdownloader-extractor",
        "apiVersion":     BACKEND_API_VERSION,
        "yt_dlp":         YT_DLP_VERSION,
        "ffmpeg":         _ffmpeg_version(),
        "cookies_loaded": bool(COOKIES_FILE and os.path.exists(COOKIES_FILE)),
    }


# ── /extract ──────────────────────────────────────────────────────────────────


@app.post("/extract")
@limiter.limit(RATE_LIMIT)
def extract(request: Request, req: ExtractRequest) -> dict[str, Any]:
    cache_key_str = request_cache_key(req.pageUrl, req.referer, req.cookies)
    if req.pageHtml:
        cache_key_str += "|html:" + hashlib.sha256(req.pageHtml.encode("utf-8")).hexdigest()[:16]
    if req.sourceAudit:
        cache_key_str += "|audit:" + hashlib.sha256(
            json.dumps(req.sourceAudit[:80], sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()[:16]
    if (cached := _cache_get(cache_key_str)) is not None:
        return _localize_ytdl_stream_urls(cached, request)

    ctx = make_context("/extract", req.pageUrl, auth_provided=bool(req.cookies))

    try:
        info = None
        if req.pageHtml:
            info = extractors.extract_weibo_from_html(req.pageUrl, req.pageHtml)
        if not info and req.pageHtml:
            info = extractors.extract_curated_site(req.pageUrl, req.cookies, page_html=req.pageHtml)
        # Media hints (URLs the browser actually fetched to play media) are
        # higher-confidence than HTML parsing — check them first.
        if not info:
            info = _info_from_media_hints(req.pageUrl, req.mediaHints)
        # An image-only HTML result (OG thumbnail with no video/audio) is kept as
        # a last-resort fallback rather than a definitive answer so that the
        # iframe scanner and yt-dlp still get a chance to find the real video.
        _image_only_fallback: dict[str, Any] | None = None
        if not info and req.pageHtml:
            _uhtml = universal.extract_universal_from_html(req.pageUrl, req.pageHtml)
            if _uhtml and universal.has_video_or_audio(_uhtml):
                info = _uhtml
            elif _uhtml:
                _image_only_fallback = _uhtml
        # For URL-paste mode (no browser HTML), fetch the page once and run
        # the universal parser or feed extractor. Reuse the HTML below for
        # iframe scanning.
        _html_for_embeds: str | None = req.pageHtml
        if not info and not req.pageHtml:
            _page_text, _page_ct, _link_header = _fetch_page_content(req)
            # Direct binary response: server returned video/audio content-type
            # for the URL itself — treat it as a direct download without parsing.
            if _page_ct and re.match(r"^(?:video|audio)/", _page_ct.strip(), re.I):
                _direct_kind = "audio" if _page_ct.lower().startswith("audio/") else "video"
                _direct_ext = guess_ext_from_url(req.pageUrl) or ("mp3" if _direct_kind == "audio" else "mp4")
                info = {
                    "id": cache_key(req.pageUrl),
                    "url": req.pageUrl,
                    "ext": _direct_ext,
                    "protocol": "https",
                    "extractor": "direct-binary",
                    "_universal_confidence": 0.95,
                }
            elif _page_text and universal.is_htmlish_content_type(_page_ct):
                _html_for_embeds = _page_text
                _uhtml = universal.extract_universal_from_html(req.pageUrl, _page_text)
                if _uhtml and universal.has_video_or_audio(_uhtml):
                    info = _uhtml
                elif _uhtml:
                    _image_only_fallback = _image_only_fallback or _uhtml
            elif _page_text and universal.is_feed_content_type(_page_ct):
                if "json" in _page_ct.lower():
                    info = universal.extract_universal_from_json_feed(req.pageUrl, _page_text)
                else:
                    info = universal.extract_universal_from_feed(req.pageUrl, _page_text)
            elif _page_text and universal.looks_like_feed_text(_page_text):
                # Some CDNs / podcast hosts serve RSS as text/plain or
                # application/octet-stream; fall back to XML sniffing.
                info = universal.extract_universal_from_feed(req.pageUrl, _page_text)
            elif _page_text and "json" in _page_ct.lower() and universal.looks_like_json_feed_text(_page_text):
                # JSON Feed spec (jsonfeed.org) served as application/json.
                info = universal.extract_universal_from_json_feed(req.pageUrl, _page_text)
            elif _page_text and "json" in _page_ct.lower():
                # Arbitrary JSON API response — run hydration + player-config
                # scanners on the JSON blob to find media URLs.
                info = universal.extract_universal_from_json_api(req.pageUrl, _page_text)
            # HTTP Link: header feed discovery — some podcast hosts advertise
            # the RSS feed only via response header, not in the page HTML.
            if not info and _link_header:
                _header_feed_url = universal.scan_feed_link_from_header(req.pageUrl, _link_header)
                if _header_feed_url and _header_feed_url != (_html_for_embeds and req.pageUrl):
                    try:
                        _hfl_req = urllib.request.Request(
                            _header_feed_url,
                            headers={
                                "User-Agent": MOBILE_UA,
                                "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8",
                            },
                        )
                        with _urlopen_public(_hfl_req, timeout=8) as _hfl_resp:
                            _hfl_text = _hfl_resp.read(1_500_000).decode("utf-8", errors="replace")
                            _hfl_ct = safe_text(_hfl_resp.headers.get("Content-Type", ""))
                        if universal.is_feed_content_type(_hfl_ct) or universal.looks_like_feed_text(_hfl_text):
                            info = universal.extract_universal_from_feed(_header_feed_url, _hfl_text)
                    except Exception:
                        pass
        # Canonical redirect: AMP pages and syndicated articles declare
        # <link rel="canonical"> pointing to the original article with the
        # real video player.  If extraction failed on the fetched page, retry
        # on the canonical URL using the universal HTML parser.
        if not info and _html_for_embeds and not (_image_only_fallback and universal.has_video_or_audio(_image_only_fallback)):
            _canonical_url = universal.scan_canonical_url(req.pageUrl, _html_for_embeds)
            if _canonical_url:
                try:
                    _can_hdrs: dict[str, str] = {
                        "User-Agent": MOBILE_UA,
                        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                        "Accept-Language": _accept_language_for_url(_canonical_url),
                    }
                    if req.cookies:
                        _can_hdrs["Cookie"] = safe_header_value("Cookie", req.cookies)
                    _can_req = urllib.request.Request(_canonical_url, headers=safe_headers(_can_hdrs))
                    with _urlopen_public(_can_req, timeout=10) as _can_resp:
                        _can_text = _can_resp.read(1_500_000).decode("utf-8", errors="replace")
                    _can_result = universal.extract_universal_from_html(_canonical_url, _can_text)
                    if _can_result and universal.has_video_or_audio(_can_result):
                        info = _can_result
                except Exception:
                    pass
        # RSS/Atom auto-discovery: blog/podcast CMS pages often advertise their
        # feed via <link rel="alternate" type="application/rss+xml"> in <head>.
        # Fetch and parse it to find media the HTML parser wouldn't see.
        if not info and _html_for_embeds:
            _feed_link = universal.scan_feed_link_url(req.pageUrl, _html_for_embeds)
            if _feed_link:
                try:
                    _fl_req = urllib.request.Request(
                        _feed_link,
                        headers={
                            "User-Agent": MOBILE_UA,
                            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8",
                        },
                    )
                    with _urlopen_public(_fl_req, timeout=8) as _fl_resp:
                        _fl_text = _fl_resp.read(1_500_000).decode("utf-8", errors="replace")
                        _fl_ct = safe_text(_fl_resp.headers.get("Content-Type", ""))
                    if universal.is_feed_content_type(_fl_ct):
                        if "json" in _fl_ct.lower():
                            info = universal.extract_universal_from_json_feed(_feed_link, _fl_text)
                        else:
                            info = universal.extract_universal_from_feed(_feed_link, _fl_text)
                    elif universal.looks_like_feed_text(_fl_text):
                        info = universal.extract_universal_from_feed(_feed_link, _fl_text)
                    elif universal.looks_like_json_feed_text(_fl_text):
                        info = universal.extract_universal_from_json_feed(_feed_link, _fl_text)
                except Exception:
                    pass
        # Try known-player iframes from page HTML (browser-provided or server-fetched).
        # Handles news/blog pages where the video lives inside a Vimeo/Brightcove/
        # JWPlayer/etc. iframe that yt-dlp's generic detector might miss.
        if not info and _html_for_embeds:
            for _embed_url in universal.scan_iframe_embed_urls(req.pageUrl, _html_for_embeds):
                try:
                    _embed_info = run_extraction(
                        _embed_url,
                        referer=req.pageUrl,
                        cookies=req.cookies,
                        subtitles=req.subtitles,
                        sub_langs=req.subLangs,
                        proxy=req.proxy,
                        request_source_audit=req.sourceAudit,
                        ctx=ctx,
                    )
                    if _embed_info:
                        info = _embed_info
                        break
                except Exception:
                    continue
        # oEmbed discovery: fetch the JSON endpoint, extract known-player iframes
        # from the response html field. Common on WordPress/Ghost/news sites.
        if not info and _html_for_embeds:
            _oembed_url = universal.scan_oembed_endpoint_url(req.pageUrl, _html_for_embeds)
            if _oembed_url:
                try:
                    _oe_req = urllib.request.Request(
                        _oembed_url,
                        headers={"Accept": "application/json", "User-Agent": MOBILE_UA},
                    )
                    with _urlopen_public(_oe_req, timeout=8) as _oe_resp:
                        _oe_data = json.loads(_oe_resp.read(65_536))
                    if isinstance(_oe_data, dict):
                        _oe_html = safe_text(_oe_data.get("html", ""))
                        for _embed_url in universal.scan_iframe_embed_urls(_oembed_url, _oe_html):
                            try:
                                _embed_info = run_extraction(
                                    _embed_url,
                                    referer=req.pageUrl,
                                    cookies=req.cookies,
                                    subtitles=req.subtitles,
                                    sub_langs=req.subLangs,
                                    proxy=req.proxy,
                                    request_source_audit=req.sourceAudit,
                                    ctx=ctx,
                                )
                                if _embed_info:
                                    info = _embed_info
                                    break
                            except Exception:
                                continue
                except Exception:
                    pass
        # meta-refresh redirect following: if all other techniques failed and
        # the page declared a redirect via <meta http-equiv="refresh">, fetch
        # the target URL and re-run the universal HTML parser on it.
        if not info and _html_for_embeds:
            _refresh_url = universal.scan_meta_refresh_url(req.pageUrl, _html_for_embeds)
            if _refresh_url:
                try:
                    _rf_hdrs: dict[str, str] = {
                        "User-Agent": MOBILE_UA,
                        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                        "Accept-Language": _accept_language_for_url(_refresh_url),
                    }
                    if req.cookies:
                        _rf_hdrs["Cookie"] = safe_header_value("Cookie", req.cookies)
                    _rf_req = urllib.request.Request(_refresh_url, headers=safe_headers(_rf_hdrs))
                    with _urlopen_public(_rf_req, timeout=10) as _rf_resp:
                        _rf_text = _rf_resp.read(1_500_000).decode("utf-8", errors="replace")
                    _rf_result = universal.extract_universal_from_html(_refresh_url, _rf_text)
                    if _rf_result and universal.has_video_or_audio(_rf_result):
                        info = _rf_result
                except Exception:
                    pass
        if not info:
            try:
                info = run_extraction(
                    req.pageUrl,
                    referer=req.referer,
                    cookies=req.cookies,
                    subtitles=req.subtitles,
                    sub_langs=req.subLangs,
                    proxy=req.proxy,
                    request_source_audit=req.sourceAudit,
                    ctx=ctx,
                    remove_watermark=req.removeWatermark,
                    preferred_quality=req.preferredQuality,
                )
            except HTTPException:
                if _image_only_fallback:
                    # yt-dlp found nothing; fall back to the OG/meta image the
                    # HTML parser found earlier rather than returning an error.
                    info = _image_only_fallback
                else:
                    raise
    except HTTPException:
        ctx.emit(status="error")
        raise

    if req.preferredQuality and info.get("_type") == "playlist":
        info = universal.reorder_by_preferred_quality(info, req.preferredQuality)
    if info.get("_type") == "playlist" and info.get("entries"):
        response = _to_gallery_response(info)
        response["title"] = info.get("title")
        _attach_source_audit(response, info, req.sourceAudit)
        _cache_put(cache_key_str, response)
        print(f"[extract] gallery: {len(response['items'])} item(s)")
        ctx.emit()
        return response

    response = _to_response(info)
    _attach_source_audit(response, info, req.sourceAudit)
    response["title"]     = info.get("title")
    response["thumbnail"] = info.get("thumbnail")
    response["duration"]  = info.get("duration")

    if req.subtitles:
        subs = info.get("subtitles") or {}
        auto = info.get("automatic_captions") or {}
        if subs or auto:
            response["subtitles"]         = subs
            response["automaticCaptions"] = auto

    response = _localize_ytdl_stream_urls(response, request)

    if response.get("kind") == "paired":
        rf = info.get("requested_formats", [{}, {}])
        print(
            f"[extract] paired: video={rf[0].get('format_id')} "
            f"({rf[0].get('height')}p {rf[0].get('vcodec')}) "
            f"audio={rf[1].get('format_id')} {response.get('label')} "
            f"extractor={info.get('extractor')}"
        )
    else:
        print(
            f"[extract] {response.get('kind')}: itag={info.get('format_id')} "
            f"height={info.get('height')} vcodec={info.get('vcodec')} "
            f"{response.get('label')} extractor={info.get('extractor')}"
        )

    if "bilibili" in (info.get("extractor") or "") or "bilibili.com" in req.pageUrl:
        h = (
            info.get("height")
            or (info.get("requested_formats") or [{}])[0].get("height")
            or 0
        )
        if h and h < 720:
            has_bili_cookies = False
            if COOKIES_FILE and os.path.exists(COOKIES_FILE):
                try:
                    with open(COOKIES_FILE, "r", encoding="utf-8", errors="replace") as f:
                        has_bili_cookies = any("bilibili" in line for line in f)
                except Exception:
                    pass
            print(
                f"[extract] WARNING: Bilibili capped at {h}p. "
                f"cookies_have_bilibili={has_bili_cookies}."
            )

    _cache_put(cache_key_str, response)
    ctx.emit()
    return response


# ── /download ─────────────────────────────────────────────────────────────────


@app.get("/download")
@limiter.limit(RATE_LIMIT)
def download(
    request: Request,
    url: str = Query(..., description="Video page or player URL"),
    referer: str | None = Query(None),
    cookies: str | None = Query(None),
    x_fcdl_cookies: str | None = Header(None, alias="X-FCDL-Cookies"),
    audioOnly: bool = Query(False),
    proxy: str | None = Query(None),
    headers: str | None = Query(None, description="Base64url JSON request headers captured by the browser"),
) -> StreamingResponse:
    cookies = safe_text(x_fcdl_cookies or cookies) if (x_fcdl_cookies or cookies) else None
    replay_headers = _decode_replay_headers(headers)
    direct_kind = _direct_media_url_kind(url)
    if direct_kind and replay_headers:
        video_id = cache_key(url)
        filename = _safe_filename(None, video_id)
        out_headers = {
            "Content-Disposition": content_disposition(filename, video_id),
            "Cache-Control": "no-store",
        }
        request_headers = {
            **_download_headers(referer, cookies, page_url=url),
            **replay_headers,
        }
        if cookies:
            request_headers["Cookie"] = safe_text(cookies)
        rid = uuid.uuid4().hex[:12]
        if direct_kind == "hls":
            return StreamingResponse(
                _ffmpeg_stream("", None, url, request_headers, request_id=rid),
                media_type="video/mp4",
                headers=out_headers,
            )
        return _direct_media_stream(url, request_headers, out_headers)

    info = run_extraction(url, referer=referer, cookies=cookies, audio_only=audioOnly, proxy=proxy)
    response = _to_response(info)
    video_id = info.get("id") or cache_key(url)
    filename = (
        _safe_filename_audio(info.get("title"), video_id)
        if audioOnly else _safe_filename(info.get("title"), video_id)
    )
    headers = {
        "Content-Disposition": content_disposition(filename, video_id),
        "Cache-Control": "no-store",
    }
    request_headers = {
        **(response.get("headers") or {}),
        **_download_headers(referer, cookies, page_url=url),
    }
    rid = uuid.uuid4().hex[:12]
    kind = response["kind"]
    if kind == "paired":
        return StreamingResponse(
            _ffmpeg_stream(response["videoUrl"], response["audioUrl"], None, request_headers, request_id=rid),
            media_type="video/mp4", headers=headers,
        )
    if kind == "hls":
        hls_headers = {
            **(info.get("http_headers") or {}),
            **_download_headers(referer, cookies, page_url=url),
        }
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], hls_headers, request_id=rid),
            media_type="video/mp4", headers=headers,
        )
    # ytdl-stream short-circuit: extraction resolved to our own /ytdl-stream proxy
    # (YouTube SABR — yt-dlp skip_download returned HLS, so the HLS guard triggered
    # and ytdl-stream strategy won). Call the supervisor directly instead of having
    # /download HTTP-request itself: urllib would forward cookies in the Cookie header,
    # but /ytdl-stream reads X-FCDL-Cookies / legacy query cookies, so yt-dlp
    # would run without cookies and YouTube would block with the bot-challenge 422.
    if "/ytdl-stream?" in response.get("url", ""):
        _qs = urllib.parse.parse_qs(urllib.parse.urlparse(response["url"]).query)
        _yt_url = (_qs.get("page_url") or [""])[0]
        if _yt_url:
            _tmpdir, _fp, _fsz, _ = supervisor.ytdl_download(_yt_url, cookies, request_id=rid)
            return StreamingResponse(
                supervisor.stream_file(_tmpdir, _fp, request_id=rid),
                media_type="video/mp4",
                headers={**headers, "Content-Length": str(_fsz), "X-Request-ID": rid},
            )
    if _needs_headered_direct_stream(url, response["url"], request_headers):
        return _direct_media_stream(response["url"], request_headers, headers)
    return RedirectResponse(response["url"], status_code=307, headers=headers)


@app.post("/download")
@limiter.limit(RATE_LIMIT)
def download_post(request: Request, req: DownloadRequest) -> StreamingResponse:
    direct_kind = _direct_media_url_kind(req.pageUrl)
    if direct_kind and req.headers:
        video_id = cache_key(req.pageUrl)
        filename = _safe_filename(None, video_id)
        headers = {
            "Content-Disposition": content_disposition(filename, video_id),
            "Cache-Control": "no-store",
        }
        request_headers = {
            **_download_headers(req.referer, req.cookies, page_url=req.pageUrl),
            **safe_headers(req.headers),
        }
        if req.cookies:
            request_headers["Cookie"] = safe_text(req.cookies)
        rid = uuid.uuid4().hex[:12]
        if direct_kind == "hls":
            return StreamingResponse(
                _ffmpeg_stream("", None, req.pageUrl, request_headers, request_id=rid),
                media_type="video/mp4",
                headers=headers,
            )
        return _buffered_direct_media_stream(req.pageUrl, request_headers, headers)

    info = run_extraction_with_format(
        req.pageUrl, referer=req.referer, cookies=req.cookies, format_id=req.formatId,
        audio_only=req.audioOnly, subtitles=req.subtitles, sub_langs=req.subLangs,
        concurrent_fragments=req.concurrentFragments, proxy=req.proxy,
    )
    response = _to_response(info)
    video_id = info.get("id") or cache_key(req.pageUrl)
    filename = (
        _safe_filename_audio(info.get("title"), video_id)
        if req.audioOnly else _safe_filename(info.get("title"), video_id)
    )
    headers = {
        "Content-Disposition": content_disposition(filename, video_id),
        "Cache-Control": "no-store",
    }
    request_headers = {
        **(response.get("headers") or {}),
        **_download_headers(req.referer, req.cookies, page_url=req.pageUrl),
    }
    rid = uuid.uuid4().hex[:12]
    kind = response["kind"]
    if kind == "paired":
        return StreamingResponse(
            _ffmpeg_stream(response["videoUrl"], response["audioUrl"], None, request_headers, request_id=rid),
            media_type="video/mp4", headers=headers,
        )
    if kind == "hls":
        hls_headers = {
            **(info.get("http_headers") or {}),
            **_download_headers(req.referer, req.cookies, page_url=req.pageUrl),
        }
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], hls_headers, request_id=rid),
            media_type="video/mp4", headers=headers,
        )
    # ytdl-stream short-circuit: same as GET /download — call supervisor directly
    # so the user's cookies reach yt-dlp (Cookie header ≠ X-FCDL-Cookies).
    if "/ytdl-stream?" in response.get("url", ""):
        _qs = urllib.parse.parse_qs(urllib.parse.urlparse(response["url"]).query)
        _yt_url = (_qs.get("page_url") or [""])[0]
        if _yt_url:
            _tmpdir, _fp, _fsz, _ = supervisor.ytdl_download(_yt_url, req.cookies, request_id=rid)
            return StreamingResponse(
                supervisor.stream_file(_tmpdir, _fp, request_id=rid),
                media_type="video/mp4",
                headers={**headers, "Content-Length": str(_fsz), "X-Request-ID": rid},
            )
    # Buffer to disk then serve (mobile clients can't resume a reset stream).
    return _buffered_direct_media_stream(response["url"], request_headers, headers)


# ── /ytdl-stream ──────────────────────────────────────────────────────────────
#
# Called when /extract's ytdl-stream fallback strategy wins.  yt-dlp in
# skip_download=True mode cannot resolve SABR format URLs.  This endpoint
# runs yt-dlp in actual download mode and streams the file.
#
# The download blocks BEFORE returning StreamingResponse so that any yt-dlp
# failure raises HTTPException (proper 4xx/5xx) instead of a 0-byte 200 OK.


@app.get("/ytdl-stream")
@limiter.limit(RATE_LIMIT)
def ytdl_stream_endpoint(
    request: Request,
    page_url: str = Query(..., description="Page URL to stream through yt-dlp download mode"),
    cookies: str | None = Query(None, description="Optional session cookies"),
    x_fcdl_cookies: str | None = Header(None, alias="X-FCDL-Cookies"),
) -> StreamingResponse:
    page_url = normalize_url(page_url)
    if not page_url:
        raise HTTPException(400, "page_url is required")
    if not any(x in page_url for x in (
        "youtube.com/", "youtu.be/", "youtube-nocookie.com/",
        "nicovideo.jp", "nico.ms", "niconico.com", "nicochannel.jp",
    )):
        raise HTTPException(400, "ytdl-stream only supports YouTube and Niconico URLs")

    cookies_val = safe_text(x_fcdl_cookies or cookies) if (x_fcdl_cookies or cookies) else None

    # Cookie size validation before handing off to supervisor.
    if cookies_val:
        try:
            auth.validate_cookies(cookies_val)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))

    rid = uuid.uuid4().hex[:12]

    # Block here: download finishes before we return StreamingResponse.
    # This prevents the 0-byte 200 OK race condition.
    tmpdir, filepath, filesize, filename = supervisor.ytdl_download(
        page_url, cookies_val, request_id=rid,
    )

    return StreamingResponse(
        supervisor.stream_file(tmpdir, filepath, request_id=rid),
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(filesize),
            "Cache-Control": "no-cache, no-store",
            "X-Request-ID": rid,
        },
    )


# ── /playlist ─────────────────────────────────────────────────────────────────


@app.get("/youtube-hd-stream")
@limiter.limit(RATE_LIMIT)
def youtube_hd_stream_endpoint(
    request: Request,
    page_url: str = Query(..., description="YouTube page URL to stream as muxed HD MP4"),
    max_height: int = Query(1080, ge=360, le=1080),
    cookies: str | None = Query(None, description="Optional YouTube session cookies"),
    x_fcdl_cookies: str | None = Header(None, alias="X-FCDL-Cookies"),
) -> StreamingResponse:
    page_url = normalize_url(page_url)
    if not page_url:
        raise HTTPException(400, "page_url is required")
    if not any(x in page_url for x in ("youtube.com/", "youtu.be/", "youtube-nocookie.com/")):
        raise HTTPException(400, "youtube-hd-stream only supports YouTube URLs")

    rid = uuid.uuid4().hex[:12]
    cookies_val = safe_text(x_fcdl_cookies or cookies) if (x_fcdl_cookies or cookies) else None
    if cookies_val:
        try:
            auth.validate_cookies(cookies_val)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))
    if not cookies_val:
        cookies_val = _cookie_header_from_netscape_file(COOKIES_FILE, "youtube")

    picked = _youtube_android_streams(page_url, max_height=max_height, cookies=cookies_val)
    video = picked["video"]
    audio = picked["audio"]
    video_id = picked.get("id") or cache_key(page_url)
    filename = _safe_filename(picked.get("title"), video_id)
    headers = {
        "Content-Disposition": content_disposition(filename, video_id),
        "Cache-Control": "no-cache, no-store",
        "X-Request-ID": rid,
        "X-FCDL-Video-Height": str(video.get("height") or ""),
        "X-FCDL-Video-Itag": str(video.get("itag") or ""),
        "X-FCDL-Audio-Itag": str(audio.get("itag") or ""),
    }
    print(
        f"[youtube-hd] rid={rid} video_itag={video.get('itag')} "
        f"height={video.get('height')} audio_itag={audio.get('itag')}"
    )
    return StreamingResponse(
        _ffmpeg_stream(
            video["url"],
            audio["url"],
            None,
            {"Cookie": cookies_val} if cookies_val else None,
            request_id=rid,
        ),
        media_type="video/mp4",
        headers=headers,
    )


@app.get("/youtube-360-stream")
@limiter.limit(RATE_LIMIT)
def youtube_360_stream_endpoint(
    request: Request,
    page_url: str = Query(..., description="YouTube page URL to stream as muxed 360p MP4"),
    cookies: str | None = Query(None, description="Optional YouTube session cookies"),
    x_fcdl_cookies: str | None = Header(None, alias="X-FCDL-Cookies"),
) -> StreamingResponse:
    page_url = normalize_url(page_url)
    if not page_url:
        raise HTTPException(400, "page_url is required")
    if not any(x in page_url for x in ("youtube.com/", "youtu.be/", "youtube-nocookie.com/")):
        raise HTTPException(400, "youtube-360-stream only supports YouTube URLs")

    rid = uuid.uuid4().hex[:12]
    cookies_val = safe_text(x_fcdl_cookies or cookies) if (x_fcdl_cookies or cookies) else None
    if cookies_val:
        try:
            auth.validate_cookies(cookies_val)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))
    if not cookies_val:
        cookies_val = _cookie_header_from_netscape_file(COOKIES_FILE, "youtube")

    picked = _youtube_android_360_stream(page_url, cookies=cookies_val)
    stream = picked["stream"]
    video_id = picked.get("id") or cache_key(page_url)
    filename = _safe_filename(picked.get("title"), video_id)
    headers = {
        "Content-Disposition": content_disposition(filename, video_id),
        "Cache-Control": "no-cache, no-store",
        "X-Request-ID": rid,
        "X-FCDL-Video-Height": str(stream.get("height") or ""),
        "X-FCDL-Video-Itag": str(stream.get("itag") or ""),
    }
    request_headers = {"Cookie": cookies_val} if cookies_val else {}
    print(
        f"[youtube-360] rid={rid} itag={stream.get('itag')} "
        f"height={stream.get('height')}"
    )
    return _direct_media_stream(stream["url"], request_headers, headers)


@app.get("/youtube-mux-stream")
@limiter.limit(RATE_LIMIT)
def youtube_mux_stream_endpoint(
    request: Request,
    video_url: str = Query(..., description="YouTube googlevideo video-only URL"),
    audio_url: str = Query(..., description="YouTube googlevideo audio-only URL"),
    title: str | None = Query(None),
    video_id: str | None = Query(None),
) -> StreamingResponse:
    video_url = normalize_url(video_url)
    audio_url = normalize_url(audio_url)
    if "googlevideo.com/" not in video_url or "googlevideo.com/" not in audio_url:
        raise HTTPException(400, "youtube-mux-stream only accepts googlevideo URLs")
    if "/videoplayback" not in video_url or "/videoplayback" not in audio_url:
        raise HTTPException(400, "youtube-mux-stream only accepts YouTube videoplayback URLs")

    rid = uuid.uuid4().hex[:12]
    safe_id = safe_text(video_id or cache_key(video_url))[:80]
    filename = _safe_filename(title or "YouTube HD", safe_id)
    print(f"[youtube-mux] rid={rid} browser-provided googlevideo URLs")
    return StreamingResponse(
        _ffmpeg_stream(video_url, audio_url, None, None, request_id=rid),
        media_type="video/mp4",
        headers={
            "Content-Disposition": content_disposition(filename, safe_id),
            "Cache-Control": "no-cache, no-store",
            "X-Request-ID": rid,
        },
    )


@app.post("/playlist")
@limiter.limit(RATE_LIMIT)
def playlist_extract(request: Request, req: PlaylistRequest) -> dict[str, Any]:
    page_url = normalize_url(req.pageUrl)
    if not page_url:
        raise HTTPException(400, "pageUrl is required")

    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
    }
    if req.proxy:
        ydl_opts["proxy"] = req.proxy

    cookie_file: str | None = None
    if req.cookies:
        try:
            cookie_file = auth.write_cookie_file(req.cookies, page_url)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))
        if cookie_file:
            ydl_opts["cookiefile"] = cookie_file
    elif COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts["cookiefile"] = COOKIES_FILE
    if req.referer:
        ydl_opts["referer"] = req.referer

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"playlist extraction failed: {safe_text(exc)[:400]}")
    finally:
        auth.unlink_cookie_file(cookie_file)

    if not info:
        raise HTTPException(502, "no playlist info returned by yt-dlp")

    entries = info.get("entries") or []
    if not entries:
        raise HTTPException(400, "URL is a single video or empty playlist — use /extract for single videos")

    items = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url") or entry.get("webpage_url") or ""
        if not url:
            continue
        if not url.startswith("http") and entry.get("ie_key") == "Youtube":
            url = f"https://www.youtube.com/watch?v={url}"
        items.append({
            "id":        entry.get("id"),
            "url":       url,
            "title":     entry.get("title"),
            "thumbnail": None,
            "duration":  entry.get("duration"),
            "uploader":  entry.get("uploader") or entry.get("channel"),
        })

    print(f"[playlist] {len(items)} items from {page_url}")
    return {
        "title":    info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "count":    len(items),
        "items":    items,
    }


# ── /proxy ────────────────────────────────────────────────────────────────────


def _default_proxy_headers(target_url: str, referer: str | None) -> dict[str, str]:
    host = ""
    try:
        host = urllib.parse.urlparse(target_url).hostname or ""
    except Exception:
        pass
    h: dict[str, str] = {
        "User-Agent":      MOBILE_UA,
        "Accept":          "*/*",
        "Accept-Language": languages.accept_language_for_url(target_url, "en-US,en;q=0.9"),
    }
    if referer:
        h["Referer"] = referer
    elif "cdninstagram" in host or "fbcdn" in host:
        h["Referer"] = "https://www.instagram.com/"
    elif "threadscdn" in host:
        h["Referer"] = "https://www.threads.com/"
    elif "bilivideo" in host or "bilibili" in host or "biliimg" in host or "hdslb" in host:
        h["Referer"] = "https://www.bilibili.com/"
        h["Origin"]  = "https://www.bilibili.com"
    elif "weibocdn" in host or "weibo" in host:
        h["Referer"] = "https://weibo.com/"
        h["Origin"]  = "https://weibo.com"
    elif "xhscdn" in host or "xiaohongshu" in host or "rednote" in host:
        h["Referer"] = "https://www.xiaohongshu.com/"
        h["Origin"]  = "https://www.xiaohongshu.com"
    elif "postfiles.pstatic" in host:
        h["Referer"] = "https://blog.naver.com/"
        h["Origin"]  = "https://blog.naver.com"
    elif "imgnews.pstatic" in host or "mimgnews.pstatic" in host:
        h["Referer"] = "https://news.naver.com/"
        h["Origin"]  = "https://news.naver.com"
    elif "naver" in host or "pstatic" in host:
        h["Referer"] = "https://tv.naver.com/"
        h["Origin"]  = "https://tv.naver.com"
    elif "mdpr" in host or "modelpress" in host:
        h["Referer"] = "https://mdpr.jp/"
        h["Origin"]  = "https://mdpr.jp"
    elif "pximg" in host or "pixiv" in host or "fanbox" in host:
        h["Referer"] = "https://www.pixiv.net/"
    elif "kakaocdn" in host or "daumcdn" in host or "tistory" in host:
        h["Referer"] = "https://www.daum.net/"
        h["Origin"]  = "https://www.daum.net"
    elif any(token in host for token in (
        "ameba", "natalie", "oricon", "kstyle", "livedoor", "yimg",
        "kodansha", "hpplus", "fashion-press", "fashionsnap", "wwdjapan",
        "thetv", "mantan-web", "crank-in", "cinematoday", "eiga",
        "realsound", "spice.eplus", "jprime", "flash", "bunshun",
        "dailyshincho", "news-postseven", "josei7", "gendai", "asagei",
        "entamenext", "girlsnews", "tokyo-sports", "hochi", "sponichi",
        "nikkansports", "sanspo", "mainichi", "asahi", "yomiuri",
        "sankei", "tokyo-np", "kyodo", "47news", "jiji", "itmedia",
        "impress", "mynavi", "ascii", "gigazine",
    )):
        h["Referer"] = f"https://{host}/"
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
    x_fcdl_cookies: str | None = Header(None, alias="X-FCDL-Cookies"),
    filename: str | None = Query(None),
    headers: str | None = Query(None, description="Base64url JSON request headers captured by the browser"),
) -> StreamingResponse:
    cookies = safe_text(x_fcdl_cookies or cookies) if (x_fcdl_cookies or cookies) else None
    return _proxy_stream(url, referer, cookies, filename, _decode_replay_headers(headers))


@app.post("/proxy")
@limiter.limit(RATE_LIMIT)
def proxy_post(
    request: Request,
    req: ProxyRequest,
    x_fcdl_cookies: str | None = Header(None, alias="X-FCDL-Cookies"),
) -> StreamingResponse:
    cookies = safe_text(x_fcdl_cookies or req.cookies) if (x_fcdl_cookies or req.cookies) else None
    return _proxy_stream(req.url, req.referer, cookies, req.filename, safe_headers(req.headers or {}))


def _proxy_stream(
    url: str,
    referer: str | None,
    cookies: str | None,
    filename: str | None,
    replay_headers: dict[str, str] | None = None,
) -> StreamingResponse:
    url = _assert_public_http_url(url)
    referer = normalize_url(referer) if referer else None

    headers = safe_headers({**_default_proxy_headers(url, referer), **safe_headers(replay_headers or {})})
    if cookies:
        headers["Cookie"] = safe_header_value("Cookie", cookies)

    try:
        req = urllib.request.Request(url, headers=headers)
        upstream = _urlopen_public(req, timeout=30)
    except urllib.error.HTTPError as exc:  # type: ignore[attr-defined]
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:240]
        except Exception:
            pass
        raise HTTPException(exc.code, f"upstream: {body or exc.reason}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"upstream: {str(exc)[:240]}")

    content_type = upstream.headers.get("Content-Type", "application/octet-stream")
    out_headers: dict[str, str] = {"Cache-Control": "no-store"}
    if filename:
        out_headers["Content-Disposition"] = content_disposition_any(filename)
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
            try:
                upstream.close()
            except Exception:
                pass

    return StreamingResponse(stream(), media_type=content_type, headers=out_headers)


# ── /debug ────────────────────────────────────────────────────────────────────


@app.get("/debug")
def debug_extract(
    request: Request,
    url: str = Query(...),
    referer: str | None = Query(None),
    cookies: str | None = Query(None),
    authorization: str | None = Header(None),
) -> dict[str, Any]:
    # TRUSTED_TOKEN is required — /debug is always protected.
    # If the operator hasn't set one, the endpoint returns 404 (as if it
    # doesn't exist) so it can't be used to probe the server from the internet.
    if not TRUSTED_TOKEN:
        raise HTTPException(404, "Not Found")
    bearer = (authorization or "").replace("Bearer ", "").strip()
    if bearer != TRUSTED_TOKEN:
        raise HTTPException(401, "debug requires TRUSTED_TOKEN")

    # Validate cookies before passing to yt-dlp — same size/format guards
    # that every other endpoint uses.  /debug was previously bypassing them.
    if cookies:
        try:
            cookies = auth.validate_cookies(cookies)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))

    out: dict[str, Any] = {
        "url":            url,
        "cookies_loaded": bool(COOKIES_FILE and os.path.exists(COOKIES_FILE)),
        "cookies_file":   COOKIES_FILE or None,
        "format_spec":    FORMAT_SPEC,
    }

    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        try:
            with open(COOKIES_FILE, "r", encoding="utf-8", errors="replace") as f:
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
        except Exception as exc:  # noqa: BLE001
            out["cookie_domains_error"] = str(exc)[:200]

    http_headers: dict[str, str] = {}
    if referer:
        http_headers["Referer"] = referer
    if cookies:
        http_headers["Cookie"] = cookies

    probe_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extractor_args": {
            "youtube": {
                "player_client": ["tv", "web_safari", "mweb"],
                "player_skip": ["configs"],
            },
        },
    }
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        probe_opts["cookiefile"] = COOKIES_FILE
    if http_headers:
        probe_opts["http_headers"] = http_headers

    try:
        with YoutubeDL(probe_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"yt-dlp: {str(exc)[:400]}"
        return out

    out["extractor"] = info.get("extractor")
    out["title"]     = info.get("title")
    out["_type"]     = info.get("_type")

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

    pick_opts = {**probe_opts, "format": FORMAT_SPEC}
    try:
        with YoutubeDL(pick_opts) as ydl2:
            picked = ydl2.extract_info(url, download=False)
        if picked.get("requested_formats"):
            v, a = picked["requested_formats"]
            out["chosen_format"] = {
                "paired":          True,
                "video_format_id": v.get("format_id"),
                "video_height":    v.get("height"),
                "video_vcodec":    v.get("vcodec"),
                "video_ext":       v.get("ext"),
                "audio_format_id": a.get("format_id"),
                "audio_acodec":    a.get("acodec"),
            }
        else:
            out["chosen_format"] = {
                "paired":    False,
                "format_id": picked.get("format_id"),
                "height":    picked.get("height"),
                "vcodec":    picked.get("vcodec"),
                "acodec":    picked.get("acodec"),
                "ext":       picked.get("ext"),
            }
    except Exception as exc:  # noqa: BLE001
        out["chosen_format_error"] = f"yt-dlp: {str(exc)[:400]}"

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

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
import html
import http.client
import json
import os
import re
import shlex
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
import urllib.parse
from typing import Any, Iterator

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from yt_dlp import YoutubeDL
from yt_dlp.version import __version__ as YT_DLP_VERSION


UTF8_ENV = {
    **os.environ,
    "PYTHONIOENCODING": "utf-8",
    "LANG": "en_US.UTF-8",
    "LC_ALL": "en_US.UTF-8",
}


def _configure_utf8_runtime() -> None:
    os.environ.update({
        "PYTHONIOENCODING": "utf-8",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "en_US.UTF-8",
    })
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


_configure_utf8_runtime()


class UTF8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", errors="replace")


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value).encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def _strip_header_controls(value: str) -> str:
    return re.sub(r"[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", " ", _safe_text(value)).strip()


def _normalize_url(url: str) -> str:
    raw = _safe_text(url).strip()
    if not raw:
        return raw
    try:
        parts = urllib.parse.urlsplit(raw)
        scheme = parts.scheme.lower()
        netloc = parts.netloc
        if parts.hostname:
            host = parts.hostname.encode("idna").decode("ascii")
            userinfo = ""
            if parts.username:
                userinfo = urllib.parse.quote(parts.username, safe="")
                if parts.password:
                    userinfo += ":" + urllib.parse.quote(parts.password, safe="")
                userinfo += "@"
            port = f":{parts.port}" if parts.port else ""
            netloc = f"{userinfo}{host}{port}"
        path = urllib.parse.quote(parts.path, safe="/%:@!$&'()*+,;=")
        query = urllib.parse.quote(parts.query, safe="=&?/:;%+@,$!'()*[]")
        fragment = urllib.parse.quote(parts.fragment, safe="=&?/:;%+@,$!'()*[]")
        return urllib.parse.urlunsplit((scheme, netloc, path, query, fragment))
    except Exception:
        return urllib.parse.quote(raw, safe=":/?#[]@!$&'()*+,;=%")


def _safe_header_value(name: str, value: Any) -> str:
    s = _strip_header_controls(_safe_text(value))
    lname = name.lower()
    if lname in {"referer", "referrer"}:
        return _normalize_url(s)
    if lname == "origin":
        try:
            p = urllib.parse.urlsplit(_normalize_url(s))
            return urllib.parse.urlunsplit((p.scheme, p.netloc, "", "", ""))
        except Exception:
            return s
    return "".join(ch if 32 <= ord(ch) <= 126 or ord(ch) == 9 else "?" for ch in s)


def _safe_headers(headers: dict[str, Any] | None) -> dict[str, str]:
    if not headers:
        return {}
    cleaned: dict[str, str] = {}
    for raw_name, raw_value in headers.items():
        name = re.sub(r"[^A-Za-z0-9-]+", "", _safe_text(raw_name))
        if not name or raw_value is None:
            continue
        cleaned[name] = _safe_header_value(name, raw_value)
    return cleaned


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
    # ── Non-HLS tiers (preferred) ─────────────────────────────────────────────
    # HLS manifests from yt-dlp carry per-segment auth that FFmpeg cannot
    # replicate server-side (YouTube's CDN 403s on every segment → 0-byte file).
    # Exclude m3u8/m3u8_native protocols in every tier; only fall back to HLS
    # at the very end when the site literally has no direct/DASH formats.
    #
    # Ideal — h264/avc1 video + m4a/aac audio (MediaMuxer-compatible), no HLS
    "bv*[height<=1080][vcodec^=avc1][ext=mp4][protocol!=m3u8_native][protocol!=m3u8]"
    "+ba[ext=m4a][protocol!=m3u8_native][protocol!=m3u8]/"
    "bv*[height<=1080][ext=mp4][protocol!=m3u8_native][protocol!=m3u8]"
    "+ba[ext=m4a][protocol!=m3u8_native][protocol!=m3u8]/"
    # Any non-HLS 1080p paired (vp9+opus, etc.)
    "bv*[height<=1080][protocol!=m3u8_native][protocol!=m3u8]"
    "+ba[protocol!=m3u8_native][protocol!=m3u8]/"
    # Pre-muxed non-HLS single file
    "b[ext=mp4][height<=1080][protocol!=m3u8_native][protocol!=m3u8]/"
    "b[height<=1080][protocol!=m3u8_native][protocol!=m3u8]/"
    # ── HLS last resort — only when the site has no direct/DASH formats at all
    #    (live streams, some regional TV sites). FFmpeg handles these when segment
    #    URLs are self-authenticating (token in URL, not in headers).
    "b"
)

# ── App + middleware ─────────────────────────────────────────────────────────

limiter = Limiter(key_func=_client_ip)
app = FastAPI(
    title="fcdownloader-extractor",
    version="2.0",
    default_response_class=UTF8JSONResponse,
)
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
    page_url = _normalize_url(page_url)
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
    # Optional HTTP proxy (e.g. "socks5://127.0.0.1:1080" or "http://proxy:8080").
    proxy: str | None = None
    # Include subtitle URLs in the response (does not embed — client downloads separately).
    subtitles: bool = False
    subLangs: str = "en"


class DownloadRequest(BaseModel):
    pageUrl: str
    referer: str | None = None
    cookies: str | None = None
    formatId: str | None = None
    # Audio-only extraction: returns best audio (m4a/mp3) instead of video.
    audioOnly: bool = False
    # Download and embed subtitles (requires FFmpeg on server).
    subtitles: bool = False
    subLangs: str = "en"
    # Embed chapter markers into the output file via FFmpeg.
    embedChapters: bool = False
    # Parallel fragment download count for HLS/DASH (yt-dlp --concurrent-fragments).
    concurrentFragments: int = 1
    # Optional HTTP proxy forwarded to yt-dlp.
    proxy: str | None = None


class PlaylistRequest(BaseModel):
    pageUrl: str
    referer: str | None = None
    cookies: str | None = None
    proxy: str | None = None


# ── Routes ───────────────────────────────────────────────────────────────────


@app.get("/")
def health() -> dict[str, Any]:
    return {
        "ok":          True,
        "cached":      len(_cache),
        "rate_limit":  RATE_LIMIT,
        "cache_ttl":   CACHE_TTL,
    }


@app.get("/version")
def version() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "fcdownloader-extractor",
        "yt_dlp": YT_DLP_VERSION,
        "ffmpeg": _ffmpeg_version(),
        "cookies_loaded": bool(COOKIES_FILE and os.path.exists(COOKIES_FILE)),
    }


def _ffmpeg_version() -> str | None:
    try:
        proc = subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=5,
            env=UTF8_ENV,
        )
        return (proc.stdout.splitlines() or [None])[0]
    except Exception:
        return None


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
    page_url = _normalize_url(page_url)
    try:
        req = urllib.request.Request(page_url, headers=_safe_headers({
            "User-Agent": _MOBILE_UA,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            **({"Cookie": cookies} if cookies else {}),
        }))
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


def _write_user_cookies_file(cookies: str, page_url: str) -> str | None:
    """Convert a user-supplied `Cookie: a=1; b=2; ...` header into a Netscape
    cookies.txt file scoped to page_url's registrable domain, write to /tmp,
    return the filepath.

    Why this matters: yt-dlp's cookiejar reads from `cookiefile` and that
    jar takes precedence over the `Cookie` http header on subsequent
    requests yt-dlp makes (Bilibili's WBI flow, Instagram's GraphQL probes
    etc. all do multiple calls and only the first sees the Cookie header).
    So if the user is logged into the site in their own browser and the
    extension/mobile app sends those cookies along, we get the real jar
    populated and every yt-dlp internal call inherits the session.
    """
    cookies = _safe_text(cookies).strip()
    page_url = _normalize_url(page_url)
    if not cookies:
        return None
    host = ""
    try:
        host = (urllib.parse.urlparse(page_url).hostname or "").encode("idna").decode("ascii")
    except Exception:
        pass
    if not host:
        return None
    # Reduce "www.bilibili.com" → "bilibili.com" so cookies match api.bilibili.com
    # / m.bilibili.com / etc. that yt-dlp probes during extraction.
    parts = host.split(".")
    reg_domain = ".".join(parts[-2:]) if len(parts) > 2 and len(parts[-1]) >= 2 else host
    domain_fields = ["." + reg_domain]
    if reg_domain in {"weibo.com", "weibo.cn"}:
        # Weibo jumps between weibo.com, m.weibo.cn, and passport.weibo.com.
        # The client gives us a flat Cookie header, so mirror it to both
        # registrable domains in the per-request yt-dlp cookie jar.
        domain_fields = [".weibo.com", ".weibo.cn"]
    expiry = int(time.time()) + 86400  # 1 day is plenty; cookies short-lived anyway

    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix="-user-cookies.txt", delete=False, encoding="utf-8", errors="replace"
    )
    try:
        tmp.write("# Netscape HTTP Cookie File\n")
        tmp.write("# Generated by fcdownloader-extractor per-request\n")
        for raw in cookies.split(";"):
            raw = raw.strip()
            if not raw or "=" not in raw:
                continue
            name, _, value = raw.partition("=")
            name = _safe_header_value("Cookie", name.strip())
            value = _safe_header_value("Cookie", value.strip())
            if not name:
                continue
            # Netscape format: domain  includeSubdomains  path  secure  expiry  name  value
            for domain_field in domain_fields:
                tmp.write(f"{domain_field}\tTRUE\t/\tFALSE\t{expiry}\t{name}\t{value}\n")
        tmp.flush()
    finally:
        tmp.close()
    return tmp.name


def _extract_meta_threads(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return _extract_meta_page(page_url, cookies, "threads")


def _extract_meta_instagram(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return _extract_meta_page(page_url, cookies, "instagram")


# Shared yt-dlp invocation — used by both /extract and /download
_WEIBO_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# Japanese video/streaming sites that need Accept-Language: ja to respond
# correctly (otherwise they often return English stubs or redirect to an
# unsupported-region page, causing yt-dlp to fail with "Unsupported URL").
_JAPANESE_SITE_DOMAINS: tuple[str, ...] = (
    "nicovideo.jp", "nico.ms", "n.nicovideo.jp",
    "abema.tv",
    "ameba.jp", "ameblo.jp",
    "wwd.co.jp", "wwdjapan.com",
    "nhk.or.jp", "nhk.jp",
    "gyao.jp",
    "hulu.jp",
    "openrec.tv",
    "mildom.com",
)


def _is_japanese_domain(url: str) -> bool:
    """Return True for URLs whose hostname is a known Japanese site or ends in .jp."""
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except Exception:
        return False
    if host.endswith(".jp"):
        return True
    return any(host == d or host.endswith("." + d) for d in _JAPANESE_SITE_DOMAINS)


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


def _weibo_headers(page_url: str, cookies: str | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": _WEIBO_DESKTOP_UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
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
    url = _normalize_url(url)
    page_url = _normalize_url(page_url)
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    try:
        req = urllib.request.Request(
            url,
            data=data,
            headers=_safe_headers(_weibo_headers(page_url, cookies)),
            method="POST" if data is not None else "GET",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            ct = resp.headers.get("Content-Type", "")
    except Exception as e:  # noqa: BLE001
        print(f"[weibo] JSON fetch failed for {url}: {str(e)[:200]}")
        return None

    if "json" not in ct.lower() and not body.lstrip().startswith(("{", "[")):
        print(f"[weibo] expected JSON, got {ct or 'unknown content-type'} from {url}")
        return None
    try:
        data_obj = json.loads(body)
        return data_obj if isinstance(data_obj, dict) else None
    except Exception as e:  # noqa: BLE001
        print(f"[weibo] JSON parse failed for {url}: {str(e)[:200]}")
        return None


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
            "http_headers": {"Referer": "https://weibo.com/", "User-Agent": _WEIBO_DESKTOP_UA},
            **(extra or {}),
        })

    playback = media_info.get("playback_list")
    if isinstance(playback, list):
        for item in playback:
            play = item.get("play_info") if isinstance(item, dict) else None
            if not isinstance(play, dict) or not play.get("url"):
                continue
            add_candidate(play["url"], {
                "format_id": play.get("label"),
                "format_note": play.get("quality_desc"),
                "width": play.get("width"),
                "height": play.get("height"),
                "tbr": play.get("bitrate"),
                "filesize": play.get("size"),
            })

    if not candidates:
        urls = media_info.get("urls")
        if isinstance(urls, dict):
            for key in ("mp4_uhd_mp4", "mp4_hd_mp4", "mp4_ld_mp4", "mp4_hd", "mp4_ld"):
                value = urls.get(key)
                if isinstance(value, str) and value.startswith("http"):
                    add_candidate(value, {"format_id": key, "format_note": key.replace("_", " ").upper()})

    if not candidates:
        for key in ("stream_url_hd", "stream_url"):
            value = media_info.get(key)
            if isinstance(value, str) and value.startswith("http"):
                add_candidate(value, {"format_id": key, "format_note": "HD" if key.endswith("_hd") else None})

    if not candidates:
        seen: set[str] = set()
        for value in _walk_json(media_info):
            if not isinstance(value, str) or not re.search(r"https?://", value):
                continue
            url = value.replace("\\u0026", "&").replace("\\/", "/")
            if not re.search(r"(?:weibocdn\.com|sinaimg\.cn).*\.(?:mp4|m3u8|mov)(?:[?#]|$)", url, re.I):
                continue
            if url in seen:
                continue
            seen.add(url)
            add_candidate(url)

    if not candidates:
        return None

    def score(fmt: dict[str, Any]) -> int:
        url = (fmt.get("url") or "").lower()
        height = int(fmt.get("height") or 0)
        width = int(fmt.get("width") or 0)
        bitrate = int(fmt.get("tbr") or 0)
        size = int(fmt.get("filesize") or 0)
        fmt_id = str(fmt.get("format_id") or "").lower()
        mp4_bonus = 10_000_000 if ".mp4" in url else 0
        hls_penalty = -1_000_000 if ".m3u8" in url else 0
        hd_bonus = 500_000 if any(token in url or token in fmt_id for token in ("hd", "uhd")) else 0
        low_penalty = -250_000 if any(token in url or token in fmt_id for token in ("ld", "sd")) else 0
        return mp4_bonus + hd_bonus + low_penalty + hls_penalty + height * width + bitrate + size // 1024

    return sorted(candidates, key=score)[-1]


def _weibo_parse_post(meta: dict[str, Any], page_url: str) -> dict[str, Any] | None:
    entries: list[dict[str, Any]] = []

    def thumbnail_url() -> str | None:
        pic = _json_get_path(meta, "page_info", "page_pic")
        if isinstance(pic, dict):
            return pic.get("url")
        return pic if isinstance(pic, str) else None

    def add_video_from_media_info(media_info: Any, fallback_id: str | None = None) -> None:
        if not isinstance(media_info, dict):
            return
        best = _weibo_best_format(media_info)
        if not best:
            return
        entries.append({
            **best,
            "id": fallback_id or str(meta.get("id") or meta.get("mid") or _cache_key(best["url"])),
            "title": media_info.get("video_title") or media_info.get("kol_title") or media_info.get("name") or meta.get("text_raw"),
            "thumbnail": thumbnail_url(),
            "duration": media_info.get("duration"),
        })

    mix_items = _json_get_path(meta, "mix_media_info", "items")
    if isinstance(mix_items, list):
        for item in mix_items:
            if not isinstance(item, dict) or item.get("type") == "pic":
                continue
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            add_video_from_media_info(data.get("media_info"), str(data.get("object_id") or ""))

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
    post_id = str(meta.get("id") or meta.get("id_str") or meta.get("mid") or _cache_key(page_url))

    if len(entries) > 1:
        return {"_type": "playlist", "entries": entries, "title": title, "thumbnail": thumb, "id": post_id}

    single = entries[0]
    single.setdefault("id", post_id)
    single.setdefault("title", title)
    single.setdefault("thumbnail", thumb)
    single.setdefault("http_headers", {"Referer": "https://weibo.com/", "User-Agent": _WEIBO_DESKTOP_UA})
    return single


def _extract_weibo_page(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    video_id = _weibo_id_from_url(page_url)
    if not video_id:
        return None
    if ":" in video_id:
        body = f'data={{"Component_Play_Playinfo":{{"oid":"{video_id}"}}}}'.encode("utf-8", errors="replace")
        component = _download_weibo_json(
            "https://weibo.com/tv/api/component",
            page_url,
            cookies,
            query={"page": f"/tv/show/{video_id}"},
            data=body,
        )
        mid = _json_get_path(component or {}, "data", "Component_Play_Playinfo", "mid")
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


def _extractor_result(
    strategy: str,
    success: bool,
    fatal: bool = False,
    reason: str | None = None,
    media: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "success": success,
        "fatal": fatal,
        "strategy": strategy,
        **({"reason": reason} if reason else {}),
        **({"media": media} if media else {}),
    }


def _try_ydl(page_url: str, ydl_opts: dict[str, Any], force_generic: bool) -> dict[str, Any]:
    strategy = "generic yt-dlp extractor" if force_generic else "yt-dlp"
    opts = {**ydl_opts}
    if force_generic:
        opts["force_generic_extractor"] = True
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
        if not info:
            return _extractor_result(strategy, False, reason="yt-dlp returned no info")
        return _extractor_result(strategy, True, media=info)
    except Exception as e:  # noqa: BLE001
        msg = _safe_text(e)[:400]
        return _extractor_result(strategy, False, reason=msg or "yt-dlp failed")


def _try_ydl_client(page_url: str, ydl_opts: dict[str, Any], client: str) -> dict[str, Any]:
    """Re-try yt-dlp with a single specific YouTube player_client.

    Used as individual fallback strategies after the multi-client primary
    attempt fails — so that each client gets its own chance in our pipeline
    rather than stopping at whichever client yt-dlp internally gave up on.
    For non-YouTube URLs the extractor_args override is harmless (ignored).
    """
    strategy = f"yt-dlp/{client}"
    existing_args = ydl_opts.get("extractor_args") or {}
    opts = {
        **ydl_opts,
        "extractor_args": {
            **existing_args,
            "youtube": {
                **(existing_args.get("youtube") or {}),
                "player_client": [client],
            },
        },
    }
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
        if not info:
            return _extractor_result(strategy, False, reason="yt-dlp returned no info")
        return _extractor_result(strategy, True, media=info)
    except Exception as e:  # noqa: BLE001
        msg = _safe_text(e)[:400]
        return _extractor_result(strategy, False, reason=msg or "yt-dlp failed")


def _try_platform_extractors(page_url: str, cookies: str | None) -> dict[str, Any]:
    try:
        if any(host in page_url for host in ("weibo.com", "weibo.cn", "video.weibo.com")):
            info = _extract_weibo_page(page_url, cookies)
            if info:
                return _extractor_result("platform-specific extractor", True, media=info)
            return _extractor_result("platform-specific extractor", False, reason="Weibo extractor found no media")
        if "threads.net" in page_url or "threads.com" in page_url:
            info = _extract_meta_threads(page_url, cookies)
            if info:
                return _extractor_result("platform-specific extractor", True, media=info)
            return _extractor_result("platform-specific extractor", False, reason="Threads extractor found no media")
        if "instagram.com" in page_url:
            info = _extract_meta_instagram(page_url, cookies)
            if info:
                return _extractor_result("platform-specific extractor", True, media=info)
            return _extractor_result("platform-specific extractor", False, reason="Instagram extractor found no media")
        # Japanese sites: yt-dlp handles these natively when given the right
        # Accept-Language + User-Agent. If yt-dlp already failed, we don't have
        # a better fallback here — just mark as "not handled" so the pipeline
        # continues to the HTML media detectors.
        if _is_japanese_domain(page_url):
            return _extractor_result("platform-specific extractor", False,
                                     reason="Japanese site — handled by yt-dlp with Accept-Language:ja; falling through to HTML detectors")
        return _extractor_result("platform-specific extractor", False, reason="no matching platform extractor")
    except Exception as e:  # noqa: BLE001
        return _extractor_result("platform-specific extractor", False, reason=_safe_text(e)[:400])


def _unsupported_server_strategy(strategy: str, reason: str) -> dict[str, Any]:
    return _extractor_result(strategy, False, reason=reason)


def _fetch_html_for_detection(page_url: str, headers: dict[str, str], cookies: str | None) -> tuple[str, dict[str, str]]:
    req_headers = _safe_headers({
        "User-Agent": headers.get("User-Agent") or _MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
        **({"Referer": headers.get("Referer")} if headers.get("Referer") else {}),
        **({"Origin": headers.get("Origin")} if headers.get("Origin") else {}),
        **({"Cookie": cookies} if cookies else {}),
    })
    req = urllib.request.Request(page_url, headers=req_headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return body, req_headers


def _info_from_media_url(
    media_url: str,
    page_url: str,
    headers: dict[str, str],
    title: str | None = None,
) -> dict[str, Any]:
    url = _normalize_url(html.unescape(media_url))
    ext = _guess_ext_from_url(url) or ("m3u8" if ".m3u8" in url.lower() else "mpd" if ".mpd" in url.lower() else "mp4")
    return {
        "url": url,
        "http_headers": _safe_headers({**headers, "Referer": headers.get("Referer") or page_url}),
        "title": title,
        "thumbnail": None,
        "duration": None,
        "ext": ext,
        "protocol": "m3u8_native" if ext == "m3u8" else "http_dash_segments" if ext == "mpd" else "https",
        "id": _cache_key(url),
    }


def _html_title(html_text: str) -> str | None:
    for pattern in (
        r'<meta\s+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        r"<title[^>]*>(.*?)</title>",
    ):
        m = re.search(pattern, html_text, re.IGNORECASE | re.DOTALL)
        if m:
            return re.sub(r"\s+", " ", html.unescape(m.group(1))).strip()
    return None


def _scan_media_urls(html_text: str, mode: str) -> list[str]:
    patterns: list[str] = []
    if mode in {"hls", "generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.m3u8[^"\'<>\s\\]*')
    if mode in {"dash", "generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.mpd[^"\'<>\s\\]*')
    if mode in {"generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.(?:mp4|m4v|webm|mov)[^"\'<>\s\\]*')
    if mode == "og":
        patterns.append(
            r'<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["\'](?:og:video(?::url)?|og:video:secure_url|twitter:player:stream)["\'][^>]+content\s*=\s*["\']([^"\']+)["\']'
        )
    found: list[str] = []
    variants = [
        html_text,
        html_text.replace("\\u0026", "&").replace("\\u003d", "=").replace("\\/", "/"),
    ]
    for text in variants:
        for pattern in patterns:
            for m in re.finditer(pattern, text, re.IGNORECASE | re.DOTALL):
                raw = m.group(1) if m.lastindex else m.group(0)
                raw = html.unescape(raw).replace("\\/", "/").replace("\\u0026", "&").strip()
                if raw.startswith(("http://", "https://")) and raw not in found:
                    found.append(raw)
    return found


def _try_html_media_detector(
    page_url: str,
    headers: dict[str, str],
    cookies: str | None,
    mode: str,
) -> dict[str, Any]:
    strategy = {
        "hls": "HLS manifest detector",
        "dash": "DASH manifest detector",
        "og": "OG/meta tag extractor",
        "generic": "generic media detector",
    }.get(mode, "HTML media detector")
    try:
        if mode == "hls" and ".m3u8" in page_url.lower():
            return _extractor_result(strategy, True, media=_info_from_media_url(page_url, page_url, headers))
        if mode == "dash" and ".mpd" in page_url.lower():
            return _extractor_result(strategy, True, media=_info_from_media_url(page_url, page_url, headers))

        html_text, request_headers = _fetch_html_for_detection(page_url, headers, cookies)
        title = _html_title(html_text)
        urls = _scan_media_urls(html_text, mode)
        if not urls:
            return _extractor_result(strategy, False, reason=f"{mode} detector found no media")
        media_url = urllib.parse.urljoin(page_url, urls[0])
        return _extractor_result(strategy, True, media=_info_from_media_url(media_url, page_url, request_headers, title))
    except urllib.error.URLError as e:
        return _extractor_result(strategy, False, reason=f"network error: {_safe_text(e)[:300]}")
    except TimeoutError as e:
        return _extractor_result(strategy, False, reason=f"timeout: {_safe_text(e)[:300]}")
    except Exception as e:  # noqa: BLE001
        return _extractor_result(strategy, False, reason=_safe_text(e)[:400])


def _run_ydl(
    page_url: str,
    referer: str | None = None,
    cookies: str | None = None,
    *,
    audio_only: bool = False,
    subtitles: bool = False,
    sub_langs: str = "en",
    embed_chapters: bool = False,
    concurrent_fragments: int = 1,
    proxy: str | None = None,
) -> dict[str, Any]:
    page_url = _normalize_url(page_url)
    referer = _normalize_url(referer) if referer else None
    cookies = _safe_text(cookies) if cookies else None
    parsed_url = urllib.parse.urlsplit(page_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise HTTPException(400, "invalid URL or unsupported protocol")
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
    elif any(host in page_url for host in ("weibo.com", "weibo.cn", "weibocdn.com")):
        http_headers["Referer"]    = "https://weibo.com/"
        http_headers["Origin"]     = "https://weibo.com"
        http_headers["User-Agent"] = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        )
    elif any(host in page_url for host in ("xiaohongshu.com", "xhslink.com", "xhscdn.com")):
        http_headers["Referer"]    = "https://www.xiaohongshu.com/"
        http_headers["Origin"]     = "https://www.xiaohongshu.com"
        http_headers["User-Agent"] = _MOBILE_UA
    # Japanese sites respond incorrectly (or region-block) without a Japanese
    # Accept-Language header. Set it when not already provided by the caller.
    if _is_japanese_domain(page_url) and "Accept-Language" not in http_headers:
        http_headers["Accept-Language"] = "ja,en-US;q=0.9,en;q=0.8"
    if cookies:
        http_headers["Cookie"] = cookies

    direct_media = re.search(
        r"(?:\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:[?#]|$)|bilivideo\.com/|weibocdn\.com/|xhscdn\.com/|cdninstagram\.com/|scontent[-\w]*\.cdninstagram\.com/|fbcdn\.net/|threadscdn\.com/)",
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
    #
    # NOTE: do NOT set `player_skip: ["configs"]` here — that prevents
    # yt-dlp from negotiating the player config that carries the actual
    # format URLs + signatures, and yields "Requested format is not
    # available" on EVERY video. We rely on yt-dlp master's own SABR
    # handling instead.
    # `web_creator` and `web_safari` are the two clients least likely to trip
    # YouTube's "Sign in to confirm you're not a bot" wall on datacenter IPs
    # (Fly.io). `tv` is the highest-quality non-SABR client but is the FIRST
    # to get bot-walled — keep it but list it last so retries get a chance to
    # succeed on the other clients before yt-dlp gives up.
    extractor_args: dict[str, Any] = {
        "youtube": {
            "player_client": ["web_safari", "web_creator", "mweb", "tv"],
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
        "format": (
            # Audio-only: best m4a first (most compatible), then any audio
            "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio"
            if audio_only else FORMAT_SPEC
        ),
        "skip_download": True,
        "outtmpl": "/tmp/%(id)s.%(ext)s",
        "extractor_args": extractor_args,
    }
    if concurrent_fragments > 1:
        ydl_opts["concurrent_fragment_downloads"] = concurrent_fragments
    if proxy:
        ydl_opts["proxy"] = proxy
    if subtitles:
        ydl_opts["writesubtitles"] = True
        ydl_opts["writeautomaticsub"] = True
        ydl_opts["subtitleslangs"] = [s.strip() for s in sub_langs.split(",") if s.strip()] or ["en"]
        ydl_opts["subtitlesformat"] = "srt"
    # Cookie sourcing priority:
    #  1. User-supplied `cookies` from the extension/mobile (their own logged-in
    #     session) — write to a per-request temp file so yt-dlp's cookiejar gets
    #     populated and every internal call inherits their session. This is what
    #     makes Bilibili HD / Instagram-logged-in / etc. work without us having
    #     to host shared throwaway cookies.
    #  2. Server-wide YT_COOKIES_BASE64 fallback (the throwaway YouTube account
    #     we host for users who can't supply their own cookies — primarily web
    #     app users since browser JS can't read HttpOnly cookies).
    user_cookie_file: str | None = None
    if cookies:
        user_cookie_file = _write_user_cookies_file(cookies, page_url)
        if user_cookie_file:
            ydl_opts["cookiefile"] = user_cookie_file
    elif COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts["cookiefile"] = COOKIES_FILE
    if referer:
        ydl_opts["referer"] = referer
    if http_headers:
        ydl_opts["http_headers"] = _safe_headers(http_headers)
    try:
        diagnostics: list[dict[str, Any]] = []
        # Per-client YouTube fallbacks: injected AFTER the HTML detectors so
        # each YouTube player_client gets its own independent yt-dlp attempt.
        # If the primary multi-client call stops internally on the first SABR
        # error, each client here still gets a clean shot. Only added for
        # YouTube URLs to avoid 4× overhead on every other site.
        is_youtube = any(
            x in page_url
            for x in ("youtube.com/", "youtu.be/", "youtube-nocookie.com/")
        )
        yt_client_fallbacks: list[tuple[str, Any]] = (
            [
                ("yt-dlp/mweb",        lambda: _try_ydl_client(page_url, ydl_opts, "mweb")),
                ("yt-dlp/tv",          lambda: _try_ydl_client(page_url, ydl_opts, "tv")),
                ("yt-dlp/web_safari",  lambda: _try_ydl_client(page_url, ydl_opts, "web_safari")),
                ("yt-dlp/web_creator", lambda: _try_ydl_client(page_url, ydl_opts, "web_creator")),
            ]
            if is_youtube else []
        )
        strategies: list[tuple[str, Any]] = [
            ("yt-dlp", lambda: _try_ydl(page_url, ydl_opts, force_generic=False)),
            ("platform-specific extractor", lambda: _try_platform_extractors(page_url, cookies)),
            ("WebView/runtime interception", lambda: _unsupported_server_strategy("WebView/runtime interception", "browser runtime is client-side only")),
            ("HLS manifest detector", lambda: _try_html_media_detector(page_url, http_headers, cookies, "hls")),
            ("DASH manifest detector", lambda: _try_html_media_detector(page_url, http_headers, cookies, "dash")),
            ("OG/meta tag extractor", lambda: _try_html_media_detector(page_url, http_headers, cookies, "og")),
            ("generic media detector", lambda: _try_html_media_detector(page_url, http_headers, cookies, "generic")),
            *yt_client_fallbacks,
            ("generic yt-dlp extractor", lambda: _try_ydl(page_url, ydl_opts, force_generic=True)),
            ("browser playback fallback", lambda: _unsupported_server_strategy("browser playback fallback", "browser playback fallback must run in the app WebView")),
        ]

        for idx, (name, fn) in enumerate(strategies):
            print(f"[extract] {name} start")
            result = fn()
            diagnostics.append({k: v for k, v in result.items() if k != "media"})
            if result.get("success") and result.get("media"):
                print(f"[extract] {name} success")
                print(f"[extract] extraction success via {name}")
                info = result["media"]
                if isinstance(info, dict):
                    info.setdefault("_extractor_strategy", name)
                    info.setdefault("_extractor_diagnostics", diagnostics)
                    return info
            reason = _safe_text(result.get("reason") or "no media")
            print(f"[extract] {name} failed: {reason[:240]}")
            if result.get("fatal"):
                raise HTTPException(400, reason or "fatal extraction error")
            if idx < len(strategies) - 1:
                print(f"[extract] falling back to {strategies[idx + 1][0]}")
    finally:
        # yt-dlp's cookiejar is populated when it opens the file; safe to
        # remove the temp file now regardless of how extract_info exited.
        if user_cookie_file:
            try: os.unlink(user_cookie_file)
            except Exception: pass

    reason = "; ".join(
        f"{d.get('strategy', 'extractor')}: {d.get('reason', 'failed')}"
        for d in diagnostics[-6:]
    )
    print(f"[extract] all strategies failed for {page_url}: {reason[:500]}")
    raise HTTPException(502, f"unsupported after all extraction strategies failed: {reason[:500]}")


def _run_ydl_with_format(
    page_url: str,
    referer: str | None = None,
    cookies: str | None = None,
    format_id: str | None = None,
    *,
    audio_only: bool = False,
    subtitles: bool = False,
    sub_langs: str = "en",
    embed_chapters: bool = False,
    concurrent_fragments: int = 1,
    proxy: str | None = None,
) -> dict[str, Any]:
    selected = _safe_text(format_id).strip()
    if not selected:
        return _run_ydl(
            page_url, referer=referer, cookies=cookies,
            audio_only=audio_only, subtitles=subtitles, sub_langs=sub_langs,
            embed_chapters=embed_chapters, concurrent_fragments=concurrent_fragments,
            proxy=proxy,
        )

    page_url = _normalize_url(page_url)
    referer = _normalize_url(referer) if referer else None
    cookies = _safe_text(cookies) if cookies else None
    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "format": selected,
        "skip_download": True,
        "outtmpl": "/tmp/%(id)s.%(ext)s",
    }
    if concurrent_fragments > 1:
        ydl_opts["concurrent_fragment_downloads"] = concurrent_fragments
    if proxy:
        ydl_opts["proxy"] = proxy
    http_headers: dict[str, str] = {}
    if referer:
        http_headers["Referer"] = referer
    if cookies:
        http_headers["Cookie"] = cookies

    user_cookie_file: str | None = None
    if cookies:
        user_cookie_file = _write_user_cookies_file(cookies, page_url)
        if user_cookie_file:
            ydl_opts["cookiefile"] = user_cookie_file
    elif COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts["cookiefile"] = COOKIES_FILE
    if referer:
        ydl_opts["referer"] = referer
    if http_headers:
        ydl_opts["http_headers"] = _safe_headers(http_headers)

    try:
        with YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(page_url, download=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"selected format failed: {_safe_text(e)[:400]}")
    finally:
        if user_cookie_file:
            try: os.unlink(user_cookie_file)
            except Exception: pass



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

    info = _run_ydl(
        req.pageUrl, referer=req.referer, cookies=req.cookies,
        subtitles=req.subtitles, sub_langs=req.subLangs, proxy=req.proxy,
    )

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
    # Subtitle track URLs — only populated when req.subtitles=True.
    # Each value is a dict of lang → list of {url, ext} objects.
    if req.subtitles:
        subs = info.get("subtitles") or {}
        auto = info.get("automatic_captions") or {}
        if subs or auto:
            response["subtitles"] = subs
            response["automaticCaptions"] = auto

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
                    with open(COOKIES_FILE, "r", encoding="utf-8", errors="replace") as f:
                        has_bili_cookies = any("bilibili" in line for line in f)
                except Exception:
                    pass
            print(f"[extract] WARNING: Bilibili capped at {h}p. cookies_have_bilibili={has_bili_cookies}. "
                  f"Upload a cookies.txt with bilibili.com SESSDATA to YT_COOKIES_BASE64.")

    _cache_put(cache_key, response)
    return response


# ── /download — server-muxed mp4 streamed to the client ─────────────────────


def _safe_filename_audio(title: str | None, video_id: str, ext: str = "m4a") -> str:
    """Like _safe_filename but uses the given audio extension."""
    base = unicodedata.normalize("NFC", _safe_text(title or video_id))
    s = re.sub(r'[<>:"/\\|?*\x00-\x1F\x7F]+', "", base, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip(" .")
    if not s:
        s = _safe_ascii_filename(video_id, "download")
    return f"{s[:160]}.{ext}"


def _safe_filename(title: str | None, video_id: str) -> str:
    base = unicodedata.normalize("NFC", _safe_text(title or video_id))
    # Preserve Japanese, emoji, and mixed-language titles. Only remove
    # filesystem-invalid/control characters and normalize whitespace.
    s = re.sub(r'[<>:"/\\|?*\x00-\x1F\x7F]+', "", base, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip(" .")
    if not s:
        s = _safe_ascii_filename(video_id, "download")
    return f"{s[:160]}.mp4"


def _safe_ascii_filename(value: str | None, fallback: str = "download") -> str:
    s = unicodedata.normalize("NFKD", _safe_text(value or ""))
    s = "".join(ch for ch in s if 32 <= ord(ch) <= 126)
    s = re.sub(r'[<>:"/\\|?*\x00-\x1F\x7F]+', "", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    return (s[:80] or fallback)


def _content_disposition(filename: str, fallback_stem: str = "download") -> str:
    safe = _safe_filename(filename.removesuffix(".mp4"), fallback_stem)
    fallback = _safe_ascii_filename(fallback_stem, "download")
    if not fallback.lower().endswith(".mp4"):
        fallback = f"{fallback}.mp4"
    return (
        f'attachment; filename="{fallback}"; '
        f"filename*=UTF-8''{_url_quote(safe)}"
    )


def _content_disposition_any(filename: str, fallback: str = "download") -> str:
    raw = unicodedata.normalize("NFC", _safe_text(filename))
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1F\x7F]+', "", raw, flags=re.UNICODE)
    safe = re.sub(r"\s+", " ", safe).strip(" .")[:160] or fallback
    ascii_fallback = _safe_ascii_filename(safe, fallback)
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{_url_quote(safe)}"
    )


def _ffmpeg_header_arg(headers: dict[str, str] | None) -> str | None:
    safe = _safe_headers(headers)
    if not safe:
        return None
    return "".join(f"{k}: {v}\r\n" for k, v in safe.items() if v)


def _download_headers(referer: str | None, cookies: str | None, page_url: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {}
    if referer:
        headers["Referer"] = _normalize_url(referer)
    elif page_url and ("bilibili.com" in page_url or "bilivideo.com" in page_url):
        # Bilibili CDN (upos-*.bilivideo.com) returns 403 without Referer.
        # If the caller didn't pass one, derive it from the page URL host.
        headers["Referer"] = "https://www.bilibili.com/"
        headers["Origin"]  = "https://www.bilibili.com"
    elif page_url and ("weibo.com" in page_url or "weibo.cn" in page_url or "weibocdn.com" in page_url):
        headers["Referer"] = "https://weibo.com/"
        headers["Origin"]  = "https://weibo.com"
    elif page_url and ("xiaohongshu.com" in page_url or "xhscdn.com" in page_url):
        headers["Referer"] = "https://www.xiaohongshu.com/"
        headers["Origin"]  = "https://www.xiaohongshu.com"
    if cookies:
        headers["Cookie"] = _safe_text(cookies)
    return _safe_headers(headers)


_HEADERED_DIRECT_HOSTS = (
    "bilibili.com",
    "bilivideo.com",
    "instagram.com",
    "cdninstagram.com",
    "fbcdn.net",
    "threadscdn.com",
    "weibo.com",
    "weibo.cn",
    "sinaimg.cn",
    "weibocdn.com",
    "xiaohongshu.com",
    "xhscdn.com",
)

_SINA_CDN_SUFFIXES = ("sinaimg.cn", "weibocdn.com")


def _needs_headered_direct_stream(page_url: str, media_url: str, headers: dict[str, str]) -> bool:
    combined = f"{page_url} {media_url}".lower()
    if headers.get("Cookie"):
        return True
    return any(host in combined for host in _HEADERED_DIRECT_HOSTS)


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
    video_url = _normalize_url(video_url) if video_url else video_url
    audio_url = _normalize_url(audio_url) if audio_url else audio_url
    hls_master = _normalize_url(hls_master) if hls_master else hls_master

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
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
        env=UTF8_ENV,
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


def _direct_media_stream(
    media_url: str,
    request_headers: dict[str, str],
    response_headers: dict[str, str],
) -> StreamingResponse:
    media_url = _normalize_url(media_url)
    headers = _safe_headers({
        "User-Agent": _MOBILE_UA,
        "Accept": "*/*",
        **(request_headers or {}),
    })
    try:
        upstream = _open_direct_media(media_url, headers)
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:240]
        except Exception:
            pass
        raise HTTPException(e.code, f"upstream: {body or e.reason}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"upstream: {str(e)[:240]}")

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
        except Exception as e:  # noqa: BLE001
            print(f"[direct] DoH resolver failed for {host}: {str(e)[:120]}")
    return []


def _open_https_via_ip(url: str, headers: dict[str, str]) -> http.client.HTTPResponse:
    url = _normalize_url(url)
    headers = _safe_headers(headers)
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
            conn.request("GET", path, headers=_safe_headers({**headers, "Host": host}))
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
        except Exception as e:  # noqa: BLE001
            last_error = e
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
    raise urllib.error.URLError(str(last_error or f"could not connect to {host}"))


def _open_direct_media(url: str, headers: dict[str, str]) -> Any:
    url = _normalize_url(url)
    headers = _safe_headers(headers)
    try:
        req = urllib.request.Request(url, headers=headers)
        return urllib.request.urlopen(req, timeout=30)
    except urllib.error.URLError as e:
        host = urllib.parse.urlparse(url).hostname or ""
        if host.endswith(_SINA_CDN_SUFFIXES):
            print(f"[direct] system resolver/open failed for {host}: {str(e)[:160]}; trying DoH/IP")
            return _open_https_via_ip(url, headers)
        raise


@app.get("/download")
@limiter.limit(RATE_LIMIT)
def download(
    request: Request,
    url: str = Query(..., description="Video page or player URL"),
    referer: str | None = Query(None, description="Optional Referer for domain-restricted embeds (e.g. AmusePlus → Vimeo)"),
    cookies: str | None = Query(None, description="Optional Cookie header for logged-in embeds"),
    audioOnly: bool = Query(False, description="Extract audio only (best m4a/mp3)"),
    proxy: str | None = Query(None, description="HTTP/SOCKS proxy for yt-dlp"),
) -> StreamingResponse:
    info = _run_ydl(url, referer=referer, cookies=cookies, audio_only=audioOnly, proxy=proxy)
    response = _to_response(info)
    video_id = info.get("id") or _cache_key(url)
    filename = (
        _safe_filename_audio(info.get("title"), video_id)
        if audioOnly else _safe_filename(info.get("title"), video_id)
    )

    headers = {
        "Content-Disposition": _content_disposition(filename, video_id),
        "Cache-Control": "no-store",
    }

    kind = response["kind"]
    # Client-facing headers (safe to expose in redirects): auth/cookie stripped.
    request_headers = {**(response.get("headers") or {}), **_download_headers(referer, cookies, page_url=url)}
    if kind == "paired":
        return StreamingResponse(
            _ffmpeg_stream(response["videoUrl"], response["audioUrl"], None, request_headers),
            media_type="video/mp4", headers=headers,
        )
    if kind == "hls":
        # For HLS, FFmpeg runs server-side and needs the full yt-dlp headers
        # (including any auth tokens) to fetch the manifest and segments.
        # Use info["http_headers"] directly instead of the stripped response headers.
        hls_headers = {
            **(info.get("http_headers") or {}),
            **_download_headers(referer, cookies, page_url=url),
        }
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], hls_headers),
            media_type="video/mp4", headers=headers,
        )
    # kind == "direct" → already a single mp4, redirect the browser straight to
    # googlevideo (saves server bandwidth — 100% of the bytes go phone↔CDN).
    if _needs_headered_direct_stream(url, response["url"], request_headers):
        return _direct_media_stream(response["url"], request_headers, headers)
    return RedirectResponse(response["url"], status_code=307, headers=headers)


@app.post("/download")
@limiter.limit(RATE_LIMIT)
def download_post(
    request: Request,
    req: DownloadRequest,
) -> StreamingResponse:
    info = _run_ydl_with_format(
        req.pageUrl, referer=req.referer, cookies=req.cookies, format_id=req.formatId,
        audio_only=req.audioOnly, subtitles=req.subtitles, sub_langs=req.subLangs,
        embed_chapters=req.embedChapters, concurrent_fragments=req.concurrentFragments,
        proxy=req.proxy,
    )
    response = _to_response(info)
    video_id = info.get("id") or _cache_key(req.pageUrl)
    filename = (
        _safe_filename_audio(info.get("title"), video_id)
        if req.audioOnly else _safe_filename(info.get("title"), video_id)
    )
    headers = {
        "Content-Disposition": _content_disposition(filename, video_id),
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
        hls_headers = {
            **(info.get("http_headers") or {}),
            **_download_headers(req.referer, req.cookies, page_url=req.pageUrl),
        }
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], hls_headers),
            media_type="video/mp4", headers=headers,
        )
    return _direct_media_stream(response["url"], request_headers, headers)


# ── /playlist — return flat item list for a playlist URL ─────────────────────


@app.post("/playlist")
@limiter.limit(RATE_LIMIT)
def playlist_extract(request: Request, req: PlaylistRequest) -> dict[str, Any]:
    """Return the flat item list for a YouTube/yt-dlp playlist URL.

    Uses yt-dlp's extract_flat mode — fast, no per-video network round-trips.
    Each item has: url, title, thumbnail, duration, id.
    """
    page_url = _normalize_url(req.pageUrl)
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

    user_cookie_file: str | None = None
    if req.cookies:
        user_cookie_file = _write_user_cookies_file(req.cookies, page_url)
        if user_cookie_file:
            ydl_opts["cookiefile"] = user_cookie_file
    elif COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts["cookiefile"] = COOKIES_FILE
    if req.referer:
        ydl_opts["referer"] = req.referer

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"playlist extraction failed: {_safe_text(e)[:400]}")
    finally:
        if user_cookie_file:
            try:
                os.unlink(user_cookie_file)
            except Exception:
                pass

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
        # Flat entries often give a bare video ID; resolve to full URL
        if not url.startswith("http") and entry.get("ie_key") == "Youtube":
            url = f"https://www.youtube.com/watch?v={url}"
        items.append({
            "id":        entry.get("id"),
            "url":       url,
            "title":     entry.get("title"),
            "thumbnail": entry.get("thumbnail") or entry.get("thumbnails", [{}])[-1].get("url") if entry.get("thumbnails") else None,
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
    elif "weibocdn" in host or "weibo.com" in host or "weibo.cn" in host:
        h["Referer"] = "https://weibo.com/"
        h["Origin"]  = "https://weibo.com"
    elif "xhscdn" in host or "xiaohongshu" in host:
        h["Referer"] = "https://www.xiaohongshu.com/"
        h["Origin"]  = "https://www.xiaohongshu.com"
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
    url = _normalize_url(url)
    referer = _normalize_url(referer) if referer else None
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must be absolute http(s)")
    headers = _safe_headers(_default_proxy_headers(url, referer))
    if cookies:
        headers["Cookie"] = _safe_header_value("Cookie", cookies)

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
        out_headers["Content-Disposition"] = _content_disposition_any(filename)
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
    key = _cache_key(_normalize_url(page_url))
    if referer:
        key += "|" + _normalize_url(referer)
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
                "thumbnail":     entry.get("thumbnail"),
                "duration":      entry.get("duration"),
                "extractor":     entry.get("extractor"),
                "formatId":      "+".join([_safe_text(video.get("format_id")), _safe_text(audio.get("format_id"))]).strip("+"),
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
            "thumbnail": entry.get("thumbnail"),
            "duration": entry.get("duration"),
            "extractor": entry.get("extractor"),
            "formatId": entry.get("format_id"),
        })

    return {"kind": "gallery", "items": items, "count": len(items)}


def _format_options(info: dict[str, Any]) -> list[dict[str, Any]]:
    formats = info.get("formats") or []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for f in formats:
        if not isinstance(f, dict):
            continue
        fid = _safe_text(f.get("format_id"))
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
            "fps":            f.get("fps"),
            "vcodec":         f.get("vcodec"),
            "acodec":         f.get("acodec"),
            "filesize":       f.get("filesize"),
            "filesizeApprox": f.get("filesize_approx"),
        })
    return out


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
            "extractor":     info.get("extractor"),
            "formatId":      "+".join([_safe_text(video.get("format_id")), _safe_text(audio.get("format_id"))]).strip("+"),
            "formats":       _format_options(info),
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
            "extractor": info.get("extractor"),
            "formatId": info.get("format_id"),
            "formats":  _format_options(info),
        }

    return {
        "kind":     "direct",
        "url":      url,
        "headers":  _headers_for(info),
        "label":    _label_for(info),
        "mimeType": _mime_for(info),
        "expire":   _expire_of(url),
        "extractor": info.get("extractor"),
        "formatId": info.get("format_id"),
        "formats":  _format_options(info),
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
    return _safe_headers(h)


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

"""
Centralised configuration for fcdownloader-extractor.

All environment-variable reads and startup side-effects live here so the rest
of the codebase never calls os.environ directly.
"""
from __future__ import annotations

import base64
import os
import tempfile

# ── Auth ────────────────────────────────────────────────────────────────────

# Optional bearer token.  Devices that present this bypass rate limiting.
# Not a security boundary (APK-embedded tokens leak on decompile), just a
# convenience tier for your own test harness.
TRUSTED_TOKEN: str = os.environ.get("TRUSTED_TOKEN", "").strip()

# ── Cookies ──────────────────────────────────────────────────────────────────

# Server-wide shared cookies file path (YT_COOKIES_FILE env var) or decoded
# from YT_COOKIES_BASE64.  Used when the caller doesn't supply their own
# session cookies — primarily web-app users who can't read HttpOnly cookies.
COOKIES_FILE: str = os.environ.get("YT_COOKIES_FILE", "").strip()

_COOKIES_B64: str = os.environ.get("YT_COOKIES_BASE64", "").strip()
if _COOKIES_B64 and not COOKIES_FILE:
    try:
        _tmp = tempfile.NamedTemporaryFile(
            mode="wb", suffix="-cookies.txt", delete=False
        )
        _tmp.write(base64.b64decode(_COOKIES_B64))
        _tmp.close()
        COOKIES_FILE = _tmp.name
        print(f"[startup] cookies decoded to {COOKIES_FILE}")
    except Exception as exc:  # noqa: BLE001
        print(f"[startup] WARNING: failed to decode YT_COOKIES_BASE64: {exc}")

# Maximum cookie blob size accepted from callers (bytes).
# Protects against oversized payloads that could DoS cookie parsing or
# exceed Netscape cookie-file line limits.
COOKIE_MAX_BYTES: int = 32 * 1024  # 32 KB

# ── Rate limiting ─────────────────────────────────────────────────────────────

RATE_LIMIT: str = os.environ.get(
    "RATE_LIMIT", "30/minute;300/hour;1500/day"
)

# ── Cache ─────────────────────────────────────────────────────────────────────

CACHE_TTL: int = int(os.environ.get("CACHE_TTL", "300"))   # seconds
CACHE_MAX: int = int(os.environ.get("CACHE_MAX", "2000"))  # entries

# ── yt-dlp format specs ───────────────────────────────────────────────────────

# Primary extraction format spec — tiered from "ideal for Android MediaMuxer"
# down to "anything yt-dlp can produce".  MediaMuxer needs h264+aac in mp4;
# the higher tiers target that pair.  Lower tiers accept any codec/container
# so we don't fail entire videos when YouTube only serves vp9/opus.
FORMAT_SPEC: str = (
    "bv*[height<=1080][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/"
    "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/"
    "bv*[height<=1080]+ba/"
    "b[ext=mp4][height<=1080]/"
    "b[height<=1080]/"
    "b"
)

# Server-side stream proxy format spec.  Prefer pre-muxed files (single
# download, no FFmpeg merge) so the temp-file download on the 512 MB Fly VM
# finishes faster.  Format 18 = YouTube legacy 360p pre-muxed MP4.
STREAM_FORMAT_SPEC: str = (
    "18/"
    "b[height<=480][ext=mp4]/"
    "bv*[height<=720][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/"
    "bv*[height<=720]+ba/"
    "best[height<=720]/"
    "bv*+ba/"
    "best"
)

# ── Server identity ───────────────────────────────────────────────────────────

SERVER_BASE_URL: str = os.environ.get(
    "SERVER_URL", "https://fcdownloader-extractor.fly.dev"
).rstrip("/")

# ── CORS ──────────────────────────────────────────────────────────────────────

_allowed = os.environ.get("ALLOWED_ORIGINS", "*").strip()
ALLOWED_ORIGINS: list[str] = (
    ["*"] if _allowed == "*"
    else [o.strip() for o in _allowed.split(",") if o.strip()]
)

# ── Stream supervisor limits ──────────────────────────────────────────────────

# Hard cap on concurrent yt-dlp download processes on the VM.
# Fly's shared-cpu-1x has 512 MB RAM; each yt-dlp download is ~100-300 MB.
MAX_CONCURRENT_STREAMS: int = int(os.environ.get("MAX_CONCURRENT_STREAMS", "4"))

# Total wall-clock timeout for a /ytdl-stream download (seconds).
STREAM_DOWNLOAD_TIMEOUT: int = int(os.environ.get("STREAM_DOWNLOAD_TIMEOUT", "300"))

# ── User agent ────────────────────────────────────────────────────────────────

MOBILE_UA: str = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.0 Mobile/15E148 Safari/604.1"
)

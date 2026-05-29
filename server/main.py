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
import json
import os
import re
import shlex
import signal
import socket
import ssl
import subprocess
import sys
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
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from yt_dlp import YoutubeDL
from yt_dlp.version import __version__ as YT_DLP_VERSION

import auth
import extractors
import languages
import registry
import supervisor
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
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_extension_origin_regex = r"^(chrome|moz|safari-web|edge)-extension://[a-zA-Z0-9_-]+$"
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=_extension_origin_regex,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-FCDL-Cookies"],
    expose_headers=["Content-Disposition", "Content-Length", "X-Request-ID"],
)

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
        "m4a": "audio/mp4",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mkv": "video/x-matroska",
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
            "expire":        expire_of(video["url"]),
            "extractor":     info.get("extractor"),
            "formatId":      "+".join([
                safe_text(video.get("format_id")),
                safe_text(audio.get("format_id")),
            ]).strip("+"),
            "formats": _format_options(info),
        }

    url = info.get("url")
    if not url:
        raise HTTPException(502, "yt-dlp info had no url")

    if looks_like_hls(url, info.get("protocol")):
        return {
            "kind":      "hls",
            "url":       url,
            "headers":   _headers_for(info),
            "label":     _label_for(info),
            "mimeType":  "application/x-mpegURL",
            "expire":    expire_of(url),
            "extractor": info.get("extractor"),
            "formatId":  info.get("format_id"),
            "formats":   _format_options(info),
        }

    return {
        "kind":      "direct",
        "url":       url,
        "headers":   _headers_for(info),
        "label":     _label_for(info),
        "mimeType":  _mime_for(info),
        "expire":    expire_of(url),
        "extractor": info.get("extractor"),
        "formatId":  info.get("format_id"),
        "formats":   _format_options(info),
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
            url = entry["formats"][-1].get("url")
        if not url:
            continue

        ext = (entry.get("ext") or guess_ext_from_url(url) or "").lower()
        is_image = ext in _IMAGE_EXTS
        items.append(_without_thumbnail_fields({
            "kind":      "image" if is_image else ("hls" if looks_like_hls(url, entry.get("protocol")) else "direct"),
            "url":       url,
            "headers":   _headers_for(entry),
            "label":     _label_for(entry),
            "ext":       ext or ("mp4" if not is_image else "jpg"),
            "mimeType":  _mime_for(entry) if not is_image else f"image/{ext or 'jpeg'}",
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
    "xiaohongshu.com", "xhscdn.com",
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
    r"(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.webm|\.mov|\.mp3|\.m4a|\.aac|\.wav|\.ogg|\.opus|\.flac)(?:[?#]|$)|"
    r"(?:v\.redd\.it|cdninstagram\.com|fbcdn\.net|threadscdn\.com|bilivideo\.com|xhscdn\.com|"
    r"kakaocdn\.net|daumcdn\.net|pstatic\.net|naver\.net|abema(?:tv)?\.akamaized\.net|"
    r"brightcove\.net|boltdns\.net|bcovlive-a\.akamaihd\.net)",
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
    if looks_like_hls(url, None) or path.endswith(".m3u8"):
        return "hls"
    if path.endswith((".mp4", ".m4v", ".webm", ".mov", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac")):
        return "direct"
    return ""


def _info_from_media_hints(page_url: str, hints: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in hints or []:
        if not isinstance(raw, dict):
            continue
        url = normalize_url(safe_text(raw.get("url")))
        if not url.startswith(("http://", "https://")):
            continue
        if not _MEDIA_HINT_HOST_RE.search(url):
            continue
        if url in seen:
            continue
        seen.add(url)
        kind = safe_text(raw.get("kind")).lower() or _direct_media_url_kind(url) or "direct"
        if kind == "dash":
            protocol = "http_dash_segments"
        elif kind == "hls" or looks_like_hls(url):
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
            "ext": guess_ext_from_url(url) or ("mp4" if kind != "audio" else "m4a"),
            "protocol": protocol,
            "http_headers": headers,
            "extractor": "browser-captured",
        })
        if len(entries) >= 20:
            break
    if not entries:
        return None
    if len(entries) == 1:
        return entries[0]
    return {
        "_type": "playlist",
        "title": "Captured media",
        "webpage_url": page_url,
        "extractor": "browser-captured",
        "entries": entries,
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
    elif page_url and any(h in page_url for h in ("xiaohongshu.com", "xhscdn.com")):
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
    url = normalize_url(url)
    headers = safe_headers(headers)
    try:
        req = urllib.request.Request(url, headers=headers)
        return urllib.request.urlopen(req, timeout=30)
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
    if (cached := _cache_get(cache_key_str)) is not None:
        return cached

    ctx = make_context("/extract", req.pageUrl, auth_provided=bool(req.cookies))

    try:
        info = None
        if req.pageHtml:
            info = extractors.extract_curated_site(req.pageUrl, req.cookies, page_html=req.pageHtml)
        if not info:
            info = _info_from_media_hints(req.pageUrl, req.mediaHints)
        if not info:
            info = run_extraction(
                req.pageUrl,
                referer=req.referer,
                cookies=req.cookies,
                subtitles=req.subtitles,
                sub_langs=req.subLangs,
                proxy=req.proxy,
                ctx=ctx,
            )
    except HTTPException:
        ctx.emit(status="error")
        raise

    if info.get("_type") == "playlist" and info.get("entries"):
        response = _to_gallery_response(info)
        response["title"] = info.get("title")
        _cache_put(cache_key_str, response)
        print(f"[extract] gallery: {len(response['items'])} item(s)")
        ctx.emit()
        return response

    response = _to_response(info)
    response["title"]     = info.get("title")
    response["thumbnail"] = None
    response["duration"]  = info.get("duration")

    if req.subtitles:
        subs = info.get("subtitles") or {}
        auto = info.get("automatic_captions") or {}
        if subs or auto:
            response["subtitles"]         = subs
            response["automaticCaptions"] = auto

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
        return _direct_media_stream(req.pageUrl, request_headers, headers)

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
    return _direct_media_stream(response["url"], request_headers, headers)


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
    elif "xhscdn" in host or "xiaohongshu" in host:
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
    url = normalize_url(url)
    referer = normalize_url(referer) if referer else None
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must be absolute http(s)")

    headers = safe_headers({**_default_proxy_headers(url, referer), **safe_headers(replay_headers or {})})
    if cookies:
        headers["Cookie"] = safe_header_value("Cookie", cookies)

    try:
        req = urllib.request.Request(url, headers=headers)
        upstream = urllib.request.urlopen(req, timeout=30)
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

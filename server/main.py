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
  GET  /ytdl-stream     → server-side yt-dlp download proxy for YouTube SABR
  POST /playlist        → flat item list for a playlist URL
  GET  /proxy           → stream a CDN media URL with auth headers
  GET  /debug           → diagnostic endpoint (requires TRUSTED_TOKEN)
"""
from __future__ import annotations

import http.client
import json
import os
import re
import shlex
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from yt_dlp import YoutubeDL
from yt_dlp.version import __version__ as YT_DLP_VERSION

import auth
import supervisor
from config import (
    ALLOWED_ORIGINS,
    CACHE_MAX,
    CACHE_TTL,
    COOKIES_FILE,
    FORMAT_SPEC,
    MOBILE_UA,
    RATE_LIMIT,
    TRUSTED_TOKEN,
)
from models import DownloadRequest, ExtractRequest, PlaylistRequest
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
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_extension_origin_regex = r"^(chrome|moz|safari-web|edge)-extension://[a-zA-Z0-9_-]+$"
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=_extension_origin_regex,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
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
            items.append({
                "kind":      "paired",
                "videoUrl":  video["url"],
                "audioUrl":  audio["url"],
                "headers":   _headers_for(video),
                "label":     _label_for(video),
                "ext":       video.get("ext") or "mp4",
                "title":     entry.get("title"),
                "thumbnail": entry.get("thumbnail"),
                "duration":  entry.get("duration"),
                "extractor": entry.get("extractor"),
                "formatId":  "+".join([
                    safe_text(video.get("format_id")),
                    safe_text(audio.get("format_id")),
                ]).strip("+"),
            })
            continue

        url = entry.get("url")
        if not url and entry.get("formats"):
            url = entry["formats"][-1].get("url")
        if not url:
            continue

        ext = (entry.get("ext") or guess_ext_from_url(url) or "").lower()
        is_image = ext in _IMAGE_EXTS
        items.append({
            "kind":      "image" if is_image else ("hls" if looks_like_hls(url, entry.get("protocol")) else "direct"),
            "url":       url,
            "headers":   _headers_for(entry),
            "label":     _label_for(entry),
            "ext":       ext or ("mp4" if not is_image else "jpg"),
            "mimeType":  _mime_for(entry) if not is_image else f"image/{ext or 'jpeg'}",
            "title":     entry.get("title"),
            "thumbnail": entry.get("thumbnail"),
            "duration":  entry.get("duration"),
            "extractor": entry.get("extractor"),
            "formatId":  entry.get("format_id"),
        })

    return {"kind": "gallery", "items": items, "count": len(items)}


# ── Download helpers ──────────────────────────────────────────────────────────

_HEADERED_DIRECT_HOSTS = (
    "bilibili.com", "bilivideo.com",
    "instagram.com", "cdninstagram.com", "fbcdn.net", "threadscdn.com",
    "weibo.com", "weibo.cn", "sinaimg.cn", "weibocdn.com",
    "xiaohongshu.com", "xhscdn.com",
)

_SINA_CDN_SUFFIXES = ("sinaimg.cn", "weibocdn.com")


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
) -> Iterator[bytes]:
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
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


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
        if host.endswith(_SINA_CDN_SUFFIXES):
            print(f"[direct] system resolver failed for {host}: {str(exc)[:160]}; trying DoH/IP")
            return _open_https_via_ip(url, headers)
        raise


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
        "cached":     len(_cache),
        "rate_limit": RATE_LIMIT,
        "cache_ttl":  CACHE_TTL,
    }


@app.get("/version")
def version() -> dict[str, Any]:
    return {
        "ok":             True,
        "service":        "fcdownloader-extractor",
        "yt_dlp":         YT_DLP_VERSION,
        "ffmpeg":         _ffmpeg_version(),
        "cookies_loaded": bool(COOKIES_FILE and os.path.exists(COOKIES_FILE)),
    }


# ── /extract ──────────────────────────────────────────────────────────────────


@app.post("/extract")
@limiter.limit(RATE_LIMIT)
def extract(request: Request, req: ExtractRequest) -> dict[str, Any]:
    cache_key_str = request_cache_key(req.pageUrl, req.referer, req.cookies)
    if (cached := _cache_get(cache_key_str)) is not None:
        return cached

    ctx = make_context("/extract", req.pageUrl, auth_provided=bool(req.cookies))

    try:
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
    response["thumbnail"] = info.get("thumbnail")
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
    audioOnly: bool = Query(False),
    proxy: str | None = Query(None),
) -> StreamingResponse:
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
    kind = response["kind"]
    if kind == "paired":
        return StreamingResponse(
            _ffmpeg_stream(response["videoUrl"], response["audioUrl"], None, request_headers),
            media_type="video/mp4", headers=headers,
        )
    if kind == "hls":
        hls_headers = {
            **(info.get("http_headers") or {}),
            **_download_headers(referer, cookies, page_url=url),
        }
        return StreamingResponse(
            _ffmpeg_stream("", None, response["url"], hls_headers),
            media_type="video/mp4", headers=headers,
        )
    if _needs_headered_direct_stream(url, response["url"], request_headers):
        return _direct_media_stream(response["url"], request_headers, headers)
    return RedirectResponse(response["url"], status_code=307, headers=headers)


@app.post("/download")
@limiter.limit(RATE_LIMIT)
def download_post(request: Request, req: DownloadRequest) -> StreamingResponse:
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
    page_url: str = Query(..., description="YouTube page URL to stream"),
    cookies: str | None = Query(None, description="Optional YouTube session cookies"),
) -> StreamingResponse:
    page_url = normalize_url(page_url)
    if not page_url:
        raise HTTPException(400, "page_url is required")
    if not any(x in page_url for x in ("youtube.com/", "youtu.be/", "youtube-nocookie.com/")):
        raise HTTPException(400, "ytdl-stream only supports YouTube URLs")

    cookies_val = safe_text(cookies) if cookies else None

    # Cookie size validation before handing off to supervisor.
    if cookies_val:
        try:
            auth.validate_cookies(cookies_val)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))

    # Block here: download finishes before we return StreamingResponse.
    # This prevents the 0-byte 200 OK race condition.
    tmpdir, filepath, filesize, filename = supervisor.ytdl_download(
        page_url, cookies_val
    )

    return StreamingResponse(
        supervisor.stream_file(tmpdir, filepath),
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(filesize),
            "Cache-Control": "no-cache, no-store",
        },
    )


# ── /playlist ─────────────────────────────────────────────────────────────────


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
            "thumbnail": (
                entry.get("thumbnail")
                or (entry.get("thumbnails", [{}])[-1].get("url") if entry.get("thumbnails") else None)
            ),
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
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        h["Referer"] = referer
    elif "cdninstagram" in host or "fbcdn" in host:
        h["Referer"] = "https://www.instagram.com/"
    elif "threadscdn" in host:
        h["Referer"] = "https://www.threads.com/"
    elif "bilivideo" in host or "bilibili" in host:
        h["Referer"] = "https://www.bilibili.com/"
        h["Origin"]  = "https://www.bilibili.com"
    elif "weibocdn" in host or "weibo" in host:
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
    filename: str | None = Query(None),
) -> StreamingResponse:
    url = normalize_url(url)
    referer = normalize_url(referer) if referer else None
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must be absolute http(s)")

    headers = safe_headers(_default_proxy_headers(url, referer))
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

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = "127.0.0.1"
PORT = 8765
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FORMAT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/best[ext=mp4]/best"
YOUTUBE_FORMAT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/137+140/136+140/18"
MAX_URL_LENGTH = 4096
SERVICE_VERSION = "0.2.1"
LOCAL_HELPER_API_VERSION = "v1"
YTDLP_DELEGATE_FLAG = "--fcdl-run-yt-dlp"
COOKIE_MAX_BYTES = 32 * 1024
FFMPEG_BASE_URL = "https://raw.githubusercontent.com/imageio/imageio-binaries/master/ffmpeg"
FFMPEG_FILENAMES = {
    "windows-x86_64": "ffmpeg-win-x86_64-v7.1.exe",
    "windows-i686": "ffmpeg-win32-v4.2.2.exe",
    "macos-aarch64": "ffmpeg-macos-aarch64-v7.1",
    "macos-x86_64": "ffmpeg-macos-x86_64-v7.1",
    "linux-aarch64": "ffmpeg-linux-aarch64-v7.0.2",
    "linux-x86_64": "ffmpeg-linux-x86_64-v7.0.2",
}
FFMPEG_SHA256 = {
    "ffmpeg-win-x86_64-v7.1.exe": "2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3",
}
EXTENSION_ORIGIN_RE = re.compile(r"^(chrome|moz|safari-web|edge)-extension://[A-Za-z0-9_-]+$")


def _ffmpeg_path() -> str:
    explicit = os.environ.get("FCDL_FFMPEG_EXE") or os.environ.get("IMAGEIO_FFMPEG_EXE")
    if explicit:
        return explicit

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg and _is_valid_ffmpeg(system_ffmpeg):
        return system_ffmpeg

    cached = _cached_ffmpeg_path()
    if cached.exists() and _is_valid_ffmpeg(str(cached)):
        return str(cached)

    return str(_download_ffmpeg(cached))


def _platform_key() -> str:
    if sys.platform.startswith("win"):
        os_name = "windows"
    elif sys.platform.startswith("darwin"):
        os_name = "macos"
    elif sys.platform.startswith("linux"):
        os_name = "linux"
    else:
        os_name = sys.platform

    is_64_bit = sys.maxsize > 2**32
    machine = platform.machine().lower()
    if machine == "armv7l":
        arch = "armv7"
    elif is_64_bit and machine.startswith(("arm", "aarch64")):
        arch = "aarch64"
    elif is_64_bit:
        arch = "x86_64"
    else:
        arch = "i686"
    return f"{os_name}-{arch}"


def _cache_root() -> Path:
    override = os.environ.get("FCDL_FFMPEG_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "FCDownloader" / "ffmpeg"
    if sys.platform.startswith("darwin"):
        return Path.home() / "Library" / "Caches" / "FCDownloader" / "ffmpeg"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "fcdownloader" / "ffmpeg"


def _cached_ffmpeg_path() -> Path:
    filename = FFMPEG_FILENAMES.get(_platform_key())
    if not filename:
        raise RuntimeError(f"No bundled ffmpeg download is configured for {_platform_key()}")
    return _cache_root() / filename


def _is_valid_ffmpeg(exe: str) -> bool:
    try:
        subprocess.run(
            [exe, "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=True,
        )
        return True
    except Exception:
        return False


def _available_ffmpeg_path() -> str | None:
    explicit = os.environ.get("FCDL_FFMPEG_EXE") or os.environ.get("IMAGEIO_FFMPEG_EXE")
    if explicit and _is_valid_ffmpeg(explicit):
        return explicit

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg and _is_valid_ffmpeg(system_ffmpeg):
        return system_ffmpeg

    try:
        cached = _cached_ffmpeg_path()
    except Exception:
        return None
    if cached.exists() and _is_valid_ffmpeg(str(cached)):
        return str(cached)
    return None


def _is_valid_yt_dlp() -> bool:
    try:
        subprocess.run(
            _yt_dlp_command(["--version"]),
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=True,
        )
        return True
    except Exception:
        return False


def _tool_status() -> dict[str, Any]:
    ffmpeg = _available_ffmpeg_path()
    yt_dlp_ok = _is_valid_yt_dlp()
    tools = [
        {
            "name": "yt-dlp",
            "ok": yt_dlp_ok,
            "required": True,
        },
        {
            "name": "ffmpeg",
            "ok": bool(ffmpeg),
            "path": ffmpeg,
            "required": True,
        },
    ]
    return {
        "ok": all(tool["ok"] for tool in tools),
        "tools": tools,
        "needsSetup": not all(tool["ok"] for tool in tools),
    }


def _ensure_tools() -> dict[str, Any]:
    if not _is_valid_yt_dlp():
        raise RuntimeError("yt-dlp is not available in the helper runtime")
    ffmpeg = _ffmpeg_path()
    return {
        "ok": True,
        "tools": [
            {"name": "yt-dlp", "ok": True, "required": True},
            {"name": "ffmpeg", "ok": True, "path": ffmpeg, "required": True},
        ],
        "needsSetup": False,
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download_ffmpeg(target: Path) -> Path:
    filename = target.name
    base_url = os.environ.get("FCDL_FFMPEG_BASE_URL", FFMPEG_BASE_URL).rstrip("/")
    url = f"{base_url}/{filename}"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".download")

    print(f"[local-helper] downloading ffmpeg: {url}", flush=True)
    try:
        with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as fh:
            shutil.copyfileobj(response, fh, length=1024 * 1024)

        expected = FFMPEG_SHA256.get(filename)
        if not expected and os.environ.get("FCDL_ALLOW_UNVERIFIED_FFMPEG") != "1":
            raise RuntimeError(
                f"No trusted checksum is configured for {filename}; install ffmpeg "
                "manually or set FCDL_ALLOW_UNVERIFIED_FFMPEG=1 to opt in."
            )
        if expected and _sha256(tmp).lower() != expected:
            raise RuntimeError("Downloaded ffmpeg checksum did not match the expected hash")

        if not sys.platform.startswith("win"):
            tmp.chmod(tmp.stat().st_mode | 0o755)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)

    if not _is_valid_ffmpeg(str(target)):
        target.unlink(missing_ok=True)
        raise RuntimeError("Downloaded ffmpeg could not be executed")
    return target


def _python_path() -> str:
    venv_python = ROOT / ".venv" / "Scripts" / "python.exe"
    return str(venv_python) if venv_python.exists() else sys.executable


def _yt_dlp_command(args: list[str]) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, YTDLP_DELEGATE_FLAG, *args]
    return [_python_path(), "-m", "yt_dlp", *args]


def _allowed_origin(handler: BaseHTTPRequestHandler) -> str | None:
    origin = (handler.headers.get("Origin") or "").strip()
    if not origin:
        return None
    if EXTENSION_ORIGIN_RE.match(origin):
        return origin
    try:
        parsed = urllib.parse.urlparse(origin)
    except Exception:
        return None
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return origin
    configured = {
        item.strip().rstrip("/")
        for item in os.environ.get("FCDL_LOCAL_HELPER_ORIGINS", "").split(",")
        if item.strip()
    }
    return origin if origin.rstrip("/") in configured else None


def _send_cors_headers(handler: BaseHTTPRequestHandler) -> None:
    origin = _allowed_origin(handler)
    if origin:
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")


def _validate_cookie_header(cookies: str | None) -> str | None:
    if not cookies:
        return None
    raw = cookies.strip()
    if not raw:
        return None
    if len(raw.encode("utf-8", errors="replace")) > COOKIE_MAX_BYTES:
        raise ValueError(f"cookie payload exceeds {COOKIE_MAX_BYTES // 1024} KB limit")
    if not any("=" in part for part in raw.split(";")):
        raise ValueError("no valid name=value cookie pairs found")
    return raw


def _cookie_domains_for_url(url: str) -> list[str]:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if host.endswith(("bilibili.com", "bilibili.tv")) or host in {"b23.tv"}:
        return [".bilibili.com", ".bilivideo.com", ".b23.tv", ".bilibili.tv"]
    parts = host.split(".")
    if len(parts) > 2 and len(parts[-1]) >= 2:
        return ["." + ".".join(parts[-2:])]
    return [f".{host}"] if host else []


def _write_cookie_file(cookies: str | None, page_url: str) -> str | None:
    validated = _validate_cookie_header(cookies)
    if not validated:
        return None
    domains = _cookie_domains_for_url(page_url)
    if not domains:
        return None

    import time

    fd, cookie_path = tempfile.mkstemp(suffix="-user-cookies.txt", prefix="fcdl_local_")
    try:
        os.chmod(cookie_path, 0o600)
        expiry = int(time.time()) + 86400
        with os.fdopen(fd, "w", encoding="utf-8", errors="replace") as fh:
            fh.write("# Netscape HTTP Cookie File\n")
            fh.write("# Generated by FCDownloader local helper per request\n")
            for raw in validated.split(";"):
                raw = raw.strip()
                if not raw or "=" not in raw:
                    continue
                name, _, value = raw.partition("=")
                name = _cookie_field(name.strip())
                value = _cookie_field(value.strip())
                if not name:
                    continue
                for domain in domains:
                    fh.write(f"{domain}\tTRUE\t/\tFALSE\t{expiry}\t{name}\t{value}\n")
    except Exception:
        try:
            os.close(fd)
        except Exception:
            pass
        try:
            os.unlink(cookie_path)
        except Exception:
            pass
        raise
    return cookie_path


def _cookie_field(value: str) -> str:
    return value.replace("\t", "").replace("\r", "").replace("\n", "")


def _json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    _send_cors_headers(handler)
    handler.end_headers()
    handler.wfile.write(body)


def _safe_name(value: str) -> str:
    keep = []
    for ch in value:
        keep.append(ch if ch.isascii() and (ch.isalnum() or ch in " ._-()") else "_")
    out = "".join(keep).strip(" ._")
    return out[:160] or "fcdownloader-media"


def _is_allowed_url(url: str) -> bool:
    if not url or len(url) > MAX_URL_LENGTH:
        return False
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    if not host or host in {"localhost", "127.0.0.1", "::1"}:
        return False
    return True


def _is_youtube_url(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return host.endswith("youtube.com") or host == "youtu.be" or host.endswith("youtube-nocookie.com")


def _is_bilibili_url(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return host.endswith("bilibili.com") or host in {"b23.tv", "bilibili.tv"} or host.endswith("bilibili.tv")


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except Exception:
        return None


def _bilibili_headers_args(url: str) -> list[str]:
    if not _is_bilibili_url(url):
        return []
    return [
        "--referer",
        "https://www.bilibili.com/",
        "--add-header",
        "Origin:https://www.bilibili.com",
        "--add-header",
        "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    ]


def _format_spec(url: str, max_height: str | None, remove_watermark: bool = False) -> str:
    height = max_height if max_height and re.fullmatch(r"\d{3,4}", max_height) else "1080"
    if _is_youtube_url(url):
        return YOUTUBE_FORMAT
    if _is_bilibili_url(url):
        # Bilibili HD is usually DASH video+audio. Prefer H.264/MP4 where
        # available so the helper can remux into a broadly playable MP4.
        return (
            f"bv*[height<={height}][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/"
            f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/"
            f"bv*[height<={height}]+ba/"
            f"b[height<={height}][ext=mp4]/b[height<={height}]/best"
        )
    if max_height and re.fullmatch(r"\d{3,4}", max_height):
        return (
            f"bv*[height<={max_height}][ext=mp4]+ba[ext=m4a]/"
            f"bv*[height<={max_height}]+ba/best[height<={max_height}]/best"
        )
    return DEFAULT_FORMAT


def _helper_port() -> int:
    raw = os.environ.get("FCDL_HELPER_PORT", "").strip()
    if raw.isdigit():
        return int(raw)
    return PORT


def _extract_formats(url: str, cookies: str | None = None) -> dict[str, Any]:
    cookie_file = _write_cookie_file(cookies, url)
    cmd = _yt_dlp_command([
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--js-runtimes",
        "node",
        "--remote-components",
        "ejs:github",
        *_bilibili_headers_args(url),
        *(["--cookies", cookie_file] if cookie_file else []),
        url,
    ])
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
    finally:
        if cookie_file:
            Path(cookie_file).unlink(missing_ok=True)
    if proc.returncode != 0:
        if _is_bilibili_url(url):
            return _bili_api_formats(url, cookies)
        raise RuntimeError((proc.stderr or proc.stdout)[-2000:])

    data = json.loads(proc.stdout)
    raw_formats = data.get("formats") or []
    formats = []
    for fmt in raw_formats:
        format_id = str(fmt.get("format_id") or "")
        if not format_id:
            continue
        height = _int(fmt.get("height"))
        ext = fmt.get("ext")
        vcodec = fmt.get("vcodec")
        acodec = fmt.get("acodec")
        filesize = _int(fmt.get("filesize") or fmt.get("filesize_approx"))
        formats.append({
            "formatId": format_id,
            "label": fmt.get("format_note") or fmt.get("resolution") or (f"{height}p" if height else format_id),
            "height": height,
            "ext": ext,
            "vcodec": vcodec,
            "acodec": acodec,
            "filesize": filesize,
            "protocol": fmt.get("protocol"),
        })

    return {
        "ok": True,
        "service": "fcdownloader-local-helper",
        "extractor": data.get("extractor_key") or data.get("extractor"),
        "title": data.get("title"),
        "thumbnail": data.get("thumbnail"),
        "id": data.get("id"),
        "webpageUrl": data.get("webpage_url") or url,
        "duration": data.get("duration"),
        "formats": formats,
    }


def _bili_api_headers(page_url: str, cookies: str | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Referer": page_url or "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
    }
    if cookies and cookies.strip():
        headers["Cookie"] = cookies.strip()
    return headers


def _bili_fetch_json(api_url: str, page_url: str, cookies: str | None = None) -> dict[str, Any]:
    req = urllib.request.Request(api_url, headers=_bili_api_headers(page_url, cookies))
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read(8 * 1024 * 1024).decode("utf-8", errors="replace"))


def _bili_bvid(url: str) -> str:
    match = re.search(r"\bBV[0-9A-Za-z]+", url, re.I)
    return match.group(0) if match else ""


def _bili_resolve_bvid(page_url: str, cookies: str | None = None) -> str:
    bvid = _bili_bvid(page_url)
    if bvid:
        return bvid
    try:
        req = urllib.request.Request(page_url, headers=_bili_api_headers("https://www.bilibili.com/", cookies))
        with urllib.request.urlopen(req, timeout=15) as resp:
            bvid = _bili_bvid(resp.geturl())
            if bvid:
                return bvid
            return _bili_bvid(resp.read(512 * 1024).decode("utf-8", errors="replace"))
    except Exception:
        return ""


def _bili_api_data(page_url: str, cookies: str | None = None) -> dict[str, Any]:
    bvid = _bili_resolve_bvid(page_url, cookies)
    if not bvid:
        raise RuntimeError("Bilibili URL did not contain a BV id")
    view_url = "https://api.bilibili.com/x/web-interface/view?" + urllib.parse.urlencode({"bvid": bvid})
    view = _bili_fetch_json(view_url, page_url, cookies)
    if view.get("code") != 0:
        raise RuntimeError(f"Bilibili view API failed: {view.get('message') or view.get('msg') or view.get('code')}")
    data = view.get("data") or {}
    cid = data.get("cid")
    aid = data.get("aid")
    if not cid:
        raise RuntimeError("Bilibili view API returned no cid")

    query = {
        "bvid": bvid,
        "cid": str(cid),
        "qn": "120",
        "fnval": "4048",
        "fourk": "1",
        "try_look": "1",
    }
    if aid:
        query["avid"] = str(aid)
    play_url = "https://api.bilibili.com/x/player/playurl?" + urllib.parse.urlencode(query)
    play = _bili_fetch_json(play_url, page_url, cookies)
    if play.get("code") != 0:
        raise RuntimeError(f"Bilibili playurl API failed: {play.get('message') or play.get('msg') or play.get('code')}")
    play_data = play.get("data") or {}
    return {"bvid": bvid, "view": data, "play": play_data}


def _bili_api_formats(page_url: str, cookies: str | None = None) -> dict[str, Any]:
    data = _bili_api_data(page_url, cookies)
    view = data["view"]
    play = data["play"]
    return {
        "ok": True,
        "service": "fcdownloader-local-helper",
        "extractor": "BiliBiliAPI",
        "title": view.get("title"),
        "thumbnail": view.get("pic"),
        "id": data["bvid"],
        "webpageUrl": page_url,
        "duration": view.get("duration"),
        "formats": _bili_formats_from_play(play),
    }


def _bili_formats_from_play(play: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    dash = play.get("dash") or {}
    for video in dash.get("video") or []:
        if not (video.get("baseUrl") or video.get("base_url")):
            continue
        height = _int(video.get("height"))
        out.append({
            "formatId": f"bili-dash-v-{video.get('id') or video.get('codecid') or height or 'video'}",
            "label": f"{height}p" if height else "video",
            "height": height,
            "ext": "mp4",
            "vcodec": video.get("codecs"),
            "acodec": "none",
            "filesize": video.get("size") or video.get("bandwidth"),
            "protocol": "https",
        })
    for audio in dash.get("audio") or []:
        if not (audio.get("baseUrl") or audio.get("base_url")):
            continue
        out.append({
            "formatId": f"bili-dash-a-{audio.get('id') or 'audio'}",
            "label": "audio",
            "height": None,
            "ext": "m4a",
            "vcodec": "none",
            "acodec": audio.get("codecs"),
            "filesize": audio.get("size") or audio.get("bandwidth"),
            "protocol": "https",
        })
    for item in play.get("durl") or []:
        if not item.get("url"):
            continue
        quality = play.get("quality") or item.get("quality")
        out.append({
            "formatId": f"bili-durl-{quality or item.get('order') or 'mp4'}",
            "label": play.get("format") or "mp4",
            "height": quality,
            "ext": "mp4",
            "vcodec": None,
            "acodec": None,
            "filesize": item.get("size"),
            "protocol": "https",
        })
    return out


def _num(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0


def _bili_pick_dash(play: dict[str, Any], max_height: str | None) -> tuple[str, str]:
    dash = play.get("dash") or {}
    limit = float(max_height) if max_height and re.fullmatch(r"\d{3,4}", max_height) else 1080.0
    best_video: dict[str, Any] | None = None
    for video in dash.get("video") or []:
        url = video.get("baseUrl") or video.get("base_url")
        height = _num(video.get("height"))
        if not url or height <= 0 or height > limit:
            continue
        if not best_video or height > _num(best_video.get("height")):
            best_video = video
        elif best_video and height == _num(best_video.get("height")) and "avc1" in str(video.get("codecs") or ""):
            best_video = video

    best_audio: dict[str, Any] | None = None
    for audio in dash.get("audio") or []:
        url = audio.get("baseUrl") or audio.get("base_url")
        if not url:
            continue
        if not best_audio or _num(audio.get("bandwidth")) > _num(best_audio.get("bandwidth")):
            best_audio = audio
    if not best_video or not best_audio:
        return "", ""
    return (
        str(best_video.get("baseUrl") or best_video.get("base_url") or ""),
        str(best_audio.get("baseUrl") or best_audio.get("base_url") or ""),
    )


def _bili_pick_durl(play: dict[str, Any]) -> str:
    best: dict[str, Any] | None = None
    for item in play.get("durl") or []:
        if not item.get("url"):
            continue
        if not best or _num(item.get("size")) > _num(best.get("size")):
            best = item
    return str(best.get("url") or "") if best else ""


def _bili_ffmpeg_headers(cookies: str | None = None) -> str:
    headers = (
        "Referer: https://www.bilibili.com/\r\n"
        "Origin: https://www.bilibili.com\r\n"
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36\r\n"
    )
    if cookies and cookies.strip():
        headers += "Cookie: " + _cookie_field(cookies.strip()) + "\r\n"
    return headers


def _download_bili_api(tmpdir: Path, ffmpeg: str, page_url: str, max_height: str | None, cookies: str | None) -> Path:
    data = _bili_api_data(page_url, cookies)
    title = _safe_name(str((data["view"] or {}).get("title") or data["bvid"]))
    play = data["play"]
    video_url, audio_url = _bili_pick_dash(play, max_height)
    out_path = tmpdir / f"{title}.mp4"
    if video_url and audio_url:
        headers = _bili_ffmpeg_headers(cookies)
        proc = subprocess.run(
            [
                ffmpeg,
                "-y",
                "-headers",
                headers,
                "-i",
                video_url,
                "-headers",
                headers,
                "-i",
                audio_url,
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(out_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60 * 60,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg Bilibili mux failed: {proc.stdout[-2000:]}")
        return out_path

    media_url = _bili_pick_durl(play)
    if not media_url:
        raise RuntimeError("Bilibili API returned no downloadable media")
    req = urllib.request.Request(media_url, headers=_bili_api_headers("https://www.bilibili.com/", cookies))
    with urllib.request.urlopen(req, timeout=120) as resp, out_path.open("wb") as fh:
        shutil.copyfileobj(resp, fh, length=1024 * 1024)
    return out_path


def _download(
    url: str,
    fmt: str | None,
    max_height: str | None,
    cookies: str | None = None,
    remove_watermark: bool = False,
) -> tuple[Path, Path]:
    tmpdir = Path(tempfile.mkdtemp(prefix="fcdl_local_"))
    cookie_file: str | None = None
    try:
        ffmpeg = _ffmpeg_path()
        if not fmt:
            fmt = _format_spec(url, max_height, remove_watermark=remove_watermark)

        cookie_file = _write_cookie_file(cookies, url)
        output_template = str(tmpdir / "%(title).120s-%(id)s.%(ext)s")
        cmd = _yt_dlp_command([
            "-f",
            fmt,
            "--merge-output-format",
            "mp4",
            "--remux-video",
            "mp4",
            "--js-runtimes",
            "node",
            "--remote-components",
            "ejs:github",
            "--ffmpeg-location",
            ffmpeg,
            *_bilibili_headers_args(url),
            *(["--cookies", cookie_file] if cookie_file else []),
            "-o",
            output_template,
            url,
        ])
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60 * 60,
        )
        if proc.returncode != 0:
            if _is_bilibili_url(url):
                return tmpdir, _download_bili_api(tmpdir, ffmpeg, url, max_height, cookies)
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise RuntimeError(proc.stdout[-2000:])

        files = sorted(
            [p for p in tmpdir.iterdir() if p.is_file()],
            key=lambda p: p.stat().st_size,
            reverse=True,
        )
        if not files or files[0].stat().st_size == 0:
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise RuntimeError("yt-dlp produced no media file")
        return tmpdir, files[0]
    except Exception:
        if tmpdir.exists():
            shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    finally:
        if cookie_file:
            Path(cookie_file).unlink(missing_ok=True)


def _query(qs: dict[str, list[str]], key: str) -> str:
    return (qs.get(key) or [""])[0].strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "FCDownloaderLocalHelper/2.0"

    def _reject_bad_origin(self) -> bool:
        origin = (self.headers.get("Origin") or "").strip()
        if origin and not _allowed_origin(self):
            _json(self, 403, {"error": "origin is not allowed"})
            return True
        return False

    def do_OPTIONS(self) -> None:
        if self._reject_bad_origin():
            return
        self.send_response(204)
        _send_cors_headers(self)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-FCDL-Cookies")
        self.end_headers()

    def do_GET(self) -> None:
        if self._reject_bad_origin():
            return
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/health":
            status = _tool_status()
            _json(self, 200, {
                "ok": True,
                "service": "fcdownloader-local-helper",
                "version": SERVICE_VERSION,
                "apiVersion": LOCAL_HELPER_API_VERSION,
                "endpoints": ["/health", "/tools", "/tools/ensure", "/formats", "/download", "/youtube-hd"],
                "needsSetup": status["needsSetup"],
                "tools": status["tools"],
            })
            return

        if parsed.path == "/tools":
            _json(self, 200, _tool_status())
            return

        if parsed.path == "/tools/ensure":
            self._handle_tools_ensure()
            return

        if parsed.path == "/formats":
            self._handle_formats(qs)
            return

        if parsed.path in {"/download", "/youtube-hd"}:
            self._handle_download(qs, youtube_only=parsed.path == "/youtube-hd")
            return

        _json(self, 404, {"error": "not found"})

    def _handle_formats(self, qs: dict[str, list[str]]) -> None:
        url = _query(qs, "url")
        if not _is_allowed_url(url):
            _json(self, 400, {"error": "url must be an http(s) media page URL"})
            return
        try:
            _json(self, 200, _extract_formats(url, self.headers.get("X-FCDL-Cookies")))
        except ValueError as exc:
            _json(self, 400, {"error": str(exc)})
        except subprocess.TimeoutExpired:
            _json(self, 504, {"error": "yt-dlp format extraction timed out"})
        except Exception as exc:  # noqa: BLE001
            _json(self, 502, {"error": str(exc)})

    def _handle_tools_ensure(self) -> None:
        try:
            _json(self, 200, _ensure_tools())
        except Exception as exc:  # noqa: BLE001
            _json(self, 502, {**_tool_status(), "ok": False, "error": str(exc)})

    def _handle_download(self, qs: dict[str, list[str]], youtube_only: bool = False) -> None:
        url = _query(qs, "url")
        if not _is_allowed_url(url):
            _json(self, 400, {"error": "url must be an http(s) media page URL"})
            return
        if youtube_only and not _is_youtube_url(url):
            _json(self, 400, {"error": "url must be a YouTube URL"})
            return

        tmpdir: Path | None = None
        try:
            tmpdir, path = _download(
                url,
                _query(qs, "format") or None,
                _query(qs, "max_height") or "1080",
                self.headers.get("X-FCDL-Cookies"),
                _query(qs, "remove_watermark") in {"1", "true", "yes"},
            )
            filename = _safe_name(path.name)
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            _send_cors_headers(self)
            self.end_headers()
            with path.open("rb") as fh:
                shutil.copyfileobj(fh, self.wfile, length=1024 * 1024)
        except ValueError as exc:
            _json(self, 400, {"error": str(exc)})
        except subprocess.TimeoutExpired:
            _json(self, 504, {"error": "yt-dlp timed out"})
        except Exception as exc:  # noqa: BLE001
            _json(self, 502, {"error": str(exc)})
        finally:
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[local-helper]", fmt % args, flush=True)


def _run_yt_dlp_delegate() -> int:
    from yt_dlp import main as yt_dlp_main

    return yt_dlp_main(sys.argv[2:])


def main() -> None:
    port = _helper_port()
    print(f"FCDownloader local helper listening on http://{HOST}:{port}", flush=True)
    ThreadingHTTPServer((HOST, port), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == YTDLP_DELEGATE_FLAG:
        raise SystemExit(_run_yt_dlp_delegate())
    main()

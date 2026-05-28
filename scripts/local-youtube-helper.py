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


def _json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
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


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except Exception:
        return None


def _extract_formats(url: str) -> dict[str, Any]:
    cmd = _yt_dlp_command([
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--js-runtimes",
        "node",
        "--remote-components",
        "ejs:github",
        url,
    ])
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
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


def _download(url: str, fmt: str | None, max_height: str | None) -> tuple[Path, Path]:
    tmpdir = Path(tempfile.mkdtemp(prefix="fcdl_local_"))
    try:
        ffmpeg = _ffmpeg_path()
        if not fmt:
            if max_height and re.fullmatch(r"\d{3,4}", max_height):
                fmt = (
                    f"bv*[height<={max_height}][ext=mp4]+ba[ext=m4a]/"
                    f"bv*[height<={max_height}]+ba/best[height<={max_height}]/best"
                )
            else:
                fmt = YOUTUBE_FORMAT if _is_youtube_url(url) else DEFAULT_FORMAT

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


def _query(qs: dict[str, list[str]], key: str) -> str:
    return (qs.get(key) or [""])[0].strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "FCDownloaderLocalHelper/2.0"

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/health":
            _json(self, 200, {
                "ok": True,
                "service": "fcdownloader-local-helper",
                "version": SERVICE_VERSION,
                "apiVersion": LOCAL_HELPER_API_VERSION,
                "endpoints": ["/health", "/formats", "/download", "/youtube-hd"],
            })
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
            _json(self, 200, _extract_formats(url))
        except subprocess.TimeoutExpired:
            _json(self, 504, {"error": "yt-dlp format extraction timed out"})
        except Exception as exc:  # noqa: BLE001
            _json(self, 502, {"error": str(exc)})

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
            tmpdir, path = _download(url, _query(qs, "format") or None, _query(qs, "max_height") or "1080")
            filename = _safe_name(path.name)
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with path.open("rb") as fh:
                shutil.copyfileobj(fh, self.wfile, length=1024 * 1024)
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
    print(f"FCDownloader local helper listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == YTDLP_DELEGATE_FLAG:
        raise SystemExit(_run_yt_dlp_delegate())
    main()

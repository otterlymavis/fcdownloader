"""
StreamSupervisor — managed subprocess lifecycle for /ytdl-stream.

Design invariants:
  - Download blocks in the route handler BEFORE any headers are sent, so a
    yt-dlp failure raises HTTPException (proper 4xx/5xx) rather than a 0-byte
    body with a 200 OK.
  - Temp directory is always cleaned up, even on exception or client disconnect.
  - Cookie temp file is deleted immediately after yt-dlp opens it.
  - Concurrent stream count is capped by MAX_CONCURRENT_STREAMS.
  - Never log raw cookie values.
  - Active yt-dlp PIDs are tracked so a SIGTERM handler (Fly.io graceful
    shutdown) can kill in-flight downloads before the process exits.

Implementation note: we use Popen + communicate() (not asyncio) because
yt-dlp must download the entire file before we can determine its size and
set Content-Length.  The FastAPI threadpool executes this synchronously.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import tempfile
import threading
from typing import Iterator

from fastapi import HTTPException

import auth
from config import (
    COOKIES_FILE,
    MAX_CONCURRENT_STREAMS,
    STREAM_DOWNLOAD_TIMEOUT,
    STREAM_FORMAT_SPEC,
)
from utils import UTF8_ENV, safe_text


# ── Concurrency accounting ────────────────────────────────────────────────────

_stream_sem = threading.Semaphore(MAX_CONCURRENT_STREAMS)


def _acquire_stream_slot(timeout: float = 10.0) -> bool:
    """Try to acquire a stream slot.  Returns False if all slots are busy."""
    return _stream_sem.acquire(timeout=timeout)


def _release_stream_slot() -> None:
    _stream_sem.release()


# ── SIGTERM / graceful-shutdown subprocess cleanup ────────────────────────────
#
# Fly.io sends SIGTERM before SIGKILL during a deploy or machine replacement.
# Any in-flight yt-dlp download will be orphaned unless we kill it first.
# We track PIDs of active subprocesses in a thread-safe set and forward the
# signal to each of them so the OS can reap the processes cleanly.

_active_pids: set[int] = set()
_active_pids_lock = threading.Lock()


def _register_pid(pid: int) -> None:
    with _active_pids_lock:
        _active_pids.add(pid)


def _unregister_pid(pid: int) -> None:
    with _active_pids_lock:
        _active_pids.discard(pid)


def _graceful_shutdown(signum: int, frame: object) -> None:
    """Forward shutdown signal to all tracked yt-dlp subprocesses."""
    print(
        f"[supervisor] signal {signum} — terminating "
        f"{len(_active_pids)} active yt-dlp process(es)",
        flush=True,
    )
    with _active_pids_lock:
        for pid in list(_active_pids):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            except Exception as exc:
                print(f"[supervisor] couldn't signal pid {pid}: {exc}", flush=True)


# Register on module import.  Use ValueError guard for environments where
# signals can't be set (e.g. non-main threads on some platforms).
for _sig in (signal.SIGTERM, signal.SIGINT):
    try:
        signal.signal(_sig, _graceful_shutdown)
    except (OSError, ValueError):
        pass


# ── Main download function ────────────────────────────────────────────────────


def ytdl_download(
    page_url: str,
    cookies: str | None,
) -> tuple[str, str, int, str]:
    """Download a YouTube video to a temp file via yt-dlp.

    Args:
        page_url: YouTube video URL.
        cookies: Raw Cookie header string (may be None).

    Returns:
        (tmpdir, filepath, filesize, filename)

    Raises:
        HTTPException: on yt-dlp failure, timeout, or concurrency limit.

    The caller is responsible for:
      - Streaming the file at `filepath`
      - Deleting `tmpdir` (via shutil.rmtree) when streaming completes
    """
    if not _acquire_stream_slot(timeout=10.0):
        raise HTTPException(
            503,
            "Too many concurrent downloads. Please try again in a moment.",
        )

    tmpdir = tempfile.mkdtemp(prefix="ytdl_")
    cookie_file: str | None = None

    try:
        out_tpl = os.path.join(tmpdir, "video.%(ext)s")
        # tv_embedded is first: YouTube's embedded-player client bypasses
        # the "Sign in to confirm you're not a bot" challenge that datacenter
        # IPs receive when using ios/web_safari/mweb, even with valid cookies.
        cmd = [
            "yt-dlp",
            "--extractor-args", "youtube:player_client=tv_embedded,ios,mweb",
            "--format", STREAM_FORMAT_SPEC,
            "--merge-output-format", "mp4",
            "--output", out_tpl,
            "--no-playlist",
            "--max-filesize", "800M",
        ]

        if cookies:
            try:
                cookie_file = auth.write_cookie_file(cookies, page_url)
            except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
                raise HTTPException(400, str(exc))
            if cookie_file:
                cmd += ["--cookies", cookie_file]
        elif COOKIES_FILE and os.path.exists(COOKIES_FILE):
            # Fall back to server-baked cookies when the caller provides none.
            cmd += ["--cookies", COOKIES_FILE]

        cmd.append(page_url)

        print(
            f"[ytdl-stream] downloading: {page_url} "
            f"(cookies={'yes' if cookies else 'no'})"
        )

        # Use Popen so we can register the PID for SIGTERM cleanup and still
        # capture stdout/stderr without shell=True race conditions.
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=UTF8_ENV,
        )
        _register_pid(proc.pid)
        try:
            try:
                _stdout, stderr_bytes = proc.communicate(timeout=STREAM_DOWNLOAD_TIMEOUT)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                shutil.rmtree(tmpdir, ignore_errors=True)
                raise HTTPException(
                    504,
                    f"YouTube download timed out ({STREAM_DOWNLOAD_TIMEOUT // 60} min limit)",
                )
        finally:
            _unregister_pid(proc.pid)
            # Delete cookie file as soon as yt-dlp exits — it read it into
            # memory at startup, so the file is no longer needed.
            auth.unlink_cookie_file(cookie_file)

        stderr_txt = stderr_bytes.decode("utf-8", errors="replace").strip()
        returncode = proc.returncode

        if returncode != 0:
            print(f"[ytdl-stream] yt-dlp failed (exit {returncode}): {stderr_txt[:600]}")
            shutil.rmtree(tmpdir, ignore_errors=True)

            _BOT_SIGNALS = (
                "Sign in to confirm", "bot", "not a bot",
                "cookies", "authentication required",
            )
            if any(k in stderr_txt for k in _BOT_SIGNALS):
                raise HTTPException(
                    422,
                    "YouTube requires your session cookies to download from a server. "
                    "Open the video in your browser, use the FCDownload bookmarklet or "
                    "extension to capture your session, and try again.",
                )
            raise HTTPException(
                500,
                f"YouTube download failed: {stderr_txt[:400] or 'unknown error'}",
            )

        if stderr_txt:
            print(f"[ytdl-stream] yt-dlp warnings: {stderr_txt[:400]}")

        files = [
            f for f in os.listdir(tmpdir)
            if os.path.isfile(os.path.join(tmpdir, f))
        ]
        if not files:
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise HTTPException(500, "yt-dlp produced no output file")

        filepath = os.path.join(tmpdir, files[0])
        filesize = os.path.getsize(filepath)
        filename = files[0]
        print(f"[ytdl-stream] streaming {filename} ({filesize:,} bytes)")

        return tmpdir, filepath, filesize, filename

    except HTTPException:
        _release_stream_slot()
        raise
    except Exception as exc:
        shutil.rmtree(tmpdir, ignore_errors=True)
        _release_stream_slot()
        raise HTTPException(500, f"ytdl-stream error: {str(exc)[:200]}")


def stream_file(tmpdir: str, filepath: str) -> Iterator[bytes]:
    """Generator that streams *filepath* in 64 KB chunks, then cleans up *tmpdir*.

    The semaphore slot is released when the generator is exhausted or aborted.
    """
    try:
        with open(filepath, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                yield chunk
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        _release_stream_slot()
        print("[ytdl-stream] done, temp cleaned up")

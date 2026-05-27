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
  - On POSIX, yt-dlp runs in its own process group (os.setsid) so that a
    timeout or stall kill reaches the entire subprocess tree (yt-dlp + any
    ffmpeg merge child it spawns), not just the parent PID.
  - A stall watchdog runs in a background thread and kills the download if the
    output file stops growing for STREAM_STALL_TIMEOUT seconds.  This catches
    SABR chunk invalidation mid-download, YouTube CDN rate-limiting, and
    network stalls that don't trip the hard communicate() timeout.

Implementation note: we use Popen + communicate() (not asyncio) because
yt-dlp must download the entire file before we can determine its size and
set Content-Length.  The FastAPI threadpool executes this synchronously.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from typing import Iterator

from fastapi import HTTPException

import auth
from config import (
    COOKIES_FILE,
    MAX_CONCURRENT_STREAMS,
    STREAM_DOWNLOAD_TIMEOUT,
    STREAM_FORMAT_SPEC,
    STREAM_STALL_TIMEOUT,
)
from utils import UTF8_ENV, safe_text

_IS_POSIX = sys.platform != "win32"
# SIGKILL does not exist on Windows; fall back to SIGTERM for the rare cases
# where we use it (stall watchdog, timeout kill).  On Fly.io (Linux) the real
# SIGKILL is always available.
_SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)


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


# ── Process-tree kill helper ──────────────────────────────────────────────────


def _kill_process_tree(proc: subprocess.Popen, sig: int = signal.SIGTERM) -> None:
    """Send *sig* to the process's entire process group (POSIX) or just the
    process itself (Windows).  Silently handles races where the process has
    already exited."""
    try:
        if _IS_POSIX:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, sig)
                return
            except (ProcessLookupError, PermissionError, OSError):
                pass  # process already gone or no group — fall through
        proc.send_signal(sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass  # process already gone


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
                if _IS_POSIX:
                    try:
                        pgid = os.getpgid(pid)
                        os.killpg(pgid, signal.SIGTERM)
                        continue
                    except (ProcessLookupError, PermissionError, OSError):
                        pass
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


# ── Stall watchdog ────────────────────────────────────────────────────────────


def _stall_watchdog(
    proc: subprocess.Popen,
    tmpdir: str,
    stall_timeout: float,
    stop_event: threading.Event,
    _check_interval: float = 10.0,  # underscore: overridable in tests
) -> None:
    """Background thread: kill *proc* if the tmpdir output stops growing.

    Polls every *_check_interval* seconds (capped to *stall_timeout* / 3 so
    short timeouts are still responsive).  Fires after *stall_timeout* seconds
    of no file-size growth.  Catches SABR chunk invalidation mid-download,
    YouTube CDN rate-limiting, and network stalls that don't trip the hard
    communicate() timeout.
    """
    interval = min(_check_interval, max(1.0, stall_timeout / 3))
    last_size: int = -1
    last_growth_time: float = time.monotonic()

    while not stop_event.wait(timeout=interval):
        if proc.poll() is not None:
            return  # process already finished — nothing to do

        total = 0
        try:
            for fname in os.listdir(tmpdir):
                fpath = os.path.join(tmpdir, fname)
                try:
                    if os.path.isfile(fpath):
                        total += os.path.getsize(fpath)
                except OSError:
                    pass
        except OSError:
            return  # tmpdir was cleaned up already

        if total > last_size:
            last_size = total
            last_growth_time = time.monotonic()
        elif time.monotonic() - last_growth_time > stall_timeout:
            print(
                f"[supervisor] stall: no file growth for {stall_timeout:.0f}s "
                f"({total:,} bytes written, pid={proc.pid}) — killing",
                flush=True,
            )
            _kill_process_tree(proc, _SIGKILL)
            return


# ── Main download function ────────────────────────────────────────────────────


def ytdl_download(
    page_url: str,
    cookies: str | None,
    *,
    request_id: str | None = None,
) -> tuple[str, str, int, str]:
    """Download a YouTube video to a temp file via yt-dlp.

    Args:
        page_url:   YouTube video URL.
        cookies:    Raw Cookie header string (may be None).
        request_id: Optional correlation ID forwarded to structured logs.

    Returns:
        (tmpdir, filepath, filesize, filename)

    Raises:
        HTTPException: on yt-dlp failure, timeout, stall, or concurrency limit.

    The caller is responsible for passing the returned values to stream_file(),
    which streams the file to the client, releases the semaphore slot, and
    deletes tmpdir when done (or on client disconnect).
    """
    rid = request_id or uuid.uuid4().hex[:12]
    t0 = time.monotonic()

    if not _acquire_stream_slot(timeout=10.0):
        raise HTTPException(
            503,
            "Too many concurrent downloads. Please try again in a moment.",
        )

    tmpdir = tempfile.mkdtemp(prefix="ytdl_")
    cookie_file: str | None = None
    proc: subprocess.Popen | None = None
    stop_watchdog = threading.Event()

    try:
        out_tpl = os.path.join(tmpdir, "video.%(ext)s")
        # tv_embedded is first: YouTube's embedded-player client bypasses
        # the "Sign in to confirm you're not a bot" challenge that datacenter
        # IPs receive when using ios/web_safari/mweb, even with valid cookies.
        #
        # --retries / --fragment-retries: handle transient SABR chunk
        # invalidation and YouTube CDN hiccups without aborting the whole
        # download.  The stall watchdog catches the rare case where yt-dlp
        # gets stuck retrying indefinitely without making progress.
        cmd = [
            "yt-dlp",
            "--extractor-args", "youtube:player_client=tv_embedded,ios,mweb",
            "--format", STREAM_FORMAT_SPEC,
            "--merge-output-format", "mp4",
            "--output", out_tpl,
            "--no-playlist",
            "--max-filesize", "800M",
            "--retries", "3",
            "--fragment-retries", "5",
            "--retry-sleep", "2",
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
            f"[ytdl-stream] rid={rid} downloading: {page_url} "
            f"(cookies={'yes' if cookies else 'no'})"
        )

        popen_kwargs: dict = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "env": UTF8_ENV,
        }
        if _IS_POSIX:
            # New process group so _kill_process_tree() reaches the full
            # subprocess tree (yt-dlp + any ffmpeg merge child it spawns).
            popen_kwargs["preexec_fn"] = os.setsid

        proc = subprocess.Popen(cmd, **popen_kwargs)
        _register_pid(proc.pid)

        # Stall watchdog: kills proc if the output file stops growing.
        watchdog_thread = threading.Thread(
            target=_stall_watchdog,
            args=(proc, tmpdir, float(STREAM_STALL_TIMEOUT), stop_watchdog),
            daemon=True,
            name=f"ytdl-stall-{rid}",
        )
        watchdog_thread.start()

        try:
            try:
                _stdout, stderr_bytes = proc.communicate(timeout=STREAM_DOWNLOAD_TIMEOUT)
            except subprocess.TimeoutExpired:
                stop_watchdog.set()
                _kill_process_tree(proc, _SIGKILL)
                proc.communicate()  # drain pipes after kill
                shutil.rmtree(tmpdir, ignore_errors=True)
                raise HTTPException(
                    504,
                    f"YouTube download timed out ({STREAM_DOWNLOAD_TIMEOUT // 60} min limit)",
                )
        finally:
            stop_watchdog.set()
            _unregister_pid(proc.pid)
            # Delete cookie file as soon as yt-dlp exits — it has read the
            # file into memory; the on-disk copy is no longer needed.
            auth.unlink_cookie_file(cookie_file)
            cookie_file = None

        stderr_txt = stderr_bytes.decode("utf-8", errors="replace").strip()
        returncode = proc.returncode
        duration_ms = (time.monotonic() - t0) * 1000

        if returncode != 0:
            print(
                f"[ytdl-stream] rid={rid} yt-dlp failed "
                f"(rc={returncode} duration={duration_ms:.0f}ms): {stderr_txt[:600]}"
            )
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
            # Stall watchdog sends SIGKILL (-9); the process may emit "Killed"
            # via stderr on some Linux kernels.
            if returncode in (-9, -15) or "Killed" in stderr_txt:
                raise HTTPException(
                    504,
                    f"YouTube download stalled and was killed — the server stopped "
                    f"receiving data from YouTube after {STREAM_STALL_TIMEOUT}s. "
                    f"The video URL may have expired or YouTube rate-limited this IP. "
                    f"Try again in a moment.",
                )
            raise HTTPException(
                500,
                f"YouTube download failed: {stderr_txt[:400] or 'unknown error'}",
            )

        if stderr_txt:
            print(f"[ytdl-stream] rid={rid} yt-dlp warnings: {stderr_txt[:400]}")

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
        print(
            f"[ytdl-stream] rid={rid} ready: {filename} "
            f"({filesize:,} bytes, rc={returncode}, duration={duration_ms:.0f}ms)"
        )

        return tmpdir, filepath, filesize, filename

    except HTTPException:
        _release_stream_slot()
        raise
    except Exception as exc:
        stop_watchdog.set()
        if proc and proc.poll() is None:
            _kill_process_tree(proc, _SIGKILL)
        shutil.rmtree(tmpdir, ignore_errors=True)
        _release_stream_slot()
        raise HTTPException(500, f"ytdl-stream error: {str(exc)[:200]}")


def stream_file(
    tmpdir: str,
    filepath: str,
    *,
    request_id: str | None = None,
) -> Iterator[bytes]:
    """Generator that streams *filepath* in 64 KB chunks, then cleans up *tmpdir*.

    The semaphore slot is released when the generator is exhausted or aborted.
    Logs bytes streamed, wall-clock duration, and disconnect reason for
    structured diagnostics.
    """
    rid = request_id or "?"
    t0 = time.monotonic()
    bytes_sent: int = 0
    disconnect_reason: str | None = None

    try:
        with open(filepath, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                bytes_sent += len(chunk)
                yield chunk
    except GeneratorExit:
        disconnect_reason = "client disconnected (GeneratorExit)"
        raise
    except BrokenPipeError:
        disconnect_reason = "broken pipe"
        raise
    except Exception as exc:
        disconnect_reason = f"{type(exc).__name__}: {str(exc)[:80]}"
        raise
    finally:
        duration_ms = (time.monotonic() - t0) * 1000
        print(
            f"[ytdl-stream] rid={rid} stream finished: "
            f"bytes={bytes_sent:,} duration={duration_ms:.0f}ms "
            f"disconnect={disconnect_reason or 'none'}",
            flush=True,
        )
        shutil.rmtree(tmpdir, ignore_errors=True)
        _release_stream_slot()

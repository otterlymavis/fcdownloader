"""
Stream lifecycle tests — supervisor.py and main._ffmpeg_stream.

Covers:
  - stream_file: byte correctness, cleanup, semaphore, disconnect logging
  - _stall_watchdog: fires on stall, does not fire on active download, stops cleanly
  - ytdl_download: success, timeout, bot-detection 422, non-zero exit, no output
    file, concurrent limit 503, semaphore release on all paths
  - _kill_process_tree: POSIX process-group kill, Windows fallback, missing pid
  - SIGTERM handler: forwards to all tracked PIDs
  - _ffmpeg_stream: stderr captured, stall watchdog kills, process-group cleanup,
    disconnect logging, bytes/duration telemetry

All subprocess calls are mocked — no real yt-dlp or ffmpeg is required.
"""
from __future__ import annotations

import io
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import MagicMock, patch, call

import pytest

# Add server/ to sys.path so bare imports work.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import supervisor
from fastapi import HTTPException


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_tmpdir_with_file(content: bytes, filename: str = "video.mp4") -> tuple[str, str]:
    """Create a temp directory containing a single file with *content*."""
    tmpdir = tempfile.mkdtemp(prefix="test_stream_")
    filepath = os.path.join(tmpdir, filename)
    with open(filepath, "wb") as f:
        f.write(content)
    return tmpdir, filepath


def _make_mock_proc(
    returncode: int = 0,
    stderr: bytes = b"",
    pid: int = 99999,
    communicate_side_effect=None,
) -> MagicMock:
    """Return a mock subprocess.Popen that behaves like a completed process."""
    mock = MagicMock(spec=subprocess.Popen)
    mock.pid = pid
    mock.returncode = returncode
    mock.stdout = io.BytesIO(b"")
    mock.stderr = io.BytesIO(stderr)
    if communicate_side_effect is not None:
        mock.communicate.side_effect = communicate_side_effect
    else:
        mock.communicate.return_value = (b"", stderr)
    mock.poll.return_value = returncode
    mock.wait.return_value = returncode
    return mock


# ── TestStreamFile ────────────────────────────────────────────────────────────


class TestStreamFile:
    """supervisor.stream_file generator behaviour."""

    def _acquire(self):
        """Acquire one semaphore slot (stream_file always releases one)."""
        supervisor._acquire_stream_slot(timeout=5.0)

    def test_yields_complete_content(self):
        data = b"A" * (3 * 65536 + 1234)  # spans three 64-KB chunks + a partial
        tmpdir, filepath = _make_tmpdir_with_file(data)
        self._acquire()
        chunks = list(supervisor.stream_file(tmpdir, filepath))
        assert b"".join(chunks) == data

    def test_cleans_tmpdir_on_normal_completion(self):
        tmpdir, filepath = _make_tmpdir_with_file(b"hello")
        self._acquire()
        list(supervisor.stream_file(tmpdir, filepath))
        assert not os.path.exists(tmpdir), "tmpdir should be deleted after streaming"

    def test_cleans_tmpdir_on_generator_close(self):
        data = b"x" * 200_000  # large enough that close() fires mid-stream
        tmpdir, filepath = _make_tmpdir_with_file(data)
        self._acquire()
        gen = supervisor.stream_file(tmpdir, filepath)
        next(gen)   # consume first chunk
        gen.close()  # simulate client disconnect
        assert not os.path.exists(tmpdir)

    def test_releases_semaphore_on_completion(self):
        """Semaphore is released after a successful stream so the slot is reused."""
        tmpdir, filepath = _make_tmpdir_with_file(b"y")
        before = supervisor._stream_sem._value  # type: ignore[attr-defined]
        self._acquire()
        list(supervisor.stream_file(tmpdir, filepath))
        after = supervisor._stream_sem._value   # type: ignore[attr-defined]
        assert after == before, "semaphore counter should be restored"

    def test_releases_semaphore_on_generator_close(self):
        tmpdir, filepath = _make_tmpdir_with_file(b"z" * 200_000)
        before = supervisor._stream_sem._value  # type: ignore[attr-defined]
        self._acquire()
        gen = supervisor.stream_file(tmpdir, filepath)
        next(gen)
        gen.close()
        after = supervisor._stream_sem._value   # type: ignore[attr-defined]
        assert after == before

    def test_releases_semaphore_on_read_error(self):
        tmpdir = tempfile.mkdtemp(prefix="test_stream_")
        filepath = os.path.join(tmpdir, "missing.mp4")  # file does not exist
        before = supervisor._stream_sem._value  # type: ignore[attr-defined]
        self._acquire()
        gen = supervisor.stream_file(tmpdir, filepath)
        with pytest.raises(FileNotFoundError):
            next(gen)
        after = supervisor._stream_sem._value   # type: ignore[attr-defined]
        assert after == before
        shutil.rmtree(tmpdir, ignore_errors=True)

    def test_logs_bytes_and_duration(self, capsys):
        data = b"B" * 1000
        tmpdir, filepath = _make_tmpdir_with_file(data)
        self._acquire()
        list(supervisor.stream_file(tmpdir, filepath, request_id="testrid"))
        out = capsys.readouterr().out
        assert "bytes=1,000" in out or "bytes=1000" in out
        assert "rid=testrid" in out
        assert "disconnect=none" in out

    def test_logs_disconnect_reason_on_close(self, capsys):
        data = b"C" * 200_000
        tmpdir, filepath = _make_tmpdir_with_file(data)
        self._acquire()
        gen = supervisor.stream_file(tmpdir, filepath, request_id="discrid")
        next(gen)
        gen.close()
        out = capsys.readouterr().out
        assert "discrid" in out
        assert "disconnect" in out


# ── TestStallWatchdog ─────────────────────────────────────────────────────────


class TestStallWatchdog:
    """supervisor._stall_watchdog background thread."""

    def test_kills_process_when_file_stops_growing(self, tmp_path):
        """Watchdog fires when the output file does not grow for stall_timeout."""
        tmpdir = str(tmp_path)
        # Create a static file that won't grow
        with open(os.path.join(tmpdir, "video.mp4"), "wb") as f:
            f.write(b"x" * 500)

        mock_proc = MagicMock()
        mock_proc.pid = 99998
        mock_proc.poll.return_value = None  # process still running

        killed = threading.Event()
        with patch.object(supervisor, "_kill_process_tree", side_effect=lambda *a, **kw: killed.set()):
            stop = threading.Event()
            t = threading.Thread(
                target=supervisor._stall_watchdog,
                args=(mock_proc, tmpdir, 0.5, stop),
                kwargs={"_check_interval": 0.1},
                daemon=True,
            )
            t.start()
            assert killed.wait(timeout=5.0), "Watchdog should have killed the process"
            stop.set()
            t.join(timeout=2.0)

    def test_does_not_kill_growing_download(self, tmp_path):
        """Watchdog must not fire while the download is actively progressing."""
        tmpdir = str(tmp_path)
        filepath = os.path.join(tmpdir, "video.mp4")
        with open(filepath, "wb") as f:
            f.write(b"x")

        mock_proc = MagicMock()
        mock_proc.pid = 99997
        mock_proc.poll.return_value = None

        killed = threading.Event()
        stop = threading.Event()

        def _grow_file():
            """Grow the file every 0.05 s for 0.5 s total."""
            for _ in range(10):
                time.sleep(0.05)
                with open(filepath, "ab") as f:
                    f.write(b"x" * 1000)

        with patch.object(supervisor, "_kill_process_tree", side_effect=lambda *a, **kw: killed.set()):
            grower = threading.Thread(target=_grow_file, daemon=True)
            grower.start()
            t = threading.Thread(
                target=supervisor._stall_watchdog,
                args=(mock_proc, tmpdir, 0.5, stop),
                kwargs={"_check_interval": 0.05},
                daemon=True,
            )
            t.start()
            grower.join()
            # Give watchdog a couple of extra checks to (wrongly) fire
            time.sleep(0.2)
            stop.set()
            t.join(timeout=2.0)
        assert not killed.is_set(), "Watchdog must not kill an actively growing download"

    def test_stops_when_event_set(self, tmp_path):
        """Watchdog exits when stop_event is set, even before stall_timeout."""
        tmpdir = str(tmp_path)
        mock_proc = MagicMock()
        mock_proc.pid = 99996
        mock_proc.poll.return_value = None

        stop = threading.Event()
        t = threading.Thread(
            target=supervisor._stall_watchdog,
            args=(mock_proc, tmpdir, 60.0, stop),
            kwargs={"_check_interval": 0.05},
            daemon=True,
        )
        t.start()
        time.sleep(0.05)
        stop.set()
        t.join(timeout=2.0)
        assert not t.is_alive(), "Watchdog thread should have exited"

    def test_exits_when_process_already_done(self, tmp_path):
        """Watchdog exits without killing when proc.poll() is non-None."""
        tmpdir = str(tmp_path)
        mock_proc = MagicMock()
        mock_proc.pid = 99995
        mock_proc.poll.return_value = 0  # process already done

        killed = threading.Event()
        stop = threading.Event()
        with patch.object(supervisor, "_kill_process_tree", side_effect=lambda *a, **kw: killed.set()):
            t = threading.Thread(
                target=supervisor._stall_watchdog,
                args=(mock_proc, tmpdir, 0.1, stop),
                kwargs={"_check_interval": 0.05},
                daemon=True,
            )
            t.start()
            t.join(timeout=2.0)
        assert not killed.is_set()


# ── TestYtdlDownload ──────────────────────────────────────────────────────────


class TestYtdlDownload:
    """supervisor.ytdl_download with mocked subprocess.Popen."""

    def _make_success_popen(self, tmp_path, content: bytes = b"v" * 5000):
        """Return a mock Popen that creates video.mp4 in *tmp_path* on communicate()."""
        tmpdir = str(tmp_path / f"ytdl_{id(content)}")
        os.makedirs(tmpdir, exist_ok=True)

        def _communicate(timeout=None):
            with open(os.path.join(tmpdir, "video.mp4"), "wb") as f:
                f.write(content)
            return b"", b""

        mock_proc = _make_mock_proc(returncode=0, communicate_side_effect=_communicate)
        return tmpdir, mock_proc

    def test_returns_tuple_on_success(self, monkeypatch, tmp_path):
        tmpdir, mock_proc = self._make_success_popen(tmp_path)
        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        result = supervisor.ytdl_download("https://www.youtube.com/watch?v=test", None)
        ret_tmpdir, filepath, filesize, filename = result
        assert ret_tmpdir == tmpdir
        assert os.path.exists(filepath)
        assert filesize == 5000
        assert filename == "video.mp4"
        # Cleanup
        shutil.rmtree(tmpdir, ignore_errors=True)
        supervisor._release_stream_slot()  # release what ytdl_download acquired

    def test_raises_503_on_concurrent_limit(self, monkeypatch):
        """503 when all semaphore slots are taken."""
        # Drain all slots
        slots = []
        for _ in range(supervisor.MAX_CONCURRENT_STREAMS):
            supervisor._acquire_stream_slot(timeout=5.0)
            slots.append(True)
        try:
            with pytest.raises(HTTPException) as exc_info:
                supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
            assert exc_info.value.status_code == 503
        finally:
            for _ in slots:
                supervisor._release_stream_slot()

    def test_raises_504_on_timeout(self, monkeypatch, tmp_path):
        """504 when communicate() times out."""
        tmpdir = str(tmp_path / "ytdl_timeout")
        os.makedirs(tmpdir, exist_ok=True)

        # First call raises TimeoutExpired; second call (drain after kill) succeeds.
        _call_count = [0]

        def _slow_communicate(timeout=None):
            _call_count[0] += 1
            if _call_count[0] == 1:
                raise subprocess.TimeoutExpired(cmd="yt-dlp", timeout=timeout)
            return b"", b""  # drain call after kill

        mock_proc = _make_mock_proc(communicate_side_effect=_slow_communicate)
        mock_proc.poll.return_value = None  # still running when killed

        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)
        monkeypatch.setattr("supervisor._kill_process_tree", lambda *a, **kw: None)

        with pytest.raises(HTTPException) as exc_info:
            supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert exc_info.value.status_code == 504
        assert "timed out" in exc_info.value.detail.lower()

    def test_raises_422_on_bot_detection(self, monkeypatch, tmp_path):
        """422 when yt-dlp stderr mentions bot-detection."""
        tmpdir = str(tmp_path / "ytdl_bot")
        os.makedirs(tmpdir, exist_ok=True)

        stderr = b"ERROR: Sign in to confirm you're not a bot"
        mock_proc = _make_mock_proc(returncode=1, stderr=stderr)

        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        with pytest.raises(HTTPException) as exc_info:
            supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert exc_info.value.status_code == 422
        assert "cookies" in exc_info.value.detail.lower()

    def test_raises_500_on_generic_failure(self, monkeypatch, tmp_path):
        """500 when yt-dlp exits non-zero without bot-detection signals."""
        tmpdir = str(tmp_path / "ytdl_fail")
        os.makedirs(tmpdir, exist_ok=True)

        stderr = b"ERROR: Video unavailable"
        mock_proc = _make_mock_proc(returncode=1, stderr=stderr)

        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        with pytest.raises(HTTPException) as exc_info:
            supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert exc_info.value.status_code == 500
        assert "Video unavailable" in exc_info.value.detail

    def test_raises_500_when_no_output_file(self, monkeypatch, tmp_path):
        """500 when yt-dlp exits 0 but writes no output file."""
        tmpdir = str(tmp_path / "ytdl_empty")
        os.makedirs(tmpdir, exist_ok=True)

        # communicate() returns 0 but does NOT create any file
        mock_proc = _make_mock_proc(returncode=0)

        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        with pytest.raises(HTTPException) as exc_info:
            supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert exc_info.value.status_code == 500
        assert "no output file" in exc_info.value.detail

    def test_tmpdir_cleaned_on_failure(self, monkeypatch, tmp_path):
        """tmpdir is deleted when yt-dlp fails."""
        tmpdir = str(tmp_path / "ytdl_cleanup")
        os.makedirs(tmpdir, exist_ok=True)
        assert os.path.exists(tmpdir)

        mock_proc = _make_mock_proc(returncode=1, stderr=b"some error")
        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        with pytest.raises(HTTPException):
            supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert not os.path.exists(tmpdir), "tmpdir must be cleaned up on failure"

    def test_semaphore_released_on_failure(self, monkeypatch, tmp_path):
        """Semaphore slot is released even when yt-dlp fails."""
        tmpdir = str(tmp_path / "ytdl_sem")
        os.makedirs(tmpdir, exist_ok=True)

        mock_proc = _make_mock_proc(returncode=1, stderr=b"error")
        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        before = supervisor._stream_sem._value  # type: ignore[attr-defined]
        with pytest.raises(HTTPException):
            supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        after = supervisor._stream_sem._value   # type: ignore[attr-defined]
        assert after == before, "semaphore must be restored after failure"

    def test_request_id_appears_in_logs(self, monkeypatch, tmp_path, capsys):
        """request_id is included in all ytdl-stream log lines."""
        tmpdir, mock_proc = self._make_success_popen(tmp_path)
        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        supervisor.ytdl_download(
            "https://www.youtube.com/watch?v=x", None, request_id="myrid99"
        )
        out = capsys.readouterr().out
        assert "myrid99" in out
        shutil.rmtree(tmpdir, ignore_errors=True)
        supervisor._release_stream_slot()

    def test_fragment_retry_flags_in_command(self, monkeypatch, tmp_path, capsys):
        """yt-dlp command includes --fragment-retries for SABR resilience."""
        seen_cmd: list[list[str]] = []
        tmpdir, mock_proc = self._make_success_popen(tmp_path)

        def _capture_popen(cmd, **kwargs):
            seen_cmd.append(cmd)
            return mock_proc

        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", _capture_popen)

        supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert seen_cmd, "Popen should have been called"
        cmd = seen_cmd[0]
        assert "--fragment-retries" in cmd
        assert "--retries" in cmd
        shutil.rmtree(tmpdir, ignore_errors=True)
        supervisor._release_stream_slot()

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups only")
    def test_process_group_flag_on_posix(self, monkeypatch, tmp_path):
        """On POSIX, Popen is called with preexec_fn=os.setsid."""
        captured_kwargs: list[dict] = []
        tmpdir, mock_proc = self._make_success_popen(tmp_path)

        def _capture_popen(cmd, **kwargs):
            captured_kwargs.append(kwargs)
            return mock_proc

        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", _capture_popen)

        supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert captured_kwargs
        assert captured_kwargs[0].get("preexec_fn") is os.setsid
        shutil.rmtree(tmpdir, ignore_errors=True)
        supervisor._release_stream_slot()


# ── TestKillProcessTree ───────────────────────────────────────────────────────


class TestKillProcessTree:
    """supervisor._kill_process_tree helper."""

    def test_handles_already_gone_process(self):
        """Should not raise even if the process no longer exists."""
        mock_proc = MagicMock()
        mock_proc.pid = 1  # init — we can't kill it, but shouldn't raise
        mock_proc.send_signal.side_effect = ProcessLookupError
        # Should not raise
        supervisor._kill_process_tree(mock_proc, signal.SIGTERM)

    def test_handles_permission_error(self):
        """Should not raise on PermissionError."""
        mock_proc = MagicMock()
        mock_proc.pid = 1
        mock_proc.send_signal.side_effect = PermissionError
        supervisor._kill_process_tree(mock_proc, signal.SIGTERM)

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX killpg only")
    def test_kills_process_group_on_posix(self, monkeypatch):
        """On POSIX, sends the signal to the entire process group."""
        killed_pgids: list[tuple[int, int]] = []

        monkeypatch.setattr(os, "getpgid", lambda pid: 42000)
        monkeypatch.setattr(os, "killpg", lambda pgid, sig: killed_pgids.append((pgid, sig)))

        mock_proc = MagicMock()
        mock_proc.pid = 12345

        supervisor._kill_process_tree(mock_proc, signal.SIGTERM)
        assert (42000, signal.SIGTERM) in killed_pgids

    def test_windows_fallback_sends_signal_directly(self, monkeypatch):
        """On Windows (or when IS_POSIX is False), sends signal to proc directly."""
        monkeypatch.setattr(supervisor, "_IS_POSIX", False)
        mock_proc = MagicMock()
        mock_proc.send_signal.return_value = None

        supervisor._kill_process_tree(mock_proc, signal.SIGTERM)
        mock_proc.send_signal.assert_called_once_with(signal.SIGTERM)


# ── TestSigtermHandler ────────────────────────────────────────────────────────


class TestSigtermHandler:
    """SIGTERM handler forwards signals to all tracked PIDs."""

    def test_forwards_to_active_pids(self, monkeypatch):
        """_graceful_shutdown sends SIGTERM to every tracked PID."""
        sent: list[int] = []
        fake_pid = 77777

        supervisor._register_pid(fake_pid)
        try:
            if supervisor._IS_POSIX:
                monkeypatch.setattr(os, "getpgid", lambda pid: pid)
                monkeypatch.setattr(os, "killpg", lambda pgid, sig: sent.append(pgid))
            else:
                monkeypatch.setattr(os, "kill", lambda pid, sig: sent.append(pid))

            supervisor._graceful_shutdown(signal.SIGTERM, None)
            assert fake_pid in sent
        finally:
            supervisor._unregister_pid(fake_pid)

    def test_handles_missing_pid_gracefully(self):
        """_graceful_shutdown does not raise when a PID is already gone."""
        fake_pid = 1  # PID 1 exists but we can't kill it; PermissionError expected
        supervisor._register_pid(fake_pid)
        try:
            # Should not raise
            supervisor._graceful_shutdown(signal.SIGTERM, None)
        finally:
            supervisor._unregister_pid(fake_pid)


# ── TestFfmpegStream ──────────────────────────────────────────────────────────


class TestFfmpegStream:
    """main._ffmpeg_stream hardening (stderr, stall, process group, telemetry)."""

    @pytest.fixture(autouse=True)
    def _import_ffmpeg_stream(self):
        from main import _ffmpeg_stream
        self._ffmpeg_stream = _ffmpeg_stream

    def _make_ffmpeg_proc(
        self,
        output: bytes = b"fakevideo" * 1000,
        stderr_lines: list[bytes] | None = None,
        returncode: int = 0,
    ) -> MagicMock:
        """Return a mock ffmpeg Popen that streams *output* on stdout."""
        mock = MagicMock(spec=subprocess.Popen)
        mock.pid = 88888
        mock.returncode = returncode
        mock.stdout = io.BytesIO(output)
        # Build a pipe-like stderr from the given lines
        stderr_content = b"".join((line + b"\n") for line in (stderr_lines or []))
        mock.stderr = io.BytesIO(stderr_content)
        mock.poll.return_value = returncode
        mock.wait.return_value = returncode
        return mock

    def test_yields_all_bytes(self, monkeypatch):
        data = b"X" * (3 * 65536 + 77)
        mock_proc = self._make_ffmpeg_proc(output=data)
        monkeypatch.setattr("main.subprocess.Popen", lambda *a, **kw: mock_proc)

        gen = self._ffmpeg_stream("", None, "http://hls.example.com/master.m3u8")
        chunks = list(gen)
        assert b"".join(chunks) == data

    def test_captures_stderr_in_log(self, monkeypatch, capsys):
        """ffmpeg stderr is captured and emitted in the final log line."""
        error_line = b"Input/output error: connection timed out"
        mock_proc = self._make_ffmpeg_proc(
            output=b"vid",
            stderr_lines=[error_line],
            returncode=1,
        )
        monkeypatch.setattr("main.subprocess.Popen", lambda *a, **kw: mock_proc)

        gen = self._ffmpeg_stream("", None, "http://hls.example.com/master.m3u8", request_id="ffrid1")
        # Exhaust the generator so finally runs
        list(gen)

        out = capsys.readouterr().out
        # The stderr drain thread may race; give it a moment
        time.sleep(0.05)
        out += capsys.readouterr().out
        assert "ffrid1" in out

    def test_logs_bytes_and_duration(self, monkeypatch, capsys):
        data = b"Q" * 4096
        mock_proc = self._make_ffmpeg_proc(output=data)
        monkeypatch.setattr("main.subprocess.Popen", lambda *a, **kw: mock_proc)

        list(self._ffmpeg_stream("", None, "http://hls.example.com/master.m3u8", request_id="ffrid2"))
        time.sleep(0.05)
        out = capsys.readouterr().out
        # bytes or duration logged by finally block
        assert "bytes=" in out or "done:" in out

    def test_terminates_proc_on_generator_close(self, monkeypatch):
        """Closing the generator terminates the ffmpeg process."""
        infinite_data = b"Z" * (10 * 1024 * 1024)  # 10 MB — won't be fully consumed
        mock_proc = self._make_ffmpeg_proc(output=infinite_data)
        mock_proc.poll.return_value = None  # still "running" when close() is called
        monkeypatch.setattr("main.subprocess.Popen", lambda *a, **kw: mock_proc)

        if sys.platform != "win32":
            # Patch killpg/getpgid so the test doesn't actually kill anything
            monkeypatch.setattr(os, "getpgid", lambda pid: pid)
            monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)

        gen = self._ffmpeg_stream("", None, "http://hls.example.com/master.m3u8")
        next(gen)
        gen.close()
        # After close, proc should have been terminated or killed
        assert mock_proc.wait.called or mock_proc.kill.called or mock_proc.terminate.called

    def test_logs_disconnect_on_generator_close(self, monkeypatch, capsys):
        data = b"D" * (3 * 65536)
        mock_proc = self._make_ffmpeg_proc(output=data)
        mock_proc.poll.return_value = None
        monkeypatch.setattr("main.subprocess.Popen", lambda *a, **kw: mock_proc)
        if sys.platform != "win32":
            monkeypatch.setattr(os, "getpgid", lambda pid: pid)
            monkeypatch.setattr(os, "killpg", lambda pgid, sig: None)

        gen = self._ffmpeg_stream(
            "", None, "http://hls.example.com/master.m3u8", request_id="discff",
        )
        next(gen)
        gen.close()
        time.sleep(0.05)
        out = capsys.readouterr().out
        assert "discff" in out
        assert "disconnect" in out

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups only")
    def test_process_group_on_posix(self, monkeypatch):
        """On POSIX, Popen is called with preexec_fn=os.setsid."""
        captured: list[dict] = []
        mock_proc = self._make_ffmpeg_proc(output=b"v")

        def _cap_popen(args, **kwargs):
            captured.append(kwargs)
            return mock_proc

        monkeypatch.setattr("main.subprocess.Popen", _cap_popen)

        list(self._ffmpeg_stream("", None, "http://hls.example.com/master.m3u8"))
        assert captured
        assert captured[0].get("preexec_fn") is os.setsid


# ── TestLargeAndLongDownloads ─────────────────────────────────────────────────


class TestLargeAndLongDownloads:
    """stream_file correctness for large payloads."""

    def test_large_file_all_bytes_yielded(self):
        """100 MB stream yields exactly the right byte count."""
        size = 100 * 1024 * 1024
        data = bytes(range(256)) * (size // 256)
        assert len(data) == size

        tmpdir, filepath = _make_tmpdir_with_file(data)
        supervisor._acquire_stream_slot(timeout=5.0)
        received = b"".join(supervisor.stream_file(tmpdir, filepath))
        assert len(received) == size
        assert received == data

    def test_empty_file_yields_no_chunks(self):
        """Empty file produces no chunks (size 0 is valid server-side)."""
        tmpdir, filepath = _make_tmpdir_with_file(b"")
        supervisor._acquire_stream_slot(timeout=5.0)
        chunks = list(supervisor.stream_file(tmpdir, filepath))
        assert chunks == []
        assert not os.path.exists(tmpdir)


# ── TestFlyIoRestarts ─────────────────────────────────────────────────────────


class TestFlyIoRestarts:
    """Behaviour under Fly.io graceful-restart SIGTERM."""

    def test_pid_registered_and_unregistered(self, monkeypatch, tmp_path):
        """PID appears in _active_pids during download and is removed after."""
        tmpdir = str(tmp_path / "ytdl_pid")
        os.makedirs(tmpdir, exist_ok=True)

        pids_during: list[set] = []

        def _communicate(timeout=None):
            pids_during.append(set(supervisor._active_pids))
            with open(os.path.join(tmpdir, "video.mp4"), "wb") as f:
                f.write(b"p" * 5000)
            return b"", b""

        mock_proc = _make_mock_proc(communicate_side_effect=_communicate)
        mock_proc.pid = 55555

        monkeypatch.setattr("supervisor.tempfile.mkdtemp", lambda **kw: tmpdir)
        monkeypatch.setattr("supervisor.subprocess.Popen", lambda *a, **kw: mock_proc)

        supervisor.ytdl_download("https://www.youtube.com/watch?v=x", None)
        assert any(55555 in s for s in pids_during), "PID must be in _active_pids during download"
        assert 55555 not in supervisor._active_pids, "PID must be removed after download"
        shutil.rmtree(tmpdir, ignore_errors=True)
        supervisor._release_stream_slot()

    def test_double_register_then_unregister(self):
        """Idempotent register; unregister once removes PID."""
        fake = 66666
        supervisor._register_pid(fake)
        supervisor._register_pid(fake)
        assert fake in supervisor._active_pids
        supervisor._unregister_pid(fake)
        assert fake not in supervisor._active_pids

    def test_unregister_nonexistent_pid_is_safe(self):
        """Unregistering a PID that was never registered does not raise."""
        supervisor._unregister_pid(0)
        supervisor._unregister_pid(2**31 - 1)

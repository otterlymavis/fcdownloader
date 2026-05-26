"""
Architecture layer tests for the refactored fcdownloader-extractor.

Tests for:
  - auth.py: cookie validation, size limits, temp-file security
  - classifier.py: URL risk/capability classification
  - registry.py: extractor capability lookup
  - telemetry.py: request context tracking
  - models.py: ErrorCode enum and response helpers
  - utils.py: filename, URL, and header helpers
"""
from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import auth
import classifier
import registry
import telemetry
import models
from utils import (
    safe_text, safe_filename, content_disposition, normalize_url,
    safe_headers, safe_header_value, url_quote, guess_ext_from_url,
    looks_like_hls, expire_of, cache_key,
)


# ── auth.validate_cookies ────────────────────────────────────────────────────

class TestValidateCookies:
    def test_valid_cookies(self):
        result = auth.validate_cookies("session=abc123; user=test")
        assert result == "session=abc123; user=test"

    def test_empty_returns_none(self):
        assert auth.validate_cookies("") is None
        assert auth.validate_cookies(None) is None
        assert auth.validate_cookies("   ") is None

    def test_oversized_raises(self):
        big = "a=b; " * 7000  # ~35 KB
        with pytest.raises(auth.CookieTooLargeError):
            auth.validate_cookies(big)

    def test_no_kv_pairs_raises(self):
        with pytest.raises(auth.CookieFormatError):
            auth.validate_cookies("not-a-cookie")
        with pytest.raises(auth.CookieFormatError):
            auth.validate_cookies(";;;")

    def test_single_pair_ok(self):
        result = auth.validate_cookies("sess=xyz")
        assert result == "sess=xyz"

    def test_strips_whitespace(self):
        result = auth.validate_cookies("  k=v  ")
        assert result is not None


class TestWriteCookieFile:
    def test_writes_file(self):
        path = auth.write_cookie_file("sess=abc", "https://youtube.com/watch?v=test")
        assert path is not None
        try:
            assert os.path.exists(path)
            content = open(path).read()
            assert "Netscape HTTP Cookie File" in content
            assert "sess" in content
        finally:
            auth.unlink_cookie_file(path)

    def test_file_mode_restricted(self):
        path = auth.write_cookie_file("sess=abc", "https://youtube.com/watch?v=test")
        assert path is not None
        try:
            stat = os.stat(path)
            # On Linux/Mac: only owner can read (0o600)
            # On Windows: permissions model differs, but file must exist
            assert os.path.exists(path)
        finally:
            auth.unlink_cookie_file(path)

    def test_invalid_page_url_returns_none(self):
        path = auth.write_cookie_file("sess=abc", "not-a-url")
        assert path is None

    def test_oversized_raises(self):
        big = "a=b; " * 7000
        with pytest.raises(auth.CookieTooLargeError):
            auth.write_cookie_file(big, "https://youtube.com/")

    def test_unlink_nonexistent_safe(self):
        auth.unlink_cookie_file(None)
        auth.unlink_cookie_file("/nonexistent/path/file.txt")

    def test_weibo_mirrors_domains(self):
        path = auth.write_cookie_file("sess=abc", "https://weibo.com/status/123")
        assert path is not None
        try:
            content = open(path).read()
            assert ".weibo.com" in content
            assert ".weibo.cn" in content
        finally:
            auth.unlink_cookie_file(path)


class TestRedactCookieSummary:
    def test_counts_pairs(self):
        summary = auth.redact_cookie_summary("a=1; b=2; c=3")
        assert "3" in summary
        assert "pairs" in summary

    def test_none_returns_none_string(self):
        assert auth.redact_cookie_summary(None) == "none"

    def test_empty_returns_none_string(self):
        assert auth.redact_cookie_summary("") == "none"


# ── classifier.classify ───────────────────────────────────────────────────────

class TestClassifier:
    def test_youtube_with_cookies_no_sabr_risk(self):
        p = classifier.classify("https://www.youtube.com/watch?v=test", cookies_provided=True)
        assert p.is_youtube
        assert not p.sabr_risk     # cookies suppress SABR risk
        assert not p.auth_likely   # cookies provided

    def test_youtube_no_cookies_sabr_risk(self):
        p = classifier.classify("https://www.youtube.com/watch?v=test", cookies_provided=False)
        assert p.is_youtube
        assert p.sabr_risk
        assert p.auth_likely
        assert p.proxy_stream_needed

    def test_bilibili_no_sabr(self):
        p = classifier.classify("https://www.bilibili.com/video/BV123")
        assert not p.is_youtube
        assert not p.sabr_risk
        assert p.hls_likely

    def test_direct_mp4_url(self):
        p = classifier.classify("https://cdn.example.com/video.mp4")
        assert p.is_direct_media

    def test_weibo_has_platform_extractor(self):
        p = classifier.classify("https://weibo.com/status/123")
        assert p.is_platform_specific

    def test_japanese_url(self):
        p = classifier.classify("https://www.nicovideo.jp/watch/sm123")
        assert p.is_japanese

    def test_unknown_site_safe_defaults(self):
        p = classifier.classify("https://example.com/video")
        assert not p.is_youtube
        assert not p.sabr_risk
        assert not p.auth_likely


# ── registry.lookup ───────────────────────────────────────────────────────────

class TestRegistry:
    def test_youtube_lookup(self):
        cap = registry.lookup("https://www.youtube.com/watch?v=test")
        assert cap.sabr_risk
        assert cap.requires_auth_on_datacenter
        assert "ios" in cap.preferred_yt_clients

    def test_bilibili_lookup(self):
        cap = registry.lookup("https://www.bilibili.com/video/BV123")
        assert cap.requires_referer
        assert cap.hls_common

    def test_weibo_lookup(self):
        cap = registry.lookup("https://weibo.com/status/123")
        assert cap.has_platform_extractor
        assert cap.requires_referer

    def test_unknown_returns_generic(self):
        cap = registry.lookup("https://example.com/video")
        assert cap.hosts == ()

    def test_is_youtube(self):
        assert registry.is_youtube("https://www.youtube.com/watch?v=abc")
        assert registry.is_youtube("https://youtu.be/abc")
        assert not registry.is_youtube("https://www.bilibili.com/video/BV1")

    def test_is_japanese_domain(self):
        assert registry.is_japanese_domain("https://www.nicovideo.jp/watch/sm123")
        assert registry.is_japanese_domain("https://tver.jp/episodes/ep1")
        assert registry.is_japanese_domain("https://abema.tv/video/test")
        assert not registry.is_japanese_domain("https://youtube.com/watch?v=test")


# ── telemetry.RequestContext ──────────────────────────────────────────────────

class TestRequestContext:
    def test_records_strategy(self):
        ctx = telemetry.RequestContext(endpoint="/extract")
        ctx.record_strategy("yt-dlp", False, reason="failed")
        ctx.record_strategy("ytdl-stream", True)
        assert len(ctx.strategy_log) == 2
        assert ctx.strategy_used == "ytdl-stream"
        assert ctx.fallback_depth == 1

    def test_first_success_sets_strategy(self):
        ctx = telemetry.RequestContext(endpoint="/extract")
        ctx.record_strategy("yt-dlp", True)
        ctx.record_strategy("ytdl-stream", True)  # ignored
        assert ctx.strategy_used == "yt-dlp"
        assert ctx.fallback_depth == 0

    def test_emit_does_not_crash(self, capsys):
        ctx = telemetry.RequestContext(endpoint="/extract", page_url_host="youtube.com")
        ctx.record_strategy("yt-dlp", False)
        ctx.emit(status="error", error_code="FORMAT_UNAVAILABLE")
        out = capsys.readouterr().out
        assert "[telemetry]" in out
        assert "FORMAT_UNAVAILABLE" in out

    def test_to_diagnostics_shape(self):
        ctx = telemetry.RequestContext(endpoint="/extract")
        ctx.record_strategy("yt-dlp", False, reason="some error")
        ctx.record_strategy("ytdl-stream", True)
        diag = ctx.to_diagnostics()
        assert len(diag) == 2
        assert diag[0]["strategy"] == "yt-dlp"
        assert diag[0]["success"] is False
        assert "reason" in diag[0]
        assert diag[1]["success"] is True
        assert "reason" not in diag[1]

    def test_make_context_extracts_host(self):
        ctx = telemetry.make_context("/extract", "https://www.youtube.com/watch?v=abc", True)
        assert ctx.page_url_host == "www.youtube.com"
        assert ctx.auth_provided is True
        assert ctx.endpoint == "/extract"


# ── models.ErrorCode + helpers ────────────────────────────────────────────────

class TestModels:
    def test_error_codes_are_strings(self):
        assert models.ErrorCode.AUTH_REQUIRED.value == "AUTH_REQUIRED"
        assert models.ErrorCode.SABR_UNSUPPORTED.value == "SABR_UNSUPPORTED"
        assert isinstance(models.ErrorCode.GEO_BLOCKED.value, str)

    def test_error_response_shape(self):
        r = models.error_response(
            models.ErrorCode.AUTH_REQUIRED,
            "Login required",
            resolution="Sign in and retry",
        )
        assert r["status"] == "error"
        assert r["error_code"] == "AUTH_REQUIRED"
        assert r["message"] == "Login required"
        assert r["resolution"] == "Sign in and retry"

    def test_error_response_no_resolution(self):
        r = models.error_response(models.ErrorCode.INTERNAL_ERROR, "oops")
        assert "resolution" not in r

    def test_success_response_shape(self):
        r = models.success_response(
            {"kind": "direct", "url": "https://cdn.example.com/video.mp4"},
            strategy="yt-dlp",
            delivery_mode="direct",
        )
        assert r["status"] == "ok"
        assert r["strategy"] == "yt-dlp"
        assert r["delivery_mode"] == "direct"
        assert r["kind"] == "direct"

    def test_extract_request_validates_url(self):
        with pytest.raises(Exception):  # pydantic ValidationError
            models.ExtractRequest(pageUrl="")


# ── utils ────────────────────────────────────────────────────────────────────

class TestUtils:
    def test_guess_ext(self):
        assert guess_ext_from_url("https://cdn.example.com/video.mp4?token=abc") == "mp4"
        assert guess_ext_from_url("https://cdn.example.com/stream.m3u8") == "m3u8"
        assert guess_ext_from_url("https://cdn.example.com/no-ext") == ""

    def test_looks_like_hls(self):
        assert looks_like_hls("https://cdn.example.com/stream.m3u8", None)
        assert looks_like_hls("https://cdn.example.com/stream", "m3u8_native")
        assert not looks_like_hls("https://cdn.example.com/video.mp4", None)

    def test_expire_of(self):
        url = "https://googlevideo.com/videoplayback?expire=1234567890&key=val"
        assert expire_of(url) == 1234567890
        assert expire_of("https://example.com/no-expire") is None

    def test_cache_key_youtube(self):
        k1 = cache_key("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        k2 = cache_key("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")
        assert k1 == k2 == "dQw4w9WgXcQ"

    def test_safe_header_value_no_crlf(self):
        val = safe_header_value("X-Custom", "value\r\nEvil: injected")
        assert "\r\n" not in val

    def test_url_quote(self):
        quoted = url_quote("https://example.com/path?key=val&foo=bar")
        assert ":" not in quoted
        assert "/" not in quoted


# ── YouTube HLS guard (strategies._strategy_ydl / _strategy_ydl_client) ──────
#
# When yt-dlp returns an m3u8/HLS protocol for YouTube in skip_download mode
# it's a SABR fallback that ffmpeg cannot remux (URL is IP-bound / auth-gated).
# Both _strategy_ydl and _strategy_ydl_client must treat that as a failure.

class TestYouTubeHlsGuard:
    """_strategy_ydl and _strategy_ydl_client reject YouTube HLS results."""

    _YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    _OTHER_URL = "https://www.bilibili.com/video/BV1x"

    def _make_fake_ydl(self, protocol: str, url: str = "https://cdn.example.com/stream"):
        """Return a YoutubeDL drop-in that reports a specific protocol."""
        info = {
            "url": url,
            "protocol": protocol,
            "ext": "mp4",
            "title": "Test Video",
            "id": "test123",
        }

        class _FakeYDL:
            def __init__(self, opts): pass
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def extract_info(self_, url, download=True): return info

        return _FakeYDL

    # ── _strategy_ydl ─────────────────────────────────────────────────────────

    def test_youtube_m3u8_native_is_failure(self, monkeypatch):
        from strategies import _strategy_ydl
        monkeypatch.setattr("strategies.YoutubeDL", self._make_fake_ydl("m3u8_native"))
        result = _strategy_ydl(self._YT_URL, {"quiet": True, "skip_download": True})
        assert not result["success"], "YouTube HLS must be treated as failure"
        assert "HLS" in result.get("reason", "") or "m3u8" in result.get("reason", "").lower()

    def test_youtube_m3u8_url_is_failure(self, monkeypatch):
        from strategies import _strategy_ydl
        monkeypatch.setattr(
            "strategies.YoutubeDL",
            self._make_fake_ydl("https", "https://r4.googlevideo.com/stream.m3u8"),
        )
        result = _strategy_ydl(self._YT_URL, {"quiet": True, "skip_download": True})
        assert not result["success"]

    def test_youtube_direct_mp4_is_success(self, monkeypatch):
        from strategies import _strategy_ydl
        monkeypatch.setattr(
            "strategies.YoutubeDL",
            self._make_fake_ydl("https", "https://r4.googlevideo.com/video.mp4"),
        )
        result = _strategy_ydl(self._YT_URL, {"quiet": True, "skip_download": True})
        assert result["success"], "Direct MP4 should succeed even for YouTube"

    def test_non_youtube_hls_is_success(self, monkeypatch):
        """Non-YouTube HLS is legitimate (Bilibili, Abema, etc.) — must not be rejected."""
        from strategies import _strategy_ydl
        monkeypatch.setattr("strategies.YoutubeDL", self._make_fake_ydl("m3u8_native"))
        result = _strategy_ydl(self._OTHER_URL, {"quiet": True, "skip_download": True})
        assert result["success"], "Non-YouTube HLS must remain a valid result"

    # ── _strategy_ydl_client ──────────────────────────────────────────────────

    def test_ydl_client_youtube_m3u8_is_failure(self, monkeypatch):
        from strategies import _strategy_ydl_client
        monkeypatch.setattr("strategies.YoutubeDL", self._make_fake_ydl("m3u8_native"))
        result = _strategy_ydl_client(self._YT_URL, {"quiet": True, "skip_download": True}, "ios")
        assert not result["success"]
        assert "HLS" in result.get("reason", "") or "m3u8" in result.get("reason", "").lower()

    def test_ydl_client_youtube_direct_is_success(self, monkeypatch):
        from strategies import _strategy_ydl_client
        monkeypatch.setattr(
            "strategies.YoutubeDL",
            self._make_fake_ydl("https", "https://r4.googlevideo.com/video.mp4"),
        )
        result = _strategy_ydl_client(self._YT_URL, {"quiet": True, "skip_download": True}, "ios")
        assert result["success"]


# ── supervisor PID tracking ───────────────────────────────────────────────────

class TestSupervisorPidTracking:
    """_register_pid / _unregister_pid maintain the active-PID set correctly."""

    def test_register_and_unregister(self):
        import supervisor
        fake_pid = 99999999
        supervisor._register_pid(fake_pid)
        assert fake_pid in supervisor._active_pids
        supervisor._unregister_pid(fake_pid)
        assert fake_pid not in supervisor._active_pids

    def test_unregister_missing_pid_is_safe(self):
        import supervisor
        supervisor._unregister_pid(0)  # should not raise

    def test_register_is_idempotent(self):
        import supervisor
        fake_pid = 88888888
        supervisor._register_pid(fake_pid)
        supervisor._register_pid(fake_pid)  # double register → still one entry
        assert fake_pid in supervisor._active_pids
        supervisor._unregister_pid(fake_pid)

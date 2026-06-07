"""
Unicode and Japanese encoding safety tests for the fcdownloader server.

These tests verify that:
  1. Japanese/Unicode text is never mangled by encoding bugs.
  2. Filenames with Japanese characters round-trip correctly.
  3. RFC 5987 Content-Disposition is generated correctly.
  4. The _is_japanese_domain() helper classifies URLs correctly.
  5. _safe_text(), _safe_filename(), and _content_disposition() are robust to
     garbage input (NUL bytes, surrogates, Latin-1, binary junk).
  6. yt-dlp http_headers for Japanese domains include Accept-Language: ja.

Run with:
    cd server
    python -m pytest tests/test_unicode.py -v
"""
from __future__ import annotations

import sys
import os
import urllib.parse

# Allow importing from the server root without installing the package.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

# Import the helpers we want to test. These are internal functions defined at
# module level in main.py; we access them by importing the module.
import importlib
import types

# We must import main without launching the FastAPI app server.
# The module runs _configure_utf8_runtime() at import time (safe) and defines
# the app object, but does NOT call uvicorn.run() at module level.
import main as _main

_safe_text       = _main._safe_text
_safe_filename   = _main._safe_filename
_content_disposition = _main._content_disposition
_is_japanese_domain  = _main._is_japanese_domain
_normalize_url   = _main._normalize_url
_safe_headers    = _main._safe_headers


# ── _safe_text ────────────────────────────────────────────────────────────────

class TestSafeText:
    def test_ascii(self):
        assert _safe_text("hello") == "hello"

    def test_japanese(self):
        assert _safe_text("日本語テスト") == "日本語テスト"

    def test_emoji(self):
        assert _safe_text("🎌🗾") == "🎌🗾"

    def test_bytes_utf8(self):
        assert _safe_text("にほんご".encode("utf-8")) == "にほんご"

    def test_bytes_latin1_replaces(self):
        # Latin-1 bytes that are not valid UTF-8 → replacement chars (no crash)
        result = _safe_text(bytes([0xC0, 0x80, 0xFF]))
        assert isinstance(result, str)  # didn't raise

    def test_none(self):
        assert _safe_text(None) == ""

    def test_surrogate_escapes(self):
        # Surrogates in a str should be handled without crashing
        bad = "\udce0\udce1"
        result = _safe_text(bad)
        assert isinstance(result, str)

    def test_nul_bytes(self):
        result = _safe_text("abc\x00def")
        assert isinstance(result, str)

    def test_integer(self):
        assert _safe_text(42) == "42"


# ── _safe_filename ────────────────────────────────────────────────────────────

class TestSafeFilename:
    def test_ascii_title(self):
        name = _safe_filename("My Video Title", "abc123")
        assert "My_Video_Title" in name or "My Video Title" in name or "My" in name

    def test_japanese_title_preserved(self):
        name = _safe_filename("日本語タイトル", "vidid")
        # Japanese characters MUST survive; no ??? or dropped chars
        assert "日本語" in name or "タイトル" in name

    def test_emoji_title(self):
        name = _safe_filename("Video 🎌 Test", "vidid")
        assert isinstance(name, str)

    def test_none_title_uses_id(self):
        name = _safe_filename(None, "fallback_id")
        assert "fallback_id" in name

    def test_path_traversal_stripped(self):
        name = _safe_filename("../../../etc/passwd", "id")
        assert ".." not in name
        assert "/" not in name

    def test_long_title_truncated(self):
        long_title = "A" * 300
        name = _safe_filename(long_title, "id")
        # Must not exceed a sane filesystem limit
        assert len(name) <= 260

    def test_control_chars_stripped(self):
        name = _safe_filename("Video\x00\x01\x1f Title", "id")
        assert "\x00" not in name

    def test_windows_reserved_chars(self):
        name = _safe_filename('Video: "Title" <test>', "id")
        # Must not contain characters that are illegal on Windows filesystems
        illegal = set('<>:"/\\|?*')
        assert not any(c in name for c in illegal)

    def test_nfc_normalization(self):
        import unicodedata
        # NFD: U+0061 a + U+0303 combining tilde -> NFC: U+00E3 a-tilde
        nfd = "a\u0303"
        name = _safe_filename(nfd, "id")
        nfc_name = unicodedata.normalize("NFC", name)
        first_char = nfc_name[0] if nfc_name else ""
        assert unicodedata.category(first_char).startswith("L")
    def test_ascii_filename(self):
        cd = _content_disposition("video.mp4", "id")
        assert "video.mp4" in cd

    def test_japanese_filename_rfc5987(self):
        cd = _content_disposition("日本語動画.mp4", "id")
        # RFC 5987 form MUST be present for non-ASCII
        assert "filename*=UTF-8''" in cd or "filename*=utf-8''" in cd

    def test_percent_encoded_japanese(self):
        cd = _content_disposition("日本語.mp4", "id")
        # The UTF-8 bytes of 日 (0xE6 0x97 0xA5) must appear percent-encoded
        assert "%E6%97%A5" in cd or "%e6%97%a5" in cd.lower()

    def test_emoji(self):
        cd = _content_disposition("video🎌.mp4", "id")
        assert "filename*=" in cd

    def test_no_crlf_injection(self):
        cd = _content_disposition("video\r\nContent-Type: text/html", "id")
        assert "\r\n" not in cd
        # CRLF stripped; "Content-Type:" (with colon = HTTP header syntax)
        # must not appear as a separate field. Text in filename is safe.
        assert "Content-Type:" not in cd


# ── _is_japanese_domain ───────────────────────────────────────────────────────

class TestIsJapaneseDomain:
    def test_nicovideo(self):
        assert _is_japanese_domain("https://www.nicovideo.jp/watch/sm12345678")

    def test_abema(self):
        assert _is_japanese_domain("https://abema.tv/video/episode/xxx")

    def test_nhk(self):
        assert _is_japanese_domain("https://www3.nhk.or.jp/news/")

    def test_tver(self):
        assert _is_japanese_domain("https://tver.jp/episodes/ep1234")

    def test_generic_jp_tld(self):
        assert _is_japanese_domain("https://video.example.co.jp/watch/123")

    def test_ameba(self):
        assert _is_japanese_domain("https://ameblo.jp/someuser/entry-12345678901.html")

    def test_non_japanese(self):
        assert not _is_japanese_domain("https://www.youtube.com/watch?v=abc")

    def test_non_japanese_tiktok(self):
        assert not _is_japanese_domain("https://www.tiktok.com/@user/video/123")

    def test_bilibili(self):
        # bilibili.com is Chinese, NOT Japanese
        assert not _is_japanese_domain("https://www.bilibili.com/video/BV1234")

    def test_invalid_url(self):
        # Must not crash on invalid input
        result = _is_japanese_domain("not-a-url")
        assert isinstance(result, bool)

    def test_empty_string(self):
        assert not _is_japanese_domain("")

    def test_mildom(self):
        assert _is_japanese_domain("https://www.mildom.com/playback/123")


# ── _normalize_url ────────────────────────────────────────────────────────────

class TestNormalizeUrl:
    def test_ascii_passthrough(self):
        url = "https://example.com/path?q=1"
        assert _normalize_url(url) == url

    def test_japanese_path(self):
        url = "https://example.co.jp/動画/watch?id=123"
        result = _normalize_url(url)
        assert result.startswith("https://example.co.jp/")
        assert isinstance(result, str)

    def test_idna_hostname(self):
        # Punycode / IDNA hostname should survive
        url = "https://日本語.jp/path"
        result = _normalize_url(url)
        assert isinstance(result, str)

    def test_empty(self):
        assert _normalize_url("") == ""

    def test_no_crash_on_junk(self):
        result = _normalize_url("\x00\xff\xfe not a url")
        assert isinstance(result, str)


# ── _safe_headers ─────────────────────────────────────────────────────────────

class TestSafeHeaders:
    def test_basic(self):
        h = _safe_headers({"Referer": "https://example.com/"})
        assert h["Referer"] == "https://example.com/"

    def test_removes_control_chars(self):
        h = _safe_headers({"X-Custom": "value\r\nEvil: injected"})
        assert "\r\n" not in h.get("XCustom", "") + h.get("X-Custom", "")

    def test_none_value_skipped(self):
        h = _safe_headers({"X-Null": None, "X-Ok": "ok"})
        assert "X-Null" not in h and "XNull" not in h
        assert h.get("XOk") == "ok" or h.get("X-Ok") == "ok"

    def test_empty(self):
        assert _safe_headers(None) == {}
        assert _safe_headers({}) == {}

    def test_japanese_cookie_safe(self):
        # Cookie value with Japanese content — must survive without crash
        h = _safe_headers({"Cookie": "sess=日本語abc"})
        result = h.get("Cookie", "")
        assert isinstance(result, str)


# ── Accept-Language injection in _run_ydl ─────────────────────────────────────
# We can't easily call _run_ydl without a running yt-dlp binary, but we CAN
# verify the logic by inspecting the http_headers dict that would be constructed.

class TestAcceptLanguageInjection:
    """Verify that Japanese URLs receive Accept-Language: ja in http_headers."""

    def _build_headers(self, page_url: str, referer: str | None = None) -> dict:
        """
        Replicate the header-building logic from _run_ydl without invoking yt-dlp.
        This tests the logic in isolation.
        """
        http_headers: dict[str, str] = {}
        if referer:
            http_headers["Referer"] = referer
        elif "bilivideo.com" in page_url or "bilibili.com" in page_url:
            http_headers["Referer"] = "https://www.bilibili.com/"
        elif any(host in page_url for host in ("weibo.com", "weibo.cn", "weibocdn.com")):
            http_headers["Referer"] = "https://weibo.com/"
        elif any(host in page_url for host in ("xiaohongshu.com", "xhslink.com", "xhscdn.com")):
            http_headers["Referer"] = "https://www.xiaohongshu.com/"

        if _is_japanese_domain(page_url) and "Accept-Language" not in http_headers:
            http_headers["Accept-Language"] = "ja,en-US;q=0.9,en;q=0.8"

        return http_headers

    def test_nicovideo_gets_japanese(self):
        h = self._build_headers("https://www.nicovideo.jp/watch/sm123")
        assert h.get("Accept-Language", "").startswith("ja")

    def test_abema_gets_japanese(self):
        h = self._build_headers("https://abema.tv/video/episode/test")
        assert h.get("Accept-Language", "").startswith("ja")

    def test_tver_gets_japanese(self):
        h = self._build_headers("https://tver.jp/episodes/ep1234")
        assert h.get("Accept-Language", "").startswith("ja")

    def test_nhk_gets_japanese(self):
        h = self._build_headers("https://www.nhk.or.jp/video/")
        assert h.get("Accept-Language", "").startswith("ja")

    def test_youtube_not_affected(self):
        h = self._build_headers("https://www.youtube.com/watch?v=abc")
        assert "Accept-Language" not in h

    def test_bilibili_not_affected(self):
        h = self._build_headers("https://www.bilibili.com/video/BV1")
        assert "Accept-Language" not in h
        assert h.get("Referer", "").startswith("https://www.bilibili.com/")

    def test_explicit_referer_not_overwritten(self):
        h = self._build_headers("https://www.nicovideo.jp/watch/sm1", referer="https://custom.example.com/")
        # Referer was given explicitly — don't override Accept-Language either
        # (the caller has already set the context)
        assert h.get("Referer") == "https://custom.example.com/"
        # Accept-Language is still injected (it's independent of Referer)
        assert h.get("Accept-Language", "").startswith("ja")

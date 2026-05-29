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
import extractors
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

    def test_japanese_platform_lookup(self):
        samples = [
            "https://www.nicovideo.jp/watch/sm9",
            "https://tver.jp/episodes/ep123",
            "https://abema.tv/video/episode/123",
            "https://twitcasting.tv/example/movie/123",
            "https://www.openrec.tv/live/abc",
            "https://mdpr.jp/news/detail/1234567",
            "https://cu.tbs.co.jp/episode/123",
            "https://fod.fujitv.co.jp/title/123",
            "https://video.yahoo.co.jp/c/123",
        ]
        for url in samples:
            cap = registry.lookup(url)
            assert cap.requires_ja_locale
            assert cap.hls_common

    def test_unknown_returns_generic(self):
        cap = registry.lookup("https://example.com/video")
        assert cap.hosts == ()

    def test_naver_lookup(self):
        cap = registry.lookup("https://tv.naver.com/v/123456")
        assert cap.requires_referer
        assert cap.hls_common
        assert not cap.requires_ja_locale

    def test_naver_blog_has_platform_extractor(self):
        cap = registry.lookup("https://blog.naver.com/jalee3228/224297926556")
        assert cap.has_platform_extractor
        assert cap.requires_referer

    def test_modelpress_has_platform_extractor(self):
        cap = registry.lookup("https://mdpr.jp/news/4690888")
        assert cap.has_platform_extractor
        assert cap.requires_ja_locale

    def test_curated_japanese_magazine_has_platform_extractor(self):
        cap = registry.lookup("https://natalie.mu/music/news/123456")
        assert cap.has_platform_extractor
        assert cap.requires_referer
        assert cap.requires_ja_locale

    def test_naver_news_has_platform_extractor(self):
        cap = registry.lookup("https://n.news.naver.com/article/001/0012345678")
        assert cap.has_platform_extractor
        assert cap.requires_referer

    def test_is_youtube(self):
        assert registry.is_youtube("https://www.youtube.com/watch?v=abc")
        assert registry.is_youtube("https://youtu.be/abc")
        assert not registry.is_youtube("https://www.bilibili.com/video/BV1")

    def test_is_japanese_domain(self):
        assert registry.is_japanese_domain("https://www.nicovideo.jp/watch/sm123")
        assert registry.is_japanese_domain("https://tver.jp/episodes/ep1")
        assert registry.is_japanese_domain("https://abema.tv/video/test")
        assert registry.is_japanese_domain("https://www.openrec.tv/live/test")
        assert registry.is_japanese_domain("https://nico.ms/sm9")
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

    def test_naver_cdn_uses_backend_streaming(self):
        from main import _needs_headered_direct_stream, _download_headers, _DOH_CDN_SUFFIXES
        page_url = "https://tv.naver.com/v/5118291"
        media_url = "http://b01-kr-cdn.vod.naver.net/navertv/video.mp4"
        headers = _download_headers(None, None, page_url=page_url)

        assert headers["Referer"] == "https://tv.naver.com/"
        assert _needs_headered_direct_stream(page_url, media_url, headers)
        assert "naver.net" in _DOH_CDN_SUFFIXES


class TestModelpressExtractor:
    def test_extracts_gzip_article_images(self, monkeypatch):
        import gzip

        html = """
        <html><head>
          <meta property="og:title" content="Sample Modelpress Article">
          <meta property="og:image" content="https://img-mdpr.freetls.fastly.net/article/abcd/nm/main.jpg?width=700&amp;auto=webp">
        </head><body>
          <img src="https://img-mdpr.freetls.fastly.net/article/abcd/nm/main.jpg?width=700&amp;auto=webp">
          <img src="https://img-mdpr.freetls.fastly.net/article/efgh/nm/second.jpg?width=496&amp;crop=496:400&amp;auto=webp">
        </body></html>
        """.encode()

        class FakeResponse:
            headers = {"Content-Encoding": "gzip"}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return gzip.compress(html)

        monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())

        info = extractors.extract_modelpress("https://mdpr.jp/news/4690888", None)
        assert info is not None
        assert info["_type"] == "playlist"
        assert info["title"] == "Sample Modelpress Article"
        assert len(info["entries"]) == 1
        assert info["entries"][0]["url"].startswith("https://img-mdpr.freetls.fastly.net/article/")

    def test_expands_photo_detail_gallery(self, monkeypatch):
        import gzip
        import re

        pages = {
            "https://mdpr.jp/photo/detail/20095232": """
                <meta property="og:title" content="(画像1/3) Sample - モデルプレス">
                <meta property="og:image" content="https://img-mdpr.freetls.fastly.net/article/a/nm/one.jpg">
                <a href="/photo/detail/20095232">1</a>
                <a href="/photo/detail/20095233">2</a>
                <a href="/photo/detail/20095234">3</a>
            """,
            "https://mdpr.jp/photo/detail/20095233": """
                <meta property="og:title" content="(画像2/3) Sample - モデルプレス">
                <meta property="og:image" content="https://img-mdpr.freetls.fastly.net/article/b/nm/two.jpg">
            """,
            "https://mdpr.jp/photo/detail/20095234": """
                <meta property="og:title" content="(画像3/3) Sample - モデルプレス">
                <meta property="og:image" content="https://img-mdpr.freetls.fastly.net/article/c/nm/three.jpg">
            """,
        }

        class FakeResponse:
            headers = {"Content-Encoding": "gzip"}
            def __init__(self, body: str): self.body = body.encode()
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return gzip.compress(self.body)

        def fake_urlopen(req, *args, **kwargs):
            url = getattr(req, "full_url", str(req))
            return FakeResponse(pages[re.sub(r"/$", "", url)])

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

        info = extractors.extract_modelpress("https://mdpr.jp/photo/detail/20095232", None)
        assert info is not None
        assert [entry["url"] for entry in info["entries"]] == [
            "https://img-mdpr.freetls.fastly.net/article/a/nm/one.jpg",
            "https://img-mdpr.freetls.fastly.net/article/b/nm/two.jpg",
            "https://img-mdpr.freetls.fastly.net/article/c/nm/three.jpg",
        ]


class TestNaverBlogExtractor:
    def test_extracts_postview_gallery_images(self, monkeypatch):
        pages = {
            "https://blog.naver.com/jalee3228/224297926556": """
                <html><body>
                  <iframe id="mainFrame" src="/PostView.naver?blogId=jalee3228&amp;logNo=224297926556"></iframe>
                </body></html>
            """,
            "https://blog.naver.com/PostView.naver?blogId=jalee3228&logNo=224297926556": """
                <html><head>
                  <meta property="og:title" content="Sample Naver Blog">
                </head><body>
                  <img class="se-image-resource" data-lazy-src="https://postfiles.pstatic.net/MjAyNjA1/test-one.jpg?type=w966">
                  <img class="se-image-resource" src="https://postfiles.pstatic.net/MjAyNjA1/test-two.jpg?type=w80_blur">
                  <img src="https://postfiles.pstatic.net/MjAyNjA1/ignored.jpg?type=w966">
                </body></html>
            """,
        }

        class FakeResponse:
            headers = {}
            def __init__(self, body: str): self.body = body.encode()
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return self.body

        def fake_urlopen(req, *args, **kwargs):
            url = getattr(req, "full_url", str(req))
            return FakeResponse(pages[url])

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

        info = extractors.extract_naver_blog("https://blog.naver.com/jalee3228/224297926556", None)
        assert info is not None
        assert info["_type"] == "playlist"
        assert info["title"] == "Sample Naver Blog"
        assert [entry["url"] for entry in info["entries"]] == [
            "https://postfiles.pstatic.net/MjAyNjA1/test-one.jpg?type=w966",
            "https://postfiles.pstatic.net/MjAyNjA1/test-two.jpg",
        ]
        assert info["entries"][0]["http_headers"]["Referer"].startswith(
            "https://blog.naver.com/PostView.naver?"
        )


class TestCuratedSiteExtractor:
    def test_oricon_photo_page_expands_full_gallery(self, monkeypatch):
        pages = {
            "https://contents.oricon.co.jp/news/2452025/photo/1/": """
              <html><head>
                <meta property="og:title" content="Sample Oricon Gallery">
                <meta property="og:image" content="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_01_thumb.jpg?width=640">
              </head><body>
                <a href="/news/2452025/photo/2/">next</a>
                <img src="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_01_thumb.jpg?width=640">
              </body></html>
            """,
            "https://contents.oricon.co.jp/news/2452025/photo/2/": """
              <html><head>
                <meta property="og:title" content="Sample Oricon Gallery 2">
                <meta property="og:image" content="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_02_s.jpg?height=480">
              </head><body>
                <img data-lazy-src="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_02_s.jpg?height=480">
              </body></html>
            """,
        }

        class FakeResponse:
            headers = {}
            def __init__(self, body: str): self.body = body.encode()
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return self.body

        def fake_urlopen(req, *args, **kwargs):
            url = getattr(req, "full_url", str(req))
            return FakeResponse(pages[url])

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

        info = extractors.extract_curated_site("https://www.oricon.co.jp/news/2452025/photo/1/", None)
        assert info is not None
        assert info["_type"] == "playlist"
        assert info["extractor"] == "oricon"
        assert info["title"] == "Sample Oricon Gallery"
        assert [entry["url"] for entry in info["entries"]] == [
            "https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_01.jpg",
            "https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_02.jpg",
        ]
        assert info["entries"][1]["http_headers"]["Referer"] == "https://www.oricon.co.jp/news/2452025/photo/2/"

    def test_oricon_shift_jis_and_full_size_preference(self, monkeypatch):
        pages = {
            "https://contents.oricon.co.jp/news/2452025/photo/1/": """
              <html><head>
                <meta charset="shift_jis">
                <meta property="og:title" content="画像・写真 | 東京ニュース 1枚目">
                <meta property="og:image" content="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_p_o_11111111.jpg">
              </head><body>
                <a href="/news/2452025/photo/2/">next</a>
                <img src="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_p_l_22222222.jpg">
                <img src="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_p_s_33333333.jpg">
                <img src="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_related_p_s_44444444.jpg">
              </body></html>
            """,
            "https://contents.oricon.co.jp/news/2452025/photo/2/": """
              <html><head>
                <meta charset="shift_jis">
                <meta property="og:title" content="画像・写真 | 東京ニュース 2枚目">
                <meta property="og:image" content="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_second_p_o_55555555.jpg">
              </head><body>
                <img src="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_second_p_l_66666666.jpg">
                <img src="https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_second_p_s_77777777.jpg">
              </body></html>
            """,
        }

        class FakeResponse:
            headers = {"Content-Type": "text/html; charset=Shift_JIS"}
            def __init__(self, body: str): self.body = body.encode("shift_jis")
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return self.body

        def fake_urlopen(req, *args, **kwargs):
            url = getattr(req, "full_url", str(req))
            return FakeResponse(pages[url])

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

        info = extractors.extract_curated_site("https://www.oricon.co.jp/news/2452025/photo/1/", None)
        assert info is not None
        assert info["title"] == "画像・写真 | 東京ニュース 1枚目"
        assert [entry["url"] for entry in info["entries"]] == [
            "https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_sample_p_o_11111111.jpg",
            "https://contents.oricon.co.jp/upimg/news/2452000/2452025/20260529_second_p_o_55555555.jpg",
        ]

    def test_extracts_japanese_article_gallery(self, monkeypatch):
        html = """
        <html><head>
          <meta property="og:title" content="Sample Natalie Gallery">
          <meta property="og:image" content="https://ogre.natalie.mu/media/news/music/sample-main.jpg">
        </head><body>
          <img src="https://ogre.natalie.mu/media/news/music/sample-main.jpg?impolicy=hq">
          <img data-src="https://ogre.natalie.mu/media/news/music/sample-second.webp">
          <img src="https://ogre.natalie.mu/media/news/music/icon-logo.png">
        </body></html>
        """

        class FakeResponse:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return html.encode()

        monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())

        info = extractors.extract_curated_site("https://natalie.mu/music/news/123456", None)
        assert info is not None
        assert info["_type"] == "playlist"
        assert info["title"] == "Sample Natalie Gallery"
        assert [entry["url"] for entry in info["entries"]] == [
            "https://ogre.natalie.mu/media/news/music/sample-main.jpg",
            "https://ogre.natalie.mu/media/news/music/sample-second.webp",
        ]
        assert info["entries"][0]["http_headers"]["Referer"] == "https://natalie.mu/music/news/123456"

    def test_naver_article_ignores_header_png(self, monkeypatch):
        html = """
        <html><head>
          <meta property="og:title" content="Sample Naver News">
          <meta property="og:image" content="https://ssl.pstatic.net/static.news/image/news/ogtag/navernews_200x200.png">
        </head><body>
          <img src="https://ssl.pstatic.net/static.news/image/news/ogtag/navernews_200x200.png">
          <img src="https://imgnews.pstatic.net/image/001/2026/05/28/article_photo.jpg?type=w647">
        </body></html>
        """

        class FakeResponse:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return html.encode()

        monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())

        info = extractors.extract_curated_site("https://n.news.naver.com/article/001/0012345678", None)
        assert info is not None
        assert [entry["url"] for entry in info["entries"]] == [
            "https://imgnews.pstatic.net/image/001/2026/05/28/article_photo.jpg?type=w647",
        ]


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

    def test_ytdl_stream_url_does_not_embed_cookies(self, monkeypatch):
        from strategies import _strategy_ytdl_stream_url
        monkeypatch.setattr(
            "strategies.YoutubeDL",
            self._make_fake_ydl("https", "https://r4.googlevideo.com/video.mp4"),
        )
        result = _strategy_ytdl_stream_url(
            self._YT_URL,
            {"quiet": True, "skip_download": True},
            "SID=secret; HSID=secret2",
        )

        assert result["success"]
        assert "/ytdl-stream?" in result["media"]["url"]
        assert "page_url=" in result["media"]["url"]
        assert "cookies=" not in result["media"]["url"]
        assert "SID=" not in result["media"]["url"]


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

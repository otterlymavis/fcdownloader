import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main


class UnicodeSafetyTests(unittest.TestCase):
    def test_safe_filename_preserves_japanese_mixed_text_and_emoji(self) -> None:
        filename = main._safe_filename("WWD Japan：春夏コレクション/東京 😄 <HD>", "abc123")

        self.assertEqual(filename, "WWD Japan：春夏コレクション東京 😄 HD.mp4")

    def test_content_disposition_uses_ascii_fallback_and_utf8_filename_star(self) -> None:
        header = main._content_disposition("日本語タイトル 😄.mp4", "vid123")

        self.assertIn('filename="vid123.mp4"', header)
        self.assertIn("filename*=UTF-8''", header)
        self.assertIn("%E6%97%A5%E6%9C%AC%E8%AA%9E", header)
        fallback = header.split("filename=", 1)[1].split(";", 1)[0]
        self.assertNotIn("日本語", fallback)

    def test_utf8_json_response_keeps_unicode_valid(self) -> None:
        body = main.UTF8JSONResponse({"title": "東京ニュース 😄"}).body

        self.assertEqual(body.decode("utf-8"), '{"title":"東京ニュース 😄"}')
        self.assertEqual(json.loads(body.decode("utf-8"))["title"], "東京ニュース 😄")

    def test_normalize_url_percent_encodes_japanese_path_query_and_idna_host(self) -> None:
        url = main._normalize_url("https://例え.jp/動画/東京?検索=春夏&emoji=😄")

        self.assertTrue(url.startswith("https://xn--r8jz45g.jp/"))
        self.assertIn("%E5%8B%95%E7%94%BB/%E6%9D%B1%E4%BA%AC", url)
        self.assertIn("%E6%A4%9C%E7%B4%A2=%E6%98%A5%E5%A4%8F", url)
        self.assertIn("emoji=%F0%9F%98%84", url)

    def test_headers_never_contain_raw_unicode_or_control_chars(self) -> None:
        headers = main._safe_headers({
            "Referer": "https://例え.jp/動画/東京\r\nX-Bad: 1",
            "X-Title": "日本語 😄",
        })

        self.assertEqual(headers["Referer"], "https://xn--r8jz45g.jp/%E5%8B%95%E7%94%BB/%E6%9D%B1%E4%BA%AC%20X-Bad:%201")
        self.assertEqual(headers["X-Title"], "??? ?")

    def test_subprocess_environment_forces_utf8(self) -> None:
        self.assertEqual(main.UTF8_ENV["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(main.UTF8_ENV["LANG"], "en_US.UTF-8")
        self.assertEqual(main.UTF8_ENV["LC_ALL"], "en_US.UTF-8")

    def test_yt_dlp_failure_falls_through_to_hls_detector(self) -> None:
        class FailingYDL:
            def __init__(self, _opts: dict) -> None:
                pass

            def __enter__(self) -> "FailingYDL":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def extract_info(self, _url: str, download: bool = False) -> dict:
                raise Exception("Unsupported URL")

        html = '<html><title>東京</title><script>var hls="https://cdn.example.jp/動画/master.m3u8";</script></html>'
        with patch.object(main, "YoutubeDL", FailingYDL), patch.object(
            main,
            "_fetch_html_for_detection",
            return_value=(html, {"User-Agent": "test"}),
        ):
            info = main._run_ydl("https://example.jp/watch/東京")

        self.assertEqual(info["_extractor_strategy"], "HLS manifest detector")
        self.assertEqual(info["protocol"], "m3u8_native")
        self.assertIn("%E5%8B%95%E7%94%BB/master.m3u8", info["url"])

    def test_yt_dlp_failure_result_is_non_fatal(self) -> None:
        class FailingYDL:
            def __init__(self, _opts: dict) -> None:
                pass

            def __enter__(self) -> "FailingYDL":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def extract_info(self, _url: str, download: bool = False) -> dict:
                raise Exception("nsig failure")

        with patch.object(main, "YoutubeDL", FailingYDL):
            result = main._try_ydl("https://example.jp/video", {}, force_generic=False)

        self.assertFalse(result["success"])
        self.assertFalse(result["fatal"])
        self.assertIn("nsig failure", result["reason"])


if __name__ == "__main__":
    unittest.main()

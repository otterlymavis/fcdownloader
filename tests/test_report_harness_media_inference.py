import importlib.util
import sys
import types
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _install_playwright_stub() -> None:
    if "playwright.sync_api" in sys.modules:
        return
    playwright = sys.modules.setdefault("playwright", types.ModuleType("playwright"))
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: None
    playwright.sync_api = sync_api
    sys.modules["playwright.sync_api"] = sync_api


def _load_script(name: str):
    _install_playwright_stub()
    path = ROOT / "tests" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"fcdownloader_{name}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_webapp_harness():
    _install_playwright_stub()
    path = ROOT / "scripts" / "test_webapp_comprehensive.py"
    spec = importlib.util.spec_from_file_location("fcdownloader_test_webapp_comprehensive", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(params=["test_extension_helper_downloads", "test_all_urls_comprehensive"])
def harness(request: pytest.FixtureRequest):
    return _load_script(str(request.param))


def test_direct_ogg_is_inferred_as_audio(harness) -> None:
    item = {
        "kind": "direct",
        "url": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
    }

    assert harness.infer_media_kind(item, "image") == "audio"
    assert harness.extension_for_media_item(item) == "ogg"


def test_avif_is_valid_image_media(harness) -> None:
    item = {"kind": "direct", "url": "https://cdn.example.com/photo.avif"}

    assert harness.is_valid_media_item(item) is True
    assert harness.infer_media_kind(item, "video") == "image"
    assert harness.extension_for_media_item(item) == "avif"


def test_manifest_mime_is_video_with_manifest_extension(harness) -> None:
    dash = {
        "kind": "direct",
        "url": "https://stream.example.com/playback",
        "mimeType": "application/dash+xml",
    }
    hls = {
        "kind": "direct",
        "url": "https://stream.example.com/live",
        "mimeType": "application/vnd.apple.mpegurl",
    }

    assert harness.infer_media_kind(dash, "image") == "video"
    assert harness.extension_for_media_item(dash) == "mpd"
    assert harness.is_stream_manifest_item(dash) is True

    assert harness.infer_media_kind(hls, "image") == "video"
    assert harness.extension_for_media_item(hls) == "m3u8"
    assert harness.is_stream_manifest_item(hls) is True


def test_content_type_aliases_are_used_for_extensionless_media(harness) -> None:
    audio = {
        "url": "https://cdn.example.com/playback",
        "contentType": "audio/ogg",
    }
    image = {
        "url": "https://cdn.example.com/media",
        "type": "image/avif",
    }
    dash = {
        "url": "https://cdn.example.com/manifest",
        "contentType": "application/dash+xml",
    }

    assert harness.is_valid_media_item(audio) is True
    assert harness.infer_media_kind(audio, "image") == "audio"
    assert harness.extension_for_media_item(audio) == "ogg"

    assert harness.is_valid_media_item(image) is True
    assert harness.infer_media_kind(image, "video") == "image"
    assert harness.extension_for_media_item(image) == "avif"

    assert harness.is_valid_media_item(dash) is True
    assert harness.infer_media_kind(dash, "image") == "video"
    assert harness.extension_for_media_item(dash) == "mpd"
    assert harness.is_stream_manifest_item(dash) is True


def test_direct_mp4_is_not_treated_as_manifest(harness) -> None:
    item = {"kind": "direct", "url": "https://cdn.example.com/video.mp4"}

    assert harness.infer_media_kind(item, "image") == "video"
    assert harness.is_stream_manifest_item(item) is False


def test_single_server_response_preserves_media_metadata(harness) -> None:
    response = {
        "kind": "direct",
        "url": "https://stream.example.com/playback",
        "mimeType": "application/dash+xml",
        "headers": {"Referer": "https://example.com/watch"},
        "title": "Playable stream",
    }

    item = harness.single_media_item_from_response(response, "video")

    assert item == response
    assert harness.extension_for_media_item(item) == "mpd"
    assert harness.is_stream_manifest_item(item) is True


def test_manifest_server_fallback_is_not_saved_directly(harness, monkeypatch: pytest.MonkeyPatch) -> None:
    download_calls = []

    def fake_fetch_json(url, data=None, method="GET", timeout=30):
        if url.startswith(f"{harness.LOCAL_HELPER}/formats"):
            return None, "helper formats failed"
        return {
            "kind": "direct",
            "url": "https://stream.example.com/playback",
            "mimeType": "application/dash+xml",
            "headers": {"Referer": "https://example.com/watch"},
        }, None

    def fake_download_file(url, target_path, headers=None, **kwargs):
        download_calls.append((url, headers))
        return False, "helper failed"

    monkeypatch.setattr(harness, "fetch_json", fake_fetch_json)
    monkeypatch.setattr(harness, "download_file", fake_download_file)
    monkeypatch.setattr(harness, "capture_screenshot", lambda url, name: None)

    if harness.__name__.endswith("test_all_urls_comprehensive"):
        result = harness.test_url("DASH Manifest", "https://example.com/video.mpd", 1)
    else:
        result = harness.test_url("DASH Manifest", "https://example.com/video.mpd")

    assert result["detection"] == "✅ PASS"
    assert "not saving raw manifest directly" in result["error"]
    assert download_calls == [
        (f"{harness.LOCAL_HELPER}/download?url=https%3A%2F%2Fexample.com%2Fvideo.mpd&max_height=1080", None)
    ]


def test_gallery_download_tries_next_candidate_after_invalid_payload(
    harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    download_calls = []

    def fake_fetch_json(url, data=None, method="GET", timeout=30):
        return {
            "kind": "gallery",
            "items": [
                {"kind": "image", "url": "https://example.com/stale.html"},
                {"kind": "image", "url": "https://cdn.example.com/photo.jpg"},
            ],
        }, None

    def fake_download_file(url, target_path, headers=None, **kwargs):
        download_calls.append(url)
        if url == "https://example.com/stale.html":
            target_path.write_bytes(b"<html>not media</html>")
        else:
            target_path.write_bytes(b"\xff\xd8\xff\xe0" + (b"\x00" * 64))
        return True, None

    monkeypatch.setattr(harness, "fetch_json", fake_fetch_json)
    monkeypatch.setattr(harness, "download_file", fake_download_file)
    monkeypatch.setattr(harness, "capture_screenshot", lambda url, name: None)

    if harness.__name__.endswith("test_all_urls_comprehensive"):
        result = harness.test_url("Gallery", "https://example.com/article", 1)
    else:
        result = harness.test_url("Gallery", "https://example.com/article")

    assert result["download"] == "✅ PASS"
    assert result["error"] is None
    assert download_calls == [
        "https://example.com/stale.html",
        "https://cdn.example.com/photo.jpg",
    ]


def test_webapp_harness_matches_percent_encoded_page_urls() -> None:
    harness = _load_webapp_harness()
    target = "https://mainichi.jp/ch150910144i/%E9%A6%96%E7%9B%B8%E6%97%A5%E3%80%85"
    tasks = [
        {
            "status": "handed_off",
            "media": {
                "pageUrl": "https://mainichi.jp/ch150910144i/首相日々",
                "url": "https://cdn.mainichi.jp/photo.jpg",
            },
        },
        {
            "status": "handed_off",
            "media": {
                "pageUrl": "https://example.com/other",
                "url": "https://cdn.example.com/other.jpg",
            },
        },
    ]

    assert harness.clean_url(target) == "mainichi.jp/ch150910144i/首相日々"
    assert harness.filter_tasks_for_url(tasks, target) == [tasks[0]]


def test_webapp_harness_task_summary_is_bounded() -> None:
    harness = _load_webapp_harness()
    tasks = [
        {
            "status": "handed_off",
            "media": {
                "mediaKind": "image",
                "url": f"https://cdn.example.com/gallery/{idx}.jpg?token={'x' * 200}",
            },
        }
        for idx in range(8)
    ]

    summary = harness.summarize_tasks(tasks, max_items=3)

    assert summary["total"] == 8
    assert summary["statusCounts"] == {"handed_off": 8}
    assert summary["truncated"] is True
    assert len(summary["preview"]) == 3
    assert all(len(item["url"]) <= 120 for item in summary["preview"])

import importlib.util
from pathlib import Path

import pytest


HELPER_PATH = Path(__file__).parents[1] / "scripts" / "local-youtube-helper.py"
SPEC = importlib.util.spec_from_file_location("fcdownloader_local_helper", HELPER_PATH)
assert SPEC and SPEC.loader
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def test_media_validation_rejects_json_sidecar(tmp_path: Path) -> None:
    metadata = tmp_path / "video.info.json"
    metadata.write_text('{"title":"not video"}', encoding="utf-8")

    with pytest.raises(RuntimeError, match="non-media"):
        helper._validate_media_file(metadata)


def test_media_validation_rejects_json_disguised_as_mp4(tmp_path: Path) -> None:
    fake_video = tmp_path / "video.mp4"
    fake_video.write_text('{"code":-403,"message":"forbidden"}', encoding="utf-8")

    with pytest.raises(RuntimeError, match="JSON/page response"):
        helper._validate_media_file(fake_video)


def test_media_validation_accepts_mp4_signature(tmp_path: Path) -> None:
    video = tmp_path / "video.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypmp42" + (b"\x00" * 64))

    assert helper._validate_media_file(video) == video


def test_youtube_hd_format_does_not_silently_fall_back_to_360p() -> None:
    fmt = helper._format_spec("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "1080")

    assert "/18" not in fmt
    assert "height<=360" not in fmt
    assert "height<720" not in fmt
    assert "height>=720" in fmt
    assert "height<=1080" in fmt


def test_youtube_hd_format_respects_requested_cap() -> None:
    fmt = helper._format_spec("https://youtu.be/dQw4w9WgXcQ", "720")

    assert "height<=720" in fmt
    assert "height<=1080" not in fmt


def test_bilibili_formats_are_best_first() -> None:
    play = {
        "dash": {
            "video": [
                {"baseUrl": "https://v-720.m4s", "id": 64, "height": 720, "codecs": "avc1", "bandwidth": 800_000},
                {"baseUrl": "https://v-1080-small.m4s", "id": 80, "height": 1080, "codecs": "avc1", "bandwidth": 200_000},
                {"baseUrl": "https://v-1080-large.m4s", "id": 112, "height": 1080, "codecs": "hev1", "bandwidth": 1_400_000},
            ],
            "audio": [
                {"baseUrl": "https://audio.m4s", "id": 30280, "bandwidth": 128_000},
            ],
        },
    }

    formats = helper._bili_formats_from_play(play)

    assert formats[0]["formatId"] == "bili-dash-v-112"
    assert formats[0]["height"] == 1080


def test_bilibili_dash_picker_prefers_high_quality_same_height() -> None:
    play = {
        "dash": {
            "video": [
                {"baseUrl": "https://v-2160.m4s", "id": 120, "height": 2160, "codecs": "hev1", "bandwidth": 2_400_000},
                {"baseUrl": "https://v-1080-small-avc.m4s", "id": 80, "height": 1080, "codecs": "avc1", "bandwidth": 200_000},
                {"baseUrl": "https://v-1080-large-hevc.m4s", "id": 112, "height": 1080, "codecs": "hev1", "bandwidth": 1_400_000},
            ],
            "audio": [
                {"baseUrl": "https://audio.m4s", "bandwidth": 128_000},
            ],
        },
    }

    video, audio = helper._bili_pick_dash(play, None)

    assert video == "https://v-2160.m4s"
    assert audio == "https://audio.m4s"

    video, audio = helper._bili_pick_dash(play, "1080")

    assert video == "https://v-1080-large-hevc.m4s"
    assert audio == "https://audio.m4s"

    video, audio = helper._bili_pick_dash(play, None, "bili-dash-v-80")

    assert video == "https://v-1080-small-avc.m4s"
    assert audio == "https://audio.m4s"


def test_bilibili_extract_formats_prefers_api(monkeypatch: pytest.MonkeyPatch) -> None:
    called = {"api": False}

    def fake_api(url: str, cookies: str | None = None) -> dict:
        called["api"] = True
        return {
            "ok": True,
            "extractor": "BiliBiliAPI",
            "formats": [
                {"formatId": "bili-dash-v-112", "height": 1080, "vcodec": "hev1", "filesize": 1_400_000},
            ],
        }

    monkeypatch.setattr(helper, "_bili_api_formats", fake_api)

    result = helper._extract_formats("https://www.bilibili.com/video/BV1QkjC6nEQU/")

    assert called["api"] is True
    assert result["extractor"] == "BiliBiliAPI"
    assert result["formats"][0]["formatId"] == "bili-dash-v-112"

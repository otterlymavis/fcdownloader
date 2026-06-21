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

import asyncio
import io

import pytest
from fastapi import HTTPException

import main


class Upstream(io.BytesIO):
    def __init__(self, body: bytes, content_type: str):
        super().__init__(body)
        self.headers = {"Content-Type": content_type, "Content-Length": str(len(body))}


def test_validated_media_prefix_accepts_mp4() -> None:
    upstream = Upstream(b"\x00\x00\x00\x18ftypmp42" + b"payload", "video/mp4")
    prefix = main._validated_media_prefix(upstream, "video/mp4")
    assert prefix[4:8] == b"ftyp"


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        (b'{"code":-403,"message":"forbidden"}', "application/json"),
        (b'{"code":-403}', "video/mp4"),
        (b"<!doctype html><title>Denied</title>", "application/octet-stream"),
        (b"", "video/mp4"),
    ],
)
def test_validated_media_prefix_rejects_non_media(body: bytes, content_type: str) -> None:
    upstream = Upstream(body, content_type)
    with pytest.raises(HTTPException) as exc:
        main._validated_media_prefix(upstream, content_type)
    assert exc.value.status_code == 502
    assert upstream.closed


def test_direct_stream_preserves_validated_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"\x00\x00\x00\x18ftypmp42" + (b"media" * 20)
    monkeypatch.setattr(main, "_open_direct_media", lambda _url, _headers: Upstream(body, "video/mp4"))

    response = main._direct_media_stream("https://cdn.example/video.mp4", {}, {})

    async def collect() -> bytes:
        return b"".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(collect()) == body


def test_buffered_stream_preserves_validated_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"\x00\x00\x00\x18ftypmp42" + (b"buffered" * 100)
    monkeypatch.setattr(main, "_open_direct_media", lambda _url, _headers: Upstream(body, "video/mp4"))

    response = main._buffered_direct_media_stream("https://cdn.example/video.mp4", {}, {})

    async def collect() -> bytes:
        return b"".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(collect()) == body

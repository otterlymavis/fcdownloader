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


def test_extract_response_shapes_direct_ogg_as_audio() -> None:
    response = main._to_response({
        "url": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
        "ext": "ogg",
        "protocol": "https",
    })

    assert response["kind"] == "audio"
    assert response["mimeType"] == "audio/ogg"


def test_gallery_response_shapes_audio_entries() -> None:
    response = main._to_gallery_response({
        "entries": [{
            "url": "https://cdn.example.com/podcast/episode.ogg",
            "ext": "ogg",
            "protocol": "https",
        }]
    })

    assert response["items"][0]["kind"] == "audio"
    assert response["items"][0]["mimeType"] == "audio/ogg"


def test_gallery_response_skips_page_like_entries_without_media_signal() -> None:
    response = main._to_gallery_response({
        "entries": [
            {
                "url": "https://www.dailyshincho.jp/",
                "protocol": "https",
                "title": "Publisher home",
            },
            {
                "url": "https://newsatcl-pctr.c.yimg.jp/t/amd-img/example.jpg?fmt=webp",
                "ext": "jpg",
                "protocol": "https",
            },
        ]
    })

    assert [item["url"] for item in response["items"]] == [
        "https://newsatcl-pctr.c.yimg.jp/t/amd-img/example.jpg?fmt=webp"
    ]


def test_gallery_response_keeps_extensionless_media_hosts() -> None:
    response = main._to_gallery_response({
        "entries": [{
            "url": "https://video-cdn.example.com/playback/stream",
            "protocol": "https",
        }]
    })

    assert response["items"][0]["kind"] == "direct"
    assert response["items"][0]["ext"] == "mp4"


def test_media_hints_collapse_instagram_reel_to_one_video() -> None:
    info = main._info_from_media_hints(
        "https://www.instagram.com/reel/C7VgIvhsKgR/",
        [
            {
                "url": "https://scontent.cdninstagram.com/v/t51.2885-15/poster.jpg?token=poster",
                "mimeType": "image/jpeg",
                "kind": "image",
                "confidence": 0.99,
            },
            {
                "url": "https://scontent.cdninstagram.com/v/t50.2886-16/reel.mp4?token=mp4",
                "mimeType": "video/mp4",
                "kind": "video",
                "confidence": 0.8,
            },
            {
                "url": "https://scontent.cdninstagram.com/v/t50.2886-16/reel.m3u8?token=hls",
                "mimeType": "application/x-mpegURL",
                "kind": "hls",
                "confidence": 0.9,
            },
        ],
    )

    assert info is not None
    assert info.get("_type") != "playlist"
    assert info["url"] == "https://scontent.cdninstagram.com/v/t50.2886-16/reel.m3u8?token=hls"
    assert info["protocol"] == "m3u8"


def test_media_hints_collapse_single_media_page_to_best_image_when_no_video() -> None:
    info = main._info_from_media_hints(
        "https://www.instagram.com/reel/C7VgIvhsKgR/",
        [
            {
                "url": "https://scontent.cdninstagram.com/v/t51.2885-15/poster-a.jpg?token=a",
                "mimeType": "image/jpeg",
                "kind": "image",
                "width": 640,
                "height": 640,
                "confidence": 0.95,
            },
            {
                "url": "https://scontent.cdninstagram.com/v/t51.2885-15/poster-b.webp?token=b",
                "mimeType": "image/webp",
                "kind": "image",
                "width": 1440,
                "height": 1440,
                "confidence": 0.8,
            },
        ],
    )

    assert info is not None
    assert info["_type"] == "playlist"
    assert [entry["url"] for entry in info["entries"]] == [
        "https://scontent.cdninstagram.com/v/t51.2885-15/poster-b.webp?token=b",
        "https://scontent.cdninstagram.com/v/t51.2885-15/poster-a.jpg?token=a",
    ]


def test_media_hints_preserve_instagram_post_gallery() -> None:
    info = main._info_from_media_hints(
        "https://www.instagram.com/p/C7VgIvhsKgR/",
        [
            {
                "url": "https://scontent.cdninstagram.com/v/t50.2886-16/post-video.mp4?token=v",
                "mimeType": "video/mp4",
                "kind": "video",
            },
            {
                "url": "https://scontent.cdninstagram.com/v/t51.2885-15/post-image.jpg?token=i",
                "mimeType": "image/jpeg",
                "kind": "image",
            },
        ],
    )

    assert info is not None
    assert info["_type"] == "playlist"
    assert [entry["url"] for entry in info["entries"]] == [
        "https://scontent.cdninstagram.com/v/t50.2886-16/post-video.mp4?token=v",
        "https://scontent.cdninstagram.com/v/t51.2885-15/post-image.jpg?token=i",
    ]


def test_media_hints_collapse_other_single_media_pages() -> None:
    cases = [
        (
            "https://www.tiktok.com/@example/video/7350000000000000000",
            "https://v16m.tiktokcdn.com/video/tiktok-video.mp4?token=v",
            "https://p16-sign.tiktokcdn-us.com/tos-useast5-p/poster.jpg?token=p",
        ),
        (
            "https://x.com/example/status/1800000000000000000",
            "https://video.twimg.com/amplify_video/playlist.m3u8?token=hls",
            "https://pbs.twimg.com/media/thumb.jpg?format=jpg",
        ),
        (
            "https://www.youtube.com/shorts/abc123XYZ",
            "https://rr1---sn.example.googlevideo.com/videoplayback/video.mp4?id=abc",
            "https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg",
        ),
    ]

    for page_url, video_url, image_url in cases:
        info = main._info_from_media_hints(
            page_url,
            [
                {"url": image_url, "mimeType": "image/jpeg", "kind": "image", "confidence": 0.95},
                {"url": video_url, "mimeType": "video/mp4", "kind": "video", "confidence": 0.85},
            ],
        )

        assert info is not None
        assert info.get("_type") != "playlist"
        assert info["url"] == video_url


def test_media_hints_collapse_audio_only_single_media_page() -> None:
    info = main._info_from_media_hints(
        "https://www.youtube.com/watch?v=abc123XYZ",
        [
            {
                "url": "https://rr1---sn.example.googlevideo.com/videoplayback/audio.m4a?id=abc",
                "mimeType": "audio/mp4",
                "kind": "audio",
                "bitrate": 192000,
                "confidence": 0.85,
            },
            {
                "url": "https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg",
                "mimeType": "image/jpeg",
                "kind": "image",
                "width": 1280,
                "height": 720,
                "confidence": 0.95,
            },
        ],
    )

    assert info is not None
    assert info["_type"] == "playlist"
    assert [entry["url"] for entry in info["entries"]] == [
        "https://rr1---sn.example.googlevideo.com/videoplayback/audio.m4a?id=abc",
        "https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg",
    ]


def test_media_hints_tolerate_stringy_quality_fields() -> None:
    info = main._info_from_media_hints(
        "https://x.com/example/status/1800000000000000000",
        [
            {
                "url": "https://pbs.twimg.com/media/image-a.jpg?format=jpg",
                "mimeType": "image/jpeg",
                "kind": "image",
                "width": "720p",
                "height": "480",
                "bitrate": "not-a-number",
            },
            {
                "url": "https://video.twimg.com/amplify_video/playlist.m3u8?token=hls",
                "mimeType": "application/x-mpegURL",
                "kind": "hls",
                "width": "1920.0",
                "height": "1080",
                "bitrate": "3500000.0",
            },
        ],
    )

    assert info is not None
    assert info.get("_type") != "playlist"
    assert info["url"] == "https://video.twimg.com/amplify_video/playlist.m3u8?token=hls"


def test_media_hints_preserve_x_image_only_gallery() -> None:
    info = main._info_from_media_hints(
        "https://x.com/example/status/1800000000000000000",
        [
            {
                "url": "https://pbs.twimg.com/media/image-a.jpg?format=jpg",
                "mimeType": "image/jpeg",
                "kind": "image",
                "width": 1200,
                "height": 800,
            },
            {
                "url": "https://pbs.twimg.com/media/image-b.jpg?format=jpg",
                "mimeType": "image/jpeg",
                "kind": "image",
                "width": 1600,
                "height": 1000,
            },
        ],
    )

    assert info is not None
    assert info["_type"] == "playlist"
    assert [entry["url"] for entry in info["entries"]] == [
        "https://pbs.twimg.com/media/image-b.jpg?format=jpg",
        "https://pbs.twimg.com/media/image-a.jpg?format=jpg",
    ]


def test_media_hints_collapse_fb_watch_short_link_with_video() -> None:
    info = main._info_from_media_hints(
        "https://fb.watch/abc123/",
        [
            {
                "url": "https://scontent-lga3-1.xx.fbcdn.net/v/t39/poster.jpg?token=p",
                "mimeType": "image/jpeg",
                "kind": "image",
            },
            {
                "url": "https://video-lga3-1.xx.fbcdn.net/v/t42/video.mp4?token=v",
                "mimeType": "video/mp4",
                "kind": "video",
            },
        ],
    )

    assert info is not None
    assert info.get("_type") != "playlist"
    assert info["url"] == "https://video-lga3-1.xx.fbcdn.net/v/t42/video.mp4?token=v"


def test_media_hints_preserve_generic_gallery() -> None:
    info = main._info_from_media_hints(
        "https://example.com/gallery/abc",
        [
            {
                "url": "https://cdn.example.com/gallery/clip.mp4?token=v",
                "mimeType": "video/mp4",
                "kind": "video",
            },
            {
                "url": "https://cdn.example.com/gallery/photo.jpg?token=i",
                "mimeType": "image/jpeg",
                "kind": "image",
            },
        ],
    )

    assert info is not None
    assert info["_type"] == "playlist"
    assert [entry["url"] for entry in info["entries"]] == [
        "https://cdn.example.com/gallery/clip.mp4?token=v",
        "https://cdn.example.com/gallery/photo.jpg?token=i",
    ]


def test_buffered_stream_preserves_validated_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"\x00\x00\x00\x18ftypmp42" + (b"buffered" * 100)
    monkeypatch.setattr(main, "_open_direct_media", lambda _url, _headers: Upstream(body, "video/mp4"))

    response = main._buffered_direct_media_stream("https://cdn.example/video.mp4", {}, {})

    async def collect() -> bytes:
        return b"".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(collect()) == body

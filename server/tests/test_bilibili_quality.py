from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import new_extractors


def test_dash_pair_wins_over_low_resolution_durl():
    result = new_extractors._parse_bilibili_playinfo({
        "data": {
            "durl": [{
                "url": "https://cdn.example.com/480p.mp4",
                "size": 5_000_000,
            }],
            "dash": {
                "video": [
                    {
                        "id": 80,
                        "baseUrl": "https://cdn.example.com/1080p.m4s",
                        "width": 1920,
                        "height": 1080,
                        "bandwidth": 2_000_000,
                        "codecs": "avc1.640028",
                        "mimeType": "video/mp4",
                    },
                    {
                        "id": 32,
                        "baseUrl": "https://cdn.example.com/480p.m4s",
                        "width": 852,
                        "height": 480,
                        "bandwidth": 500_000,
                        "codecs": "avc1.64001f",
                        "mimeType": "video/mp4",
                    },
                ],
                "audio": [{
                    "id": 30280,
                    "baseUrl": "https://cdn.example.com/audio.m4s",
                    "bandwidth": 192_000,
                    "codecs": "mp4a.40.2",
                    "mimeType": "audio/mp4",
                }],
            },
        },
    }, "HD video", "https://www.bilibili.com/video/BV1234567890")

    assert result is not None
    assert result["height"] == 1080
    assert result["url"] == "https://cdn.example.com/1080p.m4s"
    assert result["format_id"] == "80+30280"
    assert result["requested_formats"][0]["url"].endswith("/1080p.m4s")
    assert result["requested_formats"][1]["url"].endswith("/audio.m4s")


def test_durl_remains_fallback_without_dash_audio():
    result = new_extractors._parse_bilibili_playinfo({
        "data": {
            "durl": [{"url": "https://cdn.example.com/480p.mp4"}],
            "dash": {
                "video": [{
                    "baseUrl": "https://cdn.example.com/video-only.m4s",
                    "height": 1080,
                }],
                "audio": [],
            },
        },
    }, "Fallback video", "https://www.bilibili.com/video/BV1234567890")

    assert result is not None
    assert result["url"] == "https://cdn.example.com/480p.mp4"
    assert "requested_formats" not in result

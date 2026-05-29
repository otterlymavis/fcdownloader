from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))

import auth  # noqa: E402
from main import _to_gallery_response, _to_response  # noqa: E402
from strategies import run_extraction  # noqa: E402


THUMBNAIL_RE = re.compile(
    r"(?:thumb|thumbnail|avatar|profile(?:_pic)?|placeholder|blank|pixel|"
    r"[_/-](?:\d{1,3}x\d{1,3}|s\d{2,4}x\d{2,4})(?:[_.?/-]|$)|"
    r"[?&](?:thumb|thumbnail|preview|avatar)=)",
    re.I,
)


@dataclass(frozen=True)
class Target:
    name: str
    url: str
    note: str = ""
    expect: str = "pass"


TARGETS: list[Target] = [
    Target("oricon-gallery", "https://www.oricon.co.jp/news/2452025/photo/1/"),
    Target("natalie-gallery", "https://natalie.mu/music/news/670712"),
    Target("modelpress-gallery", "https://mdpr.jp/news/4690888"),
    Target("naver-blog-gallery", "https://blog.naver.com/jalee3228/224297926556"),
    Target("bilibili-video", "https://www.bilibili.com/video/BV1xx411c7mD"),
    Target("vimeo-video", "https://vimeo.com/76979871"),
    Target("youtube-test-video", "https://www.youtube.com/watch?v=BaW_jenozKc", note="may return server proxy"),
    Target("pixiv-artwork", "https://www.pixiv.net/artworks/100000000"),
]

EXPECTED_BLOCKED: list[Target] = [
    Target("yahoo-japan-article", "https://news.yahoo.co.jp/articles/e9edfb58a98f04b796f0c48de4b31cecaeb37c2c", expect="blocked", note="Yahoo blocks datacenter page fetches; browser HTML/cookies path is supported"),
    Target("reddit-video", "https://www.reddit.com/r/videos/comments/7w7n9p/the_original_youtube_video/", expect="blocked", note="Reddit currently requires account cookies from this server"),
    Target("instagram-public-post", "https://www.instagram.com/p/Cu2lA1gL2vH/", expect="blocked", note="Meta often requires browser/session cookies"),
    Target("threads-public-post", "https://www.threads.net/@instagram/post/CuZsgc9vQ0M", expect="blocked", note="Meta often requires browser/session cookies"),
]


def _shape(info: dict[str, Any]) -> dict[str, Any]:
    if info.get("_type") == "playlist" and info.get("entries"):
        shaped = _to_gallery_response(info)
        shaped["title"] = info.get("title")
        return shaped
    shaped = _to_response(info)
    shaped["title"] = info.get("title")
    return shaped


def _first_media(response: dict[str, Any]) -> tuple[str | None, dict[str, str], str]:
    kind = response.get("kind")
    if kind == "gallery":
        for item in response.get("items") or []:
            url = item.get("url") or item.get("videoUrl")
            if url:
                return url, item.get("headers") or {}, item.get("kind") or "gallery-item"
        return None, {}, "gallery"
    if kind == "paired":
        return response.get("videoUrl"), response.get("headers") or {}, "paired-video"
    return response.get("url"), response.get("headers") or {}, str(kind or "unknown")


def _probe(url: str, headers: dict[str, str]) -> dict[str, Any]:
    if url.startswith("/"):
        return {"ok": True, "skipped": "relative backend stream URL"}
    if "youtube" in url and "ytdl-stream" in url:
        return {"ok": True, "skipped": "server stream endpoint"}
    req_headers = {
        "User-Agent": headers.get("User-Agent") or headers.get("user-agent") or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "*/*",
    }
    for key in ("Referer", "Origin", "Cookie"):
        if headers.get(key):
            req_headers[key] = headers[key]
    request = urllib.request.Request(url, headers=req_headers)
    with urllib.request.urlopen(request, timeout=25) as resp:
        chunk = resp.read(2048)
        ctype = resp.headers.get("Content-Type", "")
        clen = resp.headers.get("Content-Length")
        ok_type = (
            ctype.startswith(("image/", "video/", "audio/"))
            or "mpegurl" in ctype.lower()
            or url.lower().split("?", 1)[0].endswith((".m3u8", ".mpd"))
        )
        return {
            "ok": bool(chunk) and (ok_type or len(chunk) > 0),
            "status": getattr(resp, "status", None),
            "content_type": ctype,
            "content_length": clen,
            "bytes": len(chunk),
        }


def run_target(target: Target) -> dict[str, Any]:
    started = time.time()
    try:
        info = run_extraction(target.url)
        response = _shape(info)
        media_url, headers, media_kind = _first_media(response)
        if not media_url:
            raise RuntimeError("extracted response contained no media URL")
        if THUMBNAIL_RE.search(media_url):
            raise RuntimeError(f"thumbnail-like media URL selected: {media_url}")
        parsed_media = urllib.parse.urlparse(media_url)
        qs = urllib.parse.parse_qs(parsed_media.query)
        dimensions = [
            int(values[-1])
            for key in ("width", "w", "height", "h")
            for values in [qs.get(key) or []]
            if values and str(values[-1]).isdigit()
        ]
        if dimensions and max(dimensions) <= 512:
            raise RuntimeError(f"small thumbnail-like media URL selected: {media_url}")
        probe = _probe(media_url, headers)
        if not probe.get("ok"):
            raise RuntimeError(f"download probe failed: {probe}")
        count = len(response.get("items") or []) if response.get("kind") == "gallery" else 1
        return {
            "name": target.name,
            "status": "pass",
            "kind": response.get("kind"),
            "media_kind": media_kind,
            "count": count,
            "media_url": media_url,
            "probe": probe,
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
        return {"name": target.name, "status": "fail", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {
            "name": target.name,
            "status": "fail" if target.expect == "pass" else "expected-blocked",
            "error": str(exc)[:500],
            "elapsed_ms": int((time.time() - started) * 1000),
        }


def main() -> int:
    results = [run_target(t) for t in TARGETS]
    blocked = [run_target(t) for t in EXPECTED_BLOCKED]
    report = {
        "pass": sum(1 for r in results if r["status"] == "pass"),
        "fail": [r for r in results if r["status"] != "pass"],
        "expected_blocked": blocked,
        "results": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

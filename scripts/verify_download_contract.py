#!/usr/bin/env python3
"""Probe a download endpoint without mistaking upstream outages for regressions."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BACKEND = "https://fcdownloader-extractor.fly.dev"
DEFAULT_BILIBILI_URL = "https://www.bilibili.com/video/BV1PkR2BkEUt"
MEDIA_TYPES = ("video/", "audio/", "application/octet-stream")


def looks_like_media(content_type: str, prefix: bytes) -> bool:
    if not prefix:
        return False
    sample = prefix.lstrip().lower()
    if sample.startswith((b"{", b"[", b"<html", b"<!doctype html", b"<?xml")):
        return False
    if any(content_type.lower().startswith(value) for value in MEDIA_TYPES):
        return True
    # ISO Base Media files put the ftyp box at byte offset 4.
    return len(prefix) >= 12 and prefix[4:8] == b"ftyp"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default=DEFAULT_BACKEND)
    parser.add_argument("--url", default=DEFAULT_BILIBILI_URL)
    args = parser.parse_args()

    endpoint = f"{args.backend.rstrip('/')}/download?{urllib.parse.urlencode({'url': args.url})}"
    request = urllib.request.Request(endpoint, headers={"User-Agent": "FCDownloader-CI/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
            prefix = response.read(4096)
    except urllib.error.HTTPError as exc:
        detail = exc.read(512).decode("utf-8", errors="replace").strip()
        try:
            parsed = json.loads(detail)
            detail = str(parsed.get("detail") or parsed.get("error") or detail)
        except Exception:
            pass
        print(f"::warning::Live Bilibili probe unavailable (HTTP {exc.code}): {detail[:240]}")
        return 0
    except (OSError, TimeoutError) as exc:
        print(f"::warning::Live Bilibili probe unavailable: {str(exc)[:240]}")
        return 0

    if not looks_like_media(content_type, prefix):
        preview = prefix[:160].decode("utf-8", errors="replace").replace("\n", " ")
        print(f"::error::Download endpoint returned non-media with HTTP 200 ({content_type}): {preview}")
        return 1

    print(f"Bilibili download contract passed ({content_type}, non-document media response verified).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

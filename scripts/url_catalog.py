#!/usr/bin/env python3
"""Shared URL catalog for Apple-platform automation scripts."""
from __future__ import annotations

from pathlib import Path
import importlib.util


ROOT = Path(__file__).resolve().parents[1]


EXTRA_URLS: dict[str, tuple[str, str]] = {
    "Direct-MP4": (
        "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "stable direct MP4 smoke test",
    ),
    "Direct-Audio": (
        "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
        "stable direct audio smoke test",
    ),
    "Direct-HLS": (
        "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        "Mux sample HLS manifest",
    ),
    "Direct-DASH": (
        "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
        "DASH manifest smoke test",
    ),
}


def _load_test_all_urls() -> dict[str, tuple[str, str]]:
    path = ROOT / "test_all_urls.py"
    spec = importlib.util.spec_from_file_location("fcdownloader_test_all_urls", path)
    if not spec or not spec.loader:
        raise RuntimeError(f"could not import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return dict(module.URLS)


def all_urls(include_extra: bool = True) -> dict[str, tuple[str, str]]:
    urls = _load_test_all_urls()
    if include_extra:
        urls.update(EXTRA_URLS)
    return urls


def select_urls(names: list[str], include_extra: bool = True) -> list[tuple[str, str, str]]:
    urls = all_urls(include_extra=include_extra)
    wanted = [name.lower() for name in names]
    selected = [
        (name, url, note)
        for name, (url, note) in urls.items()
        if not wanted or name.lower() in wanted
    ]
    if names and not selected:
        available = ", ".join(urls)
        raise SystemExit(f"No matching URLs. Available: {available}")
    return selected

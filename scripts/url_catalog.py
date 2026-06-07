#!/usr/bin/env python3
"""Shared URL catalog for Apple-platform automation scripts."""
from __future__ import annotations

from pathlib import Path
import importlib.util


ROOT = Path(__file__).resolve().parents[1]


EXTRA_URLS: dict[str, tuple[str, str]] = {
    "Direct-MP4": (
        "https://www.w3schools.com/html/mov_bbb.mp4",
        "stable direct MP4 smoke test",
    ),
    "Direct-HLS": (
        "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/"
        "bipbop_16x9_variant.m3u8",
        "Apple sample HLS manifest",
    ),
    "Direct-DASH": (
        "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.mpd",
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

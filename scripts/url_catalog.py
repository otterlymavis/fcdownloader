#!/usr/bin/env python3
"""Shared URL catalog for Apple-platform automation scripts."""
from __future__ import annotations

from pathlib import Path
import importlib.util


ROOT = Path(__file__).resolve().parents[1]


def _load_test_all_urls() -> dict[str, tuple[str, str]]:
    path = ROOT / "tests" / "test_all_urls.py"
    spec = importlib.util.spec_from_file_location("fcdownloader_test_all_urls", path)
    if not spec or not spec.loader:
        raise RuntimeError(f"could not import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return dict(module.URLS)


def all_urls(include_extra: bool = True) -> dict[str, tuple[str, str]]:
    return _load_test_all_urls()


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

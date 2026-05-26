"""
RequestClassifier — analyse a URL and produce an extraction risk profile.

This is a pure-function module (no I/O, no side effects).  It consults the
extractor registry and applies heuristics to predict:

  - whether authentication is likely required
  - whether YouTube SABR is a risk (skip_download won't work)
  - whether this looks like a livestream
  - whether HLS/DASH manifests are likely
  - whether the server-side /ytdl-stream proxy is needed

The ExtractionStrategyEngine uses this profile to order its strategy list and
skip strategies that have no chance of succeeding.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import registry


@dataclass(frozen=True)
class ExtractionProfile:
    """Risk/capability profile for a single extraction request."""

    # ── Source URL properties ─────────────────────────────────────────────────
    url: str
    is_youtube: bool = False
    is_japanese: bool = False
    is_direct_media: bool = False    # URL ends with .mp4/.m3u8/etc.
    is_platform_specific: bool = False  # has a custom extractor in extractors.py

    # ── Risk flags ────────────────────────────────────────────────────────────
    auth_likely: bool = False
    """Site typically requires a logged-in session."""

    sabr_risk: bool = False
    """YouTube SABR: skip_download=True may fail; /ytdl-stream is the fix."""

    livestream_likely: bool = False
    """URL patterns suggest a live stream (HLS-only, no seekable formats)."""

    hls_likely: bool = False
    """Site commonly delivers HLS manifests."""

    proxy_stream_needed: bool = False
    """Server-side download proxy (/ytdl-stream) is the recommended path."""

    # ── Recommended strategy order ────────────────────────────────────────────
    preferred_yt_clients: tuple[str, ...] = ()

    # ── Size / timeout hints ──────────────────────────────────────────────────
    max_duration_hint: int | None = None


# ── Heuristics ────────────────────────────────────────────────────────────────

_DIRECT_MEDIA_RE_PARTS = (
    ".mp4", ".webm", ".mov", ".m4v", ".m3u8", ".mpd",
    "bilivideo.com/", "weibocdn.com/", "xhscdn.com/",
    "cdninstagram.com/", "scontent", ".cdninstagram.com/",
    "fbcdn.net/", "threadscdn.com/",
)

_LIVESTREAM_SIGNALS = (
    "/live", "/stream", "is_live=", "live_chat", "live_from_start",
    "/hls/", "/manifest/hls", ".m3u8",
)


def classify(url: str, cookies_provided: bool = False) -> ExtractionProfile:
    """Classify *url* and return an ExtractionProfile.

    Args:
        url: The page URL to classify.
        cookies_provided: Whether the caller supplied session cookies.
    """
    cap = registry.lookup(url)

    is_yt = registry.is_youtube(url)
    is_ja = registry.is_japanese_domain(url)
    is_direct = any(s in url for s in _DIRECT_MEDIA_RE_PARTS)
    is_live = any(s in url.lower() for s in _LIVESTREAM_SIGNALS)

    # Auth is required when the registry says so AND the caller has no cookies.
    auth_likely = cap.requires_auth_on_datacenter and not cookies_provided

    # SABR risk only applies to YouTube without user cookies.  When cookies are
    # supplied the ios client usually avoids SABR entirely.
    sabr_risk = is_yt and cap.sabr_risk and not cookies_provided

    # Proxy-stream is needed when both SABR risk AND no cookies (the ytdl-stream
    # endpoint is the only path that CAN handle SABR from Fly.io IPs).
    proxy_stream_needed = sabr_risk

    return ExtractionProfile(
        url=url,
        is_youtube=is_yt,
        is_japanese=is_ja,
        is_direct_media=is_direct,
        is_platform_specific=cap.has_platform_extractor,
        auth_likely=auth_likely,
        sabr_risk=sabr_risk,
        livestream_likely=is_live,
        hls_likely=cap.hls_common or is_live,
        proxy_stream_needed=proxy_stream_needed,
        preferred_yt_clients=cap.preferred_yt_clients,
        max_duration_hint=cap.max_duration_hint,
    )

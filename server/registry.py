"""
Extractor capability registry.

Per-site definitions that the RequestClassifier and ExtractionStrategyEngine
consult to decide which strategies to try, in what order, and what risks to
expect.  Keeps YouTube-specific hacks out of generic extraction code.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence


@dataclass(frozen=True)
class ExtractorCapabilities:
    """Capability profile for a site or group of sites."""

    # Hostnames (partial match via `in`) that this entry applies to.
    hosts: tuple[str, ...]

    # Site requires authenticated session for ANY content from a datacenter IP.
    # YouTube bot-detects Fly.io iad and demands cookies even for public videos.
    requires_auth_on_datacenter: bool = False

    # Site uses YouTube SABR — yt-dlp skip_download=True cannot resolve format
    # URLs; must fall back to /ytdl-stream proxy.
    sabr_risk: bool = False

    # Site commonly serves HLS manifests (m3u8) rather than direct MP4 URLs.
    hls_common: bool = False

    # Site uses DASH (mpd) manifests.
    dash_common: bool = False

    # Preferred YouTube player clients, in priority order.
    # Non-YouTube sites ignore this field.
    preferred_yt_clients: tuple[str, ...] = ()

    # Site has a custom platform extractor in extractors.py.
    has_platform_extractor: bool = False

    # Referer / Origin headers required to get the CDN to respond.
    requires_referer: bool = False

    # Site requires Accept-Language: ja for correct region-routing.
    requires_ja_locale: bool = False

    # Approximate maximum content duration (seconds).  Used to tune timeouts.
    max_duration_hint: int | None = None


# ── Registry entries ──────────────────────────────────────────────────────────

_REGISTRY: list[ExtractorCapabilities] = [
    ExtractorCapabilities(
        hosts=("youtube.com/", "youtu.be/", "youtube-nocookie.com/"),
        requires_auth_on_datacenter=True,
        sabr_risk=True,
        preferred_yt_clients=("ios", "web_safari", "web_creator", "mweb", "tv"),
        max_duration_hint=7200,
    ),
    ExtractorCapabilities(
        hosts=("bilibili.com", "bilivideo.com", "biliapi.com"),
        hls_common=True,
        dash_common=True,
        requires_referer=True,
        max_duration_hint=14400,
    ),
    ExtractorCapabilities(
        hosts=("weibo.com", "weibo.cn", "video.weibo.com", "weibocdn.com", "sinaimg.cn"),
        has_platform_extractor=True,
        requires_referer=True,
    ),
    ExtractorCapabilities(
        hosts=("instagram.com",),
        has_platform_extractor=True,
    ),
    ExtractorCapabilities(
        hosts=("threads.net", "threads.com"),
        has_platform_extractor=True,
    ),
    ExtractorCapabilities(
        hosts=("xiaohongshu.com", "xhslink.com", "xhscdn.com"),
        requires_referer=True,
    ),
    ExtractorCapabilities(
        hosts=("nicovideo.jp", "nico.ms"),
        requires_ja_locale=True,
    ),
    ExtractorCapabilities(
        hosts=("video.fc2.com", "fc2.com/video"),
        requires_ja_locale=True,
    ),
    ExtractorCapabilities(
        hosts=("dmm.co.jp", "dmm.com"),
        requires_ja_locale=True,
    ),
    ExtractorCapabilities(
        hosts=("gyao.yahoo.co.jp", "video.yahoo.co.jp"),
        requires_ja_locale=True,
    ),
    ExtractorCapabilities(
        hosts=("twitcasting.tv",),
        requires_ja_locale=True,
        hls_common=True,
    ),
    ExtractorCapabilities(
        hosts=("abema.tv", "abema.io"),
        requires_ja_locale=True,
        hls_common=True,
    ),
    ExtractorCapabilities(
        hosts=("nhk.or.jp", "nhk.jp"),
        requires_ja_locale=True,
        hls_common=True,
    ),
    ExtractorCapabilities(
        hosts=("vimeo.com",),
        # Embed-only videos require the embedding page as Referer.
        requires_referer=True,
    ),
    ExtractorCapabilities(
        hosts=("reddit.com", "redd.it", "redditmedia.com"),
    ),
    ExtractorCapabilities(
        hosts=("twitter.com", "x.com", "t.co"),
    ),
    ExtractorCapabilities(
        hosts=("tiktok.com", "vm.tiktok.com"),
    ),
    ExtractorCapabilities(
        hosts=("facebook.com", "fb.com", "fb.watch", "fbcdn.net"),
        has_platform_extractor=False,  # yt-dlp handles
    ),
]

# Sentinel for "no match" — a neutral capability profile.
_GENERIC = ExtractorCapabilities(hosts=())


# ── Lookup API ────────────────────────────────────────────────────────────────


def lookup(url: str) -> ExtractorCapabilities:
    """Return the best-matching capability profile for *url*.

    Matching is substring: the first entry whose any host token appears in
    the URL string is returned.  Entries are checked in _REGISTRY order, so
    more-specific entries should be listed first.
    """
    for cap in _REGISTRY:
        if any(h in url for h in cap.hosts):
            return cap
    return _GENERIC


def is_youtube(url: str) -> bool:
    return any(h in url for h in ("youtube.com/", "youtu.be/", "youtube-nocookie.com/"))


def is_japanese_domain(url: str) -> bool:
    """Return True if the URL looks like a Japanese streaming/media site.

    Matches:
    - Any hostname ending in .jp (covers tver.jp, nhk.or.jp, ameblo.jp, etc.)
    - A curated list of known Japanese sites without .jp TLD
    """
    import urllib.parse
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except Exception:
        return False
    if not host:
        return False
    # Generic .jp TLD check — covers tver.jp, ameblo.jp, nicovideo.jp, etc.
    if host.endswith(".jp"):
        return True
    # Non-.jp Japanese sites
    _JA_HOSTS_NON_JP = (
        "nico.ms",
        "video.fc2.com", "fc2.com",
        "twitcasting.tv",
        "abema.tv", "abema.io",
        "mildom.com",
        "pixiv.net", "fanbox.cc",
        "openrec.tv",
    )
    return any(host == h or host.endswith("." + h) for h in _JA_HOSTS_NON_JP)

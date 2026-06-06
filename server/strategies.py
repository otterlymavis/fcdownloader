"""
ExtractionStrategyEngine — ordered fallback pipeline for media extraction.

Each strategy is a callable that returns an ExtractorResult dict:
  {
    "success": bool,
    "fatal":   bool,          # if True, stop pipeline immediately
    "strategy": str,
    "reason":   str | None,   # failure reason (no sensitive data)
    "media":    dict | None,  # yt-dlp info dict on success
  }

The engine runs strategies in order, returns on first success, and accumulates
diagnostics for the error response when all strategies fail.
"""
from __future__ import annotations

import os
import socket
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from typing import Any, Callable

from fastapi import HTTPException
from yt_dlp import YoutubeDL

import auth
import classifier
import extractors
import languages
import registry
import source_audit
from config import COOKIES_FILE, FORMAT_SPEC, QUALITY_FORMAT_SPECS, SERVER_BASE_URL, MOBILE_UA
from telemetry import RequestContext
from utils import (
    cache_key,
    fetch_with_retry,
    normalize_url,
    safe_headers,
    safe_text,
    guess_ext_from_url,
)

_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

_DNS_FALLBACK_HOSTS = {"video.fc2.com", "live.fc2.com"}
_DNS_FALLBACK_CACHE: dict[str, list[str]] = {}


def _server_stream_supported(page_url: str) -> bool:
    lowered = page_url.lower()
    return registry.is_youtube(lowered) or any(
        host in lowered
        for host in ("nicovideo.jp", "nico.ms", "niconico.com", "nicochannel.jp")
    )


def _extractor_name_for(page_url: str) -> str:
    lowered = page_url.lower()
    if registry.is_youtube(lowered):
        return "youtube"
    if any(host in lowered for host in ("nicovideo.jp", "nico.ms", "niconico.com", "nicochannel.jp")):
        return "niconico"
    return "yt-dlp"


def _resolve_host_via_google(host: str) -> list[str]:
    cached = _DNS_FALLBACK_CACHE.get(host)
    if cached:
        return cached
    query = urllib.parse.urlencode({"name": host, "type": "A"})
    req = urllib.request.Request(
        f"https://dns.google/resolve?{query}",
        headers={"User-Agent": _DESKTOP_UA, "Accept": "application/dns-json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            import json
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:
        return []
    addrs = [
        str(item.get("data"))
        for item in data.get("Answer") or []
        if item.get("type") == 1 and item.get("data")
    ]
    _DNS_FALLBACK_CACHE[host] = addrs
    return addrs


@contextmanager
def _patched_dns_fallback(page_url: str):
    host = (urllib.parse.urlsplit(page_url).hostname or "").lower()
    if host not in _DNS_FALLBACK_HOSTS:
        yield
        return

    original_getaddrinfo = socket.getaddrinfo

    def getaddrinfo(name, port, family=0, type=0, proto=0, flags=0):  # noqa: A002
        try:
            return original_getaddrinfo(name, port, family, type, proto, flags)
        except socket.gaierror:
            if str(name).lower() != host:
                raise
            answers = _resolve_host_via_google(host)
            if not answers:
                raise
            socktype = type or socket.SOCK_STREAM
            protocol = proto or socket.IPPROTO_TCP
            return [
                (socket.AF_INET, socktype, protocol, "", (addr, port))
                for addr in answers
            ]

    socket.getaddrinfo = getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = original_getaddrinfo


# ── Result helpers ────────────────────────────────────────────────────────────


def _result(
    strategy: str,
    success: bool,
    *,
    fatal: bool = False,
    reason: str | None = None,
    media: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "success": success,
        "fatal": fatal,
        "strategy": strategy,
        **({"reason": reason} if reason else {}),
        **({"media": media} if media else {}),
    }


def _skip(strategy: str, reason: str) -> dict[str, Any]:
    return _result(strategy, False, reason=reason)


# ── Individual strategies ─────────────────────────────────────────────────────


def _strategy_ydl(
    page_url: str,
    ydl_opts: dict[str, Any],
    force_generic: bool = False,
) -> dict[str, Any]:
    name = "generic yt-dlp extractor" if force_generic else "yt-dlp"
    opts = {**ydl_opts}
    if force_generic:
        opts["force_generic_extractor"] = True
    try:
        with _patched_dns_fallback(page_url):
            with YoutubeDL(opts) as ydl:
                info = ydl.extract_info(page_url, download=False)
        if not info:
            return _result(name, False, reason="yt-dlp returned no info")
        # YouTube guard: skip_download=True from a datacenter IP often resolves
        # HLS/m3u8 as a SABR fallback.  Those URLs require YouTube session cookies
        # bound to the extracting IP, so ffmpeg can't remux them client-side.
        # Treat HLS as a failure so ytdl-stream (actual download mode) runs instead.
        if registry.is_youtube(page_url) or any(h in page_url for h in ("nicovideo.jp", "nico.ms", "niconico.com", "nicochannel.jp")):
            _proto = (info.get("protocol") or "").lower()
            _url = (info.get("url") or "").lower()
            if "m3u8" in _proto or ".m3u8" in _url:
                return _result(
                    name, False,
                    reason=(
                        f"{_extractor_name_for(page_url)} returned HLS ({_proto!r}) "
                        "via skip_download; ytdl-stream needed"
                    ),
                )
        if isinstance(info, dict):
            source_audit.add_audit(info, source_audit.format_audit(info, name, "yt-dlp formats"))
        return _result(name, True, media=info)
    except Exception as exc:  # noqa: BLE001
        msg = safe_text(exc)[:400]
        return _result(name, False, reason=msg or "yt-dlp failed")


def _strategy_ydl_client(
    page_url: str,
    ydl_opts: dict[str, Any],
    client: str,
) -> dict[str, Any]:
    """Re-try yt-dlp with a single specific YouTube player_client."""
    name = f"yt-dlp/{client}"
    existing = ydl_opts.get("extractor_args") or {}
    opts = {
        **ydl_opts,
        "extractor_args": {
            **existing,
            "youtube": {
                **(existing.get("youtube") or {}),
                "player_client": [client],
            },
        },
    }
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
        if not info:
            return _result(name, False, reason="yt-dlp returned no info")
        # Same HLS guard as _strategy_ydl — individual clients also hit SABR.
        if registry.is_youtube(page_url):
            _proto = (info.get("protocol") or "").lower()
            _url = (info.get("url") or "").lower()
            if "m3u8" in _proto or ".m3u8" in _url:
                return _result(
                    name, False,
                    reason=(
                        f"YouTube/{client} returned HLS ({_proto!r}) via skip_download — "
                        "SABR fallback; ytdl-stream needed"
                    ),
                )
        if isinstance(info, dict):
            source_audit.add_audit(info, source_audit.format_audit(info, name, "yt-dlp formats"))
        return _result(name, True, media=info)
    except Exception as exc:  # noqa: BLE001
        msg = safe_text(exc)[:400]
        return _result(name, False, reason=msg or "yt-dlp failed")


def _strategy_platform_extractors(
    page_url: str,
    cookies: str | None,
) -> dict[str, Any]:
    name = "platform-specific extractor"
    try:
        if any(h in page_url for h in ("weibo.com", "weibo.cn", "video.weibo.com")):
            info = extractors.extract_weibo(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Weibo extractor found no media")

        if "threads.net" in page_url or "threads.com" in page_url:
            info = extractors.extract_threads(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Threads extractor found no media")

        if "instagram.com" in page_url:
            info = extractors.extract_instagram(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Instagram extractor found no media")

        if any(h in page_url for h in ("mdpr.jp", "modelpress.jp")):
            info = extractors.extract_modelpress(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Modelpress extractor found no media")

        if "trilltrill.jp" in page_url:
            info = extractors.extract_trilltrill(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Trilltrill extractor found no media")

        if "blog.naver.com" in page_url:
            info = extractors.extract_naver_blog(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Naver Blog extractor found no media")

        if any(h in page_url for h in ("xiaohongshu.com", "rednote.com", "xhslink.com", "xhscdn.com")):
            info = extractors.extract_xiaohongshu(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Xiaohongshu extractor found no media")

        if any(h in page_url for h in ("bilibili.com", "b23.tv", "bilibili.tv")):
            info = extractors.extract_bilibili(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Bilibili extractor found no media")

        if any(h in page_url for h in ("tiktok.com", "tiktokv.com", "douyin.com", "iesdouyin.com")):
            info = extractors.extract_tiktok(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="TikTok extractor found no media")

        if any(h in page_url for h in ("twitter.com", "x.com", "t.co")):
            tw_url = page_url
            if "t.co" in page_url:
                # t.co is Twitter's own link shortener — follow the redirect to the
                # real tweet URL before passing to the extractor.
                try:
                    import urllib.request as _ur
                    req = _ur.Request(page_url, headers={"User-Agent": MOBILE_UA}, method="HEAD")
                    with _ur.urlopen(req, timeout=8) as r:
                        if r.url and r.url != page_url:
                            tw_url = r.url
                except Exception:
                    pass
            info = extractors.extract_twitter(tw_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Twitter extractor found no media")

        if any(h in page_url for h in ("reddit.com", "redd.it")):
            info = extractors.extract_reddit(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Reddit extractor found no media")

        if "note.com" in page_url:
            info = extractors.extract_note(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="note.com extractor found no media")

        info = extractors.extract_curated_site(page_url, cookies)
        if info:
            return _result(name, True, media=info)

        info = extractors.extract_api_probe(page_url, cookies)
        if info:
            return _result(name, True, media=info)

        info = extractors.extract_article_photo_gallery(page_url, cookies)
        if info:
            return _result(name, True, media=info)

        info = extractors.extract_generic_media_images(page_url, cookies)
        if info:
            return _result(name, True, media=info)

        if registry.is_japanese_domain(page_url):
            return _result(
                name, False,
                reason="Japanese site — handled by yt-dlp with Accept-Language:ja; falling through"
            )

        return _result(name, False, reason="no matching platform extractor")
    except Exception as exc:  # noqa: BLE001
        return _result(name, False, reason=safe_text(exc)[:400])


def _strategy_html_scan_combined(
    page_url: str,
    http_headers: dict[str, str],
    cookies: str | None,
    _html_cache: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Fetch the page once and run all HTML scan modes (HLS→DASH→OG→generic).

    Replaces four separate _strategy_html_detector calls (each of which fetches
    the page independently) with a single HTTP request, saving 3 round-trips for
    every page that reaches the HTML-scan stage of the pipeline.

    If _html_cache is provided (a dict keyed by URL), the fetched HTML is stored
    there so that a subsequent _strategy_page_embeds call on the same URL can reuse
    it without a second HTTP request.
    """
    import html as html_mod

    name = "HTML media scanner"

    if ".m3u8" in page_url.lower():
        url = normalize_url(page_url)
        ext = "m3u8"
        return _result(name, True, media={
            "url": url, "ext": ext, "protocol": "m3u8_native",
            "id": cache_key(url), "title": None,
            "http_headers": safe_headers({**http_headers, "Referer": http_headers.get("Referer") or page_url}),
        })
    if ".mpd" in page_url.lower():
        url = normalize_url(page_url)
        ext = "mpd"
        return _result(name, True, media={
            "url": url, "ext": ext, "protocol": "http_dash_segments",
            "id": cache_key(url), "title": None,
            "http_headers": safe_headers({**http_headers, "Referer": http_headers.get("Referer") or page_url}),
        })

    req_headers = safe_headers({
        "User-Agent": http_headers.get("User-Agent") or MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": (
            http_headers.get("Accept-Language")
            or languages.accept_language_for_url(page_url, "en-US,en;q=0.9")
        ),
        **({"Referer": http_headers["Referer"]} if http_headers.get("Referer") else {}),
        **({"Origin": http_headers["Origin"]} if http_headers.get("Origin") else {}),
        **({"Cookie": cookies} if cookies else {}),
    })
    body, status = fetch_with_retry(page_url, req_headers, timeout=20, max_retries=1)
    if not body:
        return _result(name, False, reason=f"fetch failed (HTTP {status})")
    html_text = body.decode("utf-8", errors="replace")

    if _html_cache is not None:
        _html_cache[page_url] = html_text

    title = _html_title(html_text)

    def _info_from_url(media_url: str) -> dict[str, Any]:
        url = normalize_url(html_mod.unescape(media_url))
        ext = guess_ext_from_url(url) or (
            "m3u8" if ".m3u8" in url.lower() else
            "mpd"  if ".mpd"  in url.lower() else "mp4"
        )
        return {
            "url": url,
            "http_headers": safe_headers({**req_headers, "Referer": req_headers.get("Referer") or page_url}),
            "title": title, "thumbnail": None, "duration": None,
            "ext": ext,
            "protocol": (
                "m3u8_native"        if ext == "m3u8" else
                "http_dash_segments" if ext == "mpd"  else "https"
            ),
            "id": cache_key(url),
        }

    import re as _re
    _QUALITY_STRIP = _re.compile(
        r'[_-](?:\d{3,4}p|\d+x\d+|hd|sd|low|high|mid|med|\d+k)(?=[_.-]|$)',
        _re.IGNORECASE,
    )

    def _stem(u: str) -> str:
        p = urllib.parse.urlparse(u)
        path_stem = _QUALITY_STRIP.sub('', p.path)
        path_stem = _re.sub(r'\.\w{2,5}$', '', path_stem)
        return p.netloc + path_stem

    for mode in ("hls", "dash", "og", "generic"):
        urls = _scan_media_urls(html_text, mode)
        if not urls:
            continue
        candidates = [urllib.parse.urljoin(page_url, u) for u in urls]
        media_url = candidates[0]
        audit = [
            source_audit.audit_entry(
                strategy=name, source=f"html-scan/{mode}", url=u,
                selected=(u == media_url),
                rejected_reason=None if u == media_url else "lower ranked candidate",
                headers=req_headers,
            )
            for u in candidates[:80]
        ]
        if mode == "generic" and len(candidates) >= 2:
            stems = list(dict.fromkeys(_stem(u) for u in candidates))
            if len(stems) >= 2:
                entries = [_info_from_url(u) for u in candidates[:20]]
                playlist = {"_type": "playlist", "entries": entries, "title": title}
                source_audit.add_audit(playlist, audit)
                return _result(name, True, media=playlist)
        info = _info_from_url(media_url)
        source_audit.add_audit(info, audit)
        return _result(name, True, media=info)

    return _result(name, False, reason="no media found in page HTML (hls/dash/og/generic modes)")


def _strategy_ytdl_stream_url(
    page_url: str,
    ydl_opts: dict[str, Any],
    cookies: str | None,
) -> dict[str, Any]:
    """Last-resort: build a /ytdl-stream proxy URL.

    For sites where skip_download=True cannot resolve playable media URLs, the
    /ytdl-stream endpoint runs yt-dlp in actual download mode and streams the
    result. Clients forward cookies in X-FCDL-Cookies so the download URL stays
    short and does not expose session data.
    """
    name = "ytdl-stream"
    if not _server_stream_supported(page_url):
        return _result(name, False, reason="URL does not need ytdl-stream")

    # Fetch lightweight metadata (title, thumbnail) for the UI preview.
    # tv_embedded bypasses the "Sign in to confirm you're not a bot" challenge
    # that datacenter IPs receive with ios/web_safari — one attempt, fail silently.
    meta: dict[str, Any] = {}
    try:
        opts = {
            **ydl_opts,
            "format": (
                "18/b[height<=360][ext=mp4]/b[ext=mp4]"
                if registry.is_youtube(page_url)
                else "b[ext=mp4]/best"
            ),
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
        }
        if registry.is_youtube(page_url):
            opts["extractor_args"] = {
                **(ydl_opts.get("extractor_args") or {}),
                "youtube": {"player_client": ["tv_embedded", "ios"]},
            }
        with _patched_dns_fallback(page_url):
            with YoutubeDL(opts) as ydl:
                result = ydl.extract_info(page_url, download=False)
        if result and result.get("title"):
            meta = result
    except Exception:
        pass

    stream_url = (
        f"{SERVER_BASE_URL}/ytdl-stream"
        f"?page_url={urllib.parse.quote(page_url, safe='')}"
    )

    print(
        f"[extract] ytdl-stream fallback: "
        f"cookies={'yes' if cookies else 'no'} title={meta.get('title')!r}"
    )

    return _result(name, True, media={
        "url":          stream_url,
        "title":        meta.get("title") or "Video",
        "thumbnail":    meta.get("thumbnail"),
        "duration":     meta.get("duration"),
        "ext":          "mp4",
        "id":           meta.get("id") or cache_key(page_url),
        "webpage_url":  page_url,
        "protocol":     "https",
        "extractor":    _extractor_name_for(page_url),
        "http_headers": {},
    })


def _strategy_skip(name: str, reason: str) -> dict[str, Any]:
    return _result(name, False, reason=reason)


_SNAPWC_HOST_ALLOWLIST = (
    "tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "douyin.com",
    "iesdouyin.com",
    "xiaohongshu.com",
    "rednote.com",
    "xhslink.com",
    "instagram.com",
    "threads.net",
    "reddit.com",
    "redd.it",
)


def _host_matches(page_url: str, hosts: tuple[str, ...]) -> bool:
    host = (urllib.parse.urlsplit(page_url).hostname or "").lower()
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in hosts)


def _snapwc_result_acceptable(page_url: str, info: dict[str, Any]) -> tuple[bool, str | None]:
    """Reject proxy results that look like covers/thumbnails for video pages."""
    if info.get("_type") == "playlist":
        entries = [entry for entry in (info.get("entries") or []) if isinstance(entry, dict)]
        if entries:
            return True, None
        return False, "snapwc returned an empty gallery"

    url = safe_text(info.get("url"))
    ext = safe_text(info.get("ext")).lower()
    if not url:
        return False, "snapwc returned no URL"

    image_exts = {"jpg", "jpeg", "png", "webp", "gif", "avif"}
    looks_image = ext in image_exts or guess_ext_from_url(url).lower() in image_exts
    video_page = any(marker in page_url.lower() for marker in ("/video/", "/m/video/", "/reel/", "/tv/"))
    if video_page and looks_image:
        return False, "snapwc returned a cover image for a video page"

    return True, None


def _strategy_snapwc(page_url: str) -> dict[str, Any]:
    """Watermark-removal proxy via snapwc.com (only runs when remove_watermark=True)."""
    name = "watermark-removal proxy"
    if not _host_matches(page_url, _SNAPWC_HOST_ALLOWLIST):
        return _result(name, False, reason="snapwc disabled for this host")
    try:
        info = extractors.extract_via_snapwc(page_url)
        if info:
            ok, reason = _snapwc_result_acceptable(page_url, info)
            if not ok:
                return _result(name, False, reason=reason or "snapwc result rejected")
            return _result(name, True, media=info)
        return _result(name, False, reason="snapwc returned no media")
    except Exception as exc:
        return _result(name, False, reason=safe_text(exc)[:400])


def _strategy_watermark_free_source(page_url: str, cookies: str | None) -> dict[str, Any]:
    """Source-specific clean-media extractor; no third-party parser/proxy."""
    name = "watermark-free source"
    try:
        info = extractors.extract_watermark_free_source(page_url, cookies)
        if info:
            return _result(name, True, media=info)
        return _result(name, False, reason="no source-derived clean media")
    except Exception as exc:
        return _result(name, False, reason=safe_text(exc)[:400])


# ── HTML helpers (used by detector strategy) ──────────────────────────────────


def _html_title(html_text: str) -> str | None:
    import html as html_mod
    for pattern in (
        r'<meta\s+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        r"<title[^>]*>(.*?)</title>",
    ):
        import re
        m = re.search(pattern, html_text, re.IGNORECASE | re.DOTALL)
        if m:
            import re as re2
            return re2.sub(r"\s+", " ", html_mod.unescape(m.group(1))).strip()
    return None


def _scan_media_urls(html_text: str, mode: str) -> list[str]:
    import re
    import html as html_mod
    patterns: list[str] = []
    if mode in {"hls", "generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.m3u8[^"\'<>\s\\]*')
    if mode in {"dash", "generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.mpd[^"\'<>\s\\]*')
    if mode in {"generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.(?:mp4|m4v|webm|mov)[^"\'<>\s\\]*')
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.(?:mp3|m4a|aac|ogg|flac|opus)[^"\'<>\s\\]*')
        # HTML5 <video src="...">, <source src="...">, <audio src="..."> — captures the
        # URL even when it lacks a file extension (common with signed CDN URLs).
        patterns.append(
            r'<(?:video|audio|source)\b[^>]{0,400}?\bsrc=["\']'
            r'(https?://[^"\'<>\s]{10,})["\']'
        )
        # data-src lazy-loaded variants (used by some video libraries).
        patterns.append(
            r'<(?:video|source)\b[^>]{0,400}?\bdata-src=["\']'
            r'(https?://[^"\'<>\s]{10,})["\']'
        )
        # data-video-url / data-stream-url / data-mp4 / data-hls on arbitrary
        # container elements (common in custom CMS and sports/news video players).
        patterns.append(
            r'<[a-z][a-z0-9-]*\b[^>]{0,600}?\bdata-(?:video-url|stream-url|media-url'
            r'|video-src|stream-src|hls-url|mp4-url|mp4|m3u8|hls)=["\']'
            r'(https?://[^"\'<>\s]{10,})["\']'
        )
    if mode == "og":
        _vt = r'(?:og:video(?::url)?|og:video:secure_url|twitter:player:stream|og:audio(?::url)?)'
        # property=… then content=… (most common ordering)
        patterns.append(
            r'<meta\s[^>]*?(?:property|name)\s*=\s*["\']' + _vt + r'["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']'
        )
        # content=… then property=… (some sites reverse the attribute order)
        patterns.append(
            r'<meta\s[^>]*?content\s*=\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\s*=\s*["\']' + _vt + r'["\']'
        )
    found: list[str] = []
    variants = [
        html_text,
        html_text.replace("\\u0026", "&").replace("\\u003d", "=").replace("\\/", "/"),
    ]
    for text in variants:
        for pattern in patterns:
            for m in re.finditer(pattern, text, re.IGNORECASE | re.DOTALL):
                raw = m.group(1) if m.lastindex else m.group(0)
                raw = html_mod.unescape(raw).replace("\\/", "/").replace("\\u0026", "&").strip()
                if raw.startswith(("http://", "https://")) and raw not in found:
                    found.append(raw)
    return found


def _strategy_page_embeds(
    page_url: str,
    http_headers: dict[str, str],
    cookies: str | None,
    ydl_opts: dict[str, Any],
    _html_cache: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Detect embedded video players (Brightcove, JW Player, iframe) in page HTML.

    Many sites don't put direct MP4/HLS URLs in their HTML but do include static
    embed parameters — Brightcove data-account/data-video-id attributes, a
    jwplayer().setup({file:…}) call, or an <iframe> pointing to a supported
    player.  This strategy extracts those and passes them directly to yt-dlp.

    If _html_cache contains a pre-fetched HTML string for this URL (from the
    preceding _strategy_html_scan_combined call), it is reused to avoid a
    redundant HTTP request.
    """
    import html as html_mod
    import re

    name = "embedded player detector"

    req_headers = safe_headers({
        "User-Agent": http_headers.get("User-Agent") or MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": (
            http_headers.get("Accept-Language")
            or languages.accept_language_for_url(page_url, "en-US,en;q=0.9")
        ),
        **({"Referer": http_headers["Referer"]} if http_headers.get("Referer") else {}),
        **({"Cookie": cookies} if cookies else {}),
    })

    if _html_cache is not None and page_url in _html_cache:
        html_text = _html_cache[page_url]
    else:
        body, status = fetch_with_retry(page_url, req_headers, timeout=20, max_retries=1)
        if not body:
            return _result(name, False, reason=f"fetch failed (HTTP {status})")
        html_text = body.decode("utf-8", errors="replace")

    embed_urls: list[str] = []

    # ── Brightcove: data-account + data-video-id ──────────────────────────────
    bc_acc = re.search(r'data-account=["\'](\d{7,})["\']', html_text)
    bc_vid = re.search(r'data-video-id=["\'](\d{7,})["\']', html_text)
    if bc_acc and bc_vid:
        bc_plr = re.search(r'data-player=["\']([A-Za-z0-9_-]+)["\']', html_text)
        pid = bc_plr.group(1) if bc_plr else "default"
        embed_urls.append(
            f"https://players.brightcove.net/{bc_acc.group(1)}"
            f"/{pid}_default/index.html?videoId={bc_vid.group(1)}"
        )

    # ── JW Player: jwplayer().setup({file/sources/playlist}) ─────────────────
    # Three common config layouts:
    #   1. Direct file:   .setup({file: "URL"})
    #   2. Sources array: .setup({sources: [{file: "URL"}]})
    #   3. Playlist:      .setup({playlist: [{file: "URL"}]})
    jw = re.search(
        r'jwplayer\s*\([^)]*\)\s*\.setup\s*\(\s*\{',
        html_text, re.IGNORECASE,
    )
    if jw:
        # Extract the first 2000 chars of the setup object to avoid runaway matches
        setup_text = html_text[jw.end():jw.end() + 2000]
        # JS objects use both quoted ("file") and unquoted (file) keys.
        for jw_file_m in re.finditer(r'(?:["\']file["\']|file)\s*:\s*["\']([^"\']{10,})["\']', setup_text, re.IGNORECASE):
            fu = html_mod.unescape(jw_file_m.group(1).replace("\\/", "/"))
            if fu.startswith(("http://", "https://")) and fu not in embed_urls:
                embed_urls.append(fu)

    # ── iframe embeds: YouTube, Vimeo, Brightcove, Dailymotion, Kaltura, Wistia,
    #    SoundCloud, Spreaker, Buzzsprout, Podbean, Anchor/Spotify, Rumble ────────
    for m in re.finditer(
        r'<iframe\b[^>]+?src=["\']'
        r'((?:https?:)?//(?:www\.)?'
        r'(?:youtube\.com/embed/|youtu\.be/|player\.vimeo\.com/video/'
        r'|vimeo\.com/\d|players\.brightcove\.net/'
        r'|dai\.ly/|dailymotion\.com/embed/video/'
        r'|cdnapisec\.kaltura\.com/p/'
        r'|[a-z0-9-]+\.kaltura\.com/p/'
        r'|fast\.wistia\.(?:net|com)/embed/'
        r'|play\.vidyard\.com/'
        r'|embed\.vidyard\.com/'
        r'|w\.soundcloud\.com/player/'
        r'|www\.spreaker\.com/widget/'
        r'|www\.buzzsprout\.com/[0-9]+/episodes/'
        r'|www\.podbean\.com/media/player/'
        r'|anchor\.fm/[^"\']+/embed/'
        r'|rumble\.com/embed/'
        r'|player\.twitch\.tv/'
        r'|clips\.twitch\.tv/embed'
        r'|odysee\.com/\$/embed/)[^"\']{4,})["\']',
        html_text, re.IGNORECASE,
    ):
        u = html_mod.unescape(m.group(1))
        if u.startswith("//"):
            u = "https:" + u
        embed_urls.append(u)

    # ── Wistia async embed: <div class="wistia_embed wistia_async_{id}"> ────────
    wistia_m = re.search(r'wistia_async_([A-Za-z0-9]{6,20})', html_text)
    if wistia_m:
        embed_urls.append(f"https://fast.wistia.com/medias/{wistia_m.group(1)}")

    # ── VideoJS data-setup: <video data-setup='{"sources":[{"src":"URL"}]}'> ────
    # JSON almost always uses double-quotes, so the attribute itself uses single-quotes.
    # Two separate patterns avoid the [^"'] pitfall (which would exclude JSON double-quotes).
    _vjs_patterns = [
        r"""<video\b[^>]+?data-setup='(\{[^']{0,2000}\})'""",   # single-quoted attribute
        r'<video\b[^>]+?data-setup="(\{[^"]{0,2000}\})"',        # double-quoted attribute
    ]
    import json as _json
    for _vjs_pat in _vjs_patterns:
        for vjs_m in re.finditer(_vjs_pat, html_text, re.IGNORECASE | re.DOTALL):
            try:
                vjs_cfg = _json.loads(html_mod.unescape(vjs_m.group(1)))
                for src_obj in vjs_cfg.get("sources") or []:
                    src = src_obj.get("src") if isinstance(src_obj, dict) else None
                    if src and src.startswith("http"):
                        embed_urls.append(src)
            except Exception:
                pass

    # ── Flowplayer data-clip / data-config JSON on div.flowplayer ────────────────
    # Flowplayer stores clip sources in a JSON blob attached to the container div.
    # Both v5/v6 (data-clip) and v7+ (data-options / data-config) patterns are covered.
    _fp_json_patterns = [
        r"""<(?:div|section|figure)\b[^>]*?data-(?:clip|options|config|player)='(\{[^']{0,3000}\})'""",
        r'<(?:div|section|figure)\b[^>]*?data-(?:clip|options|config|player)="(\{[^"]{0,3000}\})"',
    ]
    for _fp_pat in _fp_json_patterns:
        for fp_m in re.finditer(_fp_pat, html_text, re.IGNORECASE | re.DOTALL):
            try:
                fp_cfg = _json.loads(html_mod.unescape(fp_m.group(1)))
                for src_obj in (fp_cfg.get("sources") or fp_cfg.get("clip", {}).get("sources") or []):
                    src = src_obj.get("src") if isinstance(src_obj, dict) else None
                    if src and src.startswith("http") and src not in embed_urls:
                        embed_urls.append(src)
            except Exception:
                pass

    # ── Kaltura entry from page JS (kWidget.embed / flashvars) ──────────────────
    kw_partner = re.search(r'kWidget\.embed\s*\([^)]{0,800}?wid\s*[=:]\s*["\']_?(\d{4,})["\']', html_text)
    kw_entry   = re.search(r'kWidget\.embed\s*[^)]{0,800}?entry_?[Ii]d\s*[=:]\s*["\']([0-9_a-zA-Z-]{4,})["\']', html_text)
    if not (kw_partner and kw_entry):
        kw_partner = re.search(r'["\']?partner_?id["\']?\s*[=:]\s*["\']?(\d{4,})["\']?', html_text)
        kw_entry   = re.search(r'["\']?entry_?id["\']?\s*[=:]\s*["\']([0-9_a-zA-Z-]{4,})["\']', html_text)
    if kw_partner and kw_entry:
        pid = kw_partner.group(1)
        eid = kw_entry.group(1)
        embed_urls.append(
            f"https://cdnapisec.kaltura.com/p/{pid}/sp/{pid}00/"
            f"embedIframeJs/uiconf_id/0/partner_id/{pid}?iframeembed=true&entry_id={eid}"
        )

    # ── JSON-LD VideoObject: contentUrl / embedUrl / associatedMedia ─────────────
    # News sites and video platforms often include structured metadata for SEO.
    # Schema.org VideoObject.contentUrl is a direct media URL; embedUrl is an
    # iframe player we can pass to yt-dlp; associatedMedia.contentUrl covers
    # articles that embed video.
    _direct_urls: list[str] = []
    for ld_m in re.finditer(
        r'<script\b[^>]*?\btype=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html_text, re.DOTALL | re.IGNORECASE,
    ):
        try:
            ld = _json.loads(html_mod.unescape(ld_m.group(1)))
        except Exception:
            continue
        items = ld if isinstance(ld, list) else [ld]
        for obj in items:
            obj_type = (obj.get("@type") or "").lower() if isinstance(obj, dict) else ""
            if "video" not in obj_type and "mediaobject" not in obj_type:
                # Also check associatedMedia
                assoc = obj.get("associatedMedia") if isinstance(obj, dict) else None
                if isinstance(assoc, dict):
                    obj = assoc
                    obj_type = (obj.get("@type") or "").lower()
                elif isinstance(assoc, list):
                    for sub in assoc:
                        if isinstance(sub, dict):
                            cu = html_mod.unescape(sub.get("contentUrl") or "")
                            if cu.startswith("http") and cu not in _direct_urls:
                                _direct_urls.append(cu)
                    continue
                else:
                    continue
            # contentUrl → direct media file
            content_url = html_mod.unescape(obj.get("contentUrl") or "") if isinstance(obj, dict) else ""
            if content_url.startswith("http") and content_url not in _direct_urls:
                _direct_urls.append(content_url)
            # embedUrl → oembed/player URL
            embed_url = html_mod.unescape(obj.get("embedUrl") or "") if isinstance(obj, dict) else ""
            if embed_url.startswith("http") and embed_url not in embed_urls:
                embed_urls.append(embed_url)

    # ── RSS/Podcast: <enclosure> and <media:content> direct audio/video URLs ─────
    # Covers podcast episode pages that embed or return RSS-format markup, and
    # podcast feed URLs (.rss / .xml) pasted directly.

    for enc_m in re.finditer(
        r'<(?:enclosure|media:content)\b[^>]*?\burl=["\']([^"\']{10,})["\']',
        html_text, re.IGNORECASE,
    ):
        u = html_mod.unescape(enc_m.group(1))
        if u.startswith("http") and u not in _direct_urls:
            _direct_urls.append(u)

    # ── Video/audio URL keys in inline <script> JSON blobs ───────────────────────
    # Many video platforms (news, education, corporate) store the stream URL in a
    # JS variable with a predictable key name.  Scan every script block for those.
    # Bare "src"/"source" keys are excluded — they are used for images throughout
    # React/Next.js hydration data and have a very high false-positive rate.
    _VIDEO_KEY_RE = re.compile(
        # High-confidence bare or suffixed keys
        r'"(?:video|audio|media|stream|play|file|download|hls|mp4|dash|manifest|content)'
        r'(?:Url|_url|URL|Src|_src|File|_file|Path|_path|Link)?"\s*:\s*"(https?://[^"]{10,})"'
        # Require a suffix when the key is source/src (too generic to match bare)
        r'|"(?:source|src)(?:Url|_url|URL|Src|_src|File|_file|Path|_path|Link)+"\s*:\s*"(https?://[^"]{10,})"',
        re.IGNORECASE,
    )
    # Skip URLs that are obviously images: known image extensions or image-serving CDN paths.
    _IMG_EXT_RE = re.compile(r'\.(jpe?g|png|gif|webp|svg|avif|bmp|ico|tiff?)(?:[?#][^"]*)?$', re.IGNORECASE)
    _IMG_PATH_RE = re.compile(r'/(?:thumbnails?|thumbs?|avatars?|photos?|images?|imgs?|icons?|logos?|banners?|posters?)/', re.IGNORECASE)
    for scr_m in re.finditer(r"<script\b[^>]*>(.*?)</script>", html_text, re.DOTALL | re.IGNORECASE):
        for key_m in _VIDEO_KEY_RE.finditer(scr_m.group(1)):
            raw = key_m.group(1) or key_m.group(2) or ""
            u = html_mod.unescape(raw.replace("\\/", "/"))
            if _IMG_EXT_RE.search(u) or _IMG_PATH_RE.search(u):
                continue
            if u not in _direct_urls and u not in embed_urls:
                _direct_urls.append(u)

    if _direct_urls:
        import html as _html_mod2
        page_title = _html_title(html_text)
        def _mk_entry(u: str) -> dict[str, Any]:
            u = _html_mod2.unescape(u)
            ext = guess_ext_from_url(u) or (
                "m3u8" if ".m3u8" in u.lower() else
                "mp3"  if any(x in u.lower() for x in (".mp3", "/mp3", "audio/mpeg")) else "mp4"
            )
            return {
                "url": u, "ext": ext, "id": cache_key(u),
                "title": page_title,
                "http_headers": req_headers,
                "protocol": "m3u8_native" if ext == "m3u8" else "https",
            }
        audit_entries = [
            source_audit.audit_entry(
                strategy=name, source="rss-or-json-key", url=u,
                selected=(i == 0),
                rejected_reason=None if i == 0 else "additional direct URL",
                headers=req_headers,
            )
            for i, u in enumerate(_direct_urls[:20])
        ]
        if len(_direct_urls) == 1:
            info = source_audit.add_audit(_mk_entry(_direct_urls[0]), audit_entries)
            return _result(name, True, media=info)
        # Multiple direct URLs — return as a playlist so the client shows all items.
        entries = [_mk_entry(u) for u in _direct_urls[:40]]
        playlist = {
            "_type": "playlist",
            "entries": entries,
            "title": page_title,
        }
        source_audit.add_audit(playlist, audit_entries)
        return _result(name, True, media=playlist)

    if not embed_urls:
        return _result(name, False, reason="no embedded player signatures found in page HTML")

    last_err: str = "no info returned"
    for embed_url in embed_urls:
        try:
            with YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(embed_url, download=False)
            if info:
                return _result(name, True, media=info)
        except Exception as exc:  # noqa: BLE001
            last_err = safe_text(exc)[:200]

    return _result(name, False, reason=f"embed extraction failed: {last_err}")


# ── Engine ────────────────────────────────────────────────────────────────────


def build_ydl_opts(
    page_url: str,
    http_headers: dict[str, str],
    cookie_file: str | None,
    *,
    audio_only: bool = False,
    subtitles: bool = False,
    sub_langs: str = "en",
    concurrent_fragments: int = 1,
    proxy: str | None = None,
    referer: str | None = None,
    preferred_quality: str | None = None,
) -> dict[str, Any]:
    """Build yt-dlp options dict for the given request."""
    extractor_args: dict[str, Any] = {
        "youtube": {
            "player_client": ["ios", "web_safari", "web_creator", "mweb", "tv"],
        },
    }
    if referer:
        extractor_args["vimeo"] = {"referer": [referer]}

    format_spec = (
        "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio"
        if audio_only
        else QUALITY_FORMAT_SPECS.get(preferred_quality or "", FORMAT_SPEC)
    )
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "format": format_spec,
        "skip_download": True,
        "outtmpl": "/tmp/%(id)s.%(ext)s",
        "extractor_args": extractor_args,
    }
    if concurrent_fragments > 1:
        opts["concurrent_fragment_downloads"] = concurrent_fragments
    if proxy:
        opts["proxy"] = proxy
    if subtitles:
        opts["writesubtitles"] = True
        opts["writeautomaticsub"] = True
        opts["subtitleslangs"] = [s.strip() for s in sub_langs.split(",") if s.strip()] or ["en"]
        opts["subtitlesformat"] = "srt"
    if cookie_file:
        opts["cookiefile"] = cookie_file
    elif COOKIES_FILE and os.path.exists(COOKIES_FILE):
        opts["cookiefile"] = COOKIES_FILE
    if referer:
        opts["referer"] = referer
    if http_headers:
        opts["http_headers"] = safe_headers(http_headers)
    return opts


def run_extraction(
    page_url: str,
    referer: str | None = None,
    cookies: str | None = None,
    *,
    audio_only: bool = False,
    subtitles: bool = False,
    sub_langs: str = "en",
    concurrent_fragments: int = 1,
    proxy: str | None = None,
    request_source_audit: list[dict[str, Any]] | None = None,
    ctx: RequestContext | None = None,
    remove_watermark: bool = False,
    preferred_quality: str | None = None,
) -> dict[str, Any]:
    """Run the full extraction pipeline and return a yt-dlp info dict.

    Raises HTTPException on terminal failure.
    """
    page_url = normalize_url(page_url)
    referer = normalize_url(referer) if referer else None
    cookies = safe_text(cookies) if cookies else None

    parsed = urllib.parse.urlsplit(page_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(400, "invalid URL or unsupported protocol")

    profile = classifier.classify(page_url, cookies_provided=bool(cookies))

    # ── Per-site HTTP headers ──────────────────────────────────────────────────
    http_headers: dict[str, str] = {}
    if referer:
        http_headers["Referer"] = referer
    elif "bilivideo.com" in page_url or "bilibili.com" in page_url:
        http_headers["Referer"]    = "https://www.bilibili.com/"
        http_headers["Origin"]     = "https://www.bilibili.com"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("weibo.com", "weibo.cn", "weibocdn.com")):
        http_headers["Referer"]    = "https://weibo.com/"
        http_headers["Origin"]     = "https://weibo.com"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("xiaohongshu.com", "rednote.com", "xhslink.com", "xhscdn.com")):
        http_headers["Referer"]    = "https://www.xiaohongshu.com/"
        http_headers["Origin"]     = "https://www.xiaohongshu.com"
        http_headers["User-Agent"] = MOBILE_UA
    elif any(h in page_url for h in ("nicovideo.jp", "nico.ms", "niconico.com", "nicochannel.jp")):
        http_headers["Referer"]    = "https://www.nicovideo.jp/"
        http_headers["Origin"]     = "https://www.nicovideo.jp"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("tver.jp", "tver.co.jp")):
        http_headers["Referer"]    = "https://tver.jp/"
        http_headers["Origin"]     = "https://tver.jp"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("abema.tv", "abema.io")):
        http_headers["Referer"]    = "https://abema.tv/"
        http_headers["Origin"]     = "https://abema.tv"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif "blog.naver.com" in page_url:
        http_headers["Referer"]    = "https://blog.naver.com/"
        http_headers["Origin"]     = "https://blog.naver.com"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("naver.com", "naver.me")):
        http_headers["Referer"]    = "https://tv.naver.com/"
        http_headers["Origin"]     = "https://tv.naver.com"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("mdpr.jp", "modelpress.jp")):
        http_headers["Referer"]    = "https://mdpr.jp/"
        http_headers["Origin"]     = "https://mdpr.jp"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif "twitcasting.tv" in page_url:
        http_headers["Referer"]    = "https://twitcasting.tv/"
        http_headers["Origin"]     = "https://twitcasting.tv"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif "openrec.tv" in page_url:
        http_headers["Referer"]    = "https://www.openrec.tv/"
        http_headers["Origin"]     = "https://www.openrec.tv"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("video.fc2.com", "fc2.com/video", "live.fc2.com")):
        http_headers["Referer"]    = "https://video.fc2.com/"
        http_headers["Origin"]     = "https://video.fc2.com"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("nhk.or.jp", "nhk.jp")):
        http_headers["Referer"]    = "https://www.nhk.or.jp/"
        http_headers["Origin"]     = "https://www.nhk.or.jp"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("cu.tbs.co.jp", "tbs.co.jp", "tbs.jp")):
        http_headers["Referer"]    = "https://www.tbs.co.jp/"
        http_headers["Origin"]     = "https://www.tbs.co.jp"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("fod.fujitv.co.jp", "fod-sp.fujitv.co.jp", "fujitv.co.jp")):
        http_headers["Referer"]    = "https://fod.fujitv.co.jp/"
        http_headers["Origin"]     = "https://fod.fujitv.co.jp"
        http_headers["User-Agent"] = _DESKTOP_UA
    elif any(h in page_url for h in ("video.yahoo.co.jp", "news.yahoo.co.jp", "gyao.yahoo.co.jp")):
        http_headers["Referer"]    = "https://video.yahoo.co.jp/"
        http_headers["Origin"]     = "https://video.yahoo.co.jp"
        http_headers["User-Agent"] = _DESKTOP_UA
    locale_accept_language = languages.accept_language_for_url(page_url)
    if locale_accept_language and "Accept-Language" not in http_headers:
        http_headers["Accept-Language"] = locale_accept_language
    if cookies:
        http_headers["Cookie"] = cookies

    # ── Direct media URL short-circuit ────────────────────────────────────────
    import re
    direct_media = re.search(
        r"(?:\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:[?#]|$)"
        # bilivideo.com: only .mp4/.flv are complete; .m4s are DASH video-only segments
        r"|bilivideo\.com/.*\.(?:mp4|flv)(?:[?#]|$)"
        r"|weibocdn\.com/|xhscdn\.com/"
        r"|cdninstagram\.com/|scontent[-\w]*\.cdninstagram\.com/"
        r"|fbcdn\.net/|threadscdn\.com/)",
        page_url,
        re.IGNORECASE,
    )
    if direct_media:
        ext = guess_ext_from_url(page_url) or (
            "m3u8" if ".m3u8" in page_url.lower() else "mp4"
        )
        return {
            "url":          page_url,
            "http_headers": http_headers,
            "title":        None,
            "thumbnail":    None,
            "duration":     None,
            "ext":          ext,
            "protocol":     "m3u8_native" if ".m3u8" in page_url.lower() else "https",
            "id":           cache_key(page_url),
            "_source_audit": [source_audit.audit_entry(
                strategy="direct media URL short-circuit",
                source="request-url",
                url=page_url,
                selected=True,
                headers=http_headers,
            )],
        }

    # ── Cookie file ───────────────────────────────────────────────────────────
    cookie_file: str | None = None
    if cookies:
        try:
            cookie_file = auth.write_cookie_file(cookies, page_url)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))

    # ── Strategy list ─────────────────────────────────────────────────────────
    # Shared HTML cache: _strategy_html_scan_combined stores the fetched page HTML
    # so _strategy_page_embeds can reuse it without a second HTTP request.
    _html_cache: dict[str, str] = {}

    ydl_opts = build_ydl_opts(
        page_url, http_headers, cookie_file,
        audio_only=audio_only, subtitles=subtitles, sub_langs=sub_langs,
        concurrent_fragments=concurrent_fragments, proxy=proxy, referer=referer,
        preferred_quality=preferred_quality,
    )

    is_yt = profile.is_youtube

    if is_yt:
        # YouTube-specific pipeline.
        #
        # HTML detectors (HLS/DASH/OG/generic) are useless for YouTube — YouTube's
        # HTML page never embeds raw m3u8/mpd/mp4 URLs. Omitting them saves ~4 slow
        # HTTP fetches per request.
        #
        # _strategy_ydl includes all five player clients in one call (ios,
        # web_safari, web_creator, mweb, tv — see build_ydl_opts). Individual
        # per-client fallbacks would add 5 extra sequential yt-dlp calls that
        # never improve on the combined attempt; skip them.
        #
        # The HLS guard in _strategy_ydl treats m3u8 results as failures so we
        # fall directly to ytdl-stream, which runs yt-dlp in actual download
        # mode and handles SABR internally.
        strategies: list[tuple[str, Callable[[], dict[str, Any]]]] = [
            ("yt-dlp",    lambda: _strategy_ydl(page_url, ydl_opts, False)),
            ("ytdl-stream", lambda: _strategy_ytdl_stream_url(page_url, ydl_opts, cookies)),
            ("browser playback fallback", lambda: _strategy_skip(
                "browser playback fallback",
                "browser playback fallback must run in the app WebView",
            )),
        ]
    else:
        # Non-YouTube pipeline — full strategy sweep.
        # Platforms where our custom extractor is more reliable than yt-dlp:
        # - Weibo: yt-dlp lacks an image-post extractor and returns "No video formats"
        # - XHS: yt-dlp picks up profile avatars from related sections in __INITIAL_STATE__
        # - TikTok: yt-dlp doesn't handle photo/slideshow posts (no /video/ in URL)
        # - Reddit: yt-dlp doesn't follow /s/<id> share redirects to the canonical post
        platform_first = any(h in page_url for h in (
            "weibo.com", "weibo.cn", "video.weibo.com",
            "xiaohongshu.com", "rednote.com", "xhslink.com", "xhscdn.com",
            "tiktok.com", "vm.tiktok.com",
            "reddit.com", "redd.it",
            "twitter.com", "x.com", "t.co",
        ))
        platform_strategy = ("platform-specific extractor", lambda: _strategy_platform_extractors(page_url, cookies))
        ytdlp_strategy = ("yt-dlp", lambda: _strategy_ydl(page_url, ydl_opts, False))

        # When remove_watermark is enabled, try source-specific clean media
        # first, then fall back to the slower snapwc proxy.
        watermark_proxy_strategy: list[tuple[str, Callable[[], dict[str, Any]]]] = (
            [
                ("watermark-free source", lambda: _strategy_watermark_free_source(page_url, cookies)),
                ("watermark-removal proxy", lambda: _strategy_snapwc(page_url)),
            ]
            if remove_watermark else []
        )

        strategies: list[tuple[str, Callable[[], dict[str, Any]]]] = [
            *watermark_proxy_strategy,
            *([platform_strategy, ytdlp_strategy] if platform_first else [ytdlp_strategy, platform_strategy]),
            *(
                [("ytdl-stream", lambda: _strategy_ytdl_stream_url(page_url, ydl_opts, cookies))]
                if _server_stream_supported(page_url) else []
            ),
            ("WebView/runtime interception", lambda: _strategy_skip(
                "WebView/runtime interception",
                "browser runtime is client-side only",
            )),
            # Combined HTML scan: fetches the page once and tries HLS→DASH→OG→generic
            # in priority order. The fetched HTML is cached in _html_cache so the
            # subsequent embed-detector strategy reuses it without a second HTTP request.
            ("HTML media scanner",       lambda: _strategy_html_scan_combined(page_url, http_headers, cookies, _html_cache)),
            ("embedded player detector", lambda: _strategy_page_embeds(page_url, http_headers, cookies, ydl_opts, _html_cache)),
            ("generic yt-dlp extractor", lambda: _strategy_ydl(page_url, ydl_opts, True)),
            *(
                []
                if _server_stream_supported(page_url)
                else [("ytdl-stream", lambda: _strategy_ytdl_stream_url(page_url, ydl_opts, cookies))]
            ),
            ("browser playback fallback", lambda: _strategy_skip(
                "browser playback fallback",
                "browser playback fallback must run in the app WebView",
            )),
        ]

    # ── Pipeline execution ────────────────────────────────────────────────────
    diagnostics: list[dict[str, Any]] = []
    accumulated_audit = source_audit.sanitize_audit(request_source_audit)
    try:
        for idx, (name, fn) in enumerate(strategies):
            t0 = time.monotonic()
            print(f"[extract] {name} start")
            result = fn()
            duration_ms = (time.monotonic() - t0) * 1000

            diagnostics.append({k: v for k, v in result.items() if k != "media"})
            accumulated_audit.append(source_audit.audit_entry(
                strategy=name,
                source="strategy-result",
                selected=bool(result.get("success")),
                rejected_reason=None if result.get("success") else safe_text(result.get("reason") or "no media"),
                notes=f"{duration_ms:.0f}ms",
            ))

            if ctx:
                ctx.record_strategy(
                    name,
                    result.get("success", False),
                    duration_ms=duration_ms,
                    reason=result.get("reason"),
                    fatal=result.get("fatal", False),
                )

            if result.get("success") and result.get("media"):
                print(f"[extract] {name} success (extraction complete)")
                info = result["media"]
                if isinstance(info, dict):
                    info.setdefault("_extractor_strategy", name)
                    info.setdefault("_extractor_diagnostics", diagnostics)
                    source_audit.add_audit(info, accumulated_audit)
                    if ctx:
                        ctx.extractor = info.get("extractor")
                return info

            reason = safe_text(result.get("reason") or "no media")
            print(f"[extract] {name} failed: {reason[:240]}")
            if result.get("fatal"):
                raise HTTPException(400, reason or "fatal extraction error")
            if idx < len(strategies) - 1:
                print(f"[extract] falling back to {strategies[idx + 1][0]}")
    finally:
        auth.unlink_cookie_file(cookie_file)

    # ── All strategies exhausted ──────────────────────────────────────────────
    _SKIP_REASONS = frozenset({
        "browser runtime is client-side only",
        "browser playback fallback must run in the app WebView",
    })
    reason_str = "; ".join(
        f"{d.get('strategy', 'extractor')}: {d.get('reason', 'failed')}"
        for d in diagnostics
        if d.get("reason") and d.get("reason") not in _SKIP_REASONS
    )
    print(f"[extract] all strategies failed for {page_url}: {reason_str[:800]}")

    # Build an actionable error message based on the failure pattern.
    reason_lower = reason_str.lower()
    _has_unsupported = "unsupported url" in reason_lower
    _has_403 = "403" in reason_lower or "forbidden" in reason_lower
    _has_auth = any(k in reason_lower for k in ("sign in", "login", "auth", "cookie"))
    _has_geo = any(k in reason_lower for k in ("geo", "region", "country", "not available"))

    error_code: str | None = None
    if _has_auth or (_has_403 and not cookies):
        error_code = "AUTH_REQUIRED"
        detail = (
            "This page requires you to be signed in, or the server's IP is "
            "blocked by the site. Open the page in your browser, use the "
            "FCDownload bookmarklet or extension to capture your session "
            "cookies, and try again."
        )
    elif _has_geo:
        error_code = "GEO_BLOCKED"
        detail = (
            "This video is geo-restricted and cannot be accessed from the "
            "server's location. Try using a proxy, or use the FCDownload "
            "bookmarklet in a browser with VPN access."
        )
    elif _has_unsupported and _has_403:
        error_code = "AUTH_REQUIRED"
        detail = (
            "The page blocked the server's request (HTTP 403). This usually "
            "means the site requires a browser session or is geo-restricted. "
            "Use the FCDownload bookmarklet or extension in your browser to "
            "send your session cookies with the request."
        )
    elif _has_unsupported:
        error_code = "FORMAT_UNAVAILABLE"
        detail = (
            "No extractor found for this URL and the page HTML contained no "
            "detectable media. This usually means the video is loaded by a "
            "JavaScript player that the server cannot run. "
            "If you are using the FCDownloader browser extension, check the "
            "extension popup — it may have already detected the video "
            "automatically as the page loaded in your browser. "
            "Otherwise use the FCDownload bookmarklet to capture the stream "
            f"URL directly. (details: {reason_str[:400]})"
        )
    else:
        error_code = "FORMAT_UNAVAILABLE"
        detail = f"unsupported after all extraction strategies failed: {reason_str[:800]}"

    raise HTTPException(502, {
        "message": detail,
        "error_code": error_code,
        "diagnostics": diagnostics,
        "sourceAudit": source_audit.sanitize_audit(accumulated_audit),
    })


def run_extraction_with_format(
    page_url: str,
    referer: str | None = None,
    cookies: str | None = None,
    format_id: str | None = None,
    *,
    audio_only: bool = False,
    subtitles: bool = False,
    sub_langs: str = "en",
    concurrent_fragments: int = 1,
    proxy: str | None = None,
) -> dict[str, Any]:
    """Like run_extraction but with an explicit format_id selected by the user."""
    selected = safe_text(format_id).strip()
    if not selected:
        return run_extraction(
            page_url, referer=referer, cookies=cookies,
            audio_only=audio_only, subtitles=subtitles, sub_langs=sub_langs,
            concurrent_fragments=concurrent_fragments, proxy=proxy,
        )

    page_url = normalize_url(page_url)
    referer = normalize_url(referer) if referer else None
    cookies = safe_text(cookies) if cookies else None

    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "format": selected,
        "skip_download": True,
        "outtmpl": "/tmp/%(id)s.%(ext)s",
    }
    if concurrent_fragments > 1:
        ydl_opts["concurrent_fragment_downloads"] = concurrent_fragments
    if proxy:
        ydl_opts["proxy"] = proxy

    http_headers: dict[str, str] = {}
    if referer:
        http_headers["Referer"] = referer
    locale_accept_language = languages.accept_language_for_url(page_url)
    if locale_accept_language:
        http_headers["Accept-Language"] = locale_accept_language
    if cookies:
        http_headers["Cookie"] = cookies

    cookie_file: str | None = None
    if cookies:
        try:
            cookie_file = auth.write_cookie_file(cookies, page_url)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))
        if cookie_file:
            ydl_opts["cookiefile"] = cookie_file
    elif COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts["cookiefile"] = COOKIES_FILE

    if referer:
        ydl_opts["referer"] = referer
    if http_headers:
        ydl_opts["http_headers"] = safe_headers(http_headers)

    try:
        with YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(page_url, download=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"selected format failed: {safe_text(exc)[:400]}")
    finally:
        auth.unlink_cookie_file(cookie_file)

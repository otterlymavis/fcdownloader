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
import re
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
            if "m3u8" in _proto or re.search(r"\.m3u8?(?:[?#]|$)", _url, re.I):
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
            if "m3u8" in _proto or re.search(r"\.m3u8?(?:[?#]|$)", _url, re.I):
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

        if "dailymotion.com" in page_url:
            info = extractors.extract_dailymotion(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Dailymotion extractor found no media")

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

        if any(h in page_url for h in ("redgifs.com",)):
            info = extractors.extract_redgifs(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Redgifs extractor found no media")

        if any(h in page_url for h in ("bsky.app",)):
            info = extractors.extract_bluesky(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="Bluesky extractor found no media")

        # Mastodon: detect by snowflake ID in path — works across all instances.
        # Guard against known non-Mastodon sites that use similar URL patterns.
        _NON_MASTODON = ("twitter.com", "x.com", "bsky.app", "github.com", "instagram.com")
        if (
            not any(h in page_url for h in _NON_MASTODON)
            and re.search(
                r"/(?:@[^/?#]+|users/[^/?#]+/statuses)/\d{17,20}(?:[/?#]|$)",
                page_url,
            )
        ):
            info = extractors.extract_mastodon(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            # Don't hard-stop — fall through to yt-dlp if API returns nothing

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

        if ".tumblr.com/post/" in page_url:
            info = extractors.extract_tumblr(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            # Don't hard-stop — fall through to yt-dlp for video embeds

        if "note.com" in page_url:
            info = extractors.extract_note(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            return _result(name, False, reason="note.com extractor found no media")

        if "pixiv.net" in page_url and (
            re.search(r"/artworks?/\d+", page_url) or "illust_id=" in page_url
        ):
            info = extractors.extract_pixiv(page_url, cookies)
            if info:
                return _result(name, True, media=info)
            # Fall through to curated-site CDN scan as fallback

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

    if re.search(r"\.m3u8?(?:[?#]|$)", page_url, re.I):
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
    if _html_cache is not None and page_url in _html_cache:
        html_text = _html_cache[page_url]
    else:
        body, status = fetch_with_retry(page_url, req_headers, timeout=20, max_retries=1)
        if not body:
            return _result(name, False, reason=f"fetch failed (HTTP {status})")
        html_text = body.decode("utf-8", errors="replace")
        if _html_cache is not None:
            _html_cache[page_url] = html_text

    title = _html_title(html_text)
    thumbnail = _html_thumbnail(html_text, page_url)

    def _info_from_url(media_url: str) -> dict[str, Any]:
        url = normalize_url(html_mod.unescape(media_url))
        ext = guess_ext_from_url(url) or (
            "m3u8" if re.search(r"\.m3u8?(?:[?#]|$)", url, re.I) else
            "mpd"  if ".mpd"  in url.lower() else "mp4"
        )
        return {
            "url": url,
            "http_headers": safe_headers({**req_headers, "Referer": req_headers.get("Referer") or page_url}),
            "title": title, "thumbnail": thumbnail, "duration": None,
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


def _strategy_og_image_fallback(
    page_url: str,
    http_headers: dict[str, str],
    cookies: str | None,
    _html_cache: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Last-resort image extraction via og:image / twitter:image meta tags.

    Runs after embed detection so that pages with video embeds (Brightcove,
    JW Player, etc.) are handled by those strategies first; we only fall
    through here when everything else — including the embed detector — has
    returned no media.
    """
    import html as html_mod

    name = "og:image fallback"
    html_text = (_html_cache or {}).get(page_url, "")

    if not html_text:
        # Re-fetch only when the HTML was not cached from the prior scan step.
        req_headers = safe_headers({
            "User-Agent": http_headers.get("User-Agent") or MOBILE_UA,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            **({"Cookie": cookies} if cookies else {}),
        })
        body, status = fetch_with_retry(page_url, req_headers, timeout=15, max_retries=1)
        if not body:
            return _result(name, False, reason=f"fetch failed (HTTP {status})")
        html_text = body.decode("utf-8", errors="replace")

    urls = _scan_media_urls(html_text, "og_image")
    if not urls:
        return _result(name, False, reason="no og:image / twitter:image meta tags found")

    media_url = urllib.parse.urljoin(page_url, html_mod.unescape(urls[0]))
    title = _html_title(html_text)
    ext = guess_ext_from_url(media_url) or "jpg"
    info: dict[str, Any] = {
        "url": media_url,
        "ext": ext,
        "title": title,
        "id": cache_key(media_url),
        "protocol": "https",
        "http_headers": safe_headers({"Referer": page_url}),
    }
    print(f"[og-image] {media_url[:80]}")
    return _result(name, True, media=info)


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


_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "avif", "heic"}
_JP_VIDEO_ONLY_HOSTS = (
    "nicovideo.jp", "nico.ms", "niconico.com", "nicochannel.jp",
    "tver.jp", "tver.co.jp",
    "abema.tv", "abema.io",
    "cu.tbs.co.jp",
    "fod.fujitv.co.jp", "fod-sp.fujitv.co.jp", "fujitv.co.jp",
    "lemino.docomo.ne.jp", "animestore.docomo.ne.jp", "video.dmkt-sp.jp",
    "unext.jp", "video.unext.jp", "hulu.jp", "telasa.jp",
    "plus.nhk.jp", "nhk-ondemand.jp", "wowow.co.jp", "wod.wowow.co.jp",
    "b-ch.com", "bandainamcoid.com", "tv.rakuten.co.jp",
    "jod.jsports.co.jp", "jsports.co.jp", "spoox.skyperfectv.co.jp",
    "skyperfectv.co.jp",
    "locipo.jp", "dougaizm.mbs.jp", "mbs.jp", "ytv.co.jp",
    "video.tv-tokyo.co.jp", "douga.tv-asahi.co.jp", "ktv-smart.jp",
    "ktv.jp", "vod.ntv.co.jp", "cu.ntv.co.jp",
)


def _is_jp_video_only_page(page_url: str) -> bool:
    host = (urllib.parse.urlsplit(page_url).hostname or "").lower()
    return any(host == h or host.endswith(f".{h}") for h in _JP_VIDEO_ONLY_HOSTS)


def _media_is_image_only(info: dict[str, Any]) -> bool:
    if info.get("_type") == "playlist":
        entries = [entry for entry in (info.get("entries") or []) if isinstance(entry, dict)]
        if not entries:
            return False
        for entry in entries:
            url = safe_text(entry.get("url"))
            ext = safe_text(entry.get("ext") or guess_ext_from_url(url)).lower()
            protocol = safe_text(entry.get("protocol")).lower()
            if ext not in _IMAGE_EXTS and not protocol.startswith("image"):
                return False
        return True

    url = safe_text(info.get("url"))
    ext = safe_text(info.get("ext") or guess_ext_from_url(url)).lower()
    protocol = safe_text(info.get("protocol")).lower()
    return bool(url) and (ext in _IMAGE_EXTS or protocol.startswith("image"))


def _media_result_acceptable(page_url: str, info: dict[str, Any]) -> tuple[bool, str | None]:
    if _is_jp_video_only_page(page_url):
        if _media_is_image_only(info):
            return False, "image/poster result rejected for Japanese video page"
        if info.get("_type") != "playlist":
            media_url = safe_text(info.get("url"))
            page_key = normalize_url(page_url).split("#", 1)[0].rstrip("/")
            media_key = normalize_url(media_url).split("#", 1)[0].rstrip("/") if media_url else ""
            if media_key == page_key:
                return False, "page HTML URL rejected for Japanese video page"
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


def _html_thumbnail(html_text: str, page_url: str) -> str | None:
    import html as html_mod
    patterns = (
        r'<(?:video|audio)\b[^>]{0,600}?\bposter=["\']([^"\']+)["\']',
        r'<meta\s[^>]*?(?:property|name)\s*=\s*["\'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']',
        r'<meta\s[^>]*?content\s*=\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\s*=\s*["\'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["\']',
    )
    for pattern in patterns:
        m = re.search(pattern, html_text, re.IGNORECASE | re.DOTALL)
        if not m:
            continue
        raw = html_mod.unescape(m.group(1)).replace("\\/", "/").replace("\\u0026", "&").strip()
        if raw and not raw.lower().startswith(("data:", "blob:", "javascript:", "mailto:", "#")):
            return urllib.parse.urljoin(page_url, raw)
    return None


def _scan_media_urls(html_text: str, mode: str) -> list[str]:
    import re
    import html as html_mod
    patterns: list[str] = []
    if mode in {"hls", "generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.m3u8?[^"\'<>\s\\]*')
    if mode in {"dash", "generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.mpd[^"\'<>\s\\]*')
    if mode in {"generic"}:
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.(?:mp4|m4v|webm|mov)[^"\'<>\s\\]*')
        patterns.append(r'https?:\\?/\\?/[^"\'<>\s\\]+?\.(?:mp3|m4a|aac|ogg|flac|opus)[^"\'<>\s\\]*')
        # HTML5 <video src="...">, <source src="...">, <audio src="..."> — captures the
        # URL even when it lacks a file extension (common with signed CDN URLs).
        patterns.append(
            r'<(?:video|audio|source)\b[^>]{0,400}?\bsrc=["\']'
            r'([^"\'<>\s]{2,})["\']'
        )
        # data-src lazy-loaded variants (used by some video libraries).
        patterns.append(
            r'<(?:video|source)\b[^>]{0,400}?\bdata-src=["\']'
            r'([^"\'<>\s]{2,})["\']'
        )
        # data-video-url / data-stream-url / data-mp4 / data-hls on arbitrary
        # container elements (common in custom CMS and sports/news video players).
        patterns.append(
            r'<[a-z][a-z0-9-]*\b[^>]{0,600}?\bdata-(?:video-url|stream-url|media-url'
            r'|video-src|stream-src|hls-url|mp4-url|mp4|m3u8|hls)=["\']'
            r'([^"\'<>\s]{2,})["\']'
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
    if mode == "og_image":
        _it = r'(?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)'
        patterns.append(
            r'<meta\s[^>]*?(?:property|name)\s*=\s*["\']' + _it + r'["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']'
        )
        patterns.append(
            r'<meta\s[^>]*?content\s*=\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\s*=\s*["\']' + _it + r'["\']'
        )
    found: list[str] = []
    def _is_candidate(raw_url: str) -> bool:
        lower = raw_url.lower()
        if lower.startswith(("data:", "blob:", "javascript:", "mailto:", "#")):
            return False
        if raw_url.startswith(("http://", "https://", "/", "./", "../")):
            return True
        return bool(re.search(r'\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|ogg|flac|opus)(?:[?#]|$)', raw_url, re.IGNORECASE))

    variants = [
        html_text,
        html_text.replace("\\u0026", "&").replace("\\u003d", "=").replace("\\/", "/"),
    ]
    for text in variants:
        for pattern in patterns:
            for m in re.finditer(pattern, text, re.IGNORECASE | re.DOTALL):
                raw = m.group(1) if m.lastindex else m.group(0)
                raw = html_mod.unescape(raw).replace("\\/", "/").replace("\\u0026", "&").strip()
                if _is_candidate(raw) and raw not in found:
                    found.append(raw)
    return found


def _strategy_structured_media_data(
    page_url: str,
    http_headers: dict[str, str],
    cookies: str | None,
    _html_cache: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Extract media URLs from JSON-LD, RSS/media tags, and hydration blobs."""
    import html as html_mod
    import json as json_mod

    name = "structured media data"
    req_headers = safe_headers({
        "User-Agent": http_headers.get("User-Agent") or _DESKTOP_UA,
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
        if _html_cache is not None:
            _html_cache[page_url] = html_text

    direct_urls: list[str] = []
    embed_urls: list[str] = []
    thumbnail_urls: list[str] = []

    def add_direct(raw: Any) -> None:
        if not isinstance(raw, str):
            return
        url = html_mod.unescape(raw).replace("\\/", "/").replace("\\u0026", "&").strip()
        if not url or url.lower().startswith(("data:", "blob:", "javascript:", "mailto:", "#")):
            return
        if not url.startswith(("http://", "https://")):
            url = urllib.parse.urljoin(page_url, url)
        if url.startswith(("http://", "https://")) and url not in direct_urls:
            direct_urls.append(url)

    def add_embed(raw: Any) -> None:
        if not isinstance(raw, str):
            return
        url = html_mod.unescape(raw).replace("\\/", "/").replace("\\u0026", "&").strip()
        if not url or url.lower().startswith(("data:", "blob:", "javascript:", "mailto:", "#")):
            return
        if not url.startswith(("http://", "https://")):
            url = urllib.parse.urljoin(page_url, url)
        if url.startswith(("http://", "https://")) and url not in embed_urls:
            embed_urls.append(url)

    def add_thumbnail(raw: Any) -> None:
        if isinstance(raw, list):
            for item in raw:
                add_thumbnail(item)
            return
        if isinstance(raw, dict):
            add_thumbnail(raw.get("url") or raw.get("contentUrl"))
            return
        if not isinstance(raw, str):
            return
        url = html_mod.unescape(raw).replace("\\/", "/").replace("\\u0026", "&").strip()
        if not url or url.lower().startswith(("data:", "blob:", "javascript:", "mailto:", "#")):
            return
        if not url.startswith(("http://", "https://")):
            url = urllib.parse.urljoin(page_url, url)
        if url.startswith(("http://", "https://")) and url not in thumbnail_urls:
            thumbnail_urls.append(url)

    def schema_type(obj: dict[str, Any]) -> str:
        raw = obj.get("@type") or obj.get("type") or ""
        if isinstance(raw, list):
            return " ".join(str(x) for x in raw).lower()
        return str(raw).lower()

    def walk_schema(obj: Any, media_context: bool = False) -> None:
        if isinstance(obj, list):
            for item in obj:
                walk_schema(item, media_context)
            return
        if not isinstance(obj, dict):
            return

        obj_type = schema_type(obj)
        is_media = media_context or any(t in obj_type for t in ("videoobject", "audioobject", "mediaobject"))
        if is_media:
            for key in ("contentUrl", "contentURL", "url", "downloadUrl", "downloadURL"):
                add_direct(obj.get(key))
            add_embed(obj.get("embedUrl") or obj.get("embedURL"))
            add_thumbnail(obj.get("thumbnailUrl") or obj.get("thumbnailURL") or obj.get("thumbnail"))

        for key in ("associatedMedia", "video", "audio", "media", "encoding", "encodings"):
            if key in obj:
                walk_schema(obj[key], is_media)

    for ld_m in re.finditer(
        r'<script\b[^>]*?\btype=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html_text,
        re.DOTALL | re.IGNORECASE,
    ):
        try:
            walk_schema(json_mod.loads(html_mod.unescape(ld_m.group(1))))
        except Exception:
            continue

    for enc_m in re.finditer(
        r'<(?:enclosure|media:content)\b[^>]*?\burl=["\']([^"\']{10,})["\']',
        html_text,
        re.IGNORECASE,
    ):
        add_direct(enc_m.group(1))

    video_key_re = re.compile(
        r'"(?:video|audio|media|stream|play|file|download|hls|mp4|dash|manifest|content)'
        r'(?:Url|_url|URL|Src|_src|File|_file|Path|_path|Link)?"\s*:\s*"(https?://[^"]{10,})"'
        r'|"(?:source|src)(?:Url|_url|URL|Src|_src|File|_file|Path|_path|Link)+"\s*:\s*"(https?://[^"]{10,})"',
        re.IGNORECASE,
    )
    imageish_re = re.compile(
        r'(?:\.(?:jpe?g|png|gif|webp|svg|avif|bmp|ico)(?:[?#][^"]*)?$'
        r'|/(?:thumbnails?|thumbs?|avatars?|photos?|images?|imgs?|icons?|logos?|banners?|posters?)/)',
        re.IGNORECASE,
    )
    for scr_m in re.finditer(r"<script\b[^>]*>(.*?)</script>", html_text, re.DOTALL | re.IGNORECASE):
        script_text = html_mod.unescape(scr_m.group(1)).replace("\\/", "/").replace("\\u0026", "&")
        for key_m in video_key_re.finditer(script_text):
            url = key_m.group(1) or key_m.group(2) or ""
            if not imageish_re.search(url):
                add_direct(url)

    if not direct_urls and not embed_urls:
        return _result(name, False, reason="no structured media URLs found")

    page_title = _html_title(html_text)
    page_thumbnail = thumbnail_urls[0] if thumbnail_urls else _html_thumbnail(html_text, page_url)

    def mk_entry(url: str) -> dict[str, Any]:
        ext = guess_ext_from_url(url) or (
            "m3u8" if re.search(r"\.m3u8?(?:[?#]|$)", url, re.I) else
            "mpd" if ".mpd" in url.lower() else
            "mp3" if any(x in url.lower() for x in (".mp3", "/mp3", "audio/mpeg")) else "mp4"
        )
        return {
            "url": url,
            "ext": ext,
            "id": cache_key(url),
            "title": page_title,
            "thumbnail": page_thumbnail,
            "http_headers": req_headers,
            "protocol": "m3u8_native" if ext == "m3u8" else ("dash" if ext == "mpd" else "https"),
        }

    urls = direct_urls or embed_urls
    audit_entries = [
        source_audit.audit_entry(
            strategy=name,
            source="structured-metadata",
            url=url,
            selected=(i == 0),
            rejected_reason=None if i == 0 else "additional structured media URL",
            headers=req_headers,
        )
        for i, url in enumerate(urls[:20])
    ]
    if len(urls) == 1:
        return _result(name, True, media=source_audit.add_audit(mk_entry(urls[0]), audit_entries))

    playlist = {"_type": "playlist", "entries": [mk_entry(url) for url in urls[:40]], "title": page_title}
    source_audit.add_audit(playlist, audit_entries)
    return _result(name, True, media=playlist)


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
    import json as _json
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

    # ── oEmbed discovery: <link rel="alternate" type="application/json+oembed"> ──
    # Many pages expose the actual embeddable player through a small JSON endpoint.
    # The JSON commonly contains an iframe in `html`, which we can pass to yt-dlp.
    oembed_links: list[str] = []
    for link_m in re.finditer(r"<link\b[^>]{0,1200}>", html_text, re.IGNORECASE | re.DOTALL):
        tag = link_m.group(0)
        if "oembed" not in tag.lower():
            continue
        href_m = re.search(r'\bhref=["\']([^"\']+)["\']', tag, re.IGNORECASE)
        if not href_m:
            continue
        href = urllib.parse.urljoin(page_url, html_mod.unescape(href_m.group(1)))
        if href.startswith(("http://", "https://")) and href not in oembed_links:
            oembed_links.append(href)

    for oembed_url in oembed_links[:5]:
        body, status = fetch_with_retry(
            oembed_url,
            safe_headers({**req_headers, "Accept": "application/json"}),
            timeout=10,
            max_retries=1,
        )
        if not body:
            print(f"[embed] oEmbed fetch failed HTTP {status} for {oembed_url[:80]}")
            continue
        try:
            data = _json.loads(body)
        except Exception:
            continue
        html_fragment = str(data.get("html") or "")
        for iframe_m in re.finditer(r'<iframe\b[^>]+?\bsrc=["\']([^"\']+)["\']', html_fragment, re.IGNORECASE):
            src = urllib.parse.urljoin(page_url, html_mod.unescape(iframe_m.group(1)))
            if src.startswith(("http://", "https://")) and src not in embed_urls:
                embed_urls.append(src)
        for key in ("embed_url", "embedUrl", "url"):
            raw = data.get(key)
            if isinstance(raw, str):
                src = urllib.parse.urljoin(page_url, html_mod.unescape(raw))
                if src.startswith(("http://", "https://")) and src not in embed_urls:
                    embed_urls.append(src)

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
        # Also catch playlist: "URL" (when playlist is a remote JSON URL, not an array).
        for jw_file_m in re.finditer(
            r'(?:["\'](?:file|playlist)["\']|file|playlist)\s*:\s*["\']([^"\']{10,})["\']',
            setup_text, re.IGNORECASE,
        ):
            fu = html_mod.unescape(jw_file_m.group(1).replace("\\/", "/"))
            if fu.startswith(("http://", "https://")) and fu not in embed_urls:
                embed_urls.append(fu)

    # ── iframe embeds: YouTube, Vimeo, Brightcove, Dailymotion, Kaltura, Wistia,
    #    SoundCloud, Spreaker, Buzzsprout, Podbean, Anchor/Spotify, Rumble,
    #    Bunny.net Stream, Cloudflare Stream ────────────────────────────────────
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
        r'|odysee\.com/\$/embed/'
        r'|iframe\.mediadelivery\.net/embed/'
        r'|videodelivery\.net/'
        r'|cloudflarestream\.com/[a-f0-9]+/iframe'
        r'|iframe\.bunny\.net/embed/'
        r'|videopress\.com/(?:v|embed)/'
        r'|wordpress\.com/v/'
        r'|(?:www\.)?loom\.com/embed/'
        r'|open\.spotify\.com/embed/(?:episode|track|show|playlist)/'
        r'|player\.vdocipher\.com/v2/)[^"\']{4,})["\']',
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
                "m3u8" if re.search(r"\.m3u8?(?:[?#]|$)", u, re.I) else
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


def _probe_direct_media_url(page_url: str, http_headers: dict[str, str]) -> dict[str, Any] | None:
    """Identify extensionless direct media URLs by HEAD Content-Type."""
    probe_headers = safe_headers({
        "User-Agent": http_headers.get("User-Agent") or _DESKTOP_UA,
        "Accept": "video/*,audio/*,image/*,application/vnd.apple.mpegurl,application/dash+xml,*/*;q=0.4",
        **({"Referer": http_headers["Referer"]} if http_headers.get("Referer") else {}),
        **({"Origin": http_headers["Origin"]} if http_headers.get("Origin") else {}),
        **({"Cookie": http_headers["Cookie"]} if http_headers.get("Cookie") else {}),
    })

    def classify_content_type(content_type: str) -> tuple[str, str] | None:
        media_types = {
            "application/vnd.apple.mpegurl": ("m3u8", "m3u8_native"),
            "application/x-mpegurl": ("m3u8", "m3u8_native"),
            "application/mpegurl": ("m3u8", "m3u8_native"),
            "application/dash+xml": ("mpd", "http_dash_segments"),
            "video/mp4": ("mp4", "https"),
            "video/webm": ("webm", "https"),
            "video/quicktime": ("mov", "https"),
            "audio/mpeg": ("mp3", "https"),
            "audio/mp4": ("m4a", "https"),
            "audio/aac": ("aac", "https"),
            "audio/ogg": ("ogg", "https"),
            "audio/opus": ("opus", "https"),
            "audio/flac": ("flac", "https"),
            "image/jpeg": ("jpg", "https"),
            "image/png": ("png", "https"),
            "image/webp": ("webp", "https"),
            "image/gif": ("gif", "https"),
            "image/avif": ("avif", "https"),
        }
        ext_protocol = media_types.get(content_type)
        if ext_protocol:
            return ext_protocol
        if content_type.startswith("video/"):
            return ("mp4", "https")
        if content_type.startswith("audio/"):
            return ("mp3", "https")
        if content_type.startswith("image/"):
            return ("jpg", "https")
        return None

    def classify_signature(sample: bytes) -> tuple[str, str] | None:
        head = sample[:4096].lstrip()
        lower = head[:512].lower()
        if head.startswith(b"#EXTM3U"):
            return ("m3u8", "m3u8_native")
        if b"<mpd" in lower[:512]:
            return ("mpd", "http_dash_segments")
        if len(sample) >= 12 and sample[4:8] == b"ftyp":
            return ("mp4", "https")
        if head.startswith(b"\x1a\x45\xdf\xa3"):
            return ("webm", "https")
        if head.startswith(b"ID3") or head[:2] == b"\xff\xfb":
            return ("mp3", "https")
        if head.startswith(b"OggS"):
            return ("ogg", "https")
        if head.startswith(b"fLaC"):
            return ("flac", "https")
        if head.startswith(b"\xff\xd8\xff"):
            return ("jpg", "https")
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            return ("png", "https")
        if head.startswith((b"GIF87a", b"GIF89a")):
            return ("gif", "https")
        if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return ("webp", "https")
        return None

    content_type = ""
    probe_source = "request-url/head"
    ext_protocol: tuple[str, str] | None = None
    try:
        req = urllib.request.Request(page_url, headers=probe_headers, method="HEAD")
        with urllib.request.urlopen(req, timeout=8) as resp:
            content_type = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        ext_protocol = classify_content_type(content_type)
    except Exception:
        pass

    generic_or_unknown = content_type in {"", "application/octet-stream", "binary/octet-stream"}
    if not ext_protocol and (generic_or_unknown or content_type.startswith("application/")):
        range_headers = safe_headers({**probe_headers, "Range": "bytes=0-4095"})
        try:
            req = urllib.request.Request(page_url, headers=range_headers, method="GET")
            with urllib.request.urlopen(req, timeout=8) as resp:
                content_type = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                sample = b""
                if not classify_content_type(content_type):
                    try:
                        sample = resp.read(4096)
                    except TypeError:
                        sample = resp.read()
                probe_source = "request-url/range-get"
            ext_protocol = classify_content_type(content_type) or classify_signature(sample or b"")
        except Exception:
            return None

    if not ext_protocol:
        return None

    ext, protocol = ext_protocol
    return {
        "url": page_url,
        "http_headers": probe_headers,
        "title": None,
        "thumbnail": None,
        "duration": None,
        "ext": ext,
        "protocol": protocol,
        "id": cache_key(page_url),
        "_source_audit": [source_audit.audit_entry(
            strategy="direct media content-type probe",
            source=probe_source,
            url=page_url,
            selected=True,
            mime_type=content_type,
            headers=probe_headers,
        )],
    }


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
        r"(?:\.(?:mp4|webm|mov|m4v|m3u8?|mpd)(?:[?#]|$)"
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
            "m3u8" if re.search(r"\.m3u8?(?:[?#]|$)", page_url, re.I) else "mp4"
        )
        return {
            "url":          page_url,
            "http_headers": http_headers,
            "title":        None,
            "thumbnail":    None,
            "duration":     None,
            "ext":          ext,
            "protocol":     "m3u8_native" if re.search(r"\.m3u8?(?:[?#]|$)", page_url, re.I) else "https",
            "id":           cache_key(page_url),
            "_source_audit": [source_audit.audit_entry(
                strategy="direct media URL short-circuit",
                source="request-url",
                url=page_url,
                selected=True,
                headers=http_headers,
            )],
        }

    if probed_media := _probe_direct_media_url(page_url, http_headers):
        return probed_media

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
            "redgifs.com",
            "bsky.app",
            "tumblr.com",
            "dailymotion.com",
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
            ("structured media data",    lambda: _strategy_structured_media_data(page_url, http_headers, cookies, _html_cache)),
            # Combined HTML scan: fetches the page once and tries HLS→DASH→OG→generic
            # in priority order. The fetched HTML is cached in _html_cache so the
            # subsequent embed-detector strategy reuses it without a second HTTP request.
            ("HTML media scanner",       lambda: _strategy_html_scan_combined(page_url, http_headers, cookies, _html_cache)),
            ("embedded player detector", lambda: _strategy_page_embeds(page_url, http_headers, cookies, ydl_opts, _html_cache)),
            ("og:image fallback",        lambda: _strategy_og_image_fallback(page_url, http_headers, cookies, _html_cache)),
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
                info = result["media"]
                if isinstance(info, dict):
                    acceptable, reject_reason = _media_result_acceptable(page_url, info)
                    if not acceptable:
                        print(f"[extract] {name} rejected: {reject_reason}")
                        diagnostics[-1]["success"] = False
                        diagnostics[-1]["reason"] = reject_reason
                        if ctx:
                            ctx.record_strategy(
                                f"{name} result guard",
                                False,
                                reason=reject_reason,
                            )
                        if idx < len(strategies) - 1:
                            print(f"[extract] falling back to {strategies[idx + 1][0]}")
                        continue

                    print(f"[extract] {name} success (extraction complete)")
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
    _host = (urllib.parse.urlsplit(page_url).hostname or "").lower()
    _is_fod = _host.endswith("fod.fujitv.co.jp") or _host.endswith("fod-sp.fujitv.co.jp") or _host.endswith("fujitv.co.jp")
    _is_tbs_free = _host.endswith("cu.tbs.co.jp")
    _is_dmm = _host.endswith("dmm.co.jp") or _host.endswith("dmm.com") or _host.endswith("fanza.jp")
    _is_jp_svod = any(
        _host.endswith(h)
        for h in (
            "lemino.docomo.ne.jp", "animestore.docomo.ne.jp", "video.dmkt-sp.jp",
            "unext.jp", "video.unext.jp", "hulu.jp", "telasa.jp",
            "plus.nhk.jp", "nhk-ondemand.jp", "wowow.co.jp", "wod.wowow.co.jp",
            "b-ch.com", "bandainamcoid.com", "tv.rakuten.co.jp",
            "jod.jsports.co.jp", "jsports.co.jp", "spoox.skyperfectv.co.jp",
            "skyperfectv.co.jp",
        )
    )
    _is_jp_catchup = any(
        _host.endswith(h)
        for h in (
            "locipo.jp", "dougaizm.mbs.jp", "mbs.jp", "ytv.co.jp",
            "video.tv-tokyo.co.jp", "douga.tv-asahi.co.jp", "ktv-smart.jp",
            "ktv.jp", "vod.ntv.co.jp", "cu.ntv.co.jp",
        )
    )

    error_code: str | None = None
    if _is_dmm:
        error_code = "AUTH_REQUIRED"
        detail = (
            "DMM/FANZA pages are age-gated and many product URLs expire or move. "
            "Open the current page in a browser, complete age confirmation, then "
            "use the FCDownloader extension or bookmarklet so the extractor can "
            "receive the browser session."
        )
    elif _is_fod:
        error_code = "AUTH_REQUIRED"
        detail = (
            "FOD/Fuji TV playback commonly requires a current episode URL and a "
            "browser session. Open the episode in your browser or in-app WebView, "
            "wait for the player to load, then use FCDownloader so the session "
            "and runtime stream URL can be captured."
        )
    elif _is_tbs_free:
        error_code = "AUTH_REQUIRED"
        detail = (
            "TBS FREE episode pages now load playback metadata in the browser and "
            "older episode URLs expire quickly. Open a current episode in the "
            "browser, wait for playback, then use FCDownloader's browser/extension "
            "capture path."
        )
    elif _is_jp_svod:
        error_code = "AUTH_REQUIRED"
        detail = (
            "This Japanese streaming service usually requires a Japan IP, a current "
            "logged-in browser session, and sometimes DRM. Open the title in the "
            "browser, start playback, then use FCDownloader's browser/extension "
            "capture path. If the captured stream is DRM-protected, FCDownloader "
            "cannot download it."
        )
    elif _is_jp_catchup:
        error_code = "AUTH_REQUIRED"
        detail = (
            "This Japanese catch-up TV portal is geo-sensitive and commonly exposes "
            "playback URLs only after its browser player loads. Open a current episode "
            "from Japan, start playback, then use FCDownloader's browser/extension "
            "capture path."
        )
    elif _has_auth or (_has_403 and not cookies):
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

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
import time
import urllib.parse
from typing import Any, Callable

from fastapi import HTTPException
from yt_dlp import YoutubeDL

import auth
import classifier
import extractors
import languages
import registry
from config import COOKIES_FILE, FORMAT_SPEC, SERVER_BASE_URL, MOBILE_UA
from telemetry import RequestContext
from utils import (
    cache_key,
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
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
        if not info:
            return _result(name, False, reason="yt-dlp returned no info")
        # YouTube guard: skip_download=True from a datacenter IP often resolves
        # HLS/m3u8 as a SABR fallback.  Those URLs require YouTube session cookies
        # bound to the extracting IP, so ffmpeg can't remux them client-side.
        # Treat HLS as a failure so ytdl-stream (actual download mode) runs instead.
        if registry.is_youtube(page_url):
            _proto = (info.get("protocol") or "").lower()
            _url = (info.get("url") or "").lower()
            if "m3u8" in _proto or ".m3u8" in _url:
                return _result(
                    name, False,
                    reason=(
                        f"YouTube returned HLS ({_proto!r}) via skip_download — "
                        "SABR fallback; ytdl-stream needed"
                    ),
                )
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

        if registry.is_japanese_domain(page_url):
            return _result(
                name, False,
                reason="Japanese site — handled by yt-dlp with Accept-Language:ja; falling through"
            )

        return _result(name, False, reason="no matching platform extractor")
    except Exception as exc:  # noqa: BLE001
        return _result(name, False, reason=safe_text(exc)[:400])


def _strategy_html_detector(
    page_url: str,
    http_headers: dict[str, str],
    cookies: str | None,
    mode: str,
) -> dict[str, Any]:
    """HTML media scanner — HLS / DASH / OG-tag / generic URL scraper."""
    name = {
        "hls":     "HLS manifest detector",
        "dash":    "DASH manifest detector",
        "og":      "OG/meta tag extractor",
        "generic": "generic media detector",
    }.get(mode, "HTML media detector")

    import html as html_mod
    import urllib.error
    import urllib.request

    def _info_from_url(media_url: str, title: str | None = None) -> dict[str, Any]:
        url = normalize_url(html_mod.unescape(media_url))
        ext = guess_ext_from_url(url) or (
            "m3u8" if ".m3u8" in url.lower() else
            "mpd" if ".mpd" in url.lower() else "mp4"
        )
        return {
            "url": url,
            "http_headers": safe_headers({
                **http_headers,
                "Referer": http_headers.get("Referer") or page_url,
            }),
            "title": title,
            "thumbnail": None,
            "duration": None,
            "ext": ext,
            "protocol": (
                "m3u8_native" if ext == "m3u8" else
                "http_dash_segments" if ext == "mpd" else "https"
            ),
            "id": cache_key(url),
        }

    try:
        if mode == "hls" and ".m3u8" in page_url.lower():
            return _result(name, True, media=_info_from_url(page_url))
        if mode == "dash" and ".mpd" in page_url.lower():
            return _result(name, True, media=_info_from_url(page_url))

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
        req = urllib.request.Request(page_url, headers=req_headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            html_text = resp.read().decode("utf-8", errors="replace")

        title = _html_title(html_text)
        urls = _scan_media_urls(html_text, mode)
        if not urls:
            return _result(name, False, reason=f"{mode} detector found no media")

        media_url = urllib.parse.urljoin(page_url, urls[0])
        return _result(name, True, media=_info_from_url(media_url, title))

    except urllib.error.URLError as exc:
        return _result(name, False, reason=f"network error: {safe_text(exc)[:300]}")
    except TimeoutError as exc:
        return _result(name, False, reason=f"timeout: {safe_text(exc)[:300]}")
    except Exception as exc:  # noqa: BLE001
        return _result(name, False, reason=safe_text(exc)[:400])


def _strategy_ytdl_stream_url(
    page_url: str,
    ydl_opts: dict[str, Any],
    cookies: str | None,
) -> dict[str, Any]:
    """Last-resort: build a /ytdl-stream proxy URL.

    For YouTube SABR videos where skip_download=True cannot resolve format
    URLs, the /ytdl-stream endpoint runs yt-dlp in actual download mode and
    streams the result.  Clients forward cookies in X-FCDL-Cookies so the
    download URL stays short and does not expose session data.
    """
    name = "ytdl-stream"
    if not registry.is_youtube(page_url):
        return _result(name, False, reason="not a YouTube URL — ytdl-stream not needed")

    # Fetch lightweight metadata (title, thumbnail) for the UI preview.
    # tv_embedded bypasses the "Sign in to confirm you're not a bot" challenge
    # that datacenter IPs receive with ios/web_safari — one attempt, fail silently.
    meta: dict[str, Any] = {}
    try:
        opts = {
            **ydl_opts,
            "format": "18/b[height<=360][ext=mp4]/b[ext=mp4]",
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": {
                **(ydl_opts.get("extractor_args") or {}),
                "youtube": {"player_client": ["tv_embedded", "ios"]},
            },
        }
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
        "title":        meta.get("title") or "YouTube Video",
        "thumbnail":    meta.get("thumbnail"),
        "duration":     meta.get("duration"),
        "ext":          "mp4",
        "id":           meta.get("id") or cache_key(page_url),
        "webpage_url":  page_url,
        "protocol":     "https",
        "extractor":    "youtube",
        "http_headers": {},
    })


def _strategy_skip(name: str, reason: str) -> dict[str, Any]:
    return _result(name, False, reason=reason)


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
    if mode == "og":
        _vt = r'(?:og:video(?::url)?|og:video:secure_url|twitter:player:stream)'
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
) -> dict[str, Any]:
    """Detect embedded video players (Brightcove, JW Player, iframe) in page HTML.

    Many sites don't put direct MP4/HLS URLs in their HTML but do include static
    embed parameters — Brightcove data-account/data-video-id attributes, a
    jwplayer().setup({file:…}) call, or an <iframe> pointing to a supported
    player.  This strategy extracts those and passes them directly to yt-dlp.
    """
    import html as html_mod
    import re
    import urllib.error
    import urllib.request

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
    try:
        req = urllib.request.Request(page_url, headers=req_headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            html_text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return _result(name, False, reason=f"fetch: {safe_text(exc)[:200]}")
    except Exception as exc:  # noqa: BLE001
        return _result(name, False, reason=safe_text(exc)[:300])

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

    # ── JW Player: jwplayer().setup({ file: "URL" }) ──────────────────────────
    jw = re.search(
        r'jwplayer\s*\([^)]*\)\s*\.setup\s*\(\s*\{'
        r'[^}]{0,1200}?["\']file["\']\s*:\s*["\']([^"\']{10,})["\']',
        html_text, re.IGNORECASE | re.DOTALL,
    )
    if jw:
        fu = html_mod.unescape(jw.group(1).replace("\\/", "/"))
        if fu.startswith(("http://", "https://")):
            embed_urls.append(fu)

    # ── iframe embeds: YouTube, Vimeo, Brightcove, Dailymotion ───────────────
    for m in re.finditer(
        r'<iframe\b[^>]+?src=["\']'
        r'((?:https?:)?//(?:www\.)?'
        r'(?:youtube\.com/embed/|youtu\.be/|player\.vimeo\.com/video/'
        r'|vimeo\.com/\d|players\.brightcove\.net/'
        r'|dai\.ly/|dailymotion\.com/embed/video/)[^"\']{4,})["\']',
        html_text, re.IGNORECASE,
    ):
        u = html_mod.unescape(m.group(1))
        if u.startswith("//"):
            u = "https:" + u
        embed_urls.append(u)

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
) -> dict[str, Any]:
    """Build yt-dlp options dict for the given request."""
    extractor_args: dict[str, Any] = {
        "youtube": {
            "player_client": ["ios", "web_safari", "web_creator", "mweb", "tv"],
        },
    }
    if referer:
        extractor_args["vimeo"] = {"referer": [referer]}

    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "format": (
            "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio"
            if audio_only else FORMAT_SPEC
        ),
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
    ctx: RequestContext | None = None,
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
    elif any(h in page_url for h in ("xiaohongshu.com", "xhslink.com", "xhscdn.com")):
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
        r"|bilivideo\.com/|weibocdn\.com/|xhscdn\.com/"
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
        }

    # ── Cookie file ───────────────────────────────────────────────────────────
    cookie_file: str | None = None
    if cookies:
        try:
            cookie_file = auth.write_cookie_file(cookies, page_url)
        except (auth.CookieTooLargeError, auth.CookieFormatError) as exc:
            raise HTTPException(400, str(exc))

    # ── Strategy list ─────────────────────────────────────────────────────────
    ydl_opts = build_ydl_opts(
        page_url, http_headers, cookie_file,
        audio_only=audio_only, subtitles=subtitles, sub_langs=sub_langs,
        concurrent_fragments=concurrent_fragments, proxy=proxy, referer=referer,
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
        strategies: list[tuple[str, Callable[[], dict[str, Any]]]] = [
            ("yt-dlp",                   lambda: _strategy_ydl(page_url, ydl_opts, False)),
            ("platform-specific extractor", lambda: _strategy_platform_extractors(page_url, cookies)),
            ("WebView/runtime interception", lambda: _strategy_skip(
                "WebView/runtime interception",
                "browser runtime is client-side only",
            )),
            ("HLS manifest detector",    lambda: _strategy_html_detector(page_url, http_headers, cookies, "hls")),
            ("DASH manifest detector",   lambda: _strategy_html_detector(page_url, http_headers, cookies, "dash")),
            ("OG/meta tag extractor",    lambda: _strategy_html_detector(page_url, http_headers, cookies, "og")),
            ("generic media detector",   lambda: _strategy_html_detector(page_url, http_headers, cookies, "generic")),
            ("embedded player detector", lambda: _strategy_page_embeds(page_url, http_headers, cookies, ydl_opts)),
            ("generic yt-dlp extractor", lambda: _strategy_ydl(page_url, ydl_opts, True)),
            ("ytdl-stream",              lambda: _strategy_ytdl_stream_url(page_url, ydl_opts, cookies)),
            ("browser playback fallback", lambda: _strategy_skip(
                "browser playback fallback",
                "browser playback fallback must run in the app WebView",
            )),
        ]

    # ── Pipeline execution ────────────────────────────────────────────────────
    diagnostics: list[dict[str, Any]] = []
    try:
        for idx, (name, fn) in enumerate(strategies):
            t0 = time.monotonic()
            print(f"[extract] {name} start")
            result = fn()
            duration_ms = (time.monotonic() - t0) * 1000

            diagnostics.append({k: v for k, v in result.items() if k != "media"})

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

    if _has_auth or (_has_403 and not cookies):
        detail = (
            "This page requires you to be signed in, or the server's IP is "
            "blocked by the site. Open the page in your browser, use the "
            "FCDownload bookmarklet or extension to capture your session "
            "cookies, and try again."
        )
    elif _has_geo:
        detail = (
            "This video is geo-restricted and cannot be accessed from the "
            "server's location. Try using a proxy, or use the FCDownload "
            "bookmarklet in a browser with VPN access."
        )
    elif _has_unsupported and _has_403:
        detail = (
            "The page blocked the server's request (HTTP 403). This usually "
            "means the site requires a browser session or is geo-restricted. "
            "Use the FCDownload bookmarklet or extension in your browser to "
            "send your session cookies with the request."
        )
    elif _has_unsupported:
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
        detail = f"unsupported after all extraction strategies failed: {reason_str[:800]}"

    raise HTTPException(502, detail)


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

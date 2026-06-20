"""Universal HTML/media parser for browser-submitted page HTML.

This deliberately stays pure: no network I/O and no FastAPI imports. It returns
yt-dlp-shaped info dictionaries that main.py can pass through existing response
normalizers.
"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
from typing import Any

from utils import cache_key, guess_ext_from_url, normalize_url, safe_text


IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "avif", "heic"}
AUDIO_EXTS = {"mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"}
PAGE_FETCH_MAX_BYTES = 1_500_000
PAGE_FETCH_SKIP_EXTS = {
    "3gp", "7z", "aac", "avi", "avif", "csv", "doc", "docx", "flac", "flv",
    "gif", "gz", "heic", "jpeg", "jpg", "json", "m4a", "m4v", "mkv", "mov",
    "mp3", "mp4", "mpeg", "mpg", "ogg", "opus", "pdf", "png", "rar", "tar",
    "ts", "txt", "wav", "webm", "webp", "xls", "xlsx", "zip",
}


def should_fetch_page_html(page_url: str) -> bool:
    parsed = urllib.parse.urlparse(page_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    path = parsed.path.lower()
    if path.endswith((".mpd", ".m3u", ".m3u8")):
        return False
    ext = guess_ext_from_url(page_url).lower()
    return ext not in PAGE_FETCH_SKIP_EXTS


def is_htmlish_content_type(content_type: object) -> bool:
    value = safe_text(content_type).split(";", 1)[0].strip().lower()
    return not value or value in {"text/html", "application/xhtml+xml"}


def is_feed_content_type(content_type: object) -> bool:
    value = safe_text(content_type).split(";", 1)[0].strip().lower()
    return value in {
        "application/rss+xml", "application/atom+xml", "application/feed+json",
        "application/xml", "text/xml",
    }


def looks_like_feed_text(text: object) -> bool:
    """True when the raw text looks like an XML feed despite an unhelpful content-type.

    Checks only the first 100 bytes so it stays cheap. Catches CDNs and podcast
    hosts that serve RSS/Atom as text/plain or application/octet-stream.
    """
    head = safe_text(text)[:100].lstrip()
    return bool(re.match(r"<\?xml\b|<rss\b|<feed\b|<atom\b", head, re.I))


def looks_like_json_feed_text(text: object) -> bool:
    """True when a JSON body looks like a JSON Feed 1.x document.

    Checks the first 300 characters for the canonical version URL so this is
    cheap to call on arbitrary application/json responses.
    """
    head = safe_text(text)[:300]
    return '"version"' in head and "jsonfeed.org" in head


def charset_from_content_type(content_type: object) -> str:
    match = re.search(r"(?:^|;)\s*charset=([A-Za-z0-9._-]+)", safe_text(content_type), re.I)
    return match.group(1) if match else "utf-8"


def extract_universal_from_response(
    page_url: str,
    body: bytes,
    content_type: object = "",
    *,
    max_bytes: int = PAGE_FETCH_MAX_BYTES,
) -> dict[str, Any] | None:
    if not should_fetch_page_html(page_url):
        return None
    if not is_htmlish_content_type(content_type):
        return None
    if len(body) > max_bytes:
        return None
    page_html = body.decode(charset_from_content_type(content_type), errors="replace")
    return extract_universal_from_html(page_url, page_html)


def _clean_url(raw: object, page_url: str) -> str:
    value = html.unescape(safe_text(raw))
    value = (
        value.replace("\\u0026", "&")
        .replace("\\u003d", "=")
        .replace("\\/", "/")
        .strip()
        .rstrip("),;.\"'<> \t\r\n")
    )
    if not value or re.match(r"^(?:data:|blob:|javascript:|mailto:|#)", value, re.I):
        return ""
    # Unwrap Next.js image optimizer proxy: /_next/image?url=ENCODED_URL&w=...&q=...
    _nx = re.search(r"/_next/image\?[^\s]*\burl=([^&\s]+)", value, re.I)
    if _nx:
        try:
            _decoded = urllib.parse.unquote(_nx.group(1))
            if _decoded.startswith(("http://", "https://")):
                return normalize_url(_decoded)
        except Exception:
            pass
    try:
        return normalize_url(urllib.parse.urljoin(page_url, value))
    except Exception:
        return ""


_SUBTITLE_EXTS = {"vtt", "webvtt", "srt", "ttml", "dfxp", "ass", "ssa", "sub", "sbv"}


def _parse_iso_duration(value: Any) -> int | None:
    """Parse ISO 8601 duration string ('PT1H32M45S') or plain number to integer seconds."""
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    if not isinstance(value, str):
        return None
    m = re.match(
        r"^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?"
        r"(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$",
        value, re.I,
    )
    if not m:
        return None
    total = (
        float(m.group(1) or 0) * 365.25 * 86400
        + float(m.group(2) or 0) * 30.4375 * 86400
        + float(m.group(3) or 0) * 7 * 86400
        + float(m.group(4) or 0) * 86400
        + float(m.group(5) or 0) * 3600
        + float(m.group(6) or 0) * 60
        + float(m.group(7) or 0)
    )
    return round(total) if total > 0 else None


def _media_kind(url: str, hinted: str = "") -> str:
    ext = guess_ext_from_url(url).lower()
    if hinted in {"video", "audio", "image", "subtitle"}:
        return hinted
    if ext in _SUBTITLE_EXTS:
        return "subtitle"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    return "video"


def _protocol(url: str, hinted: str = "") -> str:
    lower = f"{url} {hinted}".lower()
    if ".mpd" in lower or "dash" in lower or ".ism" in lower or "ms-sstr" in lower:
        return "http_dash_segments"
    if ".m3u8" in lower or ".m3u" in lower or "mpegurl" in lower:
        return "m3u8"
    return "https"


def _confidence(source: str, url: str, kind: str, protocol_hint: str = "") -> float:
    protocol = _protocol(url, protocol_hint)
    if source == "media-element":
        return 0.92 if protocol in {"m3u8", "http_dash_segments"} else 0.88
    if source == "resource-link":
        return 0.82 if protocol in {"m3u8", "http_dash_segments"} else 0.78 if kind in {"video", "audio"} else 0.8
    if source == "download-link":
        return 0.82 if kind in {"video", "audio"} else 0.8
    if source == "data-attribute":
        return 0.82 if protocol in {"m3u8", "http_dash_segments"} else 0.78 if kind in {"video", "audio"} else 0.8
    if source == "css-background":
        return 0.8 if kind == "image" else 0.6
    if source in {"player-config", "html-template"}:
        return 0.84 if protocol in {"m3u8", "http_dash_segments"} else 0.78 if kind in {"video", "audio"} else 0.64
    if source == "hydration-data":
        return 0.82 if protocol in {"m3u8", "http_dash_segments"} else 0.76 if kind in {"video", "audio"} else 0.62
    if source == "microdata":
        return 0.8
    if source == "json-ld":
        return 0.82 if kind == "video" else 0.72
    if source == "open-graph":
        return 0.78 if kind == "video" else 0.8 if kind == "image" else 0.76
    return 0.62


def _is_junk(url: str, kind: str) -> bool:
    lower = url.lower()
    if re.search(r"/(?:favicon|apple-touch-icon|sprite|spacer|blank|pixel|tracking)[^/]*(?:[?#.]|$)", lower):
        return True
    ext = guess_ext_from_url(lower).lower()
    if ext in {"svg", "woff", "woff2", "ttf", "eot", "otf", "ico"}:
        return True
    if kind == "image" and re.search(r"(?:^|[/?&_-])(?:avatar|profile|badge|logo|icon)(?:[/?&_.=-]|$)", lower):
        return True
    if kind == "image" and re.search(r"\b(?:width|w|height|h)=(?:1|2|3|4|8|16)\b", lower):
        return True
    return False


def _entry(page_url: str, url: str, source: str, *, kind_hint: str = "", title: str = "", thumbnail: str = "", protocol_hint: str = "", duration: int | None = None, width: int | None = None, height: int | None = None, confidence_override: float | None = None) -> dict[str, Any] | None:
    if not url.startswith(("http://", "https://")):
        return None
    ext = guess_ext_from_url(url).lower()
    protocol = _protocol(url, protocol_hint)
    direct_hint = bool(re.match(r"^(?:video|audio|image)/", protocol_hint, re.I))
    if not ext and protocol == "https" and not direct_hint:
        return None
    kind = _media_kind(url, kind_hint)
    if _is_junk(url, kind):
        return None
    confidence = confidence_override if confidence_override is not None else _confidence(source, url, kind, protocol_hint)
    if kind in {"video", "audio"} and confidence < 0.75:
        return None
    if kind == "image" and confidence < 0.8:
        return None
    if not ext:
        ext = (
            "mpd" if protocol == "http_dash_segments"
            else "m3u8" if protocol == "m3u8"
            else "m4a" if kind == "audio"
            else "jpg" if kind == "image"
            else "vtt" if kind == "subtitle"
            else "mp4"
        )
    result: dict[str, Any] = {
        "id": cache_key(url),
        "title": title or "Universal media",
        "url": url,
        "webpage_url": page_url,
        "ext": ext,
        "protocol": protocol,
        "extractor": "universal-html",
        "_universal_confidence": confidence,
        "thumbnail": thumbnail or None,
        "http_headers": {"Referer": page_url},
    }
    if duration:
        result["duration"] = duration
    if width:
        result["width"] = width
    if height:
        result["height"] = height
    return result


def _add(
    entries: list[dict[str, Any]],
    seen: set[str],
    page_url: str,
    raw_url: object,
    source: str,
    *,
    resolve_base: str = "",
    confidence_override: float | None = None,
    **kwargs: Any,
) -> None:
    url = _clean_url(raw_url, resolve_base or page_url)
    if not url or url in seen:
        return
    entry = _entry(page_url, url, source, confidence_override=confidence_override, **kwargs)
    if not entry:
        return
    seen.add(url)
    entries.append(entry)


def _meta_attrs(tag: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in re.finditer(r"\b([a-zA-Z_:.-]+)\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s\"'<>]+))", tag):
        attrs[match.group(1).lower()] = match.group(3) or match.group(4) or match.group(5) or ""
    return attrs


def _base_url_from_html(html_text: str, page_url: str) -> str:
    match = re.search(r"<base\b[^>]*>", html_text, re.I)
    if not match:
        return page_url
    href = _meta_attrs(match.group(0)).get("href")
    return _clean_url(href, page_url) or page_url


def _best_srcset_candidate(srcset: str | None) -> str:
    if not srcset:
        return ""
    best_url = ""
    best_score = -1.0
    for part in html.unescape(srcset).split(","):
        bits = part.strip().split()
        if not bits:
            continue
        descriptor = bits[1] if len(bits) > 1 else "1x"
        width = re.match(r"^(\d+)w$", descriptor, re.I)
        density = re.match(r"^(\d+(?:\.\d+)?)x$", descriptor, re.I)
        score = float(width.group(1)) if width else float(density.group(1)) * 1000 if density else 1.0
        if score > best_score:
            best_url = bits[0]
            best_score = score
    return best_url


def _data_attribute_protocol_hint(name: str, url: str) -> str:
    signal = f"{name} {url}".lower()
    if re.search(r"dash|mpd|\.ism[l]?(?:/manifest)?|ms-sstr", signal):
        return "application/dash+xml"
    if re.search(r"hls|m3u8|mpegurl", signal):
        return "application/vnd.apple.mpegurl"
    if re.search(r"audio|podcast|m4a|aac|mp3", signal):
        return "audio/mp4"
    if re.search(r"image|img|photo|picture|thumb|thumbnail|poster|cover|original|fullsize|srcset", signal):
        return "image/jpeg"
    if re.search(r"video|media|stream|playback|download|mp4|webm", signal):
        return "video/mp4"
    return ""


def _strong_data_attribute(name: str, raw_url: str, protocol_hint: str) -> bool:
    if not name.lower().startswith("data-"):
        return False
    if re.search(r"api|config|endpoint|href|link|page|profile|avatar|icon|tracking|pixel", name, re.I):
        return False
    if not re.search(r"video|media|stream|play|playback|download|hls|dash|mpd|mp4|m4v|webm|mov|ogg|flv|audio|mp3|m4a|podcast|image|img|photo|picture|thumb|thumbnail|poster|cover|original|fullsize|srcset|lazy|hd|sd", name, re.I):
        return False
    return bool(
        re.search(r"\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)", raw_url, re.I)
        or _protocol(raw_url, protocol_hint) in {"m3u8", "http_dash_segments"}
        or re.match(r"^(?:video|audio|image)/", protocol_hint, re.I)
    )


def _scan_data_attributes(html_text: str, page_url: str, entries: list[dict[str, Any]], seen: set[str], resolve_base: str = "") -> None:
    for match in re.finditer(r"<[a-zA-Z][^>]*\sdata-[^>]*>", html_text):
        attrs = _meta_attrs(match.group(0))
        for name, value in attrs.items():
            if not name.lower().startswith("data-"):
                continue
            raw_url = _best_srcset_candidate(value) if "srcset" in name.lower() else value
            protocol_hint = _data_attribute_protocol_hint(name, raw_url)
            if not raw_url or not _strong_data_attribute(name, raw_url, protocol_hint):
                continue
            _add(
                entries,
                seen,
                page_url,
                raw_url,
                "data-attribute",
                resolve_base=resolve_base,
                kind_hint=_resource_kind_hint(name, protocol_hint),
                protocol_hint=protocol_hint,
            )
            if len(entries) >= 80:
                return


def _scan_css_background_images(html_text: str, page_url: str, entries: list[dict[str, Any]], seen: set[str], resolve_base: str = "") -> None:
    def scan_css_text(css_text: str) -> None:
        text = html.unescape(css_text)
        for match in re.finditer(r"url\(\s*['\"]?([^\"')\s]+)['\"]?\s*\)", text, re.I):
            raw_url = match.group(1)
            nearby = text[max(0, match.start() - 90): min(len(text), match.end() + 90)]
            if not re.search(r"(?:background(?:-image)?|image-set)\s*[:(,]", nearby, re.I):
                continue
            if guess_ext_from_url(raw_url).lower() not in IMAGE_EXTS:
                continue
            _add(
                entries,
                seen,
                page_url,
                raw_url,
                "css-background",
                resolve_base=resolve_base,
                kind_hint="image",
                protocol_hint="image/jpeg",
            )
            if len(entries) >= 80:
                return

    for match in re.finditer(r"<[a-zA-Z][^>]*\sstyle\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s\"'<>]+))[^>]*>", html_text, re.I):
        scan_css_text(match.group(2) or match.group(3) or match.group(4) or "")
        if len(entries) >= 80:
            return

    for match in re.finditer(r"<style\b[^>]*>(.*?)</style>", html_text, re.I | re.S):
        scan_css_text(match.group(1))
        if len(entries) >= 80:
            return


def _resource_kind_hint(as_value: str, protocol_hint: str) -> str:
    signal = f"{as_value} {protocol_hint}".lower()
    if "image" in signal:
        return "image"
    if "audio" in signal:
        return "audio"
    if "video" in signal or "dash" in signal or "mpegurl" in signal or "m3u8" in signal:
        return "video"
    return ""


def _strong_resource_link(attrs: dict[str, str], raw_url: str, protocol_hint: str) -> bool:
    rel = attrs.get("rel", "").lower()
    as_value = attrs.get("as", "").lower()
    # Old-style Facebook/OpenGraph link hints and HTML5 media-typed links
    if re.match(r"^(?:video[_-]src|audio[_-]src|image[_-]src|media|video|audio)$", rel):
        return bool(
            re.match(r"^(?:video|audio|image)/", protocol_hint, re.I)
            or re.search(r"\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)", raw_url, re.I)
            or _protocol(raw_url, protocol_hint) in {"m3u8", "http_dash_segments"}
        )
    # <link rel="alternate" type="video/..."> or type="audio/...":
    # podcast/video sites advertise alternate media representations this way.
    if rel == "alternate" and re.match(r"^(?:video|audio)/", protocol_hint, re.I):
        return True
    if not re.search(r"preload|prefetch|prerender|modulepreload", rel):
        return False
    if as_value not in {"video", "audio", "image", "fetch"}:
        return False
    return bool(
        re.match(r"^(?:video|audio|image)/", protocol_hint, re.I)
        or re.search(r"\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)", raw_url, re.I)
        or _protocol(raw_url, protocol_hint) in {"m3u8", "http_dash_segments"}
    )


def _scan_resource_links(html_text: str, page_url: str, entries: list[dict[str, Any]], seen: set[str], resolve_base: str = "") -> None:
    for match in re.finditer(r"<link\b[^>]*>", html_text, re.I):
        attrs = _meta_attrs(match.group(0))
        raw_url = attrs.get("href") or _best_srcset_candidate(attrs.get("imagesrcset"))
        if not raw_url:
            continue
        protocol_hint = attrs.get("type", "")
        if not _strong_resource_link(attrs, raw_url, protocol_hint):
            continue
        _add(
            entries,
            seen,
            page_url,
            raw_url,
            "resource-link",
            resolve_base=resolve_base,
            kind_hint=_resource_kind_hint(attrs.get("as", ""), protocol_hint),
            protocol_hint=protocol_hint,
        )
        if len(entries) >= 80:
            return

    for match in re.finditer(r"<a\b[^>]*\bdownload(?:\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'<>]+))?[^>]*>", html_text, re.I):
        attrs = _meta_attrs(match.group(0))
        raw_url = attrs.get("href")
        if not raw_url:
            continue
        protocol_hint = attrs.get("type", "")
        if not (
            re.match(r"^(?:video|audio|image)/", protocol_hint, re.I)
            or re.search(r"\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)", raw_url, re.I)
            or _protocol(raw_url, protocol_hint) in {"m3u8", "http_dash_segments"}
        ):
            continue
        _add(
            entries,
            seen,
            page_url,
            raw_url,
            "download-link",
            resolve_base=resolve_base,
            kind_hint=_resource_kind_hint("", protocol_hint),
            protocol_hint=protocol_hint,
        )
        if len(entries) >= 80:
            return

    # Plain <a href> links to media files (no `download` attr required).
    # Accept either a media file extension in the href, OR an explicit media MIME
    # type on the `type` attribute (covers extensionless CDN URLs typed as video/*).
    _MEDIA_ANCHOR_EXT_RE = re.compile(
        r"\.(?:mp3|mp4|m4v|m4a|webm|mov|ogg|opus|flac|wav|aac|m3u8?|mpd)(?:[?#]|$)", re.I
    )
    _PAGE_EXT_RE = re.compile(r"\.(?:html?|php|asp(?:x)?|jsp?|py|rb|go|cfm|cgi)(?:[?#]|$)", re.I)
    # \s (not \b) immediately before "href": a word boundary would also match "href"
    # inside "data-href", and greedy backtracking in [^>]* makes that ambiguous enough
    # to sometimes prefer the wrong attribute's value over the real href.
    for match in re.finditer(r"<a\b(?![^>]*\bdownload\b)[^>]*\shref\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'<>]+))[^>]*>",
                             html_text, re.I):
        href = match.group(1) or match.group(2) or match.group(3) or ""
        if not href or _PAGE_EXT_RE.search(href):
            continue
        attrs = _meta_attrs(match.group(0))
        protocol_hint = attrs.get("type", "")
        has_media_ext = bool(_MEDIA_ANCHOR_EXT_RE.search(href))
        has_media_mime = bool(
            re.match(r"^(?:video|audio)/", protocol_hint, re.I)
            or re.search(r"(?:mpegurl|dash\+xml|vnd\.apple\.mpegurl)", protocol_hint, re.I)
        )
        if not has_media_ext and not has_media_mime:
            continue
        _add(
            entries, seen, page_url, href, "download-link",
            resolve_base=resolve_base,
            kind_hint=_resource_kind_hint("", protocol_hint),
            protocol_hint=protocol_hint,
        )
        if len(entries) >= 80:
            return


def _microdata_protocol_hint(prop: str, raw_url: str, explicit_type: str = "") -> str:
    if re.match(r"^(?:video|audio|image)/", explicit_type, re.I):
        return explicit_type
    if re.search(r"dash", explicit_type, re.I):
        return "application/dash+xml"
    if re.search(r"mpegurl|m3u8", explicit_type, re.I):
        return "application/vnd.apple.mpegurl"
    ext = guess_ext_from_url(raw_url).lower()
    if ext == "mpd":
        return "application/dash+xml"
    if ext in {"m3u", "m3u8"}:
        return "application/vnd.apple.mpegurl"
    if ext in AUDIO_EXTS:
        return "audio/mp4"
    if ext in IMAGE_EXTS or re.match(r"^(?:thumbnailurl|image|poster)$", prop, re.I):
        return "image/jpeg"
    if ext:
        return "video/mp4"
    return ""


def _strong_microdata_url(prop: str, raw_url: str, protocol_hint: str) -> bool:
    signal = f"{raw_url} {protocol_hint}".lower()
    if re.search(r"\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)", signal):
        return True
    if _protocol(raw_url, protocol_hint) in {"m3u8", "http_dash_segments"}:
        return True
    return bool(re.match(r"^(?:video|audio|image)/", protocol_hint, re.I))


def _scan_microdata_media(html_text: str, page_url: str, entries: list[dict[str, Any]], seen: set[str], resolve_base: str = "") -> None:
    for match in re.finditer(r"<[a-zA-Z][^>]*\bitemprop\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s\"'<>]+))[^>]*>", html_text, re.I):
        tag = match.group(0)
        attrs = _meta_attrs(tag)
        props = safe_text(attrs.get("itemprop")).lower().split()
        prop = next((item for item in props if re.match(r"^(?:contenturl|downloadurl|thumbnailurl|image|poster)$", item, re.I)), "")
        if not prop:
            continue
        raw_url = (attrs.get("content") or attrs.get("href") or attrs.get("src")
                   or attrs.get("data-src") or attrs.get("data-lazy-src"))
        if not raw_url:
            continue
        protocol_hint = _microdata_protocol_hint(prop, raw_url, attrs.get("type", ""))
        if not _strong_microdata_url(prop, raw_url, protocol_hint):
            continue
        _add(
            entries,
            seen,
            page_url,
            raw_url,
            "microdata",
            resolve_base=resolve_base,
            kind_hint="image" if re.match(r"^(?:thumbnailurl|image|poster)$", prop, re.I) else _resource_kind_hint(prop, protocol_hint),
            protocol_hint=protocol_hint,
        )
        if len(entries) >= 80:
            return


def _player_protocol_hint(key: str, url: str, nearby: str = "") -> str:
    ext = guess_ext_from_url(url).lower()
    if ext == "mpd":
        return "application/dash+xml"
    if ext in {"ism", "isml"}:
        return "application/vnd.ms-sstr+xml"
    if ext in {"m3u", "m3u8"}:
        return "application/vnd.apple.mpegurl"
    if ext in {"mp4", "m4v", "mov"}:
        return "video/mp4"
    if ext == "webm":
        return "video/webm"
    if ext in AUDIO_EXTS:
        return "audio/mp4"
    if ext in IMAGE_EXTS:
        return "image/jpeg"
    if re.match(r"^(?:dash_url|dashUrl|mpd_url|mpdUrl)$", key, re.I):
        return "application/dash+xml"
    if re.match(r"^(?:hls_url|hlsUrl|m3u8_url|m3u8Url|manifest_url|manifestUrl|master_url|masterUrl)$", key, re.I):
        return "application/vnd.apple.mpegurl"
    if re.match(r"^(?:flv_url|flvUrl)$", key, re.I):
        return "video/x-flv"
    if re.match(r"^(?:audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl)$", key, re.I):
        return "audio/mpeg"
    if re.match(r"^(?:live_url|liveUrl|live_stream_url|liveStreamUrl)$", key, re.I):
        return "video/mp4"
    if re.match(r"^(?:mp4_url|mp4Url|video_url|videoUrl|playable_url|playableUrl|hd_src|hdSrc|sd_src|sdSrc|stream_url|streamUrl|media_url|mediaUrl|contentUrl|contentURL|download_url|downloadUrl|play_url|playUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl)$", key, re.I):
        return "video/mp4"
    explicit = re.search(r"\b(?:type|mimeType|contentType)\s*:\s*['\"]([^'\"]+)['\"]", nearby, re.I)
    explicit_type = explicit.group(1) if explicit else ""
    if re.search(r"dash", explicit_type, re.I):
        return "application/dash+xml"
    if re.search(r"mpegurl|m3u8|hls", explicit_type, re.I):
        return "application/vnd.apple.mpegurl"
    if re.search(r"video/webm", explicit_type, re.I):
        return "video/webm"
    if re.search(r"video/", explicit_type, re.I):
        return "video/mp4"
    if re.search(r"audio/", explicit_type, re.I):
        return "audio/mp4"
    if re.search(r"image/", explicit_type, re.I):
        return "image/jpeg"
    signal = f"{key} {url} {nearby}".lower()
    if re.search(r"dash|mpd", signal):
        return "application/dash+xml"
    if re.search(r"hls|m3u8|mpegurl", signal):
        return "application/vnd.apple.mpegurl"
    if re.search(r"webm", signal):
        return "video/webm"
    if re.search(r"mp4|video", signal):
        return "video/mp4"
    if re.search(r"m4a|aac|audio", signal):
        return "audio/mp4"
    if re.search(r"jpe?g|png|webp|image|thumbnail|poster|cover", signal):
        return "image/jpeg"
    return ""


def _strong_player_config_url(key: str, raw_url: str, protocol_hint: str) -> bool:
    signal = f"{raw_url} {protocol_hint}".lower()
    if re.search(r"\.(?:m3u8?|mpd|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)", signal):
        return True
    if _protocol(raw_url, protocol_hint) in {"m3u8", "http_dash_segments"}:
        return True
    if re.search(r"googlevideo\.com/videoplayback|video\.twimg\.com|cdninstagram\.com|threadscdn\.com|jwpcdn\.com|jwplatform\.com|kaltura\.com|mux\.com|mux\.dev|akamaized\.net|cloudfront\.net|bilivideo\.com|weibocdn\.com|xhscdn\.com|vimeocdn\.com|fastly\.net/[^\"'\s]+\.(?:mp4|m3u8|mpd)|res\.cloudinary\.com|[^\"'\s]+\.b-cdn\.net|[^\"'\s]+\.bunnycdn\.com", raw_url, re.I):
        return True
    url_like = bool(re.match(r"^(?:https?:\\?/\\?/|//|/|\.{1,2}/)", raw_url, re.I))
    if not url_like:
        return False
    if not re.match(r"^(?:file|src|source|stream|stream_url|streamUrl|media_url|mediaUrl|video_url|videoUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|play_url|playUrl|download_url|downloadUrl|hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|mp4_url|mp4Url|flv_url|flvUrl|m3u8_url|m3u8Url|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|hd_src|hdSrc|sd_src|sdSrc|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl|contentUrl|contentURL)$", key, re.I):
        return False
    return bool(re.match(r"^(?:video|audio|image|application/(?:dash|vnd\.apple\.mpegurl|x-mpegurl))", protocol_hint, re.I))


def _scan_player_configs(html_text: str, page_url: str, entries: list[dict[str, Any]], seen: set[str], resolve_base: str = "") -> None:
    field_re = re.compile(
        r"['\"]?(?<![a-zA-Z0-9_])(file|src|source|stream|stream_url|streamUrl|media_url|mediaUrl|video_url|videoUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|play_url|playUrl|download_url|downloadUrl|hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|mp4_url|mp4Url|flv_url|flvUrl|m3u8_url|m3u8Url|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|hd_src|hdSrc|sd_src|sdSrc|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl|contentUrl|contentURL|image_url|imageUrl|thumbnail_url|thumbnailUrl|poster|cover|url)(?![a-zA-Z0-9_])['\"]?\s*:\s*['\"]([^'\"\\\s<>]{1,1000})['\"]",
        re.I,
    )
    for script in re.finditer(r"<script\b[^>]*>(.*?)</script>", html_text, re.I | re.S):
        # Skip pure JSON data blocks — handled by _scan_hydration_data with correct provenance.
        if re.search(r"type\s*=\s*['\"]application/(?:json|ld\+json|feed\+json)['\"]",
                     script.group(0)[:200], re.I):
            continue
        # text/x-player-data is the synthetic type used by _scan_json_data_attributes for
        # confirmed player config blobs (name_ok=True) — skip the content guard for these.
        is_confirmed_player_data = bool(re.search(
            r"type\s*=\s*['\"]text/x-player-data['\"]", script.group(0)[:200], re.I
        ))
        text = html.unescape(script.group(1))
        text = (
            text.replace("\\u002F", "/")
            .replace("\\u002f", "/")
            .replace("\\u0026", "&")
            .replace("\\/", "/")
        )
        if not is_confirmed_player_data and not re.search(
            r"jwplayer|videojs|brightcove|kaltura|bitmovin|flowplayer|clappr|wistia|vidyard|DPlayer|dplayer|Plyr|plyr|sources|playlist|hls|m3u8|dash|stream|video_url|audio_url|audioUrl|mp3_url|podcast_url|enclosure_url|episode_url|recording_url|live_url|liveUrl|media_url|manifest_url|playback_url|master_url|videoConfig|playerConfig|['\"]?file['\"]?\s*:|window\.\w+(?:Video|Player|Media|Config|Data|Setup)\b",
            text, re.I,
        ):
            continue
        for match in field_re.finditer(text):
            key = match.group(1)
            raw_url = match.group(2)
            nearby = f"{text[match.start(): min(len(text), match.start() + 260)]} {text[max(0, match.start() - 140): match.start()]}"
            protocol_hint = _player_protocol_hint(key, raw_url, nearby)
            if not _strong_player_config_url(key, raw_url, protocol_hint):
                continue
            _add(
                entries,
                seen,
                page_url,
                raw_url,
                "player-config",
                resolve_base=resolve_base,
                kind_hint=_resource_kind_hint(key, protocol_hint),
                protocol_hint=protocol_hint,
            )
            if len(entries) >= 80:
                return


def _walk_json_ld(value: Any, page_url: str, entries: list[dict[str, Any]], seen: set[str], inherited_kind: str = "", resolve_base: str = "") -> None:
    if isinstance(value, list):
        for item in value:
            _walk_json_ld(item, page_url, entries, seen, inherited_kind, resolve_base)
        return
    if not isinstance(value, dict):
        return
    raw_type = value.get("@type") or value.get("type") or ""
    type_text = " ".join(raw_type) if isinstance(raw_type, list) else safe_text(raw_type)
    type_text = type_text.lower()
    kind = (
        "video" if re.search(r"videoobject|movie|tvepisode|clip|broadcastevent|musicvideo(?:object)?|liveblogposting", type_text)
        else "audio" if re.search(r"audioobject|musicrecording|podcastepisode|radioepisode|musicrelease|audiobook", type_text)
        else "image" if re.search(r"imageobject|photograph", type_text)
        else inherited_kind
    )
    if kind:
        def _first_url(v: object) -> object:
            return (next((s for s in v if isinstance(s, str)), None) if isinstance(v, list) else v)
        raw_url = _first_url(value.get("contentUrl") or value.get("contentURL") or value.get("downloadUrl") or value.get("embedUrl") or (
            value.get("url") if kind != inherited_kind else None
        ))
        thumbnail = value.get("thumbnailUrl") or value.get("thumbnail") or ""
        if isinstance(thumbnail, list):
            thumbnail = thumbnail[0] if thumbnail else ""
        if isinstance(thumbnail, dict):
            thumbnail = thumbnail.get("url") or thumbnail.get("contentUrl") or ""
        _width = int(value["width"]) if isinstance(value.get("width"), (int, float)) else (
            int(value["width"]["value"]) if isinstance(value.get("width"), dict) and "value" in value["width"] else None
        )
        _height = int(value["height"]) if isinstance(value.get("height"), (int, float)) else (
            int(value["height"]["value"]) if isinstance(value.get("height"), dict) and "value" in value["height"] else None
        )
        _add(
            entries,
            seen,
            page_url,
            raw_url,
            "json-ld",
            resolve_base=resolve_base,
            kind_hint=kind,
            title=safe_text(value.get("name")),
            thumbnail=_clean_url(thumbnail, resolve_base or page_url),
            duration=_parse_iso_duration(value.get("duration")),
            width=_width,
            height=_height,
        )
    for key in ("@graph", "video", "audio", "image", "associatedMedia", "encoding", "encodings", "thumbnail",
                "hasPart", "mainEntity", "mediaObject", "subjectOf", "workExample",
                "itemListElement", "item",
                "items", "results", "data", "entries", "list", "tracks", "videos", "audios", "content", "clips"):
        if key in value:
            _walk_json_ld(value[key], page_url, entries, seen, kind, resolve_base)


def _is_hydration_script(tag_attrs: str, text: str) -> bool:
    return bool(
        re.search(
            r"\bid\s*=\s*['\"](?:__NEXT_DATA__|__NUXT_DATA__|__APOLLO_STATE__|__INITIAL_STATE__|__INITIAL_DATA__|app-data|__SVELTE__|__sveltekit_data|__astro_manifest__)['\"]",
            tag_attrs, re.I,
        )
        or re.search(r"\btype\s*=\s*['\"]application/(?:json|ld\+json)['\"]", tag_attrs, re.I)
        or re.search(
            r"(?:window\.)?(?:__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__INITIAL_DATA__|__APOLLO_STATE__|__remixContext|__ROUTER_DATA__|__PRELOADED_STATE__|__APP_STATE__|__STORE__|__REDUX_STATE__|__SERVER_DATA__|__SVELTE_DATA__|__MEDIA_DATA__|__VIDEO_DATA__|__VIDEO_CONFIG__|__PLAYER_CONFIG__|__MEDIA_CONFIG__|__APP_CONFIG__|__SITE_CONFIG__|__PAGE_CONFIG__|__PAGE_DATA__|__INITIAL_PROPS__|__BC_PLAYER_CONFIG__|initialState|initialData|pageData|siteData|videoData|playerData|videoConfig|playerConfig|mediaConfig|mediaData|appConfig|siteConfig|pageConfig|initialProps|wp_playlist|BCL)\s*[=:]",
            text, re.I,
        )
    )


def _hydration_protocol_hint(key: str, url: str, nearby: str = "") -> str:
    ext = guess_ext_from_url(url).lower()
    if ext == "mpd":
        return "application/dash+xml"
    if ext in {"ism", "isml"}:
        return "application/vnd.ms-sstr+xml"
    if ext in {"m3u", "m3u8"}:
        return "application/vnd.apple.mpegurl"
    if ext in {"mp4", "m4v", "mov"}:
        return "video/mp4"
    if ext == "webm":
        return "video/webm"
    if ext in AUDIO_EXTS:
        return "audio/mp4"
    if ext in IMAGE_EXTS:
        return "image/jpeg"
    if ext in _SUBTITLE_EXTS:
        return "text/vtt"
    if re.match(r"^(?:hls_url|hlsUrl|m3u8_url|m3u8Url|manifest_url|manifestUrl|master_url|masterUrl)$", key, re.I):
        return "application/vnd.apple.mpegurl"
    if re.match(r"^(?:dash_url|dashUrl|mpd_url|mpdUrl)$", key, re.I):
        return "application/dash+xml"
    if re.match(r"^(?:flv_url|flvUrl)$", key, re.I):
        return "video/x-flv"
    if re.match(r"^(?:audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl)$", key, re.I):
        return "audio/mpeg"
    if re.match(r"^(?:live_url|liveUrl|live_stream_url|liveStreamUrl)$", key, re.I):
        return "video/mp4"
    if re.match(r"^(?:mp4_url|mp4Url|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl|file_url|fileUrl)$", key, re.I):
        return "video/mp4"
    if re.match(r"^(?:subtitle_url|subtitleUrl|vtt_url|vttUrl|caption_url|captionUrl|track_url|trackUrl|transcript_url|transcriptUrl)$", key, re.I):
        return "text/vtt"
    if re.match(r"^(?:srt_url|srtUrl)$", key, re.I):
        return "application/x-subrip"
    signal = f"{key} {url} {nearby}".lower()
    if re.search(r"dash|mpd|application/dash\+xml", signal):
        return "application/dash+xml"
    if re.search(r"hls|m3u8|mpegurl|manifest|application/vnd\.apple\.mpegurl|application/x-mpegurl", signal):
        return "application/vnd.apple.mpegurl"
    if re.search(r"audio|m4a|aac|mp3|audio/", signal):
        return "audio/mp4"
    if re.search(r"video|mp4|webm|browser_native_hd_url|hd_src|sd_src|playable_url", signal):
        return "video/mp4"
    if re.search(r"image|photo|thumbnail|cover|poster|jpe?g|png|webp", signal):
        return "image/jpeg"
    return ""


def _hydration_kind_hint(key: str, protocol_hint: str) -> str:
    signal = f"{key} {protocol_hint}".lower()
    if re.search(r"image|photo|thumbnail|cover|poster", signal):
        return "image"
    if "audio" in signal:
        return "audio"
    return "video"


def _strong_hydration_url(key: str, raw_url: str, protocol_hint: str) -> bool:
    ext = guess_ext_from_url(raw_url).lower()
    if ext in IMAGE_EXTS or ext in AUDIO_EXTS or ext in {"m3u", "m3u8", "mpd", "ism", "isml", "mp4", "m4v", "webm", "mov", "avi", "mkv", "flv", "mpg", "mpeg", "3gp"}:
        return True
    url_like = bool(re.match(r"^(?:https?:\\?/\\?/|//|/|\.{1,2}/)", raw_url, re.I))
    if re.match(r"^(?:hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|m3u8_url|m3u8Url|mp4_url|mp4Url|flv_url|flvUrl|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|video_url|videoUrl|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|browser_native_hd_url|browserNativeHdUrl|hd_src|hdSrc|sd_src|sdSrc|stream_url|streamUrl|media_url|mediaUrl|contentUrl|contentURL|download_url|downloadUrl|play_url|playUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl)$", key, re.I):
        return url_like and bool(re.match(r"^(?:video|audio|application/(?:dash|vnd\.apple\.mpegurl|x-mpegurl|vnd\.ms-sstr\+xml))", protocol_hint, re.I))
    if re.match(r"^(?:image_url|imageUrl|photo_url|photoUrl|thumbnail_url|thumbnailUrl|cover_url|coverUrl|poster|original_url|originalUrl|src_url|srcUrl)$", key, re.I):
        return url_like and bool(re.match(r"^image/", protocol_hint, re.I))
    if re.match(r"^(?:subtitle_url|subtitleUrl|vtt_url|vttUrl|srt_url|srtUrl|caption_url|captionUrl|track_url|trackUrl|transcript_url|transcriptUrl)$", key, re.I):
        return url_like and (
            bool(re.match(r"^(?:text/vtt|application/x-subrip|text/plain)$", protocol_hint, re.I))
            or bool(re.search(r"\.(?:vtt|webvtt|srt|ass|ssa|sub|sbv|dfxp|ttml)(?:[?#]|$)", raw_url, re.I))
        )
    return False


def _scan_hydration_data(html_text: str, page_url: str, entries: list[dict[str, Any]], seen: set[str], resolve_base: str = "") -> None:
    field_re = re.compile(
        r"['\"]?(hls_url|hlsUrl|dash_url|dashUrl|mpd_url|mpdUrl|m3u8_url|m3u8Url|mp4_url|mp4Url|flv_url|flvUrl|manifest_url|manifestUrl|master_url|masterUrl|playback_url|playbackUrl|audio_url|audioUrl|mp3_url|mp3Url|audio_file_url|audioFileUrl|podcast_url|podcastUrl|enclosure_url|enclosureUrl|file_url|fileUrl|video_url|videoUrl|live_url|liveUrl|live_stream_url|liveStreamUrl|playable_url|playableUrl|browser_native_hd_url|browserNativeHdUrl|hd_src|hdSrc|sd_src|sdSrc|stream_url|streamUrl|media_url|mediaUrl|contentUrl|contentURL|download_url|downloadUrl|play_url|playUrl|source_url|sourceUrl|episode_url|episodeUrl|clip_url|clipUrl|recording_url|recordingUrl|image_url|imageUrl|photo_url|photoUrl|thumbnail_url|thumbnailUrl|cover_url|coverUrl|poster|original_url|originalUrl|src_url|srcUrl|subtitle_url|subtitleUrl|vtt_url|vttUrl|srt_url|srtUrl|caption_url|captionUrl|track_url|trackUrl|transcript_url|transcriptUrl)['\"]?\s*:\s*['\"]([^'\"\\\s<>]{1,1000})['\"]",
        re.I,
    )
    for script in re.finditer(r"<script\b([^>]*)>(.*?)</script>", html_text, re.I | re.S):
        text = html.unescape(script.group(2))
        text = (
            text.replace("\\u002F", "/")
            .replace("\\u002f", "/")
            .replace("\\u0026", "&")
            .replace("\\u003d", "=")
            .replace("\\/", "/")
        )
        if not _is_hydration_script(script.group(1), text):
            continue
        for match in field_re.finditer(text):
            key = match.group(1)
            raw_url = match.group(2)
            nearby = text[max(0, match.start() - 200): min(len(text), match.end() + 320)]
            protocol_hint = _hydration_protocol_hint(key, raw_url, nearby)
            if not _strong_hydration_url(key, raw_url, protocol_hint):
                continue
            _add(
                entries,
                seen,
                page_url,
                raw_url,
                "hydration-data",
                resolve_base=resolve_base,
                kind_hint=_hydration_kind_hint(key, protocol_hint),
                protocol_hint=protocol_hint,
            )
            if len(entries) >= 80:
                return


_FEED_MIME_TO_EXT: dict[str, str] = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/x-mp3": "mp3",
    "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a",
    "audio/ogg": "ogg", "audio/vorbis": "ogg", "audio/opus": "opus",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "video/ogg": "ogv",
}


def extract_universal_from_json_feed(page_url: str, feed_json: str) -> dict[str, Any] | None:
    """Extract media from JSON Feed 1.0/1.1 (https://jsonfeed.org/)."""
    try:
        data = json.loads(feed_json)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    version = safe_text(data.get("version", ""))
    if "jsonfeed.org" not in version and "items" not in data:
        return None
    items = data.get("items")
    if not isinstance(items, list):
        return None

    feed_title = safe_text(data.get("title", "")) or "Feed"
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add_att(url_raw: str, mime: str, title: str) -> None:
        url = _clean_url(url_raw, page_url)
        if not url or url in seen:
            return
        mime_lower = mime.lower()
        is_av = mime_lower.startswith(("audio/", "video/"))
        has_ext = re.search(r"\.(mp3|m4a|ogg|opus|flac|wav|mp4|webm|mov)(?:[?#]|$)", url, re.I)
        if not is_av and not has_ext:
            return
        seen.add(url)
        ext = _FEED_MIME_TO_EXT.get(mime_lower) or guess_ext_from_url(url).lower() or (
            "m4a" if mime_lower.startswith("audio/") else "mp4"
        )
        entries.append({
            "id": cache_key(url),
            "title": title or feed_title,
            "url": url,
            "webpage_url": page_url,
            "ext": ext,
            "protocol": "https",
            "extractor": "universal-feed",
            "_universal_confidence": 0.88,
            "thumbnail": None,
        })

    for item in items:
        if not isinstance(item, dict):
            continue
        title = safe_text(item.get("title", "") or item.get("id", ""))
        for att in item.get("attachments") or []:
            if not isinstance(att, dict):
                continue
            _add_att(safe_text(att.get("url", "")), safe_text(att.get("mime_type", "")), title)
        # Some JSON Feeds link to external media pages via external_url
        # (e.g. a YouTube video or podcast episode page) rather than using
        # attachments.  Pass it as a plain URL; the caller's pipeline will
        # run further extraction on it if needed.
        ext_url = safe_text(item.get("external_url") or item.get("url") or "")
        if ext_url and not any(e.get("webpage_url") == ext_url for e in entries):
            _add_att(ext_url, "", title)
        if len(entries) >= 100:
            break

    if not entries:
        return None
    if len(entries) == 1:
        return entries[0]
    return {
        "_type": "playlist",
        "title": feed_title,
        "webpage_url": page_url,
        "extractor": "universal-feed",
        "entries": entries[:50],
    }


def extract_universal_from_feed(page_url: str, feed_xml: str) -> dict[str, Any] | None:
    """Extract media entries from RSS 2.0 / Atom 1.0 / podcast feeds."""
    text = safe_text(feed_xml)[:2_000_000]
    if not re.search(r"<(?:rss|feed|rdf:RDF)\b", text, re.I):
        return None

    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _cdata(raw: str) -> str:
        m = re.match(r"<!\[CDATA\[(.*?)]]>", raw.strip(), re.S)
        return html.unescape((m.group(1) if m else raw).strip())

    def _tag(block: str, tag: str) -> str:
        m = re.search(rf"<{re.escape(tag)}\b[^>]*>(.*?)</{re.escape(tag)}>", block, re.I | re.S)
        return _cdata(m.group(1)) if m else ""

    def _add(url_raw: str, mime: str, title: str, thumb: str) -> None:
        url = _clean_url(url_raw, page_url)
        if not url or url in seen:
            return
        mime_lower = mime.lower()
        is_av = mime_lower.startswith(("audio/", "video/"))
        has_ext = re.search(r"\.(mp3|m4a|ogg|opus|flac|wav|mp4|webm|mov|ogv)(?:[?#]|$)", url, re.I)
        if not is_av and not has_ext:
            return
        seen.add(url)
        ext = _FEED_MIME_TO_EXT.get(mime_lower) or guess_ext_from_url(url).lower() or (
            "m4a" if mime_lower.startswith("audio/") else "mp4"
        )
        thumb_url = _clean_url(thumb, page_url) or None
        entries.append({
            "id": cache_key(url),
            "title": title or "Feed episode",
            "url": url,
            "webpage_url": page_url,
            "ext": ext,
            "protocol": "https",
            "extractor": "universal-feed",
            "_universal_confidence": 0.88,
            "thumbnail": thumb_url,
        })

    # RSS 2.0 / podcast: <item> blocks
    for item_m in re.finditer(r"<item\b[^>]*>(.*?)</item>", text, re.I | re.S):
        block = item_m.group(1)
        title = _tag(block, "title")
        thumb = ""
        itunes_img = re.search(r"<itunes:image\b[^>]*/?>", block, re.I)
        if itunes_img:
            thumb = _meta_attrs(itunes_img.group(0)).get("href", "")
        if not thumb:
            media_thumb = re.search(r"<media:thumbnail\b[^>]*/?>", block, re.I)
            if media_thumb:
                thumb = _meta_attrs(media_thumb.group(0)).get("url", "")

        enc = re.search(r"<enclosure\b[^>]*/?>", block, re.I)
        if enc:
            a = _meta_attrs(enc.group(0))
            _add(a.get("url", ""), a.get("type", ""), title, thumb)
        # <media:content> at item level OR inside <media:group>
        _mc_search_block = block
        mg = re.search(r"<media:group\b[^>]*>(.*?)</media:group>", block, re.I | re.S)
        if mg:
            _mc_search_block = mg.group(1)
        for mc in re.finditer(r"<media:content\b[^>]*/?>", _mc_search_block, re.I):
            a = _meta_attrs(mc.group(0))
            if a.get("medium", "") in {"audio", "video"} or a.get("type", "").startswith(("audio/", "video/")):
                _add(a.get("url", ""), a.get("type", ""), title, thumb)

        if len(entries) >= 100:
            break

    # Atom 1.0: <entry> blocks
    if not entries:
        for entry_m in re.finditer(r"<entry\b[^>]*>(.*?)</entry>", text, re.I | re.S):
            block = entry_m.group(1)
            title = _tag(block, "title")
            # <link rel="enclosure"> is the standard Atom media attachment
            for link_m in re.finditer(r"<link\b[^>]*/?>", block, re.I):
                a = _meta_attrs(link_m.group(0))
                if a.get("rel", "").lower() == "enclosure":
                    _add(a.get("href", ""), a.get("type", ""), title, "")
            # <content type="video/..." src="..."> used by some Atom video feeds
            for cnt_m in re.finditer(r"<content\b[^>]*>", block, re.I):
                a = _meta_attrs(cnt_m.group(0))
                mime = a.get("type", "")
                src = a.get("src", "")
                if src and mime.startswith(("audio/", "video/")):
                    _add(src, mime, title, "")
            if len(entries) >= 100:
                break

    if not entries:
        return None

    feed_title = _tag(text, "title") or "Feed"

    # Channel-level thumbnail as fallback for items that have none.
    _channel_thumb = ""
    _itunes_ch = re.search(r"<itunes:image\b[^>]*/?>", text, re.I)
    if _itunes_ch:
        _channel_thumb = _meta_attrs(_itunes_ch.group(0)).get("href", "")
    if not _channel_thumb:
        _img_block = re.search(r"<image\b[^>]*>(.*?)</image>", text, re.I | re.S)
        if _img_block:
            _channel_thumb = _tag(_img_block.group(1), "url")
    if _channel_thumb:
        _channel_thumb_url = _clean_url(_channel_thumb, page_url) or ""
        for entry in entries:
            if not entry.get("thumbnail"):
                entry["thumbnail"] = _channel_thumb_url

    if len(entries) == 1:
        entries[0]["title"] = entries[0].get("title") or feed_title
        return entries[0]
    return {
        "_type": "playlist",
        "title": feed_title,
        "webpage_url": page_url,
        "extractor": "universal-feed",
        "entries": entries[:50],
    }


_TITLE_KEYS = ("title", "name", "video_title", "videoTitle", "video_name", "videoName",
               "headline", "display_name", "displayName", "subject", "label")


def _extract_json_title(data: Any) -> str:
    """Extract a human-readable title from a JSON object.

    Checks the top level first, then one level deep under common wrapper keys
    (data, video, result, item, content, media) to handle APIs that return
    ``{"data": {"title": "...", "hls_url": "..."}}``.
    """
    if isinstance(data, list) and data and isinstance(data[0], dict):
        data = data[0]
    if not isinstance(data, dict):
        return ""
    for key in _TITLE_KEYS:
        val = data.get(key)
        if isinstance(val, str) and val.strip() and len(val.strip()) <= 200:
            return val.strip()
    for wrapper in ("data", "video", "result", "item", "content", "media", "article"):
        nested = data.get(wrapper)
        if isinstance(nested, dict):
            for key in _TITLE_KEYS:
                val = nested.get(key)
                if isinstance(val, str) and val.strip() and len(val.strip()) <= 200:
                    return val.strip()
    return ""


def extract_universal_from_json_api(page_url: str, json_text: str) -> dict[str, Any] | None:
    """Extract media URLs from a bare JSON API response body.

    Wraps the JSON in a synthetic hydration script tag and runs the hydration
    and player-config scanners on it. Catches custom video platforms that
    return hls_url / video_url / playback_url / manifest_url etc. in their
    JSON responses without a JSON Feed envelope.
    """
    stripped = safe_text(json_text).strip()
    if not stripped or stripped[0] not in ("{", "["):
        return None
    try:
        parsed = json.loads(stripped)
    except Exception:
        return None
    if not isinstance(parsed, (dict, list)):
        return None
    fake_html = f'<script type="application/json" id="__INITIAL_STATE__">{json_text}</script>'
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    _scan_hydration_data(fake_html, page_url, entries, seen)
    _scan_player_configs(fake_html, page_url, entries, seen)
    _walk_json_ld(parsed, page_url, entries, seen)
    if not entries:
        return None
    entries.sort(key=lambda item: (
        0 if _media_kind(item.get("url", "")) == "video"
        else 1 if _media_kind(item.get("url", "")) == "audio"
        else 2,
        -float(item.get("_universal_confidence") or 0),
        0 if item.get("protocol") in {"m3u8", "http_dash_segments"} else 1,
    ))
    json_title = _extract_json_title(parsed)
    if len(entries) == 1:
        if json_title and entries[0].get("title") in {"", "Universal media", None}:
            entries[0] = {**entries[0], "title": json_title}
        return entries[0]
    return {
        "_type": "playlist",
        "title": json_title or "Universal media",
        "webpage_url": page_url,
        "extractor": "universal-json-api",
        "entries": entries[:20],
    }


_QUALITY_HINT_RE = re.compile(
    r"[/_\-](\d{3,4})[pP](?:[/_.\-?&#]|$)|[?&](?:quality|resolution|height)=(\d{3,4})",
    re.I,
)


def _quality_hint_from_url(url: str) -> int | None:
    m = _QUALITY_HINT_RE.search(url)
    if m:
        return int(m.group(1) or m.group(2))
    return None


def reorder_by_preferred_quality(info: dict[str, Any], preferred: str) -> dict[str, Any]:
    """Reorder playlist entries so the closest quality to `preferred` comes first.

    `preferred` can be "720", "720p", "1080", "best", or "worst".
    Only acts when at least one entry has a detectable quality hint in its URL.
    Entries without hints sort to the end in original order.
    """
    if not info or info.get("_type") != "playlist":
        return info
    pref = (preferred or "").lower().strip()
    entries = list(info.get("entries") or [])
    scored = [(_quality_hint_from_url(e.get("url", "")), i, e) for i, e in enumerate(entries)]
    if not any(q is not None for q, _, _ in scored):
        return info
    if pref in {"best", "highest", "max"}:
        def sort_key(t: tuple) -> tuple:
            q, idx, _ = t
            return (-(q or 0), idx)
    elif pref in {"worst", "lowest", "min"}:
        def sort_key(t: tuple) -> tuple:
            q, idx, _ = t
            return (q if q is not None else 9999, idx)
    else:
        target_m = re.search(r"\d+", pref)
        if not target_m:
            return info
        target_p = int(target_m.group(0))
        def sort_key(t: tuple) -> tuple:
            q, idx, _ = t
            return (abs((q or 0) - target_p), idx)
    info = dict(info)
    info["entries"] = [e for _, _, e in sorted(scored, key=sort_key)]
    return info


def scan_meta_refresh_url(page_url: str, html_text: str) -> str | None:
    """Return the redirect URL from a <meta http-equiv="refresh"> tag, or None.

    Handles both `content="0;url=https://..."` and `content="0; URL='...'"`
    formats. Returns None when the resolved URL equals the current page URL
    (self-referential refresh with a delay).
    """
    for match in re.finditer(r"<meta\b[^>]*>", html_text[:200_000], re.I):
        attrs = _meta_attrs(match.group(0))
        if attrs.get("http-equiv", "").lower() != "refresh":
            continue
        content = attrs.get("content", "")
        url_m = re.search(r"(?:^|;)\s*url\s*=\s*['\"]?([^'\">\s]+)", content, re.I)
        if not url_m:
            continue
        url = _clean_url(url_m.group(1).strip("'\""), page_url)
        if url and url != page_url:
            return url
    return None


_KNOWN_PLAYER_HOST_RE = re.compile(
    r"^(?:"
    # Video platforms
    r"(?:www\.)?youtube\.com/embed/"
    r"|youtu\.be/"
    r"|player\.vimeo\.com/video/"
    r"|(?:www\.)?dailymotion\.com/embed/video/"
    r"|dai\.ly/"
    r"|players\.brightcove\.net/"
    r"|cdn\.jwplayer\.com/players/"
    r"|fast\.wistia\.(?:net|com)/embed/"
    r"|wistia\.(?:net|com)/embed/"
    r"|(?:www\.)?bandcamp\.com/EmbeddedPlayer/"
    r"|(?:www\.)?instagram\.com/(?:p|reel|tv)/[A-Za-z0-9_-]+/embed/"
    r"|platform\.(?:twitter|x)\.com/embed/"
    r"|app\.vidcast\.io/share/embed/"
    r"|iframe\.mediadelivery\.net/embed/"
    r"|iframe\.bunny\.net/embed/"
    r"|iframe\.cloudflarestream\.com/[a-f0-9]"
    r"|(?:[^/]+\.)?cloudflarestream\.com/[a-f0-9]+/iframe"
    r"|streamable\.com/[eos]/"
    r"|rumble\.com/embed/"
    r"|odysee\.com/\$/embed/"
    r"|player\.twitch\.tv/"
    r"|clips\.twitch\.tv/embed"
    r"|open\.spotify\.com/embed/(?:episode|track|show|playlist)/"
    r"|videopress\.com/(?:v|embed)/"
    r"|(?:www\.)?loom\.com/embed/"
    r"|embed\.vidyard\.com/"
    r"|play\.vidyard\.com/[0-9a-zA-Z\-]{8,}(?:\.html)?"
    r"|(?:www\.)?bitchute\.com/embed/[A-Za-z0-9]+"
    r"|(?:[^/]+\.)?kaltura\.com/.*(?:embed|player)"
    r"|(?:[^/]+\.)?panopto\.(?:com|eu)/Panopto/"
    r"|embed\.kumu\.io/"
    r"|embed\.ted\.com/(?:talks|playlists)/"
    r"|(?:www\.)?facebook\.com/plugins/video\.php"
    r"|(?:www\.)?facebook\.com/video/embed"
    r"|videos\.sproutvideo\.com/embed/"
    r"|content\.jwplatform\.com/players/"
    # Podcast / audio players
    r"|w\.soundcloud\.com/player/"
    r"|widget\.spreaker\.com/player"
    r"|(?:www\.)?podbean\.com/player"
    r"|player\.simplecast\.com/"
    r"|share\.transistor\.fm/"
    r"|embed\.acast\.com/"
    r"|embed\.megaphone\.fm/"
    # Short-form / social video
    r"|(?:www\.)?tiktok\.com/embed/"
    r"|vm\.tiktok\.com/"
    r"|odysee\.com/\$/embed/"
    r"|(?:www\.)?youtube(?:-nocookie)?\.com/embed/"
    # PeerTube federated instances: any host with /videos/embed/<UUID>
    r"|[^/]+/videos/embed/[0-9a-f]{8}-[0-9a-f]{4}-"
    # Kick.com live streams
    r"|player\.kick\.com/"
    # Podcast hosting
    r"|anchor\.fm/[^/]+/embed/episodes/"
    r"|www\.buzzsprout\.com/[^/]+/player"
    r"|player\.captivate\.fm/"
    # Business / screen recording
    r"|share\.descript\.com/embed/"
    r")",
    re.I,
)


_JSON_EMBED_URL_RE = re.compile(
    r"""[\"']?(?:embedUrl|embedURL|embed_url|playerUrl|player_url|iframeUrl|iframe_url)[\"']?\s*:\s*[\"']([^\"'\s<>]+)[\"']""",
    re.I,
)


def scan_iframe_embed_urls(page_url: str, html_text: str) -> list[str]:
    """Return known-player embed URLs found in <iframe> tags or script embed-URL fields.

    Also scans <script> block content for JSON-LD VideoObject.embedUrl and
    similar key-value patterns so that structured-data embed references are
    caught even when no <iframe> is present on the page.

    Expands <noscript> blocks so that fallback iframes hidden from JS-capable
    browsers are still detected.
    """
    # Expand <noscript> so fallback iframes are visible to the scanner.
    _noscript_expanded = re.sub(
        r"<noscript\b[^>]*>(.*?)</noscript>",
        lambda m: html.unescape(m.group(1)),
        html_text[:1_000_000],
        flags=re.I | re.S,
    )
    if _noscript_expanded != html_text:
        html_text = html_text + "\n" + _noscript_expanded

    found: list[str] = []
    seen: set[str] = set()

    def _try_add(raw: str | None) -> bool:
        if not raw or len(found) >= 10:
            return False
        url = _clean_url(raw, page_url)
        if not url or url in seen:
            return False
        try:
            parsed = urllib.parse.urlparse(url)
            netloc = parsed.netloc.lower()
            if netloc.startswith("www."):
                netloc = netloc[4:]
            if _KNOWN_PLAYER_HOST_RE.match(netloc + parsed.path):
                seen.add(url)
                found.append(url)
                return True
        except Exception:
            pass
        return False

    def _vimeo_player_url(raw: str | None) -> str | None:
        if not raw:
            return None
        value = html.unescape(str(raw)).strip()
        if not value:
            return None
        if re.match(r"^\d+$", value):
            return f"https://player.vimeo.com/video/{value}"
        url = _clean_url(value.replace("\\u0026", "&").replace("\\u003d", "=").replace("\\/", "/"), page_url)
        if not url:
            return None
        try:
            parsed = urllib.parse.urlparse(url)
            host = parsed.netloc.lower()
            if host == "player.vimeo.com":
                m = re.match(r"^/video/(\d+)(?:/|$)", parsed.path, re.I)
                if not m:
                    return None
                return urllib.parse.urlunparse(parsed._replace(path=f"/video/{m.group(1)}", fragment=""))
            if host not in {"vimeo.com", "www.vimeo.com"}:
                return None
            segments = [seg for seg in parsed.path.split("/") if seg]
            id_index = next((i for i in range(len(segments) - 1, -1, -1) if re.match(r"^\d+$", segments[i])), -1)
            if id_index < 0:
                return None
            query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            if (
                id_index == 0
                and len(segments) == 2
                and re.match(r"^[a-z0-9]+$", segments[1], re.I)
                and not any(k == "h" for k, _ in query)
            ):
                query.append(("h", segments[1]))
            return urllib.parse.urlunparse((
                "https",
                "player.vimeo.com",
                f"/video/{segments[id_index]}",
                "",
                urllib.parse.urlencode(query),
                "",
            ))
        except Exception:
            return None

    for match in re.finditer(r"<(?:iframe|object|embed)\b[^>]*>", html_text, re.I):
        attrs = _meta_attrs(match.group(0))
        # Try each candidate in order; stop at the first one accepted as a known player.
        # <object data="..."> uses `data`; <iframe>/<embed> use `src`.
        # GDPR/CMP consent-deferred iframes store the real embed URL in data-*-src attributes
        # while keeping src="about:blank" until the user accepts cookies.
        for _raw_src in (
            attrs.get("src"),
            attrs.get("data-src"),
            attrs.get("data-lazy-src"),
            attrs.get("data-consent-src"),
            attrs.get("data-cmp-src"),
            attrs.get("data-cookieconsent-src"),
            attrs.get("data-delayed-src"),
            attrs.get("data"),
        ):
            if _try_add(_raw_src):
                break
        # <iframe srcdoc="..."> embeds inline HTML; recurse into it for player URLs.
        srcdoc = attrs.get("srcdoc")
        if srcdoc:
            inner = html.unescape(srcdoc)
            for _inner_match in re.finditer(r"<(?:iframe|object|embed|video|audio|source)\b[^>]*>", inner, re.I):
                _inner_attrs = _meta_attrs(_inner_match.group(0))
                for _raw_src in (_inner_attrs.get("src"), _inner_attrs.get("data-src"), _inner_attrs.get("data")):
                    if _try_add(_raw_src):
                        break

    for script_match in re.finditer(r"<script\b[^>]*>(.*?)</script>", html_text, re.I | re.S):
        for m in _JSON_EMBED_URL_RE.finditer(script_match.group(1)):
            _try_add(m.group(1).replace("\\u0026", "&").replace("\\/", "/"))
            if len(found) >= 10:
                break

    # og:video / twitter:player meta tags often point to YouTube/Vimeo embed
    # URLs rather than direct streams. _entry() drops them (no extension, no
    # known CDN), but the iframe extractor can handle them.
    for meta_match in re.finditer(r"<meta\b[^>]*>", html_text, re.I):
        meta_a = _meta_attrs(meta_match.group(0))
        prop = meta_a.get("property", "") or meta_a.get("name", "")
        if not re.match(r"^(?:og:video(?::(?:url|secure_url))?|twitter:player)$", prop, re.I):
            continue
        _try_add(meta_a.get("content"))

    # AMP pages: <amp-video-iframe src="..."> wraps any known player iframe
    for avif_match in re.finditer(r"<amp-video-iframe\b[^>]*>", html_text, re.I):
        avif_attrs = _meta_attrs(avif_match.group(0))
        _try_add(avif_attrs.get("src"))

    # AMP pages replace <iframe> with custom elements such as <amp-youtube>,
    # <amp-vimeo>, <amp-brightcove>, etc.  Reconstruct the canonical embed URL
    # so the normal extraction pipeline can handle them.
    for amp_match in re.finditer(r"<(amp-youtube|amp-vimeo|amp-brightcove|amp-dailymotion|amp-soundcloud|amp-jwplayer)\b[^>]*>", html_text, re.I):
        amp_tag = amp_match.group(0)
        amp_component = amp_match.group(1).lower()
        amp_attrs = _meta_attrs(amp_tag)
        embed_url: str | None = None
        if amp_component == "amp-youtube":
            vid = amp_attrs.get("data-videoid")
            if vid:
                embed_url = f"https://www.youtube.com/embed/{vid}"
        elif amp_component == "amp-vimeo":
            vid = amp_attrs.get("data-videoid")
            if vid:
                embed_url = f"https://player.vimeo.com/video/{vid}"
        elif amp_component == "amp-brightcove":
            acct = amp_attrs.get("data-account")
            vid = amp_attrs.get("data-video-id") or amp_attrs.get("data-videoid")
            if acct and vid:
                embed_url = f"https://players.brightcove.net/{acct}/default_default/index.html?videoId={vid}"
        elif amp_component == "amp-dailymotion":
            vid = amp_attrs.get("data-videoid")
            if vid:
                embed_url = f"https://www.dailymotion.com/embed/video/{vid}"
        elif amp_component == "amp-soundcloud":
            tid = amp_attrs.get("data-trackid")
            if tid:
                embed_url = f"https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/{tid}"
        elif amp_component == "amp-jwplayer":
            media_id = amp_attrs.get("data-media-id") or amp_attrs.get("data-playlist-id")
            player_id = amp_attrs.get("data-player-id")
            if media_id and player_id:
                embed_url = f"https://content.jwplatform.com/players/{media_id}-{player_id}.html"
        if embed_url:
            _try_add(embed_url)

    # Wistia div-based embeds: <div class="wistia_embed wistia_async_[ID]">
    # (no <iframe> — the Wistia script dynamically creates the player)
    for wistia_match in re.finditer(r'class\s*=\s*["\'][^"\']*\bwistia_async_([a-z0-9]+)\b[^"\']*["\']', html_text, re.I):
        video_id = wistia_match.group(1)
        _try_add(f"https://fast.wistia.com/embed/iframe/{video_id}")
    # <wistia-player media-id="ID"> custom element (Wistia v2 embed)
    for wistia_match in re.finditer(r'<wistia-player\b[^>]*\bmedia-id\s*=\s*["\']([a-z0-9]+)["\'][^>]*>', html_text, re.I):
        video_id = wistia_match.group(1)
        _try_add(f"https://fast.wistia.com/embed/iframe/{video_id}")

    # Brightcove native Video.js div embeds:
    # <video-js data-account="X" data-video-id="Y"> or <video class="video-js" data-account="X" data-video-id="Y">
    for bc_match in re.finditer(r"<(?:video-js|video|div)\b([^>]*)>", html_text, re.I):
        attrs_str = bc_match.group(1)
        bc_attrs = _meta_attrs(f"<x {attrs_str}>")
        account = bc_attrs.get("data-account", "")
        video_id = bc_attrs.get("data-video-id") or bc_attrs.get("data-videoid", "")
        if not account or not video_id:
            continue
        player = bc_attrs.get("data-player", "default")
        embed = bc_attrs.get("data-embed", "default")
        embed_url = f"https://players.brightcove.net/{account}/{player}_{embed}/index.html?videoId={urllib.parse.quote(video_id)}"
        _try_add(embed_url)

    # Vidyard div-based embeds: <div class="vidyard-player-container" data-uuid="UUID">
    # Modern Vidyard uses a div+script instead of <iframe>.
    for vy_match in re.finditer(r'class\s*=\s*["\'][^"\']*\bvidyard-player[^"\']*["\'][^>]*>', html_text, re.I):
        vy_attrs = _meta_attrs(f"<x {vy_match.group(0)}>")
        uuid = vy_attrs.get("data-uuid", "")
        if uuid and re.match(r"^[0-9a-zA-Z\-]{8,}$", uuid):
            _try_add(f"https://play.vidyard.com/{uuid}")
    # Also catch thumbnail img src: <img src="https://play.vidyard.com/UUID.jpg">
    for vy_img in re.finditer(r"https?://play\.vidyard\.com/([0-9a-zA-Z\-]{8,})\.(?:jpg|png|gif)", html_text, re.I):
        _try_add(f"https://play.vidyard.com/{vy_img.group(1)}")

    # Cloudflare Stream <stream src="VIDEO_ID"> custom element
    # (Renders as an iframe; we reconstruct the canonical iframe embed URL)
    for cf_match in re.finditer(r"<stream\b[^>]*>", html_text, re.I):
        cf_attrs = _meta_attrs(cf_match.group(0))
        video_id = cf_attrs.get("src", "")
        if video_id and re.match(r"^[a-f0-9]{32}$", video_id, re.I):
            _try_add(f"https://iframe.cloudflarestream.com/{video_id}")

    # Generic <div|section|figure|article> with data-src/data-url/data-embed pointing
    # to a known player host (SproutVideo, generic CMS widgets, etc.)
    for div_m in re.finditer(
        r"<(?:div|section|figure|article)\b[^>]*\sdata-(?:src|url|embed(?:-src)?)\s*=\s*[\"']([^\"']+)[\"'][^>]*>",
        html_text,
        re.I,
    ):
        _try_add(div_m.group(1))

    # Vimeo Player SDK auto-embeds: data-vimeo-url/data-vimeo-id on any element.
    for vimeo_m in re.finditer(
        r"<[a-zA-Z][^>]*\sdata-vimeo-(?:id|url)\s*=\s*[\"'][^\"']+[\"'][^>]*>",
        html_text,
        re.I,
    ):
        vimeo_attrs = _meta_attrs(vimeo_m.group(0))
        _try_add(_vimeo_player_url(vimeo_attrs.get("data-vimeo-url") or vimeo_attrs.get("data-vimeo-id")))

    # Vimeo Player SDK programmatic embeds: new Vimeo.Player(el, { id/url }).
    for script_match in re.finditer(r"<script\b[^>]*>(.*?)</script>", html_text, re.I | re.S):
        script_text = html.unescape(script_match.group(1)).replace("\\u002F", "/").replace("\\u0026", "&").replace("\\u003d", "=").replace("\\/", "/")
        if not re.search(r"Vimeo\.Player|player\.vimeo\.com|vimeo\.com/", script_text, re.I):
            continue
        for option_m in re.finditer(r"""["']?(id|url)["']?\s*:\s*(?:"([^"]+)"|'([^']+)'|(\d{4,}))""", script_text, re.I):
            key = option_m.group(1).lower()
            value = option_m.group(2) or option_m.group(3) or option_m.group(4) or ""
            if key == "url" and not re.search(r"vimeo\.com/", value, re.I):
                continue
            _try_add(_vimeo_player_url(value))

    # data-vimeo-id / data-youtube-id / data-yt-id / data-dailymotion-id on any element
    for id_m in re.finditer(
        r"<[a-zA-Z][^>]*\sdata-(vimeo-id|youtube-id|yt-id|dailymotion-id|dm-id|dm-video-id)\s*=\s*[\"']([^\"']+)[\"'][^>]*>",
        html_text,
        re.I,
    ):
        attr_name = id_m.group(1).lower()
        id_val = id_m.group(2).strip()
        if not id_val:
            continue
        if "vimeo" in attr_name:
            _try_add(f"https://player.vimeo.com/video/{id_val}")
        elif "youtube" in attr_name or attr_name == "yt-id":
            _try_add(f"https://www.youtube.com/embed/{id_val}")
        elif "dailymotion" in attr_name or attr_name.startswith("dm-"):
            _try_add(f"https://www.dailymotion.com/embed/video/{id_val}")

    return found


def scan_feed_link_from_header(page_url: str, link_header: str) -> str | None:
    """Parse the HTTP Link: response header and return a feed URL if present.

    Podcast hosts (e.g. Buzzsprout, Captivate) sometimes advertise their RSS
    feed only via Link: <url>; rel="alternate"; type="application/rss+xml"
    without including any <link> tag in the page HTML.
    """
    for segment in link_header.split(","):
        segment = segment.strip()
        url_m = re.match(r"<([^>]+)>", segment)
        if not url_m:
            continue
        raw_url = url_m.group(1).strip()
        params = segment[url_m.end():]
        rel_m = re.search(r';\s*rel\s*=\s*["\']?([^"\';\s]+)', params, re.I)
        type_m = re.search(r';\s*type\s*=\s*["\']?([^"\';\s]+)', params, re.I)
        rel = rel_m.group(1).lower() if rel_m else ""
        mime = type_m.group(1).lower() if type_m else ""
        if "alternate" in rel and re.search(r"rss|atom|feed|xml", mime):
            url = _clean_url(raw_url, page_url)
            if url:
                return url
    return None


def scan_canonical_url(page_url: str, html_text: str) -> str | None:
    """Return the canonical URL if <link rel="canonical"> differs from page_url.

    Useful for AMP pages and syndicated articles where the canonical points to
    the original page that contains the actual video player.
    """
    for match in re.finditer(r"<link\b[^>]*>", html_text[:200_000], re.I):
        attrs = _meta_attrs(match.group(0))
        rel = attrs.get("rel", "").lower().split()
        if "canonical" not in rel:
            continue
        href = attrs.get("href", "").strip()
        if not href:
            continue
        url = _clean_url(href, page_url)
        if url and url != page_url:
            return url
    return None


_JSON_DATA_ATTR_NAME_RE = re.compile(
    r"^data-(?:config|setup|options|player|player-config|player-data|player-options|player-setup|video|video-config|media|media-config|sources?|jwplayer|jw-config|flowplayer|flowplayer-config|fp-config|plyr|vjs|stream|hls|dash|theo|embed|brightcove|bitmovin|kaltura|kaltura-config|clappr|clappr-config|dplayer|vidyard)$",
    re.I,
)


def _scan_json_data_attributes(
    html_text: str,
    page_url: str,
    entries: list[dict[str, Any]],
    seen: set[str],
    resolve_base: str = "",
) -> None:
    """Scan data-config / data-setup / data-player etc. attributes for embedded JSON.

    Video.js, JW Player, Plyr, Cloudflare Stream and many custom players
    store their configuration as a JSON blob in a data attribute rather than
    a plain URL.  This wraps the blob in a synthetic hydration script tag so
    the existing scanners can extract media URLs from it.
    """
    for match in re.finditer(r"<[a-zA-Z][^>]*\sdata-[^>]*>", html_text, re.I):
        tag_str = match.group(0)
        tag_attrs = _meta_attrs(tag_str)
        for name, raw_value in tag_attrs.items():
            if not name.lower().startswith("data-"):
                continue
            value = html.unescape(raw_value).strip()
            if not value or value[0] not in ("{", "["):
                continue
            name_ok = bool(_JSON_DATA_ATTR_NAME_RE.match(name))
            content_ok = (not name_ok) and bool(re.search(
                r'"(?:sources?|file|src|hls|dash|stream|video_url|episode_url|recording_url|source_url|mp4|hlsUrl|dashUrl|'
                r'streamUrl|mediaUrl|manifest_url|playback_url|master_url|m3u8_url|m3u8Url|'
                r'live_url|liveUrl|audio_url|audioUrl)"\s*:',
                value, re.I,
            ))
            if not name_ok and not content_ok:
                continue
            try:
                json.loads(value)
            except Exception:
                continue
            fake_html = f'<script type="text/x-player-data" id="__INITIAL_STATE__">{value}</script>'
            _scan_hydration_data(fake_html, page_url, entries, seen, resolve_base)
            _scan_player_configs(fake_html, page_url, entries, seen, resolve_base)
            if len(entries) >= 80:
                return


def _scan_page_title(html_text: str) -> str:
    """Extract the best available title from page HTML.

    Checks og:title, twitter:title, and <title> tag in that order.
    Returns an empty string if none is found.
    """
    for match in re.finditer(r"<meta\b[^>]*>", html_text[:100_000], re.I):
        attrs = _meta_attrs(match.group(0))
        prop = (attrs.get("property") or attrs.get("name") or "").lower()
        if prop in {"og:title", "twitter:title"}:
            content = attrs.get("content", "").strip()
            if content:
                return content
    title_m = re.search(r"<title\b[^>]*>(.*?)</title>", html_text[:100_000], re.I | re.S)
    if title_m:
        return html.unescape(title_m.group(1)).strip()
    return ""


def scan_feed_link_url(page_url: str, html_text: str) -> str | None:
    """Return the first RSS or Atom feed URL advertised in a page's <link> tags.

    Matches <link rel="alternate" type="application/rss+xml|atom+xml">.
    Returns an absolute URL or None.
    """
    for match in re.finditer(r"<link\b[^>]*>", html_text, re.I):
        attrs = _meta_attrs(match.group(0))
        rel = attrs.get("rel", "").lower()
        type_val = attrs.get("type", "").lower()
        href = attrs.get("href")
        if "alternate" not in rel:
            continue
        if type_val not in {"application/rss+xml", "application/atom+xml", "application/feed+json", "application/podcast+xml"}:
            continue
        url = _clean_url(href, page_url)
        if url:
            return url
    return None


def scan_oembed_endpoint_url(page_url: str, html_text: str) -> str | None:
    """Return the JSON oEmbed endpoint URL from a page's <link> tags, or None."""
    for match in re.finditer(r"<link\b[^>]*>", html_text, re.I):
        attrs = _meta_attrs(match.group(0))
        type_val = attrs.get("type", "").lower()
        href = attrs.get("href")
        if not href:
            continue
        if "application/json+oembed" in type_val or "text/json+oembed" in type_val:
            url = _clean_url(href, page_url)
            if url:
                return url
    return None


def extract_universal_from_html(page_url: str, page_html: str | None) -> dict[str, Any] | None:
    if not page_html:
        return None
    html_text = safe_text(page_html)[:1_500_000]
    resolve_base = _base_url_from_html(html_text, page_url)
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    # Expand <noscript> blocks: lazy-load sites put the real <img>/<video> fallback
    # markup inside <noscript> (entity-escaped) and replace it with a data-src
    # placeholder at runtime. Used only by the scanners below that look for native
    # media elements / bg-video attrs directly in markup (TS parity: scanMediaElements
    # and scanBgVideoAttrs are the only scanners given noscript-expanded HTML; scanners
    # that look inside <script>/JSON blobs or <link>/<a> tags never find anything
    # inside <noscript>, so they intentionally keep using the original html_text).
    _noscript_expanded = re.sub(
        r"<noscript\b[^>]*>(.*?)</noscript>",
        lambda m: html.unescape(m.group(1)),
        html_text[:1_000_000],
        flags=re.I | re.S,
    )
    _html_with_noscript = html_text + "\n" + _noscript_expanded if _noscript_expanded != html_text else html_text

    for match in re.finditer(r"<(?:video|audio|amp-video|amp-audio|source|track|img)\b[^>]*>", _html_with_noscript, re.I):
        tag = match.group(0)
        attrs = _meta_attrs(tag)
        tag_name = tag[1:].split(None, 1)[0].lower().strip("/")
        if tag_name == "track":
            track_kind = attrs.get("kind", "").lower()
            if re.match(r"^(?:subtitles|captions|descriptions?)$", track_kind):
                _add(
                    entries,
                    seen,
                    page_url,
                    attrs.get("src"),
                    "media-element",
                    resolve_base=resolve_base,
                    kind_hint="subtitle",
                    protocol_hint="text/vtt",
                )
            continue
        is_amp_video = tag_name == "amp-video"
        is_amp_audio = tag_name == "amp-audio"
        kind = (
            "image" if tag_name == "img"
            else "audio" if (tag_name == "audio" or is_amp_audio)
            else "video" if (tag_name == "video" or is_amp_video)
            else ""
        )
        # Background/hero videos (autoplay+loop+muted, no controls) are decorative.
        # Penalise below the auto-download threshold so they're excluded unless
        # no better candidate exists.
        is_bg_video = (
            kind == "video"
            and re.search(r"\bautoplay\b", tag, re.I)
            and re.search(r"\bloop\b", tag, re.I)
            and re.search(r"\bmuted\b", tag, re.I)
            and not re.search(r"\bcontrols\b", tag, re.I)
        )
        # Explicit user-facing video: <video controls> or <video playsinline>.
        is_user_facing_video = (
            kind == "video"
            and not is_bg_video
            and (re.search(r"\bcontrols\b", tag, re.I) or re.search(r"\bplaysinline\b", tag, re.I))
        )
        _add(
            entries,
            seen,
            page_url,
            (attrs.get("src") or attrs.get("data-src") or attrs.get("data-lazy-src")
             or attrs.get("data-original") or attrs.get("data-original-src") or attrs.get("data-lazy")
             or attrs.get("data-video-url") or attrs.get("data-stream-url")
             or attrs.get("data-hls-url") or attrs.get("data-hls-src")
             or attrs.get("data-mp4") or attrs.get("data-file")),
            "media-element",
            resolve_base=resolve_base,
            kind_hint=kind,
            protocol_hint=attrs.get("type", ""),
            confidence_override=0.55 if is_bg_video else (0.82 if is_user_facing_video else None),
        )
        if tag_name in {"img", "source"}:
            _add(
                entries,
                seen,
                page_url,
                _best_srcset_candidate(attrs.get("srcset") or attrs.get("data-srcset")),
                "media-element",
                resolve_base=resolve_base,
                kind_hint="image",
                protocol_hint=attrs.get("type", ""),
            )
        if (tag_name == "video" or is_amp_video) and attrs.get("poster"):
            _add(
                entries,
                seen,
                page_url,
                attrs["poster"],
                "media-element",
                resolve_base=resolve_base,
                kind_hint="image",
                protocol_hint="image/jpeg",
            )

    _scan_data_attributes(html_text, page_url, entries, seen, resolve_base)

    _scan_css_background_images(html_text, page_url, entries, seen, resolve_base)

    _scan_resource_links(html_text, page_url, entries, seen, resolve_base)

    metas: list[tuple[str, str]] = []
    for match in re.finditer(r"<meta\b[^>]*>", html_text, re.I):
        attrs = _meta_attrs(match.group(0))
        key = (attrs.get("property") or attrs.get("name") or attrs.get("itemprop") or "").lower()
        content = attrs.get("content")
        if not content:
            continue
        metas.append((key, content))

    video_mime = next((content for key, content in metas if re.match(r"^(?:og:video:type|twitter:player:stream:content_type)$", key)), "")
    audio_mime = next((content for key, content in metas if re.match(r"^(?:og:audio:type)$", key)), "")
    image_mime = next((content for key, content in metas if re.match(r"^(?:og:image:type|twitter:image:type)$", key)), "")

    def _meta_dim(pattern: str) -> int | None:
        value = next((content for key, content in metas if re.match(pattern, key)), "")
        try:
            num = int(float(value))
        except (TypeError, ValueError):
            return None
        return num if num > 0 else None

    video_width = _meta_dim(r"^og:video:width$")
    video_height = _meta_dim(r"^og:video:height$")
    image_width = _meta_dim(r"^(?:og:image:width|twitter:image:width)$")
    image_height = _meta_dim(r"^(?:og:image:height|twitter:image:height)$")

    for key, content in metas:
        if re.match(r"^(?:og:video(?::(?:url|secure_url))?|twitter:player:stream|twitter:player|video_url|media:url|content:url|media:video:url)$", key):
            _add(entries, seen, page_url, content, "open-graph", resolve_base=resolve_base, kind_hint="video",
                 protocol_hint=video_mime, width=video_width, height=video_height)
        elif re.match(r"^(?:og:audio(?::(?:url|secure_url))?|media:audio:url)$", key):
            _add(entries, seen, page_url, content, "open-graph", resolve_base=resolve_base, kind_hint="audio", protocol_hint=audio_mime)
        elif re.match(r"^(?:og:image(?::(?:url|secure_url))?|twitter:image(?::src)?|thumbnailurl)$", key):
            _add(entries, seen, page_url, content, "open-graph", resolve_base=resolve_base, kind_hint="image",
                 protocol_hint=image_mime, width=image_width, height=image_height)

    _scan_microdata_media(html_text, page_url, entries, seen, resolve_base)

    for match in re.finditer(r"<script\b[^>]*type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", html_text, re.I | re.S):
        try:
            parsed = json.loads(html.unescape(match.group(1)).strip())
        except Exception:
            continue
        _walk_json_ld(parsed, page_url, entries, seen, resolve_base=resolve_base)

    _scan_player_configs(html_text, page_url, entries, seen, resolve_base)

    _scan_hydration_data(html_text, page_url, entries, seen, resolve_base)

    _scan_json_data_attributes(html_text, page_url, entries, seen, resolve_base)

    # Scan <script type="text/html"> and other non-JS template blocks.
    # WordPress, Handlebars, and jQuery-tmpl sites embed <video src="...">
    # elements inside these tags; they are valid HTML, just deferred.
    for tmpl_m in re.finditer(r"<script\b([^>]*)>([\s\S]*?)</script>", html_text, re.I | re.S):
        tag_attrs = tmpl_m.group(1)
        # _meta_attrs does an exact attribute-name lookup; a standalone \btype\s*=
        # regex here would also match "type" inside "data-type" (same bug class as
        # attr()/anchorRe above) and could wrongly skip a real template <script>.
        type_val = _meta_attrs(f"<script {tag_attrs}>").get("type", "").lower()
        if not type_val:
            continue
        if re.search(r"javascript|ecmascript|module|json|ld\+json", type_val):
            continue
        _tmpl_text = html.unescape(tmpl_m.group(2))
        for tmpl_tag_m in re.finditer(r"<(?:video|audio|source|track|img)\b[^>]*>", _tmpl_text, re.I):
            tag = tmpl_tag_m.group(0)
            _attrs = _meta_attrs(tag)
            _tag_name = tag[1:].split(None, 1)[0].lower().strip("/")
            if _tag_name == "track":
                _track_kind = _attrs.get("kind", "").lower()
                if re.match(r"^(?:subtitles|captions|descriptions?)$", _track_kind):
                    _add(entries, seen, page_url, _attrs.get("src"),
                         "html-template", resolve_base=resolve_base,
                         kind_hint="subtitle", protocol_hint="text/vtt")
                continue
            _kind = "image" if _tag_name == "img" else "audio" if _tag_name == "audio" else "video" if _tag_name == "video" else ""
            _add(entries, seen, page_url,
                 (_attrs.get("src") or _attrs.get("data-src") or _attrs.get("data-lazy-src")
                  or _attrs.get("data-original") or _attrs.get("data-original-src") or _attrs.get("data-lazy")
                  or _attrs.get("data-video-url") or _attrs.get("data-stream-url")
                  or _attrs.get("data-hls-url") or _attrs.get("data-hls-src")
                  or _attrs.get("data-mp4") or _attrs.get("data-file")),
                 "html-template", resolve_base=resolve_base, kind_hint=_kind,
                 protocol_hint=_attrs.get("type", ""))
        if len(entries) >= 80:
            break

    # HTML5 <template> elements: Vue / Alpine / Lit / Handlebars use these as
    # client-side templates.  The browser never renders their content, but media
    # src/srcset attributes inside them point to real CDN URLs.
    for tmpl_elem_m in re.finditer(r"<template\b[^>]*>([\s\S]*?)</template>", html_text, re.I | re.S):
        inner = tmpl_elem_m.group(1).strip()
        if not inner:
            continue
        for _t in re.finditer(r"<(?:video|audio|source|img)\b[^>]*>", inner, re.I):
            _ta = _meta_attrs(_t.group(0))
            _tn = re.match(r"<(\w+)", _t.group(0))
            _kind = "audio" if (_tn and _tn.group(1).lower() == "audio") else "image" if (_tn and _tn.group(1).lower() == "img") else "video"
            _add(entries, seen, page_url,
                 (_ta.get("src") or _ta.get("data-src") or _ta.get("data-lazy-src")
                  or _ta.get("data-original") or _ta.get("data-video-url") or _ta.get("data-stream-url")
                  or _ta.get("data-hls-url") or _ta.get("data-hls-src") or _ta.get("data-mp4") or _ta.get("data-file")),
                 "html-template", resolve_base=resolve_base, kind_hint=_kind,
                 protocol_hint=_ta.get("type", ""))
        _scan_data_attributes(inner, page_url, entries, seen, resolve_base)
        if len(entries) >= 80:
            break

    # WordPress Gutenberg block comments: <!-- wp:video {"src":"..."} /-->
    # also <!-- wp:audio {"src":"..."} --> and wp:cover / wp:media-text.
    for wp_m in re.finditer(
        r"<!--\s*wp:(?:video|audio|media-text|cover)\s+(\{[^}]+\})\s*(?:/-?->|-->)", html_text, re.I
    ):
        try:
            wp_data = json.loads(wp_m.group(1))
        except Exception:
            continue
        wp_raw = (wp_data.get("src") or wp_data.get("url") or wp_data.get("mediaUrl")
                  or wp_data.get("mediaLink"))
        if not wp_raw or not isinstance(wp_raw, str):
            continue
        wp_kind = "audio" if str(wp_data.get("mediaType", "")).lower() == "audio" else "video"
        _add(entries, seen, page_url, wp_raw, "hydration-data",
             kind_hint=wp_kind, resolve_base=resolve_base)
        if len(entries) >= 80:
            break

    # Custom media element scanner: Arc XP, WordPress block player, Drupal, and
    # React-based media libraries register custom elements whose tag names contain
    # "video", "audio", "player", or "media" with a hyphen.  Examples:
    #   <audio-player src="...">, <video-player src="...">, <media-player src="...">
    #   <jw-player file="...">, <bc-video video-id="...">, <flowplayer-video src="...">
    for ce_m in re.finditer(
        r"<([a-z][a-z0-9]*-(?:video|audio|player|media|stream)|(?:video|audio|media)-[a-z][a-z0-9-]*)\b[^>]*>",
        html_text, re.I,
    ):
        ce_tag = ce_m.group(0)
        ce_name = ce_m.group(1).lower()
        ce_attrs = _meta_attrs(ce_tag)
        ce_is_audio = "audio" in ce_name
        ce_kind = "audio" if ce_is_audio else "video"
        ce_raw = (ce_attrs.get("src") or ce_attrs.get("file") or ce_attrs.get("url")
                  or ce_attrs.get("data-src") or ce_attrs.get("data-file") or ce_attrs.get("data-url"))
        if not ce_raw:
            continue
        ce_type = ce_attrs.get("type", "")
        ce_signal = f"{ce_raw} {ce_type}"
        # Require evidence this is a real media URL (extension, HLS/DASH, or MIME)
        if (not re.search(r"\.(?:mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|opus|flac|m3u8?|mpd)(?:[?#]|$)", ce_raw, re.I)
                and not re.search(r"mpegurl|dash\+xml", ce_signal, re.I)
                and not re.match(r"^(?:video|audio)/", ce_type, re.I)):
            continue
        _add(entries, seen, page_url, ce_raw, "media-element",
             resolve_base=resolve_base, kind_hint=ce_kind, protocol_hint=ce_type)
        if len(entries) >= 80:
            break

    # data-bg-video / data-background-video attributes on non-media elements
    # (Webflow, Squarespace, custom CMSes that load video via JS into container divs)
    for bgv_m in re.finditer(r"<[a-zA-Z][^>]*\bdata-(?:bg-?video|background-?video)\b[^>]*>", _html_with_noscript, re.I):
        bgv_tag = bgv_m.group(0)
        bgv_attrs = _meta_attrs(bgv_tag)
        bgv_url = (bgv_attrs.get("data-bg-video") or bgv_attrs.get("data-bgvideo")
                   or bgv_attrs.get("data-background-video") or bgv_attrs.get("data-backgroundvideo"))
        if bgv_url:
            _add(entries, seen, page_url, bgv_url, "media-element",
                 resolve_base=resolve_base, kind_hint="video")
        if len(entries) >= 80:
            break

    # <mux-video playback-id="..."> / <mux-audio playback-id="..."> custom elements
    for mux_m in re.finditer(r"<mux-(?:video|audio|player)\b[^>]*>", html_text, re.I):
        mux_tag = mux_m.group(0)
        mux_attrs = _meta_attrs(mux_tag)
        is_audio = "mux-audio" in mux_tag.lower()
        playback_id = mux_attrs.get("playback-id") or mux_attrs.get("data-playback-id")
        if playback_id and re.match(r"^[a-zA-Z0-9]{8,}$", playback_id):
            mux_url = f"https://stream.mux.com/{playback_id}.m3u8"
            _add(entries, seen, page_url, mux_url, "player-config",
                 kind_hint="audio" if is_audio else "video",
                 protocol_hint="application/vnd.apple.mpegurl",
                 confidence_override=0.88)
        # Also accept a full URL in src attribute
        if mux_attrs.get("src"):
            _add(entries, seen, page_url, mux_attrs["src"], "media-element",
                 kind_hint="audio" if is_audio else "video",
                 protocol_hint="application/vnd.apple.mpegurl")

    # Plyr player: data-plyr-provider + data-plyr-id (YouTube/Vimeo) or data-plyr-src (HTML5)
    for plyr_m in re.finditer(r"<[a-z][a-z0-9-]*\b[^>]*\bdata-plyr(?:-provider|-id|-embed-id|-src)\b[^>]*>", html_text, re.I):
        plyr_tag = plyr_m.group(0)
        plyr_attrs = _meta_attrs(plyr_tag)
        provider = (plyr_attrs.get("data-plyr-provider") or "").lower()
        vid_id = plyr_attrs.get("data-plyr-id") or plyr_attrs.get("data-plyr-embed-id")
        src = plyr_attrs.get("data-plyr-src")
        if provider == "youtube" and vid_id:
            embed_url = f"https://www.youtube.com/embed/{vid_id}"
            _add(entries, seen, page_url, embed_url, "player-config",
                 kind_hint="video", protocol_hint="video/mp4", confidence_override=0.85)
        elif provider == "vimeo" and vid_id:
            embed_url = f"https://player.vimeo.com/video/{vid_id}"
            _add(entries, seen, page_url, embed_url, "player-config",
                 kind_hint="video", protocol_hint="video/mp4", confidence_override=0.85)
        elif src:
            _add(entries, seen, page_url, src, "player-config", kind_hint="video")
        if len(entries) >= 80:
            break

    # Kaltura kWidget.embed() / KalturaPlayer.setup() JS config: no <iframe> is present
    # on the page (the SDK builds the player at runtime), so wid/partnerId + entry_id/entryId
    # are read out of the inline <script> and used to reconstruct an HLS manifest URL.
    for kw_script_m in re.finditer(r"<script\b[^>]*>([\s\S]*?)</script>", html_text, re.I):
        kw_text = kw_script_m.group(1)
        if not re.search(r"(?:kWidget|KalturaPlayer|kaltura_player|kaltura-player|Kaltura\.Player)", kw_text, re.I):
            continue
        kw_wid_m = (re.search(r"[\"']?wid[\"']?\s*:\s*[\"']?_?(\d{5,10})[\"']?", kw_text, re.I)
                    or re.search(r"[\"']?partner_?[Ii]d[\"']?\s*:\s*[\"']?(\d{5,10})[\"']?", kw_text))
        kw_entry_m = (re.search(r"[\"']?entry_id[\"']?\s*:\s*[\"']([01]_[A-Za-z0-9]{6,16})[\"']?", kw_text, re.I)
                      or re.search(r"[\"']?entryId[\"']?\s*:\s*[\"']([01]_[A-Za-z0-9]{6,16})[\"']?", kw_text, re.I))
        if not kw_wid_m or not kw_entry_m:
            continue
        kw_partner_id = kw_wid_m.group(1)
        kw_entry_id = kw_entry_m.group(1)
        kw_hls_url = (
            f"https://cdnapisec.kaltura.com/p/{kw_partner_id}/sp/{kw_partner_id}00/"
            f"playManifest/entryId/{kw_entry_id}/format/applehttp/protocol/https/manifest.m3u8"
        )
        _add(entries, seen, page_url, kw_hls_url, "player-config",
             kind_hint="video", protocol_hint="application/vnd.apple.mpegurl", confidence_override=0.82)
        if len(entries) >= 80:
            break

    # Flash <object> / <embed> flashvars: <param name="flashvars" value="file=URL&...">
    _FLASH_MEDIA_KEY_RE = re.compile(
        r"^(?:file|mp4|hd|src|stream|url|clip|flv|video_file|videofile|video_url|videoUrl|media_url|content_url)$",
        re.I,
    )
    for obj_m in re.finditer(r"<object\b[^>]*>(.*?)</object>", html_text, re.I | re.S):
        block = obj_m.group(0)
        # flashvars param
        for fv_m in re.finditer(r'<param\b[^>]*\bname\s*=\s*["\']flashvars["\'][^>]*>', block, re.I):
            fv_attrs = _meta_attrs(fv_m.group(0))
            fv_val = fv_attrs.get("value", "")
            if not fv_val:
                continue
            try:
                for k, v in urllib.parse.parse_qsl(fv_val, keep_blank_values=False):
                    if not _FLASH_MEDIA_KEY_RE.match(k):
                        continue
                    _add(entries, seen, page_url, v, "player-config", kind_hint="video")
                    if len(entries) >= 80:
                        break
            except Exception:
                pass
        # <param name="src"|"movie"> pointing to a media file (not .swf)
        for src_m in re.finditer(r'<param\b[^>]*\bname\s*=\s*["\'](?:src|movie)["\'][^>]*>', block, re.I):
            src_attrs = _meta_attrs(src_m.group(0))
            v = src_attrs.get("value", "")
            if v and not re.search(r"\.swf(?:[?#]|$)", v, re.I):
                _add(entries, seen, page_url, v, "player-config", kind_hint="video")
        if len(entries) >= 80:
            break
    # <embed type="...flash..." flashvars="...">
    for embed_m in re.finditer(r'<embed\b[^>]*\btype\s*=\s*["\'][^"\']*(?:flash|shockwave)[^"\']*["\'][^>]*/?>',
                               html_text, re.I):
        embed_attrs = _meta_attrs(embed_m.group(0))
        fv_val = embed_attrs.get("flashvars", "")
        if fv_val:
            try:
                for k, v in urllib.parse.parse_qsl(fv_val, keep_blank_values=False):
                    if not _FLASH_MEDIA_KEY_RE.match(k):
                        continue
                    _add(entries, seen, page_url, v, "player-config", kind_hint="video")
                    if len(entries) >= 80:
                        break
            except Exception:
                pass
        src_val = embed_attrs.get("src", "")
        if src_val and not re.search(r"\.swf(?:[?#]|$)", src_val, re.I):
            _add(entries, seen, page_url, src_val, "player-config", kind_hint="video")
        if len(entries) >= 80:
            break

    # <object data="media.mp4" type="video/..."> and <embed src="media.mp4" type="video/...">
    # direct media embeds (non-Flash): the MIME type explicitly says video or audio.
    for oe_m in re.finditer(r"<(?:object|embed)\b[^>]*>", html_text, re.I):
        oe_tag = oe_m.group(0)
        oe_attrs = _meta_attrs(oe_tag)
        oe_type = oe_attrs.get("type", "")
        if not re.match(r"^(?:video|audio)/", oe_type, re.I):
            continue
        oe_tag_name = re.match(r"<(\w+)", oe_tag)
        oe_src = oe_attrs.get("data" if (oe_tag_name and oe_tag_name.group(1).lower() == "object") else "src", "")
        if not oe_src:
            continue
        kind_hint = "audio" if re.match(r"^audio/", oe_type, re.I) else "video"
        _add(entries, seen, page_url, oe_src, "media-element", kind_hint=kind_hint, protocol_hint=oe_type)
        if len(entries) >= 80:
            break

    for match in re.finditer(r"https?:\\?/\\?/[^\"'<>\s)]+?(?:\.m3u8?[^\"'<>\s)]*|\.mpd[^\"'<>\s)]*|\.(?:mp4|m4v|webm|mov|avi|mkv|flv|mpg|mpeg|3gp|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|webp|gif|avif|heic)(?:[?#][^\"'<>\s)]*)?)", html_text, re.I):
        _add(entries, seen, page_url, match.group(0), "generic-url")
        if len(entries) >= 80:
            break

    if not entries:
        return None
    _KIND_RANK = {"video": 0, "audio": 1, "image": 2, "subtitle": 3}
    entries.sort(key=lambda item: (
        _KIND_RANK.get(_media_kind(item.get("url", "")), 2),
        -float(item.get("_universal_confidence") or 0),
        0 if item.get("protocol") in {"m3u8", "http_dash_segments"} else 1,
    ))
    page_title = _scan_page_title(html_text)
    if len(entries) == 1:
        if page_title and entries[0].get("title") in {"", "Universal media", None}:
            entries[0]["title"] = page_title
        return entries[0]
    return {
        "_type": "playlist",
        "title": page_title or "Universal media",
        "webpage_url": page_url,
        "extractor": "universal-html",
        "entries": entries[:20],
    }


def has_video_or_audio(info: dict[str, Any]) -> bool:
    """True when info has at least one video or audio entry (not image-only).

    Only reliable for results from extract_universal_from_html/feed because
    those use _entry(), which always sets `ext` and `protocol`.  Used by the
    server pipeline to decide whether to treat an HTML result as a definitive
    answer or keep it as a last-resort image fallback while continuing to try
    iframe / yt-dlp extraction.
    """
    if info.get("_type") == "playlist":
        return any(
            (e.get("ext") or "").lower() not in IMAGE_EXTS
            or e.get("protocol") in {"m3u8", "http_dash_segments"}
            for e in (info.get("entries") or [])
        )
    ext = (info.get("ext") or "").lower()
    protocol = info.get("protocol") or ""
    return ext not in IMAGE_EXTS or protocol in {"m3u8", "http_dash_segments"}

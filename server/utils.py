"""
Shared utility functions for fcdownloader-extractor.

Pure functions only — no I/O, no side effects, no imports from service modules.
These are safe to import from any module without circular-dependency risk.
"""
from __future__ import annotations

import hashlib
import re
import sys
import unicodedata
import urllib.parse


# ── UTF-8 runtime setup ───────────────────────────────────────────────────────

UTF8_ENV: dict[str, str] = {
    "PYTHONIOENCODING": "utf-8",
    "LANG": "en_US.UTF-8",
    "LC_ALL": "en_US.UTF-8",
}


def configure_utf8_runtime() -> None:
    import os
    os.environ.update(UTF8_ENV)
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


# ── String safety ─────────────────────────────────────────────────────────────


def safe_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value).encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def strip_header_controls(value: str) -> str:
    return re.sub(r"[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", " ", safe_text(value)).strip()


# ── URL handling ──────────────────────────────────────────────────────────────


def normalize_url(url: str) -> str:
    raw = safe_text(url).strip()
    if not raw:
        return raw
    try:
        parts = urllib.parse.urlsplit(raw)
        scheme = parts.scheme.lower()
        netloc = parts.netloc
        if parts.hostname:
            host = parts.hostname.encode("idna").decode("ascii")
            userinfo = ""
            if parts.username:
                userinfo = urllib.parse.quote(parts.username, safe="")
                if parts.password:
                    userinfo += ":" + urllib.parse.quote(parts.password, safe="")
                userinfo += "@"
            port = f":{parts.port}" if parts.port else ""
            netloc = f"{userinfo}{host}{port}"
        path = urllib.parse.quote(parts.path, safe="/%:@!$&'()*+,;=")
        query = urllib.parse.quote(parts.query, safe="=&?/:;%+@,$!'()*[]")
        fragment = urllib.parse.quote(parts.fragment, safe="=&?/:;%+@,$!'()*[]")
        return urllib.parse.urlunsplit((scheme, netloc, path, query, fragment))
    except Exception:
        return urllib.parse.quote(raw, safe=":/?#[]@!$&'()*+,;=%")


def url_quote(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def guess_ext_from_url(url: str) -> str:
    m = re.search(r"\.([a-z0-9]{2,5})(?:\?|$)", url.split("?")[0].lower())
    return m.group(1) if m else ""


def cache_key(page_url: str) -> str:
    page_url = normalize_url(page_url)
    m = re.search(
        r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/|/v/)([A-Za-z0-9_-]{11})",
        page_url,
    )
    return m.group(1) if m else page_url


def request_cache_key(
    page_url: str, referer: str | None, cookies: str | None
) -> str:
    key = cache_key(normalize_url(page_url))
    if referer:
        key += "|" + normalize_url(referer)
    if cookies:
        key += "|cookies:" + hashlib.sha256(cookies.encode("utf-8")).hexdigest()[:16]
    return key


# ── Header safety ─────────────────────────────────────────────────────────────


def safe_header_value(name: str, value: object) -> str:
    s = strip_header_controls(safe_text(value))
    lname = name.lower()
    if lname in {"referer", "referrer"}:
        return normalize_url(s)
    if lname == "origin":
        try:
            p = urllib.parse.urlsplit(normalize_url(s))
            return urllib.parse.urlunsplit((p.scheme, p.netloc, "", "", ""))
        except Exception:
            return s
    return "".join(ch if 32 <= ord(ch) <= 126 or ord(ch) == 9 else "?" for ch in s)


def safe_headers(headers: dict[str, object] | None) -> dict[str, str]:
    if not headers:
        return {}
    cleaned: dict[str, str] = {}
    for raw_name, raw_value in headers.items():
        name = re.sub(r"[^A-Za-z0-9-]+", "", safe_text(raw_name))
        if not name or raw_value is None:
            continue
        cleaned[name] = safe_header_value(name, raw_value)
    return cleaned


# ── Filename safety ───────────────────────────────────────────────────────────


def safe_filename(title: str | None, video_id: str, ext: str = "mp4") -> str:
    base = unicodedata.normalize("NFC", safe_text(title or video_id))
    s = re.sub(r'[<>:"/\\|?*\x00-\x1F\x7F]+', "", base, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip(" .")
    if not s:
        s = safe_ascii_filename(video_id, "download")
    return f"{s[:160]}.{ext}"


def safe_ascii_filename(value: str | None, fallback: str = "download") -> str:
    s = unicodedata.normalize("NFKD", safe_text(value or ""))
    s = "".join(ch for ch in s if 32 <= ord(ch) <= 126)
    s = re.sub(r'[<>:"/\\|?*\x00-\x1F\x7F]+', "", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    return (s[:80] or fallback)


def content_disposition(filename: str, fallback_stem: str = "download") -> str:
    safe = safe_filename(filename.removesuffix(".mp4"), fallback_stem)
    fallback = safe_ascii_filename(fallback_stem, "download")
    if not fallback.lower().endswith(".mp4"):
        fallback = f"{fallback}.mp4"
    return (
        f'attachment; filename="{fallback}"; '
        f"filename*=UTF-8''{url_quote(safe)}"
    )


def content_disposition_any(filename: str, fallback: str = "download") -> str:
    raw = unicodedata.normalize("NFC", safe_text(filename))
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1F\x7F]+', "", raw, flags=re.UNICODE)
    safe = re.sub(r"\s+", " ", safe).strip(" .")[:160] or fallback
    ascii_fallback = safe_ascii_filename(safe, fallback)
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{url_quote(safe)}"
    )


# ── Media type helpers ────────────────────────────────────────────────────────


def looks_like_hls(url: str, protocol: str | None) -> bool:
    if protocol and "m3u8" in protocol:
        return True
    return ".m3u8" in url or "/api/manifest/hls" in url


def expire_of(url: str) -> int | None:
    m = re.search(r"[?&]expire=(\d+)", url)
    return int(m.group(1)) if m else None

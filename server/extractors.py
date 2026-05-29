"""
Platform-specific media extractors.

Each extractor handles one or more sites that either (a) have no yt-dlp
extractor, or (b) need custom logic that yt-dlp doesn't handle well from a
server/datacenter context.

Currently implemented:
  - Meta family (Instagram, Threads) — HTML scrape for video_url / carousel
  - Weibo — REST API extraction with playback_list format selection

All extractors return either:
  - A standard yt-dlp info dict (single video / image)
  - A yt-dlp "playlist" dict with an `entries` list (carousel / gallery)
  - None on failure

None of these functions log raw cookie values.
"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
from typing import Any, Iterator

import languages
from config import MOBILE_UA
from utils import (
    cache_key,
    normalize_url,
    safe_headers,
    safe_text,
    strip_header_controls,
    guess_ext_from_url,
)


def _decode_html_body(body: bytes, headers: Any = None) -> str:
    """Decode fetched HTML using the site's declared charset, with JP fallbacks."""
    header_charset = ""
    if headers is not None:
        content_type = ""
        try:
            content_type = headers.get("Content-Type", "") or ""
        except Exception:
            content_type = ""
        m = re.search(r"charset\s*=\s*([A-Za-z0-9._-]+)", content_type, re.I)
        if m:
            header_charset = m.group(1)

    head = body[:4096].decode("ascii", errors="ignore")
    meta_charset = ""
    m = re.search(
        r"<meta\s+[^>]*charset\s*=\s*['\"]?\s*([A-Za-z0-9._-]+)",
        head,
        re.I,
    )
    if m:
        meta_charset = m.group(1)

    encodings: list[str] = []
    for enc in (header_charset, meta_charset, "utf-8", "cp932", "shift_jis", "euc_jp"):
        if enc and enc.lower() not in {e.lower() for e in encodings}:
            encodings.append(enc)

    for enc in encodings:
        try:
            text = body.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
        if text.count("\ufffd") <= max(2, len(text) // 1000):
            return text

    return body.decode(encodings[0] if encodings else "utf-8", errors="replace")


# ── Shared helpers ────────────────────────────────────────────────────────────

_WEIBO_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

_MODELPRESS_REFERER = "https://mdpr.jp/"
_NAVER_BLOG_REFERER = "https://blog.naver.com/"
_CURATED_SITE_PROFILES: tuple[dict[str, Any], ...] = (
    {
        "label": "Ameblo",
        "hosts": ("ameblo.jp", "ameba.jp"),
        "referer": "https://ameblo.jp/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("stat.ameba.jp", "ameblo.jp", "ameba.jp"),
    },
    {
        "label": "Natalie",
        "hosts": ("natalie.mu",),
        "referer": "https://natalie.mu/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("ogre.natalie.mu", "natalie.mu"),
    },
    {
        "label": "Oricon",
        "hosts": ("oricon.co.jp",),
        "referer": "https://www.oricon.co.jp/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("contents.oricon.co.jp", "oricon.co.jp"),
    },
    {
        "label": "Kstyle",
        "hosts": ("kstyle.com",),
        "referer": "https://kstyle.com/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("kstyle.com", "kstyle-img"),
    },
    {
        "label": "Daum/Tistory",
        "hosts": ("tistory.com", "daum.net"),
        "referer": "https://www.daum.net/",
        "language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("tistory.com", "daumcdn.net", "kakaocdn.net", "blog.kakaocdn.net"),
    },
    {
        "label": "Naver Article",
        "hosts": (
            "news.naver.com", "n.news.naver.com", "m.news.naver.com",
            "entertain.naver.com", "m.entertain.naver.com",
            "sports.news.naver.com", "m.sports.naver.com",
        ),
        "referer": "https://news.naver.com/",
        "language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("imgnews.pstatic.net", "mimgnews.pstatic.net", "ssl.pstatic.net", "phinf.pstatic.net"),
    },
    {
        "label": "Kakao TV",
        "hosts": ("tv.kakao.com", "kakao.com"),
        "referer": "https://tv.kakao.com/",
        "language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("kakaocdn.net", "kakao.com"),
    },
    {
        "label": "Livedoor Blog",
        "hosts": ("blog.livedoor.jp", "livedoor.blog", "livedoor.jp"),
        "referer": "https://blog.livedoor.jp/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("livedoor.blogimg.jp", "livedoor.jp"),
    },
    {
        "label": "Yahoo Japan",
        "hosts": ("news.yahoo.co.jp", "video.yahoo.co.jp", "yahoo.co.jp"),
        "referer": "https://news.yahoo.co.jp/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("yimg.jp", "yahoo.co.jp"),
    },
    {
        "label": "Bilibili Dynamic",
        "hosts": ("t.bilibili.com", "space.bilibili.com", "bilibili.com/opus", "bilibili.com/read"),
        "referer": "https://www.bilibili.com/",
        "language": "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("hdslb.com", "biliimg.com", "bilivideo.com"),
    },
    {
        "label": "Pixiv/Fanbox",
        "hosts": ("pixiv.net", "fanbox.cc"),
        "referer": "https://www.pixiv.net/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": ("pximg.net", "pixiv.net", "fanbox.cc"),
    },
    {
        "label": "Japanese News/Magazine",
        "hosts": (
            "bunshun.jp", "dailyshincho.jp", "news-postseven.com", "josei7.com",
            "friday.kodansha.co.jp", "gendai.media", "withonline.jp", "vivi.tv",
            "cancam.jp", "classy-online.jp", "classyonline.jp", "jj-jj.net",
            "gingerweb.jp", "ar-mag.jp", "bisweb.jp", "ray-web.jp",
            "nonno.hpplus.jp", "spur.hpplus.jp", "maquia.hpplus.jp",
            "lee.hpplus.jp", "baila.hpplus.jp", "more.hpplus.jp",
            "ananweb.jp", "croissant-online.jp", "frau.tokyo", "mi-mollet.com",
            "fashion-press.net", "fashionsnap.com", "wwdjapan.com",
            "thetv.jp", "mantan-web.jp", "crank-in.net", "cinematoday.jp",
            "eiga.com", "realsound.jp", "spice.eplus.jp", "jprime.jp",
            "smart-flash.jp", "flash.jp", "nikkan-gendai.com", "asagei.com",
            "entamenext.com", "girlsnews.tv", "tokyo-sports.co.jp",
            "hochi.news", "sponichi.co.jp", "nikkansports.com", "sanspo.com",
            "mainichi.jp", "asahi.com", "yomiuri.co.jp", "sankei.com",
            "tokyo-np.co.jp", "kyodo.co.jp", "47news.jp", "jiji.com",
            "itmedia.co.jp", "impress.co.jp", "watch.impress.co.jp",
            "news.mynavi.jp", "ascii.jp", "gigazine.net",
        ),
        "referer": "https://www.google.com/",
        "language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
        "cdn": (
            "bunshun.jp", "dailyshincho.jp", "news-postseven.com", "josei7.com",
            "kodansha.co.jp", "gendai.media", "withonline.jp", "vivi.tv",
            "cancam.jp", "classy-online.jp", "classyonline.jp", "jj-jj.net",
            "gingerweb.jp", "ar-mag.jp", "bisweb.jp", "ray-web.jp", "hpplus.jp",
            "ananweb.jp", "croissant-online.jp", "frau.tokyo", "mi-mollet.com",
            "fashion-press.net", "fashionsnap.com", "wwdjapan.com",
            "thetv.jp", "mantan-web.jp", "crank-in.net", "cinematoday.jp",
            "eiga.com", "realsound.jp", "spice.eplus.jp", "jprime.jp",
            "smart-flash.jp", "flash.jp", "nikkan-gendai.com", "asagei.com",
            "entamenext.com", "girlsnews.tv", "tokyo-sports.co.jp",
            "hochi.news", "sponichi.co.jp", "nikkansports.com", "sanspo.com",
            "mainichi.jp", "asahi.com", "yomiuri.co.jp", "sankei.com",
            "tokyo-np.co.jp", "kyodo.co.jp", "47news.jp", "jiji.com",
            "itmedia.co.jp", "impress.co.jp", "mynavi.jp", "ascii.jp",
            "gigazine.net", "images.microcms-assets.io", "cdn-ak.f.st-hatena.com",
            "cloudfront.net", "imgix.net", "akamaized.net", "yimg.jp",
            "cdn.clipkit.co", "i.gzn.jp", "dailyshincho.com",
            "res.cloudinary.com", "webaccel.jp", "ismcdn.jp", "img.cf.47news.jp",
        ),
    },
)


# ── Meta family (Instagram / Threads) ────────────────────────────────────────


def extract_meta_page(
    page_url: str,
    cookies: str | None,
    label: str,
) -> dict[str, Any] | None:
    """Fetch a Meta-family page and pull out video_url / og:video / carousel.

    Returns the standard response shape or None when nothing usable was found.
    """
    page_url = normalize_url(page_url)
    try:
        req = urllib.request.Request(
            page_url,
            headers=safe_headers({
                "User-Agent": MOBILE_UA,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                **({"Cookie": cookies} if cookies else {}),
            }),
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
                import gzip
                body = gzip.decompress(body)
            html_text = _decode_html_body(body, resp.headers)
    except Exception as exc:  # noqa: BLE001
        print(f"[{label}] fetch failed for {page_url}: {str(exc)[:200]}")
        return None

    def _decode(u: str) -> str:
        return (
            u.replace("\\u0026", "&")
             .replace("\\u003d", "=")
             .replace("\\/", "/")
             .replace("\\\\", "\\")
        )

    found: list[tuple[int, str, str]] = []  # (offset, url, "image"|"video")

    for pattern in (
        r'"video_url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"playable_url(?:_quality_hd)?"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"browser_native_(?:hd|sd)_url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
        r'"video_versions"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
    ):
        for m in re.finditer(pattern, html_text):
            found.append((m.start(), _decode(m.group(1)), "video"))

    for pattern in (
        r'"display_url"\s*:\s*"(https?:\\?/\\?/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"',
        r'"image_versions2"\s*:\s*\{\s*"candidates"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"(https?:\\?/\\?/[^"]+)"',
    ):
        for m in re.finditer(pattern, html_text):
            found.append((m.start(), _decode(m.group(1)), "image"))

    for m in re.finditer(
        r'<meta\s+(?:[^>]*\s)?(?:property|name)\s*=\s*["\'](?:og:video(?::url)?|twitter:player:stream)["\']'
        r'[^>]+content\s*=\s*["\']([^"\']+)["\']',
        html_text, re.IGNORECASE,
    ):
        found.append((m.start(), _decode(m.group(1)), "video"))

    for m in re.finditer(
        r'https?:\\?/\\?/(?:[\w-]+\.)?(?:fbcdn|threadscdn|instagram)\.com/[^\s"\'<>\\]+\.(?:mp4|m3u8)(?:\?[^\s"\'<>\\]*)?',
        html_text,
    ):
        found.append((m.start(), _decode(m.group(0)), "video"))

    found.sort(key=lambda t: t[0])
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for _off, u, kind in found:
        if not u.startswith("http"):
            continue
        dedup_key = u.split("?")[0]
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        uniq.append((u, kind))

    if not uniq:
        return None

    title: str | None = None
    title_m = re.search(
        r'<meta\s+property\s*=\s*["\']og:title["\'][^>]+content\s*=\s*["\']([^"\']+)["\']',
        html_text, re.IGNORECASE,
    )
    if title_m:
        title = title_m.group(1)

    thumb: str | None = None
    thumb_m = re.search(
        r'<meta\s+property\s*=\s*["\']og:image["\'][^>]+content\s*=\s*["\']([^"\']+)["\']',
        html_text, re.IGNORECASE,
    )
    if thumb_m:
        thumb = _decode(thumb_m.group(1))

    def _is_likely_avatar(u: str) -> bool:
        return bool(re.search(r"/profile_pic|/avatar|/s\d+x\d+/", u, re.I)) and "/post/" not in u

    filtered = [(u, k) for u, k in uniq if not _is_likely_avatar(u)]
    if filtered:
        uniq = filtered

    if len(uniq) >= 2:
        entries = []
        for u, kind in uniq:
            is_hls = ".m3u8" in u
            ext = guess_ext_from_url(u) or ("m3u8" if is_hls else ("jpg" if kind == "image" else "mp4"))
            entries.append({
                "id":           cache_key(u),
                "url":          u,
                "ext":          ext,
                "protocol":     "m3u8_native" if is_hls else "https",
                "http_headers": {"User-Agent": MOBILE_UA, "Referer": page_url},
                "title":        title,
            })
        print(f"[{label}] carousel: {len(entries)} item(s)")
        return {
            "_type":   "playlist",
            "entries": entries,
            "title":   title,
            "thumbnail": thumb,
            "id":      cache_key(page_url),
        }

    chosen, kind = uniq[0]
    is_hls = ".m3u8" in chosen
    print(f"[{label}] single: {chosen[:100]}")
    return {
        "url": chosen,
        "http_headers": {"User-Agent": MOBILE_UA, "Referer": page_url},
        "title": title,
        "thumbnail": thumb,
        "duration": None,
        "ext": "m3u8" if is_hls else guess_ext_from_url(chosen) or "mp4",
        "protocol": "m3u8_native" if is_hls else "https",
        "format_note": "HD" if ("hd_url" in chosen or "_hd_" in chosen) else None,
        "id": cache_key(page_url),
    }


def extract_threads(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return extract_meta_page(page_url, cookies, "threads")


def extract_instagram(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    return extract_meta_page(page_url, cookies, "instagram")


# ── Modelpress ───────────────────────────────────────────────────────────────


def extract_modelpress(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """Extract downloadable article images from Modelpress pages.

    Modelpress articles usually do not expose video manifests in static HTML,
    but they do expose first-party article photos on img-mdpr.freetls.fastly.net.
    Treat those as a gallery so the web app has useful media instead of an
    unsupported-url error.
    """
    page_url = normalize_url(page_url)

    def _fetch_html(url: str) -> str | None:
        try:
            req = urllib.request.Request(
                url,
                headers=safe_headers({
                    "User-Agent": _WEIBO_DESKTOP_UA,
                    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                    "Accept-Language": languages.accept_language_for_url(
                        url,
                        "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
                    ),
                    "Referer": _MODELPRESS_REFERER,
                    **({"Cookie": cookies} if cookies else {}),
                }),
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
                    import gzip
                    body = gzip.decompress(body)
                return _decode_html_body(body, resp.headers)
        except Exception as exc:  # noqa: BLE001
            print(f"[modelpress] fetch failed for {url}: {str(exc)[:200]}")
            return None

    html_text = _fetch_html(page_url)
    if not html_text:
        return None

    def _decode(value: str) -> str:
        return html.unescape(
            value.replace("\\u0026", "&")
                 .replace("\\u003d", "=")
                 .replace("\\/", "/")
        )

    def _meta(names: tuple[str, ...], text: str = html_text) -> str | None:
        name_alt = "|".join(re.escape(n) for n in names)
        patterns = (
            rf'<meta\s[^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']',
            rf'<meta\s[^>]*?content\s*=\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\']',
        )
        for pattern in patterns:
            m = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
            if m:
                return re.sub(r"\s+", " ", _decode(m.group(1))).strip()
        return None

    title = _meta(("og:title", "twitter:title"))
    thumb = _meta(("og:image", "twitter:image"))

    def _photo_index_total(text: str) -> tuple[int | None, int | None]:
        m = re.search(r"(?:\u753b\u50cf|\u5199\u771f)\s*(\d+)\s*/\s*(\d+)", text)
        if not m:
            return None, None
        return int(m.group(1)), int(m.group(2))

    def _photo_detail_urls() -> list[str]:
        current_id = None
        current_match = re.search(r"/photo/detail/(\d+)", page_url)
        if current_match:
            current_id = int(current_match.group(1))

        ids: list[int] = []
        for m in re.finditer(r"/photo/detail/(\d+)", html_text):
            photo_id = int(m.group(1))
            if photo_id not in ids:
                ids.append(photo_id)

        index, total = _photo_index_total(title or html_text[:5000])
        if current_id and index and total:
            first_id = current_id - index + 1
            derived = list(range(first_id, first_id + total))
            if all(photo_id in ids for photo_id in derived) or len(ids) < total:
                ids = derived
        elif current_id and ids:
            consecutive = [current_id]
            next_id = current_id + 1
            while next_id in ids:
                consecutive.append(next_id)
                next_id += 1
            if len(consecutive) > 1:
                ids = consecutive

        if current_id and current_id not in ids:
            ids.insert(0, current_id)

        return [f"https://mdpr.jp/photo/detail/{photo_id}" for photo_id in ids[:40]]

    def _image_urls_from_text(text: str) -> list[str]:
        found: list[str] = []
        variants = (
            text,
            text.replace("\\u0026", "&").replace("\\u003d", "=").replace("\\/", "/"),
        )
        image_re = re.compile(
            r'https?://img-mdpr\.freetls\.fastly\.net/article/[^"\']+\.(?:jpg|jpeg|png|webp)(?:\?[^"\']*)?',
            re.IGNORECASE,
        )
        for variant in variants:
            for m in image_re.finditer(variant):
                url = re.split(r"[\s<>]", _decode(m.group(0)), maxsplit=1)[0]
                if "crop=" in url:
                    continue
                url = re.sub(r"([?&])width=\d+", r"\g<1>width=1400", url)
                dedup_key = re.sub(r"\?.*$", "", url)
                if dedup_key not in {re.sub(r"\?.*$", "", u) for u in found}:
                    found.append(url)
        return found

    gallery_pages = _photo_detail_urls() if "/photo/detail/" in page_url else []
    found: list[tuple[str, str | None]] = []

    if gallery_pages:
        for detail_url in gallery_pages:
            detail_html = html_text if detail_url == page_url else _fetch_html(detail_url)
            if not detail_html:
                continue
            detail_title = _meta(("og:title", "twitter:title"), detail_html)
            detail_image = _meta(("og:image", "twitter:image"), detail_html)
            candidates = [detail_image] if detail_image else []
            candidates.extend(_image_urls_from_text(detail_html))
            for candidate in candidates:
                if not candidate:
                    continue
                url = _decode(candidate)
                dedup_key = re.sub(r"\?.*$", "", url)
                if "img-mdpr.freetls.fastly.net/article/" not in url:
                    continue
                if dedup_key not in {re.sub(r"\?.*$", "", u) for u, _ in found}:
                    found.append((url, detail_title))
                    break
    else:
        found = [(url, title) for url in _image_urls_from_text(html_text)]

    if thumb and thumb.startswith("http") and "img-mdpr.freetls.fastly.net/article/" in thumb:
        thumb = _decode(thumb)
        if not any(re.sub(r"\?.*$", "", thumb) == re.sub(r"\?.*$", "", u) for u, _ in found):
            found.insert(0, (thumb, title))

    if not found and profile["label"] == "Naver Article":
        linked_articles: list[str] = []
        for m in re.finditer(
            r'["\']((?:https?:)?//(?:n\.news|m\.news|news|m\.entertain|entertain|m\.sports|sports\.news)\.naver\.com/[^"\']*?(?:article|mnews/article|sports/index|entertain/article)[^"\']*)["\']',
            html_text,
            re.I,
        ):
            article_url = _decode(m.group(1))
            if article_url.startswith("//"):
                article_url = "https:" + article_url
            article_url = html.unescape(article_url)
            if article_url not in linked_articles:
                linked_articles.append(article_url)
            if len(linked_articles) >= 8:
                break
        for article_url in linked_articles:
            nested = extract_curated_site(article_url, cookies)
            if nested and nested.get("entries"):
                return nested

    if not found:
        return None

    entries = []
    headers = {
        "User-Agent": _WEIBO_DESKTOP_UA,
        "Referer": page_url,
    }
    for idx, (url, item_title) in enumerate(found):
        ext = guess_ext_from_url(url) or "jpg"
        entries.append({
            "id": cache_key(url),
            "url": url,
            "ext": ext,
            "protocol": "https",
            "http_headers": headers,
            "title": item_title or f"{title or 'Modelpress'} #{idx + 1}",
            "thumbnail": url,
            "extractor": "modelpress",
        })

    print(f"[modelpress] gallery: {len(entries)} image(s)")
    return {
        "_type": "playlist",
        "entries": entries,
        "title": title,
        "thumbnail": thumb or found[0][0],
        "id": cache_key(page_url),
        "extractor": "modelpress",
    }

# ── Weibo ─────────────────────────────────────────────────────────────────────


def extract_naver_blog(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """Extract post images from Naver Blog frameset/PostView pages."""
    page_url = normalize_url(page_url)

    def _decode(value: str) -> str:
        return html.unescape(
            value.replace("\\u0026", "&")
                 .replace("\\u003d", "=")
                 .replace("\\/", "/")
        )

    def _fetch_html(url: str, referer: str = _NAVER_BLOG_REFERER) -> str | None:
        try:
            req = urllib.request.Request(
                url,
                headers=safe_headers({
                    "User-Agent": _WEIBO_DESKTOP_UA,
                    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                    "Accept-Language": languages.accept_language_for_url(
                        url,
                        "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5",
                    ),
                    "Referer": referer,
                    **({"Cookie": cookies} if cookies else {}),
                }),
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
                    import gzip
                    body = gzip.decompress(body)
                return _decode_html_body(body, resp.headers)
        except Exception as exc:  # noqa: BLE001
            print(f"[naver-blog] fetch failed for {url}: {str(exc)[:200]}")
            return None

    def _postview_url(html_text: str) -> str | None:
        m = re.search(
            r'<iframe[^>]+id\s*=\s*["\']mainFrame["\'][^>]+src\s*=\s*["\']([^"\']+)["\']',
            html_text,
            re.IGNORECASE | re.DOTALL,
        )
        if m:
            return urllib.parse.urljoin(page_url, _decode(m.group(1)))

        parsed = urllib.parse.urlsplit(page_url)
        path_parts = [p for p in parsed.path.split("/") if p]
        if len(path_parts) >= 2 and path_parts[0] != "PostView.naver":
            return (
                "https://blog.naver.com/PostView.naver?"
                + urllib.parse.urlencode({
                    "blogId": path_parts[0],
                    "logNo": path_parts[1],
                    "redirect": "Dlog",
                    "widgetTypeCall": "true",
                    "directAccess": "false",
                })
            )
        return None

    def _meta(names: tuple[str, ...], text: str) -> str | None:
        name_alt = "|".join(re.escape(n) for n in names)
        patterns = (
            rf'<meta\s[^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']',
            rf'<meta\s[^>]*?content\s*=\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\']',
        )
        for pattern in patterns:
            m = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
            if m:
                return re.sub(r"\s+", " ", _decode(m.group(1))).strip()
        return None

    frameset_html = _fetch_html(page_url)
    if not frameset_html:
        return None
    post_url = _postview_url(frameset_html) or page_url
    post_html = frameset_html if post_url == page_url else _fetch_html(post_url, page_url)
    if not post_html:
        return None

    title = _meta(("og:title", "twitter:title"), post_html)
    thumb = _meta(("og:image", "twitter:image"), post_html)

    found: list[str] = []
    for img_tag in re.findall(r"<img[^>]+>", post_html, re.IGNORECASE | re.DOTALL):
        if "se-image-resource" not in img_tag:
            continue
        candidates: list[str] = []
        for attr in ("data-lazy-src", "src"):
            m = re.search(attr + r'\s*=\s*["\']([^"\']+)["\']', img_tag, re.IGNORECASE)
            if m:
                candidates.append(_decode(m.group(1)))
        for url in candidates:
            if "postfiles.pstatic.net/" not in url:
                continue
            url = re.sub(r"([?&])type=w80_blur(?:&|$)", r"\1", url)
            url = url.rstrip("?&")
            dedup_key = re.sub(r"\?.*$", "", url)
            if dedup_key not in {re.sub(r"\?.*$", "", u) for u in found}:
                found.append(url)
                break

    if not found:
        return None

    headers = {
        "User-Agent": _WEIBO_DESKTOP_UA,
        "Referer": post_url,
    }
    entries = []
    for idx, url in enumerate(found):
        ext = guess_ext_from_url(url) or "jpg"
        entries.append({
            "id": cache_key(url),
            "url": url,
            "ext": ext,
            "protocol": "https",
            "http_headers": headers,
            "title": f"{title or 'Naver Blog'} #{idx + 1}",
            "thumbnail": url,
            "extractor": "naver-blog",
        })

    print(f"[naver-blog] gallery: {len(entries)} image(s)")
    return {
        "_type": "playlist",
        "entries": entries,
        "title": title,
        "thumbnail": thumb or found[0],
        "id": cache_key(page_url),
        "extractor": "naver-blog",
    }


def _curated_profile(page_url: str) -> dict[str, Any] | None:
    lowered = page_url.lower()
    for profile in _CURATED_SITE_PROFILES:
        if any(host in lowered for host in profile["hosts"]):
            return profile
    return None


def _normalize_curated_media_url(url: str) -> str:
    """Prefer original article assets over CDN thumbnail transforms."""
    url = html.unescape(url).strip()
    parsed = urllib.parse.urlsplit(url)
    if "daumcdn.net/thumb/" in parsed.netloc + parsed.path:
        params = urllib.parse.parse_qs(parsed.query)
        fname = (params.get("fname") or [""])[0]
        if fname.startswith("http"):
            url = html.unescape(urllib.parse.unquote(fname))
    url = re.sub(
        r"(?:-|_)(?:\d{2,4}x\d{2,4}|scaled)(?=\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$))",
        "",
        url,
        flags=re.I,
    )
    url = re.sub(
        r"_\d{2,4}_(?:square|thumb|thumbnail)(?=\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$))",
        "",
        url,
        flags=re.I,
    )
    url = re.sub(r"/\d{2,3}w/", "/1200w/", url, flags=re.I)
    url = re.sub(r"/_size_c\d{2,4}x\d{2,4}/", "/_size_c1280x720/", url, flags=re.I)
    url = re.sub(r"([?&])(?:width|height|w|h)=\d+", r"\1", url)
    url = re.sub(r"[?&]$", "", url).rstrip("?&")
    return url


def _oricon_full_image_url(url: str) -> str:
    """Normalize Oricon photo CDN URLs toward their largest static asset."""
    url = html.unescape(url).strip()
    url = re.sub(r"/detail/img320/", "/detail/img660/", url, flags=re.I)
    url = re.sub(r"([?&])(?:width|height|w|h)=\d+", r"\1", url)
    url = re.sub(r"[?&](?:resize|fit|crop|quality|auto|format)=[^&#]+", "", url)
    url = re.sub(r"[?&]$", "", url).rstrip("?&")
    url = re.sub(r"([_/.-])(?:thumb|thumbnail|small)([_/.-])", r"\1\2", url, flags=re.I)
    url = re.sub(r"([_-])(?:s|m|small|thumb)(?=\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$))", "", url, flags=re.I)
    url = re.sub(r"([_-])+\.(jpe?g|png|webp|gif|avif)([?#].*)?$", r".\2\3", url, flags=re.I)
    return url


def _oricon_image_key(url: str) -> str:
    clean = re.sub(r"\?.*$", "", _oricon_full_image_url(url))
    clean = re.sub(
        r"_(?:p_)?(?:o|l|s|m|thumb|thumbnail)_\d+(?=\.(?:jpe?g|png|webp|gif|avif)$)",
        "",
        clean,
        flags=re.I,
    )
    clean = re.sub(r"/detail/img\d+/", "/detail/img/", clean, flags=re.I)
    return clean


def _oricon_quality_score(url: str) -> int:
    lower = url.lower()
    if re.search(r"_(?:p_)?o_\d+\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)", lower):
        return 1000
    if re.search(r"_(?:p_)?l_\d+\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)", lower):
        return 700
    if "/detail/img660/" in lower:
        return 650
    if re.search(r"(?:thumb|thumbnail|small|/detail/img320/|_(?:p_)?s_\d+\.)", lower):
        return 100
    return 500


def _extract_oricon_gallery(
    page_url: str,
    cookies: str | None,
    fetch_html,
    initial_html: str | None = None,
) -> dict[str, Any] | None:
    if "oricon.co.jp" not in page_url.lower():
        return None

    def _decode(value: str) -> str:
        value = html.unescape(value)
        if "\\" in value:
            try:
                value = value.encode("utf-8").decode("unicode_escape")
            except Exception:
                pass
        return (
            value.replace("\\u0026", "&")
                 .replace("\\u003d", "=")
                 .replace("\\/", "/")
        )

    def _meta(names: tuple[str, ...], text: str) -> str | None:
        name_alt = "|".join(re.escape(n) for n in names)
        patterns = (
            rf'<meta\s[^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']',
            rf'<meta\s[^>]*?content\s*=\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\']',
        )
        for pattern in patterns:
            m = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
            if m:
                return re.sub(r"\s+", " ", _decode(m.group(1))).strip()
        return None

    def _photo_pages(text: str) -> list[str]:
        pages: list[str] = []
        for m in re.finditer(r'["\'](/news/\d+/photo/\d+/?(?:\?[^"\']*)?)["\']', text):
            url = urllib.parse.urljoin(page_url, html.unescape(m.group(1)))
            url = re.sub(r"[?#].*$", "", url)
            if url not in pages:
                pages.append(url)

        current = re.search(r"/news/(\d+)/photo/(\d+)/?", page_url)
        total_match = re.search(r"(?:photo|image|画像|写真)\D{0,12}(\d+)\D{0,6}(?:of|/|／)\D{0,6}(\d+)", text, re.I)
        if current and total_match:
            news_id = current.group(1)
            total = min(int(total_match.group(2)), 80)
            for idx in range(1, total + 1):
                url = f"https://www.oricon.co.jp/news/{news_id}/photo/{idx}/"
                if url not in pages:
                    pages.append(url)

        canonical = re.sub(r"[?#].*$", "", page_url)
        if "/photo/" in canonical and canonical not in pages:
            pages.insert(0, canonical)
        return pages[:80]

    image_re = re.compile(
        r'https?://contents\.oricon\.co\.jp/(?:upimg|photo/img)/[^"\'<>\s\\]+?\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?[^"\'<>\s\\]*)?',
        re.IGNORECASE,
    )
    attr_re = re.compile(
        r'(?:src|data-src|data-original|data-lazy-src|data-image|content)\s*=\s*["\']([^"\']+)["\']',
        re.IGNORECASE,
    )

    first_html = initial_html or fetch_html(page_url)
    if not first_html:
        return None

    title = _meta(("og:title", "twitter:title"), first_html)
    thumb = _meta(("og:image", "twitter:image"), first_html)
    page_urls = _photo_pages(first_html) or [page_url]

    found: list[tuple[str, str | None, str, int]] = []
    by_key: dict[str, int] = {}

    def _add(url: str, item_title: str | None, referer: str) -> None:
        url = _decode(url)
        if url.startswith("//"):
            url = "https:" + url
        elif url.startswith("/"):
            url = urllib.parse.urljoin(referer, url)
        lowered = url.lower()
        if "contents.oricon.co.jp/upimg/" not in lowered and "contents.oricon.co.jp/photo/img/" not in lowered:
            return
        if not re.search(r"\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)", url, re.I):
            return
        full_url = _oricon_full_image_url(url)
        key = _oricon_image_key(full_url)
        score = _oricon_quality_score(full_url)
        existing_index = by_key.get(key)
        if existing_index is None:
            by_key[key] = len(found)
            found.append((full_url, item_title, referer, score))
            return
        if score > found[existing_index][3]:
            found[existing_index] = (full_url, item_title, referer, score)

    def _scan(text: str, detail_url: str) -> None:
        item_title = _meta(("og:title", "twitter:title"), text)
        for candidate in (_meta(("og:image", "twitter:image"), text),):
            if candidate:
                _add(candidate, item_title, detail_url)
        for variant in (text, _decode(text)):
            for m in image_re.finditer(variant):
                _add(m.group(0), item_title, detail_url)
            for m in attr_re.finditer(variant):
                _add(m.group(1), item_title, detail_url)

    for idx, detail_url in enumerate(page_urls):
        detail_html = first_html if idx == 0 and detail_url == re.sub(r"[?#].*$", "", page_url) else fetch_html(detail_url)
        if detail_html:
            _scan(detail_html, detail_url)

    found = [entry for entry in found if entry[3] >= 500]

    if not found:
        return None

    headers = {"User-Agent": _WEIBO_DESKTOP_UA}
    entries: list[dict[str, Any]] = []
    for idx, (url, item_title, item_referer, _score) in enumerate(found):
        ext = guess_ext_from_url(url) or "jpg"
        entries.append({
            "id": cache_key(url),
            "url": url,
            "ext": ext,
            "protocol": "https",
            "http_headers": {**headers, "Referer": item_referer},
            "title": item_title or f"{title or 'Oricon'} #{idx + 1}",
            "thumbnail": url,
            "extractor": "oricon",
        })

    print(f"[oricon] gallery: {len(entries)} image(s)")
    return {
        "_type": "playlist",
        "entries": entries,
        "title": title or "Oricon",
        "thumbnail": _oricon_full_image_url(thumb) if thumb else found[0][0],
        "id": cache_key(page_url),
        "extractor": "oricon",
    }


def extract_curated_site(
    page_url: str,
    cookies: str | None,
    page_html: str | None = None,
) -> dict[str, Any] | None:
    """Extract galleries/videos from supported article and blog pages.

    These sites mostly expose first-party media in static HTML or hydration JSON.
    A shared parser keeps the support light: no browser dependency, just page
    fetch + media URL collection + per-item Referer headers.
    """
    page_url = normalize_url(page_url)
    profile = _curated_profile(page_url)
    if not profile:
        return None

    referer = profile["referer"]

    def _decode(value: str) -> str:
        value = html.unescape(value)
        if "\\" in value:
            try:
                value = value.encode("utf-8").decode("unicode_escape")
            except Exception:
                pass
        return (
            value.replace("\\u0026", "&")
                 .replace("\\u003d", "=")
                 .replace("\\/", "/")
        )

    def _fetch_html(url: str) -> str | None:
        fetch_url = url
        if profile["label"] == "Oricon":
            fetch_url = re.sub(
                r"^https?://(?:www\.)?oricon\.co\.jp/",
                "https://contents.oricon.co.jp/",
                url,
                flags=re.I,
            )
        try:
            req = urllib.request.Request(
                fetch_url,
                headers=safe_headers({
                    "User-Agent": _WEIBO_DESKTOP_UA,
                    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                    "Accept-Language": languages.accept_language_for_url(url, profile["language"]),
                    "Referer": referer,
                    **({"Cookie": cookies} if cookies else {}),
                }),
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
                    import gzip
                    body = gzip.decompress(body)
                return _decode_html_body(body, resp.headers)
        except Exception as exc:  # noqa: BLE001
            print(f"[curated-site] fetch failed for {fetch_url}: {str(exc)[:200]}")
            return None

    if page_html and profile["label"] == "Oricon":
        info = _extract_oricon_gallery(page_url, cookies, _fetch_html, page_html)
        if info:
            return info

    html_text = _fetch_html(page_url)
    if not html_text:
        return None

    if profile["label"] == "Oricon":
        info = _extract_oricon_gallery(page_url, cookies, _fetch_html, html_text)
        if info:
            return info

    scan_text = html_text
    if profile["label"] == "Naver Article":
        body_match = re.search(
            r'<article[^>]+id\s*=\s*["\']dic_area["\'][^>]*>(.*?)</article>',
            html_text,
            re.IGNORECASE | re.DOTALL,
        )
        if body_match:
            scan_text = body_match.group(1)

    def _meta(names: tuple[str, ...]) -> str | None:
        name_alt = "|".join(re.escape(n) for n in names)
        patterns = (
            rf'<meta\s[^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']',
            rf'<meta\s[^>]*?content\s*=\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\s*=\s*["\'](?:{name_alt})["\']',
        )
        for pattern in patterns:
            m = re.search(pattern, html_text, re.IGNORECASE | re.DOTALL)
            if m:
                return re.sub(r"\s+", " ", _decode(m.group(1))).strip()
        return None

    title = _meta(("og:title", "twitter:title")) or _meta(("title",))
    thumb = _meta(("og:image", "twitter:image"))

    media_re = re.compile(
        r'https?://[^"\'<>\s\\]+\.(?:jpg|jpeg|png|webp|gif|avif|mp4|m3u8|mpd)(?:\?[^"\'<>\s\\]*)?',
        re.IGNORECASE,
    )
    attr_re = re.compile(
        r'(?:src|data-src|data-original|data-lazy-src|data-image|content)\s*=\s*["\']([^"\']+)["\']',
        re.IGNORECASE,
    )

    candidates: list[str] = []
    for text in (scan_text, _decode(scan_text)):
        for m in media_re.finditer(text):
            candidates.append(_decode(m.group(0)))
        for m in attr_re.finditer(text):
            raw = _decode(m.group(1))
            if raw.startswith("//"):
                raw = "https:" + raw
            elif raw.startswith("/"):
                raw = urllib.parse.urljoin(page_url, raw)
            raw_lowered = raw.lower()
            if raw.startswith("http") and "res.cloudinary.com/" in raw_lowered and "/image/upload/" in raw_lowered:
                candidates.append(raw)
            elif re.search(r"\.(?:jpg|jpeg|png|webp|gif|avif|mp4|m3u8|mpd)(?:[?#]|$)", raw, re.IGNORECASE):
                candidates.append(raw)

    if thumb:
        candidates.insert(0, _decode(thumb))

    cdn_tokens = tuple(token.lower() for token in profile["cdn"])
    found: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        url = html.unescape(candidate).strip().strip('"\'(),;')
        if not url.startswith("http"):
            continue
        lowered = url.lower()
        if not any(token in lowered for token in cdn_tokens):
            continue
        if any(skip in lowered for skip in (
            "sprite", "logo", "icon", "avatar", "profile", "emoji",
            "gnb_", "sp_", "header", "footer", "naver", "press_logo",
            "placeholder", "blank", "thumb_default", "btn_", "button",
            "/common/", "/static/", "/assets/", "/img/common/", "/css/",
            "/bg/", "bg_", "spacer", "holder",
        )):
            continue
        if profile["label"] == "Naver Article" and "pstatic.net" in lowered:
            if not any(marker in lowered for marker in ("/image/", "/mnews/", "/photo/", "/newsen/")):
                continue
        url = _normalize_curated_media_url(url)
        dedup = re.sub(r"\?.*$", "", url)
        if dedup in seen:
            continue
        seen.add(dedup)
        found.append(url)
        if len(found) >= 80:
            break

    if not found:
        return None

    headers = {
        "User-Agent": _WEIBO_DESKTOP_UA,
        "Referer": page_url if "pximg.net" not in found[0].lower() else referer,
    }
    entries: list[dict[str, Any]] = []
    for idx, url in enumerate(found):
        ext = (guess_ext_from_url(url) or "").lower()
        protocol = "m3u8_native" if ext == "m3u8" else ("http_dash_segments" if ext == "mpd" else "https")
        item_headers = headers.copy()
        if "pximg.net" in url.lower():
            item_headers["Referer"] = "https://www.pixiv.net/"
        entries.append({
            "id": cache_key(url),
            "url": url,
            "ext": ext or ("mp4" if re.search(r"\.(?:mp4|m3u8|mpd)(?:[?#]|$)", url, re.I) else "jpg"),
            "protocol": protocol,
            "http_headers": item_headers,
            "title": f"{title or profile['label']} #{idx + 1}",
            "thumbnail": url if ext not in ("mp4", "m3u8", "mpd") else thumb,
            "extractor": "curated-site",
        })

    print(f"[curated-site:{profile['label']}] gallery: {len(entries)} item(s)")
    return {
        "_type": "playlist",
        "entries": entries,
        "title": title or profile["label"],
        "thumbnail": thumb or found[0],
        "id": cache_key(page_url),
        "extractor": "curated-site",
    }


def _weibo_headers(page_url: str, cookies: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {
        "User-Agent": _WEIBO_DESKTOP_UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": languages.accept_language_for_url(
            page_url,
            "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        ),
        "Referer": page_url or "https://weibo.com/",
        "Origin": "https://weibo.com",
        "X-Requested-With": "XMLHttpRequest",
    }
    if cookies:
        headers["Cookie"] = cookies
    return headers


def _download_weibo_json(
    url: str,
    page_url: str,
    cookies: str | None,
    query: dict[str, str] | None = None,
    data: bytes | None = None,
) -> dict[str, Any] | None:
    url = normalize_url(url)
    page_url = normalize_url(page_url)
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    try:
        req = urllib.request.Request(
            url,
            data=data,
            headers=safe_headers(_weibo_headers(page_url, cookies)),
            method="POST" if data is not None else "GET",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            ct = resp.headers.get("Content-Type", "")
    except Exception as exc:  # noqa: BLE001
        print(f"[weibo] JSON fetch failed for {url}: {str(exc)[:200]}")
        return None

    if "json" not in ct.lower() and not body.lstrip().startswith(("{", "[")):
        print(f"[weibo] expected JSON, got {ct or 'unknown content-type'} from {url}")
        return None
    try:
        data_obj = json.loads(body)
        return data_obj if isinstance(data_obj, dict) else None
    except Exception as exc:  # noqa: BLE001
        print(f"[weibo] JSON parse failed for {url}: {str(exc)[:200]}")
        return None


def _json_get_path(obj: Any, *path: str) -> Any:
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _walk_json(obj: Any) -> Iterator[Any]:
    yield obj
    if isinstance(obj, dict):
        for value in obj.values():
            yield from _walk_json(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk_json(value)


def _weibo_id_from_url(page_url: str) -> str | None:
    parsed = urllib.parse.urlparse(page_url)
    host = parsed.netloc.lower()
    path = parsed.path.strip("/")
    qs = urllib.parse.parse_qs(parsed.query)
    if "video.weibo.com" in host:
        return (qs.get("fid") or [None])[-1]
    if path.startswith("tv/show/"):
        return path.split("/", 2)[-1] or None
    parts = [p for p in path.split("/") if p]
    if "m.weibo.cn" in host and len(parts) >= 2 and parts[0] in {"status", "detail"}:
        return parts[1]
    if "weibo.com" in host and len(parts) >= 2:
        return parts[1]
    return None


def _weibo_best_format(media_info: dict[str, Any]) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []

    def add_candidate(url: str, extra: dict[str, Any] | None = None) -> None:
        clean = url.replace("\\u0026", "&").replace("\\/", "/")
        lower = clean.lower()
        candidates.append({
            "url": clean,
            "ext": "m3u8" if ".m3u8" in lower else "mp4",
            "protocol": "m3u8_native" if ".m3u8" in lower else "https",
            "http_headers": {
                "Referer": "https://weibo.com/",
                "User-Agent": _WEIBO_DESKTOP_UA,
            },
            **(extra or {}),
        })

    playback = media_info.get("playback_list")
    if isinstance(playback, list):
        for item in playback:
            play = item.get("play_info") if isinstance(item, dict) else None
            if not isinstance(play, dict) or not play.get("url"):
                continue
            add_candidate(play["url"], {
                "format_id":   play.get("label"),
                "format_note": play.get("quality_desc"),
                "width":       play.get("width"),
                "height":      play.get("height"),
                "tbr":         play.get("bitrate"),
                "filesize":    play.get("size"),
            })

    if not candidates:
        urls = media_info.get("urls")
        if isinstance(urls, dict):
            for key in ("mp4_uhd_mp4", "mp4_hd_mp4", "mp4_ld_mp4", "mp4_hd", "mp4_ld"):
                value = urls.get(key)
                if isinstance(value, str) and value.startswith("http"):
                    add_candidate(value, {
                        "format_id":   key,
                        "format_note": key.replace("_", " ").upper(),
                    })

    if not candidates:
        for key in ("stream_url_hd", "stream_url"):
            value = media_info.get(key)
            if isinstance(value, str) and value.startswith("http"):
                add_candidate(value, {
                    "format_id":   key,
                    "format_note": "HD" if key.endswith("_hd") else None,
                })

    if not candidates:
        seen: set[str] = set()
        for value in _walk_json(media_info):
            if not isinstance(value, str) or not re.search(r"https?://", value):
                continue
            url = value.replace("\\u0026", "&").replace("\\/", "/")
            if not re.search(
                r"(?:weibocdn\.com|sinaimg\.cn).*\.(?:mp4|m3u8|mov)(?:[?#]|$)", url, re.I
            ):
                continue
            if url in seen:
                continue
            seen.add(url)
            add_candidate(url)

    if not candidates:
        return None

    def score(fmt: dict[str, Any]) -> int:
        u = (fmt.get("url") or "").lower()
        height = int(fmt.get("height") or 0)
        width = int(fmt.get("width") or 0)
        bitrate = int(fmt.get("tbr") or 0)
        size = int(fmt.get("filesize") or 0)
        fmt_id = str(fmt.get("format_id") or "").lower()
        mp4_bonus = 10_000_000 if ".mp4" in u else 0
        hls_penalty = -1_000_000 if ".m3u8" in u else 0
        hd_bonus = 500_000 if any(t in u or t in fmt_id for t in ("hd", "uhd")) else 0
        low_penalty = -250_000 if any(t in u or t in fmt_id for t in ("ld", "sd")) else 0
        return mp4_bonus + hd_bonus + low_penalty + hls_penalty + height * width + bitrate + size // 1024

    return sorted(candidates, key=score)[-1]


def _weibo_parse_post(
    meta: dict[str, Any], page_url: str
) -> dict[str, Any] | None:
    entries: list[dict[str, Any]] = []

    def thumbnail_url() -> str | None:
        pic = _json_get_path(meta, "page_info", "page_pic")
        if isinstance(pic, dict):
            return pic.get("url")
        return pic if isinstance(pic, str) else None

    def add_video_from_media_info(
        media_info: Any, fallback_id: str | None = None
    ) -> None:
        if not isinstance(media_info, dict):
            return
        best = _weibo_best_format(media_info)
        if not best:
            return
        entries.append({
            **best,
            "id": fallback_id or str(
                meta.get("id") or meta.get("mid") or cache_key(best["url"])
            ),
            "title": (
                media_info.get("video_title")
                or media_info.get("kol_title")
                or media_info.get("name")
                or meta.get("text_raw")
            ),
            "thumbnail": thumbnail_url(),
            "duration": media_info.get("duration"),
        })

    mix_items = _json_get_path(meta, "mix_media_info", "items")
    if isinstance(mix_items, list):
        for item in mix_items:
            if not isinstance(item, dict) or item.get("type") == "pic":
                continue
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            add_video_from_media_info(
                data.get("media_info"),
                str(data.get("object_id") or ""),
            )

    page_info = meta.get("page_info") if isinstance(meta.get("page_info"), dict) else {}
    top_media_info = page_info.get("media_info")
    if isinstance(top_media_info, dict) and isinstance(page_info.get("urls"), dict):
        top_media_info = {**top_media_info, "urls": page_info["urls"]}
    add_video_from_media_info(top_media_info)

    if not entries:
        return None

    title = (
        _json_get_path(meta, "page_info", "media_info", "video_title")
        or _json_get_path(meta, "page_info", "media_info", "kol_title")
        or _json_get_path(meta, "page_info", "media_info", "name")
        or meta.get("text_raw")
    )
    thumb = thumbnail_url()
    post_id = str(
        meta.get("id") or meta.get("id_str") or meta.get("mid") or cache_key(page_url)
    )

    if len(entries) > 1:
        return {
            "_type":     "playlist",
            "entries":   entries,
            "title":     title,
            "thumbnail": thumb,
            "id":        post_id,
        }

    single = entries[0]
    single.setdefault("id", post_id)
    single.setdefault("title", title)
    single.setdefault("thumbnail", thumb)
    single.setdefault("http_headers", {
        "Referer": "https://weibo.com/",
        "User-Agent": _WEIBO_DESKTOP_UA,
    })
    return single


def extract_weibo(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    video_id = _weibo_id_from_url(page_url)
    if not video_id:
        return None

    if ":" in video_id:
        body = (
            f'data={{"Component_Play_Playinfo":{{"oid":"{video_id}"}}}}'
        ).encode("utf-8", errors="replace")
        component = _download_weibo_json(
            "https://weibo.com/tv/api/component",
            page_url,
            cookies,
            query={"page": f"/tv/show/{video_id}"},
            data=body,
        )
        mid = _json_get_path(
            component or {}, "data", "Component_Play_Playinfo", "mid"
        )
        if mid:
            video_id = str(mid)

    meta = _download_weibo_json(
        "https://weibo.com/ajax/statuses/show",
        page_url,
        cookies,
        query={"id": video_id},
    )
    if not meta:
        meta = _download_weibo_json(
            "https://m.weibo.cn/statuses/show",
            page_url,
            cookies,
            query={"id": video_id},
        )
    if isinstance(meta, dict) and isinstance(meta.get("data"), dict):
        meta = meta["data"]

    parsed = _weibo_parse_post(meta, page_url) if meta else None
    if parsed:
        count = len(parsed.get("entries") or [parsed])
        print(f"[weibo] extracted {count} media item(s) via ajax/statuses/show")
    return parsed

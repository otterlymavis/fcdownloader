"""
Platform extractors for XHS, Bilibili, TikTok, and Reddit.
Imported into extractors.py so strategies.py can call extractors.extract_*.
"""
from __future__ import annotations

import gzip
import html as html_mod
import json
import re
import urllib.parse
import urllib.request
from typing import Any

import source_audit
from utils import cache_key, fetch_with_retry, guess_ext_from_url, safe_headers

_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def _fetch(url: str, headers: dict[str, str], timeout: int = 15) -> bytes | None:
    body, _ = fetch_with_retry(url, headers, timeout=timeout)
    if body and body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    return body


def _script_json(html: str, marker: str) -> dict[str, Any] | None:
    """Extract a JSON object assigned to `marker` from inside a <script> block."""
    for block in re.findall(r"<script[^>]*>(.*?)</script>", html, re.DOTALL):
        if marker not in block:
            continue
        m = re.search(re.escape(marker) + r"\s*=\s*", block)
        if not m:
            continue
        candidate = block[m.end():].strip().rstrip(";").strip()
        # Replace JS-only literals that break json.loads
        candidate = candidate.replace("undefined", "null")
        try:
            obj, _ = json.JSONDecoder().raw_decode(candidate)
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return None


# ── Xiaohongshu (XHS / 小红书) ─────────────────────────────────────────────────

# CDN prefixes that host actual note media (images/videos).
# Avatar CDNs (sns-avatar-*) are intentionally excluded.
_XHS_MEDIA_CDN = (
    "sns-webpic",
    "sns-img-hw.xhscdn.com",
    "sns-img-bd.xhscdn.com",
    "sns-img-qc.xhscdn.com",
    "ci.xiaohongshu.com",
    "sns-video-hw.xhscdn.com",
    "sns-video-bd.xhscdn.com",
    "sns-video-qc.xhscdn.com",
    "xhscdn.com/spectrum/",
    "xhscdn.com/media/",
)
_XHS_MEDIA_PATH_MARKERS = (
    "/notes_pre_post/",
    "/note_pre_post",
    "/spectrum/",
    "/media/",
)

# imageScene values that represent the full note image (not a square crop or avatar).
_XHS_GOOD_SCENES = ("WB_DFT", "WB_MK", "WB_PRV")


def _xhs_best_image_url(img: dict[str, Any]) -> str | None:
    """Return the best available URL for an XHS imageList entry, skipping avatars."""
    # infoList contains per-scene variants; prefer full-image scenes over SQUARE crops
    info_list = img.get("infoList") or []
    for scene in _XHS_GOOD_SCENES:
        for info in info_list:
            if isinstance(info, dict) and info.get("imageScene") == scene:
                u = info.get("url") or ""
                if u and _xhs_is_media_url(u):
                    return u
    # urlDefault / url fallbacks
    for key in ("urlDefault", "url"):
        u = img.get(key) or ""
        if u and _xhs_is_media_url(u):
            return u
    # Last resort: any infoList URL that isn't an avatar
    for info in info_list:
        if isinstance(info, dict):
            u = info.get("url") or ""
            if u and _xhs_is_media_url(u):
                return u
    return None


def _xhs_is_media_url(url: str) -> bool:
    """Return True if the URL points to a note media asset (not an avatar)."""
    if not url:
        return False
    low = url.replace("\\/", "/").lower()
    if any(skip in low for skip in ("sns-avatar", "/avatar/", "avatar", "profile")):
        return False
    return any(marker in low for marker in _XHS_MEDIA_CDN) or any(
        marker in low for marker in _XHS_MEDIA_PATH_MARKERS
    )


def _xhs_stream_candidates(stream: dict[str, Any]) -> list[dict[str, Any]]:
    """Return playable stream candidates from XHS' shifting video shapes."""
    candidates: list[dict[str, Any]] = []
    for codec in ("h264", "h265", "av1", "h264_hls"):
        si = stream.get(codec)
        entries = si if isinstance(si, list) else [si]
        for idx, item in enumerate(entries):
            if not isinstance(item, dict):
                continue
            url = item.get("masterUrl") or item.get("master_url")
            if not url:
                backups = item.get("backupUrls") or item.get("backup_urls") or []
                url = backups[0] if backups else None
            if url and _xhs_is_media_url(url):
                candidates.append({
                    "url": url,
                    "codec": codec,
                    "fieldPath": f"video.media.stream.{codec}[{idx}]",
                    "width": item.get("width"),
                    "height": item.get("height"),
                    "bitrate": item.get("bitrate") or item.get("avgBitrate"),
                    "hasVideo": True,
                    "hasAudio": True,
                })
    return candidates


def _select_candidate(
    candidates: list[dict[str, Any]],
    *,
    strategy: str,
    source: str,
    headers: dict[str, str] | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if not candidates:
        return None, []
    selected = max(candidates, key=source_audit.score_candidate)
    audit = [
        source_audit.audit_entry(
            strategy=strategy,
            source=source,
            url=c.get("url"),
            selected=c is selected,
            rejected_reason=None if c is selected else "lower ranked than selected variant",
            field_path=c.get("fieldPath"),
            width=c.get("width"),
            height=c.get("height"),
            bitrate=c.get("bitrate") or c.get("bandwidth"),
            content_length=c.get("contentLength") or c.get("filesize"),
            mime_type=c.get("mimeType"),
            headers=headers,
            codec=c.get("codec"),
        )
        for c in candidates
    ]
    return selected, audit


def _xhs_find_note(data: dict[str, Any], url_note_id: str | None) -> tuple[str | None, dict[str, Any]]:
    """Walk the __INITIAL_STATE__ to locate the noteDetailMap and return (note_id, note_dict)."""
    live_note = (((data.get("noteData") or {}).get("data") or {}).get("noteData") or {})
    if isinstance(live_note, dict) and live_note:
        note_id = live_note.get("noteId") or live_note.get("id") or url_note_id
        if note_id:
            return str(note_id), live_note

    for section_key in ("note", "noteDetail", "noteData"):
        section = data.get(section_key)
        if not isinstance(section, dict):
            continue
        ndm = section.get("noteDetailMap") or {}
        if not ndm:
            continue
        # Prefer the ID we extracted from the URL — avoids picking a related/recommended note
        note_id = (
            (url_note_id if url_note_id and url_note_id in ndm else None)
            or section.get("currentNoteId")
            or next(iter(ndm), None)
        )
        if not note_id:
            continue
        entry = ndm.get(note_id) or {}
        # Some versions nest under "note", others don't
        note = entry.get("note") or entry
        if isinstance(note, dict) and note:
            return note_id, note
    return None, {}


def extract_xiaohongshu(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    # Note ID from the URL is the most reliable source — prevents picking up a
    # related/recommended note whose images happen to be avatars.
    url_note_id_m = re.search(
        r"/(?:explore|discovery/item|item)/([a-f0-9]{24})", page_url
    )
    url_note_id = url_note_id_m.group(1) if url_note_id_m else None

    headers = safe_headers({
        "User-Agent": _MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        "Referer": "https://www.xiaohongshu.com/",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(page_url, headers)
    if not body:
        return None
    html = body.decode("utf-8", errors="ignore")

    data = _script_json(html, "window.__INITIAL_STATE__")
    if not data:
        return None

    note_id, note = _xhs_find_note(data, url_note_id)
    if not note_id or not note:
        return None

    title = note.get("title") or note.get("desc") or "Xiaohongshu"

    # Video
    video = note.get("video")
    if video:
        stream = (video.get("media") or {}).get("stream") or {}
        if isinstance(stream, dict):
            selected, audit = _select_candidate(
                _xhs_stream_candidates(stream),
                strategy="xiaohongshu extractor",
                source="__INITIAL_STATE__ video stream",
                headers={"Referer": "https://www.xiaohongshu.com/", "User-Agent": _MOBILE_UA},
            )
            if selected and selected.get("url"):
                url = selected["url"]
                is_hls = ".m3u8" in url
                first_img_url = None
                imgs = note.get("imageList") or []
                if imgs and isinstance(imgs[0], dict):
                    first_img_url = _xhs_best_image_url(imgs[0])
                return source_audit.add_audit({
                    "id": note_id,
                    "title": title,
                    "url": url,
                    "ext": "m3u8" if is_hls else "mp4",
                    "protocol": "m3u8_native" if is_hls else "https",
                    "http_headers": {
                        "Referer": "https://www.xiaohongshu.com/",
                        "User-Agent": _MOBILE_UA,
                    },
                    "thumbnail": first_img_url,
                }, audit)

    # Image gallery — filter out avatar URLs
    images = note.get("imageList") or []
    entries: list[dict[str, Any]] = []
    audit: list[dict[str, Any]] = []
    for idx, img in enumerate(images):
        if not isinstance(img, dict):
            continue
        url = _xhs_best_image_url(img)
        if not url:
            audit.append(source_audit.audit_entry(
                strategy="xiaohongshu extractor",
                source="__INITIAL_STATE__ imageList",
                selected=False,
                rejected_reason="no note media URL in image variants",
                field_path=f"imageList[{idx}]",
            ))
            continue
        entries.append({
            "id": f"{note_id}_{idx}",
            "title": f"{title} #{idx + 1}",
            "url": url,
            "ext": guess_ext_from_url(url) or "jpg",
            "protocol": "https",
            "http_headers": {"Referer": "https://www.xiaohongshu.com/"},
            "thumbnail": url,
        })
        audit.append(source_audit.audit_entry(
            strategy="xiaohongshu extractor",
            source="__INITIAL_STATE__ imageList",
            url=url,
            selected=True,
            field_path=f"imageList[{idx}]",
            headers={"Referer": "https://www.xiaohongshu.com/"},
        ))

    if not entries:
        return None
    if len(entries) == 1:
        return source_audit.add_audit(entries[0], audit)
    return source_audit.add_audit({"_type": "playlist", "id": note_id, "title": title, "entries": entries}, audit)


# ── Bilibili ──────────────────────────────────────────────────────────────────

def _parse_bilibili_playinfo(
    data: dict[str, Any], title: str, page_url: str, thumb: str | None = None
) -> dict[str, Any] | None:
    play = data.get("data") or data  # API wraps in .data; inline HTML doesn't
    headers = {"Referer": "https://www.bilibili.com/"}

    # Prefer DASH when both tracks are present. Bilibili commonly includes a
    # low-resolution progressive durl alongside much better DASH video tracks;
    # choosing durl first silently caps otherwise-HD downloads at 480p.
    dash = play.get("dash")
    if isinstance(dash, dict):
        videos = dash.get("video") or []
        audios = dash.get("audio") or []
        video_candidates = [
            {
                "url": v.get("baseUrl") or v.get("base_url"),
                "fieldPath": f"dash.video[{idx}].baseUrl",
                "formatId": v.get("id"),
                "width": v.get("width"),
                "height": v.get("height"),
                "bandwidth": v.get("bandwidth"),
                "codec": v.get("codecs"),
                "mimeType": v.get("mimeType") or v.get("mime_type"),
                "hasVideo": True,
                "hasAudio": False,
            }
            for idx, v in enumerate(videos)
            if isinstance(v, dict) and (v.get("baseUrl") or v.get("base_url"))
        ]
        audio_candidates = [
            {
                "url": a.get("baseUrl") or a.get("base_url"),
                "fieldPath": f"dash.audio[{idx}].baseUrl",
                "formatId": a.get("id"),
                "bandwidth": a.get("bandwidth"),
                "codec": a.get("codecs"),
                "mimeType": a.get("mimeType") or a.get("mime_type"),
                "hasVideo": False,
                "hasAudio": True,
            }
            for idx, a in enumerate(audios)
            if isinstance(a, dict) and (a.get("baseUrl") or a.get("base_url"))
        ]
        best_video, video_audit = _select_candidate(
            video_candidates,
            strategy="bilibili extractor",
            source="playurl DASH video",
            headers=headers,
        )
        best_audio, audio_audit = _select_candidate(
            audio_candidates,
            strategy="bilibili extractor",
            source="playurl DASH audio",
            headers=headers,
        )
        if best_video and best_audio:
            video_format = {
                "url": best_video["url"],
                "format_id": str(best_video.get("formatId") or ""),
                "ext": "mp4",
                "protocol": "https",
                "http_headers": headers,
                "width": best_video.get("width"),
                "height": best_video.get("height"),
                "vcodec": best_video.get("codec"),
                "acodec": "none",
            }
            audio_format = {
                "url": best_audio["url"],
                "format_id": str(best_audio.get("formatId") or ""),
                "ext": "m4a",
                "protocol": "https",
                "http_headers": headers,
                "vcodec": "none",
                "acodec": best_audio.get("codec"),
            }
            return source_audit.add_audit({
                "id": cache_key(page_url),
                "title": title,
                "url": best_video["url"],
                "ext": "mp4",
                "protocol": "https",
                "http_headers": headers,
                "thumbnail": thumb,
                "width": best_video.get("width"),
                "height": best_video.get("height"),
                "vcodec": best_video.get("codec"),
                "requested_formats": [video_format, audio_format],
                "format_id": "+".join(filter(None, (
                    video_format["format_id"], audio_format["format_id"],
                ))),
            }, [*video_audit, *audio_audit])

    # Progressive durl remains the reliable fallback when DASH audio is absent.
    durl = play.get("durl") or []
    if durl:
        candidates = [
            {
                "url": d.get("url"),
                "fieldPath": f"durl[{idx}].url",
                "contentLength": d.get("size"),
                "hasVideo": True,
                "hasAudio": True,
            }
            for idx, d in enumerate(durl)
            if isinstance(d, dict) and d.get("url")
        ]
        best, audit = _select_candidate(
            candidates,
            strategy="bilibili extractor",
            source="playurl durl",
            headers=headers,
        )
        if best and best.get("url"):
            return source_audit.add_audit({
                "id": cache_key(page_url),
                "title": title,
                "url": best["url"],
                "ext": "mp4",
                "protocol": "https",
                "http_headers": headers,
                "thumbnail": thumb,
            }, audit)

    # Last resort: return the best video-only DASH track when no progressive
    # file or audio companion exists.
    if isinstance(dash, dict):
        videos = dash.get("video") or []
        if videos:
            candidates = [
                {
                    "url": v.get("baseUrl") or v.get("base_url"),
                    "fieldPath": f"dash.video[{idx}].baseUrl",
                    "width": v.get("width"),
                    "height": v.get("height"),
                    "bandwidth": v.get("bandwidth"),
                    "codec": v.get("codecs"),
                    "mimeType": v.get("mimeType") or v.get("mime_type"),
                    "hasVideo": True,
                    "hasAudio": False,
                }
                for idx, v in enumerate(videos)
                if isinstance(v, dict) and (v.get("baseUrl") or v.get("base_url"))
            ]
            best, audit = _select_candidate(
                candidates,
                strategy="bilibili extractor",
                source="playurl DASH video",
                headers=headers,
            )
            if best and best.get("url"):
                return source_audit.add_audit({
                    "id": cache_key(page_url),
                    "title": title,
                    "url": best["url"],
                    "ext": "mp4",
                    "protocol": "https",
                    "http_headers": headers,
                    "thumbnail": thumb,
                    "width": best.get("width"),
                    "height": best.get("height"),
                    "vcodec": best.get("codec"),
                }, audit)

    return None


def extract_bilibili(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    api_headers = safe_headers({
        "User-Agent": _DESKTOP_UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json",
        **({"Cookie": cookies} if cookies else {}),
    })

    # Extract BV/AV ID from the URL — no page fetch needed.
    # Bilibili returns 412 to datacenter IPs on the page itself, but the
    # x/web-interface API is often still reachable from the same IP.
    bvid_m = re.search(r"(?:BV|bv)([A-Za-z0-9]{10})", page_url)
    aid_m = re.search(r"/av(\d+)", page_url) or re.search(r"[?&]aid=(\d+)", page_url)
    bvid = "BV" + bvid_m.group(1) if bvid_m else None
    aid = aid_m.group(1) if aid_m else None

    # Dynamic / opus posts (t.bilibili.com/{id} or bilibili.com/opus/{id}) embed a
    # video card whose BV ID is not in the URL.  Resolve via the polymer dynamic API.
    if not bvid and not aid:
        dyn_m = re.search(r"(?:t\.bilibili\.com|bilibili\.com/(?:opus|dynamic))/(\d+)", page_url)
        if dyn_m:
            dyn_id = dyn_m.group(1)
            try:
                dyn_body = _fetch(
                    f"https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id={dyn_id}&gaia_source=main_web",
                    api_headers, timeout=10,
                )
                if dyn_body:
                    dyn_data = json.loads(dyn_body.decode("utf-8"))
                    item = (dyn_data.get("data") or {}).get("item") or {}
                    modules = item.get("modules") or {}
                    major = (modules.get("module_dynamic") or {}).get("major") or {}
                    major_type = major.get("type", "")
                    if major_type == "MAJOR_TYPE_ARCHIVE":
                        archive = major.get("archive") or {}
                        bvid = archive.get("bvid") or None
            except Exception:
                pass

    title = "Bilibili Video"
    thumb: str | None = None

    if bvid or aid:
        try:
            param = f"bvid={bvid}" if bvid else f"aid={aid}"
            info_body = _fetch(
                f"https://api.bilibili.com/x/web-interface/view?{param}",
                api_headers, timeout=10,
            )
            if info_body:
                vid_data = json.loads(info_body.decode("utf-8")).get("data") or {}
                cid = vid_data.get("cid")
                aid_val = vid_data.get("aid")
                thumb = vid_data.get("pic") or thumb
                title = vid_data.get("title") or title
                if cid and aid_val:
                    # fnval=1  → durl (single MP4 with audio, works without login for ≤480p)
                    # fnval=16 → DASH (video-only .m4s, needs muxing)
                    parsed_results: list[dict[str, Any]] = []
                    for fnval in ("1", "16"):
                        play_body = _fetch(
                            f"https://api.bilibili.com/x/player/playurl"
                            f"?avid={aid_val}&cid={cid}&qn=80&fnval={fnval}&fnver=0&fourk=1",
                            api_headers, timeout=10,
                        )
                        if play_body:
                            api_play = json.loads(play_body.decode("utf-8"))
                            result = _parse_bilibili_playinfo(api_play, title, page_url, thumb=thumb)
                            if result:
                                source_audit.add_audit(result, [source_audit.audit_entry(
                                    strategy="bilibili extractor",
                                    source=f"playurl fnval={fnval}",
                                    url=result.get("url"),
                                    selected=False,
                                    headers={"Referer": "https://www.bilibili.com/"},
                                )])
                                parsed_results.append(result)
                    if parsed_results:
                        selected = max(parsed_results, key=lambda info: source_audit.score_candidate({
                            "url": info.get("url"),
                            "height": info.get("height"),
                            "width": info.get("width"),
                            "hasVideo": True,
                            "hasAudio": bool(info.get("requested_formats")) or info.get("vcodec") is None,
                            "contentLength": info.get("filesize"),
                        }))
                        merged_audit: list[dict[str, Any]] = []
                        for info in parsed_results:
                            for item in source_audit.sanitize_audit(info.get("_source_audit")):
                                if item.get("source", "").startswith("playurl fnval="):
                                    item["selected"] = info is selected
                                    if info is not selected:
                                        item["rejectedReason"] = "lower ranked than selected Bilibili API variant"
                                merged_audit.append(item)
                        selected["_source_audit"] = source_audit.sanitize_audit(merged_audit)
                        return selected
        except Exception:
            pass

    # Fall back to page HTML when the API didn't give us anything.
    page_headers = safe_headers({
        "User-Agent": _DESKTOP_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        "Referer": "https://www.bilibili.com/",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(page_url, page_headers)
    if not body:
        return None
    html = body.decode("utf-8", errors="ignore")

    title_m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.DOTALL)
    if title_m:
        t = re.sub(r"\s*[_-]\s*哔哩哔哩.*$", "", title_m.group(1).strip(), flags=re.I).strip()
        if t:
            title = t

    # __playinfo__ embedded in page HTML (DASH format; durl is tried first above)
    play_data = _script_json(html, "window.__playinfo__")
    if play_data:
        result = _parse_bilibili_playinfo(play_data, title, page_url, thumb=thumb)
        if result:
            return result

    # readyVideoUrl in HTML (older pages)
    m = re.search(r'"readyVideoUrl"\s*:\s*"([^"]+)"', html)
    if m:
        url = m.group(1).replace("\\/", "/").replace("\\u0026", "&")
        return source_audit.add_audit({
            "id": cache_key(page_url),
            "title": title,
            "url": url,
            "ext": "mp4",
            "protocol": "https",
            "http_headers": {"Referer": "https://www.bilibili.com/"},
        }, [source_audit.audit_entry(
            strategy="bilibili extractor",
            source="readyVideoUrl HTML",
            url=url,
            selected=True,
            headers={"Referer": "https://www.bilibili.com/"},
        )])

    return None


# ── TikTok ────────────────────────────────────────────────────────────────────

def _tiktok_from_item(item: dict[str, Any], page_url: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    video = item.get("video") or {}
    vid_id = str(item.get("id") or item.get("aweme_id") or cache_key(page_url))
    desc = item.get("desc") or item.get("title") or "TikTok Video"

    # Regular video post
    candidates: list[dict[str, Any]] = []
    for addr_key in ("downloadAddr", "download_addr", "playAddr", "play_addr"):
        addr = video.get(addr_key)
        if isinstance(addr, dict):
            urls = addr.get("url_list") or addr.get("urlList") or []
            for idx, url in enumerate(urls):
                if url:
                    candidates.append({
                        "url": url,
                        "fieldPath": f"video.{addr_key}.url_list[{idx}]",
                        "width": video.get("width"),
                        "height": video.get("height"),
                        "bitrate": video.get("bitrate") or video.get("bit_rate"),
                        "hasVideo": True,
                        "hasAudio": True,
                        "addressKey": addr_key,
                    })
        elif isinstance(addr, str) and addr.startswith("http"):
            candidates.append({
                "url": addr,
                "fieldPath": f"video.{addr_key}",
                "width": video.get("width"),
                "height": video.get("height"),
                "bitrate": video.get("bitrate") or video.get("bit_rate"),
                "hasVideo": True,
                "hasAudio": True,
                "addressKey": addr_key,
            })
    if candidates:
        selected, audit = _select_candidate(
            candidates,
            strategy="tiktok extractor",
            source="itemStruct video addresses",
        )
        if selected and selected.get("url"):
            return source_audit.add_audit({
                "id": vid_id, "title": desc,
                "url": selected["url"], "ext": "mp4",
                "protocol": "https", "http_headers": {},
            }, audit)

    # Photo slideshow post — images live in imagePost.images[].imageURL.urlList
    image_post = item.get("imagePost") or {}
    images = image_post.get("images") or []
    if images:
        entries: list[dict[str, Any]] = []
        for idx, img in enumerate(images):
            if not isinstance(img, dict):
                continue
            img_urls = (img.get("imageURL") or {}).get("urlList") or []
            if not img_urls:
                continue
            entry = {
                "id": f"{vid_id}_{idx}",
                "title": f"{desc} #{idx + 1}",
                "url": img_urls[0],
                "ext": "jpeg",
                "protocol": "https",
                "http_headers": {},
                "thumbnail": img_urls[0],
            }
            source_audit.add_audit(entry, [
                source_audit.audit_entry(
                    strategy="tiktok extractor",
                    source="imagePost.images",
                    url=u,
                    selected=(u == img_urls[0]),
                    rejected_reason=None if u == img_urls[0] else "lower ranked than first image URL variant",
                    field_path=f"imagePost.images[{idx}].imageURL.urlList",
                )
                for u in img_urls
            ])
            entries.append(entry)
        if entries:
            if len(entries) == 1:
                return entries[0]
            audit: list[dict[str, Any]] = []
            for entry in entries:
                audit.extend(source_audit.sanitize_audit(entry.get("_source_audit")))
            return {
                "_type": "playlist",
                "id": vid_id,
                "title": desc,
                "entries": entries,
                "thumbnail": entries[0]["url"],
                "_source_audit": source_audit.sanitize_audit(audit),
            }

    return None


def extract_tiktok(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    video_id_m = re.search(r"/video/(\d+)", page_url)
    video_id = video_id_m.group(1) if video_id_m else None

    # Strategy 1: parse __UNIVERSAL_DATA_FOR_REHYDRATION__ from page HTML
    html_headers = safe_headers({
        "User-Agent": _MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(page_url, html_headers)
    if body:
        html = body.decode("utf-8", errors="ignore")

        m = re.search(
            r'<script[^>]+id=["\']__UNIVERSAL_DATA_FOR_REHYDRATION__["\'][^>]*>(.*?)</script>',
            html, re.DOTALL,
        )
        if m:
            try:
                urd = json.loads(m.group(1))
                scope = urd.get("__DEFAULT_SCOPE__") or {}
                for key in scope:
                    if "video-detail" in key or "video.detail" in key or "item" in key.lower():
                        section = scope[key]
                        item_struct = (
                            ((section.get("itemInfo") or {}).get("itemStruct"))
                            or ((section.get("videoInfo") or {}).get("itemStruct"))
                            or {}
                        )
                        result = _tiktok_from_item(item_struct, page_url)
                        if result:
                            return result
            except Exception:
                pass

        m2 = re.search(
            r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
            html, re.DOTALL,
        )
        if m2:
            try:
                nd = json.loads(m2.group(1))
                item_struct = (
                    (((nd.get("props") or {}).get("pageProps") or {})
                     .get("itemInfo") or {}).get("itemStruct") or {}
                )
                result = _tiktok_from_item(item_struct, page_url)
                if result:
                    return result
            except Exception:
                pass

        # Raw scan for video MP4 URLs in HTML
        for pattern in (
            r'"downloadAddr"\s*:\s*"(https?://[^"]+\.mp4[^"]*)"',
            r'"playAddr"\s*:\s*"(https?://[^"]+\.mp4[^"]*)"',
        ):
            m3 = re.search(pattern, html)
            if m3:
                url = m3.group(1).replace("\\/", "/").replace("\\u0026", "&")
                return source_audit.add_audit({
                    "id": video_id or cache_key(page_url),
                    "title": "TikTok Video",
                    "url": url, "ext": "mp4",
                    "protocol": "https", "http_headers": {},
                }, [source_audit.audit_entry(
                    strategy="tiktok extractor",
                    source="raw HTML regex",
                    url=url,
                    selected=True,
                )])

    # Strategy 2: TikTok API (often blocked on datacenter IPs without cookies)
    if video_id:
        api_url = (
            f"https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/"
            f"?aweme_id={video_id}"
        )
        api_body = _fetch(api_url, safe_headers({"User-Agent": _MOBILE_UA, "Accept": "*/*"}))
        if api_body:
            try:
                data = json.loads(api_body.decode("utf-8"))
                for aweme in (data.get("aweme_list") or []):
                    result = _tiktok_from_item(aweme, page_url)
                    if result:
                        return result
            except Exception:
                pass

    return None


# ── Reddit ────────────────────────────────────────────────────────────────────

def _walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_dicts(child)


def _douyin_video_id_from_data(data: dict[str, Any]) -> str | None:
    for item in _walk_dicts(data):
        for key in ("video_id", "videoId", "vid", "uri", "play_addr_uri"):
            value = item.get(key)
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,}", value):
                return value
        video = item.get("video")
        if isinstance(video, dict):
            play_addr = video.get("play_addr") or video.get("playAddr") or {}
            if isinstance(play_addr, dict):
                value = play_addr.get("uri") or play_addr.get("url_key")
                if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,}", value):
                    return value
    return None


def _douyin_video_id_from_html(html: str) -> str | None:
    for pattern in (
        r'"video_id"\s*:\s*"([^"]+)"',
        r"'video_id'\s*:\s*'([^']+)'",
        r'videoId\s*:\s*"([^"]+)"',
        r'vid\s*:\s*"([^"]+)"',
        r"video_id=([^&\"']+)",
        r'"vid"\s*:\s*"([^"]+)"',
        r'playId\s*:\s*"([^"]+)"',
        r'"playId"\s*:\s*"([^"]+)"',
        r"v0[0-9a-zA-Z_-]{20,}",
    ):
        match = re.search(pattern, html)
        if match:
            return match.group(1) if match.lastindex else match.group(0)
    return None


def _html_meta_title(html: str, fallback: str) -> str:
    import html as html_mod
    for pattern in (
        r'<meta\s+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta\s+[^>]*content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']og:title["\']',
        r"<title[^>]*>(.*?)</title>",
    ):
        match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
        if match:
            title = re.sub(r"\s+", " ", html_mod.unescape(match.group(1))).strip()
            if title:
                return title
    return fallback


def extract_douyin_watermark_free(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    headers = safe_headers({
        "User-Agent": _MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5",
        "Referer": "https://www.douyin.com/",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(page_url, headers)
    if not body:
        return None
    html = body.decode("utf-8", errors="ignore")

    data = _script_json(html, "window._ROUTER_DATA") or _script_json(html, "window.__INITIAL_STATE__")
    video_id = _douyin_video_id_from_data(data) if data else None
    if not video_id:
        video_id = _douyin_video_id_from_html(html)
    if not video_id:
        return None

    title = _html_meta_title(html, "Douyin Video")
    if data:
        for item in _walk_dicts(data):
            title = item.get("desc") or item.get("title") or item.get("caption") or title
            if title != "Douyin Video":
                break

    play_url = (
        "https://aweme.snssdk.com/aweme/v1/play/"
        f"?video_id={urllib.parse.quote(video_id)}&ratio=1080p&line=0"
    )
    return source_audit.add_audit({
        "id": video_id,
        "title": title,
        "url": play_url,
        "ext": "mp4",
        "protocol": "https",
        "http_headers": {
            "Referer": "https://www.douyin.com/",
            "User-Agent": _MOBILE_UA,
        },
        "extractor": "douyin-watermark-free-source",
    }, [source_audit.audit_entry(
        strategy="watermark-free source",
        source="page video id + aweme play endpoint",
        url=play_url,
        selected=True,
        headers={"Referer": "https://www.douyin.com/", "User-Agent": _MOBILE_UA},
        notes="Source-derived no-watermark URL; no third-party parser used.",
    )])


def extract_watermark_free_source(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    host = urllib.parse.urlsplit(page_url).netloc.lower()
    if "douyin.com" in host or "iesdouyin.com" in host:
        return extract_douyin_watermark_free(page_url, cookies)
    if "xiaohongshu.com" in host or "rednote.com" in host or "xhslink.com" in host:
        info = extract_xiaohongshu(page_url, cookies)
        if info:
            source_audit.add_audit(info, [source_audit.audit_entry(
                strategy="watermark-free source",
                source="xiaohongshu full media variants",
                selected=True,
                notes="Existing XHS extractor selected full note media URLs without using a third-party parser.",
            )])
        return info
    return None


def _reddit_rss_info(
    body: bytes,
    page_url: str,
    post_id: str | None,
) -> dict[str, Any] | None:
    rss = body.decode("utf-8", errors="replace")
    entries = re.findall(r"<entry\b[\s\S]*?</entry>", rss, re.IGNORECASE)
    post_entry = next((
        entry for entry in entries
        if re.search(
            rf"<id>\s*t3_{re.escape(post_id)}\s*</id>" if post_id else r"<id>\s*t3_[A-Za-z0-9]+\s*</id>",
            entry,
            re.IGNORECASE,
        )
    ), None)
    if not post_entry:
        return None

    decoded = post_entry
    for _ in range(3):
        next_value = html_mod.unescape(decoded)
        if next_value == decoded:
            break
        decoded = next_value

    title_match = re.search(r"<title[^>]*>(.*?)</title>", post_entry, re.IGNORECASE | re.DOTALL)
    title = html_mod.unescape(title_match.group(1)).strip() if title_match else "Reddit"
    urls: list[str] = []
    for match in re.finditer(
        r"https?://(?:v\.redd\.it|i\.redd\.it|preview\.redd\.it)/[^\"'<>\s]+",
        decoded,
        re.IGNORECASE,
    ):
        url = match.group(0).rstrip(");,")
        if url not in urls:
            urls.append(url)

    video_url = next((url for url in urls if "://v.redd.it/" in url.lower()), None)
    if video_url:
        parsed = urllib.parse.urlsplit(video_url)
        path_parts = [part for part in parsed.path.split("/") if part]
        if len(path_parts) == 1:
            video_url = f"https://v.redd.it/{path_parts[0]}/HLSPlaylist.m3u8"
        headers = {"Referer": "https://www.reddit.com/"}
        return source_audit.add_audit({
            "id": post_id or cache_key(page_url),
            "title": title or "Reddit Video",
            "url": video_url,
            "ext": "m3u8" if ".m3u8" in video_url.lower() else (guess_ext_from_url(video_url) or "mp4"),
            "protocol": "m3u8_native" if ".m3u8" in video_url.lower() else "https",
            "http_headers": headers,
        }, [source_audit.audit_entry(
            strategy="reddit RSS extractor",
            source="post Atom t3 entry",
            url=video_url,
            selected=True,
            headers=headers,
        )])

    image_urls = [
        url for url in urls
        if any(host in urllib.parse.urlsplit(url).netloc.lower() for host in ("i.redd.it", "preview.redd.it"))
    ]
    if not image_urls:
        return None

    entries_out = [{
        "id": f"{post_id or cache_key(page_url)}-{idx + 1}",
        "title": title or f"Reddit Image {idx + 1}",
        "url": url,
        "ext": guess_ext_from_url(url) or "jpg",
        "protocol": "https",
        "http_headers": {"Referer": "https://www.reddit.com/"},
    } for idx, url in enumerate(image_urls)]
    audit = [
        source_audit.audit_entry(
            strategy="reddit RSS extractor",
            source="post Atom t3 entry",
            url=entry["url"],
            selected=True,
            headers=entry["http_headers"],
        )
        for entry in entries_out
    ]
    if len(entries_out) == 1:
        return source_audit.add_audit(entries_out[0], audit)
    return source_audit.add_audit({
        "_type": "playlist",
        "id": post_id or cache_key(page_url),
        "title": title or "Reddit Gallery",
        "entries": entries_out,
    }, audit)


def _reddit_json_info(
    post: dict[str, Any],
    page_url: str,
) -> dict[str, Any] | None:
    download_headers = {"Referer": "https://www.reddit.com/"}
    reddit_video = (post.get("secure_media") or {}).get("reddit_video") or {}
    if not reddit_video:
        reddit_video = (post.get("media") or {}).get("reddit_video") or {}

    vid_id = post.get("id") or cache_key(page_url)
    title = post.get("title") or "Reddit"
    thumb = post.get("thumbnail")
    if thumb in ("default", "self", "nsfw", ""):
        thumb = None

    if reddit_video:
        candidates: list[dict[str, Any]] = []
        for key, ext, proto in (
            ("hls_url",      "m3u8", "m3u8_native"),
            ("dash_url",     "mpd",  "http_dash_segments"),
            ("fallback_url", "mp4",  "https"),
        ):
            url = reddit_video.get(key)
            if url:
                candidates.append({
                    "url": url,
                    "fieldPath": f"reddit_video.{key}",
                    "ext": ext,
                    "protocol": proto,
                    "height": reddit_video.get("height"),
                    "width": reddit_video.get("width"),
                    "bitrate": reddit_video.get("bitrate_kbps"),
                    "hasVideo": True,
                    "hasAudio": key != "fallback_url",
                })

        selected, audit = _select_candidate(
            candidates,
            strategy="reddit extractor",
            source="post JSON reddit_video",
        )
        if selected and selected.get("url"):
            return source_audit.add_audit({
                "id": vid_id, "title": title,
                "url": selected["url"], "ext": selected.get("ext") or "mp4",
                "protocol": selected.get("protocol") or "https", "http_headers": download_headers,
                "thumbnail": thumb,
                "width": selected.get("width"),
                "height": selected.get("height"),
            }, audit)

    image_urls: list[str] = []
    if post.get("is_gallery") and isinstance(post.get("media_metadata"), dict):
        metadata = post["media_metadata"]
        gallery_items = ((post.get("gallery_data") or {}).get("items") or [])
        ids = [item.get("media_id") for item in gallery_items if isinstance(item, dict)]
        ids = [media_id for media_id in ids if media_id] or list(metadata)
        for media_id in ids:
            meta = metadata.get(media_id) or {}
            if meta.get("status") != "valid":
                continue
            url = ((meta.get("s") or {}).get("u") or (meta.get("s") or {}).get("gif") or "")
            if url:
                image_urls.append(html_mod.unescape(url))
    else:
        direct_url = post.get("url")
        if isinstance(direct_url, str) and re.search(r"\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)", direct_url, re.I):
            image_urls.append(direct_url)

    if not image_urls:
        return None
    entries = [{
        "id": f"{vid_id}-{idx + 1}",
        "title": title,
        "url": url,
        "ext": guess_ext_from_url(url) or "jpg",
        "protocol": "https",
        "http_headers": download_headers,
    } for idx, url in enumerate(image_urls)]
    if len(entries) == 1:
        return entries[0]
    return {"_type": "playlist", "id": vid_id, "title": title, "entries": entries}


def extract_reddit(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    _reddit_ua = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    )
    # Share links (/s/xxx) are redirects — follow them to get the canonical URL
    # before appending /.json, otherwise the JSON endpoint returns 404.
    if re.search(r"/s/[A-Za-z0-9]+/?$", page_url):
        try:
            req = urllib.request.Request(
                page_url,
                headers=safe_headers({
                    "User-Agent": _reddit_ua,
                    "Accept": "text/html,*/*",
                    **({"Cookie": cookies} if cookies else {}),
                }),
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                page_url = resp.url
        except Exception:
            pass

    canonical_url = re.sub(r"[?#].*$", "", page_url).rstrip("/")
    post_id_match = re.search(r"/comments/([A-Za-z0-9]+)", canonical_url)
    post_id = post_id_match.group(1) if post_id_match else None

    # Try Atom first. Reddit increasingly gates anonymous JSON, and a failed
    # JSON request can consume the small anonymous rate-limit budget.
    rss_headers = safe_headers({
        "User-Agent": _reddit_ua,
        "Accept": "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        **({"Cookie": cookies} if cookies else {}),
    })
    rss_body = _fetch(f"{canonical_url}/.rss", rss_headers)
    if rss_body:
        rss_info = _reddit_rss_info(rss_body, page_url, post_id)
        if rss_info:
            return rss_info

    json_url = f"{canonical_url}/.json?limit=1&raw_json=1"
    json_headers = safe_headers({
        "User-Agent": _reddit_ua,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        **({"Cookie": cookies} if cookies else {}),
    })
    body = _fetch(json_url, json_headers)
    if not body:
        return None

    try:
        data = json.loads(body.decode("utf-8"))
        post = data[0]["data"]["children"][0]["data"]
    except Exception:
        return None
    return _reddit_json_info(post, page_url)


# ── Watermark-removal proxy (snapwc.com) ──────────────────────────────────────
#
# snapwc accepts a URL, runs its own extraction, and returns media entries.
# For Weibo image posts it returns the same sinaimg.cn URLs we already use
# (static watermarks are baked into the CDN files and cannot be removed this
# way). For video content the proxy may surface cleaner or higher-quality
# streams. This extractor is only tried when removeWatermark=true is set in
# the client settings.
#
# Protocol: RSA-1024 + AES-CBC per-request envelope (key from their JS bundle).
# Timeout: ~25 s — the parse step is slow; we cap at 20 s and fall back.

_SNAPWC_SERVER_PUBLIC_PEM = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvDU+dR2bSews55172x4L\n"
    "s/ja+Dxt9ViZcj/nY0YodYo7l4jEKtEiCNV28lpFj3CkP4HKRCjL/jYkQNKGPwVg\n"
    "gUCGr/jBF1FpDLsqa0kg+dtfkm5Xm9QAyMBeG/jPdl5BEPOVh33A1UkPO/Xw6kSH\n"
    "rfghOUwBMzRBtXeYuJiYs5sKrf+Wy5sv708TI6G4hAPJG/69W4NNFJi/ipBNxntG\n"
    "dAoUHpEy4iYsvBgiccE7U0MBDnSHSqBBtIdMMFRHARn/tc+jXaadS0a4YmhTygiN\n"
    "eAJU4QuqAE25CsvkzIYIVEmlRXVcC0afw76XcwDpKBMVR5bEPzd3tMEfA+R34L1D\n"
    "fQIDAQAB\n"
    "-----END PUBLIC KEY-----"
)

_SNAPWC_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
    ),
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8",
    "Origin": "https://snapwc.com",
    "Referer": "https://snapwc.com/",
    "x-locale": "zh-CN",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
}


def _snapwc_sha256(s: str) -> bytes:
    from cryptography.hazmat.primitives import hashes
    d = hashes.Hash(hashes.SHA256())
    d.update(s.encode("utf-8"))
    return d.finalize()


def _snapwc_encrypt(payload: dict[str, Any], client_pub_pem: str) -> dict[str, Any]:
    import base64, os as _os
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.asymmetric import padding as asympad
    from cryptography.hazmat.primitives import padding as sympad, serialization

    t = _os.urandom(16).hex()
    key = _snapwc_sha256(t)
    iv = _os.urandom(16)
    pt = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    padder = sympad.PKCS7(128).padder()
    padded = padder.update(pt) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ct = enc.update(padded) + enc.finalize()
    server_pub = serialization.load_pem_public_key(_SNAPWC_SERVER_PUBLIC_PEM.encode())
    return {
        "encrypted_key":    base64.b64encode(server_pub.encrypt(t.encode(), asympad.PKCS1v15())).decode(),
        "encrypted_data":   base64.b64encode(iv + ct).decode(),
        "client_public_key": client_pub_pem,
    }


def _snapwc_decrypt(resp: dict[str, Any], priv_pem: str) -> dict[str, Any]:
    import base64
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.asymmetric import padding as asympad
    from cryptography.hazmat.primitives import padding as sympad, serialization

    priv = serialization.load_pem_private_key(priv_pem.encode(), password=None)
    n = priv.decrypt(base64.b64decode(resp["encrypted_key"]), asympad.PKCS1v15()).decode()
    key = _snapwc_sha256(n)
    raw = base64.b64decode(resp["encrypted_data"])
    dec = Cipher(algorithms.AES(key), modes.CBC(raw[:16])).decryptor()
    padded = dec.update(raw[16:]) + dec.finalize()
    unpadder = sympad.PKCS7(128).unpadder()
    return json.loads((unpadder.update(padded) + unpadder.finalize()).decode("utf-8"))


def extract_via_snapwc(page_url: str) -> dict[str, Any] | None:
    """Try snapwc watermark-removal proxy. Falls back to None on any failure."""
    import base64, datetime, os as _os, uuid as _uuid
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    jar = urllib.request.HTTPCookieProcessor()
    opener = urllib.request.build_opener(jar)

    def _post(url: str, data: dict[str, Any], timeout: int = 12) -> dict[str, Any]:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body, headers=_SNAPWC_HEADERS, method="POST")
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                import gzip as _gz
                raw = _gz.decompress(raw)
            except Exception:
                pass
            return json.loads(raw.decode("utf-8", errors="ignore"))

    try:
        # 1. Visitor init — sets session cookie
        _post("https://api.snapwc.com/api.visitor/init", {})

        # 2. Protocol events (their analytics layer gates the parse endpoint)
        sid = str(_uuid.uuid4())
        ts  = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "000Z"
        ev  = {
            "page_session_id": sid, "client_timestamp": ts,
            "page_path": "/zh", "page_search": "", "page_hash": "",
            "referrer_host": "", "has_visitor_id": True,
        }
        _post("https://api.snapwc.com/api.event/log",
              {"name": "frontend_visitor_init_reused", "data": ev, "channel": "frontend_debug"})
        _post("https://api.snapwc.com/api.captcha/is_required",
              {"scenario": "parser", "data": {"url": page_url}})

        parsed_u = urllib.parse.urlsplit(page_url)
        _post("https://api.snapwc.com/api.event/log", {
            "name": "frontend_parse_submit_started",
            "data": {**ev, "platform": "homepage", "url_present": True,
                     "url_host": parsed_u.hostname or "",
                     "url_protocol": parsed_u.scheme or "",
                     "url_pathname": parsed_u.path or ""},
            "channel": "frontend_debug",
        })

        # 3. Generate ephemeral RSA-1024 key pair for response decryption
        priv_key = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        priv_pem = priv_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        pub_pem = priv_key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()

        # 4. Encrypted parse request (20 s — snapwc is slow)
        enc_body = _snapwc_encrypt({"url": page_url}, pub_pem)
        enc_resp = _post("https://api.snapwc.com/api.parser/parse", enc_body, timeout=20)

        if "encrypted_data" not in enc_resp:
            return None

        raw = _snapwc_decrypt(enc_resp, priv_pem)
        title = raw.get("title") or ""
        print(f"[snapwc] response keys={list(raw.keys())}  title={title[:60]!r}")

        # Image gallery (e.g. Weibo image posts, Instagram carousels)
        images: list[dict[str, Any]] = raw.get("images") or []
        if images:
            entries = []
            for idx, img in enumerate(images):
                url = img.get("url") or img.get("src") or img.get("download_url") or ""
                if not url.startswith("http"):
                    continue
                entries.append({
                    "id":        f"snapwc_{idx}",
                    "title":     f"{title} #{idx + 1}" if title else f"Image #{idx + 1}",
                    "url":       url,
                    "ext":       guess_ext_from_url(url) or "jpg",
                    "protocol":  "https",
                    "http_headers": {},
                    "thumbnail": url,
                })
            if entries:
                print(f"[snapwc] gallery: {len(entries)} image(s)")
                if len(entries) == 1:
                    return entries[0]
                return {"_type": "playlist", "id": cache_key(page_url),
                        "title": title, "entries": entries}

        # Separate video + audio tracks
        videos: list[dict[str, Any]] = raw.get("videos") or []
        audios: list[dict[str, Any]] = raw.get("audios") or []
        if videos and audios:
            best_v = max(videos, key=lambda v: int(v.get("size") or 0))
            best_a = max(audios, key=lambda a: int(a.get("size") or 0))
            vurl, aurl = best_v.get("url", ""), best_a.get("url", "")
            if vurl.startswith("http") and aurl.startswith("http"):
                print(f"[snapwc] paired video+audio")
                return {
                    "url": vurl, "audio_url": aurl,
                    "title": title, "ext": "mp4",
                    "protocol": "https", "http_headers": {},
                    "id": cache_key(page_url),
                }

        # Pre-muxed stream
        muxed: list[dict[str, Any]] = raw.get("muxed") or []
        if muxed:
            best = max(muxed, key=lambda v: int(v.get("size") or 0))
            url = best.get("url", "")
            if url.startswith("http"):
                print(f"[snapwc] muxed video")
                return {
                    "url": url, "title": title, "ext": "mp4",
                    "protocol": "https", "http_headers": {},
                    "id": cache_key(page_url),
                }

        return None

    except Exception as exc:
        print(f"[snapwc] failed for {page_url}: {str(exc)[:200]}")
        return None


# ── Twitter / X ───────────────────────────────────────────────────────────────

_DESKTOP_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def extract_twitter(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """Extract Twitter/X media via the vxtwitter community API (no auth needed).

    vxtwitter mirrors tweet data including direct video.twimg.com URLs,
    bypassing Twitter's API auth wall. Falls back to HTML scan for edge cases.

    API: https://api.vxtwitter.com/twitter/status/{id}
    """
    m = re.search(r"/status/(\d+)", page_url)
    if not m:
        return None
    tweet_id = m.group(1)

    api_url = f"https://api.vxtwitter.com/twitter/status/{tweet_id}"
    hdrs = safe_headers({
        "User-Agent": _DESKTOP_UA,
        "Accept": "application/json",
    })
    body, status = fetch_with_retry(api_url, hdrs, timeout=10, max_retries=1)
    if not body or status not in (200, 201):
        print(f"[twitter] vxtwitter API returned {status} for {tweet_id}")
        return None

    try:
        data = json.loads(body)
    except Exception:
        return None

    media_items: list[dict[str, Any]] = data.get("media_extended") or []
    if not media_items:
        return None

    title = data.get("text") or f"Tweet by @{data.get('user_screen_name', 'unknown')}"
    author = data.get("user_name") or data.get("user_screen_name") or "unknown"
    thumbnail = data.get("user_profile_image_url")

    entries: list[dict[str, Any]] = []
    for item in media_items:
        url = item.get("url") or ""
        if not url.startswith("http"):
            continue
        media_type = item.get("type", "video")
        ext = guess_ext_from_url(url) or ("mp4" if media_type in ("video", "gif") else "jpg")
        thumb = item.get("thumbnail_url") or thumbnail
        entries.append({
            "id":        cache_key(url),
            "url":       url,
            "ext":       ext,
            "title":     title,
            "uploader":  author,
            "thumbnail": thumb,
            "protocol":  "m3u8_native" if ext == "m3u8" else "https",
            "http_headers": safe_headers({"Referer": "https://twitter.com/"}),
        })

    if not entries:
        return None

    print(f"[twitter] vxtwitter: {len(entries)} item(s) for tweet {tweet_id}")
    if len(entries) == 1:
        return entries[0]
    return {
        "_type":   "playlist",
        "id":      tweet_id,
        "title":   title,
        "entries": entries,
    }


# ── Redgifs ───────────────────────────────────────────────────────────────────

def extract_redgifs(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """Extract Redgifs video via the public temporary-auth API.

    Redgifs provides unauthenticated temporary tokens at /v2/auth/temporary that
    are bound to the requesting IP and user agent.  The token is then used to
    fetch the gif's HD/SD video URLs from /v2/gifs/{id}.
    """
    m = re.search(r"/(?:watch|ifr|gif)/([A-Za-z0-9]+)", page_url, re.IGNORECASE)
    if not m:
        return None
    gif_id = m.group(1).lower()

    ua = _DESKTOP_UA
    hdrs_base = safe_headers({"User-Agent": ua, "Accept": "application/json"})

    # Step 1: fetch temporary token (bound to our IP + UA)
    token_body, token_status = fetch_with_retry(
        "https://api.redgifs.com/v2/auth/temporary",
        hdrs_base, timeout=8, max_retries=1,
    )
    if not token_body or token_status not in (200, 201):
        print(f"[redgifs] failed to get temp token: HTTP {token_status}")
        return None
    try:
        token = json.loads(token_body).get("token", "")
    except Exception:
        return None
    if not token:
        return None

    # Step 2: fetch gif metadata with the auth token
    hdrs_auth = safe_headers({
        "User-Agent": ua,
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    })
    gif_body, gif_status = fetch_with_retry(
        f"https://api.redgifs.com/v2/gifs/{gif_id}",
        hdrs_auth, timeout=8, max_retries=0,
    )
    if not gif_body or gif_status not in (200, 201):
        print(f"[redgifs] API returned {gif_status} for {gif_id}")
        return None
    try:
        data = json.loads(gif_body)
    except Exception:
        return None

    gif = data.get("gif") or {}
    urls = gif.get("urls") or {}
    hd = urls.get("hd") or ""
    sd = urls.get("sd") or ""
    video_url = hd if hd.startswith("http") else (sd if sd.startswith("http") else "")
    if not video_url:
        return None

    title = gif.get("title") or gif.get("id") or gif_id
    thumb = (gif.get("thumbnail") or gif.get("poster") or "")
    print(f"[redgifs] {gif_id}: {video_url[:80]}")
    return {
        "id":      gif_id,
        "url":     video_url,
        "ext":     "mp4",
        "title":   title,
        "thumbnail": thumb if thumb.startswith("http") else None,
        "protocol": "https",
        "http_headers": safe_headers({
            "User-Agent": ua,
            "Referer": "https://www.redgifs.com/",
            "Authorization": f"Bearer {token}",
        }),
    }


def extract_bluesky(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """
    Extract media from Bluesky posts via the public AT Protocol AppView API.
    Handles video posts (HLS) and image posts (CDN fullsize).
    No auth required — uses public.api.bsky.app.
    """
    m = re.search(r"/profile/([^/?#]+)/post/([A-Za-z0-9]+)", page_url)
    if not m:
        return None
    actor = m.group(1)
    rkey = m.group(2)

    hdrs = safe_headers({"User-Agent": _DESKTOP_UA, "Accept": "application/json"})

    # Resolve handle → DID (skip if actor is already a DID)
    if actor.startswith("did:"):
        did = actor
    else:
        resolve_url = (
            f"https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle"
            f"?handle={urllib.parse.quote(actor, safe='')}"
        )
        body, status = fetch_with_retry(resolve_url, hdrs, timeout=10, max_retries=2)
        if not body or status != 200:
            print(f"[bluesky] handle resolve failed {status} for {actor!r}")
            return None
        try:
            did = json.loads(body).get("did", "")
        except Exception:
            return None
        if not did:
            return None

    at_uri = urllib.parse.quote(f"at://{did}/app.bsky.feed.post/{rkey}", safe="")
    thread_url = (
        f"https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread"
        f"?uri={at_uri}&depth=0&parentHeight=0"
    )
    body, status = fetch_with_retry(thread_url, hdrs, timeout=12, max_retries=2)
    if not body or status != 200:
        print(f"[bluesky] thread fetch failed {status} for {rkey!r}")
        return None

    try:
        data = json.loads(body)
    except Exception:
        return None

    post = (data.get("thread") or {}).get("post") or {}
    record = post.get("record") or {}
    embed = post.get("embed") or {}
    embed_type = embed.get("$type", "")
    text = (record.get("text") or "").strip()
    title = text[:200] if text else f"Bluesky post {rkey}"

    # --- Video ---
    if "video" in embed_type:
        playlist = embed.get("playlist", "")
        if playlist and playlist.startswith("http"):
            result: dict[str, Any] = {
                "id": rkey,
                "url": playlist,
                "ext": "mp4",
                "title": title,
                "protocol": "m3u8",
            }
            thumb = embed.get("thumbnail", "")
            if thumb and thumb.startswith("http"):
                result["thumbnail"] = thumb
            aspect = embed.get("aspectRatio") or {}
            if aspect.get("width") and aspect.get("height"):
                result["width"] = aspect["width"]
                result["height"] = aspect["height"]
            print(f"[bluesky] video {rkey}: {playlist[:80]}")
            return result

    # --- Images ---
    if "images" in embed_type:
        images = embed.get("images") or []
        entries: list[dict[str, Any]] = []
        for i, img in enumerate(images):
            fullsize = img.get("fullsize", "")
            if not fullsize or not fullsize.startswith("http"):
                continue
            aspect = img.get("aspectRatio") or {}
            entry: dict[str, Any] = {
                "id": f"{rkey}_{i}",
                "url": fullsize,
                "ext": "jpg",
                "title": img.get("alt") or title,
            }
            if aspect.get("width") and aspect.get("height"):
                entry["width"] = aspect["width"]
                entry["height"] = aspect["height"]
            thumb = img.get("thumb", "")
            if thumb and thumb.startswith("http"):
                entry["thumbnail"] = thumb
            entries.append(entry)
        if not entries:
            return None
        print(f"[bluesky] images {rkey}: {len(entries)} item(s)")
        if len(entries) == 1:
            return entries[0]
        return {"_type": "playlist", "id": rkey, "title": title, "entries": entries}

    print(f"[bluesky] no media found for {rkey!r} (embed type: {embed_type!r})")
    return None


def extract_pixiv(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """
    Extract all pages from a Pixiv illustration via the public AJAX API.
    Handles single-page artworks, multi-page manga, and ugoira animations.
    Requires Referer: https://www.pixiv.net/ for pximg.net CDN access.
    """
    m = (
        re.search(r"/artworks?/(\d+)", page_url)
        or re.search(r"illust_id=(\d+)", page_url)
    )
    if not m:
        return None
    illust_id = m.group(1)

    item_headers = safe_headers({
        "User-Agent": _DESKTOP_UA,
        "Referer": "https://www.pixiv.net/",
    })
    ajax_headers = safe_headers({
        **item_headers,
        "Accept": "application/json",
        **({"Cookie": cookies} if cookies else {}),
    })

    # Fetch all page URLs
    body, status_code = fetch_with_retry(
        f"https://www.pixiv.net/ajax/illust/{illust_id}/pages",
        ajax_headers, timeout=10, max_retries=1,
    )
    if not body or status_code != 200:
        print(f"[pixiv] pages API returned {status_code} for {illust_id}")
        return None

    try:
        data = json.loads(body)
    except Exception:
        return None

    pages = data.get("body") or []
    if not pages:
        return None

    # Fetch illustration metadata for the title (best-effort, no retries)
    title: str = illust_id
    meta_body, meta_status = fetch_with_retry(
        f"https://www.pixiv.net/ajax/illust/{illust_id}",
        ajax_headers, timeout=8, max_retries=0,
    )
    if meta_body and meta_status == 200:
        try:
            t = (json.loads(meta_body).get("body") or {}).get("illustTitle", "")
            if t:
                title = t
        except Exception:
            pass

    entries: list[dict[str, Any]] = []
    for i, page in enumerate(pages):
        url = (page.get("urls") or {}).get("original", "")
        if not url or not url.startswith("http"):
            url = (page.get("urls") or {}).get("regular", "")
        if not url or not url.startswith("http"):
            continue
        ext = guess_ext_from_url(url) or "jpg"
        entries.append({
            "id": f"{illust_id}_{i}",
            "url": url,
            "ext": ext,
            "title": f"{title} (p{i + 1})" if len(pages) > 1 else title,
            "http_headers": item_headers,
        })

    if not entries:
        return None

    print(f"[pixiv] {illust_id}: {len(entries)} page(s)")
    if len(entries) == 1:
        return entries[0]
    return {"_type": "playlist", "id": illust_id, "title": title, "entries": entries}


def extract_tumblr(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """
    Extract media from Tumblr photo/video/animated posts via the public
    /api/read/json endpoint — no API key required for public posts.
    """
    parsed = urllib.parse.urlsplit(page_url)

    # Modern URL: www.tumblr.com/{blogname}/{post_id}[/slug]
    www_m = re.search(r"www\.tumblr\.com/([^/?#]+)/(\d{15,})", page_url)
    if www_m:
        blog_name = www_m.group(1)
        post_id = www_m.group(2)
        host = f"{blog_name}.tumblr.com"
    else:
        # Legacy URL: {blogname}.tumblr.com/post/{id}[/slug]
        m = re.search(r"/post/(\d+)", parsed.path)
        if not m:
            return None
        post_id = m.group(1)
        # The blog may be on a custom domain; build the API URL from the request host
        host = parsed.netloc

    api_url = f"https://{host}/api/read/json?id={post_id}"

    hdrs = safe_headers({
        "User-Agent": _DESKTOP_UA,
        "Accept": "application/json, text/javascript, */*",
        "Referer": f"https://{host}/",
    })
    body, status_code = fetch_with_retry(api_url, hdrs, timeout=10, max_retries=1)
    if not body or status_code != 200:
        print(f"[tumblr] API returned {status_code} for post {post_id}")
        return None

    # Response is JSONP: `var tumblr_api_read = {...};` — strip the variable wrapper
    raw = body.decode("utf-8", errors="replace").strip()
    if raw.startswith("var tumblr_api_read"):
        raw = re.sub(r"^var\s+tumblr_api_read\s*=\s*", "", raw, count=1)
        raw = raw.rstrip(";").strip()

    try:
        data = json.loads(raw)
    except Exception:
        return None

    posts = data.get("posts") or []
    if not posts:
        return None
    post = posts[0]
    post_type = post.get("type", "")

    # ── Video ──────────────────────────────────────────────────────────────────
    if post_type == "video":
        # `video-source` may contain a direct URL to the original MP4
        video_src = post.get("video-source", "")
        if video_src and video_src.startswith("http") and any(
            ext in video_src.lower() for ext in (".mp4", ".mov", ".webm")
        ):
            ext = guess_ext_from_url(video_src) or "mp4"
            result: dict[str, Any] = {
                "id": post_id,
                "url": video_src,
                "ext": ext,
                "title": post.get("slug") or f"Tumblr post {post_id}",
                "protocol": "https",
            }
            thumb = post.get("thumbnail-url", "")
            if thumb and thumb.startswith("http"):
                result["thumbnail"] = thumb
            print(f"[tumblr] video {post_id}: {video_src[:80]}")
            return result
        # Fall through to HTML scan for embedded videos

    # ── Photo / GIF ────────────────────────────────────────────────────────────
    if post_type in ("photo", "panorama", "link"):
        photos = post.get("photos") or []
        if not photos:
            # Single-photo post: highest-res URL is at photo-url-1280
            for size in (1280, 500, 400):
                url = post.get(f"photo-url-{size}", "")
                if url and url.startswith("http"):
                    photos = [{"photo-url-1280": url}]
                    break
        if not photos:
            return None

        title = post.get("slug") or f"Tumblr post {post_id}"
        entries: list[dict[str, Any]] = []
        for i, photo in enumerate(photos):
            url = photo.get("photo-url-1280") or photo.get("photo-url-500") or ""
            if not url or not url.startswith("http"):
                continue
            ext = guess_ext_from_url(url) or "jpg"
            entries.append({
                "id": f"{post_id}_{i}",
                "url": url,
                "ext": ext,
                "title": f"{title} #{i + 1}" if len(photos) > 1 else title,
                "http_headers": safe_headers({
                    "Referer": f"https://{host}/",
                    "User-Agent": _DESKTOP_UA,
                }),
            })
        if not entries:
            return None
        print(f"[tumblr] photo {post_id}: {len(entries)} image(s)")
        if len(entries) == 1:
            return entries[0]
        return {"_type": "playlist", "id": post_id, "title": title, "entries": entries}

    return None


def extract_mastodon(page_url: str, cookies: str | None) -> dict[str, Any] | None:
    """
    Extract media from any Mastodon instance via the public REST API.
    Detects status by snowflake ID in the URL path — works across all instances
    without needing a whitelist. No auth required for public posts.
    """
    parsed = urllib.parse.urlsplit(page_url)
    # Mastodon status URL patterns:
    # /@{user}/{snowflake_id}       -- primary format
    # /users/{user}/statuses/{id}   -- older ActivityPub format
    m = re.search(
        r"/(?:@[^/?#]+|users/[^/?#]+/statuses)/(\d{17,20})(?:[/?#]|$)",
        parsed.path,
    )
    if not m:
        return None
    status_id = m.group(1)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    hdrs = safe_headers({"User-Agent": _DESKTOP_UA, "Accept": "application/json"})
    body, status_code = fetch_with_retry(
        f"{base_url}/api/v1/statuses/{status_id}",
        hdrs, timeout=10, max_retries=1,
    )
    if not body or status_code != 200:
        print(f"[mastodon] API returned {status_code} for {base_url}/…/{status_id}")
        return None

    try:
        data = json.loads(body)
    except Exception:
        return None

    attachments = data.get("media_attachments") or []
    if not attachments:
        return None

    raw_content = data.get("content") or ""
    title = re.sub(r"<[^>]+>", "", raw_content).strip()[:200] or f"Mastodon post {status_id}"

    entries: list[dict[str, Any]] = []
    for att in attachments:
        url = att.get("url", "")
        if not url or not url.startswith("http"):
            continue
        att_type = att.get("type", "")
        ext = guess_ext_from_url(url) or ("mp4" if att_type in ("video", "gifv") else "jpg")
        entry: dict[str, Any] = {
            "id": att.get("id") or cache_key(url),
            "url": url,
            "ext": ext,
            "title": att.get("description") or title,
        }
        preview = att.get("preview_url", "")
        if preview and preview.startswith("http"):
            entry["thumbnail"] = preview
        meta = (att.get("meta") or {}).get("original") or {}
        if meta.get("width") and meta.get("height"):
            entry["width"] = meta["width"]
            entry["height"] = meta["height"]
        entries.append(entry)

    if not entries:
        return None

    print(f"[mastodon] {base_url} status {status_id}: {len(entries)} attachment(s)")
    if len(entries) == 1:
        return entries[0]
    return {"_type": "playlist", "id": status_id, "title": title, "entries": entries}

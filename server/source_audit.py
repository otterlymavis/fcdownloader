"""Source audit and candidate ranking helpers for extractor diagnostics."""
from __future__ import annotations

from typing import Any

from utils import safe_headers, safe_text


def sanitize_audit(raw: Any, limit: int = 300) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = safe_text(item.get("url"))[:4096]
        strategy = safe_text(item.get("strategy"))[:120]
        source = safe_text(item.get("source"))[:160]
        field_path = safe_text(item.get("fieldPath"))[:200]
        key = (url, strategy, source, field_path)
        if key in seen:
            continue
        seen.add(key)
        clean: dict[str, Any] = {}
        for k, v in item.items():
            if not isinstance(k, str):
                continue
            if k.lower() in {"cookie", "cookies", "authorization"}:
                continue
            if isinstance(v, (str, int, float, bool)) or v is None:
                clean[k] = v if not isinstance(v, str) else safe_text(v)[:4096]
            elif isinstance(v, dict):
                clean[k] = {
                    safe_text(kk)[:80]: safe_text(vv)[:1000]
                    for kk, vv in v.items()
                    if isinstance(kk, str)
                    and kk.lower() not in {"cookie", "cookies", "authorization"}
                    and isinstance(vv, (str, int, float, bool))
                }
        if clean:
            out.append(clean)
        if len(out) >= limit:
            break
    return out


def audit_entry(
    *,
    strategy: str,
    source: str,
    url: str | None = None,
    selected: bool = False,
    rejected_reason: str | None = None,
    field_path: str | None = None,
    mime_type: str | None = None,
    width: int | None = None,
    height: int | None = None,
    bitrate: int | None = None,
    content_length: int | None = None,
    status: int | None = None,
    headers: dict[str, str] | None = None,
    notes: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "strategy": strategy,
        "source": source,
        "selected": selected,
    }
    if url:
        entry["url"] = url
    if rejected_reason:
        entry["rejectedReason"] = rejected_reason
    if field_path:
        entry["fieldPath"] = field_path
    if mime_type:
        entry["mimeType"] = mime_type
    if width:
        entry["width"] = width
    if height:
        entry["height"] = height
    if bitrate:
        entry["bitrate"] = bitrate
    if content_length:
        entry["contentLength"] = content_length
    if status:
        entry["status"] = status
    if headers:
        entry["headersNeeded"] = {
            k: v for k, v in safe_headers(headers).items()
            if k.lower() in {"accept", "accept-language", "origin", "range", "referer", "user-agent"}
        }
    if notes:
        entry["notes"] = notes
    for key, value in extra.items():
        if value is not None:
            entry[key] = value
    return sanitize_audit([entry])[0]


def add_audit(info: dict[str, Any] | None, audit: list[dict[str, Any]]) -> dict[str, Any] | None:
    if info is not None and audit:
        existing = sanitize_audit(info.get("_source_audit"))
        info["_source_audit"] = sanitize_audit([*existing, *audit])
    return info


def format_audit(info: dict[str, Any], strategy: str, source: str) -> list[dict[str, Any]]:
    audit: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    for fmt in info.get("requested_formats") or []:
        if isinstance(fmt, dict) and fmt.get("format_id"):
            selected_ids.add(str(fmt.get("format_id")))
    if info.get("format_id"):
        selected_ids.add(str(info.get("format_id")))

    for fmt in info.get("formats") or []:
        if not isinstance(fmt, dict) or not fmt.get("url"):
            continue
        format_id = safe_text(fmt.get("format_id"))
        has_video = fmt.get("vcodec") not in (None, "none")
        has_audio = fmt.get("acodec") not in (None, "none")
        selected = bool(format_id and format_id in selected_ids)
        reason = None if selected else "lower ranked than selected format"
        if not has_video and not has_audio:
            reason = "format has no audio or video codec"
        audit.append(audit_entry(
            strategy=strategy,
            source=source,
            url=safe_text(fmt.get("url")),
            selected=selected,
            rejected_reason=reason,
            width=_int(fmt.get("width")),
            height=_int(fmt.get("height")),
            bitrate=_int(fmt.get("tbr") or fmt.get("vbr") or fmt.get("abr")),
            content_length=_int(fmt.get("filesize") or fmt.get("filesize_approx")),
            mime_type=fmt.get("mime_type"),
            formatId=format_id or None,
            ext=fmt.get("ext"),
            protocol=fmt.get("protocol"),
            hasAudio=has_audio,
            hasVideo=has_video,
        ))
    return sanitize_audit(audit)


def score_candidate(candidate: dict[str, Any]) -> tuple[int, int, int, int]:
    """Sort key for media variants: complete, resolution, bitrate, size."""
    has_video = candidate.get("hasVideo", True)
    has_audio = candidate.get("hasAudio", True)
    complete = 2 if has_video and has_audio else 1 if has_video or has_audio else 0
    height = _int(candidate.get("height")) or 0
    width = _int(candidate.get("width")) or 0
    bitrate = _int(candidate.get("bitrate") or candidate.get("bandwidth") or candidate.get("tbr")) or 0
    size = _int(candidate.get("contentLength") or candidate.get("filesize")) or 0
    return complete, height * width, bitrate, size


def _int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None

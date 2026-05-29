"""
Typed request/response models and failure taxonomy for fcdownloader-extractor.

Stable contract: clients depend on the JSON shapes defined here. Changing a
field name here is a breaking API change — add a new field instead and
deprecate the old one.
"""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, field_validator


# ── Failure taxonomy ──────────────────────────────────────────────────────────


class ErrorCode(str, Enum):
    """Typed failure codes returned in the `error_code` field of 4xx/5xx JSON.

    Clients should switch on this value, not on the HTTP status code alone,
    to decide how to surface the error to the user.
    """

    AUTH_REQUIRED     = "AUTH_REQUIRED"
    """The site requires a logged-in session.  User must supply cookies."""

    SABR_UNSUPPORTED  = "SABR_UNSUPPORTED"
    """YouTube SABR format could not be resolved in skip_download mode.
    The /ytdl-stream proxy endpoint is the resolution path."""

    GEO_BLOCKED       = "GEO_BLOCKED"
    """Content is not available in the server's region (Fly.io iad/USA)."""

    RATE_LIMITED      = "RATE_LIMITED"
    """Too many requests from this IP — caller should back off."""

    FORMAT_UNAVAILABLE = "FORMAT_UNAVAILABLE"
    """No format matched the requested spec (all strategies exhausted)."""

    STREAM_TIMEOUT    = "STREAM_TIMEOUT"
    """Download or stream took longer than the configured timeout."""

    CLIENT_ABORT      = "CLIENT_ABORT"
    """Client disconnected before the stream completed."""

    STREAM_STALLED    = "STREAM_STALLED"
    """Stream produced no bytes for an extended period."""

    INVALID_URL       = "INVALID_URL"
    """The supplied URL is malformed or uses an unsupported protocol."""

    OVERSIZED_COOKIES = "OVERSIZED_COOKIES"
    """Cookie payload exceeded the 32 KB safety limit."""

    INTERNAL_ERROR    = "INTERNAL_ERROR"
    """Unexpected server-side failure (check logs)."""


# ── Request models ────────────────────────────────────────────────────────────


class ExtractRequest(BaseModel):
    pageUrl: str
    referer: str | None = None
    cookies: str | None = None
    pageHtml: str | None = None
    proxy: str | None = None
    subtitles: bool = False
    subLangs: str = "en"

    @field_validator("pageUrl", mode="before")
    @classmethod
    def page_url_not_empty(cls, v: Any) -> Any:
        if not v or not str(v).strip():
            raise ValueError("pageUrl must not be empty")
        return v


class DownloadRequest(BaseModel):
    pageUrl: str
    referer: str | None = None
    cookies: str | None = None
    formatId: str | None = None
    audioOnly: bool = False
    subtitles: bool = False
    subLangs: str = "en"
    embedChapters: bool = False
    concurrentFragments: int = 1
    proxy: str | None = None


class ProxyRequest(BaseModel):
    url: str
    referer: str | None = None
    cookies: str | None = None
    filename: str | None = None


class PlaylistRequest(BaseModel):
    pageUrl: str
    referer: str | None = None
    cookies: str | None = None
    proxy: str | None = None


# ── Response helpers ──────────────────────────────────────────────────────────


def error_response(
    code: ErrorCode,
    message: str,
    resolution: str | None = None,
    http_status: int = 500,
) -> dict[str, Any]:
    """Build the canonical error body.

    Callers should raise HTTPException(http_status, detail=error_response(...))
    after calling this function — FastAPI's detail field accepts dicts.
    """
    out: dict[str, Any] = {
        "status":     "error",
        "error_code": code.value,
        "message":    message,
    }
    if resolution:
        out["resolution"] = resolution
    return out


def success_response(
    data: dict[str, Any],
    strategy: str | None = None,
    delivery_mode: str | None = None,
    requires_auth: bool = False,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Wrap an extraction result with the stable API envelope."""
    out: dict[str, Any] = {"status": "ok", **data}
    if strategy:
        out["strategy"] = strategy
    if delivery_mode:
        out["delivery_mode"] = delivery_mode
    if requires_auth:
        out["requires_auth"] = True
    if request_id:
        out["request_id"] = request_id
    return out

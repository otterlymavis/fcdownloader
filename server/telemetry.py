"""
Structured telemetry for fcdownloader-extractor.

Provides a per-request context object that accumulates strategy attempts and
emits a single structured log line at the end of the request.  Never logs
raw cookie values or auth headers.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass
class StrategyRecord:
    """Records one strategy attempt within an extraction pipeline run."""

    name: str
    success: bool
    duration_ms: float = 0.0
    reason: str | None = None         # failure reason (no sensitive data)
    fatal: bool = False


@dataclass
class RequestContext:
    """Accumulated telemetry for a single API request.

    Create one at the start of each route handler, pass it through to service
    functions, and call .emit() before returning.
    """

    request_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    endpoint: str = ""
    page_url_host: str = ""           # host only, never path (may contain IDs)
    extractor: str | None = None      # yt-dlp extractor name
    strategy_used: str | None = None  # winning strategy name
    fallback_depth: int = 0           # how many strategies were tried before win
    auth_provided: bool = False       # True if caller supplied cookies
    yt_dlp_runtime_ms: float = 0.0
    stream_duration_ms: float = 0.0
    bytes_streamed: int = 0
    subprocess_exit_code: int | None = None
    strategy_log: list[StrategyRecord] = field(default_factory=list)
    _start: float = field(default_factory=time.monotonic, repr=False)

    # ── Strategy tracking ─────────────────────────────────────────────────────

    def record_strategy(
        self,
        name: str,
        success: bool,
        duration_ms: float = 0.0,
        reason: str | None = None,
        fatal: bool = False,
    ) -> None:
        self.strategy_log.append(
            StrategyRecord(
                name=name,
                success=success,
                duration_ms=duration_ms,
                reason=reason,
                fatal=fatal,
            )
        )
        if success and self.strategy_used is None:
            self.strategy_used = name
            self.fallback_depth = len(self.strategy_log) - 1

    # ── Emission ──────────────────────────────────────────────────────────────

    def emit(self, status: str = "ok", error_code: str | None = None) -> None:
        """Print one structured log line.  Safe to call multiple times."""
        total_ms = (time.monotonic() - self._start) * 1000
        parts: list[str] = [
            f"rid={self.request_id}",
            f"ep={self.endpoint}",
            f"host={self.page_url_host or '-'}",
            f"status={status}",
        ]
        if error_code:
            parts.append(f"error={error_code}")
        if self.extractor:
            parts.append(f"extractor={self.extractor}")
        if self.strategy_used:
            parts.append(f"strategy={self.strategy_used}")
        parts.append(f"fallback_depth={self.fallback_depth}")
        parts.append(f"auth={'yes' if self.auth_provided else 'no'}")
        if self.bytes_streamed:
            parts.append(f"bytes={self.bytes_streamed}")
        if self.subprocess_exit_code is not None:
            parts.append(f"rc={self.subprocess_exit_code}")
        parts.append(f"total_ms={total_ms:.0f}")

        # Strategy summary — names only, no reasons (reasons can be noisy)
        attempts = [s.name + ("✓" if s.success else "✗") for s in self.strategy_log]
        if attempts:
            parts.append("strategies=[" + ",".join(attempts) + "]")

        print("[telemetry] " + " ".join(parts), flush=True)

    def to_diagnostics(self) -> list[dict[str, Any]]:
        """Return strategy log in the format the /extract response embeds."""
        return [
            {
                "strategy": s.name,
                "success": s.success,
                **({"reason": s.reason} if s.reason else {}),
                **({"fatal": True} if s.fatal else {}),
            }
            for s in self.strategy_log
        ]


def make_context(endpoint: str, page_url: str, auth_provided: bool) -> RequestContext:
    """Factory: extract the host from page_url for safe logging."""
    import urllib.parse
    try:
        host = urllib.parse.urlparse(page_url).hostname or ""
    except Exception:
        host = ""
    return RequestContext(
        endpoint=endpoint,
        page_url_host=host,
        auth_provided=auth_provided,
    )

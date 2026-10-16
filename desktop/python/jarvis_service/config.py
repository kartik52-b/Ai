"""Configuration for the JARVIS local service.

Secrets are read from the environment only. This module never logs or returns
secret values, and it refuses any configuration that would expose the service
on a non-loopback interface.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from . import PROTOCOL_VERSION

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_LLM_MODEL = "openai/gpt-4o-mini"

MAX_BODY_BYTES = 64 * 1024


def default_state_dir() -> Path:
    override = os.environ.get("JARVIS_STATE_DIR")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    else:
        base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "jarvis"


def _split_list(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(part.strip() for part in value.replace(";", ",").split(",") if part.strip())


def _split_paths(value: str | None) -> tuple[Path, ...]:
    if not value:
        return ()
    parts = [p for p in value.split(os.pathsep) if p.strip()]
    return tuple(Path(p).expanduser() for p in parts)


@dataclass(frozen=True)
class Settings:
    """Immutable runtime settings resolved from the environment."""

    host: str = "127.0.0.1"
    port: int = 0
    token: str = ""
    state_dir: Path = field(default_factory=default_state_dir)
    site_allowlist: tuple[str, ...] = ()
    search_roots: tuple[Path, ...] = ()
    llm_api_key: str = ""
    llm_base_url: str = DEFAULT_LLM_BASE_URL
    llm_model: str = DEFAULT_LLM_MODEL
    llm_timeout_s: float = 30.0
    wake_threshold: float = 0.55
    command_min_interval_s: float = 0.35
    max_body_bytes: int = MAX_BODY_BYTES
    token_generated: bool = False

    # ---------------------------------------------------------------- paths
    @property
    def handshake_path(self) -> Path:
        return self.state_dir / "service.json"

    @property
    def sites_path(self) -> Path:
        return self.state_dir / "sites.json"

    @property
    def settings_path(self) -> Path:
        return self.state_dir / "settings.json"

    # --------------------------------------------------------------- helpers
    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_api_key)

    def origin_allowed(self, origin: str | None) -> bool:
        """Only local renderer origins may call the service.

        A missing Origin header is allowed (Electron main-process requests and
        `file://` renderers send none or `null`); every remote origin is denied.
        """
        if not origin or origin == "null":
            return True
        parsed = urlparse(origin)
        if parsed.scheme.lower() != "http":
            return False
        return parsed.hostname in LOOPBACK_HOSTS

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "Settings":
        env = os.environ if environ is None else environ

        host = (env.get("JARVIS_HOST") or "127.0.0.1").strip()
        if host not in LOOPBACK_HOSTS:
            raise ValueError(
                f"refusing to bind JARVIS_HOST={host!r}: only loopback interfaces are permitted"
            )

        raw_port = (env.get("JARVIS_PORT") or "0").strip()
        try:
            port = int(raw_port)
        except ValueError as exc:  # pragma: no cover - defensive
            raise ValueError(f"JARVIS_PORT must be an integer, got {raw_port!r}") from exc
        if not 0 <= port <= 65535:
            raise ValueError("JARVIS_PORT must be between 0 and 65535")

        token = (env.get("JARVIS_TOKEN") or "").strip()
        token_generated = False
        if not token:
            # Standalone mode (developer running the service by hand).
            token = secrets.token_urlsafe(32)
            token_generated = True

        try:
            threshold = float((env.get("JARVIS_WAKE_THRESHOLD") or "0.55").strip())
        except ValueError:
            threshold = 0.55
        threshold = min(max(threshold, 0.1), 0.95)

        try:
            timeout = float((env.get("LLM_TIMEOUT_SECONDS") or "30").strip())
        except ValueError:
            timeout = 30.0
        timeout = min(max(timeout, 1.0), 120.0)

        try:
            interval = float((env.get("JARVIS_COMMAND_MIN_INTERVAL") or "0.35").strip())
        except ValueError:
            interval = 0.35
        interval = min(max(interval, 0.0), 10.0)

        base_url = (env.get("LLM_BASE_URL") or DEFAULT_LLM_BASE_URL).strip().rstrip("/")
        if base_url and urlparse(base_url).hostname not in LOOPBACK_HOSTS and not base_url.startswith("https://"):
            raise ValueError(
                "LLM_BASE_URL must use https so the API key is never sent in the clear "
                "(loopback addresses are exempt for local testing)"
            )

        return cls(
            host=host,
            port=port,
            token=token,
            token_generated=token_generated,
            state_dir=default_state_dir(),
            site_allowlist=_split_list(env.get("JARVIS_SITE_ALLOWLIST")),
            search_roots=_split_paths(env.get("JARVIS_SEARCH_ROOTS")),
            llm_api_key=(env.get("LLM_API_KEY") or env.get("JARVIS_LLM_API_KEY") or "").strip(),
            llm_base_url=base_url,
            llm_model=(env.get("LLM_MODEL") or DEFAULT_LLM_MODEL).strip(),
            llm_timeout_s=timeout,
            wake_threshold=threshold,
            command_min_interval_s=interval,
        )

    def handshake(self, port: int, pid: int) -> dict[str, object]:
        """Public handshake payload — deliberately contains no token."""
        return {
            "protocol": PROTOCOL_VERSION,
            "service": "jarvis-local",
            "host": self.host,
            "port": port,
            "pid": pid,
        }

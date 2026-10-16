"""Request validation, token auth, origin checks and secret redaction.

Every inbound request passes through :func:`validate_request` before a handler
sees it. Errors carry a stable `code` and a human-readable message that never
echoes secrets or stack traces.
"""

from __future__ import annotations

import hmac
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

MAX_STRING = 2_000
MAX_KEYS = 24
MAX_LIST_ITEMS = 50
_MAX_CONTAINER_FIELDS = 24
_PRIMITIVES = (str, int, float, bool, type(None))

_SECRET_PATTERNS = (
    re.compile(r"(?i)\b(sk|pk|rk)-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{8,}"),
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*\S+"),
)


class RequestError(Exception):
    """A rejected request. `status` maps to the HTTP status code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def payload(self) -> dict[str, Any]:
        return {"ok": False, "error": {"code": self.code, "message": self.message}}


def bad_request(code: str, message: str) -> RequestError:
    return RequestError(400, code, message)


def unauthorized(message: str = "invalid or missing local service token") -> RequestError:
    return RequestError(401, "unauthorized", message)


def forbidden(code: str, message: str) -> RequestError:
    return RequestError(403, code, message)


def redact(value: object) -> str:
    """Strip credential-shaped substrings from anything destined for a log."""
    text = value if isinstance(value, str) else repr(value)
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda m: m.group(0).split(":")[0][:12] + "[redacted]", text)
    return text


def token_matches(expected: str, presented: str | None) -> bool:
    """Constant-time token comparison. Empty/absent tokens never match."""
    if not expected or not presented:
        return False
    return hmac.compare_digest(expected, presented)


def check_origin(origin: str | None, *, allow: bool) -> None:
    if not allow:
        raise forbidden("origin_rejected", "request origin is not permitted")


def parse_json(
    body: bytes, *, max_bytes: int, container_keys: tuple[str, ...] = ()
) -> dict[str, Any]:
    """Parse a request body: a flat object of primitives.

    A named `container_keys` entry may hold one level of nesting (the `args`
    object, the `history` array); everything else is rejected, so no request can
    smuggle an arbitrary structure into a handler.
    """
    if len(body) > max_bytes:
        raise RequestError(413, "payload_too_large", f"payload exceeds {max_bytes} bytes")
    if not body:
        return {}
    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise bad_request("invalid_json", "body must be valid UTF-8 JSON") from None
    if not isinstance(decoded, dict):
        raise bad_request("invalid_payload", "body must be a JSON object")
    if len(decoded) > MAX_KEYS:
        raise bad_request("too_many_fields", f"at most {MAX_KEYS} fields are accepted")
    for key, value in decoded.items():
        if not isinstance(key, str):
            raise bad_request("invalid_field", "field names must be strings")
        if isinstance(value, (dict, list)):
            if key in container_keys:
                _validate_container(key, value)
                continue
            raise bad_request("unsupported_field", f"field {key!r} must be a primitive value")
        _validate_primitive(key, value)
    return decoded


def _validate_primitive(key: str, value: Any) -> None:
    if not isinstance(value, _PRIMITIVES):
        raise bad_request("unsupported_field", f"field {key!r} has an unsupported type")
    if isinstance(value, str) and len(value) > MAX_STRING:
        raise bad_request("field_too_long", f"field {key!r} is too long")


def _validate_container(key: str, value: Any) -> None:
    if isinstance(value, dict):
        if len(value) > _MAX_CONTAINER_FIELDS:
            raise bad_request("too_many_fields", f"field {key!r} has too many entries")
        for inner_key, inner_value in value.items():
            if not isinstance(inner_key, str) or len(inner_key) > 64:
                raise bad_request("invalid_field", f"field {key!r} has an invalid key")
            if isinstance(inner_value, (dict, list)):
                raise bad_request("unsupported_field", f"{key}.{inner_key} must be a primitive value")
            _validate_primitive(f"{key}.{inner_key}", inner_value)
        return

    if len(value) > MAX_LIST_ITEMS:
        raise bad_request("too_many_items", f"field {key!r} has too many items")
    for item in value:
        if isinstance(item, dict):
            if len(item) > 8:
                raise bad_request("too_many_fields", f"an item in {key!r} has too many fields")
            for inner_key, inner_value in item.items():
                if not isinstance(inner_key, str) or isinstance(inner_value, (dict, list)):
                    raise bad_request("unsupported_field", f"items in {key!r} must be flat")
                _validate_primitive(f"{key} item", inner_value)
        elif isinstance(item, list):
            raise bad_request("unsupported_field", f"items in {key!r} must not be nested")
        else:
            _validate_primitive(key, item)


@dataclass
class RateLimiter:
    """Minimum-interval throttle so a runaway voice loop cannot hammer actions."""

    min_interval_s: float = 0.35
    _last: dict[str, float] = field(default_factory=dict)

    def check(self, key: str, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        previous = self._last.get(key)
        if previous is not None and current - previous < self.min_interval_s:
            raise RequestError(
                429, "throttled", "the previous request is still being processed — slow down"
            )
        self._last[key] = current

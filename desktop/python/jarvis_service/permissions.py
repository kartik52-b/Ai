"""Permission policy and the approval store.

Rules (see docs/DESKTOP-AUDIT.md):
* read-only commands run directly;
* approved simple actions run directly;
* anything sensitive needs a *fresh*, single-use approval bound to the exact
  command + arguments, so a previous "yes" can never be replayed;
* destructive, privileged, and script-running capabilities are not implemented
  at all — :func:`evaluate` reports them as blocked.
"""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Iterator, Literal

from . import registry
from .security import RequestError, forbidden

DecisionStatus = Literal["allow", "confirm", "blocked"]

APPROVAL_TTL_SECONDS = 90.0

BLOCKED_MESSAGE = (
    "Blocked by policy: JARVIS never deletes files, installs software, changes system "
    "settings, elevates privileges, or runs scripts."
)


@dataclass(frozen=True)
class Decision:
    status: DecisionStatus
    reason: str
    summary: str


@dataclass(frozen=True)
class PendingApproval:
    request_id: str
    name: str
    fingerprint: str
    summary: str
    created_at: float
    expires_at: float

    def public(self) -> dict[str, Any]:
        return {
            "requestId": self.request_id,
            "command": self.name,
            "summary": self.summary,
            "expiresInSeconds": round(max(self.expires_at - time.time(), 0.0), 1),
        }


def fingerprint(name: str, args: dict[str, Any]) -> str:
    """Stable hash binding an approval to one exact command + arguments."""
    payload = json.dumps({"name": name, "args": args}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def evaluate(spec: registry.CommandSpec, args: dict[str, Any]) -> Decision:
    name = spec.name
    summary = spec.summary(args)

    if registry.DENIED_NAME_PATTERN.search(name) or spec.danger == registry.BLOCKED:
        return Decision("blocked", BLOCKED_MESSAGE, summary)
    if spec.danger == registry.READ:
        return Decision("allow", "read-only local information", summary)
    if spec.danger == registry.ACTION:
        return Decision("allow", "approved simple action", summary)
    return Decision("confirm", "sensitive action requires a fresh confirmation", summary)


class NeedsApproval(Exception):
    """Raised by a handler that discovered it needs consent for these arguments."""

    def __init__(self, summary: str) -> None:
        super().__init__(summary)
        self.summary = summary


#: True only while a handler runs behind a freshly consumed, single-use approval.
_APPROVED: contextvars.ContextVar[bool] = contextvars.ContextVar("jarvis_approved", default=False)


def approval_granted() -> bool:
    return _APPROVED.get()


@contextlib.contextmanager
def approval_context(granted: bool) -> Iterator[None]:
    token = _APPROVED.set(granted)
    try:
        yield
    finally:
        _APPROVED.reset(token)


class ApprovalStore:
    """Single-use, expiring, argument-bound approvals."""

    def __init__(self, ttl_s: float = APPROVAL_TTL_SECONDS) -> None:
        self.ttl_s = ttl_s
        self._pending: dict[str, PendingApproval] = {}

    def issue(self, name: str, args: dict[str, Any], summary: str) -> PendingApproval:
        self._purge()
        request = PendingApproval(
            request_id=secrets.token_urlsafe(18),
            name=name,
            fingerprint=fingerprint(name, args),
            summary=summary,
            created_at=time.time(),
            expires_at=time.time() + self.ttl_s,
        )
        self._pending[request.request_id] = request
        return request

    def approve(self, request_id: str) -> PendingApproval:
        self._purge()
        request = self._pending.get(request_id)
        if request is None:
            raise forbidden(
                "approval_invalid",
                "this approval request is unknown or has expired — ask again to regenerate it",
            )
        return request

    def consume(self, request_id: str, name: str, args: dict[str, Any]) -> PendingApproval:
        """Verify and burn the approval for exactly this command + arguments."""
        request = self.approve(request_id)
        if request.name != name or request.fingerprint != fingerprint(name, args):
            raise forbidden(
                "approval_mismatch",
                "this approval does not match the requested action — approve the exact action again",
            )
        del self._pending[request_id]
        return request

    def reject(self, request_id: str) -> None:
        self._purge()
        self._pending.pop(request_id, None)

    def pending(self) -> list[dict[str, Any]]:
        self._purge()
        return [item.public() for item in self._pending.values()]

    def _purge(self) -> None:
        now = time.time()
        for key in [k for k, v in self._pending.items() if v.expires_at <= now]:
            del self._pending[key]

    def check_request_id(self, value: object) -> str:
        if not isinstance(value, str) or not value.strip():
            raise RequestError(400, "invalid_approval", "requestId must be a non-empty string")
        return value.strip()

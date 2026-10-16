"""The restricted localhost interface.

Bound to loopback only. Every request must carry the per-session token, come
from a local origin, stay under the body-size cap, and be JSON with primitive
fields. Routes are an explicit allowlist — unknown paths are 404.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from . import PROTOCOL_VERSION
from .commands import SiteAllowlist, build_registry, execute, interpret_local
from .config import LOOPBACK_HOSTS, Settings
from .llm import LlmClient, LlmUnavailable, describe_error, offline_reply
from .permissions import ApprovalStore
from .registry import catalog, require_command, validate_args
from .security import (
    RateLimiter,
    RequestError,
    forbidden,
    parse_json,
    redact,
    token_matches,
    unauthorized,
)
from .speech import SpeechStack

log = logging.getLogger("jarvis.server")

MAX_EVENTS = 500
HARD_DRAIN_BYTES = 1_048_576


class JarvisService:
    """Route logic, independent of HTTP so it can be driven directly in tests."""

    def __init__(self, settings: Settings, *, speech: SpeechStack | None = None) -> None:
        self.settings = settings
        self.sites = SiteAllowlist.load(settings)
        build_registry(settings, self.sites)
        self.approvals = ApprovalStore()
        self.llm = LlmClient(settings)
        self.started_at = time.time()
        self.pid = os.getpid()
        self._events: deque[dict[str, Any]] = deque(maxlen=MAX_EVENTS)
        self._event_lock = threading.Lock()
        self._sequence = 0
        self._throttle = RateLimiter(min_interval_s=settings.command_min_interval_s)
        self.speech = speech or SpeechStack(settings, self.emit)
        self._shutdown_hook: Callable[[], None] | None = None

    # ---------------------------------------------------------------- events
    def emit(self, event: dict[str, Any]) -> None:
        with self._event_lock:
            self._sequence += 1
            payload = {"seq": self._sequence, "at": time.time(), **event}
            self._events.append(payload)

    def events_since(self, cursor: int) -> dict[str, Any]:
        with self._event_lock:
            items = [e for e in self._events if int(e.get("seq", 0)) > cursor]
            return {"ok": True, "cursor": self._sequence, "events": items}

    def on_shutdown(self, hook: Callable[[], None]) -> None:
        self._shutdown_hook = hook

    # --------------------------------------------------------------- routing
    def dispatch(self, method: str, path: str, query: dict[str, list[str]], body: bytes) -> dict[str, Any]:
        route = (method.upper(), path.rstrip("/") or "/")

        if route == ("GET", "/v1/status"):
            return self.status()
        if route == ("GET", "/v1/catalog"):
            return {"ok": True, "commands": catalog()}
        if route == ("POST", "/v1/command"):
            return self.command(self._body(body, containers=("args",)))
        if route == ("POST", "/v1/confirm"):
            return self.confirm(self._body(body))
        if route == ("POST", "/v1/message"):
            return self.message(self._body(body, containers=("args", "history")))
        if route == ("GET", "/v1/events"):
            cursor = 0
            raw_cursor = (query.get("since") or ["0"])[0]
            try:
                cursor = max(int(raw_cursor), 0)
            except ValueError:
                cursor = 0
            return self.events_since(cursor)
        if route == ("POST", "/v1/speech/start") or route == ("POST", "/v1/speech/retry"):
            return {"ok": True, "speech": self.speech.start()}
        if route == ("POST", "/v1/speech/stop"):
            return {"ok": True, "speech": self.speech.stop()}
        if route == ("POST", "/v1/speech/mute"):
            payload = self._body(body)
            muted = payload.get("muted", True)
            if not isinstance(muted, bool):
                raise RequestError(400, "invalid_arg", "muted must be true or false")
            return {"ok": True, "speech": self.speech.set_muted(muted)}
        if route == ("POST", "/v1/speech/say"):
            payload = self._body(body)
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                raise RequestError(400, "invalid_arg", "text must be a non-empty string")
            spoken = self.speech.say(text)
            return {"ok": spoken, "spoken": spoken}
        if route == ("POST", "/v1/shutdown"):
            if self._shutdown_hook is not None:
                threading.Thread(target=self._shutdown_hook, daemon=True).start()
            return {"ok": True, "stopping": True}

        raise RequestError(404, "not_found", f"no route for {method.upper()} {path}")

    def _body(self, body: bytes, containers: tuple[str, ...] = ()) -> dict[str, Any]:
        return parse_json(body, max_bytes=self.settings.max_body_bytes, container_keys=containers)

    # ---------------------------------------------------------------- status
    def status(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "jarvis-local",
            "protocol": PROTOCOL_VERSION,
            "pid": self.pid,
            "startedAt": self.started_at,
            "uptimeSeconds": round(time.time() - self.started_at, 1),
            "llm": {
                "configured": self.llm.configured,
                "model": self.settings.llm_model if self.llm.configured else None,
            },
            "speech": self.speech.status(),
            "sites": self.sites.hosts(),
            "pendingApprovals": self.approvals.pending(),
            "platform": {
                "windows": os.name == "nt",
                "os": f"{platform.system()} {platform.release()}",
                "python": sys.version.split()[0],
            },
        }

    # --------------------------------------------------------------- command
    def command(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._throttle.check("command")
        name = payload.get("name")
        args = payload.get("args", {})
        request_id = payload.get("requestId")
        if request_id is not None and not isinstance(request_id, str):
            raise RequestError(400, "invalid_approval", "requestId must be a string")

        spec = require_command(name)
        validated = validate_args(spec, args)
        result = execute(spec.name, validated, approvals=self.approvals, request_id=request_id)
        if result.get("status") != "confirmation_required":
            self.speech.clear_awaiting_text()
        return {"ok": bool(result.get("ok", False)), **result}

    def confirm(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = self.approvals.check_request_id(payload.get("requestId"))
        approve = payload.get("approve", True)
        if not isinstance(approve, bool):
            raise RequestError(400, "invalid_arg", "approve must be true or false")
        pending = self.approvals.approve(request_id)
        if not approve:
            self.approvals.reject(request_id)
            self.emit({"type": "approved", "command": pending.name, "approved": False})
            return {"ok": True, "approved": False, "command": pending.name}
        self.emit({"type": "approved", "command": pending.name, "approved": True})
        return {"ok": True, "approved": True, "command": pending.name, "summary": pending.summary}

    # --------------------------------------------------------------- message
    def message(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise RequestError(400, "invalid_arg", "text must be a non-empty string")
        utterance = text.strip()[:2000]
        history = payload.get("history") if isinstance(payload.get("history"), list) else None

        proposal = interpret_local(utterance)
        if proposal is not None:
            self._throttle.check("command")
            spec = require_command(proposal["name"])
            validated = validate_args(spec, proposal["args"])
            result = execute(spec.name, validated, approvals=self.approvals)
            self.speech.clear_awaiting_text()
            spoken = result.get("detail") if result.get("ok") else None
            if result.get("status") == "confirmation_required":
                spoken = f"{result.get('summary', spec.name)}. Confirm to proceed."
            return {"ok": True, "kind": "command", "understoodLocally": True, "spoken": spoken, **result}

        try:
            reply = self.llm.chat(utterance, history)
        except LlmUnavailable as exc:
            log.info("online AI unavailable: %s", describe_error(exc))
            fallback = offline_reply(str(exc))
            return {
                "ok": True,
                "kind": "answer",
                "source": "offline",
                "text": fallback.text,
                "reason": "online_ai_unavailable",
                "spoken": fallback.text,
            }

        response: dict[str, Any] = {
            "ok": True,
            "kind": "proposal" if reply.proposal else "answer",
            "source": reply.source,
            "model": reply.model,
            "text": reply.text,
            "spoken": reply.text,
        }
        if reply.proposal:
            # AI output is only ever a *proposal*: validate it like any other input.
            try:
                spec = require_command(reply.proposal["name"])
                validated = validate_args(spec, reply.proposal.get("args", {}))
            except RequestError as exc:
                response["kind"] = "answer"
                response["proposalRejected"] = exc.message
            else:
                response["proposal"] = {"name": spec.name, "args": validated}
        return response


# ----------------------------------------------------------------- HTTP layer
class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "jarvis-local"
    sys_version = ""

    @property
    def service(self) -> JarvisService:
        return self.server.service  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - base class API
        log.debug("%s %s", self.address_string(), redact(fmt % args))

    # ------------------------------------------------------------ HTTP verbs
    def do_GET(self) -> None:  # noqa: N802 - base class API
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802 - base class API
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802 - base class API
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802 - base class API
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        try:
            self._authorise()
            body = self._read_body()
            payload = self.service.dispatch(method, parsed.path, query, body)
            self._respond(200, payload)
        except RequestError as exc:
            self._respond(exc.status, exc.payload())
        except Exception as exc:  # noqa: BLE001 - never leak a traceback to the caller
            log.error("unhandled request error: %s", redact(f"{type(exc).__name__}: {exc}"))
            self._respond(
                500,
                {"ok": False, "error": {"code": "internal_error", "message": "the local service hit an internal error"}},
            )

    def _authorise(self) -> None:
        settings = self.service.settings
        if not settings.origin_allowed(self.headers.get("Origin")):
            raise forbidden("origin_rejected", "only local origins may call the JARVIS service")
        presented = self.headers.get("X-Jarvis-Token")
        if not token_matches(settings.token, presented):
            raise unauthorized()
        host_header = (self.headers.get("Host") or "").split(":")[0]
        if host_header and host_header not in LOOPBACK_HOSTS and host_header != "":
            raise forbidden("host_rejected", "requests must address the loopback interface")

    def _read_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError:
            raise RequestError(400, "invalid_length", "invalid Content-Length header") from None
        if length < 0:
            raise RequestError(400, "invalid_length", "invalid Content-Length header")
        if length > self.service.settings.max_body_bytes:
            # Drain a sane amount so the socket stays in sync, then drop the connection.
            if length <= HARD_DRAIN_BYTES:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(65_536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            self.close_connection = True
            raise RequestError(413, "payload_too_large", "payload too large")
        return self.rfile.read(length) if length else b""

    def _respond(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


class JarvisHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], service: JarvisService) -> None:
        if address[0] not in LOOPBACK_HOSTS:
            raise ValueError("JarvisHTTPServer refuses to bind to a non-loopback interface")
        super().__init__(address, _Handler)
        self.service = service


def build_server(settings: Settings, service: JarvisService | None = None) -> tuple[JarvisHTTPServer, JarvisService]:
    """Create (but do not start) the HTTP server, bound to 127.0.0.1."""
    resolved = service or JarvisService(settings)
    server = JarvisHTTPServer((settings.host, settings.port), resolved)
    return server, resolved

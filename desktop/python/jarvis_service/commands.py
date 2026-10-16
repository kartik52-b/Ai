"""The allowlisted command handlers and the executor that gates them.

Handlers are fixed functions taking validated keyword arguments. The executor
never runs a handler until :mod:`jarvis_service.permissions` says it may, and it
never claims success beyond what the operating system confirmed.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

from . import permissions, registry, windows_actions
from .config import Settings
from .permissions import ApprovalStore, Decision, NeedsApproval, evaluate
from .registry import ACTION, READ, SENSITIVE, CommandSpec, ParamSpec, register
from .security import RequestError, bad_request, forbidden, redact

log = logging.getLogger("jarvis.commands")


# --------------------------------------------------------------------- websites
class SiteAllowlist:
    """Hosts the user has approved for direct opening."""

    def __init__(self, hosts: Iterable[str] = (), path: Path | None = None) -> None:
        self.path = path
        self._hosts = {h.strip().lower() for h in hosts if h and h.strip()}

    @classmethod
    def load(cls, settings: Settings) -> "SiteAllowlist":
        allowlist = cls(settings.site_allowlist, settings.sites_path)
        try:
            if allowlist.path and allowlist.path.is_file():
                stored = json.loads(allowlist.path.read_text(encoding="utf-8"))
                if isinstance(stored, list):
                    allowlist._hosts.update(str(h).strip().lower() for h in stored if str(h).strip())
        except (OSError, json.JSONDecodeError):  # pragma: no cover - corrupt file is not fatal
            log.warning("ignoring unreadable site allowlist at %s", allowlist.path)
        return allowlist

    def contains(self, host: str) -> bool:
        return host.strip().lower() in self._hosts

    def add(self, host: str) -> None:
        host = host.strip().lower()
        if not host:
            return
        self._hosts.add(host)
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(sorted(self._hosts), indent=2), encoding="utf-8")
            self.path.chmod(0o600)
        except OSError:  # pragma: no cover - persistence is best effort
            log.warning("could not persist the site allowlist")

    def hosts(self) -> list[str]:
        return sorted(self._hosts)


def normalise_url(raw: str) -> str:
    """Accept only absolute https URLs with a real host."""
    parsed = urlparse(raw.strip())
    if parsed.scheme.lower() != "https":
        raise bad_request("invalid_url", "only https:// addresses can be opened")
    if not parsed.hostname:
        raise bad_request("invalid_url", "the address is missing a host name")
    return raw.strip()


# ------------------------------------------------------------------- handlers
def _to_result(result: windows_actions.ActionResult) -> dict[str, Any]:
    return result.to_dict()


def build_registry(settings: Settings, sites: SiteAllowlist | None = None) -> None:
    """(Re)register the allowlist for these settings. Idempotent."""
    allowlist = sites or SiteAllowlist.load(settings)
    registry.REGISTRY.clear()

    roots = tuple(p.resolve() for p in settings.search_roots if p.exists())
    default_root = (roots[0] if roots else Path.home()).resolve()

    def _allowed_root(raw: str | None) -> str:
        candidate = Path(raw).expanduser() if raw else default_root
        try:
            resolved = candidate.resolve()
        except OSError as exc:
            raise bad_request("invalid_arg", f"unusable search root: {type(exc).__name__}") from exc
        permitted = roots or (Path.home().resolve(),)
        if not any(resolved == root or root in resolved.parents for root in permitted):
            raise forbidden(
                "root_not_permitted",
                "only folders you have added to JARVIS_SEARCH_ROOTS may be searched",
            )
        return str(resolved)

    # ---------------------------------------------------------------- open apps
    register(
        CommandSpec(
            name="open_calculator",
            description="Open Calculator",
            danger=ACTION,
            handler=lambda: _to_result(windows_actions.open_calculator()),
            describe=lambda _args: "Open Calculator",
            offline_keywords=("calculator",),
        )
    )
    register(
        CommandSpec(
            name="open_notepad",
            description="Open Notepad",
            danger=ACTION,
            handler=lambda: _to_result(windows_actions.open_notepad()),
            describe=lambda _args: "Open Notepad",
            offline_keywords=("notepad",),
        )
    )
    register(
        CommandSpec(
            name="open_file_explorer",
            description="Open File Explorer (optionally at a folder you can already reach)",
            danger=ACTION,
            params=(
                ParamSpec(
                    "path",
                    type="string",
                    description="Absolute folder path to open; omit for the default view",
                    max_length=400,
                ),
            ),
            handler=lambda path=None: _to_result(
                windows_actions.open_file_explorer(str(_allowed_root(path)))
            ),
            describe=lambda args: f"Open File Explorer at {_allowed_root(args.get('path'))}",
            offline_keywords=("explorer", "files"),
        )
    )

    def open_website_handler(url: str, remember: bool = False) -> dict[str, Any]:
        normalised = normalise_url(url)
        host = urlparse(normalised).hostname or ""
        granted = permissions.approval_granted()

        if not granted:
            # Approving is required for a new host, and for any change to the allowlist.
            notes: list[str] = []
            if not allowlist.contains(host):
                notes.append(f"first time visiting {host}")
            if remember:
                notes.append(f"remember {host} so it opens without asking next time")
            if notes:
                raise NeedsApproval(f"Open {normalised} in your default browser ({'; '.join(notes)})")
        if remember:
            allowlist.add(host)
        return _to_result(windows_actions.open_website(normalised))

    register(
        CommandSpec(
            name="open_website",
            description="Open a user-approved website in the default browser",
            danger=ACTION,
            params=(
                ParamSpec("url", type="string", required=True, description="https:// address", max_length=400),
                ParamSpec(
                    "remember",
                    type="boolean",
                    description="Approve this host for future direct opening (only after you confirm)",
                ),
            ),
            handler=open_website_handler,
            describe=lambda args: f"Open {args.get('url', 'a website')} in your default browser",
            offline_keywords=("website", "site", "open http"),
        )
    )

    # ------------------------------------------------------------- information
    register(
        CommandSpec(
            name="get_current_time",
            description="Tell the current local time",
            danger=READ,
            handler=lambda: _to_result(windows_actions.local_time()),
            describe=lambda _args: "Read the current time",
            offline_keywords=("time", "clock"),
        )
    )
    register(
        CommandSpec(
            name="get_system_info",
            description="Report basic system information (OS, CPU, memory, free disk)",
            danger=READ,
            handler=lambda: _to_result(windows_actions.system_info()),
            describe=lambda _args: "Read basic system information",
            offline_keywords=("system", "memory", "cpu", "ram"),
        )
    )
    register(
        CommandSpec(
            name="find_file",
            description="Search a folder you have added for a filename",
            danger=READ,
            params=(
                ParamSpec(
                    "query",
                    type="string",
                    required=True,
                    description="Filename fragment (no wildcards or path separators)",
                    max_length=120,
                    pattern=r"[^\\/]*",
                ),
                ParamSpec("root", type="string", description="Folder to search", max_length=400),
                ParamSpec(
                    "maxResults",
                    type="integer",
                    description="Maximum matches to return",
                    minimum=1,
                    maximum=50,
                ),
            ),
            handler=lambda query, root=None, maxResults=20: _to_result(
                windows_actions.search_files(query, _allowed_root(root), int(maxResults))
            ),
            describe=lambda args: f"Search {args.get('root') or default_root} for files named like "
            f"{args.get('query', '')!r}",
            offline_keywords=("find", "search", "locate"),
        )
    )

    # ------------------------------------------------------------------ volume
    register(
        CommandSpec(
            name="set_volume",
            description="Set the Windows master volume (requires confirmation)",
            danger=SENSITIVE,
            params=(
                ParamSpec(
                    "level",
                    type="number",
                    required=True,
                    description="Volume as a fraction between 0 and 1",
                    minimum=0.0,
                    maximum=1.0,
                ),
            ),
            handler=lambda level: _to_result(windows_actions.set_volume(float(level))),
            describe=lambda args: f"Set the Windows master volume to {round(float(args.get('level', 0)) * 100)}%",
            offline_keywords=("volume",),
        )
    )

    return registry


# ------------------------------------------------------------------- executor
def execute(
    name: str,
    args: dict[str, Any],
    *,
    approvals: ApprovalStore,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Validate, gate on permission, run, and report the OS-confirmed outcome."""
    spec = registry.require_command(name)
    validated = registry.validate_args(spec, args)
    decision = evaluate(spec, validated)

    if decision.status == "blocked":
        return _blocked(spec, validated, decision)

    approved = False
    if request_id:
        approvals.consume(request_id, spec.name, validated)
        approved = True

    if decision.status == "confirm" and not approved:
        return _needs_confirmation(spec, validated, decision, approvals)

    try:
        with permissions.approval_context(approved):
            result = spec.handler(**validated)
    except NeedsApproval as pending:
        if approved:
            return {
                "ok": False,
                "status": "failed",
                "command": spec.name,
                "detail": "this action still requires confirmation",
                "verified": False,
                "data": {},
            }
        return _needs_confirmation(spec, validated, decision, approvals, summary=pending.summary)
    except RequestError:
        raise
    except Exception as exc:  # noqa: BLE001 - report, never leak a traceback
        log.error("command %s failed: %s", spec.name, redact(f"{type(exc).__name__}: {exc}"))
        return {
            "ok": False,
            "status": "failed",
            "command": spec.name,
            "detail": f"the action failed ({type(exc).__name__})",
            "verified": False,
            "data": {},
        }

    if not isinstance(result, dict):  # pragma: no cover - defensive
        result = {"ok": False, "status": "failed", "detail": "handler returned an invalid result"}

    return {
        "ok": bool(result.get("ok", False)),
        "status": str(result.get("status", "failed")),
        "command": spec.name,
        "summary": spec.summary(validated),
        "detail": str(result.get("detail", "")),
        "verified": bool(result.get("verified", False)),
        "data": result.get("data", {}),
    }


def _needs_confirmation(
    spec: CommandSpec,
    args: dict[str, Any],
    decision: Decision,
    approvals: ApprovalStore,
    summary: str | None = None,
) -> dict[str, Any]:
    pending = approvals.issue(spec.name, args, summary or decision.summary)
    return {
        "ok": False,
        "status": "confirmation_required",
        "command": spec.name,
        "summary": pending.summary,
        "detail": decision.reason,
        "verified": False,
        "request": pending.public(),
    }


def _blocked(spec: CommandSpec, args: dict[str, Any], decision: Decision) -> dict[str, Any]:
    return {
        "ok": False,
        "status": "blocked",
        "command": spec.name,
        "summary": decision.summary,
        "detail": decision.reason,
        "verified": False,
        "data": {},
    }


# ------------------------------------------------- offline intent recognition
_OPEN_TARGETS = {
    "calculator": "open_calculator",
    "notepad": "open_notepad",
    "file explorer": "open_file_explorer",
    "explorer": "open_file_explorer",
}

_VOLUME_RE = re.compile(r"volume(?:\s+to|\s*=|:)?\s*(\d{1,3})\s*%?", re.IGNORECASE)
_FIND_RE = re.compile(
    r"\b(?:find|search|locate|look for)\b.*?\b(?:file|files|named|called)\b\s*(?:named|called|for)?\s*(.+)$",
    re.IGNORECASE,
)
_WEBSITE_RE = re.compile(r"\b(?:open|visit|go to)\s+(https?://\S+)", re.IGNORECASE)


def interpret_local(text: str) -> dict[str, Any] | None:
    """Keyword router for the offline path: text -> validated command proposal.

    Returns `{"name": ..., "args": {...}}` or None. The result is still passed
    through :func:`execute`, so it inherits every allowlist and permission check.
    """
    utterance = " ".join(text.strip().split())
    if not utterance:
        return None
    lowered = utterance.lower()

    match = _WEBSITE_RE.search(utterance)
    if match:
        return {"name": "open_website", "args": {"url": match.group(1)}}

    match = _VOLUME_RE.search(lowered)
    if match and "volume" in lowered:
        level = min(int(match.group(1)), 100) / 100
        return {"name": "set_volume", "args": {"level": level}}

    if "time" in lowered and not any(k in lowered for k in ("timer", "timesheet")):
        return {"name": "get_current_time", "args": {}}

    if any(k in lowered for k in ("system info", "system information", "system status", "how much memory", "ram")):
        return {"name": "get_system_info", "args": {}}

    if any(verb in lowered for verb in ("open", "launch", "start", "show me")):
        for target, command in _OPEN_TARGETS.items():
            if target in lowered:
                return {"name": command, "args": {}}

    match = _FIND_RE.search(utterance)
    if match:
        query = match.group(1).strip().strip("?.!\"'")
        query = re.sub(r"^(named|called|for)\s+", "", query, flags=re.IGNORECASE).strip()
        if query:
            return {"name": "find_file", "args": {"query": query}}

    return None


def catalog_with_policy() -> list[dict[str, Any]]:
    return registry.catalog()

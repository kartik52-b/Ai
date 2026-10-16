"""The command allowlist.

A command exists here or it does not exist at all. Handlers take **validated
keyword arguments only** — no handler ever receives a shell string, and AI
output must resolve to a registered name and pass :func:`validate_args` before
anything touches the operating system.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Literal

from .security import bad_request, forbidden

DangerLevel = Literal["read", "action", "sensitive", "blocked"]

READ: DangerLevel = "read"
ACTION: DangerLevel = "action"
SENSITIVE: DangerLevel = "sensitive"
BLOCKED: DangerLevel = "blocked"

ParamType = Literal["string", "integer", "number", "boolean"]

#: Command names that are refused by policy even if someone registers them.
#: Destructive / privileged / shell-ish capabilities are out of scope entirely.
DENIED_NAME_PATTERN = re.compile(
    r"(delete|remove|wipe|format|uninstall|install|elevate|admin|shutdown|reboot|"
    r"regedit|registry|powershell|cmd|shell|exec|eval|script|credential|password|"
    r"disable|defender|firewall|security)",
    re.IGNORECASE,
)

NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,39}$")


@dataclass(frozen=True)
class ParamSpec:
    name: str
    type: ParamType = "string"
    required: bool = False
    description: str = ""
    enum: tuple[str, ...] | None = None
    minimum: float | None = None
    maximum: float | None = None
    max_length: int = 200
    pattern: str | None = None


@dataclass
class CommandSpec:
    name: str
    description: str
    danger: DangerLevel
    handler: Callable[..., Any]
    params: tuple[ParamSpec, ...] = ()
    describe: Callable[[dict[str, Any]], str] | None = None
    offline_keywords: tuple[str, ...] = ()

    @property
    def requires_confirmation(self) -> bool:
        return self.danger == SENSITIVE

    def summary(self, args: dict[str, Any]) -> str:
        if self.describe is not None:
            return self.describe(args)
        return self.description


REGISTRY: dict[str, CommandSpec] = {}

RESULT_STATUSES = ("ok", "unsupported", "failed")


def register(spec: CommandSpec) -> CommandSpec:
    if not NAME_PATTERN.match(spec.name):
        raise ValueError(f"invalid command name: {spec.name!r}")
    if spec.name in REGISTRY:
        raise ValueError(f"duplicate command registration: {spec.name!r}")
    REGISTRY[spec.name] = spec
    return spec


def get(name: str) -> CommandSpec | None:
    return REGISTRY.get(name)


def require_command(raw_name: object) -> CommandSpec:
    """Resolve an untrusted name to a spec, or reject it."""
    if not isinstance(raw_name, str):
        raise bad_request("invalid_command", "command name must be a string")
    name = raw_name.strip()
    if DENIED_NAME_PATTERN.search(name):
        raise forbidden(
            "command_blocked",
            "that capability is permanently disabled: JARVIS never deletes files, installs "
            "software, changes system settings, elevates privileges, or runs scripts",
        )
    spec = REGISTRY.get(name)
    if spec is None:
        raise bad_request("unknown_command", f"no allowlisted command named {name!r}")
    return spec


def validate_args(spec: CommandSpec, args: Any) -> dict[str, Any]:
    """Type-check and bound every argument. Unknown keys are rejected loudly."""
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise bad_request("invalid_args", "arguments must be a JSON object")

    declared = {param.name: param for param in spec.params}
    for key in args:
        if key not in declared:
            raise bad_request("unknown_arg", f"{spec.name} does not accept an argument {key!r}")

    validated: dict[str, Any] = {}
    for param in spec.params:
        if param.name in args and args[param.name] is not None:
            value = args[param.name]
            validated[param.name] = _validate_param(spec, param, value)
        elif param.required:
            raise bad_request("missing_arg", f"{spec.name} requires {param.name!r}")
    return validated


def _validate_param(spec: CommandSpec, param: ParamSpec, value: Any) -> Any:
    label = f"{spec.name}.{param.name}"

    if param.type == "string":
        if not isinstance(value, str):
            raise bad_request("invalid_arg", f"{label} must be a string")
        text = value.strip()
        if not text:
            raise bad_request("invalid_arg", f"{label} must not be empty")
        if len(text) > param.max_length:
            raise bad_request("invalid_arg", f"{label} exceeds {param.max_length} characters")
        if param.pattern and not re.fullmatch(param.pattern, text):
            raise bad_request("invalid_arg", f"{label} has an unsupported format")
        if param.enum and text not in param.enum:
            raise bad_request("invalid_arg", f"{label} must be one of {', '.join(param.enum)}")
        return text

    if param.type == "boolean":
        if not isinstance(value, bool):
            raise bad_request("invalid_arg", f"{label} must be true or false")
        return value

    numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
    if not numeric:
        raise bad_request("invalid_arg", f"{label} must be a number")
    number = int(value) if param.type == "integer" else float(value)
    if param.minimum is not None and number < param.minimum:
        raise bad_request("invalid_arg", f"{label} must be >= {param.minimum}")
    if param.maximum is not None and number > param.maximum:
        raise bad_request("invalid_arg", f"{label} must be <= {param.maximum}")
    return number


def catalog() -> list[dict[str, Any]]:
    """Serialisable description of the allowlist, for the desktop UI."""
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "danger": spec.danger,
            "requiresConfirmation": spec.requires_confirmation,
            "params": [
                {
                    "name": param.name,
                    "type": param.type,
                    "required": param.required,
                    "description": param.description,
                    "enum": list(param.enum) if param.enum else None,
                }
                for param in spec.params
            ],
        }
        for spec in sorted(REGISTRY.values(), key=lambda s: s.name)
    ]


__all__ = [
    "ACTION",
    "BLOCKED",
    "CommandSpec",
    "DangerLevel",
    "ParamSpec",
    "READ",
    "REGISTRY",
    "SENSITIVE",
    "catalog",
    "get",
    "register",
    "require_command",
    "validate_args",
]

"""Online AI adapter.

* The API key is read from the environment, sent only to the configured
  provider over TLS, and never logged, returned, or placed in an error message.
* Only *text* is ever sent. No audio, no screen contents, no file contents.
* A model may *propose* a local command, but the proposal is parsed by
  :func:`parse_proposal` and then re-validated against the allowlist — AI output
  is never executed directly.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urlparse

from .config import LOOPBACK_HOSTS, Settings
from .security import redact

log = logging.getLogger("jarvis.llm")

MAX_TOKENS = 700

OFFLINE_NOTICE = (
    "My online reasoning core is offline because no AI key is configured, so I can only run "
    "local commands right now. Add LLM_API_KEY in Settings → Environment to enable general "
    "questions and answers."
)

SYSTEM_PROMPT = (
    "You are JARVIS, a voice-first assistant running locally on the user's own Windows PC. "
    "Answer concisely and in plain speakable sentences (under 120 words) unless asked for detail. "
    "You also help interpret commands, but you can never execute anything yourself. "
    "If the user asks for one of the local actions below, reply with a single JSON object and no "
    "other text: {\"proposal\": {\"command\": \"<name>\", \"args\": {...}}, \"reply\": \"<one short sentence>\"}. "
    "Allowed local commands: "
    "open_calculator{}, open_notepad{}, open_file_explorer{path?}, open_website{url}, "
    "get_current_time{}, get_system_info{}, find_file{query, root?, maxResults?}, "
    "set_volume{level 0..1}. "
    "You cannot delete files, install software, change system settings, run scripts, or elevate "
    "privileges, and you must refuse those requests in one sentence. "
    "For anything that is not a local command, reply with plain prose instead of JSON."
)


class LlmUnavailable(RuntimeError):
    """The online provider is not configured or could not answer."""


@dataclass
class LlmReply:
    text: str
    source: str  # "online" | "offline"
    model: str | None = None
    proposal: dict[str, Any] | None = None


class LlmClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def configured(self) -> bool:
        return self.settings.llm_configured

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.configured:
            raise LlmUnavailable("no online AI key is configured")

        url = f"{self.settings.llm_base_url}{path}"
        parsed = urlparse(url)
        if parsed.scheme != "https" and parsed.hostname not in LOOPBACK_HOSTS:
            raise LlmUnavailable(
                "refusing to send the API key over an unencrypted connection — LLM_BASE_URL must be https"
            )
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.settings.llm_api_key}",
                "User-Agent": "jarvis-local/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.settings.llm_timeout_s) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            # Status only — never the key, never the raw body.
            raise LlmUnavailable(f"the AI provider rejected the request (HTTP {exc.code})") from None
        except urllib.error.URLError:
            raise LlmUnavailable("the AI provider could not be reached") from None
        except TimeoutError:
            raise LlmUnavailable("the AI provider timed out") from None

        try:
            decoded = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise LlmUnavailable("the AI provider returned an unreadable response") from None
        if not isinstance(decoded, dict):
            raise LlmUnavailable("the AI provider returned an unexpected response")
        return decoded

    def chat(self, text: str, history: Iterable[dict[str, str]] | None = None) -> LlmReply:
        messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for turn in list(history or [])[-8:]:
            role = turn.get("role")
            content = turn.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                messages.append({"role": role, "content": content.strip()[:4000]})
        messages.append({"role": "user", "content": text.strip()[:4000]})

        payload = {
            "model": self.settings.llm_model,
            "messages": messages,
            "max_tokens": MAX_TOKENS,
            "temperature": 0.3,
        }
        decoded = self._post("/chat/completions", payload)
        choices = decoded.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LlmUnavailable("the AI provider returned no answer")
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise LlmUnavailable("the AI provider returned an empty answer")

        raw = content.strip()
        proposal = None
        prose = raw
        parsed = _extract_json_object(raw)
        if parsed is not None:
            proposal = parse_proposal(parsed.get("proposal"))
            reply_text = parsed.get("reply")
            if isinstance(reply_text, str) and reply_text.strip():
                prose = reply_text.strip()
        log.info("ai reply from %s (%d chars)", self.settings.llm_model, len(prose))
        return LlmReply(text=prose, source="online", model=self.settings.llm_model, proposal=proposal)


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    """Find a JSON object in a model reply, tolerating code fences."""
    candidate = raw.strip()
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if "\n" in candidate:
            candidate = candidate.split("\n", 1)[1]
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_proposal(raw: Any) -> dict[str, Any] | None:
    """Strictly parse a model-proposed local command.

    Anything that is not `{"command": <snake_case name>, "args": {primitives}}`
    is discarded, so a malformed or hostile reply can never reach a handler.
    """
    if not isinstance(raw, dict):
        return None
    name = raw.get("command")
    if not isinstance(name, str) or not name.strip():
        return None
    name = name.strip()
    if not name.replace("_", "").isalnum() or not name.islower():
        return None

    args_raw = raw.get("args", {})
    if args_raw is None:
        args_raw = {}
    if not isinstance(args_raw, dict) or len(args_raw) > 12:
        return None
    args: dict[str, Any] = {}
    for key, value in args_raw.items():
        if not isinstance(key, str) or len(key) > 40:
            return None
        if isinstance(value, bool) or isinstance(value, (int, float)):
            args[key] = value
        elif isinstance(value, str) and len(value) <= 400:
            args[key] = value
        else:
            return None
    return {"name": name, "args": args}


def offline_reply(reason: str | None = None) -> LlmReply:
    return LlmReply(text=OFFLINE_NOTICE, source="offline", model=None, proposal=None)


def provider_status(settings: Settings) -> dict[str, Any]:
    """Safe-to-expose status: never the key itself."""
    return {
        "configured": settings.llm_configured,
        "model": settings.llm_model if settings.llm_configured else None,
        "baseUrl": settings.llm_base_url if settings.llm_configured else None,
    }


def describe_error(exc: Exception) -> str:
    return redact(f"{type(exc).__name__}: {exc}")

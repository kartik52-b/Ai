"""Configuration, authentication, origin, payload, and redaction tests."""

from __future__ import annotations

import json
import unittest

from jarvis_service.config import Settings
from jarvis_service.security import (
    MAX_KEYS,
    RateLimiter,
    RequestError,
    parse_json,
    redact,
    token_matches,
)


class SettingsTests(unittest.TestCase):
    def test_refuses_non_loopback_bind(self) -> None:
        for host in ("0.0.0.0", "192.168.1.10", "::", "example.com"):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    Settings.from_env({"JARVIS_HOST": host})

    def test_defaults_bind_to_loopback_ephemeral_port(self) -> None:
        settings = Settings.from_env({})
        self.assertEqual(settings.host, "127.0.0.1")
        self.assertEqual(settings.port, 0)

    def test_rejects_bad_port(self) -> None:
        with self.assertRaises(ValueError):
            Settings.from_env({"JARVIS_PORT": "70000"})
        with self.assertRaises(ValueError):
            Settings.from_env({"JARVIS_PORT": "http"})

    def test_generates_a_token_when_none_supplied(self) -> None:
        settings = Settings.from_env({})
        self.assertTrue(settings.token)
        self.assertTrue(settings.token_generated)

    def test_uses_supplied_token_and_reads_lists(self) -> None:
        settings = Settings.from_env(
            {
                "JARVIS_TOKEN": "abc",
                "JARVIS_SITE_ALLOWLIST": "example.com, docs.example.org",
                "LLM_API_KEY": "sk-live-123",
                "LLM_MODEL": "some/model",
            }
        )
        self.assertEqual(settings.token, "abc")
        self.assertFalse(settings.token_generated)
        self.assertEqual(settings.site_allowlist, ("example.com", "docs.example.org"))
        self.assertTrue(settings.llm_configured)
        self.assertEqual(settings.llm_model, "some/model")

    def test_refuses_to_send_the_ai_key_over_plain_http(self) -> None:
        with self.assertRaises(ValueError):
            Settings.from_env({"LLM_BASE_URL": "http://api.example.com/v1", "LLM_API_KEY": "sk-x"})
        allowed = Settings.from_env({"LLM_BASE_URL": "http://127.0.0.1:8080/v1", "LLM_API_KEY": "sk-x"})
        self.assertEqual(allowed.llm_base_url, "http://127.0.0.1:8080/v1")
        self.assertTrue(
            Settings.from_env({"LLM_BASE_URL": "https://api.example.com/v1"}).llm_base_url.startswith("https://")
        )

    def test_handshake_never_contains_the_token(self) -> None:
        settings = Settings.from_env({"JARVIS_TOKEN": "super-secret"})
        payload = settings.handshake(51234, 4242)
        self.assertNotIn("token", payload)
        self.assertNotIn("super-secret", json.dumps(payload))

    def test_origin_policy(self) -> None:
        settings = Settings.from_env({})
        allowed = (None, "null", "http://127.0.0.1:5173", "http://localhost:3000", "http://[::1]:8080")
        denied = (
            "https://evil.example",
            "http://evil.example",
            "http://127.0.0.1.evil.example",
            "http://localhost.evil.example:3000",
            "file:///tmp/x.html",
            "https://127.0.0.1",
        )
        for origin in allowed:
            with self.subTest(origin=origin):
                self.assertTrue(settings.origin_allowed(origin))
        for origin in denied:
            with self.subTest(origin=origin):
                self.assertFalse(settings.origin_allowed(origin))


class TokenTests(unittest.TestCase):
    def test_constant_time_match(self) -> None:
        self.assertTrue(token_matches("abc123", "abc123"))
        self.assertFalse(token_matches("abc123", "abc124"))
        self.assertFalse(token_matches("abc123", None))
        self.assertFalse(token_matches("abc123", ""))
        self.assertFalse(token_matches("", "abc123"))
        self.assertFalse(token_matches("", ""))


class PayloadTests(unittest.TestCase):
    def test_accepts_flat_primitive_object(self) -> None:
        body = json.dumps({"name": "open_notepad", "args": {}, "flag": True, "n": 3}).encode()
        parsed = parse_json(body, max_bytes=1024, container_keys=("args",))
        self.assertEqual(parsed["name"], "open_notepad")
        self.assertEqual(parsed["args"], {})

    def test_nested_containers_are_only_allowed_where_declared(self) -> None:
        with self.assertRaises(RequestError):
            parse_json(json.dumps({"args": {}}).encode(), max_bytes=1024)
        with self.assertRaises(RequestError):
            parse_json(
                json.dumps({"args": {"query": {"deep": 1}}}).encode(),
                max_bytes=1024,
                container_keys=("args",),
            )
        with self.assertRaises(RequestError):
            parse_json(
                json.dumps({"args": [], "history": [["nested"]]}).encode(),
                max_bytes=1024,
                container_keys=("args", "history"),
            )
        parsed = parse_json(
            json.dumps({"history": [{"role": "user", "content": "hi"}]}).encode(),
            max_bytes=1024,
            container_keys=("history",),
        )
        self.assertEqual(parsed["history"][0]["role"], "user")

    def test_rejects_malformed_json(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            parse_json(b"{not json", max_bytes=1024)
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.code, "invalid_json")

    def test_rejects_non_utf8(self) -> None:
        with self.assertRaises(RequestError):
            parse_json(b"\xff\xfe\x00", max_bytes=64)

    def test_rejects_non_object_bodies(self) -> None:
        for body in (b"[1,2,3]", b'"text"', b"42"):
            with self.subTest(body=body):
                with self.assertRaises(RequestError) as ctx:
                    parse_json(body, max_bytes=1024)
                self.assertEqual(ctx.exception.code, "invalid_payload")

    def test_rejects_nested_and_complex_values(self) -> None:
        for payload in ({"a": {"b": 1}}, {"a": [1, 2]}):
            with self.subTest(payload=payload):
                with self.assertRaises(RequestError):
                    parse_json(json.dumps(payload).encode(), max_bytes=1024)

    def test_rejects_oversized_body(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            parse_json(b"x" * 2048, max_bytes=1024)
        self.assertEqual(ctx.exception.status, 413)

    def test_rejects_too_many_fields(self) -> None:
        body = json.dumps({f"k{i}": i for i in range(MAX_KEYS + 1)}).encode()
        with self.assertRaises(RequestError) as ctx:
            parse_json(body, max_bytes=8192)
        self.assertEqual(ctx.exception.code, "too_many_fields")

    def test_empty_body_is_an_empty_object(self) -> None:
        self.assertEqual(parse_json(b"", max_bytes=64), {})


class RedactionTests(unittest.TestCase):
    def test_hides_credentials_in_log_lines(self) -> None:
        secret = "sk-live-abcdef1234567890"
        for text in (
            f"Authorization: Bearer {secret}",
            f"api_key={secret}",
            f"password: hunter2",
        ):
            with self.subTest(text=text):
                cleaned = redact(text)
                self.assertNotIn(secret, cleaned)
                self.assertIn("[redacted]", cleaned)

    def test_leaves_ordinary_text_alone(self) -> None:
        self.assertEqual(redact("opened Notepad"), "opened Notepad")


class RateLimiterTests(unittest.TestCase):
    def test_blocks_rapid_repeats_and_recovers(self) -> None:
        limiter = RateLimiter(min_interval_s=0.35)
        limiter.check("command", now=100.0)
        with self.assertRaises(RequestError) as ctx:
            limiter.check("command", now=100.1)
        self.assertEqual(ctx.exception.status, 429)
        limiter.check("command", now=100.5)
        limiter.check("other", now=100.5)  # separate key is unaffected


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

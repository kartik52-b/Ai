"""HTTP-level tests against a real server on 127.0.0.1."""

from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from jarvis_service.config import Settings
from jarvis_service.locking import SingleInstanceLock
from jarvis_service.security import RequestError
from jarvis_service.server import JarvisHTTPServer, JarvisService
from jarvis_service.windows_actions import ActionResult

OK = ActionResult(True, "ok", "done", verified=True)


class ServiceHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._tmp.name)
        cls.settings = Settings(
            state_dir=cls.root,
            token="test-token",
            search_roots=(cls.root,),
            host="127.0.0.1",
            port=0,
            command_min_interval_s=0.0,  # throttling is covered by its own test
        )
        cls.service = JarvisService(cls.settings)
        cls.server = JarvisHTTPServer(("127.0.0.1", 0), cls.service)
        cls.port = int(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.service.speech.stop()
        cls._tmp.cleanup()

    # ------------------------------------------------------------- utilities
    def call(
        self,
        method: str,
        path: str,
        body: bytes | dict | None = None,
        *,
        token: str | None = "test-token",
        origin: str | None = None,
        host: str | None = None,
    ) -> tuple[int, dict]:
        if isinstance(body, dict):
            body = json.dumps(body).encode("utf-8")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Jarvis-Token"] = token
        if origin:
            headers["Origin"] = origin
        if host:
            headers["Host"] = host
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
        finally:
            connection.close()
        return response.status, json.loads(raw.decode("utf-8"))

    # ------------------------------------------------------------- the tests
    def test_binds_loopback_only(self) -> None:
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        with self.assertRaises(ValueError):
            JarvisHTTPServer(("0.0.0.0", 0), self.service)

    def test_requires_the_session_token(self) -> None:
        status, payload = self.call("GET", "/v1/status", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "unauthorized")

        status, _ = self.call("GET", "/v1/status", token="wrong-token")
        self.assertEqual(status, 401)

        status, payload = self.call("GET", "/v1/status")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertNotIn("token", json.dumps(payload))

    def test_rejects_remote_origins_and_hosts(self) -> None:
        status, payload = self.call("GET", "/v1/status", origin="https://evil.example")
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "origin_rejected")

        status, payload = self.call("GET", "/v1/status", host="evil.example")
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "host_rejected")

        status, _ = self.call("GET", "/v1/status", origin="http://127.0.0.1:5173")
        self.assertEqual(status, 200)

    def test_unknown_routes_are_not_found(self) -> None:
        status, payload = self.call("GET", "/v1/secrets")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "not_found")

    def test_malformed_and_oversized_bodies(self) -> None:
        status, payload = self.call("POST", "/v1/command", b"{not json")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_json")

        huge = {"name": "open_notepad", "args": {}, "pad": "x" * (self.settings.max_body_bytes + 10)}
        status, payload = self.call("POST", "/v1/command", huge)
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "payload_too_large")

    def test_command_validation_over_http(self) -> None:
        status, payload = self.call("POST", "/v1/command", {"name": "make_coffee"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "unknown_command")

        status, payload = self.call("POST", "/v1/command", {"name": "delete_file"})
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "command_blocked")

        status, payload = self.call("POST", "/v1/command", {"name": "set_volume", "args": {"level": 5}})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_arg")

    def test_allowlisted_command_runs_end_to_end(self) -> None:
        with mock.patch("jarvis_service.commands.windows_actions.open_notepad", return_value=OK):
            status, payload = self.call("POST", "/v1/command", {"name": "open_notepad", "args": {}})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["verified"])

    def test_confirmation_round_trip_over_http(self) -> None:
        with mock.patch("jarvis_service.commands.windows_actions.set_volume", return_value=OK) as handler:
            status, pending = self.call("POST", "/v1/command", {"name": "set_volume", "args": {"level": 0.25}})
            self.assertEqual(status, 200)
            self.assertEqual(pending["status"], "confirmation_required")
            request_id = pending["request"]["requestId"]
            handler.assert_not_called()

            status, approved = self.call(
                "POST", "/v1/confirm", {"requestId": request_id, "approve": True}
            )
            self.assertEqual(status, 200)
            self.assertTrue(approved["approved"])

            status, result = self.call(
                "POST", "/v1/command", {"name": "set_volume", "args": {"level": 0.25}, "requestId": request_id}
            )
            self.assertTrue(result["ok"])
            handler.assert_called_once_with(0.25)

            # A second attempt with the burned approval is refused.
            status, replay = self.call(
                "POST", "/v1/command", {"name": "set_volume", "args": {"level": 0.25}, "requestId": request_id}
            )
            self.assertEqual(status, 403)
            self.assertEqual(replay["error"]["code"], "approval_invalid")

    def test_rejected_confirmation_cannot_be_executed(self) -> None:
        status, pending = self.call("POST", "/v1/command", {"name": "set_volume", "args": {"level": 0.3}})
        request_id = pending["request"]["requestId"]

        status, denied = self.call("POST", "/v1/confirm", {"requestId": request_id, "approve": False})
        self.assertEqual(status, 200)
        self.assertFalse(denied["approved"])

        status, payload = self.call(
            "POST", "/v1/command", {"name": "set_volume", "args": {"level": 0.3}, "requestId": request_id}
        )
        self.assertEqual(status, 403)

    def test_events_are_reported_with_a_cursor(self) -> None:
        # Generate an event through the real path rather than relying on test order.
        _, pending = self.call("POST", "/v1/command", {"name": "set_volume", "args": {"level": 0.15}})
        self.call("POST", "/v1/confirm", {"requestId": pending["request"]["requestId"], "approve": True})

        status, payload = self.call("GET", "/v1/events?since=0")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(payload["cursor"], 1)
        kinds = {event["type"] for event in payload["events"]}
        self.assertIn("approved", kinds)

        status, future = self.call("GET", f"/v1/events?since={payload['cursor']}")
        self.assertEqual(future["events"], [])

    def test_local_intent_runs_without_an_ai_key(self) -> None:
        with mock.patch("jarvis_service.commands.windows_actions.open_notepad", return_value=OK):
            status, payload = self.call("POST", "/v1/message", {"text": "open notepad"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["kind"], "command")
        self.assertTrue(payload["understoodLocally"])
        self.assertTrue(payload["ok"])

    def test_general_question_falls_back_to_the_offline_notice(self) -> None:
        status, payload = self.call("POST", "/v1/message", {"text": "explain entropy"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["source"], "offline")
        self.assertEqual(payload["reason"], "online_ai_unavailable")
        self.assertIn("LLM_API_KEY", payload["text"])

    def test_empty_message_is_rejected(self) -> None:
        status, payload = self.call("POST", "/v1/message", {"text": "   "})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_arg")

    def test_speech_controls_report_the_truth_without_engines(self) -> None:
        status, payload = self.call("POST", "/v1/speech/mute", {"muted": True})
        self.assertEqual(status, 200)
        self.assertTrue(payload["speech"]["muted"])
        status, payload = self.call("POST", "/v1/speech/mute", {"muted": False})
        self.assertFalse(payload["speech"]["muted"])

        status, payload = self.call("POST", "/v1/speech/mute", {"muted": "yes"})
        self.assertEqual(status, 400)

        with mock.patch("jarvis_service.speech.MAX_MIC_RESTARTS", 0):
            status, payload = self.call("POST", "/v1/speech/start")
            self.assertEqual(status, 200)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                _, snapshot = self.call("GET", "/v1/status")
                speech = snapshot["speech"]
                if not speech["listening"] and speech["error"]:
                    break
                time.sleep(0.05)
        self.assertFalse(speech["listening"])
        self.assertIsNotNone(speech["error"])
        self.assertIn(speech["errorCode"], {"engine_unavailable", "mic_denied", "mic_error", "tts_unavailable"})
        self.call("POST", "/v1/speech/stop")

    def test_shutdown_is_acknowledged(self) -> None:
        status, payload = self.call("POST", "/v1/shutdown")
        self.assertEqual(status, 200)
        self.assertTrue(payload["stopping"])

    def test_command_throttle_is_enforced_when_configured(self) -> None:
        throttled = JarvisService(
            Settings(
                state_dir=self.root,
                token="t",
                search_roots=(self.root,),
                command_min_interval_s=5.0,
            )
        )
        with mock.patch("jarvis_service.commands.windows_actions.local_time", return_value=OK):
            throttled.command({"name": "get_current_time", "args": {}})
            with self.assertRaises(RequestError) as ctx:
                throttled.command({"name": "get_current_time", "args": {}})
        self.assertEqual(ctx.exception.status, 429)

    def test_args_may_be_a_nested_object_but_nothing_else_may(self) -> None:
        status, payload = self.call("POST", "/v1/command", {"name": "open_notepad", "args": {"a": {"b": 1}}})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "unsupported_field")

        status, payload = self.call("POST", "/v1/command", {"name": "open_notepad", "args": {}, "extra": {"x": 1}})
        self.assertEqual(status, 400)

    def test_status_exposes_policy_without_secrets(self) -> None:
        status, payload = self.call("GET", "/v1/status")
        self.assertEqual(status, 200)
        body = json.dumps(payload)
        self.assertNotIn(self.settings.token, body)
        self.assertFalse(payload["llm"]["configured"])
        self.assertIn("dependencies", payload["speech"])
        self.assertEqual(payload["platform"]["windows"], os.name == "nt")


class SingleInstanceLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "service.lock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_second_acquire_is_refused_while_the_owner_is_alive(self) -> None:
        first = SingleInstanceLock(self.path)
        self.assertTrue(first.acquire())
        second = SingleInstanceLock(self.path)
        self.assertFalse(second.acquire(), "a live service must not be duplicated")
        first.release()
        self.assertTrue(second.acquire())
        second.release()

    def test_stale_lock_is_reclaimed(self) -> None:
        self.path.write_text(json.dumps({"pid": 999_999_999, "startedAt": 0}), encoding="utf-8")
        lock = SingleInstanceLock(self.path)
        self.assertTrue(lock.acquire())
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["pid"], os.getpid())
        lock.release()
        self.assertFalse(self.path.exists())

    def test_corrupt_lock_file_is_replaced(self) -> None:
        self.path.write_text("not json", encoding="utf-8")
        lock = SingleInstanceLock(self.path)
        self.assertTrue(lock.acquire())
        lock.release()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

"""Online AI adapter tests.

A stub OpenAI-compatible provider runs on loopback so we can verify exactly what
leaves the machine, what comes back, and that a hostile reply never becomes an
action.
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jarvis_service import registry
from jarvis_service.commands import SiteAllowlist, build_registry
from jarvis_service.config import Settings
from jarvis_service.llm import LlmClient, LlmUnavailable, parse_proposal, provider_status
from jarvis_service.security import RequestError
from jarvis_service.server import JarvisService

API_KEY = "sk-live-supersecret-value-123456"


class _StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    reply_status = 200
    reply_body: dict = {"choices": [{"message": {"content": "Hello, sir."}}]}
    received: list[dict] = []

    def log_message(self, *_args) -> None:  # noqa: D102 - silence the stub
        pass

    def do_POST(self) -> None:  # noqa: N802 - base class API
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        type(self).received.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "body": json.loads(raw.decode("utf-8")),
            }
        )
        body = json.dumps(type(self).reply_body).encode("utf-8")
        self.send_response(type(self).reply_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class LlmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.provider = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
        cls.port = int(cls.provider.server_address[1])
        cls.thread = threading.Thread(target=cls.provider.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.provider.shutdown()
        cls.provider.server_close()
        cls._tmp.cleanup()

    def setUp(self) -> None:
        _StubHandler.received = []
        _StubHandler.reply_status = 200
        _StubHandler.reply_body = {"choices": [{"message": {"content": "Hello, sir."}}]}
        self.settings = Settings(
            state_dir=Path(self._tmp.name),
            token="t",
            llm_api_key=API_KEY,
            llm_base_url=f"http://127.0.0.1:{self.port}/v1",
            llm_model="stub/model-1",
            llm_timeout_s=5.0,
        )
        # The stub listens on plain HTTP loopback; urllib allows that, and the
        # real deployment uses the https base URL that ships in the defaults.
        self.client = LlmClient(self.settings)

    # ----------------------------------------------------------------- basics
    def test_sends_only_text_and_the_key_to_the_configured_provider(self) -> None:
        reply = self.client.chat("Who are you?", [{"role": "user", "content": "hi"}])
        self.assertEqual(reply.text, "Hello, sir.")
        self.assertEqual(reply.source, "online")
        self.assertEqual(reply.model, "stub/model-1")

        self.assertEqual(len(_StubHandler.received), 1)
        sent = _StubHandler.received[0]
        self.assertEqual(sent["path"], "/v1/chat/completions")
        self.assertEqual(sent["authorization"], f"Bearer {API_KEY}")
        messages = sent["body"]["messages"]
        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(messages[-1]["content"], "Who are you?")
        self.assertEqual(sent["body"]["model"], "stub/model-1")

    def test_no_audio_or_binary_is_ever_sent(self) -> None:
        self.client.chat("say something")
        body = json.dumps(_StubHandler.received[0]["body"])
        for forbidden in ("audio", "pcm", "wav", "base64", "screenshot"):
            self.assertNotIn(forbidden, body.lower())

    def test_proposal_is_extracted_from_a_json_reply(self) -> None:
        _StubHandler.reply_body = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"proposal": {"command": "open_notepad", "args": {}}, "reply": "Opening Notepad, sir."}
                        )
                    }
                }
            ]
        }
        reply = self.client.chat("open notepad")
        self.assertEqual(reply.proposal, {"name": "open_notepad", "args": {}})
        self.assertEqual(reply.text, "Opening Notepad, sir.")

    def test_proposal_is_extracted_from_a_fenced_reply(self) -> None:
        _StubHandler.reply_body = {
            "choices": [
                {
                    "message": {
                        "content": '```json\n{"proposal": {"command": "get_current_time", "args": {}}}\n```'
                    }
                }
            ]
        }
        reply = self.client.chat("what time is it")
        self.assertEqual(reply.proposal, {"name": "get_current_time", "args": {}})

    def test_plain_prose_stays_prose(self) -> None:
        reply = self.client.chat("explain entropy")
        self.assertIsNone(reply.proposal)
        self.assertEqual(reply.text, "Hello, sir.")

    # ----------------------------------------------------------------- errors
    def test_http_error_is_reported_without_the_key(self) -> None:
        _StubHandler.reply_status = 500
        with self.assertRaises(LlmUnavailable) as ctx:
            self.client.chat("hello")
        message = str(ctx.exception)
        self.assertIn("HTTP 500", message)
        self.assertNotIn(API_KEY, message)
        self.assertNotIn("supersecret", message)

    def test_empty_choices_is_an_error(self) -> None:
        _StubHandler.reply_body = {"choices": []}
        with self.assertRaises(LlmUnavailable):
            self.client.chat("hello")

    def test_unreachable_provider_is_reported(self) -> None:
        settings = Settings(
            state_dir=Path(self._tmp.name),
            token="t",
            llm_api_key=API_KEY,
            llm_base_url="http://127.0.0.1:9/v1",
            llm_timeout_s=2.0,
        )
        with self.assertRaises(LlmUnavailable) as ctx:
            LlmClient(settings).chat("hello")
        self.assertNotIn(API_KEY, str(ctx.exception))

    def test_unconfigured_client_refuses_to_call_out(self) -> None:
        client = LlmClient(Settings(state_dir=Path(self._tmp.name), token="t"))
        self.assertFalse(client.configured)
        with self.assertRaises(LlmUnavailable):
            client.chat("hello")
        self.assertEqual(_StubHandler.received, [])

    def test_refuses_plain_http_to_a_remote_host(self) -> None:
        settings = Settings(
            state_dir=Path(self._tmp.name),
            token="t",
            llm_api_key=API_KEY,
            llm_base_url="http://api.example.com/v1",
        )
        with self.assertRaises(LlmUnavailable) as ctx:
            LlmClient(settings).chat("hello")
        self.assertIn("https", str(ctx.exception))
        self.assertEqual(_StubHandler.received, [])

    def test_status_never_exposes_the_key(self) -> None:
        status = provider_status(self.settings)
        self.assertNotIn(API_KEY, json.dumps(status))
        self.assertNotIn("apiKey", json.dumps(status))
        self.assertTrue(status["configured"])


class ProposalParsingTests(unittest.TestCase):
    def test_accepts_well_formed_proposals(self) -> None:
        self.assertEqual(
            parse_proposal({"command": "set_volume", "args": {"level": 0.4}}),
            {"name": "set_volume", "args": {"level": 0.4}},
        )
        self.assertEqual(parse_proposal({"command": "open_notepad"}), {"name": "open_notepad", "args": {}})

    def test_rejects_malformed_or_shell_shaped_proposals(self) -> None:
        rejected = (
            None,
            "open_notepad",
            {},
            {"command": ""},
            {"command": 12},
            {"command": "open_notepad; rm -rf /"},
            {"command": "Open_Notepad"},
            {"command": "open notepad"},
            {"command": "open_notepad", "args": {"path": {"nested": 1}}},
            {"command": "open_notepad", "args": {"path": ["a"]}},
            {"command": "open_notepad", "args": {"path": "x" * 500}},
            {"command": "open_notepad", "args": {f"k{i}": i for i in range(20)}},
        )
        for raw in rejected:
            with self.subTest(raw=raw):
                self.assertIsNone(parse_proposal(raw))

    def test_a_parsed_proposal_still_has_to_pass_the_allowlist(self) -> None:
        proposal = parse_proposal({"command": "delete_file", "args": {"path": "C:/"}})
        assert proposal is not None
        with self.assertRaises(RequestError) as ctx:
            registry.require_command(proposal["name"])
        self.assertEqual(ctx.exception.status, 403)


class HostileReplyTests(unittest.TestCase):
    """A model that tries to trigger a blocked capability must be refused."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.provider = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
        cls.thread = threading.Thread(target=cls.provider.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.provider.shutdown()
        cls.provider.server_close()
        cls._tmp.cleanup()

    def build_service(self) -> JarvisService:
        port = int(self.provider.server_address[1])
        settings = Settings(
            state_dir=Path(self._tmp.name),
            token="t",
            llm_api_key=API_KEY,
            llm_base_url=f"http://127.0.0.1:{port}/v1",
            llm_model="stub/model-1",
        )
        build_registry(settings, SiteAllowlist((), settings.sites_path))
        return JarvisService(settings)

    def test_blocked_command_from_the_model_is_rejected_not_executed(self) -> None:
        _StubHandler.reply_status = 200
        _StubHandler.reply_body = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "proposal": {"command": "delete_file", "args": {"path": "C:/Windows"}},
                                "reply": "Deleting that now.",
                            }
                        )
                    }
                }
            ]
        }
        response = self.build_service().message({"text": "please wipe my important folder"})
        self.assertNotIn("proposal", response)
        self.assertIn("proposalRejected", response)
        self.assertEqual(response["kind"], "answer")

    def test_unknown_command_from_the_model_is_rejected(self) -> None:
        _StubHandler.reply_body = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps({"proposal": {"command": "teleport_me", "args": {}}, "reply": "Sure."})
                    }
                }
            ]
        }
        response = self.build_service().message({"text": "teleport me to the office"})
        self.assertNotIn("proposal", response)
        self.assertIn("proposalRejected", response)

    def test_a_valid_proposal_is_surfaced_for_confirmation_not_run(self) -> None:
        _StubHandler.reply_body = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"proposal": {"command": "open_calculator", "args": {}}, "reply": "Certainly."}
                        )
                    }
                }
            ]
        }
        service = self.build_service()
        response = service.message({"text": "could you get my calculator up"})
        self.assertEqual(response["kind"], "proposal")
        self.assertEqual(response["proposal"], {"name": "open_calculator", "args": {}})
        self.assertNotIn("status", response)  # nothing ran


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

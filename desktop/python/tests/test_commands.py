"""Executor tests: the end-to-end path from a validated name to a reported result."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from jarvis_service import registry
from jarvis_service.commands import SiteAllowlist, build_registry, execute, interpret_local
from jarvis_service.config import Settings
from jarvis_service.permissions import ApprovalStore
from jarvis_service.security import RequestError
from jarvis_service.windows_actions import ActionResult

OK = ActionResult(True, "ok", "done", verified=True)


class ExecutorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "documents").mkdir()
        (self.root / "documents" / "invoice-2026.pdf").write_text("x", encoding="utf-8")
        (self.root / "documents" / "notes.txt").write_text("x", encoding="utf-8")
        self.settings = Settings(state_dir=self.root, token="t", search_roots=(self.root,))
        build_registry(self.settings, SiteAllowlist((), self.settings.sites_path))
        self.approvals = ApprovalStore()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_cmd(self, name: str, args: dict | None = None, request_id: str | None = None) -> dict:
        return execute(name, args or {}, approvals=self.approvals, request_id=request_id)

    # ----------------------------------------------------------- direct paths
    def test_read_command_runs_directly_and_reports_verified(self) -> None:
        with mock.patch("jarvis_service.commands.windows_actions.local_time", return_value=OK):
            result = self.run_cmd("get_current_time")
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["verified"])
        self.assertEqual(result["command"], "get_current_time")
        self.assertIn("summary", result)

    def test_simple_action_runs_without_confirmation(self) -> None:
        handler = mock.Mock(return_value=OK)
        with mock.patch("jarvis_service.commands.windows_actions.open_notepad", handler):
            result = self.run_cmd("open_notepad")
        self.assertTrue(result["ok"])
        handler.assert_called_once_with()

    def test_unconfirmed_launch_is_reported_as_not_verified(self) -> None:
        fake = ActionResult(False, "failed", "Notepad did not appear in the process list", verified=False)
        with mock.patch("jarvis_service.commands.windows_actions.open_notepad", return_value=fake):
            result = self.run_cmd("open_notepad")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["verified"])

    def test_handler_exception_is_sanitized(self) -> None:
        def boom() -> ActionResult:
            raise ValueError("crash with sk-live-supersecretkey123")

        with mock.patch("jarvis_service.commands.windows_actions.local_time", boom):
            result = self.run_cmd("get_current_time")
        self.assertFalse(result["ok"])
        self.assertEqual(result["detail"], "the action failed (ValueError)")
        self.assertNotIn("supersecret", json.dumps(result))
        self.assertNotIn("Traceback", json.dumps(result))

    # --------------------------------------------------------- approval paths
    def test_sensitive_action_needs_confirmation_then_runs_once(self) -> None:
        handler = mock.Mock(return_value=OK)
        with mock.patch("jarvis_service.commands.windows_actions.set_volume", handler):
            first = self.run_cmd("set_volume", {"level": 0.4})
            self.assertEqual(first["status"], "confirmation_required")
            self.assertIn("40%", first["summary"])
            request_id = first["request"]["requestId"]
            handler.assert_not_called()

            second = self.run_cmd("set_volume", {"level": 0.4}, request_id=request_id)
            self.assertTrue(second["ok"])
            handler.assert_called_once_with(0.4)

            with self.assertRaises(RequestError) as ctx:
                self.run_cmd("set_volume", {"level": 0.4}, request_id=request_id)
        self.assertEqual(ctx.exception.code, "approval_invalid")

    def test_approval_cannot_be_reused_for_different_arguments(self) -> None:
        with mock.patch("jarvis_service.commands.windows_actions.set_volume", return_value=OK):
            first = self.run_cmd("set_volume", {"level": 0.2})
            request_id = first["request"]["requestId"]
            with self.assertRaises(RequestError) as ctx:
                self.run_cmd("set_volume", {"level": 1.0}, request_id=request_id)
        self.assertEqual(ctx.exception.code, "approval_mismatch")

    def test_no_approval_never_reaches_the_handler(self) -> None:
        handler = mock.Mock(return_value=OK)
        with mock.patch("jarvis_service.commands.windows_actions.set_volume", handler):
            self.run_cmd("set_volume", {"level": 0.9})
            with self.assertRaises(RequestError):
                self.run_cmd("set_volume", {"level": 0.9}, request_id="forged-id")
        handler.assert_not_called()

    def test_blocked_capability_is_refused_before_anything_else(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            self.run_cmd("delete_file", {"path": "C:/important"})
        self.assertEqual(ctx.exception.status, 403)

    # ------------------------------------------------------------- websites
    def test_first_visit_to_a_site_asks_for_confirmation(self) -> None:
        handler = mock.Mock(return_value=ActionResult(True, "ok", "handed to browser"))
        args = {"url": "https://example.com/docs"}
        with mock.patch("jarvis_service.commands.windows_actions.open_website", handler):
            result = self.run_cmd("open_website", args)
            self.assertEqual(result["status"], "confirmation_required")
            self.assertIn("https://example.com/docs", result["summary"])
            handler.assert_not_called()

            # The approval is re-issued for exactly the same action and target.
            approved = self.run_cmd("open_website", args, request_id=result["request"]["requestId"])
            self.assertTrue(approved["ok"])
            handler.assert_called_once_with("https://example.com/docs")

            # The host was opened once; it is still not remembered, so it asks again.
            again = self.run_cmd("open_website", {"url": "https://example.com/other"})
            self.assertEqual(again["status"], "confirmation_required")

    def test_remembering_a_site_requires_approving_that_exact_request(self) -> None:
        handler = mock.Mock(return_value=ActionResult(True, "ok", "handed to browser"))
        args = {"url": "https://docs.example.org/guide", "remember": True}
        with mock.patch("jarvis_service.commands.windows_actions.open_website", handler):
            result = self.run_cmd("open_website", args)
            self.assertEqual(result["status"], "confirmation_required")
            self.assertIn("remember", result["summary"])

            approved = self.run_cmd("open_website", args, request_id=result["request"]["requestId"])
            self.assertTrue(approved["ok"])
            self.assertIn("docs.example.org", self.settings.sites_path.read_text(encoding="utf-8"))

            # Now a different page on the remembered host opens directly.
            direct = self.run_cmd("open_website", {"url": "https://docs.example.org/other"})
            self.assertTrue(direct["ok"], direct)

    def test_remember_without_approval_is_refused(self) -> None:
        with mock.patch("jarvis_service.commands.windows_actions.open_website", return_value=OK):
            result = self.run_cmd("open_website", {"url": "https://new.example", "remember": True})
            self.assertEqual(result["status"], "confirmation_required")
            stored = (
                self.settings.sites_path.read_text(encoding="utf-8")
                if self.settings.sites_path.exists()
                else ""
            )
            self.assertNotIn("new.example", stored)

    def test_non_https_addresses_are_rejected(self) -> None:
        for url in ("http://example.com", "file:///C:/Windows/System32", "javascript:alert(1)", "ms-settings:"):
            with self.subTest(url=url):
                with self.assertRaises(RequestError) as ctx:
                    self.run_cmd("open_website", {"url": url})
                self.assertEqual(ctx.exception.status, 400)

    # ---------------------------------------------------------- file search
    def test_filename_search_finds_matches_inside_the_allowed_root(self) -> None:
        result = self.run_cmd("find_file", {"query": "invoice"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["verified"])
        self.assertEqual(len(result["data"]["matches"]), 1)
        self.assertTrue(result["data"]["matches"][0]["path"].endswith("invoice-2026.pdf"))

    def test_filename_search_reports_misses_honestly(self) -> None:
        result = self.run_cmd("find_file", {"query": "gibberish-name"})
        self.assertTrue(result["ok"])
        self.assertIn("no file named like", result["detail"])

    def test_filename_search_is_confined_to_configured_roots(self) -> None:
        for root in ("/", "/etc", str(Path.home())):
            with self.subTest(root=root):
                with self.assertRaises(RequestError) as ctx:
                    self.run_cmd("find_file", {"query": "passwd", "root": root})
                self.assertEqual(ctx.exception.status, 403)
                self.assertEqual(ctx.exception.code, "root_not_permitted")

    def test_explorer_cannot_open_an_arbitrary_traversal_path(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            self.run_cmd("open_file_explorer", {"path": "/etc/../etc"})
        self.assertEqual(ctx.exception.code, "root_not_permitted")


class IntentTests(unittest.TestCase):
    def test_recognises_supported_phrases(self) -> None:
        cases = {
            "open notepad": ("open_notepad", {}),
            "can you open the calculator": ("open_calculator", {}),
            "open file explorer": ("open_file_explorer", {}),
            "what time is it": ("get_current_time", {}),
            "give me the system info": ("get_system_info", {}),
            "set the volume to 35 percent": ("set_volume", {"level": 0.35}),
            "find a file named invoice": ("find_file", {"query": "invoice"}),
            "search my documents for a file named report.pdf": ("find_file", {"query": "report.pdf"}),
            "open https://example.com/docs": ("open_website", {"url": "https://example.com/docs"}),
        }
        for phrase, (name, args) in cases.items():
            with self.subTest(phrase=phrase):
                self.assertEqual(interpret_local(phrase), {"name": name, "args": args})

    def test_leaves_general_questions_for_the_ai(self) -> None:
        for phrase in ("tell me a joke about robots", "", "   ", "explain quantum tunnelling"):
            with self.subTest(phrase=phrase):
                self.assertIsNone(interpret_local(phrase))

    def test_recognised_intents_still_pass_through_the_allowlist(self) -> None:
        proposal = interpret_local("open https://example.com")
        assert proposal is not None
        spec = registry.require_command(proposal["name"])
        self.assertEqual(spec.name, "open_website")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

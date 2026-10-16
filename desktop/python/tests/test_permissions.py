"""Permission policy and approval-store tests.

These cover the rules that must never regress: sensitive actions need a fresh,
single-use approval that is bound to the exact command and arguments.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from jarvis_service import registry
from jarvis_service.commands import SiteAllowlist, build_registry
from jarvis_service.config import Settings
from jarvis_service.permissions import (
    ApprovalStore,
    approval_context,
    approval_granted,
    evaluate,
    fingerprint,
)
from jarvis_service.security import RequestError


def make_settings(state_dir: Path) -> Settings:
    return Settings(state_dir=state_dir, token="t", search_roots=(state_dir,))


class PolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        settings = make_settings(Path(self._tmp.name))
        build_registry(settings, SiteAllowlist((), settings.sites_path))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def spec(self, name: str) -> registry.CommandSpec:
        spec = registry.get(name)
        assert spec is not None
        return spec

    def test_read_commands_run_directly(self) -> None:
        self.assertEqual(evaluate(self.spec("get_current_time"), {}).status, "allow")
        self.assertEqual(evaluate(self.spec("find_file"), {"query": "notes"}).status, "allow")

    def test_simple_actions_run_directly(self) -> None:
        self.assertEqual(evaluate(self.spec("open_calculator"), {}).status, "allow")
        self.assertEqual(evaluate(self.spec("open_notepad"), {}).status, "allow")

    def test_sensitive_actions_need_confirmation(self) -> None:
        decision = evaluate(self.spec("set_volume"), {"level": 0.4})
        self.assertEqual(decision.status, "confirm")
        self.assertIn("40%", decision.summary)

    def test_summaries_describe_the_exact_target(self) -> None:
        summary = self.spec("open_website").summary({"url": "https://example.com/x"})
        self.assertIn("https://example.com/x", summary)

    def test_denied_names_are_blocked_even_if_registered(self) -> None:
        spec = registry.CommandSpec(
            name="delete_file", description="nope", danger=registry.BLOCKED, handler=lambda: None
        )
        decision = evaluate(spec, {})
        self.assertEqual(decision.status, "blocked")
        self.assertIn("Blocked by policy", decision.reason)


class ApprovalGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = ApprovalStore(ttl_s=60.0)

    def test_approval_is_single_use(self) -> None:
        request = self.store.issue("set_volume", {"level": 0.4}, "Set volume to 40%")
        self.store.approve(request.request_id)
        self.store.consume(request.request_id, "set_volume", {"level": 0.4})
        with self.assertRaises(RequestError) as ctx:
            self.store.consume(request.request_id, "set_volume", {"level": 0.4})
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, "approval_invalid")

    def test_approval_is_bound_to_the_exact_arguments(self) -> None:
        request = self.store.issue("set_volume", {"level": 0.4}, "Set volume to 40%")
        with self.assertRaises(RequestError) as ctx:
            self.store.consume(request.request_id, "set_volume", {"level": 1.0})
        self.assertEqual(ctx.exception.code, "approval_mismatch")
        # The original approval is still intact and usable for the approved target.
        self.store.consume(request.request_id, "set_volume", {"level": 0.4})

    def test_approval_is_bound_to_the_exact_command(self) -> None:
        request = self.store.issue("set_volume", {}, "Set volume")
        with self.assertRaises(RequestError) as ctx:
            self.store.consume(request.request_id, "open_notepad", {})
        self.assertEqual(ctx.exception.code, "approval_mismatch")

    def test_unknown_approval_is_refused(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            self.store.consume("not-a-real-id", "set_volume", {"level": 0.4})
        self.assertEqual(ctx.exception.code, "approval_invalid")

    def test_rejecting_removes_the_pending_request(self) -> None:
        request = self.store.issue("set_volume", {"level": 0.1}, "Set volume")
        self.store.reject(request.request_id)
        with self.assertRaises(RequestError):
            self.store.consume(request.request_id, "set_volume", {"level": 0.1})

    def test_expired_approval_is_refused(self) -> None:
        store = ApprovalStore(ttl_s=0.0)
        request = store.issue("set_volume", {"level": 0.1}, "Set volume")
        with self.assertRaises(RequestError) as ctx:
            store.consume(request.request_id, "set_volume", {"level": 0.1})
        self.assertEqual(ctx.exception.code, "approval_invalid")

    def test_pending_list_is_exposed_without_fingerprints(self) -> None:
        self.store.issue("set_volume", {"level": 0.2}, "Set volume to 20%")
        pending = self.store.pending()
        self.assertEqual(len(pending), 1)
        self.assertNotIn("fingerprint", pending[0])
        self.assertEqual(pending[0]["command"], "set_volume")

    def test_request_id_validation(self) -> None:
        for value in (None, "", "   ", 42):
            with self.subTest(value=value):
                with self.assertRaises(RequestError):
                    self.store.check_request_id(value)
        self.assertEqual(self.store.check_request_id(" abc "), "abc")

    def test_fingerprint_is_stable_and_argument_sensitive(self) -> None:
        self.assertEqual(fingerprint("a", {"x": 1}), fingerprint("a", {"x": 1}))
        self.assertNotEqual(fingerprint("a", {"x": 1}), fingerprint("a", {"x": 2}))
        self.assertNotEqual(fingerprint("a", {"x": 1}), fingerprint("b", {"x": 1}))
        self.assertEqual(fingerprint("a", {"x": 1, "y": 2}), fingerprint("a", {"y": 2, "x": 1}))


class ApprovalContextTests(unittest.TestCase):
    def test_defaults_to_false_and_resets_after_use(self) -> None:
        self.assertFalse(approval_granted())
        with approval_context(True):
            self.assertTrue(approval_granted())
            with approval_context(False):
                self.assertFalse(approval_granted())
            self.assertTrue(approval_granted())
        self.assertFalse(approval_granted())

    def test_context_is_cleared_even_when_the_body_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            with approval_context(True):
                raise RuntimeError("boom")
        self.assertFalse(approval_granted())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

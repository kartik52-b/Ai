"""Allowlist and argument validation tests — the first line of defence."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from jarvis_service import registry
from jarvis_service.commands import SiteAllowlist, build_registry
from jarvis_service.config import Settings
from jarvis_service.security import RequestError


def make_settings(state_dir: Path) -> Settings:
    return Settings(state_dir=state_dir, token="test-token", search_roots=(state_dir,))


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self._tmp.name))
        build_registry(self.settings, SiteAllowlist((), self.settings.sites_path))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_expected_commands_are_registered(self) -> None:
        expected = {
            "open_calculator",
            "open_notepad",
            "open_file_explorer",
            "open_website",
            "get_current_time",
            "get_system_info",
            "find_file",
            "set_volume",
        }
        self.assertEqual(set(registry.REGISTRY), expected)

    def test_destructive_names_are_refused(self) -> None:
        for name in (
            "delete_file",
            "remove_directory",
            "run_script",
            "install_software",
            "powershell",
            "change_defender_settings",
            "elevate_privileges",
            "exec_shell",
        ):
            with self.subTest(name=name):
                with self.assertRaises(RequestError) as ctx:
                    registry.require_command(name)
                self.assertEqual(ctx.exception.status, 403)
                self.assertEqual(ctx.exception.code, "command_blocked")

    def test_unknown_command_is_rejected(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            registry.require_command("make_coffee")
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.code, "unknown_command")

    def test_non_string_command_is_rejected(self) -> None:
        for value in (None, 7, {"name": "open_notepad"}, ["open_notepad"]):
            with self.subTest(value=value):
                with self.assertRaises(RequestError):
                    registry.require_command(value)

    def test_registration_guards(self) -> None:
        with self.assertRaises(ValueError):
            registry.register(
                registry.CommandSpec(
                    name="open_notepad", description="dup", danger=registry.ACTION, handler=lambda: None
                )
            )
        with self.assertRaises(ValueError):
            registry.register(
                registry.CommandSpec(name="Bad Name", description="x", danger=registry.ACTION, handler=lambda: None)
            )


class ArgumentTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self._tmp.name))
        build_registry(self.settings, SiteAllowlist((), self.settings.sites_path))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def spec(self, name: str) -> registry.CommandSpec:
        spec = registry.get(name)
        assert spec is not None
        return spec

    def test_rejects_unknown_argument(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            registry.validate_args(self.spec("open_calculator"), {"evil": "1"})
        self.assertEqual(ctx.exception.code, "unknown_arg")

    def test_rejects_missing_required_argument(self) -> None:
        with self.assertRaises(RequestError) as ctx:
            registry.validate_args(self.spec("set_volume"), {})
        self.assertEqual(ctx.exception.code, "missing_arg")

    def test_rejects_out_of_range_numbers(self) -> None:
        for level in (-0.1, 1.5, 900):
            with self.subTest(level=level):
                with self.assertRaises(RequestError):
                    registry.validate_args(self.spec("set_volume"), {"level": level})
        self.assertEqual(registry.validate_args(self.spec("set_volume"), {"level": 0.5}), {"level": 0.5})

    def test_rejects_wrong_types(self) -> None:
        with self.assertRaises(RequestError):
            registry.validate_args(self.spec("set_volume"), {"level": "loud"})
        with self.assertRaises(RequestError):
            registry.validate_args(self.spec("set_volume"), {"level": True})
        with self.assertRaises(RequestError):
            registry.validate_args(self.spec("find_file"), {"query": 12})
        with self.assertRaises(RequestError):
            registry.validate_args(self.spec("open_website"), {"url": "https://x.test", "remember": "yes"})

    def test_rejects_path_separators_in_filenames(self) -> None:
        for query in ("../../etc/passwd", "dir\\file.txt", "a/b"):
            with self.subTest(query=query):
                with self.assertRaises(RequestError) as ctx:
                    registry.validate_args(self.spec("find_file"), {"query": query})
                self.assertEqual(ctx.exception.code, "invalid_arg")

    def test_bounds_max_results(self) -> None:
        for value in (0, 500):
            with self.subTest(value=value):
                with self.assertRaises(RequestError):
                    registry.validate_args(self.spec("find_file"), {"query": "x", "maxResults": value})
        self.assertEqual(
            registry.validate_args(self.spec("find_file"), {"query": "x", "maxResults": 5})["maxResults"], 5
        )

    def test_trims_strings_and_enforces_length(self) -> None:
        self.assertEqual(
            registry.validate_args(self.spec("open_website"), {"url": "  https://a.test  "})["url"],
            "https://a.test",
        )
        with self.assertRaises(RequestError):
            registry.validate_args(self.spec("open_website"), {"url": "https://a.test/" + "x" * 500})
        with self.assertRaises(RequestError):
            registry.validate_args(self.spec("open_website"), {"url": "   "})

    def test_catalog_exposes_policy_flags(self) -> None:
        catalog = {item["name"]: item for item in registry.catalog()}
        self.assertEqual(catalog["get_current_time"]["danger"], "read")
        self.assertFalse(catalog["get_current_time"]["requiresConfirmation"])
        self.assertEqual(catalog["set_volume"]["danger"], "sensitive")
        self.assertTrue(catalog["set_volume"]["requiresConfirmation"])
        self.assertEqual(catalog["open_calculator"]["danger"], "action")
        self.assertFalse(catalog["open_calculator"]["requiresConfirmation"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

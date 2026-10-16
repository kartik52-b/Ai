"""Operating-system primitives.

Everything here is a *fixed* argv list (never `shell=True`), and each action
reports whether the OS actually confirmed the outcome. Nothing in this module
modifies or deletes files, changes system settings, or elevates privileges.
"""

from __future__ import annotations

import datetime as _dt
import os
import platform
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import importlib.util

#: Directories that would make a filename search unusably slow.
SKIPPED_DIR_NAMES = {
    ".git",
    ".svn",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "site-packages",
    ".cache",
    "Windows",
    "$Recycle.Bin",
}

MAX_SEARCH_ENTRIES = 200_000
MAX_SEARCH_DEPTH = 8


@dataclass
class ActionResult:
    """Result of a local action, including whether the OS confirmed it."""

    ok: bool
    status: str  # "ok" | "unsupported" | "failed"
    detail: str
    verified: bool = False
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "detail": self.detail,
            "verified": self.verified,
            "data": self.data,
        }


def is_windows() -> bool:
    return os.name == "nt"


# --------------------------------------------------------------------- helpers
def _module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):  # pragma: no cover - defensive
        return False


def _run(argv: Sequence[str], timeout: float = 6.0) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def process_running(image_names: Iterable[str]) -> bool | None:
    """Is any of these process images running? `None` means "cannot verify"."""
    names = [n.lower() for n in image_names]
    if is_windows():
        for name in names:
            result = _run(["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH"])
            if result is None:
                return None
            if name in result.stdout.lower():
                return True
        return False
    pgrep = shutil.which("pgrep")
    if pgrep is None:
        return None
    for name in names:
        result = _run([pgrep, "-if", name])
        if result is None:
            return None
        if result.returncode == 0 and result.stdout.strip():
            return True
    return False


def pid_alive(pid: int) -> bool | None:
    """Is this process id still alive? `None` means "cannot tell"."""
    if pid <= 0:
        return False
    if _module_available("psutil"):
        import psutil  # type: ignore[import-not-found]

        return psutil.pid_exists(pid)
    if is_windows():
        result = _run(["tasklist", "/FI", f"PID eq {pid}", "/NH"])
        if result is None:
            return None
        return str(pid) in result.stdout
    proc = Path(f"/proc/{pid}")
    if proc.exists():
        return True
    return None


def _launch(argv: Sequence[str], image_names: Sequence[str], label: str) -> ActionResult:
    """Launch a fixed process and confirm it with the OS."""
    try:
        subprocess.Popen(list(argv), shell=False, close_fds=True)
    except FileNotFoundError:
        return ActionResult(False, "failed", f"{label} could not be launched: executable not found")
    except OSError as exc:
        return ActionResult(False, "failed", f"{label} could not be launched: {type(exc).__name__}")

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        running = process_running(image_names)
        if running is True:
            return ActionResult(True, "ok", f"{label} is running", verified=True)
        if running is None:
            return ActionResult(
                True,
                "ok",
                f"{label} was launched (process state could not be verified on this system)",
                verified=False,
            )
        time.sleep(0.25)

    return ActionResult(
        False,
        "failed",
        f"{label} was started but has not appeared in the process list — the OS did not confirm it",
        verified=False,
    )


# ------------------------------------------------------------------- app launch
def open_calculator() -> ActionResult:
    if is_windows():
        result = _launch(["calc.exe"], ["calculator.exe", "calc.exe", "calculatorapp.exe"], "Calculator")
        if result.ok:
            return result
        # Windows 11 sometimes needs the app-activation path instead of the alias.
        return _launch(
            ["explorer.exe", r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"],
            ["calculator.exe", "calc.exe", "calculatorapp.exe"],
            "Calculator",
        )
    if shutil.which("gnome-calculator"):
        return _launch(["gnome-calculator"], ["gnome-calculator"], "Calculator")
    return ActionResult(False, "unsupported", "Calculator launching is only wired for Windows")


def open_notepad() -> ActionResult:
    if is_windows():
        return _launch(["notepad.exe"], ["notepad.exe"], "Notepad")
    return ActionResult(False, "unsupported", "Notepad launching is only wired for Windows")


def open_file_explorer(path: str | None = None) -> ActionResult:
    if not is_windows():
        return ActionResult(False, "unsupported", "File Explorer launching is only wired for Windows")
    if path:
        target = Path(path)
        if not target.is_dir():
            return ActionResult(False, "failed", f"not a directory: {target}")
        return _launch(["explorer.exe", str(target)], ["explorer.exe"], "File Explorer")
    return _launch(["explorer.exe"], ["explorer.exe"], "File Explorer")


def open_website(url: str) -> ActionResult:
    if not url.lower().startswith("https://"):
        return ActionResult(False, "failed", "only https:// addresses may be opened")
    if is_windows():
        try:
            os.startfile(url)  # type: ignore[attr-defined]  # noqa: S606 - fixed https URL only
        except OSError as exc:
            return ActionResult(False, "failed", f"could not open the URL: {type(exc).__name__}")
    else:
        import webbrowser

        opened = webbrowser.open(url)
        if not opened:
            return ActionResult(False, "failed", "no browser accepted the URL")
    return ActionResult(
        True,
        "ok",
        f"handed https:// address to the default browser: {url}",
        verified=False,
        data={"url": url},
    )


# ----------------------------------------------------------------------- volume
def volume_available() -> bool:
    return is_windows() and _module_available("pycaw")


def set_volume(level: float) -> ActionResult:
    """Set master volume to a 0..1 scalar and read it back to confirm."""
    if not is_windows():
        return ActionResult(False, "unsupported", "volume control requires Windows")
    if not _module_available("pycaw"):
        return ActionResult(
            False,
            "unsupported",
            "volume control needs the optional pycaw package — install it with "
            "'pip install pycaw' in the local service environment",
        )
    try:
        from pycaw.pycaw import AudioUtilities  # type: ignore[import-not-found]

        device = AudioUtilities.GetSpeakers()
        volume = device.EndpointVolume
        volume.SetMasterVolumeLevelScalar(float(level), None)
        readback = float(volume.GetMasterVolumeLevelScalar())
    except Exception as exc:  # noqa: BLE001 - third-party COM can raise anything
        return ActionResult(False, "failed", f"volume change failed: {type(exc).__name__}")

    if abs(readback - float(level)) > 0.02:
        return ActionResult(
            False,
            "failed",
            f"the OS did not apply the requested volume (asked {level:.2f}, read back {readback:.2f})",
            verified=False,
            data={"requested": level, "actual": readback},
        )
    return ActionResult(
        True,
        "ok",
        f"master volume set to {round(readback * 100)}%",
        verified=True,
        data={"level": round(readback, 3)},
    )


def get_volume() -> ActionResult:
    if not volume_available():
        return ActionResult(False, "unsupported", "volume readback requires Windows and pycaw")
    try:
        from pycaw.pycaw import AudioUtilities  # type: ignore[import-not-found]

        volume = AudioUtilities.GetSpeakers().EndpointVolume
        level = float(volume.GetMasterVolumeLevelScalar())
        muted = bool(volume.GetMute())
    except Exception as exc:  # noqa: BLE001
        return ActionResult(False, "failed", f"volume read failed: {type(exc).__name__}")
    return ActionResult(
        True, "ok", f"volume is {round(level * 100)}%", verified=True, data={"level": level, "muted": muted}
    )


# ---------------------------------------------------------------- information
def local_time() -> ActionResult:
    now = _dt.datetime.now().astimezone()
    return ActionResult(
        True,
        "ok",
        now.strftime("It is %I:%M %p on %A, %d %B %Y").replace(" 0", " "),
        verified=True,
        data={"iso": now.isoformat(), "timezone": now.tzname() or "local"},
    )


def system_info() -> ActionResult:
    memory: dict[str, Any] = {}
    if _module_available("psutil"):
        import psutil  # type: ignore[import-not-found]

        virtual = psutil.virtual_memory()
        disk = psutil.disk_usage(str(Path.home()))
        memory = {
            "totalGb": round(virtual.total / 1e9, 1),
            "availableGb": round(virtual.available / 1e9, 1),
            "diskFreeGb": round(disk.free / 1e9, 1),
        }

    info: dict[str, Any] = {
        "os": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "cpuCount": os.cpu_count() or 0,
        "python": platform.python_version(),
        **memory,
    }
    if is_windows():
        try:
            info["hostname"] = platform.node()
        except Exception:  # noqa: BLE001 - never fail the whole report
            pass

    parts = [f"{info['os']} on {info['machine']}", f"{info['cpuCount']} logical processors"]
    if memory:
        parts.append(f"{memory['availableGb']} GB of {memory['totalGb']} GB RAM free")
        parts.append(f"{memory['diskFreeGb']} GB free on the system drive")
    return ActionResult(True, "ok", "; ".join(parts), verified=True, data=info)


# --------------------------------------------------------------- file search
def search_files(query: str, root: str, max_results: int) -> ActionResult:
    """Read-only recursive filename search, bounded in depth and entry count."""
    base = Path(root)
    if not base.is_dir():
        return ActionResult(False, "failed", f"search root is not a directory: {base}")

    needle = query.lower()
    matches: list[dict[str, Any]] = []
    scanned = 0
    truncated = False

    for current, dirs, files in os.walk(base, topdown=True, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIPPED_DIR_NAMES and not d.startswith("$")]
        depth = len(Path(current).relative_to(base).parts)
        if depth >= MAX_SEARCH_DEPTH:
            dirs[:] = []
        for name in files:
            scanned += 1
            if scanned > MAX_SEARCH_ENTRIES:
                truncated = True
                break
            if needle in name.lower():
                full = Path(current) / name
                try:
                    stat = full.stat()
                except OSError:
                    continue
                matches.append(
                    {
                        "name": name,
                        "path": str(full),
                        "sizeBytes": stat.st_size,
                        "modified": _dt.datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                    }
                )
                if len(matches) >= max_results:
                    truncated = True
                    break
        if truncated:
            break

    if not matches:
        return ActionResult(
            True, "ok", f"no file named like {query!r} found under {base}", verified=True, data={"matches": []}
        )
    verb = "match" if len(matches) == 1 else "matches"
    suffix = " (stopped early — narrow the search for more)" if truncated else ""
    return ActionResult(
        True,
        "ok",
        f"found {len(matches)} {verb} under {base}{suffix}",
        verified=True,
        data={"matches": matches, "truncated": truncated},
    )

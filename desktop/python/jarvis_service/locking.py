"""Single-instance guard.

The desktop app must never end up with two copies of the local service fighting
over the microphone. Electron also kills a stale child before spawning, so this
is the second line of defence.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from . import windows_actions

log = logging.getLogger("jarvis.lock")


class SingleInstanceLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._held = False

    def owner_pid(self) -> int | None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        pid = payload.get("pid")
        return int(pid) if isinstance(pid, int) else None

    def acquire(self) -> bool:
        """True when this process may run. False when another live copy holds it."""
        if self.path.exists():
            owner = self.owner_pid()
            alive = windows_actions.pid_alive(owner) if owner else False
            if alive:
                log.error("another JARVIS service (pid %s) is already running", owner)
                return False
            if alive is None:  # pragma: no cover - platform dependent
                log.warning("could not verify the holder of %s; taking it over", self.path)
            else:
                log.info("removing stale lock left by pid %s", owner)
            self.release()

        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:  # pragma: no cover - race with another starter
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"pid": os.getpid(), "startedAt": time.time()}, handle)
        self._held = True
        return True

    def release(self) -> None:
        if self._held or self.path.exists():
            try:
                self.path.unlink()
            except OSError:  # pragma: no cover - already gone
                pass
        self._held = False

"""Entry point for the JARVIS local service.

    python -m jarvis_service                # run (Electron passes the port + token)
    python -m jarvis_service --check        # dependency + configuration report
    python -m jarvis_service --check-speech # also try to load the speech engines

The service prints one JSON handshake line on stdout when it is ready, and also
writes the same payload (no token) to <state-dir>/service.json.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
import signal
import sys
import threading
from pathlib import Path

from .config import Settings
from .locking import SingleInstanceLock
from .llm import provider_status
from .server import JarvisService, build_server
from .speech import EngineUnavailable, SpeechStack, probe_dependencies

log = logging.getLogger("jarvis")


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def diagnostics(settings: Settings, deep: bool) -> dict[str, object]:
    report: dict[str, object] = {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "stateDir": str(settings.state_dir),
        "loopbackOnly": settings.host in {"127.0.0.1", "::1", "localhost"},
        "dependencies": probe_dependencies(),
        "llm": provider_status(settings),
        "speech": {},
    }
    if not deep:
        return report

    stack = SpeechStack(settings, emit=lambda _event: None)
    detail: dict[str, object] = {"startable": True}
    for label, factory in (
        ("wakeWord", stack._wake_factory),  # noqa: SLF001 - intentional diagnostic
        ("speechToText", stack._transcriber_factory),  # noqa: SLF001
        ("textToSpeech", stack._speaker_factory),  # noqa: SLF001
    ):
        try:
            engine = factory()
            detail[label] = f"ok: {engine.name}"
        except Exception as exc:  # noqa: BLE001 - report, never crash the probe
            detail[label] = f"unavailable: {exc}"
            detail["startable"] = False
    report["speech"] = detail
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis_service", description="JARVIS local service")
    parser.add_argument("--port", type=int, default=None, help="port to bind on 127.0.0.1 (0 = ephemeral)")
    parser.add_argument("--state-dir", type=Path, default=None, help="override the state directory")
    parser.add_argument("--check", action="store_true", help="print a diagnostics report and exit")
    parser.add_argument("--check-speech", action="store_true", help="load speech engines, then exit")
    parser.add_argument("--no-speech", action="store_true", help="run without the microphone loop")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    _configure_logging(args.verbose)

    try:
        settings = Settings.from_env()
    except ValueError as exc:
        print(json.dumps({"event": "config_error", "error": str(exc)}), flush=True)
        return 2

    overrides = {}
    if args.state_dir is not None:
        overrides["state_dir"] = args.state_dir.expanduser()
    if args.port is not None:
        overrides["port"] = args.port
    if overrides:
        settings = dataclasses.replace(settings, **overrides)
    settings.state_dir.mkdir(parents=True, exist_ok=True)

    if args.check or args.check_speech:
        print(json.dumps(diagnostics(settings, deep=args.check_speech), indent=2))
        return 0

    lock = SingleInstanceLock(settings.state_dir / "service.lock")
    if not lock.acquire():
        print(
            json.dumps(
                {
                    "event": "error",
                    "error": "already_running",
                    "detail": "another JARVIS local service is already running",
                }
            ),
            flush=True,
        )
        return 3

    if settings.token_generated:
        log.warning(
            "no JARVIS_TOKEN supplied — a one-off token was generated and written to %s "
            "for standalone use only",
            settings.handshake_path,
        )

    service = JarvisService(settings)
    if args.no_speech:
        # Replace with an inert stack so /v1/status stays truthful about the mic.
        service.speech = SpeechStack(
            settings,
            service.emit,
            source_factory=_inert_source,
            wake_factory=_inert_engine,
            transcriber_factory=_inert_engine,
            speaker_factory=_inert_engine,
        )

    server, service = build_server(settings, service)
    port = int(server.server_address[1])
    handshake = settings.handshake(port, os.getpid())

    payload = dict(handshake)
    if settings.token_generated:
        payload["token"] = settings.token  # standalone developers only; Electron passes its own
    try:
        settings.handshake_path.parent.mkdir(parents=True, exist_ok=True)
        settings.handshake_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        settings.handshake_path.chmod(0o600)
    except OSError:  # pragma: no cover - informational only
        log.warning("could not write the handshake file at %s", settings.handshake_path)

    stop_event = threading.Event()

    def shutdown(*_args: object) -> None:
        if stop_event.is_set():
            return
        stop_event.set()
        log.info("shutting down")
        threading.Thread(target=server.shutdown, daemon=True).start()

    service.on_shutdown(shutdown)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, shutdown)
        except (ValueError, OSError):  # pragma: no cover - not available on all platforms
            pass

    print(json.dumps({"event": "ready", **handshake}), flush=True)
    log.info("JARVIS local service listening on http://%s:%s", settings.host, port)

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:  # pragma: no cover - signal path covers it
        shutdown()
    finally:
        try:
            service.speech.stop()
        except Exception:  # noqa: BLE001 - shutdown must always complete
            pass
        server.server_close()
        if settings.handshake_path.exists():
            try:
                settings.handshake_path.unlink()
            except OSError:  # pragma: no cover
                pass
        lock.release()
        print(json.dumps({"event": "stopped"}), flush=True)
    return 0


def _inert_source():  # pragma: no cover - used only with --no-speech
    raise EngineUnavailable("the microphone is disabled (--no-speech)")


def _inert_engine():  # pragma: no cover - used only with --no-speech
    raise EngineUnavailable("speech engines are disabled (--no-speech)")


if __name__ == "__main__":
    raise SystemExit(main())

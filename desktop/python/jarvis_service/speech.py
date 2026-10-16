"""Local speech: wake word, speech recognition, speech output.

Privacy rules enforced here:
* audio lives only in memory for the duration of one frame — nothing is written
  to disk, uploaded, or logged;
* only the recognised *text* is ever handed to the assistant or the AI adapter;
* the loop can be muted and stopped at any time from the UI.

The wake word uses the pretrained openWakeWord model identified as
``hey_jarvis`` (ONNX backend, 16 kHz mono int16, 1280-sample frames).
"""

from __future__ import annotations

import array
import importlib.util
import json
import logging
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, ContextManager, Protocol

from .config import Settings

log = logging.getLogger("jarvis.speech")

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 1_280  # 80 ms
WAKE_MODEL_NAME = "hey_jarvis"
VOSK_MODEL_DIRNAME = "vosk-model-small-en-us-0.15"
SILENCE_RMS = 420.0
MAX_UTTERANCE_SECONDS = 10.0
SILENCE_TAIL_SECONDS = 1.1
WAKE_COOLDOWN_SECONDS = 3.0
MAX_MIC_RESTARTS = 3


class EngineUnavailable(RuntimeError):
    """An optional local engine is missing or cannot start."""


class FrameSource(Protocol):
    def __enter__(self) -> "FrameSource": ...
    def read(self) -> bytes: ...
    def __exit__(self, *exc: object) -> None: ...


class WakeEngine(Protocol):
    name: str

    def predict(self, pcm: bytes) -> float: ...
    def reset(self) -> None: ...


class Transcriber(Protocol):
    name: str

    def accept(self, pcm: bytes) -> str | None: ...
    def finish(self) -> str | None: ...
    def reset(self) -> None: ...


class Speaker(Protocol):
    name: str

    def say(self, text: str) -> None: ...
    def stop(self) -> None: ...


@dataclass
class SpeechStatus:
    listening: bool = False
    muted: bool = False
    awaiting_text: bool = False
    wake_engine: str | None = None
    stt_engine: str | None = None
    tts_engine: str | None = None
    wake_threshold: float = 0.55
    error: str | None = None
    error_code: str | None = None
    last_wake_at: float | None = None
    dependencies: dict[str, bool] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "listening": self.listening,
            "muted": self.muted,
            "awaitingText": self.awaiting_text,
            "wakeEngine": self.wake_engine,
            "sttEngine": self.stt_engine,
            "ttsEngine": self.tts_engine,
            "wakeThreshold": self.wake_threshold,
            "error": self.error,
            "errorCode": self.error_code,
            "lastWakeAt": self.last_wake_at,
            "dependencies": self.dependencies,
        }


def probe_dependencies() -> dict[str, bool]:
    """Which optional local speech packages are importable right now."""
    names = ("openwakeword", "sounddevice", "vosk", "pyttsx3", "numpy")
    available: dict[str, bool] = {}
    for name in names:
        try:
            available[name] = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):  # pragma: no cover - defensive
            available[name] = False
    return available


def frame_rms(pcm: bytes) -> float:
    """Root-mean-square of a mono int16 frame, using the standard library only."""
    if len(pcm) < 2:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if not samples:
        return 0.0
    total = 0
    for sample in samples:
        total += sample * sample
    return (total / len(samples)) ** 0.5


# ------------------------------------------------------------------- adapters
class SoundDeviceSource:
    """Microphone frames through PortAudio (sounddevice)."""

    def __init__(self, samplerate: int = SAMPLE_RATE, blocksize: int = FRAME_SAMPLES) -> None:
        if importlib.util.find_spec("sounddevice") is None:
            raise EngineUnavailable("microphone capture needs 'sounddevice' in the local service env")
        self.samplerate = samplerate
        self.blocksize = blocksize
        self._stream: Any = None

    def __enter__(self) -> "SoundDeviceSource":
        import sounddevice as sd  # type: ignore[import-not-found]

        try:
            self._stream = sd.RawInputStream(
                samplerate=self.samplerate,
                blocksize=self.blocksize,
                channels=1,
                dtype="int16",
            )
            self._stream.start()
        except Exception as exc:  # noqa: BLE001 - PortAudio raises several types
            raise EngineUnavailable(f"microphone unavailable: {type(exc).__name__}") from exc
        return self

    def read(self) -> bytes:
        data, _overflowed = self._stream.read(self.blocksize)
        return bytes(data)

    def __exit__(self, *exc: object) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:  # noqa: BLE001 - closing must never raise
                pass
            self._stream = None


class OpenWakeWordEngine:
    """Pretrained offline wake-word model. Model id: ``hey_jarvis``."""

    def __init__(self, model_name: str = WAKE_MODEL_NAME) -> None:
        if importlib.util.find_spec("openwakeword") is None:
            raise EngineUnavailable(
                "wake word needs 'openwakeword' (pip install openwakeword) in the local service env"
            )
        self.name = f"openwakeword:{model_name}"
        self._model_name = model_name
        try:
            from openwakeword.model import Model  # type: ignore[import-not-found]

            self._model = Model(wakeword_models=[model_name], inference_framework="onnx")
        except Exception as exc:  # noqa: BLE001
            raise EngineUnavailable(
                "the 'hey_jarvis' model could not be loaded — run "
                "`python -m openwakeword.utils download_models hey_jarvis_v0.1` once while online "
                f"({type(exc).__name__})"
            ) from exc

    def predict(self, pcm: bytes) -> float:
        import numpy as np  # type: ignore[import-not-found]

        frame = np.frombuffer(pcm, dtype=np.int16)
        scores = self._model.predict(frame)
        if not scores:
            return 0.0
        if self._model_name in scores:
            return float(scores[self._model_name])
        return float(max(scores.values()))

    def reset(self) -> None:
        try:
            self._model.reset()
        except Exception:  # noqa: BLE001 - reset is best effort
            pass


class VoskTranscriber:
    """Offline speech recognition with the small US-English Vosk model."""

    def __init__(self, model_path: str | Path | None = None) -> None:
        if importlib.util.find_spec("vosk") is None:
            raise EngineUnavailable(
                "speech recognition needs 'vosk' (pip install vosk) in the local service env"
            )
        import os

        resolved = Path(
            model_path
            or os.environ.get("JARVIS_VOSK_MODEL")
            or (Path(os.environ.get("JARVIS_STATE_DIR", "")) / "models" / VOSK_MODEL_DIRNAME)
        )
        if not resolved.exists():
            raise EngineUnavailable(
                f"the Vosk model folder is missing: {resolved} — download '{VOSK_MODEL_DIRNAME}' "
                "(see docs/WINDOWS-SETUP.md)"
            )
        from vosk import KaldiRecognizer, Model  # type: ignore[import-not-found]

        self.name = "vosk:small-en-us"
        self._recognizer = KaldiRecognizer(Model(str(resolved)), SAMPLE_RATE)

    def accept(self, pcm: bytes) -> str | None:
        if self._recognizer.AcceptWaveform(pcm):
            text = json.loads(self._recognizer.Result()).get("text", "")
            return str(text).strip() or None
        return None

    def finish(self) -> str | None:
        text = json.loads(self._recognizer.FinalResult()).get("text", "")
        return str(text).strip() or None

    def reset(self) -> None:
        try:
            self._recognizer.Reset()
        except Exception:  # noqa: BLE001
            pass


class Pyttsx3Speaker:
    """Offline speech output through Windows SAPI5."""

    def __init__(self) -> None:
        if importlib.util.find_spec("pyttsx3") is None:
            raise EngineUnavailable(
                "spoken replies need 'pyttsx3' (pip install pyttsx3) in the local service env"
            )
        import pyttsx3  # type: ignore[import-not-found]

        self.name = "pyttsx3:sapi5"
        self._engine = pyttsx3.init()

    def say(self, text: str) -> None:
        self._engine.say(text)
        self._engine.runAndWait()

    def stop(self) -> None:
        try:
            self._engine.stop()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------- orchestrator
class SpeechStack:
    """Owns the microphone loop, the wake engine, STT, and TTS."""

    def __init__(
        self,
        settings: Settings,
        emit: Callable[[dict[str, Any]], None],
        *,
        source_factory: Callable[[], ContextManager[FrameSource]] | None = None,
        wake_factory: Callable[[], WakeEngine] | None = None,
        transcriber_factory: Callable[[], Transcriber] | None = None,
        speaker_factory: Callable[[], Speaker] | None = None,
    ) -> None:
        self.settings = settings
        self.emit = emit
        self._source_factory = source_factory or SoundDeviceSource
        self._wake_factory = wake_factory or OpenWakeWordEngine
        self._transcriber_factory = transcriber_factory or VoskTranscriber
        self._speaker_factory = speaker_factory or Pyttsx3Speaker

        self._status = SpeechStatus(wake_threshold=settings.wake_threshold)
        self._status.dependencies = probe_dependencies()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._speaker: Speaker | None = None
        self._speaker_error: str | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        with self._lock:
            self._status.dependencies = probe_dependencies()
            return self._status.to_dict()

    def _set_status(self, **changes: Any) -> None:
        with self._lock:
            for key, value in changes.items():
                setattr(self._status, key, value)
        self.emit({"type": "speech_state", "speech": self.status()})

    # ------------------------------------------------------------ lifecycle
    def start(self) -> dict[str, Any]:
        if self._thread and self._thread.is_alive():
            return self.status()

        self._stop.clear()
        self._set_status(error=None, error_code=None)
        self._thread = threading.Thread(target=self._run, name="jarvis-listen", daemon=True)
        self._thread.start()
        return self.status()

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=3.0)
        self._thread = None
        self._set_status(listening=False, awaiting_text=False)
        return self.status()

    def set_muted(self, muted: bool) -> dict[str, Any]:
        self._set_status(muted=bool(muted))
        if muted:
            self.stop_speaking()
        return self.status()

    def retry(self) -> dict[str, Any]:
        """Restart after a microphone or engine failure."""
        self.stop()
        return self.start()

    def clear_awaiting_text(self) -> None:
        """Called once the user supplied the command another way (typing)."""
        if self._status.awaiting_text:
            self._set_status(awaiting_text=False)

    # --------------------------------------------------------------- speaking
    def say(self, text: str) -> bool:
        clean = " ".join(str(text).split())[:600]
        if not clean or self._status.muted:
            return False
        if self._speaker is None:
            try:
                self._speaker = self._speaker_factory()
                self._set_status(tts_engine=self._speaker.name, error=self._speaker_error)
            except EngineUnavailable as exc:
                self._speaker_error = str(exc)
                self._set_status(tts_engine=None, error=str(exc), error_code="tts_unavailable")
                return False
        try:
            self._speaker.say(clean)
        except Exception as exc:  # noqa: BLE001
            self._speaker = None
            self._set_status(error=f"speech output failed ({type(exc).__name__})", error_code="tts_failed")
            return False
        return True

    def stop_speaking(self) -> None:
        if self._speaker is not None:
            self._speaker.stop()

    # ------------------------------------------------------------- mic loop
    def _run(self) -> None:
        attempts = 0
        while not self._stop.is_set() and attempts <= MAX_MIC_RESTARTS:
            try:
                self._listen_once()
                return
            except EngineUnavailable as exc:
                attempts += 1
                code = "mic_denied" if "denied" in str(exc).lower() else "engine_unavailable"
                self._set_status(listening=False, error=str(exc), error_code=code)
                if attempts > MAX_MIC_RESTARTS:
                    return
                if self._stop.wait(min(2.0 * attempts, 6.0)):
                    return
            except Exception as exc:  # noqa: BLE001 - the loop must never die silently
                attempts += 1
                self._set_status(
                    listening=False,
                    error=f"microphone loop stopped ({type(exc).__name__})",
                    error_code="mic_error",
                )
                if attempts > MAX_MIC_RESTARTS or self._stop.wait(min(2.0 * attempts, 6.0)):
                    return
        self._set_status(listening=False)

    def _listen_once(self) -> None:
        wake = self._wake_factory()
        self._set_status(wake_engine=wake.name)
        try:
            whisper = self._transcriber_factory()
            stt_name = whisper.name
            whisper_error = None
        except EngineUnavailable as exc:
            whisper, stt_name, whisper_error = None, None, str(exc)
        self._set_status(stt_engine=stt_name)

        with self._source_factory() as source:
            self._set_status(listening=True, error=whisper_error, error_code=None if whisper else "stt_unavailable")
            self.emit({"type": "speech_started", "wakeEngine": wake.name, "sttEngine": stt_name})
            last_wake = 0.0
            while not self._stop.is_set():
                pcm = source.read()
                score = wake.predict(pcm)
                if score < self._status.wake_threshold:
                    continue
                now = time.monotonic()
                if now - last_wake < WAKE_COOLDOWN_SECONDS:
                    continue
                last_wake = now
                wake.reset()
                if self._status.awaiting_text:
                    # Already told the user we are waiting for typed input.
                    continue
                with self._lock:
                    self._status.last_wake_at = time.time()
                self.emit({"type": "wake", "score": round(score, 3), "phrase": "Hey JARVIS"})
                if self._status.muted:
                    continue

                if whisper is None:
                    self._set_status(awaiting_text=True)
                    self.emit(
                        {
                            "type": "awaiting_text",
                            "detail": whisper_error
                            or "speech recognition is unavailable — type the command instead",
                        }
                    )
                    continue

                transcript = self._collect_utterance(source, whisper)
                if transcript:
                    self.emit({"type": "transcript", "text": transcript, "source": "voice"})
                else:
                    self.emit({"type": "transcript_empty"})
                self._set_status(awaiting_text=False)
        self._set_status(listening=False)

    def _collect_utterance(self, source: FrameSource, whisper: Transcriber) -> str | None:
        whisper.reset()
        started = time.monotonic()
        speech_seen_at: float | None = None
        while not self._stop.is_set():
            pcm = source.read()
            text = whisper.accept(pcm)
            if text:
                return text
            if frame_rms(pcm) >= SILENCE_RMS:
                speech_seen_at = time.monotonic()
            elapsed = time.monotonic() - started
            if elapsed >= MAX_UTTERANCE_SECONDS:
                break
            if speech_seen_at and time.monotonic() - speech_seen_at >= SILENCE_TAIL_SECONDS:
                break
        return whisper.finish()

    # ---------------------------------------------------------------- helpers
    def describe(self) -> dict[str, Any]:  # pragma: no cover - diagnostic helper
        payload = asdict(self._status)
        payload["stateDir"] = str(self.settings.state_dir)
        return payload

"""Speech pipeline tests using injected fake engines.

The real microphone cannot be exercised in CI, so the *state machine* is tested
with fakes: wake detection, utterance capture, mute, missing engines, and the
guarantee that no audio is ever written to disk.
"""

from __future__ import annotations

import struct
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from jarvis_service.config import Settings
from jarvis_service.speech import (
    FRAME_SAMPLES,
    SILENCE_RMS,
    EngineUnavailable,
    SpeechStack,
    frame_rms,
)

LOUD = struct.pack("<h", 6000) * FRAME_SAMPLES
QUIET = struct.pack("<h", 0) * FRAME_SAMPLES


class FakeSource:
    """Replays a scripted list of frames, then keeps emitting the last one."""

    def __init__(self, frames: list[bytes]) -> None:
        self.frames = frames
        self.index = 0

    def __enter__(self) -> "FakeSource":
        return self

    def read(self) -> bytes:
        if self.index >= len(self.frames):
            return self.frames[-1]
        frame = self.frames[self.index]
        self.index += 1
        return frame

    def __exit__(self, *_exc: object) -> None:
        return None


class FakeWake:
    name = "fake:wake"

    def __init__(self, scores: list[float]) -> None:
        self.scores = scores
        self.index = 0
        self.resets = 0

    def predict(self, _pcm: bytes) -> float:
        if self.index >= len(self.scores):
            return self.scores[-1]
        score = self.scores[self.index]
        self.index += 1
        return score

    def reset(self) -> None:
        self.resets += 1


class FakeTranscriber:
    name = "fake:stt"

    def __init__(self, text: str | None = "open notepad", after: int = 1) -> None:
        self.text = text
        self.after = after
        self.frames = 0

    def accept(self, _pcm: bytes) -> str | None:
        self.frames += 1
        return self.text if self.frames >= self.after else None

    def finish(self) -> str | None:
        return None

    def reset(self) -> None:
        self.frames = 0


class FakeSpeaker:
    name = "fake:tts"

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.stopped = 0

    def say(self, text: str) -> None:
        self.spoken.append(text)

    def stop(self) -> None:
        self.stopped += 1


class FrameTests(unittest.TestCase):
    def test_rms_distinguishes_silence_from_speech(self) -> None:
        self.assertEqual(frame_rms(QUIET), 0.0)
        self.assertGreater(frame_rms(LOUD), SILENCE_RMS)
        self.assertEqual(frame_rms(b""), 0.0)
        self.assertEqual(frame_rms(b"\x01"), 0.0)  # a single trailing byte is ignored
        self.assertEqual(frame_rms(b"\x00\x01\x00"), 256.0)  # odd byte count is truncated, not crashed


class StackTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self._tmp.name)
        self.settings = Settings(
            state_dir=self.state_dir,
            token="t",
            wake_threshold=0.5,
            search_roots=(self.state_dir,),
        )
        self.events: list[dict] = []
        self.mic: FakeSource | None = None

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def build(
        self,
        *,
        frames: list[bytes] | None = None,
        wake_scores: list[float] | None = None,
        transcriber: object | None = None,
        speaker: FakeSpeaker | None = None,
    ) -> SpeechStack:
        self.mic = FakeSource(frames or [QUIET] * 20)
        return SpeechStack(
            self.settings,
            self.events.append,
            source_factory=lambda: self.mic,
            wake_factory=lambda: FakeWake(wake_scores or [0.0] * 2 + [0.9] * 200),
            transcriber_factory=(lambda: transcriber) if transcriber is not None else (lambda: FakeTranscriber()),
            speaker_factory=(lambda: speaker) if speaker is not None else FakeSpeaker,
        )

    def wait_for(self, predicate, timeout: float = 6.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def kinds(self) -> list[str]:
        return [event["type"] for event in self.events]

    # -------------------------------------------------------------- happy path
    def test_wake_then_transcript(self) -> None:
        stack = self.build(frames=[QUIET, QUIET, LOUD, LOUD, LOUD, LOUD] * 4)
        stack.start()
        self.assertTrue(self.wait_for(lambda: "transcript" in self.kinds()), self.events)
        stack.stop()

        self.assertIn("wake", self.kinds())
        self.assertIn("speech_started", self.kinds())
        transcript = next(e for e in self.events if e["type"] == "transcript")
        self.assertEqual(transcript["text"], "open notepad")
        self.assertEqual(transcript["source"], "voice")
        self.assertEqual(stack.status()["wakeEngine"], "fake:wake")
        self.assertFalse(stack.status()["listening"])

    def test_no_wake_below_threshold_means_no_transcript(self) -> None:
        stack = self.build(wake_scores=[0.1] * 200)
        stack.start()
        time.sleep(0.4)
        stack.stop()
        self.assertNotIn("wake", self.kinds())
        self.assertNotIn("transcript", self.kinds())

    def test_muted_mic_still_arms_the_wake_word_but_does_not_listen(self) -> None:
        stack = self.build()
        stack.set_muted(True)
        stack.start()
        self.assertTrue(self.wait_for(lambda: "wake" in self.kinds()))
        time.sleep(0.3)
        stack.stop()
        self.assertNotIn("transcript", self.kinds())
        self.assertTrue(stack.status()["muted"])

    def test_missing_recognition_model_asks_for_typed_input(self) -> None:
        def unavailable():
            raise EngineUnavailable("vosk is not installed")

        stack = SpeechStack(
            self.settings,
            self.events.append,
            source_factory=lambda: FakeSource([QUIET, LOUD] * 30),
            wake_factory=lambda: FakeWake([0.0, 0.9] * 100),
            transcriber_factory=unavailable,
            speaker_factory=FakeSpeaker,
        )
        stack.start()
        self.assertTrue(self.wait_for(lambda: "awaiting_text" in self.kinds()), self.events)
        self.assertTrue(stack.status()["awaitingText"])
        self.assertIsNone(stack.status()["sttEngine"])
        stack.clear_awaiting_text()
        self.assertFalse(stack.status()["awaitingText"])
        stack.stop()

    # -------------------------------------------------------------- failures
    def test_microphone_denial_is_reported_and_does_not_hang(self) -> None:
        def denied():
            raise EngineUnavailable("microphone unavailable: PortAudioError")

        stack = SpeechStack(
            self.settings,
            self.events.append,
            source_factory=denied,
            wake_factory=lambda: FakeWake([0.9] * 10),
            transcriber_factory=lambda: FakeTranscriber(),
            speaker_factory=FakeSpeaker,
        )
        with mock.patch("jarvis_service.speech.MAX_MIC_RESTARTS", 0):
            stack.start()
            self.assertTrue(self.wait_for(lambda: stack.status()["error"] is not None, timeout=3))
        status = stack.status()
        self.assertEqual(status["errorCode"], "engine_unavailable")
        self.assertFalse(status["listening"])
        self.assertIn("microphone", status["error"])

    def test_missing_wake_engine_is_reported(self) -> None:
        def unavailable():
            raise EngineUnavailable("openwakeword is not installed")

        stack = SpeechStack(
            self.settings,
            self.events.append,
            source_factory=lambda: FakeSource([QUIET] * 5),
            wake_factory=unavailable,
            transcriber_factory=lambda: FakeTranscriber(),
            speaker_factory=FakeSpeaker,
        )
        with mock.patch("jarvis_service.speech.MAX_MIC_RESTARTS", 0):
            stack.start()
            self.assertTrue(self.wait_for(lambda: stack.status()["error"] is not None, timeout=3))
        self.assertEqual(stack.status()["errorCode"], "engine_unavailable")
        self.assertIn("openwakeword", stack.status()["error"])

    # ------------------------------------------------------------------ audio
    def test_audio_is_never_written_to_disk(self) -> None:
        stack = self.build()
        stack.start()
        self.assertTrue(self.wait_for(lambda: "transcript" in self.kinds()))
        stack.stop()
        leftovers = list(self.state_dir.rglob("*"))
        self.assertEqual([p for p in leftovers if p.is_file()], [])

    def test_transcripts_carry_text_only(self) -> None:
        stack = self.build()
        stack.start()
        self.assertTrue(self.wait_for(lambda: "transcript" in self.kinds()))
        stack.stop()
        for event in self.events:
            self.assertIsInstance(event.get("text", ""), str)

    # -------------------------------------------------------------------- tts
    def test_speaks_through_the_injected_engine(self) -> None:
        speaker = FakeSpeaker()
        stack = self.build(speaker=speaker)
        self.assertTrue(stack.say("  It is   9 PM  "))
        self.assertEqual(speaker.spoken, ["It is 9 PM"])
        stack.stop_speaking()
        self.assertEqual(speaker.stopped, 1)

    def test_muted_stack_stays_silent(self) -> None:
        speaker = FakeSpeaker()
        stack = self.build(speaker=speaker)
        stack.set_muted(True)
        self.assertFalse(stack.say("should not be spoken"))
        self.assertEqual(speaker.spoken, [])

    def test_missing_tts_is_reported_and_not_fatal(self) -> None:
        def unavailable():
            raise EngineUnavailable("pyttsx3 is not installed")

        stack = SpeechStack(
            self.settings,
            self.events.append,
            source_factory=lambda: FakeSource([QUIET] * 5),
            wake_factory=lambda: FakeWake([0.0] * 5),
            transcriber_factory=lambda: FakeTranscriber(),
            speaker_factory=unavailable,
        )
        self.assertFalse(stack.say("hello"))
        self.assertEqual(stack.status()["errorCode"], "tts_unavailable")
        self.assertTrue(stack.status()["dependencies"])  # real dependency probe is exposed


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const WAKE_WORD = "jarvis";

let audioCtx: AudioContext | null = null;

export function playChime(direction: "up" | "down" = "up"): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime;
    const freqs = direction === "up" ? [660, 990] : [880, 550];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = start + i * 0.11;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch {
    /* audio unavailable — ignore */
  }
}

function stripWakeWord(text: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(WAKE_WORD);
  if (idx === -1) return text.trim();
  return text.slice(idx + WAKE_WORD.length).replace(/^[\s,!.?]+/, "").trim();
}

export interface JarvisVoiceState {
  supported: boolean;
  listening: boolean;
  interim: string;
  awaitingCommand: boolean;
  micDenied: boolean;
}

/**
 * Ambient listener with "Jarvis" wake word detection.
 * When it hears the wake word alone it beeps and accepts the next utterance
 * as a command; when the wake word prefixes a sentence the rest is sent.
 */
export function useJarvisVoice(
  enabled: boolean,
  onCommand: (text: string) => void,
): JarvisVoiceState {
  const [supported] = useState(() => getRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [awaitingCommand, setAwaitingCommand] = useState(false);
  const [micDenied, setMicDenied] = useState(false);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const enabledRef = useRef(enabled);
  const awaitingRef = useRef(false);
  const onCommandRef = useRef(onCommand);
  const awaitTimerRef = useRef<number | null>(null);
  onCommandRef.current = onCommand;

  const clearAwaitTimer = useCallback(() => {
    if (awaitTimerRef.current !== null) {
      window.clearTimeout(awaitTimerRef.current);
      awaitTimerRef.current = null;
    }
  }, []);

  const armAwaiting = useCallback(() => {
    awaitingRef.current = true;
    setAwaitingCommand(true);
    playChime("up");
    clearAwaitTimer();
    awaitTimerRef.current = window.setTimeout(() => {
      awaitingRef.current = false;
      setAwaitingCommand(false);
      playChime("down");
    }, 12_000);
  }, [clearAwaitTimer]);

  const disarmAwaiting = useCallback(() => {
    awaitingRef.current = false;
    setAwaitingCommand(false);
    clearAwaitTimer();
  }, [clearAwaitTimer]);

  const handleFinal = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      if (awaitingRef.current) {
        disarmAwaiting();
        const command = stripWakeWord(text);
        if (command) onCommandRef.current(command);
        return;
      }
      const idx = text.toLowerCase().indexOf(WAKE_WORD);
      if (idx === -1) return;
      const rest = text.slice(idx + WAKE_WORD.length).replace(/^[\s,!.?]+/, "").trim();
      if (rest) {
        onCommandRef.current(rest);
      } else {
        armAwaiting();
      }
    },
    [armAwaiting, disarmAwaiting],
  );

  // Build the recognition instance once.
  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      let interimText = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      setInterim(interimText.trim());
      if (finalText.trim()) {
        setInterim("");
        handleFinal(finalText);
      }
    };

    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setMicDenied(true);
        enabledRef.current = false;
      }
    };

    rec.onend = () => {
      setListening(false);
      if (enabledRef.current) {
        try {
          rec.start();
          setListening(true);
        } catch {
          /* already starting */
        }
      }
    };

    recRef.current = rec;
    return () => {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      enabledRef.current = false;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      recRef.current = null;
    };
  }, [handleFinal]);

  // Start/stop with the toggle.
  useEffect(() => {
    const rec = recRef.current;
    if (!rec) return;
    enabledRef.current = enabled;
    if (enabled) {
      setMicDenied(false);
      try {
        rec.start();
        setListening(true);
      } catch {
        /* already running */
      }
    } else {
      disarmAwaiting();
      setInterim("");
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
    }
  }, [enabled, disarmAwaiting]);

  return { supported, listening, interim, awaitingCommand, micDenied };
}

export interface Tts {
  ttsSupported: boolean;
  speak: (text: string) => void;
  stopSpeaking: () => void;
}

export function useTts(): Tts {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!ttsSupported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [ttsSupported]);

  const speak = useCallback(
    (text: string) => {
      if (!ttsSupported) return;
      const cleaned = text
        .replace(/[*_#`>]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 700);
      if (!cleaned) return;
      const utterance = new SpeechSynthesisUtterance(cleaned);
      const preferred =
        voices.find((v) => /^en/i.test(v.lang) && /(daniel|alex|male|guy|ryan|david)/i.test(v.name)) ??
        voices.find((v) => /^en/i.test(v.lang)) ??
        voices[0];
      if (preferred) utterance.voice = preferred;
      utterance.rate = 1.03;
      utterance.pitch = 0.95;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    },
    [voices, ttsSupported],
  );

  const stopSpeaking = useCallback(() => {
    if (ttsSupported) window.speechSynthesis.cancel();
  }, [ttsSupported]);

  return { ttsSupported, speak, stopSpeaking };
}

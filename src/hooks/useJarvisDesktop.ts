/**
 * The desktop console's view of the local service.
 *
 * One hook owns the bridge subscriptions (service state + event log), the
 * allowlist catalog, the preferences, and the command/message round trips. The
 * page component only renders this state.
 *
 * The local service is the only authority on what is allowed: this hook relays
 * validated payloads and surfaces the service's verdict, including
 * "confirmation_required", which becomes the approval dialog.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DESKTOP_REQUIRED_MESSAGE,
  getDesktopBridge,
  unwrap,
  type CommandOutcome,
  type CommandSpec,
  type DesktopError,
  type DesktopSettings,
  type MessageReply,
  type ServiceEvent,
  type ServiceSnapshot,
  type SpeechStatus,
} from "@/lib/desktop";

const MAX_LOG_ENTRIES = 200;

export type ConsolePhase =
  | "offline"
  | "starting"
  | "ready"
  | "listening"
  | "hearing"
  | "awaiting_text"
  | "failed"
  | "unsupported";

export interface LogEntry {
  id: number;
  at: number;
  kind: "event" | "command" | "message" | "error" | "info";
  label: string;
  detail?: string;
  tone: "signal" | "amber" | "destructive" | "muted";
}

export interface PendingApproval {
  requestId: string;
  command: string;
  summary: string;
  expiresInSeconds: number;
}

export interface UseJarvisDesktop {
  available: boolean;
  supported: boolean;
  phase: ConsolePhase;
  service: ServiceSnapshot | null;
  speech: SpeechStatus | null;
  settings: DesktopSettings | null;
  commands: CommandSpec[];
  log: LogEntry[];
  pendingApproval: PendingApproval | null;
  busy: boolean;
  error: string | null;
  startService: () => Promise<void>;
  stopService: () => Promise<void>;
  restartService: () => Promise<void>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  runCommand: (name: string, args?: Record<string, string | number | boolean>) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  resolveApproval: (approve: boolean) => Promise<void>;
  updateSettings: (patch: Partial<DesktopSettings>) => Promise<void>;
  clearLog: () => void;
}

function toneForOutcome(outcome: CommandOutcome): LogEntry["tone"] {
  if (outcome.status === "confirmation_required") return "amber";
  if (outcome.ok) return "signal";
  if (outcome.status === "unsupported") return "muted";
  return "destructive";
}

function labelForOutcome(outcome: CommandOutcome): string {
  if (outcome.status === "confirmation_required") return `${outcome.command} awaits approval`;
  if (outcome.ok) return outcome.command;
  return `${outcome.command} refused`;
}

function detailForOutcome(outcome: CommandOutcome): string {
  if (outcome.status === "confirmation_required") return outcome.summary ?? "sensitive action";
  if (outcome.ok) {
    const data = outcome.data && Object.keys(outcome.data).length ? ` — ${JSON.stringify(outcome.data)}` : "";
    return `${outcome.detail ?? outcome.summary ?? "done"}${outcome.verified ? " (verified)" : ""}${data}`;
  }
  return outcome.detail ?? outcome.summary ?? "the action did not complete";
}

function phaseForService(state: ServiceSnapshot["state"]): ConsolePhase {
  switch (state) {
    case "ready":
      return "ready";
    case "starting":
    case "restarting":
      return "starting";
    case "unavailable":
    case "crashed":
      return "failed";
    default:
      return "offline";
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A chat reply that ran an allowlisted action carries the command outcome. */
function outcomeFromReply(reply: MessageReply): CommandOutcome | null {
  if (reply.kind !== "command" && typeof reply.command !== "string") return null;
  if (typeof reply.command !== "string") return null;
  return {
    ok: reply.ok,
    status: asText(reply.status) ?? (reply.ok ? "ok" : "failed"),
    command: reply.command,
    summary: asText(reply.summary),
    detail: asText(reply.detail),
    verified: typeof reply.verified === "boolean" ? reply.verified : undefined,
  };
}

export function useJarvisDesktop(): UseJarvisDesktop {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [supported, setSupported] = useState(true);
  const [phase, setPhase] = useState<ConsolePhase>(() => (bridge ? "offline" : "unsupported"));
  const [service, setService] = useState<ServiceSnapshot | null>(null);
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [commands, setCommands] = useState<CommandSpec[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(bridge ? null : DESKTOP_REQUIRED_MESSAGE);

  const logId = useRef(0);
  const inFlightTranscript = useRef(false);
  const voiceReplies = useRef(true);
  const sendMessageRef = useRef<(text: string) => Promise<void>>(async () => {});
  const handleEventRef = useRef<(event: ServiceEvent) => void>(() => {});

  const append = useCallback((entry: Omit<LogEntry, "id" | "at"> & { at?: number }) => {
    logId.current += 1;
    const next: LogEntry = { id: logId.current, at: entry.at ?? Date.now(), ...entry };
    setLog((previous) => [next, ...previous].slice(0, MAX_LOG_ENTRIES));
  }, []);

  const fail = useCallback(
    (message: string, code?: string) => {
      setError(message);
      append({ kind: "error", label: code ? `${code}` : "error", detail: message, tone: "destructive" });
    },
    [append],
  );

  // ---------------------------------------------------------------- bootstrap
  useEffect(() => {
    if (!bridge) {
      setPhase("unsupported");
      setSupported(false);
      return;
    }
    let cancelled = false;

    const load = async () => {
      const status = await unwrap((api) => api.status());
      if (cancelled) return;
      if ("error" in status) {
        fail(status.error.message, status.error.code);
        return;
      }
      setService(status.value.service);
      setSettings(status.value.settings);
      setPhase(phaseForService(status.value.service.state));
      voiceReplies.current = status.value.settings.voiceReplies;
      if (status.value.service.lastError) setError(status.value.service.lastError);
      else setError(null);

      const catalog = await unwrap((api) => api.catalog());
      if (cancelled) return;
      if ("value" in catalog) {
        setCommands(catalog.value.commands);
        append({
          kind: "info",
          label: "Allowlist loaded",
          detail: `${catalog.value.commands.length} commands available to the assistant`,
          tone: "muted",
        });
      } else {
        append({
          kind: "info",
          label: "Core stopped",
          detail: catalog.error.message,
          tone: "muted",
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [append, bridge, fail]);

  // ------------------------------------------------------------- subscriptions
  useEffect(() => {
    if (!bridge) return;
    const offState = bridge.onServiceState((snapshot) => {
      setService(snapshot);
      setPhase(phaseForService(snapshot.state));
      if (snapshot.lastError) setError(snapshot.lastError);
    });
    const offEvents = bridge.onEvent(handleEventRef.current);
    return () => {
      offState();
      offEvents();
    };
  }, [bridge]);

  const handleEvent = useCallback(
    (event: ServiceEvent) => {
      switch (event.type) {
        case "speech_state": {
          const next = (event as { speech?: SpeechStatus }).speech ?? null;
          if (next) {
            setSpeech(next);
            if (next.error) fail(next.error, next.errorCode ?? undefined);
            if (next.listening && !next.awaitingText) setPhase("listening");
            if (next.awaitingText) setPhase("awaiting_text");
          }
          break;
        }
        case "speech_started":
          setPhase("listening");
          append({
            kind: "event",
            label: "Microphone live",
            detail: `wake: ${String(event.wakeEngine ?? "?")} · speech-to-text: ${String(event.sttEngine ?? "?")}`,
            tone: "signal",
          });
          break;
        case "wake":
          setPhase("hearing");
          append({
            kind: "event",
            label: "Wake word",
            detail: `“${String(event.phrase ?? "Hey JARVIS")}” (score ${String(event.score ?? "?")})`,
            tone: "amber",
          });
          break;
        case "awaiting_text":
          setPhase("awaiting_text");
          append({
            kind: "event",
            label: "Type it instead",
            detail: String(event.detail ?? "speech recognition is unavailable"),
            tone: "amber",
          });
          break;
        case "transcript": {
          const text = String(event.text ?? "").trim();
          append({ kind: "event", label: "Heard", detail: text, tone: "signal" });
          if (text && !inFlightTranscript.current) {
            inFlightTranscript.current = true;
            void sendMessageRef.current(text).finally(() => {
              inFlightTranscript.current = false;
            });
          }
          break;
        }
        case "transcript_empty":
          append({ kind: "event", label: "Nothing heard", detail: "the microphone clip was empty", tone: "muted" });
          break;
        case "approved":
          append({
            kind: "event",
            label: event.approved ? "Approved" : "Denied",
            detail: String(event.command ?? ""),
            tone: event.approved ? "signal" : "muted",
          });
          break;
        default:
          append({ kind: "event", label: event.type, tone: "muted" });
      }
    },
    [append, fail],
  );

  // ---------------------------------------------------------------- actions
  const withBusy = useCallback(
    async <T,>(run: () => Promise<{ value: T } | { error: DesktopError }>): Promise<T | null> => {
      setBusy(true);
      const result = await run();
      setBusy(false);
      if ("error" in result) {
        fail(result.error.message, result.error.code);
        return null;
      }
      setError(null);
      return result.value;
    },
    [fail],
  );

  const refreshSpeech = useCallback((next: SpeechStatus | undefined) => {
    if (next) setSpeech(next);
  }, []);

  const startService = useCallback(async () => {
    setPhase("starting");
    const snapshot = await withBusy(() => unwrap((api) => api.startService()));
    if (snapshot) {
      setService(snapshot);
      setPhase(phaseForService(snapshot.state));
      append({ kind: "info", label: "Core started", detail: `pid ${snapshot.pid ?? "?"} on port ${snapshot.port ?? "?"}`, tone: "signal" });
      const catalog = await unwrap((api) => api.catalog());
      if ("value" in catalog) setCommands(catalog.value.commands);
    }
  }, [append, withBusy]);

  const stopService = useCallback(async () => {
    const snapshot = await withBusy(() => unwrap((api) => api.stopService()));
    if (snapshot) {
      setService(snapshot);
      setPhase("offline");
      setSpeech(null);
      setPendingApproval(null);
      append({ kind: "info", label: "Core stopped", detail: "microphone released", tone: "muted" });
    }
  }, [append, withBusy]);

  const restartService = useCallback(async () => {
    setPhase("starting");
    const snapshot = await withBusy(() => unwrap((api) => api.restartService()));
    if (snapshot) {
      setService(snapshot);
      append({ kind: "info", label: "Core restarted", tone: "signal" });
    }
  }, [append, withBusy]);

  const startListening = useCallback(async () => {
    const payload = await withBusy(() => unwrap((api) => api.speechStart()));
    if (payload) {
      setSpeech(payload.speech);
      append({ kind: "info", label: "Listening requested", tone: "signal" });
    }
  }, [append, withBusy]);

  const stopListening = useCallback(async () => {
    const payload = await withBusy(() => unwrap((api) => api.speechStop()));
    if (payload) {
      setSpeech(payload.speech);
      setPhase("ready");
      append({ kind: "info", label: "Listening stopped", tone: "muted" });
    }
  }, [append, withBusy]);

  const setMuted = useCallback(
    async (muted: boolean) => {
      const payload = await withBusy(() => unwrap((api) => api.speechMute({ muted })));
      refreshSpeech(payload?.speech);
      append({ kind: "info", label: muted ? "Replies muted" : "Replies unmuted", tone: "muted" });
    },
    [append, refreshSpeech, withBusy],
  );

  const reportOutcome = useCallback(
    (outcome: CommandOutcome) => {
      append({
        kind: "command",
        label: labelForOutcome(outcome),
        detail: detailForOutcome(outcome),
        tone: toneForOutcome(outcome),
      });
      const request = outcome.request;
      if (outcome.status === "confirmation_required" && request) {
        setPendingApproval({
          requestId: request.requestId,
          command: request.command,
          summary: request.summary,
          expiresInSeconds: request.expiresInSeconds,
        });
      }
    },
    [append],
  );

  const runCommand = useCallback(
    async (name: string, args?: Record<string, string | number | boolean>) => {
      const outcome = await withBusy(() => unwrap((api) => api.command({ name, args })));
      if (outcome) reportOutcome(outcome);
    },
    [reportOutcome, withBusy],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      append({ kind: "message", label: "You", detail: trimmed, tone: "muted" });
      const reply = await withBusy(() => unwrap((api) => api.message({ text: trimmed })));
      if (!reply) return;

      const spoken = typeof reply.spoken === "string" ? reply.spoken : null;
      append({
        kind: "message",
        label: reply.kind === "command" ? "JARVIS · action" : "JARVIS",
        detail:
          asText(reply.text) ??
          spoken ??
          asText(reply.detail) ??
          asText(reply.status) ??
          reply.kind,
        tone: reply.ok ? "signal" : "amber",
      });

      const outcome = outcomeFromReply(reply);
      if (outcome) reportOutcome(outcome);
      if (reply.proposal) {
        append({
          kind: "info",
          label: "Proposed action",
          detail: `${reply.proposal.name} — tap it in the allowlist to review and run`,
          tone: "amber",
        });
      }
      if (spoken && voiceReplies.current) {
        await unwrap((api) => api.speechSay({ text: spoken }));
      }
    },
    [append, reportOutcome, withBusy],
  );

  useEffect(() => {
    sendMessageRef.current = sendMessage;
    handleEventRef.current = handleEvent;
  }, [handleEvent, sendMessage]);

  const resolveApproval = useCallback(
    async (approve: boolean) => {
      const pending = pendingApproval;
      if (!pending) return;
      setPendingApproval(null);
      const outcome = await withBusy(() => unwrap((api) => api.confirm({ requestId: pending.requestId, approve })));
      if (outcome) {
        append({
          kind: "command",
          label: approve ? `${outcome.command} approved` : `${outcome.command} denied`,
          detail: approve ? (outcome.summary ?? "running the exact approved action") : "nothing was executed",
          tone: approve ? "signal" : "muted",
        });
      }
    },
    [append, pendingApproval, withBusy],
  );

  const updateSettings = useCallback(
    async (patch: Partial<DesktopSettings>) => {
      const next = await withBusy(() => unwrap((api) => api.setSettings(patch)));
      if (next) {
        setSettings(next);
        voiceReplies.current = next.voiceReplies;
        append({ kind: "info", label: "Preferences saved", detail: Object.keys(patch).join(", "), tone: "muted" });
      }
    },
    [append, withBusy],
  );

  const clearLog = useCallback(() => setLog([]), []);

  return {
    available: bridge !== null,
    supported,
    phase,
    service,
    speech,
    settings,
    commands,
    log,
    pendingApproval,
    busy,
    error,
    startService,
    stopService,
    restartService,
    startListening,
    stopListening,
    setMuted,
    runCommand,
    sendMessage,
    resolveApproval,
    updateSettings,
    clearLog,
  };
}

export { MAX_LOG_ENTRIES };

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  BellRing,
  Check,
  Loader2,
  LogOut,
  Mic,
  MicOff,
  Send,
  ShieldCheck,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import ArcReactor from "@/components/ArcReactor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { WAKE_WORD, playChime, useJarvisVoice, useTts } from "@/hooks/useJarvis";
import { cn, formatDueTime } from "@/lib/utils";

interface Toast {
  id: string;
  title: string;
  body: string;
}

const SUGGESTIONS = [
  "What can you do?",
  "Remind me to stretch in 20 minutes",
  "Save a note: prototype review at 5pm",
  "What time is it?",
];

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not authenticated|unauthenticated/i.test(message)) {
    return "Session expired — please sign in again.";
  }
  if (/failed to fetch|networkerror|network request failed/i.test(message)) {
    return "Can't reach the backend — is the Convex dev process running?";
  }
  if (/llm api returned (\d+)/i.test(message)) {
    return `The model API rejected the request (${message.match(/llm api returned \d+/i)?.[0]?.slice(-3)}). Check LLM_API_KEY / LLM_BASE_URL.`;
  }
  return message.slice(0, 240);
}

export default function AssistantPage() {
  const messages = useQuery(api.messages.list);
  const reminders = useQuery(api.reminders.listActive);
  const dueReminders = useQuery(api.reminders.listDue);
  const notes = useQuery(api.notes.list);
  const user = useQuery(api.users.current);

  const chat = useAction(api.assistant.chat);
  const status = useAction(api.assistant.status);
  const markFired = useMutation(api.reminders.markFired);
  const completeReminder = useMutation(api.reminders.complete);
  const clearMessages = useMutation(api.messages.clearAll);
  const { signOut } = useAuthActions();
  const navigate = useNavigate();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [llm, setLlm] = useState<{ llmConfigured: boolean; model: string } | null>(null);

  const [voiceOut, setVoiceOut] = useState(() => localStorage.getItem("jarvis.voiceOut") !== "0");
  const [wakeOn, setWakeOn] = useState(() => localStorage.getItem("jarvis.wake") === "1");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const spokenRef = useRef<Set<string>>(new Set());
  const firedRef = useRef<Set<string>>(new Set());

  const { ttsSupported, speak, stopSpeaking } = useTts();

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 9000);
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setInput("");
      setError(null);
      setPending(text);
      setBusy(true);
      try {
        await chat({ userText: text });
      } catch (err) {
        setError(humanizeError(err));
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [busy, chat],
  );

  const handleVoiceCommand = useCallback(
    (text: string) => {
      pushToast({ title: "Voice command", body: text });
      void send(text);
    },
    [pushToast, send],
  );

  const voice = useJarvisVoice(wakeOn, handleVoiceCommand);

  // Speak fresh assistant replies.
  useEffect(() => {
    if (!voiceOut || !messages || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || spokenRef.current.has(last._id)) return;
    spokenRef.current.add(last._id);
    speak(last.content);
  }, [messages, voiceOut, speak]);

  // Proactive alerts: fire due reminders with a chime/spoken notice.
  useEffect(() => {
    if (!dueReminders || dueReminders.length === 0) return;
    for (const reminder of dueReminders) {
      if (firedRef.current.has(reminder._id)) continue;
      firedRef.current.add(reminder._id);
      void markFired({ id: reminder._id }).catch(() => undefined);
      const body = reminder.note ? `${reminder.title}. ${reminder.note}` : reminder.title;
      pushToast({ title: "Reminder due", body: reminder.title });
      if (voiceOut) speak(body);
      else playChime("up");
    }
  }, [dueReminders, markFired, pushToast, voiceOut, speak]);

  // Model configuration status.
  useEffect(() => {
    let cancelled = false;
    status({})
      .then((result) => {
        if (!cancelled) setLlm(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status]);

  // Keep chat scrolled to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages?.length, busy, pending]);

  useEffect(() => {
    localStorage.setItem("jarvis.voiceOut", voiceOut ? "1" : "0");
    if (!voiceOut) stopSpeaking();
  }, [voiceOut, stopSpeaking]);

  useEffect(() => {
    localStorage.setItem("jarvis.wake", wakeOn ? "1" : "0");
  }, [wakeOn]);

  async function handleSignOut() {
    await signOut();
    navigate("/", { replace: true });
  }

  async function handleClearChat() {
    spokenRef.current = new Set();
    await clearMessages();
  }

  const empty = !messages || (messages.length === 0 && !pending);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* HEADER */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/60 px-4 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2.5">
          <ArcReactor size={24} />
          <span className="hidden font-display text-xs font-bold tracking-[0.28em] sm:inline">
            J.A.R.V.I.S.
          </span>
          <Link
            to="/"
            className="ml-1 hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:inline-flex"
            title="Back to landing page"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="ml-1 hidden max-w-[16ch] truncate text-xs text-muted-foreground md:inline">
            {user?.email ?? ""}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {llm !== null && (
            <Badge variant={llm.llmConfigured ? "signal" : "amber"} className="hidden sm:inline-flex">
              {llm.llmConfigured ? `model · ${llm.model}` : "model key missing"}
            </Badge>
          )}
          <Badge variant={voice.listening ? "default" : "outline"} className="hidden md:inline-flex">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                voice.listening ? "animate-pulse bg-signal" : "bg-muted-foreground",
              )}
            />
            {voice.awaitingCommand ? "awaiting command" : voice.listening ? "wake active" : "wake off"}
          </Badge>

          <Button
            variant={voiceOut ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setVoiceOut((v) => !v)}
            disabled={!ttsSupported}
            title={ttsSupported ? "Toggle spoken replies" : "Speech synthesis unsupported"}
          >
            {voiceOut ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </Button>

          <Button
            variant={wakeOn ? "default" : "ghost"}
            size="icon"
            onClick={() => setWakeOn((v) => !v)}
            disabled={!voice.supported}
            title={
              voice.supported
                ? wakeOn
                  ? "Listening for “Jarvis” — click to stop"
                  : "Start ambient listening for the wake word"
                : "Voice input needs Chrome or Edge"
            }
          >
            {wakeOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </Button>

          <Button variant="ghost" size="icon" onClick={() => void handleSignOut()} title="Sign out">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* CHAT COLUMN */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* setup banner */}
          {llm !== null && !llm.llmConfigured && (
            <div className="border-b border-amber/40 bg-amber/10 px-5 py-2.5 text-xs text-amber-foreground">
              <span className="font-semibold text-amber">Core offline:</span> add your model key with{" "}
              <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                bunx convex env set LLM_API_KEY &lt;key&gt;
              </code>{" "}
              (optionally <code className="font-mono">LLM_MODEL</code> /{" "}
              <code className="font-mono">LLM_BASE_URL</code>), then reload.
            </div>
          )}

          {error && (
            <div className="border-b border-destructive/40 bg-destructive/10 px-5 py-2.5 text-xs text-destructive">
              {error}
            </div>
          )}

          <div ref={scrollRef} className="scrollbar-slim flex-1 overflow-y-auto px-4 py-6 md:px-8">
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {empty && (
                <div className="flex flex-col items-center py-10 text-center">
                  <ArcReactor size={56} />
                  <h1 className="mt-5 font-display text-2xl font-bold">
                    Online. How can I help?
                  </h1>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    Type below, or enable wake mode and say{" "}
                    <span className="text-primary">“Jarvis”</span> out loud to talk hands-free.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => void send(suggestion)}
                        className="rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground transition-all hover:border-primary/60 hover:text-primary"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages?.map((message) => (
                <motion.div
                  key={message._id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-lg border px-4 py-3 text-sm leading-relaxed",
                      message.role === "user"
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border bg-card text-foreground",
                    )}
                  >
                    {message.role === "assistant" && message.toolLog && (
                      <div className="mb-2 space-y-1 border-b border-border/70 pb-2">
                        {message.toolLog.map((entry) => (
                          <p key={entry} className="font-mono text-[11px] text-amber/90">
                            ⚙ {entry}
                          </p>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  </div>
                </motion.div>
              ))}

              {pending && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-end"
                >
                  <div className="max-w-[85%] rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-sm">
                    {pending}
                  </div>
                </motion.div>
              )}

              {busy && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-primary" />
                      <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-primary [animation-delay:0.3s]" />
                      <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-primary [animation-delay:0.6s]" />
                    </span>
                    <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                      Thinking
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* COMPOSER */}
          <div className="shrink-0 border-t border-border bg-card/50 px-4 py-4 md:px-8">
            <div className="mx-auto max-w-3xl">
              {(voice.interim || voice.awaitingCommand) && (
                <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[11px] text-primary">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  {voice.awaitingCommand ? "listening for your command…" : `“${voice.interim}”`}
                </div>
              )}
              {voice.micDenied && (
                <p className="mb-2 text-xs text-destructive">
                  Microphone permission was denied — enable it in your browser to use the wake word.
                </p>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(input);
                }}
                className="flex items-end gap-2"
              >
                <Textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(input);
                    }
                  }}
                  rows={1}
                  placeholder={
                    voice.supported
                      ? `Message Jarvis — or enable wake mode and say “${WAKE_WORD}”`
                      : "Message Jarvis…"
                  }
                  className="max-h-32 min-h-[44px] flex-1"
                />
                <Button type="submit" size="icon" className="h-11 w-11" disabled={busy || !input.trim()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </form>
              <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                Enter to send · Shift+Enter for a new line · legal-only core
              </p>
            </div>
          </div>
        </main>

        {/* SIDE PANEL */}
        <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-card/40 lg:flex">
          <div className="scrollbar-slim flex-1 overflow-y-auto">
            {/* Reminders */}
            <section className="border-b border-border p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-display text-xs font-bold uppercase tracking-[0.2em]">
                  <BellRing className="h-3.5 w-3.5 text-primary" /> Reminders
                </h2>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {reminders?.length ?? 0}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {!reminders?.length && (
                  <p className="text-xs text-muted-foreground">
                    Nothing scheduled. Say “{WAKE_WORD}, remind me to …”.
                  </p>
                )}
                {reminders?.map((reminder) => {
                  const overdue = reminder.dueAt <= Date.now();
                  return (
                    <div
                      key={reminder._id}
                      className="group flex items-start gap-3 rounded-md border border-border bg-background/60 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{reminder.title}</p>
                        <p
                          className={cn(
                            "font-mono text-[11px]",
                            overdue ? "text-amber" : "text-muted-foreground",
                          )}
                        >
                          {formatDueTime(reminder.dueAt)}
                        </p>
                      </div>
                      <button
                        type="button"
                        title="Mark complete"
                        onClick={() => void completeReminder({ id: reminder._id })}
                        className="rounded border border-border p-1 text-muted-foreground opacity-0 transition-all hover:border-signal/60 hover:text-signal group-hover:opacity-100"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Notes */}
            <section className="border-b border-border p-5">
              <h2 className="font-display text-xs font-bold uppercase tracking-[0.2em]">
                Notes
              </h2>
              <div className="mt-3 space-y-2">
                {!notes?.length && (
                  <p className="text-xs text-muted-foreground">
                    No notes yet — “{WAKE_WORD}, save a note: …”.
                  </p>
                )}
                {notes?.map((note) => (
                  <div key={note._id} className="rounded-md border border-border bg-background/60 px-3 py-2.5">
                    <p className="truncate text-sm font-medium">{note.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{note.content}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* System */}
            <section className="p-5">
              <h2 className="font-display text-xs font-bold uppercase tracking-[0.2em]">System</h2>
              <div className="mt-3 space-y-2 rounded-md border border-border bg-background/60 px-3 py-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Model</span>
                  <span className={llm?.llmConfigured ? "text-signal" : "text-amber"}>
                    {llm === null ? "probing…" : llm.llmConfigured ? llm.model : "not configured"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Wake word</span>
                  <span className={voice.supported ? "text-signal" : "text-amber"}>
                    {voice.supported ? `“${WAKE_WORD}”` : "unsupported browser"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Spoken replies</span>
                  <span className={ttsSupported ? "text-signal" : "text-amber"}>
                    {ttsSupported ? (voiceOut ? "on" : "off") : "unsupported"}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber/40 bg-amber/5 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" />
                <span>Legal-only core: unauthorized access, surveillance and malware requests are refused.</span>
              </div>
              <Button
                variant="danger"
                size="sm"
                className="mt-3 w-full"
                onClick={() => void handleClearChat()}
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear conversation
              </Button>
            </section>
          </div>
        </aside>
      </div>

      {/* TOASTS */}
      <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-72 flex-col gap-2">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ duration: 0.25 }}
              className="pointer-events-auto rounded-lg border border-primary/40 bg-card px-4 py-3 shadow-xl glow-box"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
                {toast.title}
              </p>
              <p className="mt-1 text-sm text-foreground">{toast.body}</p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

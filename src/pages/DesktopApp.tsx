import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Cpu,
  Gauge,
  Loader2,
  Mic,
  MicOff,
  Play,
  Power,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  Volume2,
} from "lucide-react";

import ApprovalDialog from "@/components/ApprovalDialog";
import ArcReactor from "@/components/ArcReactor";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useJarvisDesktop, type ConsolePhase, type LogEntry } from "@/hooks/useJarvisDesktop";
import type { CommandParam, CommandSpec } from "@/lib/desktop";

const PHASE_LABEL: Record<ConsolePhase, string> = {
  offline: "Core offline",
  starting: "Starting",
  ready: "Core ready",
  listening: "Listening for wake word",
  hearing: "Capturing speech",
  awaiting_text: "Waiting for typed input",
  failed: "Core failed",
  unsupported: "Desktop shell required",
};

const PHASE_VARIANT: Record<ConsolePhase, "signal" | "amber" | "default" | "outline"> = {
  offline: "outline",
  starting: "amber",
  ready: "signal",
  listening: "signal",
  hearing: "default",
  awaiting_text: "amber",
  failed: "amber",
  unsupported: "outline",
};

const DEPENDENCIES: { id: string; label: string; detail: string }[] = [
  { id: "openwakeword", label: "openWakeWord", detail: "offline “Hey Jarvis” detection" },
  { id: "sounddevice", label: "sounddevice", detail: "microphone frames via PortAudio" },
  { id: "vosk", label: "Vosk", detail: "offline speech-to-text" },
  { id: "pyttsx3", label: "pyttsx3", detail: "Windows SAPI5 speech output" },
  { id: "numpy", label: "NumPy", detail: "audio frame maths" },
];

function Panel({
  title,
  hint,
  icon,
  action,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-border bg-card/70 p-5 glow-box backdrop-blur ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {icon ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
              {icon}
            </div>
          ) : null}
          <div>
            <h2 className="font-display text-base font-semibold">{title}</h2>
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      <span className="text-right text-sm text-foreground">{value}</span>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-md border border-border bg-background/60 p-3 transition-colors hover:border-primary/40">
      <span>
        <span className="block text-sm text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function toneClass(tone: LogEntry["tone"]): string {
  switch (tone) {
    case "signal":
      return "text-signal";
    case "amber":
      return "text-amber";
    case "destructive":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

/** One allowlisted command: its declared parameters, then a run button. */
function CommandCard({
  spec,
  busy,
  onRun,
}: {
  spec: CommandSpec;
  busy: boolean;
  onRun: (name: string, args: Record<string, string | number | boolean>) => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const param of spec.params) initial[param.name] = param.type === "boolean" ? false : "";
    return initial;
  });

  const args = useMemo(() => {
    const built: Record<string, string | number | boolean> = {};
    for (const param of spec.params) {
      const raw = values[param.name];
      if (param.type === "boolean") {
        built[param.name] = Boolean(raw);
        continue;
      }
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) continue;
      built[param.name] = param.type === "string" ? text : Number(text);
    }
    return built;
  }, [spec.params, values]);

  const missingRequired = spec.params.some(
    (param) => param.required && param.type !== "boolean" && !String(values[param.name] ?? "").trim(),
  );

  return (
    <div className="flex h-full flex-col rounded-md border border-border bg-background/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-xs text-primary">{spec.name}</p>
        {spec.requiresConfirmation ? (
          <Badge variant="amber">confirm</Badge>
        ) : spec.danger === "read" ? (
          <Badge variant="outline">read-only</Badge>
        ) : (
          <Badge variant="signal">allowed</Badge>
        )}
      </div>
      <p className="mt-2 flex-1 text-xs leading-relaxed text-muted-foreground">{spec.description}</p>

      {spec.params.length ? (
        <div className="mt-3 space-y-2">
          {spec.params.map((param: CommandParam) =>
            param.type === "boolean" ? (
              <label key={param.name} className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={Boolean(values[param.name])}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [param.name]: event.target.checked }))
                  }
                />
                {param.name}
              </label>
            ) : (
              <div key={param.name}>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {param.name}
                  {param.required ? " *" : ""}
                </label>
                <Input
                  className="h-8 text-xs"
                  type={param.type === "string" ? "text" : "number"}
                  step={param.type === "string" ? undefined : "any"}
                  placeholder={param.description || param.name}
                  value={String(values[param.name] ?? "")}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [param.name]: event.target.value }))
                  }
                />
              </div>
            ),
          )}
        </div>
      ) : null}

      <Button
        size="sm"
        variant={spec.requiresConfirmation ? "outline" : "secondary"}
        className="mt-3 w-full"
        disabled={busy || missingRequired}
        onClick={() => onRun(spec.name, args)}
      >
        <Play className="h-3.5 w-3.5" />
        {spec.requiresConfirmation ? "Request approval" : "Run"}
      </Button>
    </div>
  );
}

export default function DesktopApp() {
  const console_ = useJarvisDesktop();
  const {
    available,
    phase,
    service,
    speech,
    settings,
    commands,
    log,
    pendingApproval,
    busy,
    error,
  } = console_;

  const [draft, setDraft] = useState("");
  const [roots, setRoots] = useState("");
  const [sites, setSites] = useState("");
  const [threshold, setThreshold] = useState<number | null>(null);

  useEffect(() => {
    if (!settings) return;
    setRoots(settings.searchRoots.join(", "));
    setSites(settings.siteAllowlist.join(", "));
    setThreshold(settings.wakeThreshold);
  }, [settings]);

  const conversation = useMemo(() => log.filter((entry) => entry.kind === "message").slice().reverse(), [log]);
  const activity = useMemo(() => log.filter((entry) => entry.kind !== "message"), [log]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void console_.sendMessage(text);
  };

  const saveLists = () => {
    const parse = (value: string) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8);
    void console_.updateSettings({ searchRoots: parse(roots), siteAllowlist: parse(sites) });
  };

  // ------------------------------------------------------------- not in shell
  if (!available) {
    return (
      <div className="hud-grid flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-xl rounded-lg border border-border bg-card p-8 glow-box">
          <div className="flex items-center gap-3">
            <ArcReactor size={30} />
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
                Desktop shell required
              </p>
              <h1 className="font-display text-xl font-semibold">The local console runs on your machine</h1>
            </div>
          </div>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            The microphone, the allowlisted window actions and the Python core only exist inside the
            desktop app — a browser tab cannot reach them. Run it locally:
          </p>
          <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-background/80 p-4 font-mono text-xs leading-relaxed text-primary">
{`cd desktop
npm install
python -m pip install -r python/requirements.txt
npm run bundle:renderer
npm start`}
          </pre>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/assistant" className={buttonVariants()}>
              Use the cloud assistant
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/" className={buttonVariants({ variant: "outline" })}>
              Back home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const listening = Boolean(speech?.listening);
  const muted = Boolean(speech?.muted);
  const serviceReady = service?.state === "ready";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5">
          <div className="flex items-center gap-3">
            <ArcReactor size={26} />
            <div>
              <span className="font-display text-sm font-bold tracking-[0.28em]">J.A.R.V.I.S.</span>
              <span className="ml-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                local console
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={PHASE_VARIANT[phase]}>
              {busy || phase === "starting" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {PHASE_LABEL[phase]}
            </Badge>
            <Link to="/assistant" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Cloud assistant
            </Link>
            <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-10">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex flex-wrap items-end justify-between gap-6"
        >
          <div>
            <Badge variant="signal">Everything stays on this machine</Badge>
            <h1 className="mt-4 font-display text-3xl font-bold tracking-tight md:text-4xl">
              Local core console
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              A wake-word listener and an allowlisted action set, both driven by a Python service bound
              to <span className="font-mono text-xs text-primary">127.0.0.1</span> and reachable only by
              this app. Sensitive actions wait for your approval, every time.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {serviceReady ? (
              <>
                <Button variant="outline" onClick={() => void console_.restartService()} disabled={busy}>
                  <RotateCcw className="h-4 w-4" />
                  Restart core
                </Button>
                <Button variant="secondary" onClick={() => void console_.stopService()} disabled={busy}>
                  <Power className="h-4 w-4" />
                  Stop core
                </Button>
              </>
            ) : (
              <Button onClick={() => void console_.startService()} disabled={busy}>
                {phase === "starting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                Start core
              </Button>
            )}
          </div>
        </motion.div>

        {error ? (
          <div className="mt-6 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-6">
            <Panel
              title="Local core"
              hint="One Python child process, restarted at most three times, never duplicated."
              icon={<Cpu className="h-4 w-4" />}
            >
              <Row
                label="State"
                value={
                  <span className="font-mono text-xs text-primary">
                    {service?.state ?? "unknown"}
                    {service?.pid ? ` · pid ${service.pid}` : ""}
                    {service?.port ? ` · port ${service.port}` : ""}
                  </span>
                }
              />
              <Row
                label="Online AI"
                value={
                  serviceReady ? "used only when no local command matches" : "waiting for the core"
                }
              />
              <Row
                label="Voice replies"
                value={settings?.voiceReplies ? "spoken" : "silent"}
              />
              <Row
                label="Launch policy"
                value={settings?.startServiceOnLaunch ? "auto-start on launch" : "start manually"}
              />
            </Panel>

            <Panel
              title="Microphone & wake word"
              hint="Offline detection and recognition — no audio leaves the machine."
              icon={muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              action={
                <div className="flex flex-wrap gap-2">
                  {listening ? (
                    <Button size="sm" variant="secondary" onClick={() => void console_.stopListening()} disabled={busy}>
                      <Square className="h-3.5 w-3.5" />
                      Stop listening
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => void console_.startListening()}
                      disabled={busy || !serviceReady}
                    >
                      <Mic className="h-3.5 w-3.5" />
                      Start listening
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void console_.setMuted(!muted)}
                    disabled={busy || !serviceReady}
                  >
                    <Volume2 className="h-3.5 w-3.5" />
                    {muted ? "Unmute" : "Mute"}
                  </Button>
                </div>
              }
            >
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-md border border-border bg-background/60 p-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    engines
                  </p>
                  <p className="mt-2 text-sm">
                    wake <span className="font-mono text-xs text-primary">{speech?.wakeEngine ?? "not loaded"}</span>
                  </p>
                  <p className="mt-1 text-sm">
                    speech-to-text{" "}
                    <span className="font-mono text-xs text-primary">{speech?.sttEngine ?? "not loaded"}</span>
                  </p>
                  <p className="mt-1 text-sm">
                    voice <span className="font-mono text-xs text-primary">{speech?.ttsEngine ?? "idle"}</span>
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {speech?.awaitingText
                      ? "Wake word heard, but recognition is unavailable — type your command below."
                      : listening
                        ? "Say “Hey JARVIS” to hand over a command."
                        : "Listening is off; the microphone is released."}
                  </p>
                </div>

                <div className="rounded-md border border-border bg-background/60 p-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    local speech packages
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {DEPENDENCIES.map((dependency) => {
                      const installed = speech?.dependencies?.[dependency.id] ?? false;
                      return (
                        <li key={dependency.id} className="flex items-start justify-between gap-3 text-xs">
                          <span className={installed ? "text-foreground" : "text-muted-foreground"}>
                            <span className="font-mono">{dependency.label}</span>
                            <span className="ml-2 text-muted-foreground">{dependency.detail}</span>
                          </span>
                          <span className={installed ? "text-signal" : "text-amber"}>
                            {installed ? "ready" : "missing"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>

              <div className="mt-4 rounded-md border border-border bg-background/60 p-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    <Gauge className="h-3.5 w-3.5" /> wake sensitivity
                  </span>
                  <span className="font-mono text-xs text-primary">
                    {(threshold ?? speech?.wakeThreshold ?? 0.55).toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  className="mt-3 w-full accent-primary"
                  value={threshold ?? speech?.wakeThreshold ?? 0.55}
                  onChange={(event) => setThreshold(Number(event.target.value))}
                  onMouseUp={() => threshold !== null && void console_.updateSettings({ wakeThreshold: threshold })}
                  onTouchEnd={() => threshold !== null && void console_.updateSettings({ wakeThreshold: threshold })}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Higher is stricter: fewer false wake-ups, but you may need to speak more clearly.
                  Applied when the core next starts listening.
                </p>
              </div>
            </Panel>

            <Panel
              title="Allowlisted actions"
              hint="The complete list of what the assistant may do locally. Anything else is refused."
              icon={<Terminal className="h-4 w-4" />}
            >
              {commands.length ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {commands.map((spec) => (
                    <CommandCard
                      key={spec.name}
                      spec={spec}
                      busy={busy || !serviceReady}
                      onRun={(name, args) => void console_.runCommand(name, args)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {serviceReady ? "No commands registered." : "Start the core to load the allowlist."}
                </p>
              )}
            </Panel>

            <Panel
              title="Preferences"
              hint="Non-secret settings only, validated field by field and stored beside the app."
              icon={<ShieldCheck className="h-4 w-4" />}
            >
              <div className="space-y-3">
                <Toggle
                  label="Speak replies out loud"
                  hint="Uses the local Windows voice — nothing is sent anywhere."
                  checked={Boolean(settings?.voiceReplies)}
                  disabled={!settings || busy}
                  onChange={(next) => void console_.updateSettings({ voiceReplies: next })}
                />
                <Toggle
                  label="Start listening when the app launches"
                  hint="Off by default so the microphone is never opened behind your back."
                  checked={Boolean(settings?.listenOnLaunch)}
                  disabled={!settings || busy}
                  onChange={(next) => void console_.updateSettings({ listenOnLaunch: next })}
                />
                <Toggle
                  label="Start the local core on launch"
                  hint="Keeps the Python service warm so the first command is instant."
                  checked={Boolean(settings?.startServiceOnLaunch)}
                  disabled={!settings || busy}
                  onChange={(next) => void console_.updateSettings({ startServiceOnLaunch: next })}
                />
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    file search folders
                  </label>
                  <Input
                    placeholder="C:\\Users\\you\\Documents, D:\\Projects"
                    value={roots}
                    onChange={(event) => setRoots(event.target.value)}
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    File search never leaves these folders. Up to eight.
                  </p>
                </div>
                <div>
                  <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    allowed websites
                  </label>
                  <Input
                    placeholder="convex.dev, react.dev"
                    value={sites}
                    onChange={(event) => setSites(event.target.value)}
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Only these hosts can be opened by voice, and only over HTTPS.
                  </p>
                </div>
              </div>
              <Button className="mt-4" size="sm" variant="secondary" onClick={saveLists} disabled={busy || !settings}>
                Save preferences
              </Button>
            </Panel>
          </div>

          <div className="space-y-6 lg:sticky lg:top-24 lg:self-start">
            <Panel
              title="Conversation"
              hint="Type a command or ask a question. Voice transcripts arrive here too."
              icon={<Activity className="h-4 w-4" />}
            >
              <div className="scrollbar-slim max-h-[22rem] space-y-3 overflow-y-auto pr-1">
                {conversation.length ? (
                  conversation.map((entry) => (
                    <div key={entry.id} className="rounded-md border border-border/70 bg-background/60 p-3">
                      <p className={`font-mono text-[11px] uppercase tracking-[0.18em] ${toneClass(entry.tone)}`}>
                        {entry.label}
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-foreground">{entry.detail}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Try <span className="font-mono text-xs text-primary">what time is it</span>, or say
                    “Hey JARVIS, open the calculator”.
                  </p>
                )}
              </div>
              <form
                className="mt-4 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <Input
                  placeholder={serviceReady ? "Ask or command…" : "Start the core first"}
                  value={draft}
                  disabled={!serviceReady}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <Button type="submit" size="icon" disabled={busy || !serviceReady || !draft.trim()} aria-label="Send">
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </Panel>

            <Panel
              title="Activity log"
              hint="Service events, action results, and refusals — newest first."
              icon={<Terminal className="h-4 w-4" />}
              action={
                <Button size="sm" variant="ghost" onClick={console_.clearLog} disabled={!log.length}>
                  Clear
                </Button>
              }
            >
              <div className="scrollbar-slim max-h-[26rem] space-y-2 overflow-y-auto pr-1">
                {activity.length ? (
                  activity.map((entry) => (
                    <div key={entry.id} className="rounded-md border border-border/60 bg-background/60 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className={`font-mono text-[11px] uppercase tracking-[0.18em] ${toneClass(entry.tone)}`}>
                          {entry.label}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {new Date(entry.at).toLocaleTimeString()}
                        </span>
                      </div>
                      {entry.detail ? (
                        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                          {entry.detail}
                        </p>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing has happened yet this session.</p>
                )}
              </div>
            </Panel>

            <div className="rounded-lg border border-amber/40 bg-amber/5 p-5">
              <div className="flex items-center gap-2 text-amber">
                <AlertTriangle className="h-4 w-4" />
                <p className="font-mono text-[11px] uppercase tracking-[0.2em]">Permanent boundaries</p>
              </div>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                <li>No file deletion, no installs, no registry or system-setting changes.</li>
                <li>No elevation, no scripts, no shells — those names are refused by policy.</li>
                <li>Sensitive actions run only after a fresh, single-use approval of the exact action.</li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      <ApprovalDialog approval={pendingApproval} busy={busy} onResolve={console_.resolveApproval} />
    </div>
  );
}

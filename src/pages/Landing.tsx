import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BellRing,
  Brain,
  Cpu,
  Home,
  Mic,
  NotebookPen,
  ShieldCheck,
  Volume2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

function ArcReactor({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden>
      <circle
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke="hsl(186 100% 45%)"
        strokeWidth="1.5"
        strokeDasharray="6 5"
        className="origin-center animate-sweep opacity-70"
      />
      <circle cx="32" cy="32" r="20" fill="none" stroke="hsl(199 80% 42%)" strokeWidth="2" opacity="0.85" />
      <circle
        cx="32"
        cy="32"
        r="12"
        fill="none"
        stroke="hsl(186 100% 45%)"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        className="origin-center animate-sweep"
        style={{ animationDirection: "reverse", animationDuration: "14s" }}
      />
      <circle cx="32" cy="32" r="5" fill="hsl(186 100% 45%)" className="animate-pulse-glow" />
    </svg>
  );
}

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 26 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-70px" }}
      transition={{ duration: 0.55, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

const CAPABILITIES = [
  {
    icon: Brain,
    title: "Conversational core",
    text: "Multi-turn chat with function calling — it acts through tools instead of guessing.",
  },
  {
    icon: Mic,
    title: "Wake word “Jarvis”",
    text: "Ambient listening via the browser speech engine; it only answers when called.",
  },
  {
    icon: Volume2,
    title: "Spoken replies",
    text: "Natural text-to-speech responses under two seconds — hands free, eyes up.",
  },
  {
    icon: BellRing,
    title: "Proactive alerts",
    text: "Due reminders interrupt with a spoken notice instead of dying in a list.",
  },
  {
    icon: NotebookPen,
    title: "Persistent memory",
    text: "Notes and reminders live in your own database, attached to your account.",
  },
  {
    icon: ShieldCheck,
    title: "Legal-only guardrails",
    text: "The system prompt refuses malware, unauthorized access, fraud and surveillance.",
  },
];

const PHASES = [
  {
    n: 1,
    title: "Environment & Core Engine",
    status: "LIVE",
    text: "TypeScript stack, Convex backend, encrypted session auth and a hardened chat loop.",
  },
  {
    n: 2,
    title: "Voice Interface & Audio Pipeline",
    status: "LIVE",
    text: "Wake-word activation, real-time speech-to-text and smooth low-latency speech synthesis.",
  },
  {
    n: 3,
    title: "Workspace & Productivity Tools",
    status: "LIVE",
    text: "Function calling for reminders and notes today; calendar and email connectors next, behind explicit confirmation.",
  },
  {
    n: 4,
    title: "Smart Home & Hardware (IoT)",
    status: "PLANNED",
    text: "Home Assistant / MQTT bridges on local hardware, strictly inside your own network.",
  },
  {
    n: 5,
    title: "Proactive Background Autonomy",
    status: "LIVE",
    text: "A background scheduler raises weather, meeting and system alerts within strict permission boundaries.",
  },
] as const;

const sessionLog = [
  { kind: "user", text: "Jarvis, remind me to call the dentist in 30 minutes." },
  { kind: "tool", text: "⚙ Reminder set — “Call the dentist”, fires 14:42" },
  { kind: "jarvis", text: "Done. I'll ping you in half an hour." },
  { kind: "user", text: "Jarvis, save a note: passport renewal due in June." },
  { kind: "tool", text: "⚙ Saved note — “passport renewal”" },
  { kind: "jarvis", text: "Noted — filed in your private notebook." },
] as const;

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* NAV */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <ArcReactor size={26} />
            <span className="font-display text-sm font-bold tracking-[0.28em]">J.A.R.V.I.S.</span>
          </Link>
          <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href="#capabilities" className="transition-colors hover:text-primary">
              Capabilities
            </a>
            <a href="#roadmap" className="transition-colors hover:text-primary">
              Roadmap
            </a>
            <a href="#desktop" className="transition-colors hover:text-primary">
              Desktop
            </a>
            <a href="#safety" className="transition-colors hover:text-primary">
              Safety
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/auth" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign in
            </Link>
            <Link to="/auth?returnTo=%2Fassistant" className={buttonVariants({ size: "sm" })}>
              Initialize
            </Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative overflow-hidden pb-24 pt-32 md:pb-32 md:pt-44">
        <div className="hud-grid mask-fade-b absolute inset-0" aria-hidden />
        <div
          className="absolute left-1/2 top-[-14rem] h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-primary/10 blur-[120px]"
          aria-hidden
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 md:grid-cols-2">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex flex-wrap items-center gap-2"
            >
              <Badge variant="signal">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
                System online
              </Badge>
              <Badge>Legal-only core</Badge>
              <Badge variant="outline">Private by design</Badge>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="mt-6 font-display text-4xl font-bold leading-tight tracking-tight md:text-5xl"
            >
              <span className="text-muted-foreground">Good evening.</span>
              <br />
              <span className="glow-text text-primary">I'm J.A.R.V.I.S.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground md:text-lg"
            >
              A private, voice-first personal AI assistant that runs on your own stack. It hears
              the wake word, speaks back, manages reminders and notes through real tools — and
              stays strictly on the right side of the law.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="mt-8 flex flex-wrap items-center gap-3"
            >
              <Link
                to="/auth?returnTo=%2Fassistant"
                className={buttonVariants({ size: "lg" })}
              >
                Initialize assistant
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link to="/desktop" className={buttonVariants({ variant: "outline", size: "lg" })}>
                Open the local console
              </Link>
            </motion.div>

            <motion.ul
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.5 }}
              className="mt-8 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground"
            >
              <li>Wake word</li>
              <li>· Spoken replies</li>
              <li>· Reminders</li>
              <li>· Notes</li>
              <li>· Function calling</li>
            </motion.ul>
          </div>

          {/* Session log card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.25 }}
            className="relative"
          >
            <div className="absolute -inset-6 rounded-full bg-primary/10 blur-3xl" aria-hidden />
            <div className="relative rounded-lg border border-border bg-card/90 shadow-2xl backdrop-blur">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-signal/70" />
                <span className="ml-2 font-mono text-[11px] tracking-widest text-muted-foreground">
                  jarvis — live session
                </span>
              </div>
              <div className="space-y-3 p-5 font-mono text-[13px] leading-relaxed">
                {sessionLog.map((line, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.6 + i * 0.35, duration: 0.35 }}
                  >
                    {line.kind === "user" && (
                      <p className="text-foreground">
                        <span className="text-muted-foreground">you&nbsp›</span> {line.text}
                      </p>
                    )}
                    {line.kind === "tool" && (
                      <p className="text-amber/90">{line.text}</p>
                    )}
                    {line.kind === "jarvis" && (
                      <p className="text-primary">
                        <span className="text-signal">jarvis&nbsp›</span> {line.text}
                      </p>
                    )}
                  </motion.div>
                ))}
                <p className="text-primary">
                  jarvis&nbsp›<span className="ml-1 inline-block h-4 w-2 animate-blink bg-primary align-middle" />
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* STATS */}
      <section className="border-y border-border bg-card/40">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-5 md:grid-cols-4">
          {[
            { k: "5", l: "Phase blueprint" },
            { k: "4", l: "Phases live" },
            { k: "100%", l: "Legal operation" },
            { k: "0", l: "Data sold" },
          ].map((s) => (
            <div key={s.l} className="px-4 py-8 text-center">
              <p className="font-display text-3xl font-bold text-primary glow-text">{s.k}</p>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {s.l}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CAPABILITIES */}
      <section id="capabilities" className="mx-auto max-w-6xl px-5 py-24">
        <Reveal className="max-w-2xl">
          <Badge>Capabilities</Badge>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight md:text-4xl">
            Everything an assistant should do — <span className="text-primary">nothing it shouldn't</span>
          </h2>
          <p className="mt-4 text-muted-foreground">
            Each module ships behind a validation gate: it works, or it doesn't ship. Voice,
            memory and tool use are live; hardware control follows the same discipline.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c, i) => (
            <Reveal key={c.title} delay={i * 0.07}>
              <div className="group h-full rounded-lg border border-border bg-card/70 p-6 transition-all hover:border-primary/50 hover:glow-box">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary transition group-hover:bg-primary/20">
                  <c.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 font-display text-base font-semibold">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ROADMAP */}
      <section id="roadmap" className="border-y border-border bg-card/30">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <Reveal className="max-w-2xl">
            <Badge>Sequential pipeline</Badge>
            <h2 className="mt-4 font-display text-3xl font-bold tracking-tight md:text-4xl">
              The five-phase blueprint
            </h2>
            <p className="mt-4 text-muted-foreground">
              Strict gate discipline: no phase advances until its validation checklist passes.
              Four phases are live in this build — hardware integration is next.
            </p>
          </Reveal>

          <div className="mt-12 space-y-4">
            {PHASES.map((p, i) => (
              <Reveal key={p.n} delay={i * 0.06}>
                <div className="flex flex-col gap-4 rounded-lg border border-border bg-background/60 p-6 transition-colors hover:border-primary/40 md:flex-row md:items-center">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 font-display text-sm font-bold text-primary">
                    {String(p.n).padStart(2, "0")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="font-display text-base font-semibold">{p.title}</h3>
                      <Badge variant={p.status === "LIVE" ? "signal" : "outline"}>{p.status}</Badge>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{p.text}</p>
                  </div>
                  <div className="hidden text-muted-foreground/40 md:block">
                    {p.n === 4 ? <Home className="h-6 w-6" /> : p.n === 5 ? <Cpu className="h-6 w-6" /> : null}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* SAFETY */}
      <section id="safety" className="mx-auto max-w-6xl px-5 py-24">
        <Reveal>
          <div className="rounded-lg border border-amber/40 bg-amber/5 p-8 md:p-10">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-amber/40 bg-amber/10 text-amber">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <h2 className="font-display text-2xl font-bold">Security & legal compliance</h2>
              </div>
              <Badge variant="amber">100% legal</Badge>
            </div>
            <p className="mt-5 max-w-3xl leading-relaxed text-muted-foreground">
              This system operates strictly within standard authorized APIs, user permissions and
              local hardware limits. It is built to <strong className="text-foreground">refuse</strong>{" "}
              illegal activity on request — no malware, no unauthorized access, no surveillance of
              other people, no fraud. Every action it takes stays inside your own account.
            </p>
            <ul className="mt-6 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
              {[
                "Unauthorized network intrusion, exploitation or credential theft: refused.",
                "Covert surveillance or stalking of other people: refused.",
                "External actions (mail, calendar, devices) require explicit confirmation.",
                "Your conversations and notes live in your own backend, never sold.",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </section>

      {/* LOCAL CORE */}
      <section id="desktop" className="border-y border-border bg-card/30">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 md:grid-cols-2">
          <Reveal>
            <Badge variant="signal">Local core</Badge>
            <h2 className="mt-4 font-display text-3xl font-bold tracking-tight md:text-4xl">
              The offline build that never phones home
            </h2>
            <p className="mt-4 text-muted-foreground">
              The Windows app ships its own Python core on{" "}
              <span className="font-mono text-xs text-primary">127.0.0.1</span> — wake-word detection,
              speech recognition and speech output all run on your machine, and the microphone stays
              closed until you open it.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
              {[
                "openWakeWord detects “Hey JARVIS” without sending a single frame anywhere.",
                "Only allowlisted actions exist: open a few apps, read system info, search your own folders, set the volume.",
                "Sensitive actions stop and ask for a single-use approval of the exact action.",
                "File deletion, installs, registry edits, elevation and scripts are refused by policy.",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/desktop" className={buttonVariants()}>Open the local console</Link>
              <Link to="/auth?returnTo=%2Fassistant" className={buttonVariants({ variant: "outline" })}>
                Use the cloud assistant
              </Link>
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="rounded-lg border border-border bg-card/90 shadow-2xl backdrop-blur">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-signal/70" />
                <span className="ml-2 font-mono text-[11px] tracking-widest text-muted-foreground">
                  permission ladder
                </span>
              </div>
              <div className="space-y-4 p-5">
                {[
                  {
                    tier: "READ",
                    tone: "text-signal border-signal/40 bg-signal/10",
                    items: "time, system info, file search inside your folders",
                  },
                  {
                    tier: "ACTION",
                    tone: "text-primary border-primary/40 bg-primary/10",
                    items: "open calculator, notepad, explorer, an allowed site",
                  },
                  {
                    tier: "CONFIRM",
                    tone: "text-amber border-amber/40 bg-amber/10",
                    items: "volume and anything else that changes the machine",
                  },
                  {
                    tier: "BLOCKED",
                    tone: "text-destructive border-destructive/40 bg-destructive/10",
                    items: "delete, install, elevate, scripts, shells — no exceptions",
                  },
                ].map((row) => (
                  <div key={row.tier} className="flex items-start gap-3">
                    <span
                      className={`w-24 shrink-0 rounded border px-2 py-1 text-center font-mono text-[10px] tracking-[0.16em] ${row.tone}`}
                    >
                      {row.tier}
                    </span>
                    <p className="pt-1 text-xs leading-relaxed text-muted-foreground">{row.items}</p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t border-border">
        <div className="hud-grid absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-3xl px-5 py-24 text-center">
          <Reveal>
            <ArcReactor size={56} className="mx-auto" />
            <h2 className="mt-6 font-display text-3xl font-bold tracking-tight md:text-4xl">
              Ready when you are.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
              Create your account, connect your model key, and say “Jarvis” — the rest of the
              blueprint is already wired.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link to="/auth?returnTo=%2Fassistant" className={buttonVariants({ size: "lg" })}>
                Initialize assistant
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link to="/desktop" className={buttonVariants({ variant: "outline", size: "lg" })}>
                Run it on Windows
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 md:flex-row">
          <div className="flex items-center gap-2.5">
            <ArcReactor size={20} />
            <span className="font-display text-xs font-bold tracking-[0.28em]">J.A.R.V.I.S.</span>
          </div>
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Convex · React · Vite · Electron · Python core
          </p>
          <p className="text-xs text-muted-foreground">
            Authorized APIs only — no illegal activity, ever.
          </p>
        </div>
      </footer>
    </div>
  );
}

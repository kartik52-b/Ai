import { Link } from "react-router-dom";
import { ArrowRight, Cpu } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/**
 * Shown on the cloud routes when this build has no Convex deployment URL.
 *
 * The local desktop console does not need Convex at all, so the rest of the app
 * keeps working — only accounts, chat history, notes and reminders need it.
 */
export function MissingBackend() {
  return (
    <div className="hud-grid flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-lg rounded-lg border border-border bg-card p-8 text-center glow-box">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-amber">Backend offline</p>
        <h1 className="mt-3 font-display text-xl font-semibold text-foreground">
          Convex deployment not linked
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Accounts, conversations, notes and reminders need a Convex backend URL. From the project root
          run{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-primary">
            bunx convex dev --once
          </code>{" "}
          to generate <span className="font-mono text-xs">VITE_CONVEX_URL</span>, then reload.
        </p>
        <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Cpu className="h-3.5 w-3.5 text-signal" />
          The local desktop console works offline and needs none of this.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link to="/desktop" className={buttonVariants()}>
            Open the local console
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

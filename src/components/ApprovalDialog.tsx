import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/hooks/useJarvisDesktop";

/**
 * Approval gate for sensitive actions.
 *
 * The dialog shows the *exact* action the service proposed, because the
 * approval the service stores is bound to that command and those arguments and
 * is single-use: approving here can never authorise a different action, and it
 * expires on its own.
 */
export default function ApprovalDialog({
  approval,
  busy,
  onResolve,
}: {
  approval: PendingApproval | null;
  busy: boolean;
  onResolve: (approve: boolean) => void | Promise<void>;
}) {
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!approval) return;
    setSecondsLeft(Math.max(Math.round(approval.expiresInSeconds), 0));
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [approval]);

  return (
    <AnimatePresence>
      {approval ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-5 backdrop-blur"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm a sensitive action"
        >
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.22 }}
            className="w-full max-w-lg rounded-lg border border-amber/50 bg-card p-6 glow-box"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-amber/40 bg-amber/10 text-amber">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
                    Confirmation required
                  </p>
                  <h2 className="font-display text-lg font-semibold">Approve this exact action?</h2>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onResolve(false)}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Deny and close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 rounded-md border border-border bg-background/70 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                command
              </p>
              <p className="mt-1 font-mono text-sm text-primary">{approval.command}</p>
              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                what will happen
              </p>
              <p className="mt-1 text-sm text-foreground">{approval.summary}</p>
            </div>

            <ul className="mt-4 space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
                Single use — the approval is bound to this command and these arguments only.
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
                {secondsLeft > 0
                  ? `Expires in ${secondsLeft}s if you do nothing.`
                  : "This request has expired — ask again to get a fresh one."}
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
                Denying executes nothing at all.
              </li>
            </ul>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Button variant="outline" onClick={() => void onResolve(false)} disabled={busy}>
                Deny
              </Button>
              <Button
                onClick={() => void onResolve(true)}
                disabled={busy || secondsLeft === 0}
                className="bg-amber text-amber-foreground shadow-none hover:brightness-110"
              >
                Approve once
              </Button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

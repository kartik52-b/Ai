import { useEffect, useState, type FormEvent } from "react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import ArcReactor from "@/components/ArcReactor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function safeReturnTo(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/assistant";
}

export default function AuthPage() {
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { signIn } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnTo(searchParams.get("returnTo"));

  useEffect(() => {
    if (isAuthenticated) navigate(returnTo, { replace: true });
  }, [isAuthenticated, navigate, returnTo]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const formData = new FormData();
      formData.set("email", email.trim());
      formData.set("password", password);
      formData.set("flow", flow);
      const result = await signIn("password", formData);
      if (result && typeof result === "object" && "isSignedIn" in result && !result.isSignedIn) {
        setBusy(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/password/i.test(message) && /short|least|weak/i.test(message)) {
        setError("Password must be at least 8 characters.");
      } else if (/no account|not found|does not exist/i.test(message)) {
        setError("No account with that email — switch to “Create account”.");
      } else if (/invalid|incorrect|unauthorized/i.test(message)) {
        setError("Invalid email or password.");
      } else if (/timed out|timeout|too long/i.test(message)) {
        setError("The server took too long to respond — please try again.");
      } else {
        setError(message.slice(0, 200));
      }
      setBusy(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to={returnTo} replace />;
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden border-r border-border lg:flex lg:flex-col lg:justify-between lg:p-10">
        <div className="hud-grid absolute inset-0" aria-hidden />
        <div
          className="absolute -left-24 top-1/3 h-96 w-96 rounded-full bg-primary/10 blur-[110px]"
          aria-hidden
        />
        <Link to="/" className="relative flex items-center gap-2.5">
          <ArcReactor size={26} />
          <span className="font-display text-sm font-bold tracking-[0.28em]">J.A.R.V.I.S.</span>
        </Link>
        <div className="relative">
          <Badge variant="signal">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
            Secure link
          </Badge>
          <h1 className="mt-5 max-w-md font-display text-3xl font-bold leading-tight">
            Your assistant, <span className="text-primary glow-text">on your terms.</span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Sessions are cryptographically signed and scoped to your account. Conversations,
            reminders and notes never leave your own backend.
          </p>
        </div>
        <ul className="relative space-y-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <li className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-signal" /> Scrypt-hashed credentials
          </li>
          <li className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-signal" /> Signed session tokens
          </li>
        </ul>
      </div>

      {/* Form panel */}
      <div className="flex flex-col justify-center px-5 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center gap-2 lg:hidden">
            <ArcReactor size={24} />
            <span className="font-display text-sm font-bold tracking-[0.28em]">J.A.R.V.I.S.</span>
          </Link>

          <h2 className="font-display text-2xl font-bold">
            {flow === "signIn" ? "Welcome back" : "Create your account"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {flow === "signIn"
              ? "Authenticate to wake the assistant."
              : "One account, private to you. Minimum 8 characters."}
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete={flow === "signIn" ? "current-password" : "new-password"}
                required
                minLength={8}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" size="lg" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {flow === "signIn" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <div className="mt-6 flex items-center justify-between text-sm">
            <button
              type="button"
              className="text-primary transition-colors hover:underline"
              onClick={() => {
                setFlow(flow === "signIn" ? "signUp" : "signIn");
                setError(null);
              }}
            >
              {flow === "signIn" ? "Create an account" : "I already have an account"}
            </button>
            <Link to="/" className="text-muted-foreground transition-colors hover:text-foreground">
              Back home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";
import { Button, Callout, Card, Field, inputCls } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
    else window.location.href = "/";
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-xs font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">SW</span>
          <span className="text-sm font-semibold tracking-tight">Silent Witness <span className="text-zinc-400">GTM</span></span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Sign in</h1>
        <p className="mb-5 mt-1 text-sm text-zinc-500">Sign in with your team account.</p>
        <form onSubmit={signIn} className="space-y-3">
          <Field label="Email">
            <input
              type="email" required placeholder="you@silentwitness.ai"
              className={inputCls} value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <input
              type="password" required placeholder="Password"
              className={inputCls} value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error ? <Callout tone="bad">{error}</Callout> : null}
          <Button className="w-full" disabled={busy}>
            {busy ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";
import { Brand } from "@/components/brand";
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
        <Brand className="mb-6" />
        <h1 className="text-xl font-bold tracking-[-0.025em] text-zinc-950 dark:text-white">Sign in</h1>
        <p className="mb-5 mt-1 text-sm text-zinc-600 dark:text-zinc-400">Sign in with your team account.</p>
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

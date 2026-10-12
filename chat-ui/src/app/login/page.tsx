"use client";

import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError("Incorrect password.");
        return;
      }
      // Hard navigation, not router.replace(): any page visited while
      // logged out (redirected to /login) gets cached as "redirect to
      // login" in Next's client Router Cache - static pages (this app's
      // top-level routes all prerender as static) default to a 5-minute
      // stale time there. A soft client-side transition would keep
      // reusing that stale result after login; a full page load discards
      // the in-memory Router Cache entirely.
      const from = new URLSearchParams(window.location.search).get("from");
      window.location.href = from && from.startsWith("/") ? from : "/";
    } catch {
      setError("Couldn't reach Amy.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-xs space-y-4">
        <div className="flex items-center justify-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
          </span>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">Amy</span>
        </div>

        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30"
        />

        {error && <p className="text-center text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting || !password}
          className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
        >
          {isSubmitting ? "Checking…" : "Log in"}
        </button>
      </form>
    </div>
  );
}

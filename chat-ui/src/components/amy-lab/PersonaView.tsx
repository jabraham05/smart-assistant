"use client";

import { useEffect, useState } from "react";

export function PersonaView() {
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setIsLoading(true);
    fetch("/api/amy/persona")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setSystemPrompt(data.systemPrompt ?? null))
      .catch(() => setError("Couldn't reach chat-orchestrator."))
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">
        Amy&apos;s core persona text - her character/tone, loaded live from the active persona row. This is the
        foundational clause buildSystemPrompt puts first, before the date, response-style rules, and everything else.
      </p>
      <div className="rounded-xl border border-white/10 bg-zinc-900/40 p-4">
        {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
        {error && <p className="text-xs text-rose-400">{error}</p>}
        {!isLoading && !error && !systemPrompt && (
          <p className="text-xs text-zinc-600">No persona row could be loaded.</p>
        )}
        {!isLoading && !error && systemPrompt && (
          <pre className="whitespace-pre-wrap text-xs text-zinc-300">{systemPrompt}</pre>
        )}
      </div>
    </div>
  );
}

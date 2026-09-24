"use client";

import { useEffect, useState } from "react";
import type { MemoryEntry, MemorySearchResult } from "@/lib/memory-engine-client";

function EntryRow({ content, domain, createdAt, score }: { content: string; domain: string | null; createdAt: string; score?: number }) {
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-3.5">
      <p className="text-sm text-zinc-200">{content}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-zinc-600">
        {domain && <span className="rounded-full bg-white/5 px-1.5 py-0.5">{domain}</span>}
        <span className="font-mono">{new Date(createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        {score !== undefined && <span className="font-mono">score {score.toFixed(3)}</span>}
      </div>
    </li>
  );
}

// First-ever view into memory-engine's stored turns from chat-ui - default
// browse (GET /api/memory) newest-first, plus a search box reusing the
// same relevance-ranked query mode memory_recall/chat-orchestrator's
// per-turn retrieval already use.
export function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemorySearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    fetch("/api/memory?limit=30")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { entries: MemoryEntry[] }) => setEntries(data.entries))
      .catch(() => setError("Couldn't reach memory-engine."))
      .finally(() => setIsLoading(false));
  }, []);

  const search = async () => {
    if (!query.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK: 15 }),
      });
      const data = await res.json();
      setResults(res.ok ? data.results : []);
    } catch {
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
        className="mb-3 flex gap-1.5"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stored memory…"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50"
        />
        <button
          type="submit"
          disabled={isSearching || !query.trim()}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
        >
          {isSearching ? "Searching…" : "Search"}
        </button>
        {results && (
          <button
            type="button"
            onClick={() => {
              setResults(null);
              setQuery("");
            }}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-400 hover:bg-white/5"
          >
            Clear
          </button>
        )}
      </form>

      {results ? (
        <>
          <p className="mb-2 text-xs text-zinc-500">{results.length} result(s)</p>
          <ul className="space-y-2">
            {results.map((r, i) => (
              <EntryRow key={i} content={r.content} domain={r.domain} createdAt={r.createdAt} score={r.score} />
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="mb-2 text-xs text-zinc-500">Most recent stored turns (every message, both yours and Amy&apos;s).</p>
          {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
          {error && <p className="text-xs text-rose-400">{error}</p>}
          {!isLoading && !error && entries.length === 0 && <p className="text-xs text-zinc-600">Nothing stored yet.</p>}
          <ul className="space-y-2">
            {entries.map((e) => (
              <EntryRow key={e.id} content={e.content} domain={e.domain} createdAt={e.created_at} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

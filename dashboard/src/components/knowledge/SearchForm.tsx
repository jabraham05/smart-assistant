"use client";

import { useState } from "react";
import type { KnowledgeSearchResult } from "@/lib/knowledge-engine-client";

export function SearchForm() {
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [topK, setTopK] = useState("");
  const [includeStale, setIncludeStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          domain: domain.trim() || undefined,
          topK: topK.trim() ? Number(topK) : undefined,
          includeStale,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        setResults(null);
      } else {
        setResults(data.results);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Query
          <input
            className="w-80 rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/15"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="what does my knowledge base say about..."
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Domain (optional)
          <input
            className="w-40 rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/15"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Top K (optional)
          <input
            type="number"
            min={1}
            className="w-24 rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/15"
            value={topK}
            onChange={(e) => setTopK(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input
            type="checkbox"
            checked={includeStale}
            onChange={(e) => setIncludeStale(e.target.checked)}
          />
          Include stale
        </label>
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-black px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {results && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-black/60 dark:text-white/60">{results.length} result(s)</p>
          {results.map((r, i) => (
            <div key={i} className="rounded-md border border-black/10 p-3 text-sm dark:border-white/10">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-black/60 dark:text-white/60">
                <span className="font-medium text-black dark:text-white">{r.documentTitle}</span>
                {r.domain && <span className="rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/10">{r.domain}</span>}
                {r.pageNumber != null && <span>p.{r.pageNumber}</span>}
                {r.heading && <span>{r.heading}</span>}
                <span className="ml-auto tabular-nums">score {r.score.toFixed(4)}</span>
              </div>
              <p className="whitespace-pre-wrap">{r.content}</p>
              {r.source?.url && (
                <a
                  href={r.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs text-blue-600 underline dark:text-blue-400"
                >
                  {r.source.title ?? r.source.url}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

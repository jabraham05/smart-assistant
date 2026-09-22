"use client";

import { useState } from "react";

const DATABASES = ["postgres", "n8n", "research", "coding_tasks", "events"] as const;

interface QueryResponse {
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

export function QueryEditor() {
  const [database, setDatabase] = useState<(typeof DATABASES)[number]>("n8n");
  const [sql, setSql] = useState("SELECT now()");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResponse | null>(null);

  async function runQuery() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/database/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database, sql }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        setResult(null);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Database
          <select
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/15"
            value={database}
            onChange={(e) => setDatabase(e.target.value as (typeof DATABASES)[number])}
          >
            {DATABASES.map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </select>
        </label>
      </div>

      <textarea
        className="h-32 w-full rounded-md border border-black/15 bg-transparent p-2 font-mono text-sm dark:border-white/15"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        spellCheck={false}
      />

      <div>
        <button
          onClick={runQuery}
          disabled={loading}
          className="rounded-md bg-black px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {loading ? "Running..." : "Run (read-only)"}
        </button>
        <span className="ml-3 text-xs text-black/50 dark:text-white/50">
          Only SELECT/WITH statements are allowed - enforced twice (app-layer check + a real Postgres read-only transaction).
        </span>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div>
          <p className="mb-2 text-xs text-black/50 dark:text-white/50">
            {result.rowCount} row(s) in {result.elapsedMs}ms
          </p>
          <div className="overflow-auto rounded-md border border-black/10 dark:border-white/10">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-black/10 bg-black/[.03] dark:border-white/10 dark:bg-white/[.03]">
                  {result.fields.map((f) => (
                    <th key={f} className="whitespace-nowrap px-3 py-1.5 font-medium">
                      {f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-b border-black/5 last:border-0 dark:border-white/5">
                    {result.fields.map((f) => (
                      <td key={f} className="whitespace-nowrap px-3 py-1.5 align-top">
                        {formatCell(row[f])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

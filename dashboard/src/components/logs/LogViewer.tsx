"use client";

import { useState } from "react";

const SERVICES = [
  "n8n",
  "ollama",
  "chat-ui",
  "homeassistant",
  "postgres",
  "redis",
  "skills-mcp",
  "sandbox-runner",
  "coding-orchestrator",
  "event-bus",
  "knowledge-engine",
  "discord-bot",
  "dashboard",
] as const;

export function LogViewer() {
  const [service, setService] = useState<(typeof SERVICES)[number]>("n8n");
  const [logs, setLogs] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/logs/${service}?tail=200`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        setLogs("");
      } else {
        setLogs(data.logs);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <select
          className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
          value={service}
          onChange={(e) => setService(e.target.value as (typeof SERVICES)[number])}
        >
          {SERVICES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {loading ? "Loading..." : "Refresh (last 200 lines)"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-md border border-black/10 bg-black/[.03] p-3 text-xs dark:border-white/10 dark:bg-white/[.05]">
        {logs || "No logs loaded yet - click Refresh."}
      </pre>
    </div>
  );
}

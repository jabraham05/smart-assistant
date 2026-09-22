"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Execution {
  id: number;
  workflowId: string;
  workflowName: string | null;
  mode: string;
  status: string;
  finished: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
}

export function ExecutionsTable() {
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/executions")
      .then((r) => r.json())
      .then((data) => setExecutions(data.executions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!executions) return <p className="text-sm text-black/50 dark:text-white/50">Loading...</p>;

  return (
    <div className="overflow-auto rounded-md border border-black/10 dark:border-white/10">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-black/10 bg-black/[.03] dark:border-white/10 dark:bg-white/[.03]">
            <th className="px-3 py-1.5 font-medium">Workflow</th>
            <th className="px-3 py-1.5 font-medium">Status</th>
            <th className="px-3 py-1.5 font-medium">Mode</th>
            <th className="px-3 py-1.5 font-medium">Started</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((ex) => (
            <tr key={ex.id} className="border-b border-black/5 last:border-0 dark:border-white/5">
              <td className="px-3 py-1.5">
                <Link href={`/workflows/executions/${ex.id}`} className="text-blue-600 underline dark:text-blue-400">
                  {ex.workflowName ?? ex.workflowId} #{ex.id}
                </Link>
              </td>
              <td className="px-3 py-1.5">{ex.status}</td>
              <td className="px-3 py-1.5">{ex.mode}</td>
              <td className="px-3 py-1.5 tabular-nums">{ex.startedAt ? new Date(ex.startedAt).toLocaleString() : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

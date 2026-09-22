"use client";

import { useEffect, useState } from "react";

interface NodeRunSummary {
  nodeName: string;
  runIndex: number;
  status: "success" | "error";
  executionTime: number | null;
  output: unknown;
  errorMessage: string | null;
}

interface ExecutionDetail {
  execution: {
    id: number;
    workflowName: string | null;
    status: string;
    mode: string;
    startedAt: string | null;
    stoppedAt: string | null;
  };
  nodeRuns: NodeRunSummary[];
  error?: string;
}

export function RunDataDrilldown({ executionId }: { executionId: number }) {
  const [data, setData] = useState<ExecutionDetail | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/executions/${executionId}`)
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setFetchError(e instanceof Error ? e.message : String(e)));
  }, [executionId]);

  if (fetchError) return <p className="text-sm text-red-600 dark:text-red-400">{fetchError}</p>;
  if (!data) return <p className="text-sm text-black/50 dark:text-white/50">Loading...</p>;

  return (
    <div>
      <div className="mb-4 text-sm">
        <div className="text-base font-medium">
          {data.execution.workflowName} #{data.execution.id}
        </div>
        <div className="text-black/60 dark:text-white/60">
          {data.execution.status} · {data.execution.mode} · started{" "}
          {data.execution.startedAt ? new Date(data.execution.startedAt).toLocaleString() : "?"}
        </div>
      </div>

      {data.error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{data.error}</p>}

      <div className="flex flex-col gap-2">
        {data.nodeRuns.map((run) => (
          <details key={`${run.nodeName}-${run.runIndex}`} className="rounded-md border border-black/10 dark:border-white/10">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm">
              <span className={run.status === "error" ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}>
                {run.status === "error" ? "✗" : "✓"}
              </span>
              <span className="font-medium">{run.nodeName}</span>
              {run.executionTime != null && (
                <span className="ml-auto tabular-nums text-black/50 dark:text-white/50">{run.executionTime}ms</span>
              )}
            </summary>
            <div className="border-t border-black/10 p-3 dark:border-white/10">
              {run.errorMessage && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{run.errorMessage}</p>}
              <pre className="overflow-auto whitespace-pre-wrap rounded bg-black/[.03] p-2 text-xs dark:bg-white/[.05]">
                {JSON.stringify(run.output, null, 2)}
              </pre>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

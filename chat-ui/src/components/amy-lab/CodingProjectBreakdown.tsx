"use client";

import { useEffect, useState } from "react";
import type { CodingTask, CodingTaskLogEntry } from "@/lib/coding-orchestrator-client";

function StatusBadge({ label, variant = "neutral" }: { label: string; variant?: "neutral" | "success" | "error" }) {
  const colors =
    variant === "success"
      ? "bg-emerald-500/10 text-emerald-300"
      : variant === "error"
        ? "bg-rose-500/10 text-rose-300"
        : "bg-white/5 text-zinc-500";
  return <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${colors}`}>{label}</span>;
}

function TaskRow({ task, isSelected, onSelect }: { task: CodingTask; isSelected: boolean; onSelect: () => void }) {
  return (
    <li
      onClick={onSelect}
      className={`cursor-pointer rounded-lg border p-2.5 transition-colors ${
        isSelected ? "border-indigo-500/40 bg-indigo-500/[0.06]" : "border-white/5 bg-white/[0.02] hover:border-white/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-zinc-100">{task.task_description}</p>
        <StatusBadge label={task.status} variant={task.status === "needs_review_failed" ? "error" : "neutral"} />
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">
        {task.attempt_count} attempt{task.attempt_count === 1 ? "" : "s"}
      </p>
      {task.status === "needs_review_failed" && task.reviewer_reason && (
        <p className="mt-1 text-[10px] text-rose-400">{task.reviewer_reason}</p>
      )}
      {task.pr_url && (
        <a
          href={task.pr_url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-1 block text-[10px] text-indigo-400 hover:underline"
        >
          View PR
        </a>
      )}
    </li>
  );
}

function LogEntryRow({ entry }: { entry: CodingTaskLogEntry }) {
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-zinc-300">{entry.phase}</span>
        <StatusBadge label={entry.status} variant={entry.status === "error" ? "error" : "success"} />
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">{new Date(entry.created_at).toLocaleString()}</p>
      {(entry.content || entry.error_message) && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10px] text-indigo-400 hover:text-indigo-300">Details</summary>
          <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 text-[10px] text-zinc-400">
            {entry.error_message || entry.content}
          </pre>
        </details>
      )}
    </li>
  );
}

function TaskTimeline({ log }: { log: CodingTaskLogEntry[] }) {
  const groups = new Map<number | null, CodingTaskLogEntry[]>();
  for (const entry of log) {
    const key = entry.attempt_number;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([attempt, entries]) => (
        <div key={attempt ?? "setup"}>
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-zinc-600">
            {attempt === null ? "Setup" : `Attempt ${attempt}`}
          </p>
          <ul className="space-y-1.5">
            {entries.map((entry) => (
              <LogEntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function CodingProjectBreakdown() {
  const [tasks, setTasks] = useState<CodingTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<number | undefined>();
  const [log, setLog] = useState<CodingTaskLogEntry[] | null>(null);
  const [logError, setLogError] = useState<string | undefined>();

  useEffect(() => {
    setIsLoading(true);
    fetch("/api/coding-tasks")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setTasks(data.tasks ?? []))
      .catch(() => setError("Couldn't reach coding-orchestrator."))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    if (selectedId === undefined) return;
    setLog(null);
    setLogError(undefined);
    fetch(`/api/coding-tasks/${selectedId}/log`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setLog(data.log ?? []))
      .catch(() => setLogError("Couldn't load this task's phase log."));
  }, [selectedId]);

  return (
    <div className="flex h-full gap-4">
      <div className="w-80 shrink-0 overflow-y-auto">
        {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
        {error && <p className="text-xs text-rose-400">{error}</p>}
        {!isLoading && !error && tasks.length === 0 && <p className="text-xs text-zinc-600">No coding tasks yet.</p>}
        <ul className="space-y-1.5">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} isSelected={task.id === selectedId} onSelect={() => setSelectedId(task.id)} />
          ))}
        </ul>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/40 p-4">
        {selectedId === undefined && <p className="text-xs text-zinc-600">Select a task to see its step-by-step breakdown.</p>}
        {selectedId !== undefined && logError && <p className="text-xs text-rose-400">{logError}</p>}
        {selectedId !== undefined && !logError && log === null && <p className="text-xs text-zinc-600">Loading…</p>}
        {selectedId !== undefined && !logError && log !== null && log.length === 0 && (
          <p className="text-xs text-zinc-600">No phase log recorded for this task.</p>
        )}
        {selectedId !== undefined && !logError && log !== null && log.length > 0 && <TaskTimeline log={log} />}
      </div>
    </div>
  );
}

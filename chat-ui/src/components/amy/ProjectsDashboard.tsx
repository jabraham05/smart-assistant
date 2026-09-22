"use client";

import { useCallback, useEffect, useState } from "react";
import { useProjects } from "@/hooks/useProjects";
import type { Project } from "@/lib/knowledge-engine-client";
import type { EventBusEvent } from "@/types/chat";

function Card({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {count}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="text-xs text-gray-400">{text}</p>;
}

function ProposedRow({
  project,
  onApprove,
  onReject,
}: {
  project: Project;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <li className="rounded border border-gray-200 p-3 dark:border-gray-700">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{project.title}</p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{project.rationale}</p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={onApprove}
          className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
        >
          Approve
        </button>
        <button
          onClick={onReject}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Reject
        </button>
      </div>
    </li>
  );
}

function activeStatusLabel(project: Project): string {
  if (project.research_queue_status === "done") return "ready to complete";
  if (project.research_queue_status === "researching") return "researching…";
  if (project.research_queue_status === "pending") return "queued for research";
  if (project.research_queue_status === "failed") return "research failed";
  return "working…";
}

function ActiveRow({ project, onComplete }: { project: Project; onComplete: () => void }) {
  const ready = project.research_queue_status === "done";
  return (
    <li className="rounded border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{project.title}</p>
        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {activeStatusLabel(project)}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        {project.research_session_id && (
          <a
            href={`/research/${project.research_session_id}`}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            View research
          </a>
        )}
        <button
          onClick={onComplete}
          disabled={!ready}
          className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark done
        </button>
      </div>
    </li>
  );
}

function FeedbackRow({ event }: { event: EventBusEvent }) {
  const category = typeof event.payload?.category === "string" ? event.payload.category : "other";
  const note = typeof event.payload?.note === "string" ? event.payload.note : "";
  return (
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {category.replace("_", " ")}
        </span>
        <span className="shrink-0 text-[10px] text-gray-400">
          {new Date(event.occurred_at).toLocaleDateString()}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">{note}</p>
    </li>
  );
}

export function ProjectsDashboard() {
  const { projects, isLoading, error, actionError, refresh, approve, reject, complete } = useProjects();
  const [feedback, setFeedback] = useState<EventBusEvent[]>([]);

  const refreshFeedback = useCallback(async () => {
    try {
      const res = await fetch("/api/events?type=behavior_feedback&limit=20");
      if (res.ok) setFeedback(await res.json());
    } catch {
      // Non-critical, read-only view - a failed fetch just leaves the
      // card showing its previous (or empty) state.
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshFeedback();
  }, [refresh, refreshFeedback]);

  const proposed = projects.filter((p) => p.status === "proposed");
  const active = projects.filter((p) => p.status === "active");

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Amy</h1>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-red-500">{error}</p>}
      {actionError && <p className="mb-3 text-xs text-red-500">{actionError}</p>}

      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="Proposed" count={proposed.length}>
          {!isLoading && proposed.length === 0 && <EmptyRow text="Nothing proposed right now." />}
          <ul className="space-y-2">
            {proposed.map((p) => (
              <ProposedRow key={p.id} project={p} onApprove={() => approve(p.id)} onReject={() => reject(p.id)} />
            ))}
          </ul>
        </Card>

        <Card title="Active" count={active.length}>
          {!isLoading && active.length === 0 && <EmptyRow text="No active projects." />}
          <ul className="space-y-2">
            {active.map((p) => (
              <ActiveRow key={p.id} project={p} onComplete={() => complete(p.id)} />
            ))}
          </ul>
        </Card>

        <Card title="Feedback" count={feedback.length}>
          {feedback.length === 0 && (
            <EmptyRow text="No behavior feedback captured yet - tell Amy when she keeps doing something, and it'll show up here." />
          )}
          <ul className="space-y-2">
            {feedback.map((e) => (
              <FeedbackRow key={e.id} event={e} />
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

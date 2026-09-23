"use client";

import { useCallback, useEffect, useState } from "react";
import { useProjects } from "@/hooks/useProjects";
import type { Project } from "@/lib/knowledge-engine-client";
import type { CodingTask } from "@/lib/coding-orchestrator-client";
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

// research vs coding badge colors just need to be visually distinct, same
// non-semantic-color convention as SessionList/EventLogPanel's origin badges.
function ActivityBadge({ activityType }: { activityType: string }) {
  const isCoding = activityType === "coding";
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
        isCoding
          ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
          : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
      }`}
    >
      {isCoding ? "coding" : "research"}
    </span>
  );
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
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{project.title}</p>
        <ActivityBadge activityType={project.activity_type} />
      </div>
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

// coding_tasks.status='proposed' means something different from
// projects.status='proposed' (Reviewer-approved/PR-ready vs
// awaiting-approval-to-start) - see docs/knowledge-engine.md. Only the
// project's own status drives this dashboard's Proposed/Active grouping;
// this label is purely about the underlying work's progress.
function activeStatusLabel(project: Project): string {
  if (project.activity_type === "coding") {
    if (project.coding_task_status === "proposed") return "ready to complete";
    if (project.coding_task_status === "needs_review_failed") return "coding failed";
    if (project.coding_task_status === "resource_limit_reached") return "resource limit reached";
    if (project.coding_task_status === "running") return "coding…";
    return "working…";
  }
  if (project.research_queue_status === "done") return "ready to complete";
  if (project.research_queue_status === "researching") return "researching…";
  if (project.research_queue_status === "pending") return "queued for research";
  if (project.research_queue_status === "failed") return "research failed";
  return "working…";
}

function ActiveRow({ project, onComplete }: { project: Project; onComplete: () => void }) {
  const ready =
    project.activity_type === "coding"
      ? project.coding_task_status === "proposed"
      : project.research_queue_status === "done";
  return (
    <li className="rounded border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{project.title}</p>
          <ActivityBadge activityType={project.activity_type} />
        </div>
        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {activeStatusLabel(project)}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        {project.activity_type === "research" && project.research_session_id && (
          <a
            href={`/research/${project.research_session_id}`}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            View research
          </a>
        )}
        {project.activity_type === "coding" && project.coding_task_pr_url && (
          <a
            href={project.coding_task_pr_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            View PR
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

// Every coding_tasks row, whether or not it's linked to a `projects` row -
// a code_task called directly mid-chat was never meant to be wrapped in a
// project and shows up here too.
function CodingTaskRow({ task }: { task: CodingTask }) {
  return (
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-gray-900 dark:text-gray-100">{task.task_description}</p>
        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {task.status}
        </span>
      </div>
      {task.pr_url && (
        <a
          href={task.pr_url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          View PR
        </a>
      )}
    </li>
  );
}

export function ProjectsDashboard() {
  const { projects, isLoading, error, actionError, refresh, approve, reject, complete } = useProjects();
  const [feedback, setFeedback] = useState<EventBusEvent[]>([]);
  const [codingTasks, setCodingTasks] = useState<CodingTask[]>([]);

  const refreshFeedback = useCallback(async () => {
    try {
      const res = await fetch("/api/events?type=behavior_feedback&limit=20");
      if (res.ok) setFeedback(await res.json());
    } catch {
      // Non-critical, read-only view - a failed fetch just leaves the
      // card showing its previous (or empty) state.
    }
  }, []);

  const refreshCodingTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/coding-tasks?limit=20");
      if (res.ok) {
        const data = await res.json();
        setCodingTasks(data.tasks ?? []);
      }
    } catch {
      // Non-critical, read-only view.
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshFeedback();
    refreshCodingTasks();
  }, [refresh, refreshFeedback, refreshCodingTasks]);

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

      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-2">
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

        <Card title="Coding Tasks" count={codingTasks.length}>
          {codingTasks.length === 0 && (
            <EmptyRow text="No coding tasks yet - ask Amy to build or fix something to see it here." />
          )}
          <ul className="space-y-2">
            {codingTasks.map((t) => (
              <CodingTaskRow key={t.id} task={t} />
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

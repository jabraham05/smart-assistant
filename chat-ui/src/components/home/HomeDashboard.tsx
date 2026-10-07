"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useHomeSummary } from "@/hooks/useHomeSummary";
import { useHomeActivity } from "@/hooks/useHomeActivity";
import { useProjects } from "@/hooks/useProjects";
import { ActivityFeedItem } from "@/components/activity/ActivityFeedItem";
import type { Goal, TaskContext, UpcomingEvent } from "@/types/chat";
import type { Project } from "@/lib/knowledge-engine-client";

function formatEventTime(event: UpcomingEvent): string {
  const iso = event.start?.dateTime ?? event.start?.date;
  if (!iso) return "";
  const date = new Date(iso);
  if (event.start?.date && !event.start?.dateTime) {
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Card({
  title,
  count,
  children,
  className = "",
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col rounded-xl border border-white/10 bg-zinc-900/40 backdrop-blur-sm ${className}`}>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
        <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[11px] text-zinc-500">{count}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="px-1 py-1 text-xs text-zinc-600">{text}</p>;
}

// Goals are the one thing in this dashboard Amy is expected to keep
// updated over time (see goal_manage's action='update') - this inline
// click-to-edit exists so the user can also correct/add to it directly,
// same pattern as TodoRow's objective edit, applied to both title and
// description independently.
function GoalRow({
  goal,
  onEdit,
}: {
  goal: Goal;
  onEdit: (fields: { title?: string; description?: string }) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [titleDraft, setTitleDraft] = useState(goal.title);
  const [descriptionDraft, setDescriptionDraft] = useState(goal.description ?? "");

  const commitTitle = () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft.trim() !== goal.title) onEdit({ title: titleDraft.trim() });
  };

  const commitDescription = () => {
    setEditingDescription(false);
    const trimmed = descriptionDraft.trim();
    if (trimmed !== (goal.description ?? "")) onEdit({ description: trimmed });
  };

  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      {editingTitle ? (
        <input
          autoFocus
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === "Enter" && commitTitle()}
          className="w-full rounded border border-indigo-500/40 bg-white/[0.04] px-1.5 py-0.5 text-sm text-zinc-100 outline-none"
        />
      ) : (
        <p onClick={() => setEditingTitle(true)} className="cursor-text text-sm text-zinc-100">
          {goal.title}
        </p>
      )}
      {editingDescription ? (
        <textarea
          autoFocus
          value={descriptionDraft}
          onChange={(e) => setDescriptionDraft(e.target.value)}
          onBlur={commitDescription}
          rows={2}
          className="mt-1 w-full rounded border border-indigo-500/40 bg-white/[0.04] px-1.5 py-0.5 text-xs text-zinc-300 outline-none"
        />
      ) : (
        <p onClick={() => setEditingDescription(true)} className="mt-0.5 cursor-text text-xs text-zinc-500">
          {goal.description || "Add a description…"}
        </p>
      )}
    </li>
  );
}

function TodoRow({
  task,
  onToggleDone,
  onEdit,
}: {
  task: TaskContext;
  onToggleDone: () => void;
  onEdit: (objective: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.objective);
  const done = task.status === "done";

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== task.objective) onEdit(draft.trim());
  };

  return (
    <li className="group rounded-lg border border-white/5 bg-white/[0.02] p-2.5 transition-colors hover:border-white/10">
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={done}
          onChange={onToggleDone}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-white/20 bg-white/5 accent-indigo-500"
          title={done ? "Mark not done" : "Mark done"}
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              className="w-full rounded border border-indigo-500/40 bg-white/[0.04] px-1.5 py-0.5 text-sm text-zinc-100 outline-none"
            />
          ) : (
            <p
              onClick={() => setEditing(true)}
              className={`cursor-text text-sm ${done ? "text-zinc-600 line-through" : "text-zinc-100"}`}
            >
              {task.objective}
            </p>
          )}
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
                task.source === "user" ? "bg-indigo-500/10 text-indigo-300" : "bg-white/5 text-zinc-500"
              }`}
            >
              {task.source === "user" ? "you" : "amy"}
            </span>
            <Link href={`/tasks/${task.id}`} className="shrink-0 text-[10px] text-indigo-400 hover:underline">
              Details
            </Link>
            {task.next_action && !done && <p className="text-xs text-zinc-500">Next: {task.next_action}</p>}
          </div>
        </div>
      </div>
    </li>
  );
}

function EventRow({ event }: { event: UpcomingEvent }) {
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <p className="text-sm text-zinc-100">{event.summary || "(untitled event)"}</p>
      <p className="mt-0.5 font-mono text-[11px] text-zinc-500">{formatEventTime(event)}</p>
    </li>
  );
}

// Pinned to the top of Activity - an actionable item, not just something
// that already happened, so it gets its own louder (amber) treatment and
// inline Approve/Reject rather than blending into ActivityFeedItem's
// plain informational rows.
function ApprovalRow({
  project,
  onApprove,
  onReject,
}: {
  project: Project;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <li className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide text-amber-300">
          needs approval
        </span>
      </div>
      <p className="mt-1 text-sm font-medium text-zinc-100">{project.title}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{project.rationale}</p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={onApprove}
          className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
        >
          Approve
        </button>
        <button
          onClick={onReject}
          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/5"
        >
          Reject
        </button>
      </div>
    </li>
  );
}

export function HomeDashboard() {
  const { summary, isLoading, error, refresh } = useHomeSummary();
  const activity = useHomeActivity();
  const { projects, refresh: refreshProjects, approve, reject } = useProjects();
  const [newTodo, setNewTodo] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    refresh();
    activity.refresh();
    refreshProjects();
    // Only ever run once on mount - each refresh callback is a stable
    // useCallback with no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addTodo = async () => {
    const objective = newTodo.trim();
    if (!objective) return;
    setIsAdding(true);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective }),
      });
      if (res.ok) {
        setNewTodo("");
        refresh();
      }
    } finally {
      setIsAdding(false);
    }
  };

  const patchTodo = async (id: number, fields: { objective?: string; status?: string }) => {
    await fetch("/api/todos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...fields }),
    });
    refresh();
  };

  const patchGoal = async (id: number, fields: { title?: string; description?: string }) => {
    await fetch("/api/goals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...fields }),
    });
    refresh();
  };

  const proposedProjects = projects.filter((p) => p.status === "proposed");
  const openTodos = (summary?.openTasks ?? []).filter((t) => t.status !== "done");

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Home</h1>
          <p className="mt-0.5 text-xs text-zinc-500">What&apos;s on your plate right now.</p>
        </div>
        <button
          onClick={() => {
            refresh();
            activity.refresh();
            refreshProjects();
          }}
          disabled={isLoading}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-40"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-rose-400">{error}</p>}

      {/* Top row and Activity split the remaining screen 1:2 (not fixed
          rem heights) so the top row scales with the window instead of
          being a small fixed strip next to an oversized Activity feed. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid min-h-0 flex-[1] grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="Goals" count={summary?.goals.length ?? 0} className="h-full">
          {!summary && !error && <EmptyRow text="Loading…" />}
          {summary && summary.goals.length === 0 && <EmptyRow text="No active goals." />}
          <ul className="space-y-1.5">
            {summary?.goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} onEdit={(fields) => patchGoal(goal.id, fields)} />
            ))}
          </ul>
        </Card>

        <Card title="Todos" count={openTodos.length} className="h-full">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addTodo();
            }}
            className="mb-2 flex gap-1.5"
          >
            <input
              value={newTodo}
              onChange={(e) => setNewTodo(e.target.value)}
              placeholder="Add a todo…"
              disabled={isAdding}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30"
            />
            <button
              type="submit"
              disabled={isAdding || !newTodo.trim()}
              className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
            >
              Add
            </button>
          </form>
          {!summary && !error && <EmptyRow text="Loading…" />}
          {summary && openTodos.length === 0 && <EmptyRow text="Nothing on your list." />}
          <ul className="space-y-1.5">
            {openTodos.map((task) => (
              <TodoRow
                key={task.id}
                task={task}
                onToggleDone={() => patchTodo(task.id, { status: "done" })}
                onEdit={(objective) => patchTodo(task.id, { objective })}
              />
            ))}
          </ul>
        </Card>

        <Card title="Upcoming Events" count={summary?.upcomingEvents.length ?? 0} className="h-full">
          {!summary && !error && <EmptyRow text="Loading…" />}
          {summary && !summary.calendarConfigured && <EmptyRow text="Calendar isn't configured." />}
          {summary && summary.calendarConfigured && summary.upcomingEvents.length === 0 && (
            <EmptyRow text="Nothing on the calendar this week." />
          )}
          <ul className="space-y-1.5">
            {summary?.upcomingEvents.map((event) => <EventRow key={event.id} event={event} />)}
          </ul>
        </Card>
      </div>

      {/* Activity - full width, gets the other 2/3. Approvals are pinned
          to the top since they need a decision, not just a read. */}
      <div className="min-h-0 flex-[2]">
        <Card title="Activity" count={proposedProjects.length + activity.items.length} className="h-full">
          {proposedProjects.length === 0 && !activity.isLoading && activity.items.length === 0 && (
            <EmptyRow text="Nothing recent." />
          )}
          {activity.isLoading && activity.items.length === 0 && proposedProjects.length === 0 && (
            <EmptyRow text="Loading…" />
          )}
          <ul className="space-y-1.5">
            {proposedProjects.map((p) => (
              <ApprovalRow
                key={`approval-${p.id}`}
                project={p}
                onApprove={() => approve(p.id).then(refreshProjects)}
                onReject={() => reject(p.id).then(refreshProjects)}
              />
            ))}
            {activity.items.map((item) => (
              <ActivityFeedItem key={item.id} label={item.category} summary={item.summary} occurredAt={item.occurredAt} />
            ))}
          </ul>
        </Card>
      </div>
      </div>
    </div>
  );
}

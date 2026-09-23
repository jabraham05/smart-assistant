"use client";

import { useEffect, useState } from "react";
import { useHomeSummary } from "@/hooks/useHomeSummary";
import { useEvents } from "@/hooks/useEvents";
import { useProjects } from "@/hooks/useProjects";
import type { Goal, TaskContext, UpcomingEvent } from "@/types/chat";

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
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
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

function GoalRow({ goal }: { goal: Goal }) {
  return (
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <p className="text-sm text-gray-900 dark:text-gray-100">{goal.title}</p>
      {goal.description && (
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{goal.description}</p>
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
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={done}
          onChange={onToggleDone}
          className="mt-0.5"
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
              className="w-full rounded border border-gray-300 bg-transparent px-1 py-0.5 text-sm dark:border-gray-600"
            />
          ) : (
            <p
              onClick={() => setEditing(true)}
              className={`cursor-text text-sm ${done ? "text-gray-400 line-through" : "text-gray-900 dark:text-gray-100"}`}
            >
              {task.objective}
            </p>
          )}
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {task.source === "user" ? "you" : "amy"}
            </span>
            {task.next_action && !done && (
              <p className="text-xs text-gray-500 dark:text-gray-400">Next: {task.next_action}</p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function EventRow({ event }: { event: UpcomingEvent }) {
  return (
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <p className="text-sm text-gray-900 dark:text-gray-100">{event.summary || "(untitled event)"}</p>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{formatEventTime(event)}</p>
    </li>
  );
}

function ActivityRow({ event }: { event: { id: number; source: string; type: string; occurred_at: string } }) {
  return (
    <li className="rounded border border-gray-200 p-2 text-xs dark:border-gray-700">
      <div className="flex items-center justify-between gap-2">
        <span className="text-gray-700 dark:text-gray-300">{event.type.replace(/_/g, " ")}</span>
        <span className="shrink-0 text-[10px] text-gray-400">
          {new Date(event.occurred_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </span>
      </div>
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{event.source}</span>
    </li>
  );
}

export function HomeDashboard() {
  const { summary, isLoading, error, refresh } = useHomeSummary();
  const activity = useEvents();
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

  const proposedProjects = projects.filter((p) => p.status === "proposed");
  const openTodos = (summary?.openTasks ?? []).filter((t) => t.status !== "done");

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Home</h1>
        <button
          onClick={() => {
            refresh();
            activity.refresh();
            refreshProjects();
          }}
          disabled={isLoading}
          className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-red-500">{error}</p>}

      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="Todos" count={openTodos.length}>
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
              className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-2 py-1 text-xs dark:border-gray-600"
            />
            <button
              type="submit"
              disabled={isAdding || !newTodo.trim()}
              className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
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

        <Card title="Upcoming Events" count={summary?.upcomingEvents.length ?? 0}>
          {!summary && !error && <EmptyRow text="Loading…" />}
          {summary && !summary.calendarConfigured && (
            <EmptyRow text="Calendar isn't configured." />
          )}
          {summary && summary.calendarConfigured && summary.upcomingEvents.length === 0 && (
            <EmptyRow text="Nothing on the calendar this week." />
          )}
          <ul className="space-y-1.5">
            {summary?.upcomingEvents.map((event) => <EventRow key={event.id} event={event} />)}
          </ul>
        </Card>

        <Card title="Recent Activity" count={activity.events.length}>
          {activity.isLoading && activity.events.length === 0 && <EmptyRow text="Loading…" />}
          {!activity.isLoading && activity.events.length === 0 && <EmptyRow text="Nothing recent." />}
          <ul className="space-y-1.5">
            {activity.events.slice(0, 20).map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </ul>
        </Card>

        {proposedProjects.length > 0 && (
          <Card title="Needing Approval" count={proposedProjects.length}>
            <ul className="space-y-2">
              {proposedProjects.map((p) => (
                <li key={p.id} className="rounded border border-gray-200 p-2 dark:border-gray-700">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.title}</p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{p.rationale}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => approve(p.id).then(refreshProjects)}
                      className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => reject(p.id).then(refreshProjects)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Goals" count={summary?.goals.length ?? 0}>
          {!summary && !error && <EmptyRow text="Loading…" />}
          {summary && summary.goals.length === 0 && <EmptyRow text="No active goals." />}
          <ul className="space-y-1.5">
            {summary?.goals.map((goal) => <GoalRow key={goal.id} goal={goal} />)}
          </ul>
        </Card>
      </div>
    </div>
  );
}

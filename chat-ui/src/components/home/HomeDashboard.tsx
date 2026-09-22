"use client";

import { useEffect } from "react";
import { useHomeSummary } from "@/hooks/useHomeSummary";
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

function TaskRow({ task }: { task: TaskContext }) {
  return (
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-gray-900 dark:text-gray-100">{task.objective}</p>
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {task.status === "waiting_for_user" ? "waiting" : task.status}
        </span>
      </div>
      {task.next_action && (
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Next: {task.next_action}</p>
      )}
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

export function HomeDashboard() {
  const { summary, isLoading, error, refresh } = useHomeSummary();

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Home</h1>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-red-500">{error}</p>}

      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="Goals" count={summary?.goals.length ?? 0}>
          {!summary && !error && <EmptyRow text="Loading…" />}
          {summary && summary.goals.length === 0 && <EmptyRow text="No active goals." />}
          <ul className="space-y-1.5">
            {summary?.goals.map((goal) => <GoalRow key={goal.id} goal={goal} />)}
          </ul>
        </Card>

        <Card title="Open Tasks" count={summary?.openTasks.length ?? 0}>
          {!summary && !error && <EmptyRow text="Loading…" />}
          {summary && summary.openTasks.length === 0 && <EmptyRow text="No open tasks." />}
          <ul className="space-y-1.5">
            {summary?.openTasks.map((task) => <TaskRow key={task.id} task={task} />)}
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
      </div>
    </div>
  );
}

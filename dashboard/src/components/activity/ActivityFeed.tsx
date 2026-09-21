"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface ActivityItem {
  kind: "event" | "execution";
  timestamp: string;
  summary: string;
  detail: Record<string, unknown>;
  executionId?: number;
}

interface Goal {
  id: number;
  title: string;
  status: string;
}

interface TaskContext {
  id: number;
  objective: string;
  status: string;
}

const POLL_INTERVAL_MS = 5000;

function itemKey(item: ActivityItem): string {
  return `${item.kind}-${item.executionId ?? item.detail.id}-${item.timestamp}`;
}

export function ActivityFeed() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [activeGoals, setActiveGoals] = useState<Goal[] | { error: string } | null>(null);
  const [openTaskContexts, setOpenTaskContexts] = useState<TaskContext[] | { error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const seenKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const url = cursorRef.current ? `/api/activity?since=${encodeURIComponent(cursorRef.current)}` : "/api/activity";
        const res = await fetch(url);
        const data = await res.json();
        if (cancelled) return;

        cursorRef.current = data.cursor;
        setActiveGoals(data.activeGoals);
        setOpenTaskContexts(data.openTaskContexts);

        const fresh: ActivityItem[] = data.items.filter((i: ActivityItem) => !seenKeys.current.has(itemKey(i)));
        fresh.forEach((i) => seenKeys.current.add(itemKey(i)));
        if (fresh.length > 0) {
          setItems((prev) => [...fresh, ...prev].slice(0, 200));
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="grid grid-cols-[1fr_260px] gap-6">
      <div>
        <h2 className="mb-2 text-sm font-medium text-black/60 dark:text-white/60">Recent activity (polling every 5s)</h2>
        {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex flex-col gap-1.5">
          {items.length === 0 && <p className="text-sm text-black/40 dark:text-white/40">No activity in the last 5 minutes.</p>}
          {items.map((item) => (
            <div key={itemKey(item)} className="flex items-center gap-2 rounded-md border border-black/10 px-2.5 py-1.5 text-sm dark:border-white/10">
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  item.kind === "execution" ? "bg-blue-500/10 text-blue-700 dark:text-blue-400" : "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60"
                }`}
              >
                {item.kind}
              </span>
              {item.executionId ? (
                <Link href={`/workflows/executions/${item.executionId}`} className="text-blue-600 underline dark:text-blue-400">
                  {item.summary}
                </Link>
              ) : (
                <span>{item.summary}</span>
              )}
              <span className="ml-auto tabular-nums text-xs text-black/40 dark:text-white/40">
                {new Date(item.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <h2 className="mb-2 text-sm font-medium text-black/60 dark:text-white/60">Active goals</h2>
          {activeGoals && "error" in activeGoals ? (
            <p className="text-xs text-red-600 dark:text-red-400">{activeGoals.error}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {activeGoals?.map((g) => <li key={g.id}>{g.title}</li>)}
              {activeGoals?.length === 0 && <li className="text-black/40 dark:text-white/40">None</li>}
            </ul>
          )}
        </div>
        <div>
          <h2 className="mb-2 text-sm font-medium text-black/60 dark:text-white/60">Open task contexts</h2>
          {openTaskContexts && "error" in openTaskContexts ? (
            <p className="text-xs text-red-600 dark:text-red-400">{openTaskContexts.error}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {openTaskContexts?.map((t) => <li key={t.id}>{t.objective}</li>)}
              {openTaskContexts?.length === 0 && <li className="text-black/40 dark:text-white/40">None</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

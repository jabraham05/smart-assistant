"use client";

import { useEffect, useMemo, useState } from "react";
import type { EventBusEvent } from "@/types/chat";

interface Entity {
  id: string;
  type: string;
  name: string;
  created_at: string;
}

interface TimelineItem {
  key: string;
  timestamp: string;
  label: string;
  kind: "event" | "entity";
}

function dayKey(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function TimelineView() {
  const [events, setEvents] = useState<EventBusEvent[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      // No originSessionId - the unscoped firehose across every source,
      // not one session's slice (see chat-ui/src/app/api/events/route.ts).
      fetch("/api/events?limit=100").then((res) => (res.ok ? res.json() : Promise.reject())),
      fetch("/api/entities").then((res) => (res.ok ? res.json() : Promise.reject())),
    ])
      .then(([eventsData, entitiesData]) => {
        setEvents(Array.isArray(eventsData) ? eventsData : []);
        setEntities(entitiesData.entities ?? []);
      })
      .catch(() => setError("Couldn't reach event-bus/knowledge-engine."))
      .finally(() => setIsLoading(false));
  }, []);

  const items = useMemo<TimelineItem[]>(() => {
    const eventItems: TimelineItem[] = events.map((e) => ({
      key: `event-${e.id}`,
      timestamp: e.occurred_at,
      label: `${e.source} / ${e.type}`,
      kind: "event",
    }));
    const entityItems: TimelineItem[] = entities.map((e) => ({
      key: `entity-${e.id}`,
      timestamp: e.created_at,
      label: `${e.type}: ${e.name}`,
      kind: "entity",
    }));
    return [...eventItems, ...entityItems].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [events, entities]);

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">
        Everything that happened, across every source - event-bus&apos;s activity log merged with knowledge-engine&apos;s
        entities, sorted chronologically. Not every source is wired into this yet (coding-task phase logs aren&apos;t
        published to event-bus), so treat this as a growing view, not the full picture.
      </p>
      {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!isLoading && !error && items.length === 0 && <p className="text-xs text-zinc-600">Nothing recorded yet.</p>}
      <ul className="space-y-3">
        {items.map((item, i) => {
          const showDayHeader = i === 0 || dayKey(items[i - 1].timestamp) !== dayKey(item.timestamp);
          return (
            <li key={item.key}>
              {showDayHeader && (
                <p className="mb-1.5 mt-4 font-mono text-[10px] uppercase tracking-wide text-zinc-600 first:mt-0">
                  {dayKey(item.timestamp)}
                </p>
              )}
              <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2">
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
                    item.kind === "entity" ? "bg-indigo-500/10 text-indigo-300" : "bg-white/5 text-zinc-500"
                  }`}
                >
                  {item.kind}
                </span>
                <p className="min-w-0 flex-1 truncate text-xs text-zinc-300">{item.label}</p>
                <span className="shrink-0 text-[10px] text-zinc-600">
                  {new Date(item.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

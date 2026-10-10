"use client";

import { useEffect, useState } from "react";
import type { GrowthHistoryEntry } from "@/lib/growth-client";
import { Card, CategoryBadge, EmptyRow, ErrorRow, formatDate } from "./shared";

const EVENT_LABELS: Record<string, string> = {
  observed: "Observed",
  scored: "Scored",
  proposed: "Proposed",
  approved: "Approved",
  rejected: "Rejected",
  dormant: "Deferred",
  learning_plan_created: "Learning plan started",
  consolidated: "Consolidated",
  persona_promoted: "Persona promoted",
  persona_dismissed: "Persona proposal dismissed",
};

function detailSummary(entry: GrowthHistoryEntry): string | null {
  const d = entry.detail;
  if (typeof d?.destination === "string") return `→ ${d.destination}`;
  if (typeof d?.summary === "string") return d.summary;
  if (typeof d?.notes === "string") return d.notes;
  if (typeof d?.reason === "string") return d.reason;
  if (typeof d?.source === "string") return `signal: ${d.source}`;
  return null;
}

export function GrowthHistory() {
  const [history, setHistory] = useState<GrowthHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    fetch("/api/growth/history?limit=200")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setHistory(data.history ?? []))
      .catch(() => setError("Couldn't reach agent-service."));
  }, []);

  if (error) return <ErrorRow text={error} />;
  if (!history) return <EmptyRow text="Loading…" />;

  return (
    <Card title="Growth history" count={history.length}>
      <p className="mb-2 px-1 text-xs text-zinc-500">
        A durable, append-only record of everything Growth has observed, proposed, decided, and consolidated.
      </p>
      {history.length === 0 && <EmptyRow text="Nothing recorded yet." />}
      <ul className="space-y-1">
        {history.map((h) => (
          <li key={h.id} className="flex items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs">
            <span className="shrink-0 font-mono text-[10px] text-zinc-600">{formatDate(h.created_at)}</span>
            <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-400">
              {EVENT_LABELS[h.event_type] ?? h.event_type}
            </span>
            {h.proposal_category && <CategoryBadge category={h.proposal_category} />}
            <span className="flex-1 truncate text-zinc-300">
              {h.opportunity_title ?? (h.proposal_id ? `proposal #${h.proposal_id}` : "")}
            </span>
            {detailSummary(h) && <span className="shrink-0 text-zinc-600">{detailSummary(h)}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

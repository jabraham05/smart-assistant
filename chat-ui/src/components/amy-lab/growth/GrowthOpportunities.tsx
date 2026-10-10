"use client";

import { useCallback, useEffect, useState } from "react";
import type { GrowthOpportunity } from "@/lib/growth-client";
import { ActionButton, Card, CategoryBadge, EmptyRow, ErrorRow, ScoreTag, StatusBadge, formatDate } from "./shared";

const STATUS_FILTERS = ["all", "observed", "scored", "proposed", "rejected", "dormant"] as const;
type SortKey = "score" | "recency" | "frequency";

function OpportunityRow({
  opportunity,
  onDismiss,
  onDefer,
  onPromote,
}: {
  opportunity: GrowthOpportunity;
  onDismiss: () => void;
  onDefer: () => void;
  onPromote: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const actionable = !["proposed", "rejected", "dormant"].includes(opportunity.status);

  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <button onClick={() => setExpanded((v) => !v)} className="w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 truncate text-sm text-zinc-100">
            <CategoryBadge category={opportunity.category} />
            {opportunity.title}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <ScoreTag score={opportunity.score} />
            <StatusBadge status={opportunity.status} />
          </div>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          seen {opportunity.frequency}× · last {formatDate(opportunity.last_observed_at)}
        </p>
      </button>
      {expanded && (
        <div className="mt-2 border-t border-white/5 pt-2">
          <p className="text-xs text-zinc-400">{opportunity.description}</p>
          <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-600">
            <span>usefulness: {opportunity.usefulness ?? "—"}</span>
            <span>confidence: {opportunity.confidence ?? "—"}</span>
            <span>reuse: {opportunity.reuse_potential ?? "—"}</span>
            <span>improvement: {opportunity.improvement_value ?? "—"}</span>
            <span>effort: {opportunity.effort ?? "—"}</span>
            <span>interruption: {opportunity.interruption_cost ?? "—"}</span>
          </div>
          {actionable && (
            <div className="mt-2 flex gap-2">
              <ActionButton label="Promote to proposal" tone="primary" onClick={onPromote} />
              <ActionButton label="Defer" onClick={onDefer} />
              <ActionButton label="Dismiss" tone="danger" onClick={onDismiss} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function GrowthOpportunities() {
  const [opportunities, setOpportunities] = useState<GrowthOpportunity[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [sortKey, setSortKey] = useState<SortKey>("score");

  const refresh = useCallback(() => {
    const url = statusFilter === "all" ? "/api/growth/opportunities" : `/api/growth/opportunities?status=${statusFilter}`;
    fetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setOpportunities(data.opportunities ?? []))
      .catch(() => setError("Couldn't reach agent-service."));
  }, [statusFilter]);

  useEffect(() => refresh(), [refresh]);

  const runAction = async (path: string) => {
    setActionError(undefined);
    try {
      const res = await fetch(path, { method: "POST" });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        setActionError(body.error ?? "Action failed.");
        return;
      }
      refresh();
    } catch {
      setActionError("Action failed - couldn't reach agent-service.");
    }
  };

  const sorted = [...(opportunities ?? [])].sort((a, b) => {
    if (sortKey === "score") return (b.score ?? 0) - (a.score ?? 0);
    if (sortKey === "frequency") return b.frequency - a.frequency;
    return new Date(b.last_observed_at).getTime() - new Date(a.last_observed_at).getTime();
  });

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as (typeof STATUS_FILTERS)[number])}
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500/50"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s}
            </option>
          ))}
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500/50"
        >
          <option value="score">Sort by score</option>
          <option value="recency">Sort by most recent</option>
          <option value="frequency">Sort by recurrence</option>
        </select>
      </div>

      {actionError && <ErrorRow text={actionError} />}
      {error && <ErrorRow text={error} />}
      {!error && opportunities === null && <EmptyRow text="Loading…" />}
      {!error && opportunities !== null && sorted.length === 0 && <EmptyRow text="Nothing here." />}

      <Card title="Opportunities" count={sorted.length}>
        <ul className="space-y-1.5">
          {sorted.map((o) => (
            <OpportunityRow
              key={o.id}
              opportunity={o}
              onDismiss={() => runAction(`/api/growth/opportunities/${o.id}/dismiss`)}
              onDefer={() => runAction(`/api/growth/opportunities/${o.id}/defer`)}
              onPromote={() => runAction(`/api/growth/opportunities/${o.id}/promote`)}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

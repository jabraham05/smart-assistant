"use client";

import { useEffect, useMemo, useState } from "react";
import type { Entity, EntityDetail } from "@/lib/knowledge-engine-client";
import { MarkdownContent } from "@/components/chat/MarkdownContent";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="shrink-0 rounded-full bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-indigo-300">
      {type}
    </span>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const variant =
    status === "done"
      ? "bg-emerald-500/10 text-emerald-300"
      : status === "rejected"
        ? "bg-rose-500/10 text-rose-300"
        : "bg-white/5 text-zinc-500";
  return <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${variant}`}>{status}</span>;
}

// The "proof Amy is growing" framing this tab exists for - a running count
// of durable things she's accumulated, not just a raw list. Computed
// client-side from the already-fetched entities list rather than a
// dedicated backend aggregation endpoint, since the list is small enough
// (and will stay small enough through at least the next phase of this
// rework) not to need one yet.
function GrowthStats({ entities }: { entities: Entity[] }) {
  const byType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return [...counts.entries()];
  }, [entities]);

  const newThisWeek = useMemo(
    () => entities.filter((e) => Date.now() - new Date(e.created_at).getTime() < WEEK_MS).length,
    [entities],
  );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/40 p-3">
      <div className="pr-3">
        <p className="font-mono text-2xl font-semibold text-zinc-100">{entities.length}</p>
        <p className="text-[10px] uppercase tracking-wide text-zinc-600">durable things total</p>
      </div>
      <div className="h-8 w-px bg-white/10" />
      {byType.map(([type, count]) => (
        <span key={type} className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-zinc-400">
          {count} {type}
        </span>
      ))}
      {newThisWeek > 0 && (
        <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">+{newThisWeek} this week</span>
      )}
    </div>
  );
}

function EntityRow({ entity, isSelected, onSelect }: { entity: Entity; isSelected: boolean; onSelect: () => void }) {
  return (
    <li
      onClick={onSelect}
      className={`cursor-pointer rounded-lg border p-2.5 transition-colors ${
        isSelected ? "border-indigo-500/40 bg-indigo-500/[0.06]" : "border-white/5 bg-white/[0.02] hover:border-white/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-zinc-100">{entity.name}</p>
        <div className="flex shrink-0 gap-1">
          <TypeBadge type={entity.type} />
          <StatusBadge status={entity.status} />
        </div>
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">{new Date(entity.created_at).toLocaleString()}</p>
    </li>
  );
}

function EntityDetailPane({
  detail,
  onOpenSession,
  onViewInGraph,
}: {
  detail: EntityDetail;
  onOpenSession?: (sessionId: string) => void;
  onViewInGraph?: (graphitiId: string) => void;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-100">{detail.name}</h3>
        <div className="flex shrink-0 gap-1">
          <TypeBadge type={detail.type} />
          <StatusBadge status={detail.status} />
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        <dt className="text-zinc-600">Created</dt>
        <dd>{new Date(detail.created_at).toLocaleString()}</dd>
        {detail.source_table && (
          <>
            <dt className="text-zinc-600">Source</dt>
            <dd>
              {detail.source_table}
              {detail.source_id ? ` #${detail.source_id}` : ""}
            </dd>
          </>
        )}
        {detail.graphiti_id && (
          <>
            <dt className="text-zinc-600">Graphiti episode</dt>
            <dd className="truncate font-mono">{detail.graphiti_id}</dd>
          </>
        )}
      </dl>
      {/* Real provenance drill-through, not just inert display - "why does
          Amy know this" for the two cases with an actual place to go: the
          chat session that produced a classifier-extracted entity, or the
          Graphiti node a project consolidation wrote. source_table==="projects"
          stays text-only above - that case is self-referential (the project
          entity IS what the Projects tab already shows). */}
      {((detail.source_table === "chat" && detail.source_id && onOpenSession) || (detail.graphiti_id && onViewInGraph)) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {detail.source_table === "chat" && detail.source_id && onOpenSession && (
            <button
              onClick={() => onOpenSession(detail.source_id!)}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-indigo-300 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/[0.06]"
            >
              Open this conversation
            </button>
          )}
          {detail.graphiti_id && onViewInGraph && (
            <button
              onClick={() => onViewInGraph(detail.graphiti_id!)}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-indigo-300 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/[0.06]"
            >
              View in Knowledge Graph
            </button>
          )}
        </div>
      )}
      <div className="mt-3 border-t border-white/10 pt-3">
        {detail.content ? (
          <MarkdownContent content={detail.content} isUser={false} />
        ) : (
          <p className="text-xs text-zinc-600">No backing file content for this entity.</p>
        )}
      </div>
    </div>
  );
}

export function EntitiesView({
  typeFilter,
  description,
  emptyMessage,
  onOpenSession,
  onViewInGraph,
}: {
  // Filters the already-fetched full list client-side rather than adding
  // multi-type plumbing to getEntities (which only takes one type) - this
  // view is reused across Projects/Memories/Amy-Learnings sub-tabs now,
  // each wanting a different subset of the same underlying list.
  typeFilter?: string[];
  description?: string;
  emptyMessage?: string;
  onOpenSession?: (sessionId: string) => void;
  onViewInGraph?: (graphitiId: string) => void;
}) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [detailError, setDetailError] = useState<string | undefined>();

  useEffect(() => {
    setIsLoading(true);
    fetch("/api/entities")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setEntities(data.entities ?? []))
      .catch(() => setError("Couldn't reach knowledge-engine."))
      .finally(() => setIsLoading(false));
  }, []);

  const visibleEntities = useMemo(
    () => (typeFilter ? entities.filter((e) => typeFilter.includes(e.type)) : entities),
    [entities, typeFilter],
  );

  useEffect(() => {
    if (selectedId === undefined) return;
    setDetail(null);
    setDetailError(undefined);
    fetch(`/api/entities/${selectedId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setDetail(data))
      .catch(() => setDetailError("Couldn't load this entity's details."));
  }, [selectedId]);

  return (
    <div className="flex h-full flex-col">
      <p className="mb-3 text-xs text-zinc-500">
        {description ??
          "Durable things Amy has produced and had approved - projects, and whatever later phases add (learnings, preferences, decisions). Each one is backed by a real file under knowledge-engine's knowledge store, not just a database row."}
      </p>
      <GrowthStats entities={visibleEntities} />
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-80 shrink-0 overflow-y-auto">
          {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
          {error && <p className="text-xs text-rose-400">{error}</p>}
          {!isLoading && !error && visibleEntities.length === 0 && (
            <p className="text-xs text-zinc-600">
              {emptyMessage ?? "Nothing yet - entities are created when a proposed project gets approved and completed."}
            </p>
          )}
          <ul className="space-y-1.5">
            {visibleEntities.map((entity) => (
              <EntityRow
                key={entity.id}
                entity={entity}
                isSelected={entity.id === selectedId}
                onSelect={() => setSelectedId(entity.id)}
              />
            ))}
          </ul>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/40 p-4">
          {selectedId === undefined && <p className="text-xs text-zinc-600">Select an item to see its full write-up.</p>}
          {selectedId !== undefined && detailError && <p className="text-xs text-rose-400">{detailError}</p>}
          {selectedId !== undefined && !detailError && detail === null && <p className="text-xs text-zinc-600">Loading…</p>}
          {selectedId !== undefined && !detailError && detail !== null && (
            <EntityDetailPane detail={detail} onOpenSession={onOpenSession} onViewInGraph={onViewInGraph} />
          )}
        </div>
      </div>
    </div>
  );
}

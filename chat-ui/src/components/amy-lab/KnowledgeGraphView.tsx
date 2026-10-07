"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { KnowledgeGraphEdge, KnowledgeGraphNode } from "@/lib/graphiti-client";

// react-force-graph-2d touches `window` at module scope - must never be
// pulled into the server bundle or an SSR render.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

interface GraphData {
  nodes: KnowledgeGraphNode[];
  links: KnowledgeGraphEdge[];
}

export function KnowledgeGraphView({ initialSelectedId }: { initialSelectedId?: string } = {}) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<KnowledgeGraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 500 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/knowledge-graph");
        if (!res.ok) {
          if (!cancelled) setError("Couldn't reach graphiti-service.");
          return;
        }
        const graph = await res.json();
        if (!cancelled) setData({ nodes: graph.nodes, links: graph.edges });
      } catch {
        if (!cancelled) setError("Couldn't reach graphiti-service.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Provenance drill-through from an entity's graphiti_id (see EntitiesView's
  // "View in Knowledge Graph" button) - additive only, no effect when
  // initialSelectedId is absent (the normal click-to-select flow below is
  // unchanged).
  useEffect(() => {
    if (!initialSelectedId || !data) return;
    const node = data.nodes.find((n) => n.id === initialSelectedId);
    if (node) setSelected(node);
  }, [data, initialSelectedId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const connectedEdges = selected ? (data?.links.filter((e) => e.source === selected.id || e.target === selected.id) ?? []) : [];

  return (
    <div className="flex h-full gap-4">
      <div ref={containerRef} className="relative min-w-0 flex-1 rounded-xl border border-white/10 bg-zinc-900/40">
        {error && <p className="p-4 text-xs text-rose-400">{error}</p>}
        {!error && !data && <p className="p-4 text-xs text-zinc-600">Loading…</p>}
        {!error && data && data.nodes.length === 0 && (
          <p className="p-4 text-xs text-zinc-600">
            Nothing in the knowledge graph yet - it fills in as Amy approves projects, creates goals, and
            consolidates work.
          </p>
        )}
        {!error && data && data.nodes.length > 0 && (
          <ForceGraph2D
            graphData={data}
            width={size.width}
            height={size.height}
            nodeId="id"
            nodeLabel="label"
            nodeVal={2}
            nodeColor={(n: object) => (selected?.id === (n as KnowledgeGraphNode).id ? "#818cf8" : "#a1a1aa")}
            linkLabel="fact"
            linkColor={() => "rgba(161,161,170,0.35)"}
            linkDirectionalArrowLength={3}
            onNodeClick={(n: object) => setSelected(n as KnowledgeGraphNode)}
            backgroundColor="rgba(0,0,0,0)"
          />
        )}
      </div>

      {selected && (
        <div className="w-72 shrink-0 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/40 p-3">
          <p className="text-sm font-medium text-zinc-100">{selected.label}</p>
          {selected.summary && <p className="mt-1 text-xs text-zinc-400">{selected.summary}</p>}
          {connectedEdges.length > 0 && (
            <div className="mt-3">
              <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">Connections</p>
              <ul className="mt-1.5 space-y-1.5">
                {connectedEdges.map((e, i) => (
                  <li key={i} className="rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs text-zinc-400">
                    <span className="font-mono text-[9px] uppercase tracking-wide text-indigo-300">{e.type}</span>
                    {e.fact && <p className="mt-0.5">{e.fact}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import type { DocEntry } from "@/lib/docs-source";
import type { Project } from "@/lib/knowledge-engine-client";
import type { CodingTask } from "@/lib/coding-orchestrator-client";
import type { KnowledgeSearchResult } from "@/lib/knowledge-engine-client";

type Tab = "research" | "projects" | "learning";

function StatusBadge({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-500">
      {label}
    </span>
  );
}

// Mirrors the status derivation the old ops-dashboard's ProjectsDashboard
// used - coding_task_status/research_queue_status mean something
// different from the project's own `status` (proposed/active/complete),
// see docs/knowledge-engine.md.
function activityStatusLabel(project: Project): string {
  if (project.activity_type === "coding") {
    if (project.coding_task_status === "proposed") return "ready to complete";
    if (project.coding_task_status === "needs_review_failed") return "coding failed";
    if (project.coding_task_status === "resource_limit_reached") return "resource limit reached";
    if (project.coding_task_status === "running") return "coding…";
    return project.status;
  }
  if (project.research_queue_status === "done") return "ready to complete";
  if (project.research_queue_status === "researching") return "researching…";
  if (project.research_queue_status === "pending") return "queued for research";
  if (project.research_queue_status === "failed") return "research failed";
  return project.status;
}

function ProjectRow({ project }: { project: Project }) {
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-4 transition-colors hover:border-white/20">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-zinc-100">{project.title}</p>
        <StatusBadge label={activityStatusLabel(project)} />
      </div>
      <p className="mt-1 text-xs text-zinc-500">{project.rationale}</p>
      <div className="mt-2 flex items-center gap-3">
        {project.activity_type === "research" && project.research_session_id && (
          <a href={`/research/${project.research_session_id}`} className="text-xs text-indigo-400 hover:text-indigo-300">
            View write-up
          </a>
        )}
        {project.activity_type === "coding" && project.coding_task_pr_url && (
          <a
            href={project.coding_task_pr_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300"
          >
            View PR
          </a>
        )}
      </div>
    </li>
  );
}

function CodingTaskRow({ task }: { task: CodingTask }) {
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-zinc-100">{task.task_description}</p>
        <StatusBadge label={task.status} />
      </div>
      {task.pr_url && (
        <a href={task.pr_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-indigo-400 hover:text-indigo-300">
          View PR
        </a>
      )}
    </li>
  );
}

function SearchBox() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const search = async () => {
    if (!query.trim()) return;
    setIsSearching(true);
    setError(undefined);
    try {
      const res = await fetch("/api/knowledge-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK: 10 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "search failed");
        return;
      }
      setResults(data.results);
    } catch {
      setError("Couldn't reach knowledge-engine.");
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="mb-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
        className="flex gap-1.5"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search everything Amy knows…"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30"
        />
        <button
          type="submit"
          disabled={isSearching || !query.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
        >
          {isSearching ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {results && (
        <ul className="mt-3 space-y-2">
          {results.length === 0 && <p className="text-xs text-zinc-600">No results.</p>}
          {results.map((r, i) => (
            <li key={i} className="rounded-xl border border-white/10 bg-zinc-900/40 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-zinc-200">{r.documentTitle}</span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-600">{r.domain}</span>
              </div>
              {r.heading && <p className="mt-0.5 text-[11px] text-zinc-500">{r.heading}</p>}
              <p className="mt-1 text-zinc-400">{r.content}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ArtifactRegistry({
  docs,
  projects,
  codingTasks,
}: {
  docs: DocEntry[];
  projects: Project[];
  codingTasks: CodingTask[];
}) {
  const [tab, setTab] = useState<Tab>("research");
  const research = projects.filter((p) => p.activity_type === "research");
  const codingProjects = projects.filter((p) => p.activity_type === "coding");
  const unwrappedCodingTasks = codingTasks.filter((t) => !codingProjects.some((p) => p.coding_task_id === t.id));

  const TABS: { id: Tab; label: string; count: number }[] = [
    { id: "research", label: "Research", count: research.length },
    { id: "projects", label: "Projects", count: codingProjects.length + unwrappedCodingTasks.length },
    { id: "learning", label: "Learning", count: docs.length },
  ];

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Artifacts</h1>
        <p className="mt-0.5 text-xs text-zinc-500">Research, project docs, and what Amy has learned.</p>
      </div>

      <SearchBox />

      <div className="mb-4 flex gap-1 border-b border-white/10">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative px-3 py-2 text-sm transition-colors ${
              tab === t.id ? "font-medium text-indigo-300" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label} <span className="font-mono text-xs text-zinc-600">({t.count})</span>
            {tab === t.id && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-indigo-400" />}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "research" && (
          <ul className="space-y-2">
            {research.length === 0 && <p className="text-xs text-zinc-600">No research documents yet.</p>}
            {research.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </ul>
        )}

        {tab === "projects" && (
          <ul className="space-y-2">
            {codingProjects.length === 0 && unwrappedCodingTasks.length === 0 && (
              <p className="text-xs text-zinc-600">No project docs yet.</p>
            )}
            {codingProjects.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
            {unwrappedCodingTasks.map((t) => (
              <CodingTaskRow key={t.id} task={t} />
            ))}
          </ul>
        )}

        {tab === "learning" && (
          <ul className="space-y-1">
            {docs.length === 0 && <p className="text-xs text-zinc-600">No docs baked into this build.</p>}
            {docs.map((d) => (
              <li key={d.slug}>
                <a
                  href={`/artifacts/docs/${d.slug}`}
                  className="block rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-100"
                >
                  {d.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

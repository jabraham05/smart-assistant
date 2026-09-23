"use client";

import { useState } from "react";
import type { DocEntry } from "@/lib/docs-source";
import type { Project } from "@/lib/knowledge-engine-client";
import type { CodingTask } from "@/lib/coding-orchestrator-client";
import type { KnowledgeSearchResult } from "@/lib/knowledge-engine-client";

type Tab = "research" | "projects" | "learning";

function StatusBadge({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
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
    <li className="rounded border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{project.title}</p>
        <StatusBadge label={activityStatusLabel(project)} />
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{project.rationale}</p>
      <div className="mt-2 flex items-center gap-3">
        {project.activity_type === "research" && project.research_session_id && (
          <a
            href={`/research/${project.research_session_id}`}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            View write-up
          </a>
        )}
        {project.activity_type === "coding" && project.coding_task_pr_url && (
          <a
            href={project.coding_task_pr_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
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
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-gray-900 dark:text-gray-100">{task.task_description}</p>
        <StatusBadge label={task.status} />
      </div>
      {task.pr_url && (
        <a
          href={task.pr_url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
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
    <div className="mb-4">
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
          className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-gray-600"
        />
        <button
          type="submit"
          disabled={isSearching || !query.trim()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isSearching ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      {results && (
        <ul className="mt-3 space-y-2">
          {results.length === 0 && <p className="text-xs text-gray-400">No results.</p>}
          {results.map((r, i) => (
            <li key={i} className="rounded border border-gray-200 p-2 text-xs dark:border-gray-700">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-gray-800 dark:text-gray-200">{r.documentTitle}</span>
                <span className="shrink-0 text-[10px] text-gray-400">{r.domain}</span>
              </div>
              {r.heading && <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{r.heading}</p>}
              <p className="mt-1 text-gray-600 dark:text-gray-300">{r.content}</p>
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
    <div className="flex h-full flex-col p-4">
      <h1 className="mb-3 text-lg font-semibold text-gray-800 dark:text-gray-100">Artifacts</h1>

      <SearchBox />

      <div className="mb-3 flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-t px-3 py-1.5 text-sm ${
              tab === t.id
                ? "border-b-2 border-blue-600 font-medium text-blue-600 dark:text-blue-400"
                : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            {t.label} <span className="text-xs text-gray-400">({t.count})</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "research" && (
          <ul className="space-y-2">
            {research.length === 0 && <p className="text-xs text-gray-400">No research documents yet.</p>}
            {research.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </ul>
        )}

        {tab === "projects" && (
          <ul className="space-y-2">
            {codingProjects.length === 0 && unwrappedCodingTasks.length === 0 && (
              <p className="text-xs text-gray-400">No project docs yet.</p>
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
            {docs.length === 0 && <p className="text-xs text-gray-400">No docs baked into this build.</p>}
            {docs.map((d) => (
              <li key={d.slug}>
                <a
                  href={`/artifacts/docs/${d.slug}`}
                  className="block rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
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

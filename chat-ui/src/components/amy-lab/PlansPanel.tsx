"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useProjects } from "@/hooks/useProjects";
import type { Project } from "@/lib/knowledge-engine-client";
import type { TaskContext } from "@/types/chat";

function ProjectRow({ project }: { project: Project }) {
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-zinc-100">{project.title}</p>
        <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-500">
          {project.activity_type}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-zinc-500">{project.rationale}</p>
    </li>
  );
}

function ProjectGroup({ title, projects }: { title: string; projects: Project[] }) {
  if (projects.length === 0) return null;
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-xs font-medium text-zinc-400">
        {title} ({projects.length})
      </p>
      <ul className="space-y-2">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </ul>
    </div>
  );
}

function PlanRow({ task }: { task: TaskContext }) {
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-zinc-100">{task.objective}</p>
        <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-500">
          {task.status}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-zinc-600">
        <span className={task.source === "user" ? "rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-indigo-300" : "rounded-full bg-white/5 px-1.5 py-0.5"}>
          {task.source === "user" ? "you" : "amy"}
        </span>
        <Link href={`/tasks/${task.id}`} className="text-indigo-400 hover:underline">
          Details
        </Link>
      </div>
    </li>
  );
}

// Amy's own proposed/queued/active projects (knowledge-engine, via
// useProjects - the same hook chat's inline ApprovalRow and Home already
// use, unfiltered here) plus every task_context ("plans") she's tracking,
// not just the open subset Home's Todos card shows. Previously the only
// place to see any of this was Home's Activity feed or Artifacts' Research/
// Projects tabs - never Amy Lab itself, despite this being exactly the
// self-improvement/planning surface the page is for.
export function PlansPanel() {
  const { projects, refresh: refreshProjects } = useProjects();
  const [tasks, setTasks] = useState<TaskContext[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    refreshProjects();
    fetch("/api/todos")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { taskContexts: TaskContext[] }) => setTasks(data.taskContexts))
      .catch(() => setError("Couldn't reach event-bus."))
      .finally(() => setIsLoading(false));
    // Both fetches are one-shot on mount - refreshProjects is a stable
    // useCallback with no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const proposed = projects.filter((p) => p.status === "proposed");
  const active = projects.filter((p) => p.status === "active");
  const done = projects.filter((p) => p.status === "done");

  return (
    <div>
      <div className="mb-5">
        <p className="mb-2 text-xs font-medium text-zinc-400">Projects</p>
        {projects.length === 0 && <p className="text-xs text-zinc-600">No projects proposed yet.</p>}
        <ProjectGroup title="Proposed" projects={proposed} />
        <ProjectGroup title="Active" projects={active} />
        <ProjectGroup title="Done" projects={done} />
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">Plans ({tasks.length})</p>
        {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
        {error && <p className="text-xs text-rose-400">{error}</p>}
        {!isLoading && !error && tasks.length === 0 && <p className="text-xs text-zinc-600">No task contexts tracked yet.</p>}
        <ul className="space-y-2">
          {tasks.map((t) => (
            <PlanRow key={t.id} task={t} />
          ))}
        </ul>
      </div>
    </div>
  );
}

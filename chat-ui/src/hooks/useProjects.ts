import { useCallback, useState } from "react";
import type { Project } from "@/lib/knowledge-engine-client";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) {
        setError("Couldn't reach knowledge-engine.");
        return;
      }
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch {
      setError("Couldn't reach knowledge-engine.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const runAction = useCallback(
    async (id: number, action: "approve" | "reject" | "complete") => {
      setActionError(undefined);
      try {
        const res = await fetch(`/api/projects/${id}/${action}`, { method: "POST" });
        const body = await res.json();
        if (!res.ok) {
          setActionError(body.error ?? `${action} failed`);
          return;
        }
        await refresh();
      } catch {
        setActionError(`${action} failed - couldn't reach knowledge-engine.`);
      }
    },
    [refresh],
  );

  return {
    projects,
    isLoading,
    error,
    actionError,
    refresh,
    approve: (id: number) => runAction(id, "approve"),
    reject: (id: number) => runAction(id, "reject"),
    complete: (id: number) => runAction(id, "complete"),
  };
}

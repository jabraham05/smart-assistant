import { useCallback, useState } from "react";
import type { SkillProposal } from "@/lib/skills-registry-client";

export function useSkillProposals() {
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/skill-proposals");
      if (!res.ok) {
        setError("Couldn't reach skills-mcp.");
        return;
      }
      const data = await res.json();
      setProposals(data.proposals ?? []);
    } catch {
      setError("Couldn't reach skills-mcp.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const runAction = useCallback(
    async (id: number, action: "approve" | "reject") => {
      setActionError(undefined);
      try {
        const res = await fetch(`/api/skill-proposals/${id}/${action}`, { method: "POST" });
        const body = await res.json();
        if (!res.ok) {
          setActionError(body.error ?? `${action} failed`);
          return;
        }
        await refresh();
      } catch {
        setActionError(`${action} failed - couldn't reach skills-mcp.`);
      }
    },
    [refresh],
  );

  return {
    proposals,
    isLoading,
    error,
    actionError,
    refresh,
    approve: (id: number) => runAction(id, "approve"),
    reject: (id: number) => runAction(id, "reject"),
  };
}

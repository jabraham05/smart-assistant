import { useCallback, useState } from "react";
import type { RegisteredTool } from "@/types/chat";

export function useRegistry() {
  const [tools, setTools] = useState<RegisteredTool[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/registry");
      if (!res.ok) {
        setError("Couldn't reach skills-mcp.");
        return;
      }
      setTools(await res.json());
    } catch {
      setError("Couldn't reach skills-mcp.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { tools, isLoading, error, refresh };
}

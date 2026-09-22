import { useCallback, useState } from "react";
import type { HomeSummary } from "@/types/chat";

export function useHomeSummary() {
  const [summary, setSummary] = useState<HomeSummary | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/home");
      if (!res.ok) {
        setError("Couldn't reach event-bus.");
        return;
      }
      setSummary(await res.json());
    } catch {
      setError("Couldn't reach event-bus.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { summary, isLoading, error, refresh };
}

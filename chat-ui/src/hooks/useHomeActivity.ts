import { useCallback, useState } from "react";
import type { HomeActivityItem } from "@/types/chat";

export function useHomeActivity() {
  const [items, setItems] = useState<HomeActivityItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/home-activity");
      if (!res.ok) {
        setError("Couldn't reach event-bus.");
        return;
      }
      setItems(await res.json());
    } catch {
      setError("Couldn't reach event-bus.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { items, isLoading, error, refresh };
}

import { useCallback, useState } from "react";
import type { EventBusEvent } from "@/types/chat";

export function useEvents() {
  const [events, setEvents] = useState<EventBusEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/events?limit=100");
      if (!res.ok) {
        setError("Couldn't reach event-bus.");
        return;
      }
      setEvents(await res.json());
    } catch {
      setError("Couldn't reach event-bus.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { events, isLoading, error, refresh };
}

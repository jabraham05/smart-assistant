import { useCallback, useState } from "react";
import type { EventBusEvent } from "@/types/chat";

// Pass a sessionId to scope this to one conversation's activity (Chat's
// sidebar, Amy Lab) - omit it for the global feed (Home's recent activity).
export function useEvents(sessionId?: string) {
  const [events, setEvents] = useState<EventBusEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const url = new URL("/api/events", window.location.origin);
      url.searchParams.set("limit", "100");
      if (sessionId) url.searchParams.set("originSessionId", sessionId);
      const res = await fetch(url);
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
  }, [sessionId]);

  return { events, isLoading, error, refresh };
}

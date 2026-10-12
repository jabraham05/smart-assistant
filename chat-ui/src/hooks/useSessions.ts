"use client";

import { useCallback, useEffect, useState } from "react";
import type { EnrichedSession } from "@/types/chat";
import { randomUUID } from "@/lib/uuid";

export function useSessions() {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => randomUUID());
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      // Already filtered to real conversations and sorted by actual last
      // activity server-side (see /api/sessions -> listRealSessions) -
      // nothing left to do here.
      const data: EnrichedSession[] = await res.json();
      setSessions(data);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startNewSession = useCallback(() => {
    setActiveSessionId(randomUUID());
  }, []);

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    startNewSession,
    isLoading,
    refresh,
  };
}

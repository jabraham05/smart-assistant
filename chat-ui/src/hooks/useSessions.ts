"use client";

import { useCallback, useEffect, useState } from "react";
import type { HonchoSession } from "@/types/chat";

export function useSessions() {
  const [sessions, setSessions] = useState<HonchoSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => crypto.randomUUID());
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data: HonchoSession[] = await res.json();
      data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setSessions(data);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startNewSession = useCallback(() => {
    setActiveSessionId(crypto.randomUUID());
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

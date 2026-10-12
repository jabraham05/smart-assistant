"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useSessions } from "@/hooks/useSessions";

type SessionsState = ReturnType<typeof useSessions>;

// Chat (the default "/" route) and the global AppDrawer both need the same
// active-conversation state - the drawer lists/switches sessions, Chat owns
// the conversation itself. One provider, shared via context, instead of two
// independent useSessions() calls that would silently drift out of sync.
const ActiveSessionContext = createContext<SessionsState | null>(null);

export function ActiveSessionProvider({ children }: { children: ReactNode }) {
  const sessions = useSessions();
  return <ActiveSessionContext.Provider value={sessions}>{children}</ActiveSessionContext.Provider>;
}

export function useActiveSession(): SessionsState {
  const ctx = useContext(ActiveSessionContext);
  if (!ctx) throw new Error("useActiveSession must be used within ActiveSessionProvider");
  return ctx;
}

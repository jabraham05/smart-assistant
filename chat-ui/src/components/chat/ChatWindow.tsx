"use client";

import { useEffect, useState } from "react";
import type { ChatMessage } from "@/types/chat";
import { useChat } from "@/hooks/useChat";
import { useEvents } from "@/hooks/useEvents";
import { useRegistry } from "@/hooks/useRegistry";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import { EventLogPanel } from "./EventLogPanel";
import { TurnDebugPanel } from "./TurnDebugPanel";
import { AgentRegistryPanel } from "./AgentRegistryPanel";
import { getAvailableUserIds, getStoredUserId, setStoredUserId } from "@/lib/identity";

type SidePanel = "events" | "registry" | null;

// One fixed, persistent thread for the whole web client - deliberately not
// a per-visit random session, same model as the iOS app's single
// `amy-main` thread (ios/Amy/Chat/ChatViewModel.swift's mainThreadId). The
// web app used to mint a fresh random UUID session on every page load
// (useSessions.ts), which fragmented conversation history across disposable
// threads instead of feeling like talking to one person - user-requested
// fix, 2026-11-04. Amy Lab's own session browser is unrelated and keeps its
// independent useSessions() instance for debugging/inspecting any session.
const WEB_THREAD_ID = "amy-web";

export function ChatWindow() {
  // Defaults to "test" until the user explicitly picks a real identity
  // (see lib/identity.ts) - persisted per-browser so it survives reloads
  // without ever being silently upgraded to real on its own.
  const [userId, setUserId] = useState(getStoredUserId);
  const availableUserIds = getAvailableUserIds();
  const handleUserIdChange = (next: string) => {
    setUserId(next);
    setStoredUserId(next);
  };
  const { messages, isSending, isLoadingHistory, sendMessage } = useChat(WEB_THREAD_ID, userId);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  // Scoped to the active session - this is the per-conversation activity
  // sidebar (tool calls, research pulled, goals/tasks created), not the
  // global feed Home's Recent Activity card shows.
  const eventsState = useEvents(WEB_THREAD_ID);
  const registryState = useRegistry();

  const toggleSidePanel = (panel: SidePanel) => {
    setSelectedTurnId(null);
    setSidePanel((prev) => (prev === panel ? null : panel));
  };

  useEffect(() => {
    if (sidePanel === "events") eventsState.refresh();
    if (sidePanel === "registry") registryState.refresh();
    // registryState.refresh is stable (useCallback with no deps);
    // eventsState.refresh's identity is stable too now that the session is
    // fixed (WEB_THREAD_ID never changes), but kept in deps for honesty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidePanel, eventsState.refresh]);

  // A "turn" is a user message + the assistant reply that followed it -
  // clicking either bubble in the pair opens the same debug panel, keyed
  // off the assistant message id (that's where the trace data lives).
  const handleSelectTurn = (message: ChatMessage, index: number) => {
    const assistantId =
      message.role === "assistant" ? message.id : messages[index + 1]?.role === "assistant" ? messages[index + 1].id : null;
    if (!assistantId) return;
    setSelectedTurnId((prev) => (prev === assistantId ? null : assistantId));
  };

  const selectedIndex = selectedTurnId ? messages.findIndex((m) => m.id === selectedTurnId) : -1;
  const selectedAssistant = selectedIndex >= 0 ? messages[selectedIndex] : undefined;
  const selectedUser = selectedIndex > 0 ? messages[selectedIndex - 1] : undefined;

  return (
    <div className="flex h-full w-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="hidden items-center justify-end gap-4 border-b border-white/10 px-4 py-2.5 md:flex">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500" title="Which identity this conversation's memory is attributed to">
            identity
            <select
              value={userId}
              onChange={(e) => handleUserIdChange(e.target.value)}
              className="rounded border border-white/10 bg-transparent px-1 py-0.5 text-xs text-zinc-300"
            >
              {availableUserIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={sidePanel === "registry"}
              onChange={() => toggleSidePanel("registry")}
              className="accent-indigo-500"
            />
            agent registry
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={sidePanel === "events"}
              onChange={() => toggleSidePanel("events")}
              className="accent-indigo-500"
            />
            session activity
          </label>
          <span className="text-xs text-zinc-600">Click a message for turn detail</span>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {isLoadingHistory && <p className="text-center text-xs text-zinc-600">Loading conversation…</p>}
          {messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              isSelected={
                selectedTurnId !== null &&
                (message.id === selectedTurnId || messages[index + 1]?.id === selectedTurnId)
              }
              onSelect={() => handleSelectTurn(message, index)}
            />
          ))}
        </div>
        <InputBar onSend={sendMessage} disabled={isSending} />
      </div>
      {selectedAssistant && (
        <div className="hidden md:flex">
          <TurnDebugPanel
            userMessage={selectedUser}
            assistantMessage={selectedAssistant}
            onClose={() => setSelectedTurnId(null)}
          />
        </div>
      )}
      {!selectedAssistant && sidePanel === "registry" && (
        <div className="hidden md:flex">
          <AgentRegistryPanel
            tools={registryState.tools}
            isLoading={registryState.isLoading}
            error={registryState.error}
            onRefresh={registryState.refresh}
          />
        </div>
      )}
      {!selectedAssistant && sidePanel === "events" && (
        <div className="hidden md:flex">
          <EventLogPanel
            events={eventsState.events}
            isLoading={eventsState.isLoading}
            error={eventsState.error}
            onRefresh={eventsState.refresh}
            title="this session's activity"
          />
        </div>
      )}
    </div>
  );
}

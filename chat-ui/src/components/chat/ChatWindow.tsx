"use client";

import { useEffect, useState } from "react";
import type { ChatMessage } from "@/types/chat";
import { useChat } from "@/hooks/useChat";
import { useActiveSession } from "@/contexts/ActiveSessionContext";
import { useEvents } from "@/hooks/useEvents";
import { useRegistry } from "@/hooks/useRegistry";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import { EventLogPanel } from "./EventLogPanel";
import { TurnDebugPanel } from "./TurnDebugPanel";
import { AgentRegistryPanel } from "./AgentRegistryPanel";

type SidePanel = "events" | "registry" | null;

export function ChatWindow() {
  // Session list/switching now lives in the global AppDrawer (the "☰" menu
  // on every page) - this just reads the conversation the drawer selected.
  const { sessions, activeSessionId, refresh } = useActiveSession();
  const { messages, isSending, isLoadingHistory, sendMessage } = useChat(activeSessionId);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  // Scoped to the active session - this is the per-conversation activity
  // sidebar (tool calls, research pulled, goals/tasks created), not the
  // global feed Home's Recent Activity card shows.
  const eventsState = useEvents(activeSessionId);
  const registryState = useRegistry();

  const toggleSidePanel = (panel: SidePanel) => {
    setSelectedTurnId(null);
    setSidePanel((prev) => (prev === panel ? null : panel));
  };

  useEffect(() => {
    if (sidePanel === "events") eventsState.refresh();
    if (sidePanel === "registry") registryState.refresh();
    // registryState.refresh is stable (useCallback with no deps);
    // eventsState.refresh's identity changes with activeSessionId, which is
    // exactly the re-fetch trigger needed when switching sessions with the
    // panel already open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidePanel, activeSessionId, eventsState.refresh]);

  const handleSend = async (content: string) => {
    const isNewSession = !sessions.some((s) => s.id === activeSessionId);
    await sendMessage(content);
    if (isNewSession) refresh();
  };

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
        <InputBar onSend={handleSend} disabled={isSending} />
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

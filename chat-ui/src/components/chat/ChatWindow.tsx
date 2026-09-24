"use client";

import { useEffect, useState } from "react";
import type { ChatMessage } from "@/types/chat";
import { useChat } from "@/hooks/useChat";
import { useSessions } from "@/hooks/useSessions";
import { useEvents } from "@/hooks/useEvents";
import { useRegistry } from "@/hooks/useRegistry";
import { useProjects } from "@/hooks/useProjects";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import { SessionList } from "./SessionList";
import { EventLogPanel } from "./EventLogPanel";
import { TurnDebugPanel } from "./TurnDebugPanel";
import { AgentRegistryPanel } from "./AgentRegistryPanel";

type SidePanel = "events" | "registry" | null;

export function ChatWindow() {
  const { sessions, activeSessionId, setActiveSessionId, startNewSession, isLoading, refresh } =
    useSessions();
  const { messages, isSending, isLoadingHistory, sendMessage } = useChat(activeSessionId);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  // Scoped to the active session - this is the per-conversation activity
  // sidebar (tool calls, research pulled, goals/tasks created), not the
  // global feed Home's Recent Activity card shows.
  const eventsState = useEvents(activeSessionId);
  const registryState = useRegistry();
  // Only approve/reject are used here (not projects/refresh) - inline
  // proposal cards act on the same knowledge-engine endpoints Home's
  // ApprovalRow already calls, no duplicated fetch logic.
  const { approve: approveProject, reject: rejectProject, actionError: projectActionError } = useProjects();

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
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onNewSession={startNewSession}
        isLoading={isLoading}
      />
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-end gap-4 border-b border-white/10 px-4 py-2.5">
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
              approveProject={approveProject}
              rejectProject={rejectProject}
            />
          ))}
        </div>
        {projectActionError && <p className="px-4 pb-1 text-xs text-rose-400">{projectActionError}</p>}
        <InputBar onSend={handleSend} disabled={isSending} />
      </div>
      {selectedAssistant && (
        <TurnDebugPanel
          userMessage={selectedUser}
          assistantMessage={selectedAssistant}
          onClose={() => setSelectedTurnId(null)}
        />
      )}
      {!selectedAssistant && sidePanel === "registry" && (
        <AgentRegistryPanel
          tools={registryState.tools}
          isLoading={registryState.isLoading}
          error={registryState.error}
          onRefresh={registryState.refresh}
        />
      )}
      {!selectedAssistant && sidePanel === "events" && (
        <EventLogPanel
          events={eventsState.events}
          isLoading={eventsState.isLoading}
          error={eventsState.error}
          onRefresh={eventsState.refresh}
          title="this session's activity"
        />
      )}
    </div>
  );
}

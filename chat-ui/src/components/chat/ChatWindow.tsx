"use client";

import { useEffect, useState } from "react";
import type { ChatMessage } from "@/types/chat";
import { useChat } from "@/hooks/useChat";
import { useSessions } from "@/hooks/useSessions";
import { useEvents } from "@/hooks/useEvents";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import { SessionList } from "./SessionList";
import { EventLogPanel } from "./EventLogPanel";
import { TurnDebugPanel } from "./TurnDebugPanel";

export function ChatWindow() {
  const { sessions, activeSessionId, setActiveSessionId, startNewSession, isLoading, refresh } =
    useSessions();
  const { messages, isSending, isLoadingHistory, sendMessage } = useChat(activeSessionId);
  const [showEvents, setShowEvents] = useState(false);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const eventsState = useEvents();

  useEffect(() => {
    if (showEvents) eventsState.refresh();
    // eventsState.refresh is stable (useCallback with no deps) - only
    // re-fetch when the panel is actually opened, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEvents]);

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
    <div className="flex h-screen w-full">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onNewSession={startNewSession}
        isLoading={isLoading}
      />
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-end gap-4 border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <input
              type="checkbox"
              checked={showEvents}
              onChange={(e) => setShowEvents(e.target.checked)}
            />
            event-bus
          </label>
          <span className="text-xs text-gray-400 dark:text-gray-500">Click a message for turn detail</span>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {isLoadingHistory && (
            <p className="text-center text-xs text-gray-400">Loading conversation…</p>
          )}
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
      {selectedAssistant ? (
        <TurnDebugPanel
          userMessage={selectedUser}
          assistantMessage={selectedAssistant}
          onClose={() => setSelectedTurnId(null)}
        />
      ) : (
        showEvents && (
          <EventLogPanel
            events={eventsState.events}
            isLoading={eventsState.isLoading}
            error={eventsState.error}
            onRefresh={eventsState.refresh}
          />
        )
      )}
    </div>
  );
}

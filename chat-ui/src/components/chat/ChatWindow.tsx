"use client";

import { useEffect, useState } from "react";
import { useChat } from "@/hooks/useChat";
import { useSessions } from "@/hooks/useSessions";
import { useEvents } from "@/hooks/useEvents";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import { SessionList } from "./SessionList";
import { EventLogPanel } from "./EventLogPanel";

export function ChatWindow() {
  const { sessions, activeSessionId, setActiveSessionId, startNewSession, isLoading, refresh } =
    useSessions();
  const { messages, isSending, isLoadingHistory, sendMessage } = useChat(activeSessionId);
  const [debugMode, setDebugMode] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
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
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
            />
            Debug mode
          </label>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {isLoadingHistory && (
            <p className="text-center text-xs text-gray-400">Loading conversation…</p>
          )}
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} debugMode={debugMode} />
          ))}
        </div>
        <InputBar onSend={handleSend} disabled={isSending} />
      </div>
      {showEvents && (
        <EventLogPanel
          events={eventsState.events}
          isLoading={eventsState.isLoading}
          error={eventsState.error}
          onRefresh={eventsState.refresh}
        />
      )}
    </div>
  );
}

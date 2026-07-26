"use client";

import { useState } from "react";
import { useChat } from "@/hooks/useChat";
import { useSessions } from "@/hooks/useSessions";
import { MessageBubble } from "./MessageBubble";
import { InputBar } from "./InputBar";
import { SessionList } from "./SessionList";

export function ChatWindow() {
  const { sessions, activeSessionId, setActiveSessionId, startNewSession, isLoading, refresh } =
    useSessions();
  const { messages, isSending, isLoadingHistory, sendMessage } = useChat(activeSessionId);
  const [debugMode, setDebugMode] = useState(false);

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
        <div className="flex items-center justify-end border-b border-gray-200 px-4 py-2 dark:border-gray-700">
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
    </div>
  );
}

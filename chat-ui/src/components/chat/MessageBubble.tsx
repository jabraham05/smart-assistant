import type { ChatMessage } from "@/types/chat";
import { StepIndicator } from "./StepIndicator";
import { DebugPanel } from "./DebugPanel";

export function MessageBubble({
  message,
  debugMode,
}: {
  message: ChatMessage;
  debugMode: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] rounded-lg px-4 py-2 text-sm ${
          isUser
            ? "bg-blue-600 text-white"
            : message.isEmpty
              ? "bg-transparent text-gray-500 italic dark:text-gray-400"
              : "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
        }`}
      >
        {!isUser && message.steps && <StepIndicator steps={message.steps} />}
        {message.content}
        {!isUser && debugMode && message.rawEvents && (
          <DebugPanel events={message.rawEvents} />
        )}
      </div>
    </div>
  );
}

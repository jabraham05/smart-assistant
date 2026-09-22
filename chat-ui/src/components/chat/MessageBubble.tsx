import type { ChatMessage } from "@/types/chat";
import { StepIndicator } from "./StepIndicator";

export function MessageBubble({
  message,
  isSelected,
  onSelect,
}: {
  message: ChatMessage;
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <button
        type="button"
        onClick={onSelect}
        title="Click for turn detail"
        className={`max-w-[75%] rounded-lg px-4 py-2 text-left text-sm ${
          isUser
            ? "bg-blue-600 text-white"
            : message.isEmpty
              ? "bg-transparent text-gray-500 italic dark:text-gray-400"
              : "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
        } ${isSelected ? "ring-2 ring-blue-400 ring-offset-1 dark:ring-offset-gray-900" : ""}`}
      >
        {!isUser && message.steps && <StepIndicator steps={message.steps} />}
        {message.content}
      </button>
    </div>
  );
}

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
      {/* A <button> can only contain phrasing content - StepIndicator renders
          a <ul>/<li> list, which isn't valid inside one and causes the
          browser to reparent the DOM, producing a React hydration mismatch
          on essentially every assistant message with a tool call. A div
          with button semantics avoids the invalid nesting entirely. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.();
          }
        }}
        title="Click for turn detail"
        className={`max-w-[75%] cursor-pointer rounded-lg px-4 py-2 text-left text-sm ${
          isUser
            ? "bg-blue-600 text-white"
            : message.isEmpty
              ? "bg-transparent text-gray-500 italic dark:text-gray-400"
              : "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
        } ${isSelected ? "ring-2 ring-blue-400 ring-offset-1 dark:ring-offset-gray-900" : ""}`}
      >
        {!isUser && message.steps && <StepIndicator steps={message.steps} />}
        {message.content}
      </div>
    </div>
  );
}

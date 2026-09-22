import type { ChatMessage } from "@/types/chat";
import { StepIndicator } from "./StepIndicator";
import { MarkdownContent } from "./MarkdownContent";

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

  // A real <a> from rendered markdown (see MarkdownContent) can't nest
  // inside a <button> - nested interactive elements are invalid HTML and
  // browsers handle their click/focus behavior inconsistently, which
  // would silently break the exact links this component exists to make
  // clickable. Using a div with a button role instead keeps the "click
  // for turn detail" behavior and keyboard accessibility without that
  // conflict; MarkdownContent's own link override stops propagation so
  // clicking a link doesn't also toggle turn detail underneath it.
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSelect?.();
        }}
        title="Click for turn detail"
        className={`max-w-[75%] cursor-pointer rounded-lg px-4 py-2 text-left ${
          isUser
            ? "bg-blue-600 text-white"
            : message.isEmpty
              ? "bg-transparent text-gray-500 italic dark:text-gray-400"
              : "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
        } ${isSelected ? "ring-2 ring-blue-400 ring-offset-1 dark:ring-offset-gray-900" : ""}`}
      >
        {!isUser && message.steps && <StepIndicator steps={message.steps} />}
        <MarkdownContent content={message.content} isUser={isUser} />
      </div>
    </div>
  );
}

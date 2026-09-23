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

  // A <button> can only contain phrasing content - two independent reasons
  // this breaks that: StepIndicator renders a <ul>/<li> list (invalid
  // inside a button, causing the browser to reparent the DOM and produce a
  // React hydration mismatch on essentially any tool-call turn), and a real
  // <a> from rendered markdown (see MarkdownContent) can't nest inside one
  // either (nested interactive elements, unreliable click/focus behavior -
  // exactly the link this component exists to make clickable). A div with
  // button semantics avoids both; MarkdownContent's own link override stops
  // propagation so clicking a link doesn't also toggle turn detail.
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
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
        className={`max-w-[75%] cursor-pointer rounded-2xl px-4 py-2.5 text-left transition-colors ${
          isUser
            ? "bg-indigo-600 text-white"
            : message.isEmpty
              ? "border border-white/10 bg-transparent text-zinc-500 italic"
              : "border border-white/10 bg-zinc-900/60 text-zinc-100"
        } ${isSelected ? "ring-2 ring-indigo-400/60 ring-offset-2 ring-offset-zinc-950" : ""}`}
      >
        {!isUser && message.steps && <StepIndicator steps={message.steps} />}
        <MarkdownContent content={message.content} isUser={isUser} />
      </div>
    </div>
  );
}

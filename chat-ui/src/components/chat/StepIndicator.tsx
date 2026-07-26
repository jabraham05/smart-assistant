import type { StepEvent, StepKind } from "@/types/chat";

const KIND_ICON: Record<StepKind, string> = {
  thinking: "\u{1F914}",
  tool_call: "\u{1F527}",
  message_sent: "\u{1F4E4}",
  data_saved: "\u{1F4BE}",
  other: "⚙️",
};

function StatusMark({ status }: { status: StepEvent["status"] }) {
  if (status === "running") {
    return (
      <span
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 dark:border-gray-600 dark:border-t-blue-400"
        aria-label="in progress"
      />
    );
  }
  if (status === "error") {
    return <span className="text-red-500">✕</span>;
  }
  return <span className="text-green-600 dark:text-green-400">✓</span>;
}

export function StepIndicator({ steps }: { steps: StepEvent[] }) {
  if (steps.length === 0) return null;

  return (
    <ul className="mb-1.5 space-y-1">
      {steps.map((step, i) => (
        <li
          key={`${step.nodeId}-${i}`}
          className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"
        >
          <StatusMark status={step.status} />
          <span>{KIND_ICON[step.kind]}</span>
          <span>{step.label}</span>
        </li>
      ))}
    </ul>
  );
}

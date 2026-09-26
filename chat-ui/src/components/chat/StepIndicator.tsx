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
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/15 border-t-indigo-400"
        aria-label="in progress"
      />
    );
  }
  if (status === "error") {
    return <span className="text-rose-400">✕</span>;
  }
  return <span className="text-emerald-400">✓</span>;
}

export function StepIndicator({ steps }: { steps: StepEvent[] }) {
  if (steps.length === 0) return null;

  return (
    <ul className="mt-1.5 space-y-1">
      {steps.map((step, i) => (
        <li key={`${step.nodeId}-${i}`} className="flex items-center gap-2 text-xs text-zinc-400">
          <StatusMark status={step.status} />
          <span>{KIND_ICON[step.kind]}</span>
          <span>{step.label}</span>
        </li>
      ))}
    </ul>
  );
}

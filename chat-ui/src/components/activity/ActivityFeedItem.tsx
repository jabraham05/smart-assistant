// Shared feed row for both Home's curated activity feed (label = a
// HomeActivityItem's category: research/project/task/goal) and the task
// detail page's granular feed (label = a TaskActivityItem's kind:
// note/step/event). Both endpoints compute `summary` server-side, so
// there's no raw payload to expand here - that's what the Chat sidebar's
// EventLogPanel is for.
const LABEL_COLOR: Record<string, string> = {
  research: "bg-violet-500/10 text-violet-300",
  project: "bg-indigo-500/10 text-indigo-300",
  task: "bg-emerald-500/10 text-emerald-300",
  goal: "bg-amber-500/10 text-amber-300",
  step: "bg-emerald-500/10 text-emerald-300",
  event: "bg-indigo-500/10 text-indigo-300",
  note: "bg-white/5 text-zinc-400",
};
const DEFAULT_LABEL_COLOR = "bg-white/5 text-zinc-400";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ActivityFeedItem({
  label,
  summary,
  occurredAt,
}: {
  label: string;
  summary: string;
  occurredAt: string;
}) {
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide ${
            LABEL_COLOR[label] ?? DEFAULT_LABEL_COLOR
          }`}
        >
          {label}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-zinc-600">{formatTime(occurredAt)}</span>
      </div>
      <p className="mt-1 text-zinc-300">{summary}</p>
    </li>
  );
}

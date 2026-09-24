import type { EventBusEvent } from "@/types/chat";

// Companion read view for FeedbackForm - previously feedback was
// write-only (POST /api/feedback, no way to see what had already been
// submitted anywhere in chat-ui). Filters the same session-scoped
// eventsState AmyLab already fetches for the Context Engine tab, so no
// extra request is needed here - just a different slice of the same data,
// naturally tied to whichever session is active (per the user's own
// request that feedback be tied into the chat session).
export function SessionFeedbackList({ events }: { events: EventBusEvent[] }) {
  const feedback = events.filter((e) => e.type === "behavior_feedback");

  if (feedback.length === 0) {
    return <p className="px-3.5 py-2 text-[10px] text-zinc-600">No feedback logged for this session yet.</p>;
  }

  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto border-b border-white/10 px-3.5 py-2.5">
      {feedback.map((e) => (
        <li key={e.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-500">
              {String(e.payload.category ?? "other")}
            </span>
            <span className="font-mono text-[9px] text-zinc-600">
              {new Date(e.occurred_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">{String(e.payload.note ?? "")}</p>
        </li>
      ))}
    </ul>
  );
}

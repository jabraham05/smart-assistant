import type { EventBusEvent } from "@/types/chat";

// Source badge colors just need to be visually distinct, not meaningful -
// picked to roughly match each producer's own domain color elsewhere in
// this file (indigo-ish for chat, matching SessionList's origin badges).
const SOURCE_COLOR: Record<string, string> = {
  chat: "bg-indigo-500/10 text-indigo-300",
  discord: "bg-violet-500/10 text-violet-300",
  coding_orchestrator: "bg-emerald-500/10 text-emerald-300",
  pi_dashboard: "bg-amber-500/10 text-amber-300",
  amy_lab: "bg-cyan-500/10 text-cyan-300",
};
const DEFAULT_SOURCE_COLOR = "bg-white/5 text-zinc-400";

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function EventRow({ event }: { event: EventBusEvent }) {
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide ${
              SOURCE_COLOR[event.source] ?? DEFAULT_SOURCE_COLOR
            }`}
          >
            {event.source}
          </span>
          <span className="text-xs text-zinc-400">{event.type}</span>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-zinc-600">{formatTime(event.occurred_at)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-zinc-600">
        <span>priority: {event.priority}</span>
        <span>{event.should_notify ? (event.notified_at ? "notified" : "pending notify") : "no notify"}</span>
        {event.origin_session_id && <span className="truncate">session: {event.origin_session_id}</span>}
      </div>
      {Object.keys(event.payload ?? {}).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300">payload</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-white/5 bg-black/40 p-1.5 font-mono text-[10px] leading-snug text-zinc-300">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

export function EventLogPanel({
  events,
  isLoading,
  error,
  onRefresh,
  title = "event-bus",
}: {
  events: EventBusEvent[];
  isLoading: boolean;
  error?: string;
  onRefresh: () => void;
  title?: string;
}) {
  return (
    <div className="flex h-full w-96 flex-col border-l border-white/10">
      <div className="flex items-center justify-between border-b border-white/10 p-2.5">
        <span className="text-xs font-medium text-zinc-300">{title}</span>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="rounded-lg px-2 py-1 text-xs text-indigo-400 transition-colors hover:bg-white/5 disabled:opacity-40"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {error && <p className="px-1 py-2 text-xs text-rose-400">{error}</p>}
        {!error && !isLoading && events.length === 0 && (
          <p className="px-1 py-2 text-xs text-zinc-600">No events yet.</p>
        )}
        <ul className="space-y-1.5">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ul>
      </div>
    </div>
  );
}

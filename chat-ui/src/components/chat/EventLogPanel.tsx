import type { EventBusEvent } from "@/types/chat";

// Source badge colors just need to be visually distinct, not meaningful -
// picked to roughly match each producer's own domain color elsewhere in
// this file (blue-ish for chat, indigo for discord, matching
// SessionList's origin badges).
const SOURCE_COLOR: Record<string, string> = {
  chat: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  discord: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300",
  coding_orchestrator: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
  pi_dashboard: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
};
const DEFAULT_SOURCE_COLOR = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";

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
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              SOURCE_COLOR[event.source] ?? DEFAULT_SOURCE_COLOR
            }`}
          >
            {event.source}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{event.type}</span>
        </div>
        <span className="shrink-0 text-[10px] text-gray-400">{formatTime(event.occurred_at)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400">
        <span>priority: {event.priority}</span>
        <span>
          {event.should_notify ? (event.notified_at ? "notified" : "pending notify") : "no notify"}
        </span>
        {event.origin_session_id && <span className="truncate">session: {event.origin_session_id}</span>}
      </div>
      {Object.keys(event.payload ?? {}).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            payload
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-900 p-1.5 text-[10px] leading-snug text-gray-100">
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
}: {
  events: EventBusEvent[];
  isLoading: boolean;
  error?: string;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-full w-96 flex-col border-l border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-200 p-2 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">event-bus</span>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {error && <p className="px-1 py-2 text-xs text-red-500">{error}</p>}
        {!error && !isLoading && events.length === 0 && (
          <p className="px-1 py-2 text-xs text-gray-400">No events yet.</p>
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

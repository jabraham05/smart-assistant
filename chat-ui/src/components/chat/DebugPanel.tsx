import type { N8nStreamEvent } from "@/types/chat";

export function DebugPanel({ events }: { events: N8nStreamEvent[] }) {
  if (events.length === 0) return null;

  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
        {events.length} raw event{events.length === 1 ? "" : "s"}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded bg-gray-900 p-2 text-[11px] leading-snug text-gray-100">
        {events.map((e) => JSON.stringify(e)).join("\n")}
      </pre>
    </details>
  );
}

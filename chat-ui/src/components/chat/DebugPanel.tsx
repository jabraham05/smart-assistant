import type { N8nStreamEvent } from "@/types/chat";

export function DebugPanel({ events }: { events: N8nStreamEvent[] }) {
  if (events.length === 0) return null;

  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
        {events.length} raw event{events.length === 1 ? "" : "s"}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] leading-snug text-zinc-300">
        {events.map((e) => JSON.stringify(e)).join("\n")}
      </pre>
    </details>
  );
}

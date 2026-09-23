import type { ChatMessage, ChatTraceEvent } from "@/types/chat";
import { DebugPanel } from "./DebugPanel";

const RETRY_REASON_LABEL: Record<Extract<ChatTraceEvent, { kind: "retry" }>["reason"], string> = {
  empty_output: "Got an empty reply — trying again",
  search_intent: "Said it would search but never actually called a tool — nudging it to really search",
  confabulation: "Claimed to have done something without calling the tool that would do it — asking it to actually call it, or stop claiming it did",
  required_tool: "This message needed a real tool call and didn't get one — nudging it to actually call the required tool",
};

// Renders a tool's args (or a JSON-ish result string) as a readable
// key: value list rather than a raw JSON blob - falls back to a plain
// preformatted block for anything that isn't a plain object.
function ReadableValue({ value }: { value: unknown }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-zinc-600">(no arguments)</span>;
    return (
      <dl className="space-y-0.5">
        {entries.map(([key, v]) => (
          <div key={key} className="flex gap-1.5 text-xs">
            <dt className="shrink-0 font-medium text-zinc-500">{key}:</dt>
            <dd className="break-words text-zinc-300">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <pre className="whitespace-pre-wrap break-words text-xs text-zinc-300">{String(value)}</pre>;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function ResultText({ text }: { text: string }) {
  const parsed = tryParseJson(text);
  if (parsed !== undefined) return <ReadableValue value={parsed} />;
  return <p className="whitespace-pre-wrap break-words text-xs text-zinc-300">{text}</p>;
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">{label}</p>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {items.map((t) => (
          <span key={t} className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function ClassifyRow({ event }: { event: Extract<ChatTraceEvent, { kind: "classify" }> }) {
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <p className="text-xs font-medium text-zinc-400">🧭 What Amy decided about this message</p>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
        <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-indigo-300">toolPolicy: {event.toolPolicy}</span>
        <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-violet-300">memoryPolicy: {event.memoryPolicy}</span>
        {event.needsPlanning && (
          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-amber-300">needs planning</span>
        )}
        {event.background && (
          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">background</span>
        )}
      </div>

      <ChipRow label="Capability groups" items={event.relevantGroups} />
      <ChipRow label="Tools bound this turn" items={event.boundTools} />

      {event.openTasks.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">Open task context</p>
          <ul className="mt-0.5 space-y-0.5">
            {event.openTasks.map((t) => (
              <li key={t.id} className="text-[11px] text-zinc-400">
                #{t.id} {t.objective} <span className="text-zinc-600">({t.status})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {event.relevantGoals.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">Matched goals</p>
          <ul className="mt-0.5 space-y-0.5">
            {event.relevantGoals.map((g) => (
              <li key={g.id} className="text-[11px] text-zinc-400">
                {g.title} <span className="text-zinc-600">({g.status})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {event.memories.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">
            Recalled from memory-engine {event.memoryPolicy === "none" && "(not used — memoryPolicy: none)"}
          </p>
          <ul className="mt-0.5 space-y-1">
            {event.memories.map((m, i) => (
              <li key={i} className="rounded-lg bg-white/[0.03] p-1.5 text-[11px] text-zinc-400">
                <span className="text-zinc-600">[{m.domain ?? "general"} · score {m.score.toFixed(2)}]</span> {m.content}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function TraceRow({ event }: { event: ChatTraceEvent }) {
  if (event.kind === "classify") {
    return <ClassifyRow event={event} />;
  }

  if (event.kind === "retry") {
    return (
      <li className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-2.5 text-xs text-amber-300">
        🔁 Attempt {event.attempt}: {RETRY_REASON_LABEL[event.reason]}
      </li>
    );
  }

  if (event.kind === "tool_call") {
    return (
      <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
        <p className="text-xs font-medium text-zinc-300">
          🔧 Called <code className="text-indigo-400">{event.name}</code>
          <span className="ml-1 font-mono text-[10px] font-normal text-zinc-600">
            attempt {event.attempt} · iteration {event.iteration}
          </span>
        </p>
        <div className="mt-1">
          <ReadableValue value={event.args} />
        </div>
      </li>
    );
  }

  // tool_result
  return (
    <li
      className={`rounded-lg border p-2.5 ${
        event.isError ? "border-rose-500/20 bg-rose-500/[0.06]" : "border-white/5 bg-white/[0.02]"
      }`}
    >
      <p className="text-xs font-medium text-zinc-300">
        {event.isError ? "✕" : "↩"} <code className="text-indigo-400">{event.name}</code> result
      </p>
      <div className="mt-1 max-h-48 overflow-auto">
        <ResultText text={event.result} />
      </div>
    </li>
  );
}

export function TurnDebugPanel({
  userMessage,
  assistantMessage,
  onClose,
}: {
  userMessage?: ChatMessage;
  assistantMessage: ChatMessage;
  onClose: () => void;
}) {
  const trace = assistantMessage.trace ?? [];

  return (
    <div className="flex h-full w-[28rem] flex-col border-l border-white/10">
      <div className="flex items-center justify-between border-b border-white/10 p-2.5">
        <span className="text-xs font-medium text-zinc-300">Turn detail</span>
        <button onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/5">
          Close
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {userMessage && (
          <div>
            <p className="text-xs font-medium text-zinc-500">User said</p>
            <p className="mt-1 rounded-lg bg-white/[0.03] p-2 text-xs text-zinc-200">{userMessage.content}</p>
          </div>
        )}

        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">What happened</p>
          {trace.length === 0 ? (
            <p className="text-xs text-zinc-600">No tool calls or retries — a plain reply.</p>
          ) : (
            <ul className="space-y-1.5">
              {trace.map((event, i) => (
                <TraceRow key={i} event={event} />
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-zinc-500">Final reply</p>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-white/[0.03] p-2 text-xs text-zinc-200">
            {assistantMessage.content || "(empty)"}
          </p>
        </div>

        {assistantMessage.rawEvents && assistantMessage.rawEvents.length > 0 && (
          <div>
            <p className="text-xs font-medium text-zinc-500">Raw stream</p>
            <DebugPanel events={assistantMessage.rawEvents} />
          </div>
        )}
      </div>
    </div>
  );
}

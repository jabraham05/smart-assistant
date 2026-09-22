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
    if (entries.length === 0) return <span className="text-gray-400">(no arguments)</span>;
    return (
      <dl className="space-y-0.5">
        {entries.map(([key, v]) => (
          <div key={key} className="flex gap-1.5 text-xs">
            <dt className="shrink-0 font-medium text-gray-500 dark:text-gray-400">{key}:</dt>
            <dd className="break-words text-gray-700 dark:text-gray-300">
              {typeof v === "string" ? v : JSON.stringify(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <pre className="whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">{String(value)}</pre>;
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
  return <p className="whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">{text}</p>;
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {items.map((t) => (
          <span
            key={t}
            className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function ClassifyRow({ event }: { event: Extract<ChatTraceEvent, { kind: "classify" }> }) {
  return (
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">🧭 What Amy decided about this message</p>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
          toolPolicy: {event.toolPolicy}
        </span>
        <span className="rounded bg-purple-100 px-1.5 py-0.5 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
          memoryPolicy: {event.memoryPolicy}
        </span>
        {event.needsPlanning && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            needs planning
          </span>
        )}
        {event.background && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
            background
          </span>
        )}
      </div>

      <ChipRow label="Capability groups" items={event.relevantGroups} />
      <ChipRow label="Tools bound this turn" items={event.boundTools} />

      {event.openTasks.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Open task context</p>
          <ul className="mt-0.5 space-y-0.5">
            {event.openTasks.map((t) => (
              <li key={t.id} className="text-[11px] text-gray-600 dark:text-gray-300">
                #{t.id} {t.objective} <span className="text-gray-400">({t.status})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {event.relevantGoals.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Matched goals</p>
          <ul className="mt-0.5 space-y-0.5">
            {event.relevantGoals.map((g) => (
              <li key={g.id} className="text-[11px] text-gray-600 dark:text-gray-300">
                {g.title} <span className="text-gray-400">({g.status})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {event.memories.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">
            Recalled from memory-engine {event.memoryPolicy === "none" && "(not used — memoryPolicy: none)"}
          </p>
          <ul className="mt-0.5 space-y-1">
            {event.memories.map((m, i) => (
              <li
                key={i}
                className="rounded bg-gray-50 p-1.5 text-[11px] text-gray-600 dark:bg-gray-800/60 dark:text-gray-300"
              >
                <span className="text-gray-400">[{m.domain ?? "general"} · score {m.score.toFixed(2)}]</span>{" "}
                {m.content}
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
      <li className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
        🔁 Attempt {event.attempt}: {RETRY_REASON_LABEL[event.reason]}
      </li>
    );
  }

  if (event.kind === "tool_call") {
    return (
      <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
        <p className="text-xs font-medium text-gray-700 dark:text-gray-200">
          🔧 Called <code className="text-blue-600 dark:text-blue-400">{event.name}</code>
          <span className="ml-1 text-[10px] font-normal text-gray-400">
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
      className={`rounded border p-2 ${
        event.isError
          ? "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/20"
          : "border-gray-200 dark:border-gray-700"
      }`}
    >
      <p className="text-xs font-medium text-gray-700 dark:text-gray-200">
        {event.isError ? "✕" : "↩"} <code className="text-blue-600 dark:text-blue-400">{event.name}</code> result
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
    <div className="flex h-full w-[28rem] flex-col border-l border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-200 p-2 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Turn detail</span>
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          Close
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {userMessage && (
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">User said</p>
            <p className="mt-1 rounded bg-gray-100 p-2 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
              {userMessage.content}
            </p>
          </div>
        )}

        <div>
          <p className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">What happened</p>
          {trace.length === 0 ? (
            <p className="text-xs text-gray-400">No tool calls or retries — a plain reply.</p>
          ) : (
            <ul className="space-y-1.5">
              {trace.map((event, i) => (
                <TraceRow key={i} event={event} />
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Final reply</p>
          <p className="mt-1 whitespace-pre-wrap rounded bg-gray-100 p-2 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
            {assistantMessage.content || "(empty)"}
          </p>
        </div>

        {assistantMessage.rawEvents && assistantMessage.rawEvents.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Raw stream</p>
            <DebugPanel events={assistantMessage.rawEvents} />
          </div>
        )}
      </div>
    </div>
  );
}

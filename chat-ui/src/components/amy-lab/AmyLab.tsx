"use client";

import { useEffect, useState } from "react";
import { useSessions } from "@/hooks/useSessions";
import { useEvents } from "@/hooks/useEvents";
import { SessionList } from "@/components/chat/SessionList";
import { EventLogPanel } from "@/components/chat/EventLogPanel";
import type { EventBusEvent } from "@/types/chat";

type Tab = "trace" | "system-prompt";

// Mirrors chat-orchestrator/src/system-prompt.ts's buildSystemPrompt clause
// order. Persona text, user cards, and the skills catalog aren't captured
// per-turn anywhere retrievable after the fact (only the classify decision
// below is persisted to event-bus, see chat-orchestrator/src/events.ts's
// publishClassificationEvent) - this is a structural explainer of what
// Amy's system prompt is built from, not a reconstruction of one turn's
// exact prompt text.
const SYSTEM_PROMPT_SECTIONS: { label: string; description: string; dynamic: boolean }[] = [
  { label: "Persona", description: "Amy's core persona text, loaded from the active persona record.", dynamic: false },
  { label: "Current date/time", description: "Pacific time, injected fresh every turn as ground truth for relative dates.", dynamic: false },
  { label: "Response style", description: "Standing rule: concise, synthesized answers, not raw tool-output dumps.", dynamic: false },
  { label: "Tool-error handling", description: "Standing rule: diagnose and retry a failed tool call in the same reply, don't just say 'I'll check later'.", dynamic: false },
  { label: "User card", description: "What Amy knows about the user, an evolving profile.", dynamic: false },
  { label: "User card for Amy", description: "Standing instructions the user has given about how Amy should behave.", dynamic: false },
  { label: "Relevant memories", description: "Cross-conversation recall from memory-engine, filtered by this turn's memory policy.", dynamic: true },
  { label: "Open tasks", description: "Every open task_context, shown every turn regardless of memory policy (see this session's Trace tab).", dynamic: true },
  { label: "Relevant goals", description: "Goals keyword-matched to this message.", dynamic: true },
  { label: "Needs-planning nudge", description: "One-time nudge to plan a multi-step task before attempting it.", dynamic: true },
  { label: "Narrate-before-slow-answer", description: "Told to narrate what it's about to do when a turn will likely take a while.", dynamic: true },
  { label: "Skills catalog", description: "The full list of skills Amy has learned.", dynamic: false },
];

function classificationSummary(payload: Record<string, unknown>) {
  const relevantGroups = Array.isArray(payload.relevantGroups) ? (payload.relevantGroups as string[]) : [];
  const relevantTools = Array.isArray(payload.relevantTools) ? (payload.relevantTools as string[]) : [];
  return { relevantGroups, relevantTools };
}

function ClassificationRow({ event }: { event: EventBusEvent }) {
  const { relevantGroups, relevantTools } = classificationSummary(event.payload);
  return (
    <li className="rounded border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">What Amy decided about this turn</p>
        <span className="shrink-0 text-[10px] text-gray-400">
          {new Date(event.occurred_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
          toolPolicy: {String(event.payload.toolPolicy ?? "?")}
        </span>
        <span className="rounded bg-purple-100 px-1.5 py-0.5 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
          memoryPolicy: {String(event.payload.memoryPolicy ?? "?")}
        </span>
        {event.payload.needsPlanning === true && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            needs planning
          </span>
        )}
        {event.payload.background === true && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
            background
          </span>
        )}
      </div>
      {relevantGroups.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Capability groups</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {relevantGroups.map((g) => (
              <span key={g} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {g}
              </span>
            ))}
          </div>
        </div>
      )}
      {relevantTools.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Tools bound this turn</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {relevantTools.map((t) => (
              <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function FeedbackForm({ sessionId }: { sessionId: string }) {
  const [category, setCategory] = useState("behavior");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const submit = async () => {
    if (!note.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, note, sessionId }),
      });
      setStatus(res.ok ? "sent" : "error");
      if (res.ok) setNote("");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="border-b border-gray-200 p-3 dark:border-gray-700">
      <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">Leave feedback on this session</p>
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="mb-2 w-full rounded border border-gray-300 bg-transparent px-2 py-1 text-xs dark:border-gray-600"
      >
        <option value="behavior">Behavior</option>
        <option value="tool_use">Tool use</option>
        <option value="response_style">Response style</option>
        <option value="other">Other</option>
      </select>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What should Amy have done differently?"
        rows={3}
        className="w-full resize-none rounded border border-gray-300 bg-transparent px-2 py-1 text-xs dark:border-gray-600"
      />
      <button
        onClick={submit}
        disabled={status === "sending" || !note.trim()}
        className="mt-2 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {status === "sending" ? "Sending…" : "Submit feedback"}
      </button>
      {status === "sent" && <p className="mt-1 text-[10px] text-green-600 dark:text-green-400">Saved.</p>}
      {status === "error" && <p className="mt-1 text-[10px] text-red-500">Couldn&apos;t reach event-bus.</p>}
    </div>
  );
}

export function AmyLab() {
  const { sessions, activeSessionId, setActiveSessionId, startNewSession, isLoading } = useSessions();
  const eventsState = useEvents(activeSessionId);
  const [tab, setTab] = useState<Tab>("trace");

  useEffect(() => {
    eventsState.refresh();
    // eventsState.refresh's identity changes with activeSessionId - this is
    // the re-fetch trigger when switching sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, eventsState.refresh]);

  const classificationEvents = eventsState.events.filter((e) => e.type === "message_classified").reverse();

  return (
    <div className="flex h-full w-full">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onNewSession={startNewSession}
        isLoading={isLoading}
      />
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          {(["trace", "system-prompt"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-sm ${
                tab === t
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                  : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              }`}
            >
              {t === "trace" ? "Trace" : "System Prompt"}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "trace" && (
            <>
              <p className="mb-3 text-xs text-gray-400">
                Each turn&apos;s classify decision for this session - the dynamic half of what shapes Amy&apos;s system prompt.
                For the full picture (tool calls, research pulled, etc.) see the activity log →
              </p>
              {classificationEvents.length === 0 && (
                <p className="text-xs text-gray-400">
                  {eventsState.isLoading ? "Loading…" : "No classified turns recorded for this session yet."}
                </p>
              )}
              <ul className="space-y-2">
                {classificationEvents.map((e) => (
                  <ClassificationRow key={e.id} event={e} />
                ))}
              </ul>
            </>
          )}

          {tab === "system-prompt" && (
            <>
              <p className="mb-3 text-xs text-gray-400">
                Every named section chat-orchestrator&apos;s buildSystemPrompt assembles, in order. Sections marked
                &quot;varies by turn&quot; change with this session&apos;s Trace tab above; the rest are effectively static.
              </p>
              <ul className="space-y-2">
                {SYSTEM_PROMPT_SECTIONS.map((s) => (
                  <li key={s.label} className="rounded border border-gray-200 p-2 dark:border-gray-700">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{s.label}</p>
                      {s.dynamic && (
                        <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                          varies by turn
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{s.description}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      <div className="flex h-full w-96 flex-col border-l border-gray-200 dark:border-gray-700">
        <FeedbackForm sessionId={activeSessionId} />
        <div className="flex-1 overflow-hidden">
          <EventLogPanel
            events={eventsState.events}
            isLoading={eventsState.isLoading}
            error={eventsState.error}
            onRefresh={eventsState.refresh}
            title="this session's activity"
          />
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useSessions } from "@/hooks/useSessions";
import { useEvents } from "@/hooks/useEvents";
import { SessionList } from "@/components/chat/SessionList";
import { EventLogPanel } from "@/components/chat/EventLogPanel";
import { KnowledgeGraphView } from "@/components/amy-lab/KnowledgeGraphView";
import { EntitiesView } from "@/components/amy-lab/EntitiesView";
import { CodingProjectBreakdown } from "@/components/amy-lab/CodingProjectBreakdown";
import { SuggestedUpgrades } from "@/components/amy-lab/SuggestedUpgrades";
import { PersonaView } from "@/components/amy-lab/PersonaView";
import { UserProfileView, UserInstructionsView } from "@/components/amy-lab/UserProfileView";
import { FilesView } from "@/components/amy-lab/FilesView";
import { TimelineView } from "@/components/amy-lab/TimelineView";
import { SystemPromptView } from "@/components/amy-lab/SystemPromptView";
import { GrowthOverview } from "@/components/amy-lab/growth/GrowthOverview";
import { GrowthOpportunities } from "@/components/amy-lab/growth/GrowthOpportunities";
import { GrowthReviewQueue } from "@/components/amy-lab/growth/GrowthReviewQueue";
import { GrowthLearningPlans } from "@/components/amy-lab/growth/GrowthLearningPlans";
import { GrowthHistory } from "@/components/amy-lab/growth/GrowthHistory";
import type { EventBusEvent } from "@/types/chat";

// Amy Lab Phase 2: restructured from a flat tab bar into a "Memory Library"
// grouping (User/Amy/Projects/Memories/Knowledge/Session) - every existing
// feature relocated, nothing dropped, plus four new pieces (categorized
// profile, provenance drill-through, cross-source Timeline, real System
// Prompt sizes). See the plan doc for the research behind this split -
// categories only exist here where a real, already-grounded data source
// backs them.
const CATEGORIES = ["user", "amy", "growth", "projects", "memories", "knowledge", "session"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<Category, string> = {
  user: "User",
  amy: "Amy",
  growth: "Growth",
  projects: "Projects",
  memories: "Memories",
  knowledge: "Knowledge",
  session: "Session",
};

const SUB_TABS: Record<Category, { key: string; label: string }[]> = {
  user: [
    { key: "profile", label: "Profile" },
    { key: "instructions", label: "Instructions" },
  ],
  amy: [
    { key: "soul", label: "Soul" },
    { key: "learnings", label: "Learnings" },
    { key: "suggested-upgrades", label: "Suggested Upgrades" },
  ],
  growth: [
    { key: "overview", label: "Overview" },
    { key: "opportunities", label: "Opportunities" },
    { key: "review-queue", label: "Review Queue" },
    { key: "learning-plans", label: "Learning Plans" },
    { key: "history", label: "History" },
  ],
  projects: [
    { key: "entities", label: "Entities" },
    { key: "coding", label: "Coding" },
  ],
  memories: [
    { key: "decisions-facts", label: "Decisions & Facts" },
    { key: "timeline", label: "Timeline" },
  ],
  knowledge: [
    { key: "graph", label: "Graph" },
    { key: "files", label: "Files" },
  ],
  session: [
    { key: "trace", label: "Trace" },
    { key: "system-prompt", label: "System Prompt" },
  ],
};

function classificationSummary(payload: Record<string, unknown>) {
  const relevantGroups = Array.isArray(payload.relevantGroups) ? (payload.relevantGroups as string[]) : [];
  const relevantTools = Array.isArray(payload.relevantTools) ? (payload.relevantTools as string[]) : [];
  return { relevantGroups, relevantTools };
}

function ClassificationRow({ event }: { event: EventBusEvent }) {
  const { relevantGroups, relevantTools } = classificationSummary(event.payload);
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-zinc-400">What Amy decided about this turn</p>
        <span className="shrink-0 font-mono text-[10px] text-zinc-600">
          {new Date(event.occurred_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
        <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-indigo-300">
          toolPolicy: {String(event.payload.toolPolicy ?? "?")}
        </span>
        <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-violet-300">
          memoryPolicy: {String(event.payload.memoryPolicy ?? "?")}
        </span>
        {event.payload.needsPlanning === true && (
          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-amber-300">needs planning</span>
        )}
        {event.payload.background === true && (
          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">background</span>
        )}
      </div>
      {relevantGroups.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">Capability groups</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {relevantGroups.map((g) => (
              <span key={g} className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {g}
              </span>
            ))}
          </div>
        </div>
      )}
      {relevantTools.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">Tools bound this turn</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {relevantTools.map((t) => (
              <span key={t} className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">
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
    <div className="border-b border-white/10 p-3.5">
      <p className="mb-2 text-xs font-medium text-zinc-300">Leave feedback on this session</p>
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="mb-2 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-500/50"
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
        className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50"
      />
      <button
        onClick={submit}
        disabled={status === "sending" || !note.trim()}
        className="mt-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
      >
        {status === "sending" ? "Sending…" : "Submit feedback"}
      </button>
      {status === "sent" && <p className="mt-1 text-[10px] text-emerald-400">Saved.</p>}
      {status === "error" && <p className="mt-1 text-[10px] text-rose-400">Couldn&apos;t reach event-bus.</p>}
    </div>
  );
}

export function AmyLab() {
  const { sessions, activeSessionId, setActiveSessionId, startNewSession, isLoading } = useSessions();
  const eventsState = useEvents(activeSessionId);
  const [category, setCategory] = useState<Category>("session");
  const [subTab, setSubTab] = useState<string>("trace");
  // Provenance drill-through target (see EntitiesView's "View in Knowledge
  // Graph" button) - passed to KnowledgeGraphView as initialSelectedId.
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | undefined>();

  const selectCategory = (c: Category) => {
    setCategory(c);
    setSubTab(SUB_TABS[c][0].key);
  };

  const openSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setCategory("session");
    setSubTab("trace");
  };

  const viewInGraph = (graphitiId: string) => {
    setSelectedGraphNodeId(graphitiId);
    setCategory("knowledge");
    setSubTab("graph");
  };

  useEffect(() => {
    eventsState.refresh();
    // eventsState.refresh's identity changes with activeSessionId - this is
    // the re-fetch trigger when switching sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, eventsState.refresh]);

  const classificationEvents = eventsState.events.filter((e) => e.type === "message_classified").reverse();

  return (
    <div className="flex h-full w-full">
      <div className="hidden md:flex md:h-full">
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={setActiveSessionId}
          onNewSession={startNewSession}
          isLoading={isLoading}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-4 py-2">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => selectCategory(c)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                category === c ? "bg-indigo-500/10 font-medium text-indigo-300" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
              }`}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-4 py-1.5">
          {SUB_TABS[category].map((t) => (
            <button
              key={t.key}
              onClick={() => setSubTab(t.key)}
              className={`shrink-0 rounded-lg px-2.5 py-1 text-xs transition-colors ${
                subTab === t.key ? "bg-white/10 font-medium text-zinc-200" : "text-zinc-600 hover:bg-white/5 hover:text-zinc-400"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {category === "user" && subTab === "profile" && <UserProfileView />}
          {category === "user" && subTab === "instructions" && <UserInstructionsView />}

          {category === "amy" && subTab === "soul" && <PersonaView />}
          {category === "amy" && subTab === "learnings" && (
            <EntitiesView
              typeFilter={["learning"]}
              description="Discovered rules, lessons, and behavior-feedback-derived learnings - captured automatically from conversations."
              emptyMessage="Nothing yet - learnings are captured automatically from conversations and repeated behavior feedback."
              onOpenSession={openSession}
              onViewInGraph={viewInGraph}
            />
          )}
          {category === "amy" && subTab === "suggested-upgrades" && <SuggestedUpgrades />}

          {category === "growth" && subTab === "overview" && <GrowthOverview onNavigate={setSubTab} />}
          {category === "growth" && subTab === "opportunities" && <GrowthOpportunities />}
          {category === "growth" && subTab === "review-queue" && <GrowthReviewQueue />}
          {category === "growth" && subTab === "learning-plans" && <GrowthLearningPlans />}
          {category === "growth" && subTab === "history" && <GrowthHistory />}

          {category === "projects" && subTab === "entities" && (
            <EntitiesView
              typeFilter={["project"]}
              description="Completed projects Amy has had approved - each backed by a real write-up file."
              emptyMessage="Nothing yet - entities are created when a proposed project gets approved and completed."
              onOpenSession={openSession}
              onViewInGraph={viewInGraph}
            />
          )}
          {category === "projects" && subTab === "coding" && <CodingProjectBreakdown />}

          {category === "memories" && subTab === "decisions-facts" && (
            <EntitiesView
              typeFilter={["decision", "fact"]}
              description="Durable facts and decisions captured automatically from real conversations."
              emptyMessage="Nothing yet - facts/decisions are captured automatically when they come up in conversation."
              onOpenSession={openSession}
              onViewInGraph={viewInGraph}
            />
          )}
          {category === "memories" && subTab === "timeline" && <TimelineView />}

          {category === "knowledge" && subTab === "graph" && <KnowledgeGraphView initialSelectedId={selectedGraphNodeId} />}
          {category === "knowledge" && subTab === "files" && <FilesView />}

          {category === "session" && subTab === "trace" && (
            <>
              <p className="mb-3 text-xs text-zinc-500">
                Each turn&apos;s classify decision for this session - the dynamic half of what shapes Amy&apos;s system prompt.
                For the full picture (tool calls, research pulled, etc.) see the activity log →
              </p>
              {classificationEvents.length === 0 && (
                <p className="text-xs text-zinc-600">
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
          {category === "session" && subTab === "system-prompt" && <SystemPromptView />}
        </div>
      </div>
      <div className="hidden h-full w-96 flex-col border-l border-white/10 md:flex">
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

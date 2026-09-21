import type { Config } from "./config.js";

export interface TaskContextSummary {
  id: number;
  objective: string;
  status: string;
}

export interface GoalSummary {
  id: number;
  title: string;
  status: string;
}

// Part of the context-assembly pipeline (see the architecture plan):
// open task contexts are injected unconditionally, independent of
// memoryPolicy - directly actionable state, not ambient personalization.
// Degrades to an empty list rather than throwing, same "briefly-
// unreachable dependency shouldn't break the chat" pattern as everything
// else in this file.
export async function getOpenTaskContexts(config: Config): Promise<TaskContextSummary[]> {
  try {
    const res = await fetch(`${config.eventBusUrl}/task-contexts?status=open`);
    if (!res.ok) return [];
    const data = (await res.json()) as { taskContexts?: { id: number; objective: string; status: string }[] };
    return (data.taskContexts ?? []).map((t) => ({ id: t.id, objective: t.objective, status: t.status }));
  } catch (e) {
    console.error("getOpenTaskContexts failed:", e);
    return [];
  }
}

// Which active goals does this message's text match, via event-bus's
// deterministic keyword matcher (same one used for auto-progress-logging)
// - no LLM call, and self-limiting to genuinely relevant goals rather than
// surfacing every open goal every turn.
export async function matchGoals(config: Config, text: string): Promise<GoalSummary[]> {
  try {
    const url = new URL(`${config.eventBusUrl}/goals/match`);
    url.searchParams.set("text", text);
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as { goals?: GoalSummary[] };
    return data.goals ?? [];
  } catch (e) {
    console.error("matchGoals failed:", e);
    return [];
  }
}

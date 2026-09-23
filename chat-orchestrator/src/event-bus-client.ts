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

// Which open task contexts does this message's text actually relate to,
// via event-bus's lexeme-overlap matcher (mirroring matchGoals below).
// Real bug found via live dogfooding: task contexts used to be injected
// into every chat turn unconditionally regardless of topic ("directly
// actionable state, not ambient personalization" was the original
// reasoning) - in practice this meant a single standing personal
// reminder bled into and got conflated with completely unrelated
// conversations turn after turn. Degrades to an empty list rather than
// throwing, same "briefly-unreachable dependency shouldn't break the
// chat" pattern as everything else in this file.
export async function matchTaskContexts(config: Config, text: string): Promise<TaskContextSummary[]> {
  try {
    const url = new URL(`${config.eventBusUrl}/task-contexts/match`);
    url.searchParams.set("text", text);
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as { taskContexts?: TaskContextSummary[] };
    return data.taskContexts ?? [];
  } catch (e) {
    console.error("matchTaskContexts failed:", e);
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

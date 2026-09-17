import type { Config } from "./config.js";
import type { EventRow, GoalRow } from "./db.js";
import * as db from "./db.js";

// Intentionally the simplest possible matcher - substring containment, no
// stemming/fuzzing/embeddings, no LLM call. This will miss synonyms (a real,
// accepted v1 gap - the same class of limitation skill_gap_scanner's dedup
// step originally had before an LLM step was added there only once real
// usage showed it was needed).
export function matchKeywords(goal: Pick<GoalRow, "keywords">, event: Pick<EventRow, "type" | "source" | "payload">): string[] {
  const haystack = `${event.type} ${event.source} ${JSON.stringify(event.payload)}`.toLowerCase();
  return goal.keywords.filter((kw) => kw && haystack.includes(kw.toLowerCase()));
}

// Runs unconditionally on every ingested event, independent of whether
// classify.ts decided to notify.
export async function matchEventToGoals(config: Config, event: EventRow): Promise<void> {
  const goals = await db.listActiveGoals(config);
  if (goals.length === 0) return;

  for (const goal of goals) {
    const matched = matchKeywords(goal, event);
    if (matched.length === 0) continue;

    await db.insertProgressLog(config, goal.id, event.id, `matched keywords: ${matched.join(", ")}`);
    await db.touchGoal(config, goal.id);
  }
}

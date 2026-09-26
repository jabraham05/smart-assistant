import type { Config } from "./config.js";
import type { EventRow, GoalRow } from "./db.js";
import * as db from "./db.js";
import { summarizeEvent } from "./activity.js";

// Intentionally the simplest possible matcher - substring containment, no
// stemming/fuzzing/embeddings, no LLM call. This will miss synonyms (a real,
// accepted v1 gap - the same class of limitation skill_gap_scanner's dedup
// step originally had before an LLM step was added there only once real
// usage showed it was needed).
export function matchKeywords(goal: Pick<GoalRow, "keywords">, event: Pick<EventRow, "type" | "source" | "payload">): string[] {
  const haystack = `${event.type} ${event.source} ${JSON.stringify(event.payload)}`.toLowerCase();
  return goal.keywords.filter((kw) => kw && haystack.includes(kw.toLowerCase()));
}

// Reuses matchKeywords for the context-assembly pipeline's "relevant
// goals" injection (see the architecture plan's Phase 4) by wrapping a
// chat message in the same {type, source, payload} shape matchKeywords
// already expects - a chat message and an ingested event are both just
// "some text a goal's keywords might match," no reason for a second
// matcher.
export function matchGoalsToText(goals: Pick<GoalRow, "id" | "title" | "status" | "keywords">[], text: string): Pick<GoalRow, "id" | "title" | "status" | "keywords">[] {
  const pseudoEvent: Pick<EventRow, "type" | "source" | "payload"> = {
    type: "chat_message",
    source: "chat",
    payload: { text },
  };
  return goals.filter((goal) => matchKeywords(goal, pseudoEvent).length > 0);
}

// Runs unconditionally on every ingested event, independent of whether
// classify.ts decided to notify.
export async function matchEventToGoals(config: Config, event: EventRow): Promise<void> {
  const goals = await db.listActiveGoals(config);
  if (goals.length === 0) return;

  for (const goal of goals) {
    const matched = matchKeywords(goal, event);
    if (matched.length === 0) continue;

    // Real, live-verified finding: this used to store the raw matcher's own
    // debug output (`matched keywords: attempt, service, end`) as the
    // progress note - internal matching mechanics, not something meant for
    // a user to ever see. goal_manage's action='progress' returns these
    // notes verbatim to the model, which then faithfully paraphrased the
    // raw keyword list straight into a Discord reply. summarizeEvent()
    // already exists for exactly this purpose (home-activity's digest feed)
    // - describe what actually happened, not which keywords fired.
    await db.insertProgressLog(config, goal.id, event.id, summarizeEvent(event));
    await db.touchGoal(config, goal.id);
  }
}

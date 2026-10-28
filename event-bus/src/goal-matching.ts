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
//
// 2026-10-27, real live-verified bug: a single generic keyword (a goal
// auto-derived "skills"/"practice"/"budget" from its own title/description -
// index.ts's deriveKeywords only filters grammatical stopwords, not common
// content words) was enough to match completely unrelated messages ("what
// skills do you have?" wrongly matched a goal titled "Get better at
// cooking"). Fixed here, not in matchKeywords itself, because matchKeywords
// is shared with matchEventToGoals below (real progress-tracking off actual
// system events) where a single genuine keyword hit is real signal worth
// keeping - this function alone needs the stricter bar, since injecting an
// irrelevant goal into every turn's context is actively harmful in a way a
// slightly-less-complete progress log isn't. Requires 2+ independent
// keyword matches before trusting a hit as real relevance, unless the goal
// only ever had one keyword to begin with (then that's still the best
// signal available, not a reason to never match it at all).
export function matchGoalsToText(goals: Pick<GoalRow, "id" | "title" | "status" | "keywords">[], text: string): Pick<GoalRow, "id" | "title" | "status" | "keywords">[] {
  const pseudoEvent: Pick<EventRow, "type" | "source" | "payload"> = {
    type: "chat_message",
    source: "chat",
    payload: { text },
  };
  return goals.filter((goal) => {
    const matched = matchKeywords(goal, pseudoEvent).length;
    return goal.keywords.length < 2 ? matched > 0 : matched >= 2;
  });
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

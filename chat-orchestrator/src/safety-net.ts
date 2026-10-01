// Only the mechanism-independent checks from the old n8n Chat workflow's
// safety net survive this migration. The elaborate regex zoo in the old
// "Detect Garbage Output" node (leaked MCP error strings, leaked internal
// node/tool names, fake tool-call JSON blobs, "function call" narration) was
// specifically symptomatic of the two n8n-specific bugs this migration
// removes (the MCP Client Tool node's tool-name segment-length limit, and
// lmChatOllama losing tool_calls on a `thinking` response) - those failure
// shapes shouldn't occur here at all, since agent-loop.ts detects a real
// tool call structurally (message.tool_calls), never by parsing prose. The
// two checks below are kept because they're real regardless of mechanism:
// a model can still narrate an unfinished search, or claim it did
// something without actually calling the tool that would do it.

// Same tool list as the old "confabulated action" backstop - tools whose
// whole point is performing a real side effect, where a claim of success
// with no matching call is worth catching.
export const ACTION_TOOLS = [
  "goal_manage",
  "calendar_event",
  "spotify_control",
  "dashboard_control",
  "code_task",
  "skill_propose",
  "research_task",
  "project_propose",
  // Real gap found via live testing: task_context_manage is always bound
  // (see ALWAYS_BOUND_TOOLS below), so on a turn where nothing else got
  // classified/bound, "I've created a task for X" with no real call
  // slipped past confabulation detection entirely - hadActionToolBound
  // was false because this wasn't in the list, short-circuiting the check.
  "task_context_manage",
  "project_complete",
];

// Real gap found via live testing: "I've proposed a project for X" slipped
// past this check entirely (project_propose is in ACTION_TOOLS below, but
// "proposed"/"approved" weren't in this verb list) - the model confabulated
// having called the tool with no detection at all. Added those plus a few
// other real action-tool verbs (skill_propose, code_task) this list was
// missing for the same reason.
const CLAIMS_COMPLETED_ACTION =
  /\b(?:I['’]?ve|I have)\s+(added|noted|created|set\s?up|scheduled|deleted|removed|updated|started|paused|resumed|played|queued|turned|proposed|approved|rejected|submitted|kicked off|built|fixed|completed|finished|consolidated|wrapped up)\b/i;
const CLAIMS_COMPLETED_ACTION_PASSIVE =
  /\b(?:has|have)\s+been\s+(added|noted|created|set\s?up|scheduled|deleted|removed|updated|started|paused|resumed|played|queued|proposed|approved|rejected|submitted|built|fixed|completed|finished|consolidated)\b/i;

// True when the reply claims to have performed a real action but no
// matching action tool was actually invoked this turn - the model likely
// confabulated a completed action. `calledTools` is whatever
// runAgentLoop's onToolCalls collected across every iteration of this turn.
export function isConfabulatedAction(replyText: string, boundTools: string[], calledTools: string[]): boolean {
  const hadActionToolBound = boundTools.some((t) => ACTION_TOOLS.includes(t));
  const claimsCompleted = CLAIMS_COMPLETED_ACTION.test(replyText) || CLAIMS_COMPLETED_ACTION_PASSIVE.test(replyText);
  if (!claimsCompleted) return false;
  const actuallyCalledAction = calledTools.some((t) => ACTION_TOOLS.includes(t));
  return hadActionToolBound && !actuallyCalledAction;
}

const UNFULFILLED_SEARCH_INTENT =
  /\b(I['’]?ll|I will|let me|hold on|give me a (moment|second))\b[^.!?]{0,60}\b(try|search|look(ing)?|refin(e|ing)|check|find|research(ing)?)\b/i;

const SEARCH_TOOLS = ["web_search", "knowledge_search", "research_task"];

// True when the reply talks about searching/checking but no search tool
// was actually called this turn, and a search tool was available to call -
// same narrow signal the old "Detect Unfulfilled Search Intent" node used.
export function hasUnfulfilledSearchIntent(replyText: string, boundTools: string[], calledTools: string[]): boolean {
  const hadSearchTool = boundTools.some((t) => SEARCH_TOOLS.includes(t));
  const actuallySearched = calledTools.some((t) => SEARCH_TOOLS.includes(t));
  return hadSearchTool && !actuallySearched && UNFULFILLED_SEARCH_INTENT.test(replyText);
}

export const SEARCH_RETRY_NUDGE =
  " (Your last attempt said you'd search again but didn't actually call the tool - actually call " +
  "web_search, knowledge_search, or research_task again (whichever fits) right now with a " +
  "meaningfully different query before replying. Briefly let the user know you're trying a " +
  "different angle.)";

// Tools that don't count toward toolPolicy=required - both are bound to
// every turn regardless of classification (see classify-tools.ts's
// expandGroupsToTools), so their presence says nothing about whether the
// classifier's actual required capability was used.
const ALWAYS_BOUND_TOOLS = ["calculate", "task_context_manage"];

// True when the classifier decided this message needed live/authoritative
// data or a real action (toolPolicy=required, see classify-tools.ts), a
// capability-specific tool was actually bound this turn, and none of them
// were called - the deterministic version of the old confabulation
// heuristic: instead of waiting for the reply to *claim* an action
// happened, this catches the model answering conversationally (or from
// its own training data) when it was supposed to check first.
export function hasUnsatisfiedRequiredTool(
  toolPolicy: string,
  boundTools: string[],
  calledTools: string[],
  relevantGroups: string[] = [],
): boolean {
  if (toolPolicy !== "required") return false;
  // Real bug found via live testing: "list my open tasks" classified into
  // 'goals' (binding goal_manage/project_propose/status_overview) but was
  // correctly answered by task_context_manage instead - a real, genuine
  // overlap (both track "things to do"), not a wrong tool choice. The
  // successful task_context_manage call still got overridden by the
  // hardcoded failure message below, because it only ever satisfied this
  // check when it was the ONLY bound tool at all - any other 'goals' tool
  // being bound too made a genuinely correct answer look like a failure.
  if (relevantGroups.includes("goals") && calledTools.includes("task_context_manage")) {
    return false;
  }
  const boundCapabilityTools = boundTools.filter((t) => !ALWAYS_BOUND_TOOLS.includes(t));
  if (boundCapabilityTools.length > 0) {
    return !boundCapabilityTools.some((t) => calledTools.includes(t));
  }
  // Real gap found via live testing: "create a task to do X" has no
  // classifier category of its own (task_context_manage is always bound,
  // not tied to a group), so boundCapabilityTools was always empty for
  // these turns and this check short-circuited to false unconditionally -
  // the model could say "I'll keep that in mind" and never call anything,
  // with no deterministic backstop at all. If nothing else was bound but
  // task_context_manage was, and toolPolicy=required, that's still an
  // unsatisfied requirement.
  return boundTools.includes("task_context_manage") && !calledTools.includes("task_context_manage");
}

export const REQUIRED_TOOL_RETRY_NUDGE =
  " (This needs real, current information or an actual action, not a guess - actually call the " +
  "relevant tool right now before replying, then answer based on what it actually returns.)";

export const REQUIRED_TOOL_FAILURE_MESSAGE =
  "I wasn't able to complete that using my tools just now — want me to try again?";

// Deterministic provenance tag for a memory_entries write - real incident
// that motivated this: an invented, plausible-sounding API name ("Qwen3.8-
// LiveTranslate API") written with zero tool calls got stored into memory,
// then retrieved and cited as "confirmed research" in later unrelated
// conversations, compounding across 17 memory rows over 9 days before being
// found and purged. NOT a truth check (a tool call doesn't guarantee the
// reply is correct) - just a provenance signal distinguishing open-book
// turns from the model's own generated prose, at the same turn-level
// granularity as isConfabulatedAction/hasUnsatisfiedRequiredTool above.
// role='user' is the user's own statement, never penalized for zero tool
// activity (most user turns have none - that's normal, not a grounding
// failure). role='assistant' is tool_verified only if at least one tool was
// actually called this turn, else ungrounded.
export function classifyMemoryGrounding(role: "user" | "assistant", calledTools: string[]): string {
  if (role === "user") return "user_stated";
  return calledTools.length > 0 ? "tool_verified" : "ungrounded";
}

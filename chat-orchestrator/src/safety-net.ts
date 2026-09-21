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
];

const CLAIMS_COMPLETED_ACTION =
  /\b(?:I['’]?ve|I have)\s+(added|noted|created|set\s?up|scheduled|deleted|removed|updated|started|paused|resumed|played|queued|turned)\b/i;
const CLAIMS_COMPLETED_ACTION_PASSIVE =
  /\b(?:has|have)\s+been\s+(added|noted|created|set\s?up|scheduled|deleted|removed|updated|started|paused|resumed|played|queued)\b/i;

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

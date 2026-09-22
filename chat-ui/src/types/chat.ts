export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps?: StepEvent[];
  rawEvents?: N8nStreamEvent[];
  // Readable turn trace (tool-group classification, each tool call/result,
  // retries) - see ChatTraceEvent. Empty/undefined for plain replies with no
  // tool calls or retries.
  trace?: ChatTraceEvent[];
  // True when the AI Agent's stream ended with zero tokens (a known,
  // documented reliability gap - see README's tool-calling gotcha section).
  // The fallback chain still corrects Honcho/Postgres memory for future
  // turns, but the streaming response has already closed by the time it
  // runs, so this turn's reply is genuinely empty - flagged here so the UI
  // can show something instead of a blank bubble.
  isEmpty?: boolean;
}

export interface ChatRequest {
  message: string;
  sessionId: string;
}

// Raw event shape streamed by chat-orchestrator (and, before it, n8n's Chat
// Trigger with responseMode: "streaming" - the wire contract was kept
// identical on purpose, see docs/chat-orchestrator.md). "trace" is the one
// addition chat-orchestrator makes on top of that original contract -
// discord-bot ignores it safely since it only ever looks for type:"item".
export interface N8nStreamEvent {
  type: "begin" | "item" | "end" | "error" | "trace";
  content?: string;
  trace?: ChatTraceEvent;
  metadata: {
    nodeId: string;
    nodeName: string;
    itemIndex: number;
    runIndex: number;
    timestamp: number;
  };
}

// A readable account of what chat-orchestrator actually did for a turn -
// which tools it decided were relevant, each tool it called (with args and
// the result that came back), and any retry it had to trigger. Mirrors
// chat-orchestrator's own ChatTraceEvent (src/index.ts) field-for-field.
export type ChatTraceEvent =
  | {
      kind: "classify";
      boundTools: string[];
      relevantGroups: string[];
      toolPolicy: string;
      memoryPolicy: string;
      needsPlanning: boolean;
      background: boolean;
      openTasks: { id: number; objective: string; status: string }[];
      relevantGoals: { id: number; title: string; status: string }[];
      memories: { content: string; domain: string | null; score: number }[];
    }
  | { kind: "tool_call"; attempt: number; iteration: number; name: string; args: Record<string, unknown> }
  | { kind: "tool_result"; attempt: number; iteration: number; name: string; result: string; isError: boolean }
  | { kind: "retry"; attempt: number; reason: "empty_output" | "search_intent" | "confabulation" | "required_tool" };

export type StepKind = "thinking" | "tool_call" | "message_sent" | "data_saved" | "other";

// A node's lifecycle as tracked client-side, derived from N8nStreamEvent.
export interface StepEvent {
  nodeId: string;
  nodeName: string;
  kind: StepKind;
  label: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
}

export interface HonchoSession {
  id: string;
  is_active: boolean;
  created_at: string;
}

export type SessionOrigin = "discord" | "cli" | "chat";

// Server-enriched session for the sidebar (see lib/honcho-client.ts's
// listRealSessions) - raw Honcho sessions/list is unfiltered and includes
// one-way, amy-only "sessions" from background notification paths
// (coding-orchestrator, event-bus nudges) alongside genuine
// conversations, and has no notion of "most recently active." Both are
// fixed here rather than in Honcho itself.
export interface EnrichedSession extends HonchoSession {
  origin: SessionOrigin;
  lastMessageAt: string;
  preview: string;
}

export interface HonchoMessage {
  id: string;
  content: string;
  peer_id: string;
  session_id: string;
  created_at: string;
}

// Matches event-bus's EventRow (src/db.ts) - the append-only audit trail
// every ingested event lands in, even when classify.ts decides not to
// notify on it. See docs/event-bus-and-goals.md.
export interface EventBusEvent {
  id: number;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  origin_session_id: string | null;
  priority: string;
  should_notify: boolean;
  status: string;
  notified_at: string | null;
  created_at: string;
}

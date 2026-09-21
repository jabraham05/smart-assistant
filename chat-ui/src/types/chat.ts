export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps?: StepEvent[];
  rawEvents?: N8nStreamEvent[];
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

// Raw event shape streamed by n8n's Chat Trigger (responseMode: "streaming").
export interface N8nStreamEvent {
  type: "begin" | "item" | "end" | "error";
  content?: string;
  metadata: {
    nodeId: string;
    nodeName: string;
    itemIndex: number;
    runIndex: number;
    timestamp: number;
  };
}

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

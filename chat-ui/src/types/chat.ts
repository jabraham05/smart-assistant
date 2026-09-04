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

export interface HonchoMessage {
  id: string;
  content: string;
  peer_id: string;
  session_id: string;
  created_at: string;
}

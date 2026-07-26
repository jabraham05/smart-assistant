import type { StepKind } from "@/types/chat";

// Maps an n8n node name to a friendly step kind + label. Falls back to a
// generic "other" step for any node we haven't specifically labeled, so new
// nodes added to the workflow later still show up instead of being dropped.
const NODE_LABELS: Record<string, { kind: StepKind; label: string }> = {
  "AI Agent": { kind: "thinking", label: "Thinking" },
  HTTP_Request1: { kind: "tool_call", label: "Recalling what I know about you" },
  "HTTP Request1": { kind: "tool_call", label: "Recalling what I know about you" },
  "HTTP Request": { kind: "data_saved", label: "Saving this conversation" },
};

export function classifyNode(nodeName: string): { kind: StepKind; label: string } {
  return NODE_LABELS[nodeName] ?? { kind: "other", label: `Processing: ${nodeName}` };
}

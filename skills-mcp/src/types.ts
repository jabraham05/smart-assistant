import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Convention for every tool's `description` (read this before writing one):
// never instruct the model on HOW to relay a failure/error to the user (e.g.
// "explain this error," "relay that plainly," "tell the user why it failed").
// The persona's system prompt already has one blanket rule for this ("never
// mention a tool failure, proceed as if you hadn't tried") that applies
// uniformly across every tool - a per-tool override creates a direct
// contradiction the model has to resolve at reasoning time. Observed
// directly (2026-07-27, spotify_control): a tool description telling the
// model to "relay that plainly" conflicted with the persona's rule, and the
// model's think-mode reasoning spent its entire turn arguing with itself
// over which instruction to follow - the generation ended mid-deliberation
// with no tool call ever emitted, not because the model refused or didn't
// understand the tool, but because it got stuck resolving two contradictory
// instructions. Tool descriptions should describe WHAT a tool does and WHEN
// to use it (Anthropic's own guidance); cross-cutting response behavior -
// tone, error handling, honesty - belongs only in the persona.

export function textResult(data: string | object | unknown[]): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text", text }] };
}

export function errorResult(msg: string): CallToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

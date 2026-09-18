import type { SearchResult } from "./search.js";

export interface RouteDecision {
  source: "knowledge" | "web";
  reason: string;
}

// Deterministic, not an LLM call - this project has repeatedly hit real
// qwen3:8b tool-selection reliability failures at exactly this kind of
// decision point (see docs/chat-workflow.md's tool-calling gotcha and
// docs/coding-agent-pipeline.md's MCP tool-name-segment-length bug), so a
// research router is exactly the wrong place to introduce a new one.
// Staleness is already handled upstream: search() excludes expired
// (valid_until) documents by default, so a "best match is stale" case
// simply surfaces here as "no good knowledge-base result," not a separate
// check.
export function decideRoute(topResult: SearchResult | undefined, threshold: number): RouteDecision {
  if (!topResult) {
    return { source: "web", reason: "no matching chunks in the knowledge base" };
  }
  if (topResult.score < threshold) {
    return {
      source: "web",
      reason: `top knowledge-base match scored ${topResult.score.toFixed(4)}, below the ${threshold} threshold`,
    };
  }
  return {
    source: "knowledge",
    reason: `top knowledge-base match scored ${topResult.score.toFixed(4)}, met the ${threshold} threshold`,
  };
}

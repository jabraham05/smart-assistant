import type { SearchResult } from "./search.js";

export interface RouteDecision {
  source: "knowledge" | "web";
  reason: string;
}

// Deterministic, not an LLM call - this project has repeatedly hit real
// qwen3:8b tool-selection reliability failures at exactly this kind of
// decision point (see docs/chat-workflow.md's tool-calling gotcha and
// docs/coding-agent-pipeline.md's MCP tool-name-segment-length bug), so a
// research router is exactly the wrong place to introduce a new one. The
// keyword-overlap gate below is the same kind of check: a plain SQL-derived
// count, not a semantic judgment call.
//
// Staleness is already handled upstream: search() excludes expired
// (valid_until) documents by default, so a "best match is stale" case
// simply surfaces here as "no good knowledge-base result," not a separate
// check.
//
// minKeywordOverlap exists because the RRF score alone can't tell a
// genuine match from an unrelated same-domain "best of a bad bunch": real
// live testing found a genuine brake-fluid match and a completely
// unrelated "Nissan GT-R" query against a Porsche-only knowledge base
// scoring nearly identically (~0.0164 both), because a domain-filtered
// vector search always ranks *something* top-K regardless of true
// relevance. Skipped entirely when the query itself has no significant
// lexemes (queryLexemeCount === 0, e.g. an all-stopword query) - there's
// no real signal to check in that case, so it falls back to pure
// RRF-threshold behavior rather than force-failing.
export function decideRoute(
  topResult: SearchResult | undefined,
  threshold: number,
  minKeywordOverlap: number = 1,
): RouteDecision {
  if (!topResult) {
    return { source: "web", reason: "no matching chunks in the knowledge base" };
  }
  if (topResult.score < threshold) {
    return {
      source: "web",
      reason: `top knowledge-base match scored ${topResult.score.toFixed(4)}, below the ${threshold} threshold`,
    };
  }
  if (topResult.queryLexemeCount > 0 && topResult.keywordOverlapCount < minKeywordOverlap) {
    return {
      source: "web",
      reason:
        `top knowledge-base match scored ${topResult.score.toFixed(4)} (met the ${threshold} threshold) but shared ` +
        `only ${topResult.keywordOverlapCount} keyword(s) with the query (need ${minKeywordOverlap}) - likely a ` +
        `vector-similarity coincidence, not a real match`,
    };
  }
  return {
    source: "knowledge",
    reason: `top knowledge-base match scored ${topResult.score.toFixed(4)}, met the ${threshold} threshold`,
  };
}

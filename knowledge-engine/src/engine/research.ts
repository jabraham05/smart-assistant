import type { Config } from "../config.js";
import { search, type SearchResult } from "./search.js";
import { decideRoute, type RouteDecision } from "./router.js";
import { runResearchAgent } from "./research-agent.js";
import { clusterFindings } from "./cluster-findings.js";
import { verifyClusters, type VerifiedFinding } from "./verify.js";

export interface ResearchInput {
  query: string;
  domain?: string;
}

// Phase 2 added the router; Phase 3 replaces the web branch's old
// single-Tavily-search-and-fetch with the full multi-step agent
// (research-agent.ts) plus deterministic clustering + LLM-verified
// contradiction detection - the knowledge branch is untouched, since an
// agent loop would be pure overkill when the knowledge base already has a
// good enough answer.
export interface ResearchResult {
  route: RouteDecision;
  knowledgeResults: SearchResult[];
  findings?: VerifiedFinding[];
  agentIterations?: number;
  agentExhaustedIterations?: boolean;
}

export async function research(config: Config, input: ResearchInput): Promise<ResearchResult> {
  const knowledgeResults = await search(config, { query: input.query, domain: input.domain, topK: 5 });
  const route = decideRoute(knowledgeResults[0], config.routeToWebThreshold);

  if (route.source === "knowledge") {
    return { route, knowledgeResults };
  }

  if (!config.tavilyApiKey) {
    throw new Error("web escalation needed but TAVILY_API_KEY is not configured");
  }

  const agentResult = await runResearchAgent(config, input.query, input.domain);
  const clusters = clusterFindings(agentResult.findings, input.query);
  const findings = await verifyClusters(config, clusters);

  return {
    route,
    knowledgeResults,
    findings,
    agentIterations: agentResult.iterations,
    agentExhaustedIterations: agentResult.exhaustedIterations,
  };
}

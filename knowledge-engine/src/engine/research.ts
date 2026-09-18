import type { Config } from "../config.js";
import { search, type SearchResult } from "./search.js";
import { decideRoute, type RouteDecision } from "./router.js";
import { runResearchAgent } from "./research-agent.js";
import { clusterFindings } from "./cluster-findings.js";
import { verifyClusters, type VerifiedFinding } from "./verify.js";
import { persistResearch } from "./persist-research.js";

export interface ResearchInput {
  query: string;
  domain?: string;
  triggerSource?: string;
  originSessionId?: string;
}

// Phase 2 added the router; Phase 3 replaced the web branch's old
// single-Tavily-search-and-fetch with the full multi-step agent plus
// contradiction detection; Phase 4 persists a web-escalated run (remember())
// so it's findable later - the knowledge branch is untouched throughout,
// since none of this (agent loop, persistence) is needed when the
// knowledge base already has a good enough answer.
export interface ResearchResult {
  route: RouteDecision;
  knowledgeResults: SearchResult[];
  findings?: VerifiedFinding[];
  agentIterations?: number;
  agentExhaustedIterations?: boolean;
  sessionId?: number;
  documentId?: number;
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

  const persisted = await persistResearch(config, {
    topic: input.query,
    domain: input.domain,
    triggerSource: input.triggerSource,
    originSessionId: input.originSessionId,
    findings,
  });

  return {
    route,
    knowledgeResults,
    findings,
    agentIterations: agentResult.iterations,
    agentExhaustedIterations: agentResult.exhaustedIterations,
    sessionId: persisted.sessionId,
    documentId: persisted.documentId,
  };
}

import type { Config } from "../config.js";
import * as db from "../db.js";
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

export interface ResearchResult {
  route: RouteDecision;
  knowledgeResults: SearchResult[];
  findings?: VerifiedFinding[];
  agentIterations?: number;
  agentExhaustedIterations?: boolean;
  sessionId?: number;
  documentId?: number;
}

// The fast half only: knowledge search + the deterministic routing
// decision. Always synchronous - this alone is fast enough that a caller
// (an MCP tool call, a direct HTTP client) can wait on it directly.
export async function checkKnowledge(
  config: Config,
  input: Pick<ResearchInput, "query" | "domain">,
): Promise<{ route: RouteDecision; knowledgeResults: SearchResult[] }> {
  const knowledgeResults = await search(config, { query: input.query, domain: input.domain, topK: 5 });
  const route = decideRoute(knowledgeResults[0], config.routeToWebThreshold);
  return { route, knowledgeResults };
}

// The slow half: the full multi-step agent loop, contradiction detection,
// and persistence. Genuinely slow (a real agent run took over a minute in
// Phase 3 testing) - callers that can't block for that long should run
// this without awaiting it (see index.ts's POST /research handler) against
// an already-created research_sessions row, updating its status when done
// rather than returning a value directly.
export async function runWebResearchAndPersist(config: Config, input: ResearchInput, sessionId: number): Promise<void> {
  try {
    const agentResult = await runResearchAgent(config, input.query, input.domain);
    const clusters = clusterFindings(agentResult.findings, input.query);
    const findings = await verifyClusters(config, clusters);

    await persistResearch(config, {
      topic: input.query,
      domain: input.domain,
      triggerSource: input.triggerSource,
      originSessionId: input.originSessionId,
      findings,
      existingSessionId: sessionId,
    });
  } catch (e) {
    console.error(`background research failed (session ${sessionId}):`, e);
    await db.updateResearchSessionStatus(config, sessionId, "failed");
  }
}

// Full synchronous run: knowledge check, and if needed, the entire agent
// loop + persistence, awaited end-to-end. Used directly by tests and any
// caller that genuinely can afford to block (not the skills-mcp tool,
// which uses checkKnowledge + runWebResearchAndPersist separately so a
// real research run doesn't hang a Chat tool call for over a minute).
export async function research(config: Config, input: ResearchInput): Promise<ResearchResult> {
  const { route, knowledgeResults } = await checkKnowledge(config, input);

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

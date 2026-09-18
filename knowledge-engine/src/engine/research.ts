import type { Config } from "../config.js";
import { search, type SearchResult } from "./search.js";
import { decideRoute, type RouteDecision } from "./router.js";
import { tavilySearch } from "../lib/tavily.js";
import { extractUrl } from "../lib/html-extract.js";

export interface ResearchInput {
  query: string;
  domain?: string;
}

export interface WebFinding {
  url: string;
  title: string;
  content: string;
}

// Phase 2 scope: one routing decision, one round of web search if needed -
// not yet the multi-step, contradiction-aware agent loop (Phase 3) or
// persisted research sessions (Phase 4). Synchronous for now since this is
// fast enough; becomes fire-and-forget once Phase 3's agent loop makes a
// single call potentially slow.
export interface ResearchResult {
  route: RouteDecision;
  knowledgeResults: SearchResult[];
  webFindings?: WebFinding[];
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

  const tavilyResults = await tavilySearch(config.tavilyApiKey, input.query, { maxResults: 3 });
  const webFindings: WebFinding[] = [];
  for (const result of tavilyResults) {
    try {
      const extracted = await extractUrl(result.url);
      webFindings.push({ url: result.url, title: extracted.title || result.title, content: extracted.text });
    } catch {
      // A single page failing to extract (paywall, JS-only rendering, etc.)
      // shouldn't sink the whole call - fall back to Tavily's own short
      // content excerpt for that one result instead of dropping it.
      webFindings.push({ url: result.url, title: result.title, content: result.content });
    }
  }

  return { route, knowledgeResults, webFindings };
}

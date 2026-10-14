import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { knowledgeSearch } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// Real, live-verified incident: combining topK=3 saved-knowledge chunks with
// maxWebSources=3 (up to 5 passages) and returning each one's full,
// untruncated content produced a 34KB tool result in one real test, which
// then blew the model's own output token budget before any response was
// generated at all (pydantic_ai.exceptions.UnexpectedModelBehavior) - and a
// retry that piled on a second raw ~41KB web_search result on top of that
// produced a bizarre, off-topic "Search Refinement Plan" reply instead of an
// answer. Capping each item's content here, not raising maxWebSources/topK's
// own caps - those already bound how many results come back; this bounds
// how much raw text each one is allowed to carry into the model's context.
const _MAX_CONTENT_CHARS = 600;

function truncate(text: string): string {
  return text.length > _MAX_CONTENT_CHARS ? `${text.slice(0, _MAX_CONTENT_CHARS)}…` : text;
}

interface WebPassage {
  text: string;
  url: string;
  title: string;
  score: number;
}

/** One factual lookup across saved world knowledge and the live web. */
export function registerKnowledgeLookup(server: McpServer, config: Config): void {
  server.registerTool(
    "knowledge_lookup",
    {
      title: "Look up information",
      description:
        "Search Amy's saved documents and past research AND the live web together for an immediate " +
        "factual answer. Results are labeled by source and include citations. Use this for facts, " +
        "reference material, current information, or when unsure. This is a lookup only; it does not " +
        "start or save a research task. Growth decides what deserves ongoing research, and the Research " +
        "agent creates or updates the saved knowledge document. For facts about what the user told Amy, " +
        "use memory_recall. If neither source supports an answer, say you could not verify it.",
      inputSchema: {
        query: z.string().min(1, "query must not be empty").describe("What to look up."),
        domain: z.string().optional().describe("Optional topic area, such as automotive or Warframe."),
        topK: z.coerce.number().int().min(1).max(5).optional().describe("Saved-knowledge results, 1-5; defaults to 3."),
        maxWebSources: z.coerce.number().int().min(1).max(5).optional().describe("Web sources to inspect, 1-5; defaults to 3."),
      },
    },
    async ({ query, domain, topK, maxWebSources }) => {
      const [knowledge, web] = await Promise.allSettled([
        knowledgeSearch(config, query, { domain, topK: topK ?? 3 }),
        (async () => {
          if (!config.tavilyApiKey) throw new Error("Web search is not configured (TAVILY_API_KEY not set).");
          const response = await fetch(`${config.knowledgeEngineUrl}/web-search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, maxSources: maxWebSources ?? 3, maxPassages: 5 }),
            signal: AbortSignal.timeout(35_000),
          });
          if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`Web search failed: ${response.status} ${body}`.trim());
          }
          return (await response.json()) as { passages: WebPassage[]; noMatch: boolean };
        })(),
      ]);

      const results: Record<string, unknown> = { query };
      if (knowledge.status === "fulfilled") {
        results.savedKnowledge = knowledge.value.map((k) => ({ ...k, content: truncate(k.content) }));
      } else results.savedKnowledgeError = knowledge.reason instanceof Error ? knowledge.reason.message : String(knowledge.reason);
      if (web.status === "fulfilled") {
        results.web = web.value.noMatch
          ? { noMatch: true, results: [] }
          : {
              noMatch: false,
              results: web.value.passages.map((p) => ({ title: p.title, url: p.url, content: truncate(p.text) })),
            };
      } else results.webError = web.reason instanceof Error ? web.reason.message : String(web.reason);

      if (knowledge.status === "rejected" && web.status === "rejected") {
        return errorResult(`knowledge_lookup failed: ${JSON.stringify(results)}`);
      }
      return textResult(results);
    },
  );
}

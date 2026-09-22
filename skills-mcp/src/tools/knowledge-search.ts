import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { knowledgeSearch } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// Not chatSessionId-scoped - the whole point of knowledge recall is that
// anything ingested or researched in any past conversation (or triggered
// autonomously by skill_gap_scanner) is findable from any other. Replaces
// the old research_search tool.
export function registerKnowledgeSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "knowledge_search",
    {
      title: "Search Amy's knowledge base",
      description:
        "Search documents and past research Amy already has - ingested manuals/notes, saved web " +
        "pages, and previously-completed research - returning the most relevant excerpts with " +
        "their source cited. Use this before starting new research with research_task, to check " +
        "whether something is already known. Synthesize a short answer in your own words from " +
        "these excerpts and cite the source - don't paste multiple excerpts verbatim into the " +
        "chat reply.",
      inputSchema: {
        query: z.string().min(1, "query must not be empty").describe("What to search for."),
        domain: z.string().optional().describe("Narrow the search to one topic area, if known (e.g. 'automotive', 'warframe')."),
        // coerce, not number(): the model sometimes sends a stringified
        // number for fields like this - see web-search.ts for the real
        // production failure this pattern is fixed for. Max lowered from
        // the original 10 (default 3, not 5) after research_task_status's
        // own live-tested lesson: don't hand the model more raw content
        // than it needs, since it won't reliably self-limit once it has it.
        topK: z.coerce.number().int().min(1).max(5).optional().describe("How many results to return, 1-5. Defaults to 3."),
      },
    },
    async ({ query, domain, topK }) => {
      try {
        const results = await knowledgeSearch(config, query, { domain, topK: topK ?? 3 });
        if (results.length === 0) return textResult("No matching results in the knowledge base.");
        return textResult({ query, results });
      } catch (e) {
        return errorResult(`knowledge_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

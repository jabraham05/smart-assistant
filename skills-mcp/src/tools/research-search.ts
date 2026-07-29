import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { searchResearch } from "../lib/research-workflow.js";
import { errorResult, textResult } from "../types.js";

// Not chatSessionId-scoped, unlike research_task/research_task_status — the
// whole point of this tool is cross-session recall: research done in one
// conversation (or triggered autonomously by skill_gap_scanner) should be
// findable from any other.
export function registerResearchSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "research_search",
    {
      title: "Search previously-researched topics",
      description:
        "Search previously-completed research documents for information relevant to a query, " +
        "returning the most relevant excerpts along with their source document's title and " +
        "URLs. Use this when the user asks about something that may already have been " +
        "researched before, or to check whether a topic is already covered before starting new " +
        "research on it with research_task.",
      inputSchema: {
        query: z.string().min(1, "query must not be empty").describe("What to search for."),
        topK: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many results to return, 1-10. Defaults to 5."),
      },
    },
    async ({ query, topK }) => {
      if (!config.researchSearchWebhookUrl) {
        return errorResult("Research search is not configured (RESEARCH_SEARCH_WEBHOOK_URL not set).");
      }
      try {
        const results = await searchResearch(config, query, topK);
        return textResult({ query, results });
      } catch (e) {
        return errorResult(`research_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

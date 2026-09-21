import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { tavilySearch } from "../lib/tavily.js";
import { errorResult, textResult } from "../types.js";

export function registerWebSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "web_search",
    {
      title: "Search the web",
      description:
        "Search the live web and return a short list of results (title, URL, and a content " +
        "snippet) for a query. Use this for anything that needs current, real-world " +
        "information that could have changed or that you don't already know for certain — " +
        "news and current events, today's headlines, recent releases, prices, scores, or any " +
        "specific fact worth checking against a live source rather than guessing. Set topic " +
        "to 'news' for current-events/headline requests (biases results toward the last few " +
        "days); leave it as 'general' for anything else. Do NOT use this for things fully " +
        "answerable from general knowledge or casual conversation, or for anything a more " +
        "specific tool already covers (weather_get for weather, calendar_event for the user's " +
        "own calendar). If the results are weak, off-topic, or don't actually answer the " +
        "specific question — call this again right now with a more targeted or differently-worded " +
        "query (try a different phrasing, add a specific model/product/year, or try a site- or " +
        "forum-specific angle) before replying. Do this a couple of times if needed. Never tell " +
        "the user you're going to refine the search and then not actually call it again in the " +
        "same turn — either do it now or answer with what you actually found.",
      inputSchema: {
        query: z.string().describe("The search query, as specific as possible."),
        topic: z
          .enum(["general", "news"])
          .optional()
          .describe(
            "'news' biases results toward recent news articles (last few days); defaults to 'general'.",
          ),
        maxResults: z
          // coerce, not number(): the model sometimes sends a stringified
          // number ("5" instead of 5) for this exact field - observed live,
          // a real production failure (MCP error -32602 rejecting the whole
          // call outright). coerce runs it through Number() first, so a
          // stringified number still validates while genuine garbage fails.
          .coerce.number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many results to return, 1-10. Defaults to 5."),
      },
    },
    async ({ query, topic, maxResults }) => {
      if (!config.tavilyApiKey) {
        return errorResult("Web search is not configured (TAVILY_API_KEY not set).");
      }
      try {
        const results = await tavilySearch(config.tavilyApiKey, query, { topic, maxResults });
        return textResult({
          query,
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            ...(r.publishedDate ? { published: r.publishedDate } : {}),
          })),
        });
      } catch (e) {
        return errorResult(`web_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

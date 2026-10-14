import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { errorResult, textResult } from "../types.js";

interface RankedPassage {
  text: string;
  url: string;
  title: string;
  score: number;
}

export function registerWebSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "web_search",
    {
      title: "Search the web",
      description:
        "Search the live web for a query and return only the passages that actually address it - each " +
        "one already fetched in full and ranked against your query, not a raw search-result snippet. Use " +
        "this for anything that needs current, real-world information that could have changed or that you " +
        "don't already know for certain — news and current events, today's headlines, recent releases, " +
        "prices, scores, or any specific fact worth checking against a live source rather than guessing. " +
        "Do NOT use this for things fully answerable from general knowledge or casual conversation, or for " +
        "anything a more specific tool already covers (weather_get for weather, calendar_event for the " +
        "user's own calendar). If no passage actually answers the question, this returns noMatch:true - " +
        "say so directly rather than guessing or filling the gap with a plausible-sounding answer. If that " +
        "happens, try again with a more targeted or differently-worded query (a different phrasing, a " +
        "specific model/product/year, a site- or forum-specific angle) before concluding nothing exists.",
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
          .describe("How many source pages to search across, 1-10. Defaults to 5."),
      },
    },
    async ({ query, topic, maxResults }) => {
      if (!config.tavilyApiKey) {
        return errorResult("Web search is not configured (TAVILY_API_KEY not set).");
      }
      try {
        const res = await fetch(`${config.knowledgeEngineUrl}/web-search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, topic, maxSources: maxResults }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return errorResult(`web_search failed: ${res.status} ${body}`.trim());
        }
        const data = (await res.json()) as { passages: RankedPassage[]; noMatch: boolean };
        if (data.noMatch) {
          return textResult({
            query,
            noMatch: true,
            message: "No fetched passage actually answered this query - don't guess or fill the gap.",
          });
        }
        return textResult({
          query,
          results: data.passages.map((p) => ({ title: p.title, url: p.url, content: p.text })),
        });
      } catch (e) {
        return errorResult(`web_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

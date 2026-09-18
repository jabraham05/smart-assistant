import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { knowledgeIngestUrl } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// URL only - local-file/PDF ingestion is CLI-only via
// scripts/ingest-document.mjs, since no file-upload channel exists in
// chat-ui for the model to hand a file through.
export function registerKnowledgeIngest(server: McpServer, config: Config): void {
  server.registerTool(
    "knowledge_ingest",
    {
      title: "Save a web page into Amy's knowledge base",
      description:
        "Save a specific web page's content into Amy's knowledge base so it's recallable later via " +
        "knowledge_search, from any conversation. Use this when the user gives you a specific URL to " +
        "remember, not for general research on a topic - use research_task for that instead.",
      inputSchema: {
        url: z.string().url("must be a valid URL").describe("The web page to save."),
        domain: z.string().optional().describe("Topic area this belongs to, if known (e.g. 'automotive', 'warframe')."),
        title: z.string().optional().describe("A title for this document, if you know a better one than the page's own."),
      },
    },
    async ({ url, domain, title }) => {
      try {
        const result = await knowledgeIngestUrl(config, url, { domain, title });
        return textResult(`Saved (${result.chunkCount} chunk${result.chunkCount === 1 ? "" : "s"}).`);
      } catch (e) {
        return errorResult(`knowledge_ingest failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

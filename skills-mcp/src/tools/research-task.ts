import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { startResearch } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// Calls knowledge-engine's POST /research directly (no n8n hop, same
// always-on-infra tier as knowledge_search) instead of the old
// research_pipeline webhook. The route stays fast even for a web
// escalation - knowledge-engine acks immediately and keeps working in the
// background (see its own engine/research.ts) - so this call is safe to
// await directly without risking a long-hanging tool call.
export function registerResearchTask(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "research_task",
    {
      title: "Start researching a topic",
      description:
        "Start an in-depth research task on a topic: checks Amy's existing knowledge first, and if " +
        "that's not enough, searches the live web across multiple angles, gathers real findings with " +
        "sources, and saves them so they stay recallable later via knowledge_search. A web-based " +
        "research task runs in the background - this call returns before it finishes. Use this when " +
        "the user asks you to research or look into something in depth and remember it for later, or " +
        "when you judge that having real background on a topic would meaningfully help going forward " +
        "- don't reach for this for a quick current-fact lookup, use web_search for that instead.",
      inputSchema: {
        topic: z.string().min(1, "topic must not be empty").describe("The specific topic to research, as concrete as possible."),
        domain: z.string().optional().describe("Topic area this belongs to, if known (e.g. 'automotive', 'warframe')."),
      },
    },
    async ({ topic, domain }) => {
      try {
        const result = await startResearch(config, topic, { domain, originSessionId: chatSessionId });

        if (result.route.source === "knowledge") {
          return textResult("Already have enough background on this in the knowledge base - use knowledge_search to see it.");
        }

        return textResult(
          chatSessionId
            ? "Started researching this in the background — I'll post an update right here in " +
                "this conversation once it's done."
            : "Started researching this in the background.",
        );
      } catch (e) {
        return errorResult(`research_task failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

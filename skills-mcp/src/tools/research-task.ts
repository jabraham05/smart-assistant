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
export function registerResearchTask(server: McpServer, config: Config, chatSessionId?: string, background?: boolean): void {
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
        const result = await startResearch(config, topic, { domain, originSessionId: chatSessionId, deferNotify: background });

        if (result.route.source === "knowledge") {
          // Return the actual top result content inline rather than telling
          // the model to go call knowledge_search itself - a real test run
          // showed the model taking a "go check knowledge_search" suggestion
          // at face value and fabricating a "done" reply without ever making
          // that second call. Returning the real content here removes the
          // need for a second tool call (and the reliability gap) entirely.
          const top = result.knowledgeResults.slice(0, 2);
          if (top.length === 0) {
            return textResult(
              "Already have enough background on this in the knowledge base, but no specific passages came back - try knowledge_search directly.",
            );
          }
          const excerpts = top
            .map((r) => {
              const location = [r.documentTitle, r.pageNumber ? `page ${r.pageNumber}` : null].filter(Boolean).join(", ");
              const content = r.content.length > 1500 ? `${r.content.slice(0, 1500)}...` : r.content;
              return `[${location}]\n${content}`;
            })
            .join("\n\n---\n\n");
          return textResult(`Already have background on this in the knowledge base:\n\n${excerpts}`);
        }

        if (background) {
          return textResult("Started researching this in the background — I'll include it in your next digest once it's done.");
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

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { submitResearchTask } from "../lib/research-workflow.js";
import { errorResult, textResult } from "../types.js";

export function registerResearchTask(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "research_task",
    {
      title: "Start researching a topic",
      description:
        "Start an in-depth background research task on a topic: searches the live web across " +
        "multiple angles, gathers real findings with sources, and synthesizes them into a " +
        "saved, detailed document that stays recallable later via research_search. Runs in " +
        "the background; this call returns immediately, well before the research finishes. " +
        "Use this when the user asks you to research or look into something in depth and " +
        "remember it for later, or when you judge that having real background on a topic " +
        "would meaningfully help going forward — don't reach for this for a quick current-fact " +
        "lookup, use web_search for that instead.",
      inputSchema: {
        topic: z
          .string()
          .min(1, "topic must not be empty")
          .describe("The specific topic to research, as concrete as possible."),
      },
    },
    async ({ topic }) => {
      try {
        await submitResearchTask(config, { topic, chatSessionId });
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

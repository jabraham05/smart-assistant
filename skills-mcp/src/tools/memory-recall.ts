import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { searchMemory } from "../lib/memory-engine-client.js";
import { errorResult, textResult } from "../types.js";

export function registerMemoryRecall(server: McpServer, config: Config): void {
  server.registerTool(
    "memory_recall",
    {
      title: "Recall user memory",
      description:
        "Look up specific facts, preferences, or history about the user that you don't " +
        "already have in the current conversation. Only use this for substantive questions " +
        "where recalling something the user has told you before would actually help — e.g. " +
        "\"what's my favorite X\", \"what did I tell you about Y\", questions about their past " +
        "preferences or traits, or a chance to be genuinely proactive/personal rather than " +
        "generic. Before calling, form one concrete, specific question — never call with a " +
        "vague or open-ended query. Do NOT use this for greetings (hi, hey, hello), small " +
        "talk, general knowledge questions unrelated to the user, or anything already visible " +
        "in the current conversation (recent turns are already provided as context — you " +
        "don't need this tool to remember what was just said). If you're not sure whether " +
        "recalling something would actually help, don't call it — answer directly or ask a " +
        "clarifying question instead.",
      inputSchema: {
        query: z
          .string()
          .min(1, "query must not be empty")
          .describe(
            "The specific question to look up about the user, e.g. 'what is their favorite " +
              "food' or 'what did they say about their job'. Must not be empty.",
          ),
      },
    },
    async ({ query }) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return errorResult("query must not be empty or whitespace-only.");
      }
      try {
        const results = await searchMemory(config, trimmed);
        if (results.length === 0) {
          return textResult("No relevant information found.");
        }
        return textResult(results.map((r) => `[${r.role}, ${r.createdAt}] ${r.content}`).join("\n\n"));
      } catch (e) {
        return errorResult(
          `memory_recall failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}

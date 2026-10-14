import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { forgetMemory } from "../lib/memory-engine-client.js";
import { errorResult, textResult } from "../types.js";

export function registerMemoryForget(server: McpServer, config: Config): void {
  server.registerTool(
    "memory_forget",
    {
      title: "Correct your own stored memory",
      description:
        "Use this when the user explicitly tells you that something YOU previously said, stored, or " +
        "'remembered' is false, made up, or incorrect (e.g. 'that's made up', 'you're wrong about X', " +
        "'I never said that'). Finds your own matching past replies and marks them so they're never " +
        "retrieved as fact again - it never touches the user's own statements, only your own claims. " +
        "Describe what was wrong as a short, specific query (e.g. the actual false claim, not just the " +
        "general topic) - a vague query risks matching something unrelated. This is NOT for an ordinary " +
        "single correction on the current turn ('no, I meant tomorrow') - it's specifically for when a " +
        "past claim needs to stop being treated as remembered fact. Always tell the user what you found " +
        "and marked, or that nothing matched.",
      inputSchema: {
        query: z
          .string()
          .min(1, "query must not be empty")
          .describe("The specific false claim to find and correct, as close to its original wording as possible."),
      },
    },
    async ({ query }) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return errorResult("query must not be empty or whitespace-only.");
      }
      try {
        const matches = await forgetMemory(config, trimmed);
        if (matches.length === 0) {
          return textResult("No matching stored memory found - nothing was marked.");
        }
        return textResult({
          markedCount: matches.length,
          marked: matches.map((m) => ({ content: m.content, sessionId: m.sessionId, createdAt: m.createdAt })),
        });
      } catch (e) {
        return errorResult(`memory_forget failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getResearchStatus, getResearchStatusByTopic } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// chatSessionId comes from the MCP transport layer (see server.ts's
// RequestContext), same as research_task itself — it's how this resolves
// "my research task" to a specific row without the model needing to track
// or supply an id, for a task started in *this* conversation.
export function registerResearchTaskStatus(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "research_task_status",
    {
      title: "Check on a research task's progress",
      description:
        "Check the current progress of a research task — what phase it's in, and its findings " +
        "if it's finished. Omit `topic` to check for a task started earlier in THIS conversation " +
        "(the original use case). Pass `topic` instead when asking about something that might " +
        "have been researched in the background and NOT necessarily started via a request in " +
        "this exact conversation — e.g. the self-learning research queue queues topics ambiently " +
        "and drains them during idle/overnight time, so \"what have you found out about the " +
        "robotic arm\" can be true even if no research_task was ever explicitly started here. " +
        "When genuinely unsure which to use, pass `topic` — it also finds tasks started in this " +
        "conversation if the topic matches closely enough.",
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe(
            "Optional: the specific topic to check on (e.g. 'robotic arm', 'submarine'), for " +
              "research that may have happened in the background rather than this conversation.",
          ),
      },
    },
    async ({ topic }) => {
      try {
        if (topic?.trim()) {
          const result = await getResearchStatusByTopic(config, topic.trim());
          if (!result.found) {
            return textResult(`No research found on "${topic}".`);
          }
          return textResult(result);
        }

        if (!chatSessionId) {
          return errorResult("research_task_status has no chat session in scope for this call.");
        }
        const result = await getResearchStatus(config, chatSessionId);
        if (!result.found) {
          return textResult("No research task found for this conversation.");
        }
        return textResult(result);
      } catch (e) {
        return errorResult(`research_task_status failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

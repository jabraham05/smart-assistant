import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getResearchStatus } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// chatSessionId comes from the MCP transport layer (see server.ts's
// RequestContext), same as research_task itself — it's how this resolves
// "my research task" to a specific row without the model needing to track
// or supply an id.
export function registerResearchTaskStatus(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "research_task_status",
    {
      title: "Check on a research task's progress",
      description:
        "Check the current progress of a research task started earlier in this conversation — " +
        "what phase it's in and its latest status update.",
      inputSchema: {},
    },
    async () => {
      if (!chatSessionId) {
        return errorResult("research_task_status has no chat session in scope for this call.");
      }
      try {
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

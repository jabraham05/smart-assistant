import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getCodingTaskStatus } from "../lib/coding-workflow.js";
import { errorResult, textResult } from "../types.js";

// chatSessionId comes from the MCP transport layer (see server.ts's
// RequestContext), same as code_task itself — it's how this resolves
// "my coding task" to a specific row without the model needing to track
// or supply an id.
export function registerCodeTaskStatus(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "code_task_status",
    {
      title: "Check on a coding task's progress",
      description:
        "Check the current progress of a coding task started earlier in this conversation — " +
        "what phase it's in (planning, coding, testing, reviewing), its latest status update, " +
        "and the pull request link once one exists.",
      inputSchema: {},
    },
    async () => {
      if (!chatSessionId) {
        return errorResult("code_task_status has no chat session in scope for this call.");
      }
      try {
        const result = await getCodingTaskStatus(config, chatSessionId);
        if (!result.found) {
          return textResult("No coding task found for this conversation.");
        }
        return textResult(result);
      } catch (e) {
        return errorResult(`code_task_status failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

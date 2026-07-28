import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getTaskDiff } from "../lib/task-container.js";
import { errorResult, textResult } from "../types.js";

// Same containerId/workingDir wiring as code_task_run_command — see that
// file's comment.
export function registerCodeTaskGetDiff(
  server: McpServer,
  config: Config,
  containerId?: string,
  workingDir?: string,
): void {
  server.registerTool(
    "code_task_get_diff",
    {
      title: "See this task's current combined diff",
      description:
        "See the current combined diff of everything changed so far in this coding task's " +
        "container, across all files. Use this to check your own progress before deciding " +
        "the work is done.",
      inputSchema: {},
    },
    async () => {
      if (!containerId || !workingDir) {
        return errorResult("code_task_get_diff has no task container in scope for this session.");
      }
      try {
        const result = await getTaskDiff(config, { containerId, workingDir });
        return textResult(result.diff || "(no changes yet)");
      } catch (e) {
        return errorResult(`code_task_get_diff failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

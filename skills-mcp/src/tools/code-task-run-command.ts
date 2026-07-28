import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { runTaskCommand } from "../lib/task-container.js";
import { errorResult, textResult } from "../types.js";

// containerId/workingDir come from the MCP transport layer (the coding_task_
// pipeline workflow's MCP Client Tool node templates them into the endpoint
// URL as query params, the same way the Chat workflow already does for
// chatSessionId — see server.ts's RequestContext) — never a tool input-
// schema field, so the model can't choose or override which container it
// talks to.
export function registerCodeTaskRunCommand(
  server: McpServer,
  config: Config,
  containerId?: string,
  workingDir?: string,
): void {
  server.registerTool(
    "code_task_run_command",
    {
      title: "Run a command in this task's container",
      description:
        "Run one shell command inside the current coding task's working container and see its " +
        "output. The container already has the target repository cloned and checked out. Use " +
        "this to look at files, make edits, create or delete files, and run the project's test " +
        "command — one command at a time, iterating until the work described is actually done.",
      inputSchema: {
        command: z.string().min(1, "command must not be empty").describe("A single shell command to run."),
      },
    },
    async ({ command }) => {
      if (!containerId || !workingDir) {
        return errorResult("code_task_run_command has no task container in scope for this session.");
      }
      try {
        const result = await runTaskCommand(config, { containerId, workingDir, command });
        return textResult(result);
      } catch (e) {
        return errorResult(`code_task_run_command failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

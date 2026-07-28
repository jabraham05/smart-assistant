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
    // Short, few-underscore-segment name on purpose: n8n's MCP Client Tool
    // node prefixes every exposed tool with its own node name before
    // sending it to the model (e.g. "Task_Tool_" + this name). Confirmed
    // directly (replaying the exact request Ollama received, varying only
    // the tool name) that qwen3:8b's tool-calling grammar silently fails
    // to produce a real tool_calls block once the combined name crosses
    // somewhere around 5-6 underscore-separated segments - it burns real
    // generation tokens but the output never resolves into a parseable
    // call, with no error anywhere in the chain (n8n, LangChain, or
    // Ollama). "code_task_run_command" (4 segments) plus any node-name
    // prefix reliably crossed that line; this shorter name leaves room.
    "run_command",
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
        return errorResult("run_command has no task container in scope for this session.");
      }
      try {
        const result = await runTaskCommand(config, { containerId, workingDir, command });
        // Plain readable text, not a JSON-stringified object - a model has to
        // parse nested JSON to find real file content inside {"stdout":"..."},
        // which is exactly the kind of thing that confuses smaller local
        // models (observed directly: a real file's content sitting inside a
        // stdout field got misread as "the file wasn't found").
        const parts = [`exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`];
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
        return textResult(parts.join("\n\n"));
      } catch (e) {
        return errorResult(`run_command failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

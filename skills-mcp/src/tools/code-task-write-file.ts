import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { writeTaskFile } from "../lib/task-container.js";
import { errorResult, textResult } from "../types.js";

// Same containerId/workingDir wiring as run_command/get_diff — see
// code-task-run-command.ts's comment. Short name for the same reason (n8n's
// MCP Client Tool node prefixes this with its own node name, and too many
// combined underscore-segments silently breaks qwen3:8b's tool-calling
// grammar).
//
// This exists because run_command alone forces file content through a shell
// string (e.g. `echo "..." > file`), which breaks the moment the content
// itself contains a double quote — confirmed directly against a real failed
// run where a Python file's embedded quotes closed the outer echo early and
// silently produced an empty file. This tool takes filename and content as
// separate parameters and never builds a shell command out of the content,
// so there is nothing to quote.
export function registerCodeTaskWriteFile(
  server: McpServer,
  config: Config,
  containerId?: string,
  workingDir?: string,
): void {
  server.registerTool(
    "write_file",
    {
      title: "Write a file in this task's container",
      description:
        "Create or overwrite a file in the current coding task's working container with exact " +
        "content, no shell escaping needed. Use this whenever you need to write a whole file's " +
        "contents from scratch or replace it entirely — prefer this over building the content " +
        "into a shell command. Parent directories are created automatically.",
      inputSchema: {
        filename: z
          .string()
          .min(1, "filename must not be empty")
          .describe("Path of the file to write, relative to the project's working directory."),
        content: z.string().describe("The exact full content to write to the file."),
      },
    },
    async ({ filename, content }) => {
      if (!containerId || !workingDir) {
        return errorResult("write_file has no task container in scope for this session.");
      }
      try {
        const result = await writeTaskFile(config, { containerId, workingDir, filename, content });
        if (result.exitCode !== 0) {
          return errorResult(
            `write_file failed (exit code ${result.exitCode}): ${result.stderr || result.stdout}`,
          );
        }
        return textResult(`Wrote ${filename}.`);
      } catch (e) {
        return errorResult(`write_file failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

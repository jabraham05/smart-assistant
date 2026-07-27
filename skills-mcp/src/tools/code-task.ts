import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { submitCodingTask } from "../lib/coding-workflow.js";
import { errorResult, textResult } from "../types.js";

export function registerCodeTask(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "code_task",
    {
      title: "Start a coding task",
      description:
        "Start an autonomous coding task: plans the change, writes a diff, adds test " +
        "coverage, runs the tests in an isolated sandbox, and reviews the result — " +
        "repeating up to a few attempts if needed. Runs in the background; this call " +
        "returns immediately, well before the work finishes. Nothing is ever applied to " +
        "the real repository automatically — the result always lands as a human-reviewed " +
        "proposal (a diff, or a pull request if the target repo has one configured), never " +
        "an automatic change. Only call this for a genuine, concrete coding task (fix a " +
        "specific bug, add a specific feature) that you have a real repoUrl for — never " +
        "guess or invent a repository URL. If you don't know the target repo, ask the user " +
        "for it rather than calling this.",
      inputSchema: {
        task: z
          .string()
          .min(1, "task must not be empty")
          .describe(
            "A specific, concrete description of the change to make — what's broken or " +
              "missing, and what the fix should accomplish. Not a vague goal.",
          ),
        repoUrl: z
          .string()
          .min(1, "repoUrl must not be empty")
          .describe(
            "Git URL the task's target repo can be cloned from (e.g. a GitHub URL). Must be " +
              "a real URL the user gave you or that's already known — never invented.",
          ),
        ref: z
          .string()
          .optional()
          .describe("Branch, tag, or commit to work from. Defaults to the repo's main branch."),
        testCommand: z
          .string()
          .optional()
          .describe(
            "Command to run the test suite, e.g. 'npm test' or 'pytest'. Defaults to 'npm test' " +
              "if not given — only override this if you know the project uses something else.",
          ),
        contextCommand: z
          .string()
          .optional()
          .describe(
            "Shell command run inside the target repo to print the file(s) the Coder needs to " +
              "see before writing a diff — without this, the Coder only has the task description " +
              "and can hallucinate the file's actual content. Defaults to a shallow search for " +
              "*.js files only, which misses TypeScript/Python/deeper-nested files entirely. " +
              "Override this whenever the target file isn't a top-level-ish .js file — e.g. " +
              "`cat path/to/real_file.ts` or `find ./src -name '*.py' -exec cat {} +`.",
          ),
      },
    },
    async ({ task, repoUrl, ref, testCommand, contextCommand }) => {
      try {
        await submitCodingTask(config, { task, repoUrl, ref, testCommand, contextCommand, chatSessionId });
        return textResult(
          chatSessionId
            ? "Started working on this in the background — I'll post an update right here in " +
                "this conversation once it's done."
            : "Started working on this in the background — check the coding_proposals table " +
                "for the result once it's done.",
        );
      } catch (e) {
        return errorResult(`code_task failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { createTaskContext, listTaskContexts, logTaskContext, updateTaskContext } from "../lib/event-bus-workflow.js";
import { errorResult, textResult } from "../types.js";

// Always-on, ungated by classification (unlike every other tool, which is
// only bound to a chat turn when the relevant capability was classified) -
// a task can span multiple capabilities over multiple real-world days
// (e.g. "measure the fuel sender now, full reading tomorrow"), so it isn't
// owned by any one of them. See docs/chat-workflow.md.
export function registerTaskContextManage(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "task_context_manage",
    {
      title: "Cross-session task tracking",
      description:
        "Track something that genuinely spans multiple real-world interactions and needs to " +
        "resume correctly later, chosen via the `action` parameter. Use action='create' when a " +
        "task can't be finished in this conversation and depends on something the user needs " +
        "to go do first (e.g. 'measure the fuel sender now, I'll get the second reading " +
        "tomorrow') - not for something you can just answer or do right now. Every open task " +
        "you're tracking is already shown to you at the start of each conversation, so " +
        "check there before assuming a new message is unrelated - if a message plausibly " +
        "answers or advances one, use action='log' (and action='update' to change its status) " +
        "rather than starting a disconnected new task or asking what task the user means. " +
        "action='update' status='waiting_for_user' when the ball is in the user's court; " +
        "status='done' once the objective is actually met. action='list' shows tasks by status.",
      inputSchema: {
        action: z.enum(["create", "list", "update", "log"]).describe("Which task operation to perform."),
        // coerce, not number(): the model sometimes sends a stringified
        // number for id-like fields - see web-search.ts's maxResults for
        // the real production failure this pattern is fixed for.
        taskContextId: z.coerce.number().int().optional().describe("update/log: the task's id, from the open-tasks list already shown to you. Required for both."),
        objective: z.string().optional().describe("create: what the task is trying to accomplish (required). update: new objective, if changing."),
        capability: z.string().optional().describe("create/update: which capability this task relates to, e.g. 'research', 'automation' - metadata only."),
        domain: z.string().optional().describe("create/update: free-text domain, e.g. 'automotive' - same convention as knowledge_search's domain."),
        status: z.enum(["active", "waiting_for_user", "done", "abandoned"]).optional().describe("update: new status, if changing."),
        note: z.string().optional().describe("log: what to record, e.g. a measurement or finding the user just reported. Required for action='log'."),
      },
    },
    async ({ action, taskContextId, objective, capability, domain, status, note }) => {
      try {
        if (action === "create") {
          if (!objective?.trim()) return errorResult("objective is required for action='create'.");
          const task = await createTaskContext(config, { objective, capability, domain, originSessionId: chatSessionId });
          return textResult({ id: task.id, objective: task.objective, status: task.status });
        }

        if (action === "list") {
          const tasks = await listTaskContexts(config, status);
          if (tasks.length === 0) return textResult("No task contexts found.");
          return textResult(
            tasks.map((t) => ({ id: t.id, objective: t.objective, status: t.status, updatedAt: t.updated_at })),
          );
        }

        if (action === "update") {
          if (!taskContextId) return errorResult("taskContextId is required for action='update'.");
          const task = await updateTaskContext(config, taskContextId, { objective, capability, domain, status });
          return textResult({ id: task.id, objective: task.objective, status: task.status });
        }

        // action === "log"
        if (!taskContextId) return errorResult("taskContextId is required for action='log'.");
        if (!note?.trim()) return errorResult("note is required for action='log'.");
        await logTaskContext(config, taskContextId, note);
        return textResult(`Logged.`);
      } catch (e) {
        return errorResult(`task_context_manage failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

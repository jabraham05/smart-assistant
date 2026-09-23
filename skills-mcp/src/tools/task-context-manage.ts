import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  createTaskContext,
  listTaskContexts,
  logTaskContext,
  updateTaskContext,
  createTaskContextSteps,
  listTaskContextSteps,
  updateTaskContextStep,
} from "../lib/event-bus-workflow.js";
import { errorResult, textResult } from "../types.js";
import { registerVerifier, verifyToolResult } from "../lib/verify-tool-result.js";

// Second-priority verifier per the architecture plan (after calendar_event) -
// closes a real confabulation-adjacent gap: confirming a write actually
// took (the returned row genuinely reflects what was requested), not just
// that the model correctly decided to call the tool at all (that's Phase
// 2's job, in chat-orchestrator's safety-net.ts).
registerVerifier("task_context_manage", (args, result) => {
  const a = args as { action?: string; objective?: string; stepStatus?: string; stepDescriptions?: string[] };
  if (a.action === "create" && a.objective) {
    const r = result as { objective?: string; duplicate?: boolean };
    // A dedup match legitimately returns a different (pre-existing)
    // objective's exact wording - not a verification failure, see
    // event-bus's POST /task-contexts.
    if (!r.duplicate && r.objective !== a.objective) {
      return { ok: false, reason: `Requested objective "${a.objective}" but got back "${r.objective}".` };
    }
  }
  if (a.action === "advance_step" && a.stepStatus) {
    const r = result as { status?: string };
    if (r.status !== a.stepStatus) {
      return { ok: false, reason: `Requested step status "${a.stepStatus}" but got back "${r.status}".` };
    }
  }
  if (a.action === "plan" && Array.isArray(a.stepDescriptions)) {
    const r = result as unknown[];
    if (!Array.isArray(r) || r.length !== a.stepDescriptions.length) {
      return { ok: false, reason: `Requested ${a.stepDescriptions.length} steps but got back ${Array.isArray(r) ? r.length : 0}.` };
    }
  }
  return { ok: true };
});

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
        "status='done' once the objective is actually met. There is no separate delete action - " +
        "if the user says to cancel, drop, delete, or forget about a task, use action='update' " +
        "status='abandoned', never status='done' (that specifically means the objective was " +
        "actually achieved, not that tracking stopped). An 'abandoned' task no longer shows up in " +
        "the open-tasks list you're shown each turn, the same as 'done'. action='list' defaults to " +
        "open (active/waiting_for_user) tasks - pass status explicitly for abandoned/done history. " +
        "For a genuinely multi-step task, use action='plan' once, right after action='create', " +
        "to break it into an explicit ordered list of steps - then action='advance_step' each " +
        "time a step actually completes, fails, or gets blocked, so progress stays accurate " +
        "instead of just a free-text log.",
      inputSchema: {
        action: z.enum(["create", "list", "update", "log", "plan", "advance_step"]).describe("Which task operation to perform."),
        // coerce, not number(): the model sometimes sends a stringified
        // number for id-like fields - see web-search.ts's maxResults for
        // the real production failure this pattern is fixed for.
        taskContextId: z.coerce.number().int().optional().describe("update/log/plan/advance_step: the task's id, from the open-tasks list already shown to you. Required for all four."),
        objective: z.string().optional().describe("create: what the task is trying to accomplish (required). update: new objective, if changing."),
        capability: z.string().optional().describe("create/update: which capability this task relates to, e.g. 'research', 'automation' - metadata only."),
        domain: z.string().optional().describe("create/update: free-text domain, e.g. 'automotive' - same convention as knowledge_search's domain."),
        status: z.enum(["active", "waiting_for_user", "done", "abandoned"]).optional().describe("update: new status, if changing."),
        note: z.string().optional().describe("log: what to record, e.g. a measurement or finding the user just reported. Required for action='log'."),
        stepDescriptions: z
          .array(z.string())
          .optional()
          .describe("plan: the ordered list of steps this task breaks down into, each a short concrete description. Required for action='plan'."),
        stepId: z.coerce.number().int().optional().describe("advance_step: which step to update, from action='plan's or action='list's output. Required for action='advance_step'."),
        stepStatus: z
          .enum(["pending", "running", "completed", "failed", "blocked", "skipped"])
          .optional()
          .describe("advance_step: the step's new status, if changing."),
        stepFailurePolicy: z
          .enum(["retry", "recover", "clarify", "continue", "skip", "fail"])
          .optional()
          .describe("advance_step: how to handle this step if/when it fails, if you have an opinion on it now."),
      },
    },
    async ({
      action,
      taskContextId,
      objective,
      capability,
      domain,
      status,
      note,
      stepDescriptions,
      stepId,
      stepStatus,
      stepFailurePolicy,
    }) => {
      try {
        if (action === "create") {
          if (!objective?.trim()) return errorResult("objective is required for action='create'.");
          const task = await createTaskContext(config, { objective, capability, domain, originSessionId: chatSessionId });
          const verification = verifyToolResult("task_context_manage", { action, objective }, task);
          if (!verification.ok) return errorResult(`Task was created but didn't verify: ${verification.reason}`);
          if (task.duplicate) {
            return textResult({
              id: task.id,
              objective: task.objective,
              status: task.status,
              note: `An open task like this already exists (#${task.id}: "${task.objective}") - reused it instead of creating a duplicate. Use this id, don't create another.`,
            });
          }
          return textResult({ id: task.id, objective: task.objective, status: task.status });
        }

        if (action === "list") {
          // Real bug found via live testing: an unscoped list() returned
          // every task_context ever created, including old abandoned
          // test/debug entries ("Phase 6b notification test", duplicate
          // Japan-trip variants) - presented as if they were current. The
          // model can still explicitly pass status='abandoned'/'done' for
          // the full history; omitting it should mean "what's open," not
          // "everything."
          const tasks = await listTaskContexts(config, status ?? "open");
          if (tasks.length === 0) return textResult("No task contexts found.");
          const enriched = await Promise.all(
            tasks.map(async (t) => {
              const steps = await listTaskContextSteps(config, t.id);
              return {
                id: t.id,
                objective: t.objective,
                status: t.status,
                updatedAt: t.updated_at,
                steps: steps.length
                  ? steps.map((s) => ({ id: s.id, description: s.description, status: s.status }))
                  : undefined,
              };
            }),
          );
          return textResult(enriched);
        }

        if (action === "update") {
          if (!taskContextId) return errorResult("taskContextId is required for action='update'.");
          const task = await updateTaskContext(config, taskContextId, { objective, capability, domain, status });
          return textResult({ id: task.id, objective: task.objective, status: task.status });
        }

        if (action === "log") {
          if (!taskContextId) return errorResult("taskContextId is required for action='log'.");
          if (!note?.trim()) return errorResult("note is required for action='log'.");
          await logTaskContext(config, taskContextId, note);
          return textResult(`Logged.`);
        }

        if (action === "plan") {
          if (!taskContextId) return errorResult("taskContextId is required for action='plan'.");
          if (!stepDescriptions || stepDescriptions.length === 0 || !stepDescriptions.every((d) => d.trim())) {
            return errorResult("stepDescriptions must be a non-empty array of non-empty steps for action='plan'.");
          }
          const steps = await createTaskContextSteps(config, taskContextId, stepDescriptions);
          const verification = verifyToolResult("task_context_manage", { action, stepDescriptions }, steps);
          if (!verification.ok) return errorResult(`Steps were created but didn't verify: ${verification.reason}`);
          return textResult(steps.map((s) => ({ id: s.id, description: s.description, status: s.status })));
        }

        // action === "advance_step"
        if (!taskContextId) return errorResult("taskContextId is required for action='advance_step'.");
        if (!stepId) return errorResult("stepId is required for action='advance_step'.");
        if (!stepStatus && !stepFailurePolicy) {
          return errorResult("provide stepStatus and/or stepFailurePolicy for action='advance_step'.");
        }
        const step = await updateTaskContextStep(config, taskContextId, stepId, {
          status: stepStatus,
          failurePolicy: stepFailurePolicy,
        });
        const verification = verifyToolResult("task_context_manage", { action, stepStatus }, step);
        if (!verification.ok) return errorResult(`Step was updated but didn't verify: ${verification.reason}`);
        return textResult({ id: step.id, description: step.description, status: step.status });
      } catch (e) {
        return errorResult(`task_context_manage failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

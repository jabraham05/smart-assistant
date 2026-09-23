import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { createGoal, getGoalProgress, listGoals, updateGoal } from "../lib/event-bus-workflow.js";
import { errorResult, textResult } from "../types.js";

export function registerGoalManage(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "goal_manage",
    {
      title: "Goal management",
      description:
        "Manage the user's persistent personal goals — create, list, update, or check " +
        "progress on, chosen via the `action` parameter. Use action='create' when the user " +
        "states an ongoing objective worth tracking over time (e.g. 'help me track my job " +
        "search', 'I want to lose weight') — not for one-off tasks. This also covers new " +
        "hobby/technical/creative projects the user mentions wanting to start or work on " +
        "(e.g. 'I have a new project idea, I want to build a robotics arm', 'I'm going to " +
        "learn guitar', 'I want to restore an old car') — proactively call action='create' " +
        "for these too, don't just acknowledge them in conversation and move on; a new " +
        "project the user cares about is exactly the kind of thing that should be tracked, " +
        "not forgotten once the conversation moves on. Progress is tracked " +
        "automatically and deterministically as related events happen elsewhere in the " +
        "system (no need to log progress manually); action='progress' shows what's actually " +
        "been logged, real matches only, never a guess. Use action='list' for 'what are my " +
        "goals' / 'what am I tracking'. action='update' only changes the fields you provide " +
        "— use it to mark a goal 'done' or 'abandoned' when the user says so, or to adjust " +
        "its title/description/keywords. Goals, projects, task contexts, and coding tasks are four " +
        "separate things with their own independent numeric ids - 'ID 8' is ambiguous across them " +
        "(a real mix-up found via live testing: an abandoned goal #8 got confused with an unrelated " +
        "active project #8). Always say 'goal #N' (the `ref` field below) when referring to one in " +
        "conversation, never a bare number.",
      inputSchema: {
        action: z.enum(["create", "list", "update", "progress"]).describe("Which goal operation to perform."),
        // coerce, not number(): the model sometimes sends a stringified
        // number for id-like fields - see web-search.ts's maxResults for
        // the real production failure this pattern is fixed for.
        goalId: z.coerce.number().int().optional().describe("update/progress: the goal's id, from a prior action='list' call. Required for both."),
        title: z.string().optional().describe("create: goal title (required). update: new title, if changing."),
        description: z.string().optional().describe("create/update: more detail on what the goal actually means."),
        keywords: z
          .array(z.string())
          .optional()
          .describe(
            "create/update: words/phrases used to match future events to this goal (e.g. " +
              "['job', 'interview', 'resume'] for a job-search goal). Omit on create to have " +
              "them derived automatically from the title/description.",
          ),
        status: z.enum(["active", "done", "abandoned"]).optional().describe("update: new status, if changing."),
      },
    },
    async ({ action, goalId, title, description, keywords, status }) => {
      try {
        if (action === "create") {
          if (!title?.trim()) return errorResult("title is required for action='create'.");
          const goal = await createGoal(config, { title, description, keywords, originSessionId: chatSessionId });
          return textResult({ id: goal.id, ref: `goal #${goal.id}`, title: goal.title, keywords: goal.keywords, status: goal.status });
        }

        if (action === "list") {
          const goals = await listGoals(config, status);
          if (goals.length === 0) return textResult("No goals found.");
          return textResult(
            goals.map((g) => ({ id: g.id, ref: `goal #${g.id}`, title: g.title, status: g.status, updatedAt: g.updated_at })),
          );
        }

        if (action === "update") {
          if (!goalId) return errorResult("goalId is required for action='update'.");
          const goal = await updateGoal(config, goalId, { title, description, keywords, status });
          return textResult({ id: goal.id, ref: `goal #${goal.id}`, title: goal.title, status: goal.status });
        }

        // action === "progress"
        if (!goalId) return errorResult("goalId is required for action='progress'.");
        const { goal, progress } = await getGoalProgress(config, goalId);
        if (progress.length === 0) {
          return textResult(`No progress logged yet for "${goal.title}".`);
        }
        return textResult({
          goal: { id: goal.id, ref: `goal #${goal.id}`, title: goal.title, status: goal.status },
          progress: progress.map((p) => ({ note: p.note, at: p.created_at })),
        });
      } catch (e) {
        return errorResult(`goal_manage failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

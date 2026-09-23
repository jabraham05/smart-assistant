import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { proposeProject } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

export function registerProjectPropose(server: McpServer, config: Config): void {
  server.registerTool(
    "project_propose",
    {
      title: "Propose a learning/research/coding project",
      description:
        "Propose a bounded project for yourself to go work on autonomously, once approved - either " +
        "activityType='research' (dig into a topic in depth) or activityType='coding' (build or fix " +
        "something real via the coding agent). Use this when the user describes a new interest or " +
        "idea that's worth a review gate before real work starts, not for something they want done " +
        "immediately: for a quick question, use research_task/web_search; for code the user wants " +
        "built RIGHT NOW, use code_task directly instead - this tool is for a more exploratory or " +
        "longer-term idea worth approving first, not a direct command to act now. This is different " +
        "from goal_manage: a goal just tracks an ongoing objective for progress-matching and does no " +
        "work on its own; a project is concrete work you will actually go do once a human approves it " +
        "- often proposed as a next step right after creating a related goal, not instead of it. It's " +
        "also different from skill_propose: a skill proposal is about a new capability for yourself, a " +
        "project is about learning or building something for the user. Nothing happens automatically " +
        "- a human reviews and approves every project on the /amy dashboard before any research or " +
        "coding work starts, so there's no cost to proposing when it seems genuinely worthwhile. " +
        "Real gap found via live testing: if the user asks to turn SEVERAL ideas into projects at " +
        "once (e.g. 'make a project out of each of these 5'), call this tool once per idea - one " +
        "call creates exactly one project, so N ideas need N calls in this same reply, not one call " +
        "for the group. Only ever use a title/rationale/domain the user actually said or that you " +
        "yourself proposed earlier in this exact conversation - never invent or substitute a " +
        "different topic than what was discussed, even if a similarly-worded past project exists. " +
        "That also means: if the CURRENT request is for one single idea, call this tool exactly " +
        "once for it - never call it again with a reworded title/domain/activityType to 'try again' " +
        "after a result comes back, whether that result succeeded or reported a duplicate. A " +
        "duplicate result is not a signal to retry with variations; it means the work is already " +
        "covered, so just relay that to the user (see the tool result's own instruction on a " +
        "duplicate).",
      inputSchema: {
        title: z
          .string()
          .min(1, "title must not be empty")
          .max(200, "must be at most 200 characters")
          .describe("A short, specific title, e.g. 'Robotics arm design and construction basics'."),
        rationale: z
          .string()
          .min(1, "rationale must not be empty")
          .describe(
            "Why this is worth doing and what the outcome should be - shown to the human reviewing it. " +
              "For activityType='coding', this doubles as the actual task description given to the " +
              "coding agent once approved, so be concrete about what should be built or fixed.",
          ),
        activityType: z
          .enum(["research", "coding"])
          .default("research")
          .describe(
            "'research' to investigate a topic in depth and write up findings. 'coding' to build or " +
              "fix something via the coding agent (Planner/Coder/Tester/Reviewer, isolated sandbox, " +
              "result lands as a human-reviewed PR) once approved.",
          ),
        domain: z.string().optional().describe("Topic area this belongs to, if known (e.g. 'robotics', 'automotive')."),
        repoUrl: z
          .string()
          .optional()
          .describe(
            "activityType='coding' only: git URL of an existing repo this targets, if there is one. " +
              "Omit entirely for a from-scratch idea with no existing project - never guess or invent one.",
          ),
      },
    },
    async ({ title, rationale, domain, activityType, repoUrl }) => {
      try {
        const result = await proposeProject(config, { title, rationale, domain, activityType, repoUrl });
        if (result.duplicate) {
          return textResult(
            `A similar project already exists (#${result.id}: "${result.title}", status: ${result.status}) - ` +
              `didn't create a new one. STOP: do not call project_propose again for this idea, even with a ` +
              `different title, domain, or activityType - that would just hit this same duplicate check again. ` +
              `Tell the user about project #${result.id} instead.`,
          );
        }
        return textResult(
          `Project "${result.title}" proposed (#${result.id}) - awaiting your review on the /amy dashboard.`,
        );
      } catch (e) {
        return errorResult(`project_propose failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

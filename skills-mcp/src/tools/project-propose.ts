import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { proposeProject } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

export function registerProjectPropose(server: McpServer, config: Config): void {
  server.registerTool(
    "project_propose",
    {
      title: "Propose a learning/research project",
      description:
        "Propose a bounded research project for yourself to go work on autonomously, once approved. " +
        "Use this when the user describes a new interest or idea (a hobby, a build, something they " +
        "want to learn) that would benefit from real research over time - not for a quick question " +
        "that already has an answer (use research_task/web_search for that instead). This is " +
        "different from goal_manage: a goal just tracks an ongoing objective for progress-matching " +
        "and does no work on its own; a project is concrete work you will actually go do (research a " +
        "topic in depth, then consolidate the findings into a real write-up) once a human approves " +
        "it - often proposed as a next step right after creating a related goal, not instead of it. " +
        "It's also different from skill_propose: a skill proposal is about a new capability for " +
        "yourself, a project is about learning or building something for the user. Nothing happens " +
        "automatically - a human reviews and approves every project on the /amy dashboard before any " +
        "research starts, so there's no cost to proposing when it seems genuinely worthwhile.",
      inputSchema: {
        title: z
          .string()
          .min(1, "title must not be empty")
          .max(200, "must be at most 200 characters")
          .describe("A short, specific title, e.g. 'Robotics arm design and construction basics'."),
        rationale: z
          .string()
          .min(1, "rationale must not be empty")
          .describe("Why this is worth researching and what you'd expect to learn - shown to the human reviewing it."),
        domain: z.string().optional().describe("Topic area this belongs to, if known (e.g. 'robotics', 'automotive')."),
      },
    },
    async ({ title, rationale, domain }) => {
      try {
        const result = await proposeProject(config, { title, rationale, domain });
        return textResult(
          `Project "${result.title}" proposed (#${result.id}) - awaiting your review on the /amy dashboard.`,
        );
      } catch (e) {
        return errorResult(`project_propose failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

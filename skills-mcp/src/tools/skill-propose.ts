import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { submitSkillProposal } from "../lib/skills-workflow.js";
import { errorResult, textResult } from "../types.js";

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function registerSkillPropose(server: McpServer, config: Config): void {
  server.registerTool(
    "skill_propose",
    {
      title: "Propose new skill",
      description:
        "Propose a new skill or tool for yourself when YOU discover, mid-task, that you " +
        "can't help with something the user reasonably expects, and neither an existing " +
        "tool, an already-active skill, nor your own knowledge covers it - this is for your " +
        "own self-initiated gap-discovery, not something the user asked you to create. NOT " +
        "for when the user is directly teaching, demonstrating, or dictating a skill/" +
        "procedure to you themselves (e.g. 'I want to teach you a skill...', 'let me show " +
        "you how I do X') - that's teaching_session_manage's job, which captures their actual " +
        "explanation faithfully and classifies what kind of lesson it is (not everything " +
        "taught is even a skill). Also NOT for answering a question about your own " +
        "capabilities ('can you create skills', 'are you able to do X') - just answer that " +
        "directly and honestly, never call this tool just to respond to a question. Before " +
        "calling this, check: could you already answer or handle this directly right now? If " +
        "so, just do that — this is for genuine, present gaps, not something to reach for " +
        "routinely. This never applies automatically — a human reviews and approves every " +
        "proposal before anything changes, so there's no cost to proposing when you're " +
        "genuinely stuck. Use " +
        "kind='instruction' for something you could fully write out as a procedure right now " +
        "using tools/knowledge you already have (a recipe, not a new capability) — describe " +
        "the actual steps in `instructions`. Use kind='tool_idea' only when no combination of " +
        "what you have could do this at all — you can only describe what's needed in " +
        "`tool_idea_details`, not build it; a human has to implement it later.",
      inputSchema: {
        kind: z
          .enum(["instruction", "tool_idea"])
          .describe(
            "'instruction' for a procedure you can fully write out yourself using what " +
              "you already have. 'tool_idea' for a request for a genuinely new capability " +
              "that needs real code — you can only describe it, not build it.",
          ),
        name: z
          .string()
          .max(64, "must be at most 64 characters")
          .regex(
            NAME_PATTERN,
            "must be kebab-case: lowercase letters, digits, and single hyphens only — " +
              "no leading, trailing, or consecutive hyphens",
          )
          .describe("A short kebab-case identifier, e.g. 'draft-follow-up-email'."),
        description: z
          .string()
          .min(1, "description must not be empty")
          .max(1024, "must be at most 1024 characters")
          .describe(
            "Describe both what this does AND when to use it, with specific keywords for " +
              "discovery. Good: 'Extracts text and tables from PDF files... Use when working " +
              "with PDF documents or when the user mentions PDFs, forms...'. Poor: 'Helps " +
              "with PDFs.'",
          ),
        reason: z
          .string()
          .min(1, "reason must not be empty")
          .describe("Why this would help — what gap it fills."),
        instructions: z
          .string()
          .max(8000, "must be at most 8000 characters")
          .optional()
          .describe(
            "Required when kind='instruction': the full step-by-step procedure, markdown, " +
              "no code.",
          ),
        tool_idea_details: z
          .string()
          .max(4000, "must be at most 4000 characters")
          .optional()
          .describe(
            "Required when kind='tool_idea': proposed inputs/outputs and why memory_recall " +
              "/ weather_get / calendar_event don't already cover this.",
          ),
      },
    },
    async ({ kind, name, description, reason, instructions, tool_idea_details }) => {
      if (kind === "instruction" && !instructions?.trim()) {
        return errorResult("instructions is required and must not be empty when kind='instruction'.");
      }
      if (kind === "tool_idea" && !tool_idea_details?.trim()) {
        return errorResult(
          "tool_idea_details is required and must not be empty when kind='tool_idea'.",
        );
      }

      try {
        await submitSkillProposal(config, {
          kind,
          name,
          description,
          reason,
          instructions: kind === "instruction" ? instructions : undefined,
          tool_idea_details: kind === "tool_idea" ? tool_idea_details : undefined,
        });
        return textResult("Proposal recorded for human review.");
      } catch (e) {
        return errorResult(
          `skill_propose failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}

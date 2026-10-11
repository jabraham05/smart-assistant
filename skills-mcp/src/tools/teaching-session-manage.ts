import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { captureTeachingContent, finalizeTeachingSession, getTeachingSession, startTeachingSession } from "../lib/growth-client.js";
import { errorResult, textResult } from "../types.js";

// Phase 10 (Teaching layer, docs/unified-architecture-gap-analysis.md §7) -
// the actual capture hook. Amy calls this herself, mid-conversation, when
// she recognizes the user is teaching her something - same "model-invoked"
// idiom skill_propose already uses - rather than a new field on the
// per-turn classifier (which would mean touching the tuned structured-
// output schema used on every single turn, for a signal the agent itself
// can already recognize in context).
export function registerTeachingSessionManage(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "teaching_session_manage",
    {
      title: "Capture and route a direct teaching moment from the user",
      description:
        "Use when the user is directly teaching you something - demonstrating a task step by step, " +
        "correcting your attempt at one, explaining a procedure/rules/examples outright, OR STATING A " +
        "LASTING PREFERENCE OR STANDING INSTRUCTION for how you should behave or respond going forward " +
        "(this is the most common case, not an edge case - 'I prefer direct answers', 'remember this " +
        "preference', 'from now on, always/never do X', 'I want you to work this way with me' are ALL " +
        "teaching, even though they don't look like a step-by-step procedure). This is NOT for an " +
        "ordinary single correction ('no, I meant tomorrow') - it's for anything meant to last beyond " +
        "this one turn. action='start' begins a session with `mode` ('demonstration' for the user " +
        "performing+narrating a task, 'guided_practice' for you attempting a task with the user " +
        "correcting you, 'explain_and_build' for the user describing a procedure OR a preference/rule " +
        "directly - use explain_and_build for a plain preference statement) and the " +
        "initial captured text; returns teachingSessionId. action='capture' appends more captured text " +
        "(e.g. each correction during guided_practice) to an existing session via `teachingSessionId`. " +
        "action='finalize' classifies what was captured (not everything taught becomes a skill - it " +
        "might be a fact, a behavior preference, or a procedure) and routes it into the same Growth " +
        "pipeline growth_review surfaces - call this once the teaching is actually complete, not after " +
        "every single message. IMPORTANT for mode='explain_and_build': the user's message IS usually " +
        "the complete teaching already, so pass `finalizeImmediately: true` on the SAME start call " +
        "instead of calling action='finalize' separately afterward - you cannot know the real " +
        "teachingSessionId a separate finalize call would need until you've actually seen this call's " +
        "result, so don't guess it. For 'demonstration'/'guided_practice' (where more turns of " +
        "capture are genuinely expected), start WITHOUT finalizeImmediately, use action='capture' with " +
        "the teachingSessionId from start's result as the conversation continues, then call " +
        "action='finalize' with that same id once the user signals they're done. action='status' " +
        "checks a session's current classification/routing.",
      inputSchema: {
        action: z.enum(["start", "capture", "finalize", "status"]).describe("Which teaching-session operation to perform."),
        mode: z
          .enum(["demonstration", "guided_practice", "explain_and_build"])
          .optional()
          .describe(
            "start: which teaching mode this is. 'explain_and_build' covers both a described " +
              "procedure AND a plain stated preference/standing instruction. Required for action='start'.",
          ),
        content: z
          .string()
          .optional()
          .describe("start/capture: the captured text - what the user said/demonstrated/corrected. Required for both."),
        teachingSessionId: z.coerce.number().int().optional().describe("capture/finalize/status: the session's id, from action='start'. Required for all three."),
        finalizeImmediately: z
          .boolean()
          .optional()
          .describe(
            "start only: set true when the teaching is already complete in this one message (the " +
              "normal case for explain_and_build) - classifies and routes in this same call, instead " +
              "of a separate action='finalize' call that would need an id you can't know yet.",
          ),
      },
    },
    async ({ action, mode, content, teachingSessionId, finalizeImmediately }) => {
      try {
        if (action === "start") {
          if (!mode) return errorResult("mode is required for action='start'.");
          if (!content) return errorResult("content is required for action='start'.");
          const result = await startTeachingSession(config, mode, content, chatSessionId, finalizeImmediately);
          return textResult(result);
        }

        if (action === "capture") {
          if (!teachingSessionId) return errorResult("teachingSessionId is required for action='capture'.");
          if (!content) return errorResult("content is required for action='capture'.");
          const result = await captureTeachingContent(config, teachingSessionId, content);
          return textResult(result);
        }

        if (action === "finalize") {
          if (!teachingSessionId) return errorResult("teachingSessionId is required for action='finalize'.");
          const result = await finalizeTeachingSession(config, teachingSessionId);
          return textResult(result);
        }

        // action === "status"
        if (!teachingSessionId) return errorResult("teachingSessionId is required for action='status'.");
        const session = await getTeachingSession(config, teachingSessionId);
        return textResult(session);
      } catch (e) {
        return errorResult(`teaching_session_manage failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

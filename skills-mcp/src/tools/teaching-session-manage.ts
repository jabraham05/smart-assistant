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
        "correcting your attempt at one, or explaining a procedure/rules/examples outright so you can " +
        "do it again later. This is NOT for an ordinary single correction ('no, I meant tomorrow') or " +
        "a repeated-behavior complaint (that's growth_review's domain) - it's for when the user is " +
        "clearly in 'teaching mode'. action='start' begins a session with `mode` ('demonstration' for " +
        "the user performing+narrating, 'guided_practice' for you attempting it with the user " +
        "correcting you, 'explain_and_build' for the user describing the procedure directly) and the " +
        "initial captured text; returns teachingSessionId. action='capture' appends more captured text " +
        "(e.g. each correction during guided_practice) to an existing session via `teachingSessionId`. " +
        "action='finalize' classifies what was captured (not everything taught becomes a skill - it " +
        "might be a fact, a behavior preference, or a procedure) and routes it into the same Growth " +
        "pipeline growth_review surfaces - call this once the teaching is actually complete, not after " +
        "every single message. IMPORTANT: for mode='explain_and_build', the user's message IS usually " +
        "the complete teaching already - call action='start' and then action='finalize' in the SAME " +
        "turn right after, don't wait for a followup that may never come. For 'demonstration'/" +
        "'guided_practice', wait and call action='finalize' once the user signals they're done (or the " +
        "task/correction cycle has clearly ended). action='status' checks a session's current " +
        "classification/routing.",
      inputSchema: {
        action: z.enum(["start", "capture", "finalize", "status"]).describe("Which teaching-session operation to perform."),
        mode: z
          .enum(["demonstration", "guided_practice", "explain_and_build"])
          .optional()
          .describe("start: which teaching mode this is. Required for action='start'."),
        content: z
          .string()
          .optional()
          .describe("start/capture: the captured text - what the user said/demonstrated/corrected. Required for both."),
        teachingSessionId: z.coerce.number().int().optional().describe("capture/finalize/status: the session's id, from action='start'. Required for all three."),
      },
    },
    async ({ action, mode, content, teachingSessionId }) => {
      try {
        if (action === "start") {
          if (!mode) return errorResult("mode is required for action='start'.");
          if (!content) return errorResult("content is required for action='start'.");
          const result = await startTeachingSession(config, mode, content, chatSessionId);
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

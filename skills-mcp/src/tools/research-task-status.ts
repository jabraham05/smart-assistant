import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getResearchStatus, getResearchStatusByTopic, type ResearchStatus } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// Real gap found via live testing, twice over: a chat reply with every
// finding pasted in verbatim reads as an unstructured wall of text. Just
// telling the model to summarize and link out (in this tool's own
// description below) wasn't enough on its own - qwen3:8b was given all 9
// findings and a documentUrl, and still restated all 9 as a numbered list
// with no link, the exact behavior the description explicitly said not to
// do. Same lesson this whole project has learned repeatedly (calculate.ts,
// calendar_event.ts's implausibleDateError, safety-net.ts's tool-policy
// enforcement): don't trust the model to be disciplined when a
// deterministic constraint can enforce it instead. Fix: only ever hand the
// model a small number of findings at all - it can't paste what it was
// never given - with an explicit count of what's left, pointing at
// chat-ui/src/app/research/[id]/page.tsx (which renders the complete,
// untruncated list) for the rest.
export const MAX_FINDINGS_INLINE = 3;

// Real gap found via live dogfooding: a status of "pending" or
// "researching" has no next-step field anywhere in this shape, and with
// nothing honest to say the model invented "waiting for you to take the
// next step" framing when asked - there was genuinely nothing for the
// user to do, since the queue drains automatically (event-bus's periodic
// drain). Same string duplicated in status-overview.ts rather than a
// shared module for two call sites.
export const RESEARCH_IN_PROGRESS_NOTE =
  "No action needed on your end - this runs automatically in the background (including idle/overnight " +
  "time) and will complete without any further input from you.";
const IN_PROGRESS_STATUSES = ["pending", "researching", "running"];

export function shapeResultForChat(config: Config, result: ResearchStatus): ResearchStatus & { documentUrl?: string; moreFindingsCount?: number; progressNote?: string } {
  const shaped: ResearchStatus & { documentUrl?: string; moreFindingsCount?: number; progressNote?: string } = { ...result };
  if (result.sessionId) {
    shaped.documentUrl = `${config.chatUiUrl}/research/${result.sessionId}`;
  }
  if (result.findings && result.findings.length > MAX_FINDINGS_INLINE) {
    shaped.moreFindingsCount = result.findings.length - MAX_FINDINGS_INLINE;
    shaped.findings = result.findings.slice(0, MAX_FINDINGS_INLINE);
  }
  if (result.status && IN_PROGRESS_STATUSES.includes(result.status)) {
    shaped.progressNote = RESEARCH_IN_PROGRESS_NOTE;
  }
  return shaped;
}

// chatSessionId comes from the MCP transport layer (see server.ts's
// RequestContext), same as research_task itself — it's how this resolves
// "my research task" to a specific row without the model needing to track
// or supply an id, for a task started in *this* conversation.
export function registerResearchTaskStatus(server: McpServer, config: Config, chatSessionId?: string): void {
  server.registerTool(
    "research_task_status",
    {
      title: "Check on a research task's progress",
      description:
        "Check the current progress of a research task — what phase it's in, and its findings " +
        "if it's finished. Omit `topic` to check for a task started earlier in THIS conversation " +
        "(the original use case). Pass `topic` instead when asking about something that might " +
        "have been researched in the background and NOT necessarily started via a request in " +
        "this exact conversation — e.g. the self-learning research queue queues topics ambiently " +
        "and drains them during idle/overnight time, so \"what have you found out about the " +
        "robotic arm\" can be true even if no research_task was ever explicitly started here. " +
        "When genuinely unsure which to use, pass `topic` — it also finds tasks started in this " +
        "conversation if the topic matches closely enough. This is for ONE specific topic you " +
        "already have in mind - for a broad 'how's everything going' question spanning multiple " +
        "things, use status_overview instead. Findings are capped at a few per call " +
        "on purpose (see `moreFindingsCount` when present) — mention in your own words what you " +
        "were given, note there's more if `moreFindingsCount` is set, and include `documentUrl` " +
        "so the user can read the rest there. If `progressNote` is present, relay it honestly — " +
        "it means the status is still in-progress with nothing for the user to do; don't invent " +
        "your own 'waiting on you' framing when this field is absent from a finished result. A " +
        "finding with confidence 'unverified' could not be confirmed against anything actually " +
        "fetched — never present it as settled; say plainly it's unconfirmed, or leave it out.",
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe(
            "Optional: the specific topic to check on (e.g. 'robotic arm', 'submarine'), for " +
              "research that may have happened in the background rather than this conversation.",
          ),
      },
    },
    async ({ topic }) => {
      try {
        if (topic?.trim()) {
          const result = await getResearchStatusByTopic(config, topic.trim());
          if (!result.found) {
            return textResult(`No research found on "${topic}".`);
          }
          return textResult(shapeResultForChat(config, result));
        }

        if (!chatSessionId) {
          return errorResult("research_task_status has no chat session in scope for this call.");
        }
        const result = await getResearchStatus(config, chatSessionId);
        if (!result.found) {
          return textResult("No research task found for this conversation.");
        }
        return textResult(shapeResultForChat(config, result));
      } catch (e) {
        return errorResult(`research_task_status failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  approveProposal,
  getPersonaProposal,
  listOpportunities,
  listProposals,
  promotePersonaProposal,
  rejectProposal,
} from "../lib/growth-client.js";
import { errorResult, textResult } from "../types.js";

// Human approval surface for the Growth engine (Phase 6.5) - same
// conversational-approval idiom as skill_propose/task_context_manage/
// goal_manage, not a new chat-ui page. Growth never auto-applies anything
// above Tier 1 (observing/scoring/proposing) on its own; a proposal sits
// in growth_proposals until a user explicitly approves or rejects it here.
export function registerGrowthReview(server: McpServer, config: Config): void {
  server.registerTool(
    "growth_review",
    {
      title: "Review the Growth engine's self-improvement proposals",
      description:
        "Review what Amy's Growth engine has noticed about her own behavior and proposed to " +
        "improve, chosen via `action`. action='list_opportunities' shows accumulated, scored " +
        "candidates for improvement (not yet proposals - most never become one). " +
        "action='list_proposals' shows actual proposals awaiting a decision (status='proposed' " +
        "by default - pass status='approved'/'rejected' for history). action='approve' or " +
        "action='reject' requires `proposalId` from that list. Approving immediately consolidates " +
        "the proposal into wherever it belongs (a durable fact/learning, a new skill, a tool idea " +
        "queued for human review, or - for a behavior/persona change - a candidate persona edit " +
        "that still requires separate manual promotion, after an automatic golden-transcript " +
        "regression check). action='persona_proposal' shows any pending candidate persona edit " +
        "(there may be one sitting unreviewed regardless of whether it came through this system) - " +
        "action='promote_persona' applies it to Amy's live system prompt; this is the one step " +
        "that's never automatic anywhere in Growth, so only do it when the user explicitly confirms " +
        "they've reviewed the candidate text and want it applied, not just because one exists. Only " +
        "use this tool when the user is explicitly asking about Amy's own self-improvement, pending " +
        "proposals, or growth opportunities - not for ordinary skill proposals (that's skill_propose) " +
        "or tasks/goals.",
      inputSchema: {
        action: z
          .enum(["list_opportunities", "list_proposals", "approve", "reject", "persona_proposal", "promote_persona"])
          .describe("Which growth-review operation to perform."),
        status: z.string().optional().describe("list_opportunities/list_proposals: filter by status (e.g. 'proposed', 'approved', 'rejected', 'observed', 'scored'). Omit for list_proposals to default to 'proposed'."),
        proposalId: z.coerce.number().int().optional().describe("approve/reject: the proposal's id, from action='list_proposals'. Required for both."),
        notes: z.string().optional().describe("approve/reject: optional reviewer notes explaining the decision."),
      },
    },
    async ({ action, status, proposalId, notes }) => {
      try {
        if (action === "list_opportunities") {
          const opportunities = await listOpportunities(config, status);
          if (opportunities.length === 0) return textResult("No growth opportunities found.");
          return textResult(
            opportunities.map((o) => ({
              id: o.id,
              ref: `opportunity #${o.id}`,
              title: o.title,
              category: o.category,
              frequency: o.frequency,
              score: o.score,
              status: o.status,
            })),
          );
        }

        if (action === "list_proposals") {
          const proposals = await listProposals(config, status ?? "proposed");
          if (proposals.length === 0) return textResult("No growth proposals found.");
          return textResult(
            proposals.map((p) => ({
              id: p.id,
              ref: `proposal #${p.id}`,
              category: p.category,
              proposedAction: p.proposed_action,
              rationale: p.rationale,
              status: p.status,
              title: p.opportunity_title,
            })),
          );
        }

        if (action === "approve") {
          if (!proposalId) return errorResult("proposalId is required for action='approve'.");
          const result = await approveProposal(config, proposalId, notes);
          return textResult(result);
        }

        if (action === "reject") {
          if (!proposalId) return errorResult("proposalId is required for action='reject'.");
          const result = await rejectProposal(config, proposalId, notes);
          return textResult(result);
        }

        if (action === "persona_proposal") {
          const proposal = await getPersonaProposal(config);
          if (!proposal.pending) return textResult("No pending persona proposal.");
          return textResult({
            name: proposal.name,
            proposedSystemPrompt: proposal.proposed_system_prompt,
            proposedReason: proposal.proposed_reason,
            proposedAt: proposal.proposed_at,
            note: "This has not been applied. Confirm with the user before using action='promote_persona'.",
          });
        }

        // action === "promote_persona"
        const result = await promotePersonaProposal(config);
        return textResult(result);
      } catch (e) {
        return errorResult(`growth_review failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

import type { Config } from "../config.js";
import { insertSkillProposal } from "../db.js";

export interface SkillProposal {
  kind: "instruction" | "tool_idea";
  name: string;
  description: string;
  reason: string;
  instructions?: string;
  tool_idea_details?: string;
}

// Inserts directly into skills-mcp's own skill_proposals table (see db.ts).
// Real, live-verified finding: this used to POST to the skill_proposal_intake
// n8n workflow, which inserted into n8n's own internal `skills` Data Table -
// a store with no REST read or approve endpoint anywhere in this repo, so a
// human could only review proposals by opening n8n's UI directly. Replaced
// as part of retiring n8n shims from the microservices architecture, same
// direction as coding-workflow.ts's own n8n-shim retirement.
export async function submitSkillProposal(config: Config, payload: SkillProposal): Promise<void> {
  await insertSkillProposal(config, payload);
}

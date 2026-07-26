import type { Config } from "../config.js";

export interface SkillProposal {
  kind: "instruction" | "tool_idea";
  name: string;
  description: string;
  reason: string;
  instructions?: string;
  tool_idea_details?: string;
}

// POSTs to the skill_proposal_intake n8n workflow, which inserts a new row
// into the `skills` Data Table with status="proposed". Mirrors the
// fetch-wrapper shape of lib/honcho.ts and lib/open-meteo.ts.
export async function submitSkillProposal(config: Config, payload: SkillProposal): Promise<void> {
  const res = await fetch(config.skillsProposalWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Skill proposal intake failed: ${res.status} ${body}`);
  }
}

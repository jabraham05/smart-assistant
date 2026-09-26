import type { Express, Request, Response } from "express";
import type { Config } from "../config.js";
import { getSkillProposal, listSkillProposals, updateSkillProposalStatus } from "../db.js";

// Plain internal REST route, no LLM/MCP involved - chat-ui's Amy Lab
// Suggested Upgrades tab reads/approves/rejects these directly. Replaces
// the old skill_proposal_intake n8n workflow's Data Table, which had no
// REST read or approve path at all.
export function registerSkillProposalsRoute(app: Express, config: Config): void {
  app.get("/skill-proposals", async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    try {
      const proposals = await listSkillProposals(config, status);
      res.json({ proposals });
    } catch (e) {
      console.error("failed to list skill proposals:", e);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/skill-proposals/:id/approve", async (req, res) => {
    await reviewProposal(req, res, "approved");
  });

  app.post("/skill-proposals/:id/reject", async (req, res) => {
    await reviewProposal(req, res, "rejected");
  });

  async function reviewProposal(req: Request, res: Response, status: "approved" | "rejected") {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid skill proposal id" });
    }
    try {
      const proposal = await getSkillProposal(config, id);
      if (!proposal) return res.status(404).json({ error: `skill proposal ${id} not found` });
      if (proposal.status !== "proposed") {
        return res.status(409).json({ error: `skill proposal ${id} is not proposed (status: ${proposal.status})` });
      }
      const updated = await updateSkillProposalStatus(config, id, status);
      res.json(updated);
    } catch (e) {
      console.error(`failed to ${status === "approved" ? "approve" : "reject"} skill proposal ${id}:`, e);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}

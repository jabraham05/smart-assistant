import type { Config } from "../config.js";
import { ollamaChat, parseJsonContent } from "../ollama.js";
import type { FindingCluster } from "./cluster-findings.js";
import type { Finding } from "./research-agent.js";

export interface VerifiedFinding {
  claim: string;
  sourceUrls: string[];
  confidence: "confirmed" | "contested" | "single_source" | "unverified";
  // Present only for a contested finding - the other claims in its cluster
  // that disagreed with it, so a caller can show both sides rather than
  // silently picking one.
  contestedBy?: Finding[];
}

const VERIFY_SYSTEM_PROMPT = `You are checking a small group of research findings that all appear to be about
the same sub-topic (grouped by keyword overlap, not by an LLM). Decide whether they genuinely agree with each
other or whether at least one of them contradicts the others - this is a real judgment call, not a wording
comparison. Respond with exactly one JSON object: {"agree": boolean, "reasoning": string}.`;

// One dedicated LLM call per multi-finding cluster - the same "a real LLM
// judgment call is good at this, unlike string matching" shape as
// skill_gap_scanner's Semantic Dedup Check. A cluster of size 1 never
// needs this at all: there's nothing to compare it against, so it's
// single_source by construction, not run through the model for a verdict
// it can't meaningfully give.
//
// Ungrounded findings (research-agent.ts's isGrounded check failed - a
// cited source was never actually fetched, or the claim doesn't match what
// was fetched) are resolved to "unverified" before any of the above runs,
// with no LLM call at all: agreement between two fabrications proves
// nothing, so there's no judgment call here for the model to make. Verified
// confidence (single_source/confirmed/contested) is only ever assigned
// among a cluster's grounded members.
export async function verifyClusters(config: Config, clusters: FindingCluster[]): Promise<VerifiedFinding[]> {
  const verified: VerifiedFinding[] = [];

  for (const cluster of clusters) {
    const grounded = cluster.findings.filter((f) => f.grounded);
    const ungrounded = cluster.findings.filter((f) => !f.grounded);

    for (const finding of ungrounded) {
      verified.push({ claim: finding.claim, sourceUrls: finding.sourceUrls, confidence: "unverified" });
    }

    if (grounded.length === 0) continue;

    if (grounded.length === 1) {
      const finding = grounded[0];
      verified.push({ claim: finding.claim, sourceUrls: finding.sourceUrls, confidence: "single_source" });
      continue;
    }

    const claimsText = grounded.map((f, i) => `${i + 1}. ${f.claim}`).join("\n");
    const { message } = await ollamaChat(config.ollamaHost, {
      model: config.researchModel,
      messages: [
        { role: "system", content: VERIFY_SYSTEM_PROMPT },
        { role: "user", content: claimsText },
      ],
      format: {
        type: "object",
        properties: { agree: { type: "boolean" }, reasoning: { type: "string" } },
        required: ["agree", "reasoning"],
      },
    });

    const parsed = parseJsonContent<{ agree: boolean; reasoning: string }>(message.content, {
      agree: true,
      reasoning: "could not parse verification response, defaulting to agree",
    });

    for (let i = 0; i < grounded.length; i++) {
      const finding = grounded[i];
      const others = grounded.filter((_, j) => j !== i);
      verified.push({
        claim: finding.claim,
        sourceUrls: finding.sourceUrls,
        confidence: parsed.agree ? "confirmed" : "contested",
        ...(parsed.agree ? {} : { contestedBy: others }),
      });
    }
  }

  return verified;
}

import type { Config } from "../config.js";
import { ollamaChat, parseJsonContent } from "../ollama.js";
import { gatherWebPassages } from "./web-search.js";
import { isGrounded } from "./grounding.js";

export interface Finding {
  claim: string;
  sourceUrls: string[];
  // Deterministic, computed below - false means the synthesis model cited
  // a passage for a claim that passage's own text doesn't actually
  // support. verify.ts resolves these straight to confidence:"unverified"
  // with no LLM call; persist-research.ts never writes a citation/chunk
  // row for them.
  grounded: boolean;
}

export interface ResearchAgentResult {
  findings: Finding[];
  iterations: number;
  exhaustedIterations: boolean;
}

// Only ever sees pre-filtered, already-relevant, already-fetched passages
// (see web-retrieval.ts) - never a raw page, never a free-floating search
// snippet, and never a tool it could use to go fetch something ungrounded
// on its own. Its entire job is extraction from text it's handed, not
// research - that's deliberate: the old design let the model decide what
// to search, what to read, and what counted as a fact, entirely through
// its own in-context reasoning over noisy raw pages, which is exactly what
// produced confidently-stated, unverifiable Warframe entities (Kali,
// Veknom, "Vay Hala", "Plasma Rifle") despite many rounds of explicit
// correction. Narrowing what the model is trusted to do - summarize vetted
// text instead of orchestrating its own retrieval - is the actual fix, not
// another round of prompting the same failure mode away.
const SYNTHESIS_SYSTEM_PROMPT =
  "You are extracting concrete, citable facts strictly from the numbered passages below - never from your " +
  "own general knowledge, and never by generalizing past what a passage actually states. Each passage was " +
  "already fetched and confirmed relevant; your only job is to pull out the specific facts they state, each " +
  "tagged with the exact passage number that backs it. If a name, claim, or entity is not explicitly stated " +
  "in a passage, do not include it, even if it sounds plausible. If none of the passages actually answer the " +
  "topic, return an empty findings list rather than padding one out. Respond with exactly one JSON object: " +
  '{"findings": [{"claim": string, "passageNumber": integer}]}.';

export async function runResearchAgent(config: Config, topic: string, domain?: string): Promise<ResearchAgentResult> {
  const { passages, noMatch } = await gatherWebPassages(config, topic, {
    maxSources: 6,
    maxPassages: 10,
    minScore: 0.35,
  });

  if (noMatch) {
    return { findings: [], iterations: 1, exhaustedIterations: false };
  }

  const passagesText = passages.map((p, i) => `[${i + 1}] (source: ${p.url})\n${p.text}`).join("\n\n");

  const { message } = await ollamaChat(config.ollamaHost, {
    model: config.researchModel,
    think: false,
    timeoutMs: 120_000,
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
      { role: "user", content: `Research topic: ${topic}\n\nPassages:\n${passagesText}` },
    ],
    format: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: { claim: { type: "string" }, passageNumber: { type: "integer" } },
            required: ["claim", "passageNumber"],
          },
        },
      },
      required: ["findings"],
    },
  });

  const parsed = parseJsonContent<{ findings: { claim: string; passageNumber: number }[] }>(message.content, {
    findings: [],
  });

  const findings: Finding[] = parsed.findings
    .filter((f) => Number.isInteger(f.passageNumber) && f.passageNumber >= 1 && f.passageNumber <= passages.length)
    .map((f) => {
      const passage = passages[f.passageNumber - 1];
      // Re-checks the claim against the *specific* passage it says backs
      // it (not just "was anything fetched this session" like the old
      // design) - catches the model citing passage [3] for a claim that's
      // actually only supported by passage [1], or embellishing past what
      // the cited passage actually says.
      const grounded = isGrounded(f.claim, [passage.url], new Map([[passage.url, passage.text]]));
      return { claim: f.claim, sourceUrls: [passage.url], grounded };
    });

  return { findings, iterations: 1, exhaustedIterations: false };
}

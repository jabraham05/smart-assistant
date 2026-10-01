import type { Config } from "../config.js";
import * as db from "../db.js";
import { embedTexts } from "../lib/ollama-embeddings.js";
import type { VerifiedFinding } from "./verify.js";

export interface PersistResearchInput {
  topic: string;
  domain?: string;
  triggerSource?: string;
  originSessionId?: string;
  findings: VerifiedFinding[];
  // When the caller already created a research_sessions row up front (the
  // fast-ack path in index.ts's POST /research, so the HTTP response
  // doesn't have to wait for the full agent run) - reuses that row instead
  // of creating a second one.
  existingSessionId?: number;
}

export interface PersistResearchResult {
  sessionId: number;
  documentId: number;
}

// remember(): saves a completed research run two ways at once - a
// research_sessions/findings/citations record (so "what did we learn about
// X" and "where did sources disagree" both work later, Phase 4's actual
// goal) AND a searchable documents/sources/chunks record (kind='research'),
// so the exact same knowledge_search a future conversation already uses
// can surface these findings too, with no separate recall mechanism needed.
export async function persistResearch(config: Config, input: PersistResearchInput): Promise<PersistResearchResult> {
  const session = input.existingSessionId
    ? { id: input.existingSessionId }
    : await db.insertResearchSession(config, {
        topic: input.topic,
        domain: input.domain,
        triggerSource: input.triggerSource,
        originSessionId: input.originSessionId,
      });

  const document = await db.insertDocument(config, {
    kind: "research",
    sourceType: "web_research",
    title: input.topic,
    domain: input.domain,
    triggerSource: input.triggerSource,
    originSessionId: input.originSessionId,
    status: "running",
  });

  try {
    const sourceIdByUrl = new Map<string, number>();
    async function resolveSource(url: string): Promise<number> {
      const cached = sourceIdByUrl.get(url);
      if (cached) return cached;
      const source = await db.getOrCreateSource(config, document.id, url);
      sourceIdByUrl.set(url, source.id);
      return source.id;
    }

    const claims = input.findings.map((f) => f.claim);
    const embeddings = claims.length > 0 ? await embedTexts(config, claims) : [];

    for (let i = 0; i < input.findings.length; i++) {
      const finding = input.findings[i];
      const findingRow = await db.insertFinding(config, {
        researchSessionId: session.id,
        claim: finding.claim,
        confidence: finding.confidence,
      });

      // Hard block, not a tag-and-surface: unlike memory_entries/findings
      // (which have a visible trust field a consumer can render a caveat
      // around), a citations row *asserts* "this source backs this claim"
      // and a chunks row feeds knowledge_search with no way to mark itself
      // unverified - neither table has a trust vocabulary of its own, so an
      // unverified finding gets no citation/chunk at all. The findings row
      // above is still written and visibly tagged "unverified" - every
      // consumer that already renders [confidence] claim
      // (research_task_status, notify.ts, consolidate.ts) surfaces it
      // automatically.
      if (finding.confidence === "unverified") continue;

      for (const url of finding.sourceUrls) {
        const sourceId = await resolveSource(url);
        await db.insertCitation(config, { findingId: findingRow.id, sourceId, excerpt: finding.claim, supports: true });
      }
      for (const contesting of finding.contestedBy ?? []) {
        for (const url of contesting.sourceUrls) {
          const sourceId = await resolveSource(url);
          await db.insertCitation(config, {
            findingId: findingRow.id,
            sourceId,
            excerpt: contesting.claim,
            supports: false,
          });
        }
      }

      const chunkSourceId = finding.sourceUrls[0] ? await resolveSource(finding.sourceUrls[0]) : undefined;
      await db.insertChunk(config, {
        documentId: document.id,
        sourceId: chunkSourceId,
        chunkIndex: i,
        content: finding.claim,
        embedding: embeddings[i],
      });
    }

    await db.updateDocumentStatus(config, document.id, "complete");
    await db.updateResearchSessionStatus(config, session.id, "complete", document.id);
    return { sessionId: session.id, documentId: document.id };
  } catch (e) {
    await db.updateDocumentStatus(config, document.id, "failed");
    await db.updateResearchSessionStatus(config, session.id, "failed");
    throw e;
  }
}

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
  const session = await db.insertResearchSession(config, {
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

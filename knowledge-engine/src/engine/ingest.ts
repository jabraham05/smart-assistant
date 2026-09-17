import type { Config } from "../config.js";
import * as db from "../db.js";
import { embedTexts } from "../lib/ollama-embeddings.js";
import { extractUrl } from "../lib/html-extract.js";
import { chunkText } from "./chunk-text.js";

export interface IngestInput {
  sourceType: "text" | "url";
  text?: string;
  url?: string;
  title?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  triggerSource?: string;
  originSessionId?: string;
}

export interface IngestResult {
  documentId: number;
  sourceId: number;
  chunkCount: number;
}

// Phase 1a: text/URL only. Every chunk gets a real source_id pointing at
// the one source this ingestion came from - the direct fix for
// research_chunks never having had per-chunk attribution.
export async function ingestText(config: Config, input: IngestInput): Promise<IngestResult> {
  let text: string;
  let title = input.title;
  let originUrl: string | undefined;

  if (input.sourceType === "url") {
    if (!input.url) throw new Error("url is required when sourceType is 'url'");
    const extracted = await extractUrl(input.url);
    text = extracted.text;
    title = title || extracted.title || undefined;
    originUrl = input.url;
  } else {
    if (!input.text) throw new Error("text is required when sourceType is 'text'");
    text = input.text;
  }

  const document = await db.insertDocument(config, {
    sourceType: input.sourceType,
    title,
    domain: input.domain,
    metadata: input.metadata,
    originUrl,
    triggerSource: input.triggerSource,
    originSessionId: input.originSessionId,
    status: "running",
  });

  try {
    const source = await db.insertSource(config, { documentId: document.id, url: originUrl, title });

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error("no content to chunk after extraction");
    }
    const embeddings = await embedTexts(config, chunks);

    for (let i = 0; i < chunks.length; i++) {
      await db.insertChunk(config, {
        documentId: document.id,
        sourceId: source.id,
        chunkIndex: i,
        content: chunks[i],
        embedding: embeddings[i],
      });
    }

    await db.updateDocumentStatus(config, document.id, "complete");
    return { documentId: document.id, sourceId: source.id, chunkCount: chunks.length };
  } catch (e) {
    await db.updateDocumentStatus(config, document.id, "failed");
    throw e;
  }
}

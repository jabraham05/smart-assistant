import type { Config } from "../config.js";
import * as db from "../db.js";
import { embedTexts } from "../lib/ollama-embeddings.js";
import { extractUrl } from "../lib/html-extract.js";
import { extractPdf } from "../lib/pdf-extract.js";
import { chunkText } from "./chunk-text.js";
import { detectHeading } from "./detect-heading.js";

export interface IngestInput {
  sourceType: "text" | "url" | "pdf";
  text?: string;
  url?: string;
  // Base64-encoded PDF bytes - matches how scripts/ingest-document.mjs
  // sends a local file over the same JSON POST body every other ingestion
  // path uses, rather than a separate multipart upload route.
  pdfBase64?: string;
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

interface PendingChunk {
  content: string;
  heading?: string;
  pageNumber?: number;
}

// Phase 1a (text/url) + Phase 1b (pdf). Every chunk gets a real source_id
// pointing at the one source this ingestion came from - the direct fix for
// research_chunks never having had per-chunk attribution. PDF chunks
// additionally carry page_number (always accurate, from pdf-extract.ts)
// and heading (best-effort, from detect-heading.ts - null when the source
// PDF's real formatting gave the deterministic heuristic nothing to find,
// which is a legitimate, expected outcome, not a failure).
export async function ingestDocument(config: Config, input: IngestInput): Promise<IngestResult> {
  let title = input.title;
  let originUrl: string | undefined;
  let pendingChunks: PendingChunk[];

  if (input.sourceType === "url") {
    if (!input.url) throw new Error("url is required when sourceType is 'url'");
    const extracted = await extractUrl(config.scraplingServiceUrl, input.url);
    title = title || extracted.title || undefined;
    originUrl = input.url;
    pendingChunks = chunkText(extracted.text).map((content) => ({ content }));
  } else if (input.sourceType === "pdf") {
    if (!input.pdfBase64) throw new Error("pdfBase64 is required when sourceType is 'pdf'");
    const pdf = await extractPdf(Buffer.from(input.pdfBase64, "base64"));
    pendingChunks = pdf.pages.flatMap((page) => {
      const heading = detectHeading(page.text) ?? undefined;
      return chunkText(page.text).map((content) => ({ content, heading, pageNumber: page.pageNumber }));
    });
  } else {
    if (!input.text) throw new Error("text is required when sourceType is 'text'");
    pendingChunks = chunkText(input.text).map((content) => ({ content }));
  }

  if (pendingChunks.length === 0) {
    throw new Error("no content to chunk after extraction");
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

    const embeddings = await embedTexts(
      config,
      pendingChunks.map((c) => c.content),
    );

    for (let i = 0; i < pendingChunks.length; i++) {
      await db.insertChunk(config, {
        documentId: document.id,
        sourceId: source.id,
        chunkIndex: i,
        heading: pendingChunks[i].heading,
        pageNumber: pendingChunks[i].pageNumber,
        content: pendingChunks[i].content,
        embedding: embeddings[i],
      });
    }

    await db.updateDocumentStatus(config, document.id, "complete");
    return { documentId: document.id, sourceId: source.id, chunkCount: pendingChunks.length };
  } catch (e) {
    await db.updateDocumentStatus(config, document.id, "failed");
    throw e;
  }
}

import type { Config } from "../config.js";
import * as db from "../db.js";
import { embedText } from "../lib/ollama-embeddings.js";

export interface SearchInput {
  query: string;
  domain?: string;
  metadataFilter?: Record<string, unknown>;
  includeStale?: boolean;
  topK?: number;
}

// Citations are first-class per result - a document title/domain plus a
// nested source (url/title) and, for PDFs, page/section - not the old
// research_chunks' flat document-level source_urls array.
export interface SearchResult {
  content: string;
  documentTitle: string | null;
  domain: string | null;
  pageNumber: number | null;
  sectionPath: string | null;
  heading: string | null;
  score: number;
  source: { url: string | null; title: string | null };
}

export async function search(config: Config, input: SearchInput): Promise<SearchResult[]> {
  const queryEmbedding = await embedText(config, input.query);

  const rows = await db.hybridSearchChunks(config, {
    queryEmbedding,
    queryText: input.query,
    domain: input.domain,
    metadataFilter: input.metadataFilter,
    includeStale: input.includeStale,
    topK: input.topK,
  });

  return rows.map((row) => ({
    content: row.content,
    documentTitle: row.document_title,
    domain: row.domain,
    pageNumber: row.page_number,
    sectionPath: row.section_path,
    heading: row.heading,
    score: row.rrf_score,
    source: { url: row.source_url, title: row.source_title },
  }));
}

import type { Config } from "../config.js";
import { tavilySearch } from "../lib/tavily.js";
import { extractUrl } from "../lib/html-extract.js";
import { embedTexts } from "../lib/ollama-embeddings.js";
import { chunkText } from "./chunk-text.js";

export interface RankedPassage {
  text: string;
  url: string;
  title: string;
  score: number;
}

export interface GatherPassagesOptions {
  // How many search results to fetch full pages for. Kept small by default
  // (5) - each one is a real page fetch through scrapling-service, not a
  // cheap call.
  maxSources?: number;
  // How many ranked passages to keep after scoring, across all fetched
  // pages combined.
  maxPassages?: number;
  // Blended semantic+keyword score floor (see scorePassage below) - a
  // passage below this never reaches the model, regardless of how it ranks
  // relative to the others. Replaces the old research-agent.ts design,
  // where the model itself decided what counted as relevant by reading
  // raw fetched pages and free-form reasoning over them - the exact
  // mechanism that produced confidently-stated, unverifiable Warframe
  // entities (Kali, Veknom, Vay Hala, "Plasma Rifle") despite repeated
  // teaching. A deterministic floor means a query with no real answer in
  // any fetched page structurally can't reach the synthesis model at all.
  minScore?: number;
  // Passed straight through to tavilySearch - biases results toward the
  // last few days for current-events/headline queries.
  topic?: "general" | "news";
}

export interface GatheredPassages {
  passages: RankedPassage[];
  // True when nothing fetched cleared minScore - callers should report
  // "couldn't find anything that actually answers this" directly, never
  // fall through to an LLM call with weak-or-irrelevant context to pad out.
  noMatch: boolean;
}

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "is", "are", "was",
  "were", "in", "on", "at", "with", "about", "into", "it", "its", "this",
  "that", "has", "have", "had", "be", "been", "as", "by", "from", "not",
]);

function significantKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Fraction of the query's significant keywords that actually appear in the
// passage - the same stopword-filtered overlap signal grounding.ts and
// cluster-findings.ts already use elsewhere in this codebase, applied here
// as the keyword half of a hybrid score. Deliberately not embedding
// similarity alone: OpenAI's own chunk-scoring blends semantic and keyword
// signal rather than trusting either in isolation (a passage can be
// semantically "close" via shared topic vocabulary while never actually
// stating the fact the query asks for).
export function keywordOverlapScore(query: string, passage: string): number {
  const queryKeywords = significantKeywords(query);
  if (queryKeywords.size === 0) return 0;
  const passageKeywords = significantKeywords(passage);
  const overlap = [...queryKeywords].filter((k) => passageKeywords.has(k)).length;
  return overlap / queryKeywords.size;
}

interface Candidate {
  text: string;
  url: string;
  title: string;
}

// Search the live web, fetch full page text for the top candidates, split
// each into passages, and rank every passage against the query - returning
// only the ones that clear minScore. Replaces letting the model itself
// decide relevance by reading raw fetched pages in-context (research-agent.ts's
// old design): ranking and filtering happen here, deterministically, before
// any LLM ever sees a token of this content.
export async function gatherWebPassages(
  config: Config,
  query: string,
  options: GatherPassagesOptions = {},
): Promise<GatheredPassages> {
  const maxSources = options.maxSources ?? 5;
  const maxPassages = options.maxPassages ?? 8;
  const minScore = options.minScore ?? 0.35;

  if (!config.tavilyApiKey) {
    return { passages: [], noMatch: true };
  }

  const searchResults = await tavilySearch(config.tavilyApiKey, query, { maxResults: maxSources, topic: options.topic });
  if (searchResults.length === 0) {
    return { passages: [], noMatch: true };
  }

  const pages = await Promise.all(
    searchResults.map(async (r) => {
      try {
        const page = await extractUrl(config.scraplingServiceUrl, r.url);
        return page.text ? { url: r.url, title: r.title, text: page.text } : null;
      } catch {
        // A single page failing to fetch (dead link, blocked, timeout)
        // shouldn't fail the whole query - the other candidates still get
        // ranked normally.
        return null;
      }
    }),
  );

  const candidates: Candidate[] = [];
  for (const page of pages) {
    if (!page) continue;
    for (const chunk of chunkText(page.text)) {
      candidates.push({ text: chunk, url: page.url, title: page.title });
    }
  }

  if (candidates.length === 0) {
    return { passages: [], noMatch: true };
  }

  const [queryEmbedding, ...passageEmbeddings] = await embedTexts(config, [query, ...candidates.map((c) => c.text)]);

  const scored: RankedPassage[] = candidates.map((c, i) => {
    const semantic = cosineSimilarity(queryEmbedding, passageEmbeddings[i]);
    const keyword = keywordOverlapScore(query, c.text);
    // 70/30 semantic/keyword blend - semantic carries most of the signal
    // (it's what catches a passage that answers the question using
    // different words than the query), keyword guards against a
    // semantically-similar-but-off-topic passage that never actually
    // mentions the thing being asked about.
    const score = semantic * 0.7 + keyword * 0.3;
    return { text: c.text, url: c.url, title: c.title, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const kept = scored.filter((p) => p.score >= minScore).slice(0, maxPassages);

  return { passages: kept, noMatch: kept.length === 0 };
}

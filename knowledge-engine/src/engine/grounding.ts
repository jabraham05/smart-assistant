// Same stopword-filtered word-split approach cluster-findings.ts uses for
// its own keyword overlap - deliberately not a new technique, just applied
// to a different question (is this claim backed by what was actually
// fetched, not which findings belong in the same cluster).
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

// A claim's keywords must mostly appear in what was actually fetched -
// catches a model that fetched a real, on-topic page and then cited it for
// an unrelated or embellished claim it invented anyway. Tunable, no
// empirical basis yet beyond "most, not all" (a claim can legitimately
// paraphrase).
const OVERLAP_THRESHOLD = 0.6;

// Deterministic, no-LLM check that a record_finding call is actually backed
// by content the research agent fetched this session - not just a URL
// string the model typed into the tool call. The real gap this closes: a
// model fabricating a plausible product name and calling
// record_finding({claim, sourceUrls: []}) (or with a made-up/never-fetched
// URL) was previously indistinguishable from a well-sourced finding -
// same incident shape as the "Qwen3.8-LiveTranslate API"/WebRTC fabrication
// that poisoned memory-engine via a different path (see system-prompt.ts's
// actionClarifyLine comment).
export function isGrounded(claim: string, sourceUrls: string[], fetchedPages: Map<string, string>): boolean {
  if (sourceUrls.length === 0) return false;

  const fetchedUrls = sourceUrls.filter((u) => fetchedPages.has(u));
  if (fetchedUrls.length === 0) return false;

  const claimKeywords = significantKeywords(claim);
  if (claimKeywords.size === 0) return true;

  const pageText = fetchedUrls.map((u) => fetchedPages.get(u)!).join("\n");
  const pageKeywords = significantKeywords(pageText);
  const overlap = [...claimKeywords].filter((k) => pageKeywords.has(k)).length;
  return overlap / claimKeywords.size >= OVERLAP_THRESHOLD;
}

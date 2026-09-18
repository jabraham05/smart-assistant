import type { Finding } from "./research-agent.js";

export interface FindingCluster {
  findings: Finding[];
}

// Same stopword-filtered word-split approach event-bus's deriveKeywords()
// uses for goal keywords - a real, accepted v1 gap (misses synonyms), not
// an oversight. Two findings addressing the same sub-question are grouped
// deterministically by keyword overlap before the one LLM call (verify.ts)
// that's actually needed - judging agreement/contradiction is a real
// judgment call an LLM is good at; deciding which findings are even about
// the same thing is not.
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "is", "are", "was",
  "were", "in", "on", "at", "with", "about", "into", "it", "its", "this",
  "that", "has", "have", "had", "be", "been", "as", "by", "from", "not",
]);

function keywords(text: string, exclude: Set<string>): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !exclude.has(w));
  return new Set(words);
}

// 2026-09-17 - real bug found via a live end-to-end run: researching
// "Kuva farming" produced 8 genuinely distinct findings (riven reroll
// cost, which mission types drop it, a companion mod, etc.) that all got
// merged into one cluster, because every single one of them mentions
// "Kuva" - the literal research topic. Sharing the topic's own name isn't
// evidence two findings are about the same *sub-question* within it; it's
// guaranteed to be true of nearly everything found while researching that
// topic. `topic` is now excluded from the significant-keyword set for
// exactly this reason - two findings must share some other, more specific
// term to actually cluster together.
export function clusterFindings(findings: Finding[], topic = ""): FindingCluster[] {
  const topicWords = new Set(topic.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const keywordSets = findings.map((f) => keywords(f.claim, topicWords));
  const clusterIndex = findings.map((_, i) => i); // union-find parent pointers

  function find(i: number): number {
    while (clusterIndex[i] !== i) {
      clusterIndex[i] = clusterIndex[clusterIndex[i]];
      i = clusterIndex[i];
    }
    return i;
  }

  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) clusterIndex[rootA] = rootB;
  }

  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const shared = [...keywordSets[i]].some((kw) => keywordSets[j].has(kw));
      if (shared) union(i, j);
    }
  }

  const groups = new Map<number, Finding[]>();
  for (let i = 0; i < findings.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(findings[i]);
  }

  return [...groups.values()].map((groupFindings) => ({ findings: groupFindings }));
}

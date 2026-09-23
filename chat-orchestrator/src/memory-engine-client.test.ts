import { test } from "node:test";
import assert from "node:assert/strict";
import { isRelevantMemory } from "./memory-engine-client.js";
import type { MemorySearchResult } from "./memory-engine-client.js";

// Defaults trivially pass the keyword-overlap gate so every score-focused
// test below is a pure test of the threshold behavior, same convention as
// knowledge-engine's router.test.ts.
function result(score: number, keywordOverlapCount = 5, queryLexemeCount = 5): MemorySearchResult {
  return {
    content: "irrelevant",
    role: "user",
    sessionId: "s1",
    domain: null,
    taskContextId: null,
    createdAt: new Date().toISOString(),
    score,
    keywordOverlapCount,
    queryLexemeCount,
  };
}

test("isRelevantMemory: a score below the threshold is rejected", () => {
  assert.equal(isRelevantMemory(result(0.01), 0.012, 1), false);
});

test("isRelevantMemory: a score meeting the threshold with overlap is accepted", () => {
  assert.equal(isRelevantMemory(result(0.03), 0.012, 1), true);
});

test("isRelevantMemory: a passing score with zero keyword overlap is rejected (the live regression)", () => {
  // Mirrors the real incident: a stale, unrelated memory scored ~0.029
  // (well above the 0.012 default) but shared no real terms with the
  // current query - a recency/vector coincidence, not a real match.
  assert.equal(isRelevantMemory(result(0.029, 0, 6), 0.012, 1), false);
});

test("isRelevantMemory: a passing score with at least one keyword overlap is accepted", () => {
  assert.equal(isRelevantMemory(result(0.029, 1, 6), 0.012, 1), true);
});

test("isRelevantMemory: overlap below a configured higher minimum is rejected", () => {
  assert.equal(isRelevantMemory(result(0.03, 1, 5), 0.012, 2), false);
});

test("isRelevantMemory: a query with no significant lexemes at all bypasses the overlap gate", () => {
  assert.equal(isRelevantMemory(result(0.03, 0, 0), 0.012, 1), true);
});

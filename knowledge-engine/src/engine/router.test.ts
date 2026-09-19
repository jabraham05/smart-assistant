import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRoute } from "./router.js";
import type { SearchResult } from "./search.js";

// Defaults trivially pass the keyword-overlap gate so every existing test
// below stays a pure test of the score/threshold behavior, unaffected by
// the gate added after this file was first written.
function result(score: number, keywordOverlapCount = 5, queryLexemeCount = 5): SearchResult {
  return {
    content: "irrelevant",
    documentTitle: null,
    domain: null,
    pageNumber: null,
    sectionPath: null,
    heading: null,
    score,
    keywordOverlapCount,
    queryLexemeCount,
    source: { url: null, title: null },
  };
}

test("decideRoute: no knowledge-base result at all escalates to web", () => {
  const decision = decideRoute(undefined, 0.02);
  assert.equal(decision.source, "web");
});

test("decideRoute: a score below the threshold escalates to web", () => {
  const decision = decideRoute(result(0.01), 0.02);
  assert.equal(decision.source, "web");
});

test("decideRoute: a score meeting the threshold stays in knowledge", () => {
  const decision = decideRoute(result(0.03), 0.02);
  assert.equal(decision.source, "knowledge");
});

test("decideRoute: a score exactly at the threshold stays in knowledge (not below)", () => {
  const decision = decideRoute(result(0.02), 0.02);
  assert.equal(decision.source, "knowledge");
});

test("decideRoute: reason always names the actual score and threshold, for debuggability", () => {
  const decision = decideRoute(result(0.015), 0.02);
  assert.match(decision.reason, /0\.0150/);
  assert.match(decision.reason, /0\.02/);
});

test("decideRoute: a passing RRF score with zero keyword overlap escalates to web (Nissan GT-R regression)", () => {
  // Mirrors real live testing: an unrelated same-domain top result scored
  // 0.0164 (passes a 0.012 threshold) but shares no lexemes with the
  // query - a vector-similarity coincidence, not a real match.
  const decision = decideRoute(result(0.0164, 0, 4), 0.012);
  assert.equal(decision.source, "web");
  assert.match(decision.reason, /keyword/);
});

test("decideRoute: a passing RRF score with at least one keyword overlap stays in knowledge (brake-fluid regression)", () => {
  // Mirrors real live testing: the same 0.0164 score, but this time the
  // top result genuinely shares a term with the query even though it
  // doesn't contain every query word verbatim.
  const decision = decideRoute(result(0.0164, 1, 5), 0.012);
  assert.equal(decision.source, "knowledge");
});

test("decideRoute: overlap below a configured higher minimum still escalates to web", () => {
  const decision = decideRoute(result(0.03, 1, 5), 0.02, 2);
  assert.equal(decision.source, "web");
});

test("decideRoute: a query with no significant lexemes at all bypasses the overlap gate", () => {
  // All-stopword/degenerate query: overlap can't be evaluated, so only the
  // RRF threshold applies - the same behavior as before this gate existed.
  const decision = decideRoute(result(0.03, 0, 0), 0.02);
  assert.equal(decision.source, "knowledge");
});

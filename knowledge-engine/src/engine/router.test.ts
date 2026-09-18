import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRoute } from "./router.js";
import type { SearchResult } from "./search.js";

function result(score: number): SearchResult {
  return {
    content: "irrelevant",
    documentTitle: null,
    domain: null,
    pageNumber: null,
    sectionPath: null,
    heading: null,
    score,
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

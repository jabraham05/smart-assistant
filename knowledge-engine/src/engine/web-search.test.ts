import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, keywordOverlapScore } from "./web-search.js";

test("cosineSimilarity is 1 for identical vectors", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosineSimilarity is 0 for orthogonal vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity is 0 (not NaN) when either vector is all zeros", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 1], [0, 0]), 0);
});

test("keywordOverlapScore is 1 when every significant query keyword appears in the passage", () => {
  assert.equal(keywordOverlapScore("Warframe damage modding", "This page explains Warframe damage and modding."), 1);
});

test("keywordOverlapScore is 0 when the passage shares none of the query's significant keywords", () => {
  assert.equal(keywordOverlapScore("Warframe damage modding", "This page is about gardening tips and recipes."), 0);
});

test("keywordOverlapScore is 0 for an all-stopword query (no significant keywords to check)", () => {
  assert.equal(keywordOverlapScore("is the a of", "anything at all"), 0);
});

test("keywordOverlapScore reflects partial overlap", () => {
  // "warframe" and "modding" present, "veknom" absent - 2 of 3 significant keywords.
  const score = keywordOverlapScore("warframe veknom modding", "A guide to warframe modding mechanics.");
  assert.equal(score, 2 / 3);
});

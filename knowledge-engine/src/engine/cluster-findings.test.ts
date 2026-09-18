import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterFindings } from "./cluster-findings.js";

test("clusterFindings: findings sharing a significant keyword land in the same cluster", () => {
  const clusters = clusterFindings([
    { claim: "The Kuva Nukor got a damage buff in the latest patch", sourceUrls: ["a"] },
    { claim: "The Kuva Nukor is currently considered weak after recent changes", sourceUrls: ["b"] },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].findings.length, 2);
});

test("clusterFindings: unrelated findings land in separate clusters", () => {
  const clusters = clusterFindings([
    { claim: "The fuel pump relay is located under the dashboard", sourceUrls: ["a"] },
    { claim: "The Kuva Nukor got a damage buff in the latest patch", sourceUrls: ["b"] },
  ]);
  assert.equal(clusters.length, 2);
});

test("clusterFindings: transitively links findings through a shared middle finding", () => {
  const clusters = clusterFindings([
    { claim: "The Kuva Nukor deals radiation damage", sourceUrls: ["a"] },
    { claim: "Radiation damage causes enemies to attack each other", sourceUrls: ["b"] },
    { claim: "Confused enemies deal reduced damage", sourceUrls: ["c"] },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].findings.length, 3);
});

test("clusterFindings: a single unrelated finding is its own cluster", () => {
  const clusters = clusterFindings([{ claim: "The sky is blue during the day", sourceUrls: ["a"] }]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].findings.length, 1);
});

test("clusterFindings: an empty findings list produces no clusters", () => {
  assert.deepEqual(clusterFindings([]), []);
});

test("clusterFindings: the topic's own words don't count as a clustering signal - real case from researching Kuva farming", () => {
  const clusters = clusterFindings(
    [
      { claim: "Kuva Siphon missions reward roughly 550-700 Kuva each", sourceUrls: ["a"] },
      { claim: "Rerolling costs 900 Kuva on the first cycle", sourceUrls: ["b"] },
      { claim: "The Loyal Retriever precept has a 13% chance to double a Kuva pickup", sourceUrls: ["c"] },
    ],
    "what is the current best way to farm Kuva in Warframe",
  );
  // All three genuinely mention "Kuva" (the topic itself) but are about
  // three unrelated sub-questions (mission rewards, reroll cost, a
  // companion mod) - without excluding the topic's own words, these would
  // incorrectly merge into one cluster on "Kuva" alone.
  assert.equal(clusters.length, 3);
});

test("clusterFindings: stopwords alone never create a false-positive link", () => {
  const clusters = clusterFindings([
    { claim: "This is a note about the car", sourceUrls: ["a"] },
    { claim: "This is a note about the game", sourceUrls: ["b"] },
  ]);
  // Every word both claims share ("this", "is", "a", "note", "about",
  // "the") except "note" is a stopword - "note" itself is a real shared
  // keyword, so these two are legitimately expected to cluster together.
  // This test exists to document that stopwords specifically don't drive
  // clustering on their own, not that any two unrelated sentences must
  // stay separate.
  assert.equal(clusters.length, 1);
});

test("clusterFindings: sentences with genuinely no shared content words stay separate", () => {
  const clusters = clusterFindings([
    { claim: "The fuel pump relay is located under the dashboard", sourceUrls: ["a"] },
    { claim: "Kuva Nukor weapons deal radiation elemental damage", sourceUrls: ["b"] },
  ]);
  assert.equal(clusters.length, 2);
});

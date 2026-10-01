import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyClusters } from "./verify.js";
import type { FindingCluster } from "./cluster-findings.js";
import type { Config } from "../config.js";

// Minimal config - the cases below never reach the ollamaChat call (only
// taken when a cluster has 2+ grounded members), so no real Ollama
// endpoint or mocking is needed.
const config = { ollamaHost: "http://unused:0", researchModel: "unused" } as Config;

// Real incident shape: a single fabricated, zero-citation finding with
// nothing else to cluster against previously sailed through unchecked,
// auto-labeled "single_source" with no verification of any kind.
test("verifyClusters resolves an ungrounded cluster member to unverified with no LLM call", async () => {
  const clusters: FindingCluster[] = [
    { findings: [{ claim: "Widget X supports gadget Y", sourceUrls: [], grounded: false }] },
  ];
  const verified = await verifyClusters(config, clusters);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].confidence, "unverified");
});

test("verifyClusters resolves a single grounded finding to single_source", async () => {
  const clusters: FindingCluster[] = [
    { findings: [{ claim: "Widget X supports gadget Y", sourceUrls: ["https://example.com"], grounded: true }] },
  ];
  const verified = await verifyClusters(config, clusters);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].confidence, "single_source");
});

test("verifyClusters splits a mixed cluster: ungrounded members become unverified, the lone grounded member becomes single_source", async () => {
  const clusters: FindingCluster[] = [
    {
      findings: [
        { claim: "Widget X supports gadget Y", sourceUrls: [], grounded: false },
        { claim: "Widget X is made of titanium", sourceUrls: ["https://example.com"], grounded: true },
      ],
    },
  ];
  const verified = await verifyClusters(config, clusters);
  assert.equal(verified.length, 2);
  const unverified = verified.find((v) => v.claim === "Widget X supports gadget Y");
  const grounded = verified.find((v) => v.claim === "Widget X is made of titanium");
  assert.equal(unverified?.confidence, "unverified");
  assert.equal(grounded?.confidence, "single_source");
});

test("verifyClusters produces nothing for a cluster whose only members are ungrounded (no grounded tail logic runs)", async () => {
  const clusters: FindingCluster[] = [
    { findings: [{ claim: "A", sourceUrls: [], grounded: false }, { claim: "B", sourceUrls: [], grounded: false }] },
  ];
  const verified = await verifyClusters(config, clusters);
  assert.equal(verified.length, 2);
  assert.ok(verified.every((v) => v.confidence === "unverified"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeResultForChat, MAX_FINDINGS_INLINE } from "./research-task-status.js";
import type { Config } from "../config.js";
import type { ResearchStatus } from "../lib/knowledge-engine-client.js";

const config = { chatUiUrl: "http://localhost:3000" } as Config;

function findings(n: number): ResearchStatus["findings"] {
  return Array.from({ length: n }, (_, i) => ({ id: i, claim: `claim ${i}`, confidence: "confirmed", citations: [] }));
}

test("shapeResultForChat adds documentUrl when a sessionId is present", () => {
  const result: ResearchStatus = { found: true, status: "complete", sessionId: 42 };
  const shaped = shapeResultForChat(config, result);
  assert.equal(shaped.documentUrl, "http://localhost:3000/research/42");
});

test("shapeResultForChat adds no documentUrl without a sessionId", () => {
  const result: ResearchStatus = { found: true, status: "pending" };
  const shaped = shapeResultForChat(config, result);
  assert.equal(shaped.documentUrl, undefined);
});

test("shapeResultForChat passes through findings under the cap untouched", () => {
  const result: ResearchStatus = { found: true, status: "complete", sessionId: 1, findings: findings(2) };
  const shaped = shapeResultForChat(config, result);
  assert.equal(shaped.findings?.length, 2);
  assert.equal(shaped.moreFindingsCount, undefined);
});

test("shapeResultForChat truncates findings over the cap and reports the remainder", () => {
  const result: ResearchStatus = { found: true, status: "complete", sessionId: 1, findings: findings(9) };
  const shaped = shapeResultForChat(config, result);
  assert.equal(shaped.findings?.length, MAX_FINDINGS_INLINE);
  assert.equal(shaped.moreFindingsCount, 6);
});

test("shapeResultForChat leaves a result with no findings field alone", () => {
  const result: ResearchStatus = { found: true, status: "running" };
  const shaped = shapeResultForChat(config, result);
  assert.equal(shaped.findings, undefined);
  assert.equal(shaped.moreFindingsCount, undefined);
});

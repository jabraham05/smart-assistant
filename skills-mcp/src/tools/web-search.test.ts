import { test } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "./web-search.js";

// Real, live-verified incident (2026-10-19): web_search had no cap at all,
// and a real call returned a 20-35KB passage, which blew the model's
// output token budget before any response was generated. See web-search.ts's
// own comment for the full incident - this just confirms the fix.

test("truncate leaves short content untouched", () => {
  assert.equal(truncate("short passage"), "short passage");
});

test("truncate caps long content at 600 chars with an ellipsis", () => {
  const long = "x".repeat(1000);
  const result = truncate(long);
  assert.equal(result.length, 601); // 600 chars + the ellipsis character
  assert.ok(result.endsWith("…"));
  assert.equal(result.slice(0, 600), "x".repeat(600));
});

test("truncate at exactly the cap leaves content untouched", () => {
  const exact = "x".repeat(600);
  assert.equal(truncate(exact), exact);
});

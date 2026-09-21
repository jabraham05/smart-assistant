import { test } from "node:test";
import assert from "node:assert/strict";
import { registerVerifier, verifyToolResult } from "./verify-tool-result.js";

test("verifyToolResult passes through ok=true for a tool with no registered verifier", () => {
  assert.deepEqual(verifyToolResult("no_such_tool", {}, {}), { ok: true });
});

test("verifyToolResult calls the registered verifier for that tool name", () => {
  registerVerifier("test_tool_a", (args) => (args.shouldFail ? { ok: false, reason: "nope" } : { ok: true }));
  assert.deepEqual(verifyToolResult("test_tool_a", { shouldFail: false }, {}), { ok: true });
  assert.deepEqual(verifyToolResult("test_tool_a", { shouldFail: true }, {}), { ok: false, reason: "nope" });
});

test("verifyToolResult degrades to ok=true (not a crash) when a verifier itself throws", () => {
  registerVerifier("test_tool_b", () => {
    throw new Error("boom");
  });
  const result = verifyToolResult("test_tool_b", {}, {});
  assert.equal(result.ok, true);
  assert.match(result.reason ?? "", /verifier threw: boom/);
});

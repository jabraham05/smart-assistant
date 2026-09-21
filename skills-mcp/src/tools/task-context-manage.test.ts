import { test } from "node:test";
import assert from "node:assert/strict";
// Importing task-context-manage.js registers its verifier as a module-load
// side effect - see calendar-event.test.ts for the same pattern.
import "./task-context-manage.js";
import { verifyToolResult } from "../lib/verify-tool-result.js";

test("task_context_manage verifier passes a create result matching the request", () => {
  const result = verifyToolResult("task_context_manage", { action: "create", objective: "Plan a trip" }, { objective: "Plan a trip" });
  assert.deepEqual(result, { ok: true });
});

test("task_context_manage verifier flags an objective mismatch", () => {
  const result = verifyToolResult("task_context_manage", { action: "create", objective: "Plan a trip" }, { objective: "Something else" });
  assert.equal(result.ok, false);
});

test("task_context_manage verifier passes an advance_step result matching the requested status", () => {
  const result = verifyToolResult("task_context_manage", { action: "advance_step", stepStatus: "completed" }, { status: "completed" });
  assert.deepEqual(result, { ok: true });
});

test("task_context_manage verifier flags an advance_step status mismatch", () => {
  const result = verifyToolResult("task_context_manage", { action: "advance_step", stepStatus: "completed" }, { status: "pending" });
  assert.equal(result.ok, false);
});

test("task_context_manage verifier passes a plan result with the right step count", () => {
  const result = verifyToolResult(
    "task_context_manage",
    { action: "plan", stepDescriptions: ["a", "b"] },
    [{ id: 1 }, { id: 2 }],
  );
  assert.deepEqual(result, { ok: true });
});

test("task_context_manage verifier flags a plan step-count mismatch", () => {
  const result = verifyToolResult(
    "task_context_manage",
    { action: "plan", stepDescriptions: ["a", "b", "c"] },
    [{ id: 1 }],
  );
  assert.equal(result.ok, false);
});

test("task_context_manage verifier is a no-op for list/update/log", () => {
  assert.deepEqual(verifyToolResult("task_context_manage", { action: "list" }, {}), { ok: true });
  assert.deepEqual(verifyToolResult("task_context_manage", { action: "log" }, {}), { ok: true });
});

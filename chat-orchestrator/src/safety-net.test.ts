import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfabulatedAction, hasUnfulfilledSearchIntent, hasUnsatisfiedRequiredTool } from "./safety-net.js";

test("isConfabulatedAction flags a claimed action with no matching tool call", () => {
  assert.equal(
    isConfabulatedAction("I've scheduled that for you.", ["calendar_event"], []),
    true,
  );
});

test("isConfabulatedAction does not flag a real action that was actually called", () => {
  assert.equal(
    isConfabulatedAction("I've scheduled that for you.", ["calendar_event"], ["calendar_event"]),
    false,
  );
});

test("isConfabulatedAction does not flag plain text with no action claim", () => {
  assert.equal(isConfabulatedAction("The weather today is sunny.", ["weather_get"], []), false);
});

test("isConfabulatedAction ignores a claim when no action tool was even bound", () => {
  assert.equal(isConfabulatedAction("I've added that.", ["weather_get"], []), false);
});

test("hasUnfulfilledSearchIntent flags narrated intent with no actual search call", () => {
  assert.equal(
    hasUnfulfilledSearchIntent("Let me search for that real quick.", ["web_search"], []),
    true,
  );
});

test("hasUnfulfilledSearchIntent does not flag when the search tool was actually called", () => {
  assert.equal(
    hasUnfulfilledSearchIntent("Let me search for that.", ["web_search"], ["web_search"]),
    false,
  );
});

test("hasUnfulfilledSearchIntent does not flag ordinary text", () => {
  assert.equal(hasUnfulfilledSearchIntent("Here's the answer directly.", ["web_search"], []), false);
});

test("hasUnsatisfiedRequiredTool flags a required policy with no matching call", () => {
  assert.equal(hasUnsatisfiedRequiredTool("required", ["calculate", "task_context_manage", "weather_get"], []), true);
});

test("hasUnsatisfiedRequiredTool does not flag when the capability tool was actually called", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool("required", ["calculate", "weather_get"], ["weather_get"]),
    false,
  );
});

test("hasUnsatisfiedRequiredTool does not flag toolPolicy=optional", () => {
  assert.equal(hasUnsatisfiedRequiredTool("optional", ["weather_get"], []), false);
});

test("hasUnsatisfiedRequiredTool does not flag when only calculate is exposed (no task-creation signal)", () => {
  assert.equal(hasUnsatisfiedRequiredTool("required", ["calculate"], []), false);
});

// Real gap found via live testing: "create a task to do X" has no
// classifier category of its own, so this used to short-circuit to false
// unconditionally - the model could talk about creating a task and never
// actually call task_context_manage, with no backstop at all.
test("hasUnsatisfiedRequiredTool flags task_context_manage bound-but-uncalled even with no other capability tool", () => {
  assert.equal(hasUnsatisfiedRequiredTool("required", ["calculate", "task_context_manage"], []), true);
});

test("hasUnsatisfiedRequiredTool does not flag when task_context_manage was actually called", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool("required", ["calculate", "task_context_manage"], ["task_context_manage"]),
    false,
  );
});

test("hasUnsatisfiedRequiredTool is satisfied if any bound capability tool was called, not necessarily all", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool("required", ["weather_get", "calendar_event"], ["calendar_event"]),
    false,
  );
});
